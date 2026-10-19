import { createPrisma } from "./db.js";
import { buildApp } from "./app.js";
const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) throw new Error("SESSION_SECRET (>=32 chars) is required");
const app = buildApp(createPrisma(), {
  sessionSecret: secret,
  demoMode: process.env.DEMO_MODE === "true",
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),
});
await app.listen({ port: Number(process.env.PORT ?? 4000), host: "127.0.0.1" });
