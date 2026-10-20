import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { API_URL } from "@/lib/api";

/** Demo-mode sign-in: obtains a server-issued session from the API and stores it in an httpOnly cookie. */
export async function GET(req: NextRequest) {
  const next = req.nextUrl.searchParams.get("next") ?? "/";
  const dest = next.startsWith("/") && !next.startsWith("//") ? next : "/"; // no open redirects
  const res = await fetch(`${API_URL}/api/v1/demo/session`, { method: "POST", cache: "no-store" });
  if (!res.ok) return new NextResponse("Demo session unavailable. Is the API running and seeded (pnpm db:seed)?", { status: 503 });
  const { token } = (await res.json()) as { token: string };
  const out = NextResponse.redirect(new URL(dest, req.url));
  const secure = process.env.NODE_ENV === "production" && req.nextUrl.protocol === "https:";
  out.cookies.set("fl_session", token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 3500 });
  out.cookies.set("fl_csrf", randomBytes(16).toString("hex"), { httpOnly: false, sameSite: "lax", secure, path: "/", maxAge: 3500 });
  return out;
}
