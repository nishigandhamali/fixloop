# Implementation status (verified by running commands)

Last verified: `pnpm typecheck` clean; `pnpm test` = 27 domain + 43 API = **70 passing, 0 failing, 0 skipped** (API suite run 5x consecutively, stable).

## Milestones
| # | Milestone | State |
|---|-----------|-------|
| 0-2 | Monorepo, schema, state machine, safety engine, MCP server (8 tools) | Done |
| 3 | Document ingestion, FTS retrieval, evidence verification, `find_document_evidence` | Done |
| 6 (backend) | Draft -> approval -> human decision -> idempotent execution -> reconciliation | Done (backend only) |
| 4 | Controlled agent / fixture LLM / conversations | **Not started** |
| 5 | Frontend (Next.js, voice) | **Not started** |
| 7-8 | E2E, CI, benchmarks, submission docs, compliance doc | **Not started** |

## Milestone 3 - what exists
- Migration `20261019020346_document_search`: `ApplianceDocument.declaredModels/declaredBrand/expiresOn`; `DocumentChunk.search` = `GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` + GIN index (hand-edited migration SQL; Prisma models the column as `Unsupported`).
- Ingestion (`POST /api/v1/documents`, raw body `application/pdf` | `text/plain`, metadata in query): size limit (`MAX_UPLOAD_BYTES`), magic-byte sniffing, UTF-8/NUL validation, PDF page cap (200) + parse timeout, filename sanitising, SHA-256 dedupe per household (race-safe via unique constraint), content-addressed `BlobStorage` (local FS), page-aware deterministic chunking. Typed errors: `UNSUPPORTED_MEDIA_TYPE`, `MALFORMED_PDF`, `CONTENT_TYPE_MISMATCH`, `INVALID_TEXT`, `EMPTY_DOCUMENT`, `PAYLOAD_TOO_LARGE`, `DOCUMENT_TOO_LONG`, `EXTRACTION_TIMEOUT`. Nothing is persisted for rejected files.
- Retrieval: `to_tsquery` OR-query over significant terms, ranked by `ts_rank_cd`, scoped to the authenticated household and the incident's appliance. Verification is computed on the *quoted snippet* (always an exact substring of the stored chunk), not the whole chunk.
- Classification (pure functions in `packages/domain/src/evidence.ts`): VERIFIED only if document model/brand match the registered appliance AND the snippet covers all question terms; wrong model => UNVERIFIED; model not stated => at most PARTIALLY_SUPPORTED; same-unit different values from matched-model sources => CONFLICTING; no chunk covering >=50% of terms => NOT_FOUND. Expired warranty text is downgraded VERIFIED -> PARTIALLY_SUPPORTED with an explicit uncertainty.
- Prompt injection: instruction-like sentences are detected, never quoted, never counted as support, and flagged (`instructionLikeContentIgnored`). The lookup is read-only (asserted: incident row, event count, approvals, repair requests, provider requests unchanged).
- Fixtures (synthetic, original; generator `apps/api/make-fixtures.mjs`, `pnpm fixtures:build`): correct manual PDF (with embedded injection on p.3), wrong-model manual PDF, expired warranty, no-coverage warranty, conflicting service bulletin. "Missing relevant evidence" is covered by an unanswerable question against the correct manual.
- `pnpm db:seed` now also ingests the correct manual + expired warranty for the demo appliance.

