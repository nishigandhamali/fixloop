import Fastify, { type FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import { issueToken, verifyToken } from "./auth.js";
import type { Principal } from "./principal.js";
import { IncidentService } from "./modules/incidents/incident-service.js";
import { buildMcpServer } from "./mcp/server.js";
import { DocumentService } from "./modules/documents/document-service.js";
import { EvidenceService } from "./modules/documents/evidence-service.js";
import type { BlobStorage } from "./adapters/storage.js";

export interface AppConfig { sessionSecret: string; demoMode: boolean; allowedOrigins: string[]; storage: BlobStorage; maxUploadBytes: number; now?: () => Date }

declare module "fastify" { interface FastifyRequest { principal?: Principal } }

export function buildApp(db: Db, cfg: AppConfig): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { redact: ["req.headers.authorization"] }, bodyLimit: 1_000_000, genReqId: () => randomUUID() });
  const svc = new IncidentService(db);
  const docs = new DocumentService(db, cfg.storage, cfg.maxUploadBytes);
  const evidence = new EvidenceService(db, cfg.now);

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

  const authenticate = async (req: import("fastify").FastifyRequest) => {
    const h = req.headers.authorization;
    const p = await verifyToken(db, cfg.sessionSecret, h?.startsWith("Bearer ") ? h.slice(7) : undefined, req.id);
    if (!p) throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
    req.principal = p;
    return p;
  };

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try { await db.$queryRaw`SELECT 1`; return { status: "ready" }; } catch { return reply.status(503).send({ status: "db_unavailable" }); }
  });

  // --- local demo session (NOT production auth) ---
  app.post("/api/v1/demo/session", async () => {
    if (!cfg.demoMode) throw new AppError("DEMO_DISABLED", "Demo mode disabled", 404);
    const m = await db.householdMember.findFirst({ where: { household: { name: { startsWith: "Demo Household" } } } });
    if (!m) throw new AppError("NOT_SEEDED", "Run pnpm db:seed", 500);
    return { token: issueToken(cfg.sessionSecret, m.userId, m.householdId), householdId: m.householdId };
  });
  app.get("/api/v1/session", async (req) => { const p = await authenticate(req); return { userId: p.userId, householdId: p.householdId, role: p.role }; });

  // --- REST surface (same services as MCP) ---
  app.get("/api/v1/appliances", async (req) => ({ appliances: await svc.listAppliances(await authenticate(req)) }));
  app.get("/api/v1/incidents", async (req) => ({ incidents: await svc.listActive(await authenticate(req)) }));
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

  // --- MCP Streamable HTTP (stateless: one server+transport per request, bound to the authenticated principal) ---
  app.route({ method: ["POST", "GET", "DELETE"], url: "/mcp", handler: async (req, reply) => {
    const p = await authenticate(req);
    if (req.method !== "POST") { // stateless mode: no server-initiated SSE stream or sessions
      return reply.status(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
    }
    const server = buildMcpServer({ incidents: svc, evidence }, p);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  } });

  return app;
}
