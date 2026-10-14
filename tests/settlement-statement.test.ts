import { describe, expect, it } from "vitest";
import { statementLines } from "@/server/accounting/organiser-report";

describe("settlement statement balance", () => {
  it("due on the chosen events − payments tagged to them − payments on account, per currency", () => {
    const lines = statementLines(
      [{ currency: "eur", organiserDue: 1678243, organiserPaid: 400000 }, { currency: "eur", organiserDue: 910576, organiserPaid: 0 }, { currency: "gbp", organiserDue: 5000, organiserPaid: 5000 }],
      [{ currency: "eur", amount: 2100000 }],
    );
    expect(lines).toEqual([
      { currency: "eur", due: 2588819, paidOnEvents: 400000, paidOnAccount: 2100000, balance: 88819 },
      { currency: "gbp", due: 5000, paidOnEvents: 5000, paidOnAccount: 0, balance: 0 },
    ]);
  });
  it("a negative balance means the organiser has been overpaid", () => {
    expect(statementLines([{ currency: "eur", organiserDue: 1000, organiserPaid: 0 }], [{ currency: "eur", amount: 1500 }])[0]!.balance).toBe(-500);
  });
});
