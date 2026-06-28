# OpenCode for Codex

This plugin lets Codex call OpenCode through a bundled MCP server. The full repository README is the canonical source for installation, verification, and documentation governance.

Core capabilities:

- Check local OpenCode CLI/provider/model availability.
- Run OpenCode tasks from Codex.
- Continue existing OpenCode sessions.
- Ask OpenCode for rescue, review, and adversarial review.
- Transfer visible Codex thread history into an OpenCode session with `opencode import`.
- Manage background OpenCode jobs.

## Build

From the repository root:

```bash
npm install
npm run check
```

## MCP Tools

The current tool registry lives in `src/server.ts` and is smoke-tested by `../../scripts/smoke-mcp.mjs`.

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

For `opencode_run`, put task instructions in `prompt`; `files` is only for existing filesystem paths to attach.

## Local OpenCode Discovery

The MCP server discovers OpenCode in this order:

1. `opencodeBin` tool argument.
2. `OPENCODE_BIN`.
3. `~/.opencode/bin/opencode`.
4. `/opt/homebrew/bin/opencode`.
5. `/usr/local/bin/opencode`.
6. `PATH`.

## Transfer Privacy

`opencode_transfer` imports visible user/assistant transcript text into OpenCode's local session database. It does not include Codex developer/system messages, tool outputs, or reasoning by default.
