/**
 * First-run bootstrap: creates one organisation and its owner account.
 *   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_ORG="Your Company" ADMIN_PASSWORD='…' npm run bootstrap
 * The password is read from the environment (or typed, hidden, when a TTY is attached) and is never logged.
 */
import { createInterface } from "node:readline";
import { db, pool } from "@/db";
import { createOrganisation, createUser } from "@/server/orgs";

async function ask(q: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  return new Promise((res) => rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); res(a); }));
}

async function main() {
  const email = process.env.ADMIN_EMAIL ?? (await ask("Owner email: "));
  const name = process.env.ADMIN_NAME ?? (await ask("Owner name: "));
  const org = process.env.ADMIN_ORG ?? (await ask("Organisation name: "));
  const password = process.env.ADMIN_PASSWORD ?? (await ask("Password (min 12 chars): ", true));
  const ctx = { ip: "127.0.0.1", userAgent: "bootstrap-cli", correlationId: "bootstrap" } as never;
  await db.transaction(async (tx) => {
    const u = await createUser(tx, { email, name, password, isSuperAdmin: false });
    const o = await createOrganisation(tx, { name: org, ownerUserId: u.id }, ctx);
    console.log(`Created organisation "${o.name}" and owner ${u.email}`);
  });
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => pool.end());
