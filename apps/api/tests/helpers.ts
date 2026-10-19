import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { LocalFsStorage } from "../src/adapters/storage.js";
import { issueToken } from "../src/auth.js";
import { seed, SEED_IDS } from "../../../prisma/seed.js";

export const SECRET = "test-secret-0123456789abcdef0123456789";
export const FIXED_NOW = new Date("2026-10-18T12:00:00Z");
export { SEED_IDS };

export interface StartOptions { reset?: boolean; storageDir?: string; maxUploadBytes?: number }

export async function startApp(opts: StartOptions = {}) {
  const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  if (opts.reset !== false) {
    await db.$executeRawUnsafe(`TRUNCATE "IncidentEvent","SafetyAssessment","EvidenceReference","RepairRequest","Approval","Incident","ToolExecution","OutboxEvent","ProviderRequest","DocumentChunk","ApplianceDocument" RESTART IDENTITY CASCADE`);
    await seed(db);
  }
  const storageDir = opts.storageDir ?? mkdtempSync(join(tmpdir(), "fixloop-test-"));
  const storage = new LocalFsStorage(storageDir);
  const app: FastifyInstance = buildApp(db, { sessionSecret: SECRET, demoMode: true, allowedOrigins: ["http://localhost:3000"], storage, maxUploadBytes: opts.maxUploadBytes ?? 2_000_000, now: () => FIXED_NOW });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, db, url, storage, storageDir, close: async () => { await app.close(); await db.$disconnect(); } };
}

export const tokenFor = (userId: string, householdId: string) => issueToken(SECRET, userId, householdId);

export async function mcpClient(baseUrl: string, token: string) {
  const client = new Client({ name: "fixloop-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return { client, transport };
}
