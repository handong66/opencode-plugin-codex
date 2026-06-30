---
name: opencode
description: Use when the user asks to run OpenCode from Codex, continue an OpenCode session, transfer a Codex thread to OpenCode, or ask OpenCode for rescue/review/adversarial review.
---

# OpenCode For Codex

Use the bundled `opencode_*` MCP tools to delegate work from Codex to OpenCode.

## Default Workflow

1. Use `opencode_check` first when the user asks whether OpenCode is available, when a model/provider may be missing, or before a live transfer.
2. Use `opencode_run` for a new OpenCode task.
3. Use `opencode_continue` for an existing OpenCode session.
4. Use `opencode_transfer` when the user wants the current Codex conversation continued in OpenCode.
5. Use `opencode_status`, `opencode_result`, and `opencode_cancel` for background jobs.
6. Use `opencode_review`, `opencode_adversarial_review`, or `opencode_rescue` for second-agent analysis.

## Safety Defaults

- Do not enable `dangerouslySkipPermissions` unless the user explicitly asks for it.
- Do not instruct OpenCode to read Codex private runtime paths such as `~/.codex`, `$CODEX_HOME`, or `.codex/plugins/cache`; OpenCode's default sandbox may reject those paths. Inline collaboration/PUA expectations in the prompt, or use OpenCode-native skill paths under `~/.config/opencode/skills` only after verifying they exist.
- Do not attach binary files such as `.docx` directly with `files` unless OpenCode can read that format. Prefer repository scripts, unpacked text, or explicit text extracts for review tasks.
- For transfer, use the default visible transcript filter. It excludes developer messages, system messages, tool outputs, and reasoning.
- Warn the user that transfer imports visible conversation text into OpenCode's local session database.
- Prefer an explicit `model` if the user has already named a working OpenCode model.

## Known Local Setup Pattern

OpenCode may be installed at `~/.opencode/bin/opencode` without being available on `PATH` in non-interactive shells. Pass `opencodeBin` or rely on the tool's discovery order before assuming OpenCode is missing.
