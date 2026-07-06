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
5. Use `opencode_status`, `opencode_result`, and `opencode_cancel` for background jobs. Treat `opencode_result.outputSummary.resultComplete === true` as required before quoting OpenCode as a finished result.
6. Use `opencode_review`, `opencode_adversarial_review`, or `opencode_rescue` for second-agent analysis.

## Safety Defaults

- Do not enable `dangerouslySkipPermissions` unless the user explicitly asks for it.
- Do not instruct OpenCode to read Codex private runtime paths such as `~/.codex`, `$CODEX_HOME`, or `.codex/plugins/cache`; OpenCode's default sandbox may reject those paths. Inline collaboration/PUA expectations in the prompt, or use OpenCode-native skill paths under `~/.config/opencode/skills` only after verifying they exist.
- Do not attach binary files such as `.docx` directly with `files` unless OpenCode can read that format. Prefer repository scripts, unpacked text, or explicit text extracts for review tasks.
- Treat `opencode_review` and `opencode_adversarial_review` as bounded second-pass reviews, not full security scans. Do not ask OpenCode to invoke `security-diff-scan`, threat-modeling, attack-path analysis, validation skills, or subagents for the bounded review. If parallel or full security-audit work is truly required, stop and create a separate explicitly scoped OpenCode task after explicit user approval. For ordinary path-boundary or failure-mode review, name exact files and ask for a concise bounded review.
- Normal OpenCode collaboration should not expose Codex security-scan skills inside OpenCode. The repository registration script skips those by default; set `OPENCODE_REGISTER_SECURITY_SKILLS=1` only for explicitly scoped OpenCode security-scan workflows.
- For background jobs, never treat stdout/stderr tails as final OpenCode output when `outputSummary.state` is `queued_partial`, `running_partial`, `cancelled_partial`, `failed_partial`, or `succeeded_without_text`. Report the partial state, cancel or rerun with a narrower target, and only use validated intermediate findings after reading the actual files yourself.
- If OpenCode spends a long run reading files, calling `task` subagents, or producing low final text, narrow the packet to exact files/diffs and require findings-only output. This is a convergence problem, not proof that OpenCode is unavailable.
- For transfer, use the default visible transcript filter. It excludes developer messages, system messages, tool outputs, and reasoning.
- For transfer, pass an explicit authorized `model`; the plugin intentionally does not choose a provider/model default.
- Warn the user that transfer imports visible conversation text into OpenCode's local session database.
- Prefer an explicit `model` if the user has already named a working OpenCode model.

## Known Local Setup Pattern

OpenCode may be installed at `~/.opencode/bin/opencode` without being available on `PATH` in non-interactive shells. Pass `opencodeBin` or rely on the tool's discovery order before assuming OpenCode is missing.
