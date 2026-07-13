# PromptBus

Local reverse proxy for Claude Code that routes API requests to the cheapest capable model.

## How it works

PromptBus sits between Claude Code and Anthropic's API. It inspects each request, classifies the task difficulty using keyword heuristics, and rewrites the `model`/`effort` fields to use the cheapest capable model — all while your existing auth passes through unchanged.

```
Claude Code → PromptBus (port 4701) → api.anthropic.com
                 ↓
         SQLite logs + Dashboard (port 4702)
```

## Install

```bash
npm install -g promptbus
promptbus install
```

This sets `ANTHROPIC_BASE_URL` in Claude Code's `settings.json` to point at the proxy.

## Usage

```bash
# Configure Claude Code to route through PromptBus
promptbus install
promptbus install --project   # apply to current project only

# Start the proxy and dashboard (background daemon)
promptbus start

# View recent request logs
promptbus logs

# Check status
promptbus status

# Stop
promptbus stop

# Restart
promptbus restart

# Revert configuration
promptbus uninstall
```

The **proxy** listens on `http://127.0.0.1:4701`.  
The **dashboard** is at `http://127.0.0.1:4702`.

### Dashboard

The dashboard provides real-time visibility into your proxy usage:

- **Stats cards** — Total/downgraded request counts, reroute rate, number of active routes, cost saved, original cost, and actual cost
- **Cost tracking** — Cost saved, original cost (what you would have paid), and actual cost, calculated per-request using the pricing table in `config/rules.yaml`
- **Request log** — List of recent requests with task type, model routing, effort, latency; auto-refreshes every 8 seconds
- **Detail modal** — Click any request to see full details including tokens, cost delta, reason, and request body (if logging enabled)
- **Routing rules editor** — Inline editor for adding, removing, and modifying route rules
- **Advanced settings** — Confidence floor slider, log retention days, log request bodies toggle
- **Log export** — CSV export with optional date range filter
- **Dark/light mode** — Toggle via the sun/moon button in the topbar; follows your system preference and persists

## Configuration

Edit `config/rules.yaml` to control routing:

```yaml
version: 1
enabled: true
default_model: claude-sonnet-5
confidence_floor_for_any_downgrade: 0.6
log_retention_days: 90
log_request_bodies: false

routes:
  - when:
      task_type: read_explain
      min_confidence: 0.6
    use:
      model: claude-haiku-4-5
      effort: low
  - when:
      task_type: small_edit
    use:
      model: claude-sonnet-5
      effort: medium
  - when:
      task_type: test_generation
    use:
      model: claude-sonnet-5
      effort: medium
  - when:
      task_type: multi_file_refactor
    never_downgrade: true
  - when:
      task_type: planning
    never_downgrade: true
  - when:
      task_type: debug_loop
    never_downgrade: true
  - when:
      task_type: unknown
    never_downgrade: true

pricing:
  claude-haiku-4-5:
    input_per_mtok: 1
    output_per_mtok: 5
  claude-sonnet-5:
    input_per_mtok: 3
    output_per_mtok: 15
  claude-opus-4-8:
    input_per_mtok: 5
    output_per_mtok: 25
  claude-fable-5:
    input_per_mtok: 10
    output_per_mtok: 50
  # … additional models (opus-4-*, sonnet-4-*, mythos-*, etc.)
```

Use the dashboard's rules editor at `http://127.0.0.1:4702` for a point-and-click interface.

### Pricing table

Pricing is defined in `config/rules.yaml` under the `pricing` key. Currently tracked models and their per-million-token prices:

| Model | Input $/Mtok | Output $/Mtok |
|-------|-------------|--------------|
| `claude-haiku-4-5` | 1 | 5 |
| `claude-haiku-4-5-20251001` | 1 | 5 |
| `claude-sonnet-4-5` | 3 | 15 |
| `claude-sonnet-4-5-20250929` | 3 | 15 |
| `claude-sonnet-4-6` | 3 | 15 |
| `claude-sonnet-5` | 3 | 15 |
| `claude-opus-4-1` | 5 | 25 |
| `claude-opus-4-1-20250805` | 5 | 25 |
| `claude-opus-4-5` | 5 | 25 |
| `claude-opus-4-5-20251101` | 5 | 25 |
| `claude-opus-4-6` | 5 | 25 |
| `claude-opus-4-7` | 5 | 25 |
| `claude-opus-4-8` | 5 | 25 |
| `claude-mythos-preview` | 8 | 40 |
| `claude-mythos-5` | 8 | 40 |
| `claude-fable-5` | 10 | 50 |

Add or update entries to match current Anthropic pricing. Unlisted models are treated as $0 cost.

### Task types

| Type | Description |
|------|-------------|
| `read_explain` | Brief read-only questions |
| `small_edit` | Targeted edits (short prompts) |
| `multi_file_refactor` | Cross-file refactoring |
| `planning` | Design or architecture work |
| `debug_loop` | Debugging and error fixing |
| `test_generation` | Writing tests |
| `unknown` | Unclassified — `never_downgrade: true` by default |

### Route rule options

| Key | Type | Description |
|-----|------|-------------|
| `when.task_type` | string | One of the 7 task types above |
| `when.min_confidence` | number (0–1) | Per-rule confidence threshold override |
| `use.model` | string | Target model ID (e.g. `claude-haiku-4-5`) |
| `use.effort` | string | Effort level: `low`, `medium`, or `high` |
| `never_downgrade` | boolean | When `true`, always use the original model |

### Top-level config keys

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master toggle; when `false`, all requests pass through unmodified |
| `default_model` | `claude-sonnet-5` | Fallback model used when config cannot be loaded |
| `confidence_floor_for_any_downgrade` | `0.6` | Minimum confidence required for any downgrade |
| `log_retention_days` | `90` | Days to keep log entries before automatic pruning |
| `log_request_bodies` | `false` | Whether to store full request bodies in the database |

## CLI

### Commands

| Command | Description |
|---------|-------------|
| `install` | Configure Claude Code to route through PromptBus |
| `uninstall` | Revert the configuration (also stops the daemon) |
| `start` | Start the proxy and dashboard (background daemon) |
| `stop` | Stop the proxy and dashboard |
| `restart` | Restart the proxy and dashboard |
| `status` | Show running status and configuration |
| `logs` | Show recent daemon log lines (last 20) |

### Flags

| Flag | Description |
|------|-------------|
| `--yes`, `-y` | Auto-confirm prompts (non-interactive mode) |
| `--project`, `-p` | Apply install/uninstall to project-level `.claude/settings.json` |
| `--version`, `-v` | Show version number |
| `--help`, `-h` | Show help message |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROMPTBUS_PORT` | `4701` | Proxy server port |
| `PROMPTBUS_DASHBOARD_PORT` | `4702` | Dashboard server port |

## Development

```bash
npm run dev          # Run in dev mode (tsx)
npm run build        # Compile TypeScript
npm test             # Run tests
npm run lint         # Type-check only
```

## License

MIT
