import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { revokeTelegramUser } from "@/server/accounting/telegram";

/** Unlink a Telegram account: it can no longer use the assistant and its conversation is deleted. */
export const DELETE = acct<{ id: string }>("accounting.admin", async ({ auth, ctx, params }) => revokeTelegramUser({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Telegram account")));
