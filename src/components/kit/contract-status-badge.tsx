import type { ReactNode } from 'react';

/** Mirrors backend/contracts ContractState. Kept as a string union so web has no runtime dependency on the backend package. */
export type ContractStatus = 'draft' | 'sent' | 'in_progress' | 'completed' | 'declined' | 'voided' | 'expired';

const TONE: Record<ContractStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  in_progress: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  completed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  declined: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  voided: 'bg-muted text-muted-foreground line-through',
  expired: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
};

const DEFAULT_LABEL: Record<ContractStatus, string> = {
  draft: 'Draft', sent: 'Sent', in_progress: 'In progress', completed: 'Completed',
  declined: 'Declined', voided: 'Voided', expired: 'Expired',
};

/** Pass `labels` from your i18n layer; text is always rendered, so status is never conveyed by color alone. */
export function ContractStatusBadge({ status, labels = DEFAULT_LABEL }: { status: ContractStatus; labels?: Record<ContractStatus, ReactNode> }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${TONE[status]}`}>
      {labels[status]}
    </span>
  );
}
