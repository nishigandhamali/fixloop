import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppError } from "../../errors.js";

export type Phase = "UNDERSTAND" | "SAFETY_CHECK" | "DISCOVER_CONTEXT" | "GATHER_EVIDENCE" | "PROPOSE_ACTION" | "AWAIT_APPROVAL" | "EXECUTE" | "SUMMARIZE";

/** Tool allowlist per phase. A tool outside the current phase is refused before any network call. */
export const PHASE_TOOLS: Record<Phase, readonly string[]> = {
  UNDERSTAND: [],
  SAFETY_CHECK: ["create_incident", "assess_incident_safety"],
  DISCOVER_CONTEXT: ["list_household_appliances", "list_active_incidents", "get_incident", "get_incident_timeline"],
  GATHER_EVIDENCE: ["find_document_evidence"],
  PROPOSE_ACTION: ["draft_repair_request", "request_action_approval"],
  AWAIT_APPROVAL: ["get_incident"],
  EXECUTE: ["execute_approved_action"],
  SUMMARIZE: ["get_incident", "get_incident_timeline", "resolve_incident"],
};
export const MAX_TOOL_CALLS_PER_TURN = 6;

export interface ToolResult { ok: boolean; data: Record<string, any>; errorCode?: string }
export interface ToolGateway { call(name: string, args: Record<string, unknown>): Promise<ToolResult>; close(): Promise<void> }

/** Calls the FixLoop MCP server over real Streamable HTTP using the official SDK client. */
export class McpToolGateway implements ToolGateway {
  private client: Client | null = null;
  constructor(private readonly url: string, private readonly agentToken: string) {}
  private async connect() {
    if (this.client) return this.client;
    const c = new Client({ name: "fixloop-agent", version: "0.1.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { authorization: `Bearer ${this.agentToken}` } } }));
    return (this.client = c);
  }
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const c = await this.connect();
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
    const data = r.structuredContent ?? {};
    return r.isError ? { ok: false, data, errorCode: data.error?.code ?? "TOOL_ERROR" } : { ok: true, data };
  }
  async close() { await this.client?.close().catch(() => undefined); this.client = null; }
}

export interface ToolTrace { name: string; phase: Phase; ok: boolean; ms: number; errorCode?: string }

/** Bounded, phase-gated executor. The agent cannot call anything else. */
export class ToolExecutor {
  readonly trace: ToolTrace[] = [];
  phase: Phase = "UNDERSTAND";
  constructor(private readonly gw: ToolGateway, private readonly max = MAX_TOOL_CALLS_PER_TURN) {}
  async call(phase: Phase, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.phase = phase;
    if (!PHASE_TOOLS[phase].includes(name)) throw new AppError("TOOL_NOT_ALLOWED", `Tool ${name} is not allowed in phase ${phase}`, 500);
    if (this.trace.length >= this.max) throw new AppError("TOOL_BUDGET_EXCEEDED", "Too many tool calls in one turn", 500);
    const t0 = performance.now();
    try {
      const r = await this.gw.call(name, args);
      this.trace.push({ name, phase, ok: r.ok, ms: Math.round(performance.now() - t0), ...(r.errorCode ? { errorCode: r.errorCode } : {}) });
      return r;
    } catch (e) {
      this.trace.push({ name, phase, ok: false, ms: Math.round(performance.now() - t0), errorCode: "TRANSPORT" });
      throw e;
    }
  }
}
