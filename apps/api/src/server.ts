import { createPrisma } from "./db.js";
import { buildApp } from "./app.js";
import { LocalFsStorage } from "./adapters/storage.js";
const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) throw new Error("SESSION_SECRET (>=32 chars) is required");
const app = buildApp(createPrisma(), {
  sessionSecret: secret,
  demoMode: process.env.DEMO_MODE === "true",
  storage: new LocalFsStorage(process.env.STORAGE_DIR ?? "./storage"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10_000_000),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),
});
await app.listen({ port: Number(process.env.PORT ?? 4000), host: "127.0.0.1" });
