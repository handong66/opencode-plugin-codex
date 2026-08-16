---
name: opencode
description: Use when the user asks Codex to run OpenCode, continue an OpenCode session, transfer a visible Codex task, or request OpenCode rescue, review, or adversarial review.
---

# OpenCode for Codex

Use the bundled `opencode_*` tools. Plugin source and tests define machine behavior; this Skill only explains tool selection and boundaries.

Read results from MCP `structuredContent`. The text copy is compact, and a payload above 8192 characters is not duplicated there at all: it becomes a one-line `structuredContentOnly` notice with the payload size.

Every tool returns one envelope: `{ ok, error?: { code, message, retryable, details? }, warnings: string[], data }`. The payload is in `data` — `job`, `record`, `stdout`, `stderr`, `outputSummary`, `workspace`, `effectiveModel`, `continuation`. Small scalars (`terminal`, `nextAction`, `waited`, `resumable`, `openCodeSessionId`, `errorClass`, `exitCode`, `maxChars`, `maxCharsClamped`, `view`, `modelSelection`, `background`, `importSucceeded`) are mirrored at the top level for the 0.2 transition; bulk fields are not.

A boundary refusal is returned, not thrown: `workspace_unavailable`, `workspace_out_of_bounds` (which lists the roots that are available), `file_attachment_invalid`, `private_path_blocked`, `rollout_invalid`, `state_write_failed`, `cli_not_found`, `cli_probe_timeout`. All are `retryable: false` except `cli_probe_timeout`. Never work around one by calling the OpenCode CLI directly.

Full failure routing (every `errorClass` and boundary code, what to do about each) and the polling contract are in [references/failure-routing.md](references/failure-routing.md), which ships and versions with this plugin.

## Choose a tool

- Diagnose availability with `opencode_check`.
- Start bounded work with `opencode_run`; continue a known session with `opencode_continue`.
- Use `opencode_rescue`, `opencode_review`, or `opencode_adversarial_review` for read-only second-agent analysis.
- Use `opencode_transfer` only when the user explicitly asks to hand a long conversation over to OpenCode, or when a follow-up session genuinely needs the earlier turns. It is worth its cost only when the context is longer than you would paste into a prompt and the same OpenCode session will keep working from it; for anything smaller, inline the relevant part into an `opencode_run` prompt instead — that is cheaper and keeps the Codex private rollout file out of the picture. `model` is optional and defaults to OpenCode's configured model.
- Manage background work with `opencode_status`, `opencode_result`, and `opencode_cancel` using only the returned `jobId`.
- Recover a lost session or job handle with `opencode_sessions`, which lists recent OpenCode sessions (id, title, directory, updatedAt) scoped to the current workspace roots. Use it instead of a raw CLI call; pass `includeAllDirectories: true` only when the session belongs to another project.

Never invoke the OpenCode CLI directly with exec or shell. If `opencode_check` cannot validate a workspace root, use its degraded diagnostics; a raw CLI call bypasses the model, permission, path, and job-record contracts entirely. The one recorded case of a direct `opencode run --model …` call created a session the plugin never saw and a provider 403 nothing in the plugin could explain.

## Model selection

Omit `model` for normal collaboration so OpenCode uses its configured default; 943 of 1,051 recorded jobs did. Pass an explicit model only when the user requested that override or a continuation requires a previously verified model. Every execution result reports `modelSelection.source` (`opencode_config` or `explicit`), and an explicit value that differs from OpenCode's configured default adds a warning naming both. A configured or listed model is not proof of authorization — check `errorClass: "model_unauthorized"` for that. `opencode_check` reports the effective root, build, and plan models under `effectiveModel`.

`opencode_check` also reports `agents`, the `proxy` variables OpenCode will inherit, and any leftover 0.1-era `.opencode-plugin-codex` / `.grok-plugin-codex` directory in the workspace (safe to delete, never deleted for you). A configured proxy is the first thing to test when provider calls fail or hang.

`opencode_check` is cached for this MCP server session: call it once at the start, not before every batch. Pass `force: true` after installing a CLI or editing the OpenCode configuration; the response reports `cache.providersCachedAt` and `cache.providersCacheHit`, and returns `providers`/`providerIds`/`models` as parsed arrays with ANSI escapes stripped. If a listing exits non-zero the response is `ok: false` — a `Provider not found` message no longer arrives inside a success. Once providers have been enumerated, an explicit `model` whose provider id differs only in case (`AIHubMix/…` vs `aihubmix/…`) is refused before the job starts, with the correct spelling and `details.knownProviders`; the plugin never rewrites the id itself.

`opencode_run` defaults to background execution. Put task text in `prompt`; it is sent through stdin. `files` accepts at most 32 existing regular files whose real paths remain inside `cwd`. `cwd` must remain inside a root supplied by standard MCP roots or current Codex per-call workspace metadata. Configure a nonstandard CLI through the trusted MCP environment variable `OPENCODE_BIN`; tools do not accept a caller-controlled executable path.

## Budget contract

`timeoutMs` applies in both foreground and background modes and accepts `10000..86400000`; omitting it means 600000. Foreground calls (`background:false`) are clamped to 240000 because Codex aborts a `tools/call` at 300s, so a budget larger than that only exists in background mode. A clamp or a budget below the kind's recorded p90 is reported in `warnings[]` and never refuses the call. Budget and polling workflow belong to the Codex `codex-opencode-collaboration` Skill, not here.

`maxToolCalls` (`opencode_run`, `opencode_rescue`, `opencode_review`, `opencode_adversarial_review`) bounds investigation instead of wall time. Reaching it does not kill the job: the worker asks the same OpenCode session for its final answer from what it already gathered, and the record reports `toolBudgetReached: true`. It is enforced only when `background` is true; a foreground call reports that in `warnings[]`.

