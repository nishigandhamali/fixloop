# FixLoop - submission summary

**What it is:** a voice-first household incident recovery concept (Alexa+ style simulation). A user reports a broken appliance; the agent runs a safety check, finds evidence in the user's own manuals/warranties (with page citations and verification status), drafts a repair request, and **only a human can approve it**. Execution is idempotent and reconciles ambiguous provider outcomes instead of guessing.

**Key properties (all covered by automated tests):**

- Safety gate: hazardous or unassessed incidents cannot produce a repair request.
- Evidence honesty: wrong-model manuals never show as Verified; prompt injection in documents is detected and never quoted.
- Human-only approval bound to a hash of the exact draft; tampering or expiry is refused.
- Exactly-once downstream request under retries, timeouts and concurrent execution.
- Accessible UI (axe), mobile layout, microphone-unavailable fallback.

**Verify:** `pnpm db:start &` then `pnpm verify && pnpm e2e` (94 unit/integration + 15 E2E tests). Screenshots: `docs/submission/screenshots/`.

**Honest limits:** see `docs/IMPLEMENTATION_STATUS.md` (demo auth only, simulated repair provider, lexical evidence verification, no outbox).
