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

`maxToolCalls` (`opencode_run`, `opencode_rescue`, `opencode_review`, `opencode_adversarial_review`) bounds investigation instead of wall time. Reaching it does not kill the job: the worker asks the same OpenCode session for its final answer from what it already gathered, and the record reports `toolBudgetReached: true`. It is enforced only when `background` is true; a foreground call reports that in `warnings[]`.

Use `autoApprovePermissions` to request current OpenCode `--auto` behavior on `opencode_run`, `opencode_continue`, and `opencode_rescue`. It auto-approves prompts not explicitly denied. It does not permit Codex private paths. Set `allowCodexPrivatePaths` separately only after explicit user authorization. `dangerouslySkipPermissions` is a deprecated compatibility alias for `autoApprovePermissions` and does not widen path access. `opencode_review` and `opencode_adversarial_review` do not accept it: they are read-only and `--auto` also approves writes, so a review that needs wider access must become an explicit `opencode_run`.

A job with `outputSummary.permissionDenied === true` inspected less than it was asked to, whatever its status. Never report such a job as "OpenCode found no problems": absence of findings there is absence of access. `deniedPaths` lists what it could not reach (capped at 5); the first remedy is a `cwd` that already contains those paths, not wider permissions.

## Result and safety gates

`outputSummary` reports what the run actually did: `toolCallCount`, `filesInspected`, `turnsUsed`, `skillsLoaded[]`, and the derived `evidenceLevel` (`none` | `thin` | `substantive`). A `review` or `adversarial_review` that made zero tool calls is reported as `resultComplete: false` with the warning `verdict produced with 0 tool calls — treat as opinion, not review`; never count it as a passing vote. `outputSummary.warnings[]` also names any interactive skill a headless delegation loaded.

`outputSummary.finalText` is OpenCode's answer; the stdout tail is evidence, not the answer. It is present only when `resultComplete === true`, is bounded at 32000 characters, and reports `finalTextTruncated` when that bound was hit. `opencode_result` accepts `view: "raw" | "final"`; `raw` remains the default and `final` drops the stdout/stderr tails (`rawOmitted: true`) for callers that only need the answer.

Only `outputSummary.resultComplete === true` is a finished OpenCode conclusion. Running, queued, cancelled, failed, JSONL-error, truncated, or succeeded-without-final-text output is partial evidence. Codex must verify every finding against real files and commands.

`opencode_result`'s `maxChars` has an effective range of `1..100000` (default `20000`); a larger request is clamped and reported as `maxChars` plus `maxCharsClamped: true` rather than refused. Widening the window is not how to reach a conclusion — read `outputSummary`.

Background state lives in a private central user-state directory and survives MCP restarts. Keep the first returned `jobId`; status/result/cancel do not take `cwd`.

`errorClass` is derived only from real error channels (timeout, terminating signal, structured JSONL error, stderr), never from OpenCode's own prose. `quota_exhausted`, `auth_required`, `model_unauthorized`, and `model_not_found` are not retryable: rerunning the same call reaches the same answer, so change provider, model, or account instead. `timeout`, `terminated`, `rate_limited`, `network_error`, `opencode_failed`, and `unknown` are retryable. An unrecognised provider message is reported as `unknown` with the full text rather than filed under a guessed class.

`errorClass: "timeout"` is a spent budget, not a failed job: `opencode_status` returns `openCodeSessionId` and `resumable`, and a resumable session still holds the work. Records written before 0.2.0 have no `resumable` field; treat a missing value as false.

Transfer accepts a rollout inside the workspace or Codex sessions directory, prefers current visible `event_msg` user/assistant text, verifies import by exporting the new session, and requires an explicit authorized model. If continuation fails after import, preserve the returned session ID and report `importSucceeded` separately. For background continuation, `continuationStarted` is not finality; require the job result or `continuationResultComplete === true`.

Never ask OpenCode to commit, push, deploy, clean the worktree, read hidden Codex context, or act as final owner.
