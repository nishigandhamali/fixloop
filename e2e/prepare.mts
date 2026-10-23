import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export const E2E_DB = "postgresql://fixloop:fixloop@localhost:54329/fixloop_e2e";
async function prepare() {
  const admin = new PrismaClient({ datasources: { db: { url: "postgresql://fixloop:fixloop@localhost:54329/postgres" } } });
  try {
    await admin.$executeRawUnsafe("CREATE DATABASE fixloop_e2e");
  } catch {
    /* exists */
  }
  await admin.$disconnect();
  const env = { ...process.env, DATABASE_URL: E2E_DB, STORAGE_DIR: "./.e2e-storage" };
  execSync("pnpm exec prisma migrate deploy", { env, stdio: "pipe" });
  execSync("pnpm --filter @fixloop/api exec tsx src/cli/seed.ts", { env, stdio: "pipe" });
}
await prepare();
