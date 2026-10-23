"use client";
/** Browser -> Next gateway (same origin). CSRF: double-submit cookie echoed in a header. */
function csrf(): string {
  return (
    document.cookie
      .split("; ")
      .find((c) => c.startsWith("fl_csrf="))
      ?.split("=")[1] ?? ""
  );
}
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function gw<T = any>(
  path: string,
  opts: { method?: string; json?: unknown; raw?: { body: BodyInit; contentType: string } } = {},
): Promise<T> {
  const method = opts.method ?? (opts.json || opts.raw ? "POST" : "GET");
  const headers: Record<string, string> = { "x-fixloop-csrf": csrf() };
  let body: BodyInit | undefined;
  if (opts.raw) {
    headers["content-type"] = opts.raw.contentType;
    body = opts.raw.body;
  } else if (method !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json ?? {});
  }
  const res = await fetch(`/api/gateway/${path.replace(/^\//, "")}`, { method, headers, body, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GatewayError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}
