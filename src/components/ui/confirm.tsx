"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "./button";
import { Modal } from "./modal";

/** Confirmation for irreversible/outward actions. `onConfirm` runs the real API call; the dialog stays open on failure. */
export function ConfirmDialog({ open, onClose, title, description, confirmLabel, onConfirm, danger = true, children }: { open: boolean; onClose: () => void; title: string; description?: string; confirmLabel: string; onConfirm: () => Promise<void>; danger?: boolean; children?: React.ReactNode }) {
  const t = useTranslations("common");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="sm"
      footer={<><Button onClick={onClose}>{t("cancel")}</Button><Button variant={danger ? "danger" : "primary"} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{confirmLabel}</Button></>}>
      {children}
    </Modal>
  );
}
