import { ScenarioLauncher } from "@/components/dashboard/ScenarioLauncher";
import { apiGet } from "@/lib/api";

export const dynamic = "force-dynamic";
export default async function Demo() {
  await apiGet("/api/v1/session", "/demo"); // ensures a session cookie exists
  return (
    <div className="space-y-4">
      <h1 className="font-display text-3xl tracking-tight">Demo scenario launcher</h1>
      <ScenarioLauncher />
    </div>
  );
}
