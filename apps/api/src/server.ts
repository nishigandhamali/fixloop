import { createPrisma } from "./db.js";
import { buildApp, type AppConfig } from "./app.js";
import { LocalFsStorage } from "./adapters/storage.js";
import { EmailRepairProvider } from "./adapters/provider.js";
import { AnthropicLlmProvider, FixtureLlmProvider, ResilientLlm, type LlmProvider } from "./modules/agent/llm.js";
const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) throw new Error("SESSION_SECRET (>=32 chars) is required");
const fixture = new FixtureLlmProvider();
const primary: LlmProvider =
  process.env.LLM_PROVIDER === "anthropic"
    ? new AnthropicLlmProvider({ apiKey: process.env.LLM_API_KEY ?? "", model: process.env.LLM_MODEL ?? "" })
    : fixture;

// DELIVERY=simulated (default) stores approved requests in the local database; DELIVERY=email sends them as real emails.
const delivery = process.env.DELIVERY ?? "simulated";
if (delivery !== "simulated" && delivery !== "email") throw new Error('DELIVERY must be "simulated" or "email"');
let realDelivery: Pick<AppConfig, "provider" | "recipients"> = {};
if (delivery === "email") {
  const { EMAIL_API_KEY: apiKey, EMAIL_FROM: from, TECHNICIAN_EMAIL: technician } = process.env;
  if (!apiKey || !from || !technician) throw new Error("DELIVERY=email requires EMAIL_API_KEY, EMAIL_FROM and TECHNICIAN_EMAIL");
  realDelivery = { provider: new EmailRepairProvider({ apiKey, from }), recipients: { REPAIR_TECHNICIAN: technician } };
}
const app = buildApp(createPrisma(), {
  ...realDelivery,
  llm: new ResilientLlm(primary, fixture),
  sessionSecret: secret,
  demoMode: process.env.DEMO_MODE === "true",
  storage: new LocalFsStorage(process.env.STORAGE_DIR ?? "./storage"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10_000_000),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),
});
await app.listen({ port: Number(process.env.PORT ?? 4000), host: "127.0.0.1" });
