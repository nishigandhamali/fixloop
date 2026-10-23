/** In-process metrics (no external dependency). Latencies are kept as a bounded sample for p50/p95. */
export class Metrics {
  private calls = new Map<string, { ok: number; error: number; ms: number[] }>();
  record(name: string, ok: boolean, ms: number) {
    const e = this.calls.get(name) ?? { ok: 0, error: 0, ms: [] };
    if (ok) e.ok++;
    else e.error++;
    e.ms.push(ms);
    if (e.ms.length > 1000) e.ms.shift();
    this.calls.set(name, e);
  }
  snapshot() {
    const q = (a: number[], p: number) => {
      const s = [...a].sort((x, y) => x - y);
      return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
    };
    return Object.fromEntries(
      [...this.calls].map(([k, v]) => [k, { ok: v.ok, error: v.error, p50Ms: +q(v.ms, 0.5).toFixed(2), p95Ms: +q(v.ms, 0.95).toFixed(2) }]),
    );
  }
}
