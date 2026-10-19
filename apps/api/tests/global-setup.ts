import { execSync } from "node:child_process";
import pg from "node:net";

const BASE = "postgresql://fixloop:fixloop@localhost:54329";
export default async function setup() {
  const url = `${BASE}/fixloop_test`;
  process.env.TEST_DATABASE_URL = url;
  const { PrismaClient } = await import("@prisma/client");
  const admin = new PrismaClient({ datasources: { db: { url: `${BASE}/postgres` } } });
  try { await admin.$executeRawUnsafe("CREATE DATABASE fixloop_test"); } catch { /* exists */ }
  await admin.$disconnect();
  execSync("pnpm exec prisma migrate deploy", { cwd: "../..", env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  void pg;
}
