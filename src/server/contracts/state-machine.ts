export const STATUSES = [
  "DRAFT", "READY_TO_SEND", "SENT", "DELIVERED", "VIEWED", "PARTIALLY_SIGNED", "AWAITING_SIGNATURE",
  "COMPLETED", "DECLINED", "CANCELLED", "EXPIRED", "VOIDED", "ARCHIVED",
] as const;
export type ContractStatus = (typeof STATUSES)[number];

const inFlight: ContractStatus[] = ["SENT", "DELIVERED", "VIEWED", "PARTIALLY_SIGNED", "AWAITING_SIGNATURE"];
const terminalOps: ContractStatus[] = ["DECLINED", "CANCELLED", "EXPIRED", "VOIDED"];

const T: Record<ContractStatus, readonly ContractStatus[]> = {
  DRAFT: ["READY_TO_SEND", "CANCELLED", "ARCHIVED"],
  READY_TO_SEND: ["DRAFT", "SENT", "CANCELLED"],
  SENT: [...inFlight.filter((s) => s !== "SENT"), "COMPLETED", ...terminalOps],
  DELIVERED: [...inFlight.filter((s) => s !== "DELIVERED"), "COMPLETED", ...terminalOps],
  VIEWED: ["PARTIALLY_SIGNED", "AWAITING_SIGNATURE", "COMPLETED", ...terminalOps],
  PARTIALLY_SIGNED: ["AWAITING_SIGNATURE", "PARTIALLY_SIGNED", "COMPLETED", ...terminalOps],
  AWAITING_SIGNATURE: ["VIEWED", "PARTIALLY_SIGNED", "COMPLETED", ...terminalOps],
  COMPLETED: ["ARCHIVED"],
  DECLINED: ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  EXPIRED: ["ARCHIVED"],
  VOIDED: ["ARCHIVED"],
  ARCHIVED: [],
};

export const canTransition = (from: ContractStatus, to: ContractStatus) => T[from].includes(to);
export const isInFlight = (s: ContractStatus) => inFlight.includes(s);
export const isTerminal = (s: ContractStatus) => [...terminalOps, "COMPLETED", "ARCHIVED"].includes(s);

export class InvalidTransitionError extends Error {
  constructor(public from: ContractStatus, public to: ContractStatus) {
    super(`Invalid contract transition ${from} -> ${to}`);
  }
}
export function assertTransition(from: ContractStatus, to: ContractStatus) {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
