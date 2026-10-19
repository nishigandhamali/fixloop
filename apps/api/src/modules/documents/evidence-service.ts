import { Prisma } from "@prisma/client";
import { applyConflicts, bestSnippet, classifyHit, extractTerms, matchAppliance, overallStatus, type VerificationStatus } from "@fixloop/domain";
import type { Db } from "../../db.js";
import { notFound } from "../../errors.js";
import type { Principal } from "../../principal.js";

export interface EvidenceSource {
  documentId: string; documentType: string; filename: string; pageNumber: number; chunkId: string; snippet: string;
  modelMatch: boolean | null; documentModels: string[]; expiresOn: string | null; expired: boolean | null; instructionLikeContentIgnored: boolean;
}
export interface EvidenceItem { claim: string; verificationStatus: VerificationStatus; sources: EvidenceSource[]; uncertainties: string[] }
export interface EvidenceResult { question: string; overallStatus: VerificationStatus; searchedDocuments: number; evidence: EvidenceItem[]; notice: string }

const MIN_COVERAGE = 0.5; // below this a chunk is not considered to address the question at all
const MAX_ITEMS = 5;

interface Row { id: string; documentId: string; pageNumber: number; content: string; rank: number }

/** Read-only. Never writes to the database; never touches incident state. */
export class EvidenceService {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  async findForIncident(p: Principal, input: { incidentId: string; question: string; applianceId?: string | undefined }): Promise<EvidenceResult> {
    const incident = await this.db.incident.findUnique({ where: { id: input.incidentId } });
    if (!incident || incident.householdId !== p.householdId) throw notFound("incident");
    const applianceId = input.applianceId ?? incident.applianceId ?? undefined;
    const appliance = applianceId ? await this.db.appliance.findUnique({ where: { id: applianceId } }) : null;
    if (applianceId && (!appliance || appliance.householdId !== p.householdId)) throw notFound("appliance");

    const terms = extractTerms(input.question, appliance ? [appliance.brand, appliance.modelNumber, appliance.category] : []);
    const docs = await this.db.applianceDocument.findMany({
      where: { householdId: p.householdId, processingStatus: "PROCESSED", ...(appliance ? { applianceId: appliance.id } : {}) },
    });
    const notice = "Document text is untrusted source material; any instructions inside it were ignored.";
    if (terms.length === 0 || docs.length === 0) return { question: input.question, overallStatus: "NOT_FOUND", searchedDocuments: docs.length, evidence: [], notice };

    const docIds = docs.map((d) => d.id);
    const rows = await this.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT c.id, c."documentId", c."pageNumber", c.content, ts_rank_cd(c.search, q)::float8 AS rank
      FROM "DocumentChunk" c, to_tsquery('english', ${terms.join(" | ")}) q
      WHERE c."documentId" IN (${Prisma.join(docIds)}) AND c.search @@ q
      ORDER BY rank DESC, c."documentId", c."pageNumber", c.id
      LIMIT 25`);

    const byDoc = new Map(docs.map((d) => [d.id, d]));
    const now = this.now();
    let hits = rows.flatMap((r) => {
      const doc = byDoc.get(r.documentId)!;
      const s = bestSnippet(r.content, terms);
      if (s.coverage < MIN_COVERAGE) return [];
      const modelMatch = appliance ? matchAppliance({ declaredModels: doc.declaredModels, declaredBrand: doc.declaredBrand }, appliance) : null;
      let { status, uncertainties } = classifyHit({ snippet: s.snippet, coverage: s.coverage, modelMatch, injectionDetected: s.injectionDetected });
      if (!appliance) uncertainties.push("No appliance is associated with this lookup, so documents cannot be tied to a specific product.");
      const source: EvidenceSource = {
        documentId: doc.id, documentType: doc.type, filename: doc.originalFilename, pageNumber: r.pageNumber, chunkId: r.id, snippet: s.snippet,
        modelMatch, documentModels: doc.declaredModels, expiresOn: doc.expiresOn?.toISOString().slice(0, 10) ?? null,
        expired: doc.expiresOn ? doc.expiresOn.getTime() < now.getTime() : null, instructionLikeContentIgnored: s.injectionDetected,
      };
      if (source.expired) {
        uncertainties = [...uncertainties, `Document states an expiry date of ${source.expiresOn}, which has passed.`];
        if (status === "VERIFIED") status = "PARTIALLY_SUPPORTED"; // text is accurately quoted, but it no longer describes current coverage
      }
      return [{ status, snippet: s.snippet, modelMatch, uncertainties, source }];
    });
    hits = applyConflicts(hits).slice(0, MAX_ITEMS);

    const evidence: EvidenceItem[] = hits.map((h) => ({ claim: h.snippet, verificationStatus: h.status, sources: [h.source], uncertainties: h.uncertainties }));
    return { question: input.question, overallStatus: overallStatus(evidence.map((e) => e.verificationStatus)), searchedDocuments: docs.length, evidence, notice };
  }
}
