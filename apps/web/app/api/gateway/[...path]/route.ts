import { NextRequest, NextResponse } from "next/server";
import { API_URL } from "@/lib/api";

const ALLOWED = ["conversations", "approvals", "incidents", "appliances", "documents", "demo", "households"];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!ALLOWED.includes(path[0] ?? "")) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const token = req.cookies.get("fl_session")?.value;
  if (!token) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Session expired" } }, { status: 401 });
  if (req.method !== "GET") {
    const header = req.headers.get("x-fixloop-csrf");
    if (!header || header !== req.cookies.get("fl_csrf")?.value) return NextResponse.json({ error: { code: "CSRF", message: "Missing or invalid CSRF token" } }, { status: 403 });
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const ct = req.headers.get("content-type");
  if (ct) headers["content-type"] = ct;
  const body = req.method === "GET" ? undefined : await req.arrayBuffer();
  const upstream = await fetch(`${API_URL}/api/v1/${path.join("/")}${req.nextUrl.search}`, { method: req.method, headers, body, cache: "no-store" });
  return new NextResponse(await upstream.arrayBuffer(), { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
}
export { proxy as GET, proxy as POST, proxy as PATCH };
