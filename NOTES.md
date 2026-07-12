# PromptBus — Development

## Architecture

```
Claude Code → PromptBus (port 4701) → api.anthropic.com
                 ↓
         SQLite logs + Dashboard (port 4702)
```

PromptBus is a transparent HTTP reverse proxy. It intercepts Claude Code's API
requests, classifies the task type via keyword heuristics, consults
`config/rules.yaml` for routing rules, optionally rewrites the `model`/`effort`
fields, and forwards to Anthropic. Responses stream back unchanged.

## Modules

| Module | File | Purpose |
|--------|------|---------|
| CLI | `src/cli/index.ts` | `install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs` |
| Classifier | `src/core/classifier/classifier.ts` | Keyword-heuristic task type detection (7 types) |
| Rules Engine | `src/core/rules_engine/rules_engine.ts` | Loads `rules.yaml`, applies `TaskProfile` → `RoutingDecision` |
| Proxy | `src/core/proxy/server.ts`, `handler.ts` | HTTP server, upstream forwarding, request rewriting, error forwarding |
| Logger | `src/core/logger/logger.ts` | SQLite logging, pricing sync, log pruning, CSV export |
| Dashboard | `src/dashboard/server.ts`, `public/index.html` | Express app + SPA for stats, logs, rules editor |

## Model IDs

Current model IDs in `config/rules.yaml` should be verified against
https://docs.anthropic.com/en/docs/about-claude/models before release.

## Settings

PromptBus configures Claude Code via `ANTHROPIC_BASE_URL` in three settings files
(descending precedence):

- **Local**: `.claude/settings.local.json` (gitignored by default)
- **Project**: `.claude/settings.json`
- **User** (lowest): `~/.claude/settings.json`

The `env` block syntax:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:4701" } }
```