## Milestone 6 (backend) - what exists
- MCP tools: `draft_repair_request`, `request_action_approval`, `execute_approved_action` (now 12 tools registered incl. `find_document_evidence`; **`reopen_incident`/`resolve_incident` etc. unchanged**).
- Human-only approval: tokens carry a scope. `/mcp` accepts only `agent`; `POST /api/v1/approvals/:id/approve|reject`, resolve and reopen REST accept only `user`. There is no approve tool in MCP. (Demo auth only - see limitations.)
- Approval binds to a SHA-256 of the exact draft (recipient, subject, body). Tampering after request or after approval => `PAYLOAD_CHANGED`. Expiry (15 min, injected clock) gates approving and starting execution.
- Draft refuses unassessed (`SAFETY_NOT_CLEARED`) and hazardous (`SAFETY_BLOCKED`) incidents; quotes only VERIFIED facts with page citations; omits serial number.
- Execution (`ExecutionService`): `ToolExecution` row per (tool, actor, idempotency key) with `requestHash`; atomic claim with lease (30 s) for crash recovery; bounded exponential backoff with full jitter for `NOT_SENT` errors; `AMBIGUOUS` errors (timeout after send) trigger provider read-back *before* any retry; read-back failure => `UNKNOWN_OUTCOME` (draft not shown as sent); resume with same key reconciles first. Provider-native idempotency (`SimulatedRepairProvider`, own `ProviderRequest` table) guarantees one downstream request per repair request. Results always carry `externalCompletionVerified: false`.
- Fault injection for the simulated provider: `provider.script(...)` in tests and `POST /api/v1/demo/provider-faults` (user scope + demo mode) for the interrupted-submission scenario.

## Tests added since baseline (45 new -> 70 total)
- `packages/domain/tests/evidence.test.ts` (13), `approval.test.ts` (2)
- `apps/api/tests/documents.integration.test.ts` (17): real MCP client + real Postgres - gate scenario, page-citation accuracy (every citation resolves to a DB chunk containing the snippet), wrong-model, mixed-model, expired warranty, missing coverage, irrelevant question, conflicting sources, no-appliance, injection + zero-mutation, cross-household (MCP + REST), malformed/mismatched/binary/empty/unsupported uploads, dedupe, 413, restart durability.
- `apps/api/tests/repair.integration.test.ts` (18): golden path with ordered timeline, drafting rules, tamper (approve + execute), expiry, rejection, cross-household, 6-way concurrent execution, consumed approval, key reuse, retry/backoff, exhausted retries then success, timeout-after-send reconciliation, unknown outcome resumed from a new MCP session, never-landed resubmission, stale-lease crash recovery, permanent rejection, fault endpoint auth.
- A bug found and fixed by these tests: a new idempotency key against an already-consumed approval skipped validation when the draft was SENT (no duplicate was sent, but it should have been refused with `APPROVAL_ALREADY_CONSUMED`).

## Known limitations / honest gaps
- **No transactional outbox.** Side effect is called inline; safety comes from ToolExecution state + provider idempotency + reconciliation. The `OutboxEvent` table exists but is unused.
- No `build` script: the API runs via `tsx`; `pnpm typecheck` is the only compile check. No production bundle yet.
- Retrieval ranking order is produced by `ts_rank_cd` but no test asserts relative ranking between two relevant chunks. English-only text search config. Scanned PDFs (no text layer) are rejected - no OCR.
- Claim-vs-snippet verification is lexical (stemmed term coverage), so it can miss paraphrase and can be fooled by negation ("does NOT leak"). Conflict detection only compares quantities with units (months, days, psi, ...).
- Evidence results are not persisted to `EvidenceReference` (lookup is intentionally read-only).
- Only `fixloop_test`/`fixloop` embedded Postgres tested; `docker-compose.yml` untested (Docker not installed here).
- Auth is demo HMAC tokens only; no OAuth/PKCE, no CSRF needed yet (bearer header, no cookies), no rate limiting, MCP `GET/DELETE` return 405 (stateless).
- Not started: agent orchestration, conversations, frontend/voice, Playwright, CI, benchmarks, HACKATHON_COMPLIANCE.md (hackathon rules not yet verified against the live site), submission docs, ADRs.
- `resolve_incident` via MCP is still allowed for agent scope (REST resolve is user-only). Decide whether resolution should also be human-only.
- PDF test output prints pdf.js warnings to stderr in the malformed-upload test; harmless but noisy.
