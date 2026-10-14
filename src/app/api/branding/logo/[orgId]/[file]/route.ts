import { open } from "@/server/http";
import { GET as logo } from "../route";

/** Same public logo, under a path ending in an image extension (e.g. /logo.jpg) — Stripe Checkout requires one for branding. */
export const GET = open<{ orgId: string; file: string }>(async ({ req, params }) =>
  logo(req, { params: Promise.resolve({ orgId: params.orgId }) }));
