import { createPrisma } from "./db.js";
import { buildApp } from "./app.js";
import { LocalFsStorage } from "./adapters/storage.js";
import { AnthropicLlmProvider, FixtureLlmProvider, ResilientLlm, type LlmProvider } from "./modules/agent/llm.js";
const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) throw new Error("SESSION_SECRET (>=32 chars) is required");
const fixture = new FixtureLlmProvider();
const primary: LlmProvider =
  process.env.LLM_PROVIDER === "anthropic"
    ? new AnthropicLlmProvider({ apiKey: process.env.LLM_API_KEY ?? "", model: process.env.LLM_MODEL ?? "" })
    : fixture;
const app = buildApp(createPrisma(), {
  llm: new ResilientLlm(primary, fixture),
  sessionSecret: secret,
  demoMode: process.env.DEMO_MODE === "true",
  storage: new LocalFsStorage(process.env.STORAGE_DIR ?? "./storage"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10_000_000),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),
});
await app.listen({ port: Number(process.env.PORT ?? 4000), host: "127.0.0.1" });
