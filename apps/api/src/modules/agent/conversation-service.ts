import { Prisma } from "@prisma/client";
import type { Db } from "../../db.js";
import { forbidden, notFound } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { Coordinator, type SessionState, type TurnResult } from "./coordinator.js";
import type { LlmProvider } from "./llm.js";
import type { ToolGateway } from "./tools.js";

export class ConversationService {
  constructor(
    private readonly db: Db,
    private readonly llm: LlmProvider,
    private readonly gatewayFor: (p: Principal) => ToolGateway,
  ) {}

  async start(p: Principal) {
    return this.db.conversationSession.create({ data: { userId: p.userId, householdId: p.householdId } });
  }

  private async load(p: Principal, id: string) {
    const s = await this.db.conversationSession.findUnique({ where: { id } });
    if (!s || s.householdId !== p.householdId) throw notFound("conversation");
    if (s.userId !== p.userId) throw forbidden();
    return s;
  }

  async get(p: Principal, id: string) {
    const s = await this.load(p, id);
    return {
      session: s,
      messages: await this.db.conversationMessage.findMany({ where: { sessionId: id }, orderBy: [{ timestamp: "asc" }, { id: "asc" }] }),
    };
  }

  async send(p: Principal, id: string, text: string): Promise<TurnResult & { messageId: string; degraded: boolean }> {
    const s = await this.load(p, id);
    if (p.role === "VIEWER") throw forbidden();
    const userMsg = await this.db.conversationMessage.create({
      data: { sessionId: id, role: "user", content: text, incidentId: (s.state as SessionState).incidentId ?? null },
    });
    const gw = this.gatewayFor(p);
    let result: TurnResult;
    try {
      result = await new Coordinator(this.llm, gw).handle(p, text, s.state as SessionState, userMsg.id);
    } finally {
      await gw.close();
    }
    const assistant = await this.db.conversationMessage.create({
      data: { sessionId: id, role: "assistant", content: result.spoken, incidentId: result.incidentId, ...(result.cards.length ? {} : {}) },
    });
    await this.db.conversationSession.update({
      where: { id },
      data: {
        incidentId: result.incidentId,
        state: result.state as unknown as Prisma.InputJsonValue,
        compactSummary: result.summary || s.compactSummary,
        lastMessageAt: new Date(),
      },
    });
    return { ...result, messageId: assistant.id, degraded: (this.llm as { degraded?: boolean }).degraded === true };
  }
}
