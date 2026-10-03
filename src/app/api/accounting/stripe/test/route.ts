import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { ModeSchema } from "@/server/accounting/core";
import { testStripe } from "@/server/accounting/stripe-gateway";

export const POST = acct("accounting.admin", async ({ req, auth }) => testStripe(auth.organisationId, (await body(req, z.object({ mode: ModeSchema }))).mode));
