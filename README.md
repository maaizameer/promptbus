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

- **Stats cards** — Total/downgraded request counts, reroute rate, number of active routes
- **Cost tracking** — Cost saved, original cost (what you would have paid), and actual cost, calculated per-request using the pricing table in `config/rules.yaml`
- **Request log** — List of recent requests with task type, model routing, effort, latency
- **Detail modal** — Click any request to see full details including tokens, cost delta, and request body
- **Dark/light mode** — Toggle via the sun/moon button in the topbar; follows your system preference and persists

## Configuration

Edit `config/rules.yaml` to control routing:

```yaml
routes:
  - when:
      task_type: read_explain
      min_confidence: 0.6
    use:
      model: claude-haiku-4-5
      effort: low
  - when:
      task_type: multi_file_refactor
    never_downgrade: true  # always use the original model
```

Or use the dashboard's rules editor at `http://127.0.0.1:4702`.

### Task types

| Type | Description |
|------|-------------|
| `read_explain` | Brief read-only questions |
| `small_edit` | Targeted edits (short prompts) |
| `multi_file_refactor` | Cross-file refactoring |
| `planning` | Design or architecture work |
| `debug_loop` | Debugging and error fixing |
| `test_generation` | Writing tests |
| `unknown` | Unclassified — never downgraded by default |

### Model IDs

Current supported models (verified from Anthropic SDK types):

- `claude-sonnet-5`
- `claude-haiku-4-5`
- `claude-opus-4-8`
- `claude-fable-5`

## CLI flags

| Flag | Description |
|------|-------------|
| `--project <path>` | Target a specific project's `.claude/settings.json` |
| `--yes` | Auto-confirm install/uninstall |
| `--version` | Show version |
| `--help` | Show help |

## Development

```bash
npm run dev          # Run in dev mode (tsx)
npm run build        # Compile TypeScript
npm test             # Run tests
npm run lint         # Type-check only
```

## License

MIT
