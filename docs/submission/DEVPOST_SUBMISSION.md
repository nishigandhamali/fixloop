# Devpost submission draft (edit before pasting)

**Track:** Alexa+ (self-hosted MCP server over Streamable HTTP, plus a simulated Alexa+ voice experience). **Mini challenge:** Open Source (new MIT-licensed repo). Not AWS Builder.

## Text description

FixLoop is a voice-first household incident recovery agent. A user says "my dishwasher is leaking"; FixLoop runs a safety check (hazards escalate immediately and block any repair request), finds answers in the user's own manuals and warranties with page citations and honest verification status, drafts a repair request, and waits for the human to approve it. Execution is idempotent and reconciles ambiguous provider outcomes (for example a timeout after send) instead of guessing, so the user is never told something was sent when it may not have been.

The core is a self-hosted MCP server (spec 2025-11-25, Streamable HTTP, 10 tools) that a controlled agent calls through a real MCP client, phase-gated so each step can only use the tools allowed for that phase. Approving, resolving and reopening are human-only and are deliberately not exposed as MCP tools. The Next.js web app simulates the Alexa+ experience: voice console with a text fallback, approval cards, evidence viewer, incident timeline, appliance/document library and demo scenarios (emergency, wrong-model manual, interrupted submission).

Trust features: evidence is VERIFIED only when the document's model matches the registered appliance and the quoted snippet covers the question; wrong-model manuals never show as verified; instruction-like text inside documents is detected and never quoted or obeyed; approvals are bound to a hash of the exact draft; simple negation in sources ("does NOT leak") is detected.

Built during the window: all of it (first commit 2026-10-18). 94 unit/integration tests and 15 Playwright E2E tests (including axe accessibility and mobile) pass.

Honest limits: the repair provider is simulated, auth is demo-only, and evidence verification is lexical.

## Product feedback (MCP / Alexa+ track)

- **Tools used:** MCP spec and TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1) for the server (Streamable HTTP, stateless) and client; Alexa+ simulated in a web app.
- **What worked well:** _(edit)_ e.g. the SDK's server/client pair made real end-to-end tests easy; structured output schemas and tool annotations (`readOnlyHint`) mapped cleanly to our read/write split.
- **What needs work:** _(edit)_ e.g. no standard way for a tool to declare "human approval required"; we modelled it by omitting the approval tool and using scoped credentials. No official Alexa+ test harness to run the MCP server against, so Alexa+ was simulated.
- **Onboarding:** _(edit with your real experience)_
- **Build again?** _(Yes/No + why)_

## Optional friction log (up to 10% bonus; replace with real entries)

1. Task: expose an MCP server to an assistant that must never perform human-only decisions. Expected: a per-tool approval/consent marker. Actual: had to omit the tools and enforce scope outside MCP. Severity: medium. Workaround: scope-bearing bearer tokens, `/mcp` accepts agent scope only. Suggestion: standard tool metadata for "requires human confirmation".

## 3-minute demo video script

0:00-0:20 Problem + "FixLoop, an Alexa+-style agent over a self-hosted MCP server". 0:20-1:10 Report a leaking dishwasher by voice -> safety questions -> evidence card with page citation. 1:10-1:50 Draft + approval card; approve as the human; submission; show timeline. 1:50-2:20 Emergency scenario (outlet hazard) blocks repair; wrong-model manual shows UNVERIFIED. 2:20-2:45 Interrupted submission -> honest "unknown outcome" -> safe recovery with no duplicate. 2:45-3:00 Show `/mcp` tool list, tests passing, repo URL.
