import { applyBps, prorate } from "@/lib/money";
import type { Posting } from "./ledger";

export type BtKind = "SALE" | "REFUND" | "DISPUTE" | "DISPUTE_REVERSAL" | "PAYOUT" | "PAYOUT_REVERSAL" | "STRIPE_FEE" | "OTHER";

/** Map a Stripe balance transaction to what it means for Bilit. Reporting category wins for disputes (they are `adjustment`s). */
export function classifyBt(type: string, reportingCategory: string | null | undefined): BtKind {
  if (reportingCategory === "dispute") return "DISPUTE";
  if (reportingCategory === "dispute_reversal") return "DISPUTE_REVERSAL";
  switch (type) {
    case "charge": case "payment": return "SALE";
    case "refund": case "payment_refund": case "refund_failure": case "payment_failure_refund": return "REFUND";
    case "payout": return "PAYOUT";
    case "payout_cancel": case "payout_failure": return "PAYOUT_REVERSAL";
    case "stripe_fee": case "stripe_fx_fee": case "tax_fee": return "STRIPE_FEE";
    default: return "OTHER";
  }
}

export type Agreement = {
  id: string; percentBps: number; percentBasis: string; fixedPerTicket: number; fixedEventFee: number;
  stripeFeesBorneBy: string; chargebacksBorneBy: string; refundsReverseCommission: boolean;
};

/** Bilit commission on a sale: percentage of gross (or of gross − Stripe fee) plus a fixed amount per ticket. */
export function saleCommission(gross: number, fee: number, qty: number, a: Agreement): number {
  const base = a.percentBasis === "NET" ? gross - fee : gross;
  return applyBps(base, a.percentBps) + a.fixedPerTicket * qty;
}

export type PostingInput = {
  kind: BtKind;
  amount: number; fee: number; net: number;
  matched: { eventId: string; organiserId: string; agreement: Agreement } | null;
  ticketQuantity?: number;
  /** For refunds/disputes: the original sale's gross and booked commission, when known. */
  original?: { amount: number; commission: number } | null;
  classificationAccountId?: string | null;
};

export type PostingResult = { entryType: string; postings: Posting[]; commission: number | null; organiserAmount: number | null };

/**
 * Double-entry lines for one Stripe balance transaction. Sign convention: positive = debit. Every result balances:
 * Stripe Balance takes `net`, Stripe Fees take `fee`, and the counterpart lines sum to −amount (net + fee = amount).
 */
export function btPostings(i: PostingInput): PostingResult {
  if (i.net + i.fee !== i.amount) throw new Error(`Stripe amounts inconsistent: amount ${i.amount} ≠ net ${i.net} + fee ${i.fee}`);
  const dim = i.matched ? { eventId: i.matched.eventId, organiserId: i.matched.organiserId } : {};
  const p: Posting[] = [
    { account: "stripe_balance", amount: i.net, ...dim, memo: "Stripe net" },
    { account: "stripe_fees", amount: i.fee, ...dim, memo: "Stripe fee" },
  ];
  const add = (account: Posting["account"], amount: number, memo: string) => p.push({ account, amount, ...dim, memo });

  switch (i.kind) {
    case "SALE": {
      if (!i.matched) { add("unallocated_receipts", -i.amount, "Unallocated receipt"); return { entryType: "SALE_UNALLOCATED", postings: p, commission: null, organiserAmount: null }; }
      const a = i.matched.agreement;
      const k = saleCommission(i.amount, i.fee, i.ticketQuantity ?? 1, a);
      const share = i.amount - k;
      add("ticket_sales", -i.amount, "Gross ticket sales");
      add("organiser_share", share, "Organiser share");
      add("organiser_payable", -share, "Payable to organiser");
      const recharge = a.stripeFeesBorneBy === "ORGANISER" ? i.fee : 0;
      add("organiser_payable", recharge, "Stripe fee recharged to organiser");
      add("stripe_fee_recharges", -recharge, "Stripe fee recharged to organiser");
      return { entryType: "SALE", postings: p, commission: k, organiserAmount: share - recharge };
    }
    case "REFUND": case "DISPUTE": case "DISPUTE_REVERSAL": {
      const expense = i.kind === "REFUND" ? "refunds" : "chargebacks";
      if (!i.matched) { add("unallocated_receipts", -i.amount, "Unallocated (original sale not allocated)"); return { entryType: i.kind, postings: p, commission: null, organiserAmount: null }; }
      add(expense, -i.amount, i.kind === "REFUND" ? "Refund" : i.kind === "DISPUTE" ? "Chargeback" : "Chargeback reversed");
      const a = i.matched.agreement;
      const organiserBears = i.kind === "REFUND" || a.chargebacksBorneBy === "ORGANISER";
      if (!organiserBears) return { entryType: i.kind, postings: p, commission: 0, organiserAmount: 0 };
      // Commission follows the money back pro rata (refund of 40 % of a sale reverses 40 % of its commission) when agreed.
      const cd = !a.refundsReverseCommission ? 0 : i.original && i.original.amount !== 0 ? prorate(i.original.commission, i.amount, i.original.amount) : applyBps(a.percentBasis === "NET" ? i.amount - i.fee : i.amount, a.percentBps);
      const share = i.amount - cd;
      add("organiser_share", share, "Organiser share reversed");
      add("organiser_payable", -share, "Charged back to organiser");
      const recharge = a.stripeFeesBorneBy === "ORGANISER" || i.kind !== "REFUND" ? i.fee : 0;
      add("organiser_payable", recharge, "Stripe fee recharged to organiser");
      add("stripe_fee_recharges", -recharge, "Stripe fee recharged to organiser");
      return { entryType: i.kind, postings: p, commission: cd, organiserAmount: share - recharge };
    }
    case "PAYOUT": case "PAYOUT_REVERSAL":
      add("payouts_in_transit", -i.amount, i.kind === "PAYOUT" ? "Payout to bank (in transit)" : "Payout returned to Stripe balance");
      return { entryType: i.kind, postings: p, commission: null, organiserAmount: null };
    case "STRIPE_FEE":
      add("stripe_fees", -i.amount, "Stripe fee");
      return { entryType: "STRIPE_FEE", postings: p, commission: null, organiserAmount: null };
    default:
      add(i.classificationAccountId ? { id: i.classificationAccountId } : "unclassified", -i.amount, i.classificationAccountId ? "Classified Stripe activity" : "Unclassified Stripe activity");
      return { entryType: "STRIPE_OTHER", postings: p, commission: null, organiserAmount: null };
  }
}
