# opencode-plugin-codex

A Codex plugin that lets Codex use OpenCode. It is the reverse-direction companion idea to `openai/codex-plugin-cc`: instead of using Codex inside another agent, this plugin exposes OpenCode inside Codex.

## Status

Implemented:

- Codex plugin manifest and repo-local marketplace.
- Bundled stdio MCP server.
- OpenCode CLI discovery and diagnostics.
- OpenCode run/continue/rescue/review/adversarial-review tools.
- Background job store with status/result/cancel tools.
- Codex rollout JSONL parser.
- Codex visible transcript to OpenCode import JSON conversion.
- `opencode_transfer` using `opencode import`.

## Install From This Repository

Build the MCP server:

```bash
npm install
npm run build
```

Add the repo marketplace to Codex if it is not already configured:

```bash
codex plugin marketplace add /Users/domo/Downloads/opencode-plugin-codex
```

Then install `opencode-plugin-codex` from that marketplace in the Codex plugin directory or CLI.

## Development

```bash
npm run check
```

Live OpenCode integration depends on local provider/model access:

```bash
OPENCODE_BIN="$HOME/.opencode/bin/opencode" \
OPENCODE_MODEL="aihubmix/gemini-3-flash-preview" \
npm run test:integration
```

See [docs/development.md](docs/development.md) for the complete design and implementation plan.
