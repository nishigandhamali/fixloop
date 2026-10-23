import { Pill, label, when } from "@/components/shared/ui";
import type { IncidentEvent } from "@/lib/types";

const ACTOR: Record<string, string> = {
  USER: "You",
  AGENT: "Assistant",
  SYSTEM: "System",
  TOOL: "Assistant tool",
  EXTERNAL: "Simulated provider",
};
const TONE: Record<string, string> = {
  USER: "border-accent",
  EXTERNAL: "border-warn",
  TOOL: "border-line",
  AGENT: "border-line",
  SYSTEM: "border-line",
};

export function Timeline({ events }: { events: IncidentEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-muted">No events yet.</p>;
  return (
    <ol className="space-y-3" aria-label="Case timeline">
      {events.map((e) => (
        <li key={e.id} className={`border-l-4 pl-3 ${TONE[e.actorType] ?? "border-line"}`}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{label(e.eventType)}</span>
            <Pill value="" text={ACTOR[e.actorType] ?? e.actorType} />
          </div>
          <div className="text-xs text-muted">{when(e.timestamp)}</div>
          {typeof e.structuredPayload.providerReference === "string" && (
            <div className="text-xs">
              Provider reference <code>{e.structuredPayload.providerReference}</code> · external completion not verified
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
