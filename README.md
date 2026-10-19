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
