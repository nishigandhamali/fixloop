import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const API_URL = process.env.FIXLOOP_API_URL ?? "http://127.0.0.1:4000";

/** Server-side call to the API using the httpOnly session cookie. The token never reaches browser JavaScript. */
export async function apiGet<T>(path: string, nextPath = "/"): Promise<T> {
  const token = (await cookies()).get("fl_session")?.value;
  if (!token) redirect(`/api/session/start?next=${encodeURIComponent(nextPath)}`);
  const res = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (res.status === 401) redirect(`/api/session/start?next=${encodeURIComponent(nextPath)}`);
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}
