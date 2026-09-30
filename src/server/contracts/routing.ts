import type { InferSelectModel } from "drizzle-orm";
import type { schema } from "@/db";
import { allRequiredSigned, blockingRecipient, isActing, nextActionableRecipients, validatePlan, type Recipient, type RecipientStatus, type RecipientRole, type PlanIssue } from "../kit/recipients/recipients";

type Row = InferSelectModel<typeof schema.recipients>;

const STATUS_TO_KIT: Record<Row["status"], RecipientStatus> = {
  PENDING: "created", WAITING: "created", SENT: "sent", VIEWED: "viewed", COMPLETED: "signed", DECLINED: "declined", REMOVED: "expired",
};
const ROLE_TO_KIT: Record<Row["role"], RecipientRole> = { SIGNER: "signer", CC: "cc", WITNESS: "witness", APPROVER: "approver" };

export const toKit = (r: Row): Recipient => ({
  id: r.id, email: r.email, name: r.name, role: ROLE_TO_KIT[r.role], order: r.signingOrder,
  optional: !r.required, kind: r.internal ? "internal" : "external", status: STATUS_TO_KIT[r.status],
});

const live = (rows: Row[]) => rows.filter((r) => !r.deletedAt && r.status !== "REMOVED");

export const isActingRow = (r: Row) => isActing(toKit(r));

/** Acting recipients who may sign right now (earlier routing groups resolved). */
export function actionableNow(rows: Row[]): Row[] {
  const plan = live(rows).map(toKit);
  const ids = new Set(nextActionableRecipients(plan).filter(isActing).map((r) => r.id));
  return rows.filter((r) => ids.has(r.id));
}

export const everyoneRequiredSigned = (rows: Row[]) => allRequiredSigned(live(rows).map(toKit));
export const blockedBy = (rows: Row[]) => {
  const b = blockingRecipient(live(rows).map(toKit));
  return b ? rows.find((r) => r.id === b.id) : undefined;
};
export const planIssues = (rows: Row[]): PlanIssue[] => validatePlan(live(rows).map(toKit));
export const liveRecipients = live;
