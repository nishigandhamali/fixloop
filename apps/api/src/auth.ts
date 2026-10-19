import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import type { Principal } from "./principal.js";

/** LOCAL DEMO AUTH ONLY: server-issued HMAC-signed bearer token bound to one user+household. Not OAuth. */
export type TokenScope = "user" | "agent";

/** scope "user" = a human session (may approve actions); scope "agent" = the MCP/LLM credential (can never approve). */
export function issueToken(secret: string, userId: string, householdId: string, scope: TokenScope = "user", ttlSec = 3600): string {
  const body = Buffer.from(JSON.stringify({ u: userId, h: householdId, s: scope, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export async function verifyToken(db: Db, secret: string, token: string | undefined, correlationId: string, allowed: TokenScope[] = ["user", "agent"]): Promise<Principal | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: { u: string; h: string; s: TokenScope; exp: number };
  try { claims = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (claims.exp < Date.now() / 1000 || !allowed.includes(claims.s)) return null;
  // Authorization is re-checked against the DB on every request; the token alone grants nothing.
  const m = await db.householdMember.findUnique({ where: { householdId_userId: { householdId: claims.h, userId: claims.u } } });
  if (!m) return null;
  return { userId: claims.u, householdId: claims.h, role: m.role, scope: claims.s, correlationId };
}
