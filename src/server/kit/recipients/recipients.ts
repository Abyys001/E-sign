export const RECIPIENT_ROLES = ['signer', 'approver', 'cc', 'witness', 'viewer', 'in_person'] as const;
export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

export const RECIPIENT_STATUSES = ['created', 'sent', 'viewed', 'authenticated', 'signed', 'declined', 'expired'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export interface Recipient {
  id: string;
  email: string;
  name: string;
  role: RecipientRole;
  /** Routing group. Same `order` = parallel; ascending `order` = sequential. */
  order: number;
  optional: boolean;
  /** Internal = member of the sending tenant; external = anyone else. Identity requirements usually differ. */
  kind: 'internal' | 'external';
  status: RecipientStatus;
  /** Set when reassigned: the recipient this one replaced. */
  delegatedFrom?: string | null;
}

/** Roles that must act (sign/approve) for the contract to progress. cc/viewer only receive; witness/in_person act. */
const ACTING: ReadonlySet<RecipientRole> = new Set(['signer', 'approver', 'witness', 'in_person']);
const TERMINAL: ReadonlySet<RecipientStatus> = new Set(['signed', 'declined', 'expired']);

export const isActing = (r: Recipient): boolean => ACTING.has(r.role);

/** created→sent→viewed→authenticated→signed; declined/expired reachable from any non-terminal state. */
const NEXT: Record<RecipientStatus, readonly RecipientStatus[]> = {
  created: ['sent', 'declined', 'expired'],
  sent: ['viewed', 'declined', 'expired'],
  viewed: ['authenticated', 'signed', 'declined', 'expired'], // `signed` directly when no auth level is required
  authenticated: ['signed', 'declined', 'expired'],
  signed: [],
  declined: [],
  expired: [],
};

export class InvalidRecipientTransitionError extends Error {
  readonly from: RecipientStatus;
  readonly to: RecipientStatus;
  constructor(from: RecipientStatus, to: RecipientStatus) {
    super(`recipient cannot move ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

export function transitionRecipient(r: Recipient, to: RecipientStatus): Recipient {
  if (!NEXT[r.status].includes(to)) throw new InvalidRecipientTransitionError(r.status, to);
  return { ...r, status: to };
}

/** Group recipients by `order`, ascending. */
export function routingGroups(plan: readonly Recipient[]): Recipient[][] {
  const by = new Map<number, Recipient[]>();
  for (const r of plan) by.set(r.order, [...(by.get(r.order) ?? []), r]);
  return [...by.entries()].sort(([a], [b]) => a - b).map(([, g]) => g);
}

/**
 * Recipients who may act now. A group opens when every earlier group is *resolved*:
 * each acting recipient is signed, or is optional and declined/expired. A declined/expired
 * REQUIRED recipient blocks all later groups (the contract should move to declined/expired).
 * Receive-only roles (cc/viewer) are returned once their group opens so they can be notified.
 */
export function nextActionableRecipients(plan: readonly Recipient[]): Recipient[] {
  for (const group of routingGroups(plan)) {
    const open = group.filter((r) => !TERMINAL.has(r.status));
    if (open.length > 0) return open;
    if (!groupResolved(group)) return []; // blocked by a required decline/expiry
  }
  return [];
}

function groupResolved(group: readonly Recipient[]): boolean {
  return group.filter(isActing).every((r) => r.status === 'signed' || (r.optional && TERMINAL.has(r.status)));
}

/** All required acting recipients signed → completion gate for the routing layer. */
export function allRequiredSigned(plan: readonly Recipient[]): boolean {
  return plan.filter(isActing).every((r) => r.status === 'signed' || (r.optional && TERMINAL.has(r.status)))
    && plan.some((r) => isActing(r) && r.status === 'signed');
}

export function blockingRecipient(plan: readonly Recipient[]): Recipient | undefined {
  return plan.find((r) => isActing(r) && !r.optional && (r.status === 'declined' || r.status === 'expired'));
}

export type PlanIssue = { code: 'duplicate_email' | 'no_acting_recipient' | 'optional_only_group' | 'bad_order'; recipientId?: string };

/**
 * Duplicate emails are allowed only across different roles at different `order`s (e.g. a signer who is also cc'd later is
 * pointless, but a person may legitimately sign twice in different capacities). Same email + same role is always rejected:
 * it double-counts a person and breaks per-recipient tokens.
 */
export function validatePlan(plan: readonly Recipient[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const seen = new Set<string>();
  for (const r of plan) {
    const key = `${r.email.trim().toLowerCase()}|${r.role}`;
    if (seen.has(key)) issues.push({ code: 'duplicate_email', recipientId: r.id });
    seen.add(key);
    if (!Number.isInteger(r.order) || r.order < 0) issues.push({ code: 'bad_order', recipientId: r.id });
  }
  if (!plan.some((r) => isActing(r) && !r.optional)) issues.push({ code: 'no_acting_recipient' });
  for (const g of routingGroups(plan)) {
    const acting = g.filter(isActing);
    if (acting.length > 0 && acting.every((r) => r.optional)) issues.push({ code: 'optional_only_group', recipientId: acting[0]!.id });
  }
  return issues;
}

/**
 * Reassign/delegate: only a recipient who has not acted (created/sent/viewed/authenticated) can be replaced.
 * The old recipient is marked expired (its tokens must be revoked by the caller in the same transaction); the new one
 * inherits role/order/optional and restarts at `created`.
 */
export function reassignRecipient(
  plan: readonly Recipient[],
  recipientId: string,
  replacement: Pick<Recipient, 'id' | 'email' | 'name' | 'kind'>,
): Recipient[] {
  const old = plan.find((r) => r.id === recipientId);
  if (!old) throw new Error('recipient not found');
  if (TERMINAL.has(old.status)) throw new Error(`cannot reassign a ${old.status} recipient`);
  const next: Recipient = { ...old, ...replacement, status: 'created', delegatedFrom: old.id };
  return plan.flatMap((r) => (r.id === recipientId ? [{ ...r, status: 'expired' as const }, next] : [r]));
}
