# Hackathon compliance checklist

**The official rules have not been verified against the live hackathon site.** Fill in the "Rule" column from the source before submitting; the "Evidence" column is what the repo already provides.

| Area                      | Rule (to confirm) | Evidence in this repo                                                                                  |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| Original work             | _confirm_         | Own code, MIT `LICENSE`; fixtures are synthetic (`apps/api/make-fixtures.mjs`).                        |
| Third-party / open source | _confirm_         | Dependencies pinned in `pnpm-lock.yaml`.                                                               |
| Alexa branding            | _confirm_         | README states this is a concept simulation; no native Alexa/Echo integration is claimed.               |
| Data / privacy            | _confirm_         | Demo data only, no real PII; documents scoped per household; serial numbers omitted from drafts.       |
| AI use disclosure         | _confirm_         | Default LLM is a deterministic fixture; Anthropic adapter optional (`LLM_PROVIDER=anthropic`).         |
| Demo video / screenshots  | _confirm_         | Screenshots in `docs/submission/screenshots/` (regenerate: `SHOTS=1 pnpm e2e`). No video recorded yet. |
| Public repo / setup       | _confirm_         | README "Run locally"; CI workflow in `.github/workflows/ci.yml`.                                       |
