"use client";
import Link from "next/link";
import { useState } from "react";
import { Card, btnGhost, btnPrimary } from "@/components/shared/ui";
import { gw, GatewayError } from "@/lib/client";

const SCENARIOS = [
  ["dishwasher_leak", "Dishwasher leak", "Clean slate with the correct manual and warranty on file."],
  [
    "resume_incident",
    "Resume dishwasher incident",
    "A case already submitted to the simulated provider; ask for a status from a new conversation.",
  ],
  ["wrong_model", "Wrong-model document", "Only a manual for model AQ-DW900 is on file; its claims can't be verified for your AQ-DW450."],
  ["emergency", "Emergency escalation", "Clean slate; report water near an outlet to see conservative guidance."],
  [
    "interrupted_submission",
    "Interrupted submission",
    "An approved request whose first send times out after reaching the provider; the outcome is unknown until you retry.",
  ],
] as const;

export function ScenarioLauncher() {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; utterance: string; description: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function launch(id: string) {
    setBusy(id);
    setErr(null);
    setDone(null);
    try {
      setDone(await gw(`demo/scenario`, { json: { scenario: id } }));
    } catch (e) {
      setErr(e instanceof GatewayError ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }
  async function reset() {
    setBusy("reset");
    setErr(null);
    setDone(null);
    try {
      await gw("demo/reset", { method: "POST" });
      setDone({ title: "Reset", utterance: "", description: "All cases and conversations cleared; default documents restored." });
    } catch (e) {
      setErr(e instanceof GatewayError ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Each scenario resets the demo household and configures <strong>real backend state</strong> (documents, cases, approvals) through the
        same services the assistant uses. Development/demo mode only.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {SCENARIOS.map(([id, t, d]) => (
          <Card key={id} label={t}>
            <h2 className="font-semibold">{t}</h2>
            <p className="mt-1 text-sm text-muted">{d}</p>
            <button className={`${btnPrimary} mt-3`} disabled={busy !== null} onClick={() => launch(id)} data-testid={`scenario-${id}`}>
              {busy === id ? "Setting up…" : "Launch scenario"}
            </button>
          </Card>
        ))}
      </div>
      <button className={btnGhost} onClick={reset} disabled={busy !== null}>
        Reset demo data
      </button>
      {err && (
        <p role="alert" className="text-sm text-danger">
          {err}
        </p>
      )}
      {done && (
        <Card tone="ok" label="Scenario ready">
          <h2 className="font-semibold">{done.title} ready</h2>
          <p className="mt-1 text-sm">{done.description}</p>
          {done.utterance && (
            <p className="mt-2 text-sm">
              Say or type: <q>{done.utterance}</q>
            </p>
          )}
          <Link className={`${btnPrimary} mt-3`} href={done.utterance ? `/?say=${encodeURIComponent(done.utterance)}` : "/"}>
            Go to conversation
          </Link>
        </Card>
      )}
    </div>
  );
}
