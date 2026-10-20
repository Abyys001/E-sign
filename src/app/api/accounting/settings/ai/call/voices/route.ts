import { acct } from "@/server/accounting/http";
import { listElevenVoices } from "@/server/accounting/ai-call";

/** Voices on the saved ElevenLabs account, to pick one for calls. */
export const GET = acct("accounting.admin", async ({ auth }) => listElevenVoices(auth.organisationId));
