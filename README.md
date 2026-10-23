# FixLoop

Voice-first household incident recovery, built as an Alexa+ concept simulation (not an official Alexa product; no native Alexa/Echo integration is claimed).

## Status

See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for what genuinely works today.

## Run locally (no Docker required)

    pnpm install            # pnpm 12, Node >= 22
    cp .env.example .env
    pnpm db:start &         # real PostgreSQL 17 via embedded-postgres on :54329 (or: docker compose up -d)
    pnpm db:migrate && pnpm db:seed
    pnpm dev                # API + MCP at http://127.0.0.1:4000 (POST /mcp)
    pnpm verify             # typecheck + tests

## Delivery: simulated or real email

After you approve a repair request, FixLoop delivers it one of two ways, chosen by `DELIVERY` in `.env`:

- `simulated` (default): the request is stored in the local `ProviderRequest` table. No technician is contacted.
- `email`: the exact approved text is emailed through the [Resend](https://resend.com) API. Set `EMAIL_API_KEY`, `EMAIL_FROM` and `TECHNICIAN_EMAIL`. With Resend's test sender (`onboarding@resend.dev`) mail can only go to the address that owns the Resend account, so use that address as `TECHNICIAN_EMAIL` to try it safely.

In email mode the recipient address is on the approval card, is covered by the approval hash, and the request is sent at most once (the request's idempotency key is the email service's `Idempotency-Key`). The demo scenarios that submit a request or inject faults are disabled, because they only make sense with the simulated provider.
