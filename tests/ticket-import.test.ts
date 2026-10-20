import { describe, expect, it } from "vitest";
import { computeImport, parseCsv, parseTicketCsv } from "@/server/accounting/ticket-import";

const HEAD = "Event Name,Venue,Ticket ID,Ticket Type,Ticket Label,Seat ID,Name,Email,Phone Number,Ticket Price (Organizer),Facility Fee,Booking Fee,Transaction Fee,Total User Paid,Stripe Fee,Platform Revenue,Order ID,Created At,Checked In,Photo URL,Meet & Greet - ADD-ON";
const row = (order: string, type: string, price: string, fee: string, total: string, mg = "No") =>
  `Show - Paris,"Apollo, 18 Rue, Paris",T${order}${type},${type},"Rear - P - Seat #7",R-P-7,A B,a@b.c,+33,${price},0.00,${fee},0.00,${total},1.29,1.86,${order},"10/1/2026, 8:32:43 PM",Yes,,${mg}`;

describe("ticket export CSV", () => {
  it("parses quoted fields with commas and doubled quotes", () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\n')).toEqual([["a", "b, c", 'd "e"'], ["1", "2", "3"]]);
  });

  it("finds columns by header and reads amounts as minor units", () => {
    const rows = parseTicketCsv([HEAD, row("o1", "Bronze", "45.00", "3.15", "48.15"), row("o2", "Premium", "85.00", "9.45", "94.45", "Yes")].join("\n"), "eur");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ order: "o1", type: "Bronze", price: 4500, bookingFee: 315, total: 4815, checkedIn: true, addOn: false, eventName: "Show - Paris" });
    expect(rows[1]).toMatchObject({ addOn: true, bookingFee: 945 });
  });

  it("rejects a file without the needed columns", () => {
    expect(() => parseTicketCsv("Name,Email\nA,b@c.d", "eur")).toThrow(/Missing column/);
  });

  it("corrects the booked fee to the charged fee; add-ons and unmatched sales are handled", () => {
    const rows = parseTicketCsv([HEAD,
      row("o1", "Bronze", "45.00", "3.15", "48.15"), row("o1", "Bronze", "45.00", "3.15", "48.15"), // 2 tickets, 7 %
      row("o2", "Premium", "85.00", "9.45", "94.45", "Yes"), // M&G: Stripe took €50 more than the export total
      row("o3", "Gold", "0.00", "0.00", "0.00"), // free
      row("o4", "Gold", "65.00", "8.45", "73.45"), // no Stripe sale
    ].join("\n"), "eur");
    const sales = [
      { order: "o1", amount: 9630, commission: 1032, refunded: false }, // booked at 12 % ADDED
      { order: "o2", amount: 14445, commission: 1548, refunded: false },
      { order: null, amount: 5300, commission: 568, refunded: false },
    ];
    const { summary, orders } = computeImport(rows, sales, "eur");
    expect(summary).toMatchObject({ tickets: 5, paidTickets: 4, freeTickets: 1, ticketPrice: 24000, bookingFees: 2420, addOnAmount: 5000, addOnTickets: 1, matchedOrders: 2 });
    expect(summary.bookedFee).toBe(1032 + 1548);
    expect(summary.targetFee).toBe(630 + 945);
    expect(summary.correction).toBe(2580 - 1575);
    expect(summary.siteOnly).toEqual([{ order: "o4", total: 7345 }]);
    expect(summary.stripeOnly).toEqual([{ order: null, amount: 5300 }]);
    expect(orders.find((o) => o.order === "o3")?.status).toBe("FREE");
  });

  it("never corrects refunded orders or orders Stripe under-received", () => {
    const rows = parseTicketCsv([HEAD, row("o1", "Bronze", "45.00", "3.15", "48.15"), row("o2", "Bronze", "45.00", "3.15", "48.15")].join("\n"), "eur");
    const { summary } = computeImport(rows, [{ order: "o1", amount: 4815, commission: 516, refunded: true }, { order: "o2", amount: 4000, commission: 429, refunded: false }], "eur");
    expect(summary.correction).toBe(0);
    expect(summary.refunded).toEqual(["o1"]);
    expect(summary.amountLow).toEqual([{ order: "o2", site: 4815, stripe: 4000 }]);
  });
});
