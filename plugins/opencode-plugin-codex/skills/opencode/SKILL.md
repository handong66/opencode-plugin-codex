---
name: opencode
description: Use when the user asks Codex to run OpenCode, continue an OpenCode session, transfer a visible Codex task, or request OpenCode rescue, review, or adversarial review.
---

# OpenCode for Codex

Use the bundled `opencode_*` tools. Plugin source and tests define machine behavior; this Skill only explains tool selection and boundaries.

## Choose a tool

- Diagnose availability with `opencode_check`.
- Start bounded work with `opencode_run`; continue a known session with `opencode_continue`.
- Use `opencode_rescue`, `opencode_review`, or `opencode_adversarial_review` for read-only second-agent analysis.
- Use `opencode_transfer` only when visible Codex conversation context is worth importing into OpenCode's local session database.
- Manage background work with `opencode_status`, `opencode_result`, and `opencode_cancel` using only the returned `jobId`.

`opencode_run` defaults to background execution. Put task text in `prompt`; it is sent through stdin. `files` accepts at most 32 existing regular files whose real paths remain inside `cwd`. `cwd` must remain inside a root supplied by standard MCP roots or current Codex per-call workspace metadata. Configure a nonstandard CLI through the trusted MCP environment variable `OPENCODE_BIN`; tools do not accept a caller-controlled executable path.

## Budget contract

`timeoutMs` applies in both foreground and background modes and accepts `10000..86400000`; omitting it means 600000. Foreground calls (`background:false`) are clamped to 240000 because Codex aborts a `tools/call` at 300s, so a budget larger than that only exists in background mode. A clamp or a budget below the kind's recorded p90 is reported in `warnings[]` and never refuses the call. Budget and polling workflow belong to the Codex `codex-opencode-collaboration` Skill, not here.

Use `autoApprovePermissions` to request current OpenCode `--auto` behavior. It auto-approves prompts not explicitly denied. It does not permit Codex private paths. Set `allowCodexPrivatePaths` separately only after explicit user authorization. `dangerouslySkipPermissions` is a deprecated compatibility alias for `autoApprovePermissions` and does not widen path access.

## Result and safety gates

Only `outputSummary.resultComplete === true` is a finished OpenCode conclusion. Running, queued, cancelled, failed, JSONL-error, truncated, or succeeded-without-final-text output is partial evidence. Codex must verify every finding against real files and commands.

Background state lives in a private central user-state directory and survives MCP restarts. Keep the first returned `jobId`; status/result/cancel do not take `cwd`.

Transfer accepts a rollout inside the workspace or Codex sessions directory, prefers current visible `event_msg` user/assistant text, verifies import by exporting the new session, and requires an explicit authorized model. If continuation fails after import, preserve the returned session ID and report `importSucceeded` separately. For background continuation, `continuationStarted` is not finality; require the job result or `continuationResultComplete === true`.

Never ask OpenCode to commit, push, deploy, clean the worktree, read hidden Codex context, or act as final owner.
