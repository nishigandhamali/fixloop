// Latency benchmark against a running API (default http://127.0.0.1:4000, DEMO_MODE=true, seeded DB).
const base = process.env.BENCH_URL ?? "http://127.0.0.1:4000";
const N = Number(process.env.BENCH_N ?? 50);

async function call(path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function bench(name: string, fn: () => Promise<unknown>) {
  await fn(); // warm-up
  const ms: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(`${name.padEnd(34)} p50=${pct(ms, 50).toFixed(1)}ms p95=${pct(ms, 95).toFixed(1)}ms max=${ms.at(-1)!.toFixed(1)}ms (n=${N})`);
}

const { token } = await call("/api/v1/demo/session", undefined, {});
await bench("GET /health/ready", () => call("/health/ready"));
await bench("GET /api/v1/incidents", () => call("/api/v1/incidents", token));
await bench("GET /api/v1/appliances", () => call("/api/v1/appliances", token));
await bench("POST conversation + first message", async () => {
  const { session } = await call("/api/v1/conversations", token, {});
  await call(`/api/v1/conversations/${session.id}/messages`, token, { text: "My fridge is leaking water" });
});
