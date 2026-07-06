# Verification

Last verified on 2026-07-06.

## 2026-07-06 Background Result Regression

Commands:

```bash
npm run check
npm run register:opencode-skills
git diff --check
git -C /Users/domo/Downloads/Dong-skills diff --check
```

Results:

- `npm run check`: build, all Vitest tests, plugin validation, and MCP smoke passed.
- `npm run register:opencode-skills`: completed successfully; existing conflicting OpenCode skill targets were reported and skipped without overwriting, and Superpowers registration was skipped by default.
- `git diff --check`: no whitespace errors in this repository.
- `git -C /Users/domo/Downloads/Dong-skills diff --check`: no whitespace errors in the collaboration skill source repository.

Coverage added:

- `opencode_result` now returns `outputSummary`, including `resultComplete`, `state`, event counts, final text preview, and whether an OpenCode `task` subagent was observed.
- Tests cover cancelled tool-only background logs as partial output and succeeded assistant text as complete output.

## Static and Local Checks

```bash
npm audit --json
npm run check
/private/tmp/opencode-plugin-codex-validator-venv/bin/python /Users/domo/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/opencode-plugin-codex
git diff --check
```

Results:

- `npm audit --json`: 0 vulnerabilities.
- `npm run check`: build, unit tests, plugin validation, and MCP smoke passed.
- Official plugin-creator validator passed.
- `git diff --check`: no whitespace errors.

## MCP Smoke

`npm run smoke:mcp` starts `plugins/opencode-plugin-codex/dist/server.js` through the MCP TypeScript SDK client and verifies all 10 tools are listed:

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

It also calls `opencode_check` when a local OpenCode binary is discoverable.

## Live OpenCode Transfer Smoke

Command:

```bash
OPENCODE_BIN=/Users/domo/.opencode/bin/opencode \
OPENCODE_MODEL=aihubmix/gemini-3-flash-preview \
npm run smoke:live-transfer
```

Latest result:

```json
{
  "ok": true,
  "opencodeSessionId": "ses_codex_transfer_1782591198127",
  "importedMessages": 8,
  "model": "aihubmix/gemini-3-flash-preview",
  "sentinel": "OPENCODE_PLUGIN_CODEX_LIVE_TRANSFER_OK"
}
```

This verifies the bundled MCP server can:

1. Locate the current Codex thread rollout through `CODEX_THREAD_ID`.
2. Convert visible user/assistant transcript into OpenCode import JSON.
3. Import it with `opencode import`.
4. Continue the imported OpenCode session with `opencode run --session`.
5. Receive the expected sentinel response from OpenCode.

## Local Codex Marketplace

The repository marketplace was accepted by the local Codex CLI:

```bash
codex plugin marketplace add /Users/domo/Downloads/opencode-plugin-codex
```

Result:

```text
Added marketplace `opencode-plugin-codex` from /Users/domo/Downloads/opencode-plugin-codex.
Installed marketplace root: /Users/domo/Downloads/opencode-plugin-codex
```
