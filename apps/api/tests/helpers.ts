import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { issueToken } from "../src/auth.js";
import { seed, SEED_IDS } from "../../../prisma/seed.js";

export const SECRET = "test-secret-0123456789abcdef0123456789";
export { SEED_IDS };

export async function startApp() {
  const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  await db.$executeRawUnsafe(`TRUNCATE "IncidentEvent","SafetyAssessment","EvidenceReference","RepairRequest","Approval","Incident","ToolExecution","OutboxEvent","ProviderRequest" RESTART IDENTITY CASCADE`);
  await seed(db);
  const app: FastifyInstance = buildApp(db, { sessionSecret: SECRET, demoMode: true, allowedOrigins: ["http://localhost:3000"] });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, db, url, close: async () => { await app.close(); await db.$disconnect(); } };
}

export const tokenFor = (userId: string, householdId: string) => issueToken(SECRET, userId, householdId);

export async function mcpClient(baseUrl: string, token: string) {
  const client = new Client({ name: "fixloop-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return { client, transport };
}
