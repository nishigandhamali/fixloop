import Fastify, { type FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import { issueToken, verifyToken, type TokenScope } from "./auth.js";
import type { Principal } from "./principal.js";
import { IncidentService } from "./modules/incidents/incident-service.js";
import { buildMcpServer } from "./mcp/server.js";
import { DocumentService } from "./modules/documents/document-service.js";
import { EvidenceService } from "./modules/documents/evidence-service.js";
import type { BlobStorage } from "./adapters/storage.js";
import { SimulatedRepairProvider, type Fault } from "./adapters/provider.js";
import { ConversationService } from "./modules/agent/conversation-service.js";
import { McpToolGateway, type ToolGateway } from "./modules/agent/tools.js";
import { FixtureLlmProvider, ResilientLlm, type LlmProvider } from "./modules/agent/llm.js";
import { DemoService, SCENARIOS } from "./modules/demo/demo-service.js";
import { RepairService } from "./modules/repair/repair-service.js";
import { ExecutionService, DEFAULT_RETRY, type RetryConfig } from "./modules/repair/execution-service.js";

export interface AppConfig { sessionSecret: string; demoMode: boolean; allowedOrigins: string[]; storage: BlobStorage; maxUploadBytes: number; now?: () => Date; provider?: SimulatedRepairProvider; retry?: RetryConfig; llm?: LlmProvider; gatewayFor?: (p: Principal) => ToolGateway }

declare module "fastify" { interface FastifyRequest { principal?: Principal } }

export function buildApp(db: Db, cfg: AppConfig): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { redact: ["req.headers.authorization"] }, bodyLimit: 1_000_000, genReqId: () => randomUUID() });
  const svc = new IncidentService(db);
  const docs = new DocumentService(db, cfg.storage, cfg.maxUploadBytes);
  const evidence = new EvidenceService(db, cfg.now);
  const provider = cfg.provider ?? new SimulatedRepairProvider(db);
  const repair = new RepairService(db, svc, evidence, cfg.now);
  const fixtureLlm = new FixtureLlmProvider();
  const llm = cfg.llm ?? new ResilientLlm(fixtureLlm, fixtureLlm);
  // The agent reaches the domain only through the real MCP endpoint of this same server, with a server-minted agent credential.
  const gatewayFor = cfg.gatewayFor ?? ((p: Principal) => {
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new AppError("NOT_LISTENING", "Server is not listening", 500);
    return new McpToolGateway(`http://127.0.0.1:${addr.port}/mcp`, issueToken(cfg.sessionSecret, p.userId, p.householdId, "agent", 120));
  });
  const conversations = new ConversationService(db, llm, gatewayFor);
  const exec = new ExecutionService(db, svc, provider, cfg.retry ?? DEFAULT_RETRY, cfg.now);

  // Uploads are raw bodies (application/pdf | text/plain) with metadata in the query string.
  for (const ct of ["application/pdf", "text/plain"]) app.addContentTypeParser(ct, { parseAs: "buffer", bodyLimit: cfg.maxUploadBytes }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { validation?: unknown; statusCode?: number };
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, correlationId: req.id } });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.issues.map((i) => i.message).join("; "), correlationId: req.id } });
    const sc = e.statusCode;
    if (sc === 413) return reply.status(413).send({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large", correlationId: req.id } });
    if (sc === 415) return reply.status(415).send({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported content type", correlationId: req.id } });
    if (sc && sc >= 400 && sc < 500) return reply.status(sc).send({ error: { code: "BAD_REQUEST", message: "Bad request", correlationId: req.id } });
    req.log.error({ err }, "unhandled");
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Unexpected error", correlationId: req.id } });
  });

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !cfg.allowedOrigins.includes(origin)) throw new AppError("ORIGIN_NOT_ALLOWED", "Origin not allowed", 403);
    if (origin) { reply.header("access-control-allow-origin", origin); reply.header("vary", "origin"); reply.header("access-control-allow-headers", "authorization,content-type,mcp-session-id,mcp-protocol-version"); reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS"); }
    if (req.method === "OPTIONS") return reply.status(204).send();
  });

  const authenticate = async (req: import("fastify").FastifyRequest, scopes?: TokenScope[]) => {
    const h = req.headers.authorization;
    const p = await verifyToken(db, cfg.sessionSecret, h?.startsWith("Bearer ") ? h.slice(7) : undefined, req.id, scopes);
    if (!p) throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
    req.principal = p;
    return p;
  };

  const idParam = (req: { params: unknown }) => z.object({ id: z.string().uuid() }).parse(req.params).id;
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try { await db.$queryRaw`SELECT 1`; return { status: "ready" }; } catch { return reply.status(503).send({ status: "db_unavailable" }); }
  });

  // --- local demo session (NOT production auth) ---
  app.post("/api/v1/demo/session", async () => {
    if (!cfg.demoMode) throw new AppError("DEMO_DISABLED", "Demo mode disabled", 404);
    const m = await db.householdMember.findFirst({ where: { household: { name: { startsWith: "Demo Household" } } } });
    if (!m) throw new AppError("NOT_SEEDED", "Run pnpm db:seed", 500);
    return { token: issueToken(cfg.sessionSecret, m.userId, m.householdId, "user"), agentToken: issueToken(cfg.sessionSecret, m.userId, m.householdId, "agent"), householdId: m.householdId };
  });
  app.get("/api/v1/session", async (req) => { const p = await authenticate(req); return { userId: p.userId, householdId: p.householdId, role: p.role }; });

  // --- REST surface (same services as MCP) ---
  app.get("/api/v1/appliances", async (req) => ({ appliances: await svc.listAppliances(await authenticate(req)) }));
  app.get("/api/v1/incidents", async (req) => {
    const p = await authenticate(req);
    const all = z.object({ all: z.enum(["1", "true"]).optional() }).parse(req.query).all;
    return { incidents: all ? await svc.listAll(p) : await svc.listActive(p) };
  });
  app.get("/api/v1/incidents/:id/evidence", async (req) => {
    const p = await authenticate(req);
    const q = z.object({ question: z.string().min(3).max(500) }).parse(req.query);
    return evidence.findForIncident(p, { incidentId: idParam(req), question: q.question });
  });
  app.post("/api/v1/incidents", async (req, reply) => {
    const p = await authenticate(req);
    const body = z.object({ applianceId: z.string().uuid().optional(), description: z.string().min(3).max(4000), idempotencyKey: z.string().min(8).max(128) }).parse(req.body);
    const r = await svc.create(p, body);
    return reply.status(r.replayed ? 200 : 201).send({ incident: r.incident, replayed: r.replayed });
  });
  app.get("/api/v1/incidents/:id", async (req) => svc.get(await authenticate(req), z.object({ id: z.string().uuid() }).parse(req.params).id));
  app.get("/api/v1/incidents/:id/events", async (req) => {
    const p = await authenticate(req);
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().uuid().optional() }).parse(req.query);
    return svc.timeline(p, id, q);
  });

  app.post("/api/v1/documents", { bodyLimit: cfg.maxUploadBytes }, async (req, reply) => {
    const p = await authenticate(req);
    const q = z.object({ filename: z.string().min(1).max(200), type: z.enum(["MANUAL", "WARRANTY", "RECEIPT", "LEASE", "OTHER"]), applianceId: z.string().uuid().optional() }).parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Send the file as application/pdf or text/plain", 415);
    const r = await docs.ingest(p, { filename: q.filename, type: q.type, applianceId: q.applianceId, contentType: req.headers["content-type"] ?? "", bytes: req.body });
    return reply.status(r.duplicate ? 200 : 201).send({ document: r.document, duplicate: r.duplicate, chunkCount: r.chunkCount });
  });
  app.get("/api/v1/documents", async (req) => ({ documents: await docs.list(await authenticate(req), z.object({ applianceId: z.string().uuid().optional() }).parse(req.query).applianceId) }));
  app.get("/api/v1/documents/:id", async (req) => ({ document: await docs.get(await authenticate(req), z.object({ id: z.string().uuid() }).parse(req.params).id) }));

  // --- conversations (browser/user scope; the agent acts via MCP, never with this credential) ---
  app.post("/api/v1/conversations", async (req, reply) => reply.status(201).send({ session: await conversations.start(await authenticate(req, ["user"])) }));
  app.get("/api/v1/conversations/:id", async (req) => conversations.get(await authenticate(req, ["user"]), z.object({ id: z.string().uuid() }).parse(req.params).id));
  app.post("/api/v1/conversations/:id/messages", async (req) => {
    const p = await authenticate(req, ["user"]);
    const body = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
    return conversations.send(p, z.object({ id: z.string().uuid() }).parse(req.params).id, body.text);
  });

  app.get("/api/v1/households/current", async (req) => {
    const p = await authenticate(req);
    const h = await db.household.findUniqueOrThrow({ where: { id: p.householdId } });
    return { household: { id: h.id, name: h.name, timezone: h.timezone }, role: p.role };
  });
  app.get("/api/v1/appliances/:id", async (req) => {
    const p = await authenticate(req);
    const a = await db.appliance.findUnique({ where: { id: idParam(req) } });
    if (!a || a.householdId !== p.householdId) throw new AppError("APPLIANCE_NOT_FOUND", "appliance not found", 404);
    return { appliance: a, documents: await docs.list(p, a.id) };
  });
  app.post("/api/v1/appliances", async (req, reply) => {
    const p = await authenticate(req, ["user"]);
    if (p.role === "VIEWER") throw new AppError("FORBIDDEN", "Not authorized for this resource", 403);
    const b = z.object({ category: z.string().min(2).max(40), brand: z.string().min(1).max(60), modelNumber: z.string().min(2).max(60), serialNumber: z.string().max(60).optional(), location: z.string().max(60).optional(), notes: z.string().max(500).optional() }).parse(req.body);
    return reply.status(201).send({ appliance: await db.appliance.create({ data: { ...b, householdId: p.householdId } }) });
  });
  app.patch("/api/v1/appliances/:id", async (req) => {
    const p = await authenticate(req, ["user"]);
    const cur = await db.appliance.findUnique({ where: { id: idParam(req) } });
    if (!cur || cur.householdId !== p.householdId) throw new AppError("APPLIANCE_NOT_FOUND", "appliance not found", 404);
    const b = z.object({ brand: z.string().min(1).max(60), modelNumber: z.string().min(2).max(60), location: z.string().max(60).nullable(), notes: z.string().max(500).nullable() }).partial().parse(req.body);
    return { appliance: await db.appliance.update({ where: { id: cur.id }, data: b }) };
  });

  const demo = new DemoService(db, cfg.storage, svc, repair, exec, provider);
  const demoApplianceId = async (p: Principal) => (await db.appliance.findFirstOrThrow({ where: { householdId: p.householdId }, orderBy: { createdAt: "asc" } })).id;
  app.post("/api/v1/demo/reset", async (req) => {
    const p = await authenticate(req, ["user"]);
    if (!cfg.demoMode) throw new AppError("DEMO_DISABLED", "Demo mode disabled", 404);
    return demo.reset(p, await demoApplianceId(p));
  });
  app.post("/api/v1/demo/scenario", async (req) => {
    const p = await authenticate(req, ["user"]);
    if (!cfg.demoMode) throw new AppError("DEMO_DISABLED", "Demo mode disabled", 404);
    const b = z.object({ scenario: z.enum(SCENARIOS) }).parse(req.body);
    return demo.launch(p, b.scenario, await demoApplianceId(p));
  });

  // --- approvals: human decisions require a scope:"user" credential; the MCP/agent credential is refused ---
  app.get("/api/v1/approvals/:id", async (req) => repair.getApproval(await authenticate(req), idParam(req)));
  app.post("/api/v1/approvals/:id/approve", async (req) => repair.decide(await authenticate(req, ["user"]), idParam(req), "APPROVED"));
  app.post("/api/v1/approvals/:id/reject", async (req) => repair.decide(await authenticate(req, ["user"]), idParam(req), "REJECTED"));
  app.post("/api/v1/incidents/:id/resolve", async (req) => {
    const b = z.object({ resolutionSummary: z.string().min(1).max(2000), idempotencyKey: z.string().min(8).max(128) }).parse(req.body);
    return svc.resolve(await authenticate(req, ["user"]), idParam(req), b.resolutionSummary, b.idempotencyKey);
  });
  app.post("/api/v1/incidents/:id/reopen", async (req) => svc.reopen(await authenticate(req, ["user"]), idParam(req), z.object({ reason: z.string().min(1).max(1000) }).parse(req.body).reason));

  // Demo-only fault injection for the simulated provider (interrupted-submission scenario).
  app.post("/api/v1/demo/provider-faults", async (req) => {
    await authenticate(req, ["user"]);
    if (!cfg.demoMode) throw new AppError("DEMO_DISABLED", "Demo mode disabled", 404);
    const b = z.object({ faults: z.array(z.enum(["submit:fail_before", "submit:timeout_after", "submit:reject", "lookup:fail"])).max(10) }).parse(req.body);
    provider.script(...(b.faults as Fault[]));
    return { scripted: b.faults };
  });

  // --- MCP Streamable HTTP (stateless: one server+transport per request, bound to the authenticated principal) ---
  app.route({ method: ["POST", "GET", "DELETE"], url: "/mcp", handler: async (req, reply) => {
    const p = await authenticate(req, ["agent"]);
    if (req.method !== "POST") { // stateless mode: no server-initiated SSE stream or sessions
      return reply.status(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
    }
    const server = buildMcpServer({ incidents: svc, evidence, repair, exec }, p);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  } });

  return app;
}
