import { authed } from "@/server/http";
import { LEGAL_MATRIX, matrixStats } from "@/server/legal/matrix";

export const GET = authed("templates.view", async () => ({ stats: matrixStats(), rows: LEGAL_MATRIX, disclaimer: "Research support for qualified counsel. Not legal advice and not a statement of compliance." }));
