# Implementation status (verified by running commands)

## Done and verified
- Monorepo (pnpm 12 workspace, Node 22, TS strict). `pnpm typecheck` clean.
- PostgreSQL schema + migration `init` (all spec entities incl. append-only IncidentEvent, ProviderRequest stand-in).
- Domain: explicit state machine, deterministic safety engine (sticky escalation). 12 unit tests.
- API (Fastify): demo HMAC bearer auth, health, REST incidents, Origin allowlist, error envelope.
- MCP: official SDK 1.32.1, Streamable HTTP at POST /mcp (stateless, JSON responses), 8 tools. Real SDK client integration tests (8): initialize, tools/list, create/idempotency, safety escalation, timeline pagination, cross-household denial, forged token, bad origin.

## Not done yet (do not treat as implemented)
- Tools: find_document_evidence, draft_repair_request, request_action_approval, execute_approved_action
- Document ingestion/search, evidence verification, simulated provider + outbox/recovery
- Agent orchestration + fixture LLM, conversations, REST for approvals/conversations/documents
- Entire frontend (Next.js), voice, Playwright E2E, CI, benchmarks, submission docs
- Rules verification of the hackathon site (no web fetch performed yet); HACKATHON_COMPLIANCE.md not written

## Deviations
- Docker Desktop is not installed on this machine; local Postgres runs via `embedded-postgres` (real PG 17). docker-compose.yml is provided but untested here.
- MCP endpoint lives in the API process (modular monolith) instead of a separate apps/mcp.
- MCP is stateless: GET/DELETE /mcp return 405.
