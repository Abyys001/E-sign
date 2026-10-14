import { staffRoute } from "@/server/treasury/http";
import { body } from "@/server/http";
import { ExpenseInput, saveExpenseNote } from "@/server/treasury/staff-portal";
export const POST = staffRoute(async ({ req, sc }) => saveExpenseNote(sc, await body(req, ExpenseInput)));
