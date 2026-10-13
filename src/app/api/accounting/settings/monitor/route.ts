import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { getMonitorSettings, MONITOR_DEFAULTS, MonitorSettingsPatch, updateMonitorSettings } from "@/server/accounting/monitor";

/** Thresholds for the coded financial checks and the cash-forecast assumptions. */
export const GET = acct("accounting.view", async ({ auth }) => ({ settings: await getMonitorSettings(auth.organisationId), defaults: MONITOR_DEFAULTS }));
export const PATCH = acct("accounting.admin", async ({ req, auth, ctx }) => ({ settings: await updateMonitorSettings({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, MonitorSettingsPatch)), defaults: MONITOR_DEFAULTS }));