Use `autoApprovePermissions` to request current OpenCode `--auto` behavior on `opencode_run`, `opencode_continue`, and `opencode_rescue`. It auto-approves prompts not explicitly denied. It does not permit Codex private paths. Set `allowCodexPrivatePaths` separately only after explicit user authorization. `dangerouslySkipPermissions` is a deprecated compatibility alias for `autoApprovePermissions` and does not widen path access. `opencode_review` and `opencode_adversarial_review` do not accept it: they are read-only and `--auto` also approves writes, so a review that needs wider access must become an explicit `opencode_run`.

A job with `outputSummary.permissionDenied === true` inspected less than it was asked to, whatever its status. Never report such a job as "OpenCode found no problems": absence of findings there is absence of access. `deniedPaths` lists what it could not reach (capped at 5); the first remedy is a `cwd` that already contains those paths, not wider permissions.

## Adversarial review scope

Pass `threatModel` to `opencode_adversarial_review` whenever the user has stated one (for example "single-user local application; no network exposure"). Every finding then carries an in-model or out-of-model label, and an out-of-model finding is advisory: it must not be reported as a blocker or a NO_GO, and must not interrupt verification already in progress. Without a `threatModel` the review stays a robustness review of the named target and does not escalate into a security audit.

## Result and safety gates

`outputSummary` reports what the run actually did: `toolCallCount`, `filesInspected`, `turnsUsed`, `skillsLoaded[]`, and the derived `evidenceLevel` (`none` | `thin` | `substantive`). A `review` or `adversarial_review` that made zero tool calls is reported as `resultComplete: false` with the warning `verdict produced with 0 tool calls — treat as opinion, not review`; never count it as a passing vote. `outputSummary.warnings[]` also names any interactive skill a headless delegation loaded.

`outputSummary.finalText` is OpenCode's answer; the stdout tail is evidence, not the answer. It is present only when `resultComplete === true`, is bounded at 32000 characters, and reports `finalTextTruncated` when that bound was hit. `opencode_result` accepts `view: "raw" | "final"`; `raw` remains the default and `final` drops the stdout/stderr tails (`rawOmitted: true`) for callers that only need the answer.

Only `outputSummary.resultComplete === true` is a finished OpenCode conclusion. Running, queued, cancelled, failed, JSONL-error, truncated, or succeeded-without-final-text output is partial evidence. Codex must verify every finding against real files and commands.

A foreground call returns at most the last 20000 characters of each stream (captured at 100000) and reports `stdoutTruncated` / `stderrTruncated`. The full buffers still feed `outputSummary`, so read the answer there, not from the tail.

`opencode_result`'s `maxChars` has an effective range of `1..100000` (default `20000`); a larger request is clamped and reported as `maxChars` plus `maxCharsClamped: true` rather than refused. Widening the window is not how to reach a conclusion — read `outputSummary`.

`opencode_status`, `opencode_result`, and `opencode_cancel` return `ok` for the **job's** outcome, not the query's: a `failed` or `cancelled` job returns `ok: false` with `error: { code, message, retryable }`. `terminal: true` means the record is final — `nextAction` then reads `do not poll again; the record is final`, and polling a job that has been terminal for over five minutes adds a warning. A non-terminal job's `nextAction` says to wait, and never to call status and result at the same instant.

`opencode_status` and `opencode_result` accept `waitMs`: the server blocks until the record is terminal instead of returning immediately. The default is `0`, any request above `240000` is clamped to `240000` and reported in `warnings[]` (the MCP client aborts a `tools/call` at 300s), and the response reports `waited` in milliseconds. The record is re-read every round, so an `opencode_cancel` issued elsewhere ends the wait.

A terminal record carries `terminalSummary` (state, `resultComplete`, a bounded `finalTextPreview`, `permissionDenied`, `deniedPaths`, and the evidence counters), so a finished job stays readable from `opencode_status` alone after its logs are gone.

`data.job` and `data.record` are projections, not the stored record: the executable path, argv, pids, and state log paths are not returned. Everything actionable is (`status`, timestamps, `timeoutMs`, `opencodeSessionId`, `resumable`, `errorClass`, `errorMessage`, `modelSelection`, `toolBudgetReached`).

Background state lives in a private central user-state directory and survives MCP restarts. Keep the first returned `jobId`; status/result/cancel do not take `cwd`.

`errorClass` is derived only from real error channels (timeout, terminating signal, structured JSONL error, stderr), never from OpenCode's own prose. `quota_exhausted`, `auth_required`, `model_unauthorized`, and `model_not_found` are not retryable — change provider, model, or account instead of rerunning. The full routing table for every class and boundary code is in [references/failure-routing.md](references/failure-routing.md).

`errorClass: "timeout"` is a spent budget, not a failed job: `opencode_status` returns `openCodeSessionId` and `resumable`, and a resumable session still holds the work. Records written before 0.2.0 have no `resumable` field; treat a missing value as false. `errorClass: "stalled"` is the opposite case — no output at all before the stall window — and points at the provider or model, not at a larger budget.

Transfer accepts a rollout inside the workspace or Codex sessions directory, prefers current visible `event_msg` user/assistant text, and verifies import by exporting the new session. Its `model` follows the same rule as every other tool: omit it and OpenCode's configured default is used; only a configuration that cannot be read at all is a refusal. If continuation fails after import, preserve the returned session ID and report `importSucceeded` separately. For background continuation, `continuationStarted` is not finality; require the job result or `continuationResultComplete === true`.

Never ask OpenCode to commit, push, deploy, clean the worktree, read hidden Codex context, or act as final owner.
