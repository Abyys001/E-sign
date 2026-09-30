import { hash, verify } from "@node-rs/argon2";

const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // OWASP minimum profile for argon2id

export const hashPassword = (pw: string) => hash(pw, OPTS);

let dummy: Promise<string> | undefined;
/** Always runs a real verify, even for unknown users, so response time does not reveal which emails exist. */
export async function verifyPassword(stored: string | null | undefined, pw: string): Promise<boolean> {
  const target = stored ?? (await (dummy ??= hashPassword("timing-equalisation-only")));
  try { return (await verify(target, pw)) && !!stored; } catch { return false; }
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters.";
  if (pw.length > 200) return "Password is too long.";
  if (/^(.)\1+$/.test(pw)) return "Password is too simple.";
  return null;
}
