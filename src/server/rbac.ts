export const PERMISSIONS = [
  "contracts.view", "contracts.create", "contracts.edit", "contracts.delete", "contracts.send", "contracts.cancel",
  "contracts.remind", "contracts.download", "contracts.audit", "contracts.override",
  "templates.view", "templates.create", "templates.edit", "templates.delete",
  "intake.view", "intake.manage", "intake.send", "intake.telemetry",
  "users.manage", "organisation.manage", "billing.manage", "settings.manage", "webhooks.manage", "audit.export",
  "accounting.view", "accounting.manage", "accounting.admin", "accounting.payroll",
  "treasury.admin",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const contractRead: Permission[] = ["contracts.view", "contracts.download", "templates.view"];
const intakeRead: Permission[] = ["intake.view"];
const intakeWrite: Permission[] = ["intake.manage", "intake.send"];
const contractWrite: Permission[] = ["contracts.create", "contracts.edit", "contracts.send", "contracts.cancel", "contracts.remind", "templates.create", "templates.edit"];

export const SYSTEM_ROLES: Record<string, { name: string; permissions: readonly Permission[] }> = {
  SUPER_ADMIN: { name: "Super admin", permissions: PERMISSIONS },
  ORG_OWNER: { name: "Organisation owner", permissions: PERMISSIONS },
  ADMIN: { name: "Admin", permissions: PERMISSIONS.filter((p) => p !== "billing.manage") },
  CONTRACT_MANAGER: { name: "Contract manager", permissions: [...contractRead, ...contractWrite, ...intakeRead, ...intakeWrite, "intake.telemetry", "contracts.audit", "contracts.delete", "templates.delete", "contracts.override"] },
  SENDER: { name: "Sender", permissions: [...contractRead, ...intakeRead, "intake.send", "contracts.create", "contracts.edit", "contracts.send", "contracts.remind", "contracts.cancel"] },
  EDITOR: { name: "Editor", permissions: [...contractRead, ...intakeRead, "intake.manage", "contracts.create", "contracts.edit", "templates.create", "templates.edit"] },
  VIEWER: { name: "Viewer", permissions: [...contractRead, ...intakeRead] },
  AUDITOR: { name: "Auditor", permissions: [...contractRead, ...intakeRead, "intake.telemetry", "contracts.audit", "audit.export", "accounting.view"] },
  SIGNER: { name: "Signer (external, token only)", permissions: [] },
};

export type Membership = { roleKey: string; grants: readonly string[]; denies: readonly string[]; isSuperAdmin?: boolean };

/** Effective permission = (role ∪ grants) − denies. Deny always wins. */
export function can(m: Membership | null | undefined, perm: Permission): boolean {
  if (!m) return false;
  if (m.denies.includes(perm)) return false;
  if (m.isSuperAdmin) return true;
  const role = SYSTEM_ROLES[m.roleKey];
  return !!role?.permissions.includes(perm) || m.grants.includes(perm);
}
