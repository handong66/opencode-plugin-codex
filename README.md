# opencode-plugin-codex

Use OpenCode from Codex. This repository packages a Codex plugin with a bundled stdio MCP server so Codex can start OpenCode tasks, continue OpenCode sessions, run second-agent reviews, and transfer visible Codex thread history into an OpenCode session.

This is the reverse-direction companion idea to `openai/codex-plugin-cc`: instead of using Codex inside another agent, this plugin exposes OpenCode inside Codex.

## Current Status

Implemented and locally verified:

- Codex plugin manifest and repo-local marketplace metadata.
- Bundled Node-based stdio MCP server.
- OpenCode CLI discovery through explicit argument, environment, common install paths, and `PATH`.
- OpenCode run, continue, rescue, review, and adversarial-review tools.
- Background OpenCode job status, result, and cancel tools.
- Background result summaries that distinguish complete OpenCode answers from partial tool logs.
- Codex rollout JSONL parser for visible user/assistant transcript.
- Codex-visible transcript to OpenCode import JSON conversion.
- `opencode_transfer` using `opencode import`, with optional post-import continuation.

## Tool Surface

The MCP tool registry is defined in `plugins/opencode-plugin-codex/src/server.ts`. Keep this list aligned with that file and `scripts/smoke-mcp.mjs`.

- `opencode_check`
- `opencode_run`
- `opencode_continue`
- `opencode_rescue`
- `opencode_review`
- `opencode_adversarial_review`
- `opencode_transfer`
- `opencode_status`
- `opencode_result`
- `opencode_cancel`

For `opencode_run`, put the task instructions in `prompt`. Use `files` only for existing filesystem paths to attach; the server rejects prompt-like text in `files` before OpenCode can treat it as a missing path, and sends the prompt before `--file` arguments so OpenCode does not parse the prompt as another attachment.

Do not ask OpenCode to read Codex private runtime paths such as `~/.codex`, `$CODEX_HOME`, or `.codex/plugins/cache` unless broader OpenCode filesystem access was explicitly requested. The plugin rejects those prompts by default because OpenCode's sandbox normally cannot read Codex's private runtime files; inline collaboration/PUA expectations in the prompt instead, or point to verified OpenCode-native skill files under `~/.config/opencode/skills`.

For document review workflows, avoid attaching binary files such as `.docx` directly unless OpenCode can read that format. Prefer repository scripts, unpacked text, or explicit text extracts as review inputs.

Use `opencode_review` and `opencode_adversarial_review` as bounded second-pass reviews. They are not full security scans by default; prompts should name exact files or diffs and should not ask OpenCode to invoke `security-diff-scan`, threat modeling, attack-path analysis, validation skills, or subagents for the bounded review. If parallel or full security-audit work is needed, start a separate explicitly scoped OpenCode task with explicit user approval.

For background jobs, read `opencode_result.outputSummary` before quoting OpenCode output. Only `succeeded_with_text` with `resultComplete: true` is a finished OpenCode answer. `queued_partial`, `running_partial`, `cancelled_partial`, `failed_partial`, and `succeeded_without_text` are process evidence only; narrow or rerun the task before treating OpenCode as having reviewed or implemented anything.

## Requirements

- Node.js `>=22`
- npm
- Codex with local plugin marketplace support
- OpenCode CLI for live OpenCode actions

The MCP server discovers OpenCode in this order:

1. Tool argument `opencodeBin`.
2. `OPENCODE_BIN`.
3. `~/.opencode/bin/opencode`.
4. `/opt/homebrew/bin/opencode`.
5. `/usr/local/bin/opencode`.
6. `PATH`.

## Install From This Repository

Build the bundled MCP server:

```bash
npm install
npm run build
```

Add this repository as a Codex plugin marketplace if it is not already configured:

```bash
codex plugin marketplace add /path/to/opencode-plugin-codex
```

Then install `opencode-plugin-codex` from that marketplace in Codex.

Optional: register selected Codex collaboration skills for OpenCode to read from `~/.config/opencode/skills`:

```bash
npm run register:opencode-skills
```

The registration script is conservative: it skips existing conflicting skill targets instead of overwriting them, and it does not symlink Superpowers by default because OpenCode may already load Superpowers from its package cache. Set `OPENCODE_REGISTER_SUPERPOWERS=1` only when OpenCode is not already loading those skills.

## Development

Run the full local check before publishing README, manifest, MCP server, or tool changes:

```bash
npm run check
git diff --check
```

`npm run check` performs:

1. TypeScript typecheck.
2. MCP server bundle build.
3. Vitest unit tests.
4. Repository plugin validation.
5. MCP smoke test that lists all expected tools.

Live OpenCode transfer verification depends on local provider/model access:

```bash
OPENCODE_BIN="$HOME/.opencode/bin/opencode" \
OPENCODE_MODEL="aihubmix/gemini-3-flash-preview" \
npm run smoke:live-transfer
```

## Privacy Boundary

`opencode_transfer` imports visible user/assistant transcript text into OpenCode's local session database. By default it does not include Codex system messages, developer messages, tool outputs, or reasoning.

## Documentation Governance

To avoid documentation drift, treat these files as having different authority:

- `README.md`: current user-facing source of truth for install, capabilities, requirements, and verification commands.
- `plugins/opencode-plugin-codex/README.md`: concise marketplace/plugin-directory summary. Keep it short and point back here for full details.
- `docs/verification.md`: dated verification ledger. Update it when new smoke, audit, or live-transfer evidence is collected.
- `docs/development.md`: historical design and implementation notes. It may describe planned layouts or earlier environment snapshots; do not treat it as the current repo contract without checking source files.
- `plugins/opencode-plugin-codex/src/server.ts`: authoritative MCP tool registry.
- `scripts/smoke-mcp.mjs`: executable guard for the tool list published in this README.

When changing tools, install steps, discovery behavior, transfer privacy, or verification commands, update this README in the same commit as the code or manifest change.
