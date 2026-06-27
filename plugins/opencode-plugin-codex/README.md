# OpenCode for Codex

This plugin lets Codex call OpenCode through a bundled MCP server.

Core capabilities:

- Check local OpenCode CLI/provider/model availability.
- Run OpenCode tasks from Codex.
- Continue existing OpenCode sessions.
- Ask OpenCode for rescue, review, and adversarial review.
- Transfer visible Codex thread history into an OpenCode session with `opencode import`.
- Manage background OpenCode jobs.

## Build

```bash
npm install
npm run build
npm test
```

## Local OpenCode Discovery

The MCP server discovers OpenCode in this order:

1. `opencodeBin` tool argument.
2. `OPENCODE_BIN`.
3. `~/.opencode/bin/opencode`.
4. `/opt/homebrew/bin/opencode`.
5. `/usr/local/bin/opencode`.
6. `PATH`.

## Transfer Privacy

`opencode_transfer` imports visible user/assistant transcript text into the local OpenCode database. It does not include Codex developer/system messages, tool outputs, or reasoning by default.
