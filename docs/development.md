# Development

This document describes the current implementation. Source and tests win if documentation disagrees.

## Responsibility layers

1. `plugins/opencode-plugin-codex/src/` and tests define machine behavior.
2. `plugins/opencode-plugin-codex/skills/opencode/SKILL.md` briefly explains tools, parameters, finality, and safety.
3. `plugins/opencode-plugin-codex/skills/opencode/references/failure-routing.md` is the vendored, version-bound failure-routing and polling contract. It ships inside the plugin so it can never be a release behind the code, and `test/skill-contract.test.ts` fails the build when it names an error code or result field that no longer exists in `src/`, when `src/` can return a code it does not list (it is advertised as the complete table, so both directions are drift), or when any shipped document re-acquires a claim the code contradicts.
4. Dong-skills `codex-opencode-collaboration` defines the full Codex-owned collaboration workflow. Its personal installed copy is synchronization output, not a second source.

Do not copy the orchestration workflow into the plugin Skill or register the Codex orchestration Skill into OpenCode. Layer 4 lives outside this repository and is not version-bound to it: anything a caller must get right in the same release as a code change belongs in layer 3, not layer 4. That asymmetry is the drift mechanism behind the 0.1-era timeout dogma.

## Build outputs

`npm run build` typechecks and bundles two Node 22 ESM entry points:

- `dist/server.js`: stdio MCP server.
- `dist/job-worker.js`: detached background supervisor.

Both files are tracked release artifacts and must be regenerated after source changes.

## Runtime flow

### Foreground

1. Resolve `cwd` inside a filesystem root supplied by standard MCP roots or current Codex per-call workspace metadata; refresh standard roots for each call because a client may change them, and never treat the plugin cache process directory as a project root.
2. Resolve every attachment with `realpath`; require an in-`cwd` regular file.
3. Discover OpenCode from trusted server environment/common paths.
4. Build argument-array flags. Send the prompt through stdin.
5. Spawn with `CODEX_*` variables removed, capturing at most 100000 characters per stream and returning the last 20000 with `stdoutTruncated` / `stderrTruncated`. The full buffers still feed the summariser, so truncation costs nothing diagnostically. The foreground path used to be 10–50× wider than the background one for no stated reason.
6. Parse JSONL error/step events and return `outputSummary`.

### Background

1. The MCP server creates a private job record and mode-`0600` prompt input under the central state directory.
2. It starts `dist/job-worker.js` detached and returns `jobId`.
3. The worker removes the input file after reading it, spawns OpenCode in its own process group, enforces `timeoutMs`, keeps bounded log tails, and writes partial logs while running.
4. The worker atomically writes the terminal record. A new MCP process can read/cancel the same job by ID.
5. Status reconciliation turns a nonterminal record with a dead worker into `failed/worker_unavailable`.
6. `opencode_status` and `opencode_result` accept `waitMs`: the server polls the record itself (500ms backing off to 5s) until it is terminal, and returns `waited`. Any request above `240000` is clamped and the clamp is reported, because the MCP client aborts a `tools/call` at 300s. The record is re-read every round, so an `opencode_cancel` issued from another call ends the wait instead of deadlocking it. One blocking wait replaces four or five polls and their approval round-trips.
7. `opencode_sessions` lists recent OpenCode sessions (`opencode session list --format json`) scoped to the caller's workspace roots, with `includeAllDirectories` as the explicit escape hatch. It exists so a lost `jobId` or session id has a supported recovery path instead of a raw CLI call.

State directory order in the implementation (the override is primarily for tests/embedding; the shipped MCP config guarantees `HOME`):

1. `OPENCODE_PLUGIN_STATE_DIR`
2. `$XDG_STATE_HOME/opencode-plugin-codex`
3. `~/.local/state/opencode-plugin-codex`

State directories are `0700`; records, prompt inputs, and logs are `0600`. Job IDs must match `^job_[A-Za-z0-9_-]{1,128}$`. Output paths are derived from the validated ID rather than trusted from JSON.

## Result envelope

Since 0.2.0 every tool returns one shape:

```jsonc
{ "ok": true, "error": { "code": "…", "message": "…", "retryable": false }, "warnings": [], "data": { } }
```

`data` carries the payload — `job`, `record`, `stdout`, `stderr`, `outputSummary`, `workspace`, `effectiveModel`, `continuation`. Cheap scalars (`terminal`, `nextAction`, `waited`, `resumable`, `openCodeSessionId`, `errorClass`, `exitCode`, `maxChars`, `maxCharsClamped`, `view`, `modelSelection`, `background`, `importSucceeded`) are also mirrored at the top level for the transition. Bulk fields are deliberately not mirrored: duplicating them is what OX2 removed, and the text copy of a payload above 8192 characters is replaced by a one-line `structuredContentOnly` notice so the same bytes never travel twice.

`ok` reports the **job's** outcome on `opencode_status` / `opencode_result` / `opencode_cancel`, not the query's: a `failed` or `cancelled` job answers `ok: false` with a typed `error`. `terminal: true` means the record is final and `nextAction` says to stop polling.

`src/boundary.ts` owns the boundary codes. They are **returned**, never thrown, so a refusal reaches the caller as data it can route on:

| Code | Retryable | Raised when |
| --- | --- | --- |
| `workspace_unavailable` | no | no usable MCP root or Codex workspace metadata |
| `workspace_out_of_bounds` | no | `cwd` resolves outside every available root; the message lists the roots and explains that Codex supplies them per call |
| `file_attachment_invalid` | no | an attachment is missing, not a regular file, or resolves outside `cwd`; the message names the remedy |
| `private_path_blocked` | no | the prompt references a Codex private path without `allowCodexPrivatePaths`; the error carries the offset and a masked preview |
| `rollout_invalid` | no | a transfer rollout is unreadable or outside the allowed directories |
| `state_write_failed` | no | the state directory could not be written; carries the directory and errno |
| `cli_not_found` | no | discovery found no OpenCode binary; carries the probed candidates |
| `cli_probe_timeout` | yes | the discovery probe timed out — the one boundary a plain retry can fix |
| `job_not_found` | no | `opencode_status` / `opencode_result` / `opencode_cancel` was given an id with no record; echoes the id only, never the state path |
| `model_not_found` | no | an explicit provider id matches an enumerated lowercase one only in case; shares the OC-3 `errorClass` name on purpose |

Codes shared with `grok-plugin-codex` (`workspace_unavailable`, `private_path_blocked`, `quota_exhausted`, `auth_required`, `network_error`, `timeout`, `terminated`) are reused verbatim so one orchestrator learns one table.

`toPublicJob()` in `src/job-store.ts` is the privacy boundary between the stored record and the wire. The executable path, argv, `workerPid`, `pid`, `stdoutPath`, and `stderrPath` never leave the process; everything actionable does (`status`, timestamps, `timeoutMs`, `opencodeSessionId`, `resumable`, `lastEventAt`, `errorClass`, `errorMessage`, `modelSelection`, `toolBudgetReached`, `terminalSummary`). `test/public-job.test.ts` asserts that no argv entry, pid, or state path survives into a tool result — add fields to the projection deliberately, never by spreading the record.

## Model selection

`src/model-guard.ts` probes `opencode debug config` and parses **only** the root `model` and the `build`/`plan` agent `model`/`variant`. That command prints the whole resolved configuration, credentials included, so the allowlist is the security property; malformed output degrades to a warning and never refuses work.

Execution results and job records carry `modelSelection { source, requested, configured, agents }`, where `source` is `opencode_config` (the caller omitted `model` — 943 of 1,051 recorded jobs) or `explicit`. An explicit value that differs from the configured default adds a warning naming both. It is a warning, not a refusal, and there is no separate authorization field: a listed model has never been proof of authorization.

The probe runs on the submit path only when the caller passed an explicit `model` — with nothing requested there is nothing to compare, and an unconditional probe would add a CLI process to the common path. `opencode_check` probes unconditionally and reports `effectiveModel`.

Results are cached per binary and directory for the life of the MCP server process. The cache key is built from two absolute paths joined by a space; never use a control byte for a separator, because a raw NUL makes Git treat the source file as binary and `test/source-is-text.test.ts` will fail the build.

## Discovery and check cache

`src/check-cache.ts` memoises CLI discovery, the effective model, and the provider/model listings for the life of the MCP server process — `opencode_check` was called 471 times in two months, 124 of them in one day. `force: true` is the escape hatch after installing a CLI or editing configuration, and every response reports `cache.providersCachedAt` and `cache.providersCacheHit` so a caller can judge freshness itself.

There is no `cacheTtlMs`, on purpose. What invalidates this answer is a user installing a CLI or editing a config file, which no interval predicts; publishing a TTL the plugin does not enforce would be a false promise.

Only successful answers are remembered — the rule `discoverOpenCode` already followed. A listing that exits non-zero and a `debug config` probe that could not read the configuration are re-run on the next call, because a memoised failure is not a cached answer but a stuck one: `provider_listing_failed` is returned with `retryable: true`, so a caller's retry has to be able to reach the CLI again rather than land back in the memo, and a stuck `debug config` would make every later `opencode_transfer` without an explicit model refuse with `opencode_model_required`. `force: true` remains an extra invalidation, not the only recovery.

Listings are parsed into arrays with ANSI escapes stripped by `src/ansi.ts`, and a listing that exits non-zero is `ok: false` with `provider_listing_failed` instead of a `Provider not found` message wrapped inside a success.

`providers list` is a banner of **display names** in OpenCode 1.18.16 (`● AIHubMix api`), while the provider id is `aihubmix`. `parseListOutput` therefore claims a token as an id only when it already looks like one — lowercase and letter-initial — and reports `providerIds: []` plus a warning when a listing yields no ids at all, rather than passing display names off as ids. Reading the name as an id is not a cosmetic error: the spelling guard below would then refuse the id that works.

Once providers have been enumerated, an explicit model whose provider id differs from an enumerated **lowercase** id only in case is refused before the job starts, with the correct spelling in `details.knownProviders`. The check is one-directional by design — an enumerated id that is not lowercase means the parse is unsure, and an unsure parse must not refuse the caller's work. The plugin never rewrites the id itself either; silent normalisation was rejected.

## OpenCode CLI contract

The public MCP schema does not accept `opencodeBin`. Operators may set trusted `OPENCODE_BIN`; discovery then checks the default user install, Homebrew locations, and `PATH`.

Run messages use:

```text
opencode run --format json --dir <cwd> [flags]
```

The message is stdin, not a positional argv value. `autoApprovePermissions` adds current public `--auto`. The deprecated `dangerouslySkipPermissions` input is a compatibility alias for the same flag and does not widen Codex private-path access.

All child environments remove names beginning with `CODEX_`. Do not remove provider/OpenCode variables needed for the user's configured runtime.

## Path boundaries

- `cwd`: existing directory inside the MCP workspace after `realpath`. Standard MCP roots are preferred; current Codex `x-codex-turn-metadata.workspaces` is the fallback because plugin MCP processes start in their installed cache.
- `files`: at most 32 existing regular files inside resolved `cwd`; escaping symlinks fail.
- explicit `rolloutFile`: JSONL inside resolved `cwd` or the resolved Codex sessions directory.
- `jobId`: strict identifier used against central state; status/result/cancel do not accept `cwd`.
- OpenCode binary: trusted environment/discovery only.

`allowCodexPrivatePaths` controls only the prompt guard and requires explicit user authorization. It does not change OpenCode permission handling. `autoApprovePermissions` controls only OpenCode permission prompts.

## JSONL finality and errors

An exit code is not enough. `resultComplete` requires all of:

- job/process state succeeded;
- a terminal `step_finish` with reason `stop`;
- nonempty assistant text in that same final step;
- no structured JSONL error event;
- and, for `review` / `adversarial_review`, at least one tool call. A verdict reached with `toolCallCount === 0` read nothing in the workspace, so it is reported as `resultComplete: false` with a "treat as opinion, not review" warning no matter how confident the text is. Execution kinds are unaffected.

Text from an earlier tool-call step remains partial. JSONL `error` events override exit code 0 and feed error classification such as `model_unauthorized` or `network_error`. Output tails are capped; `outputTruncated` means earlier content was discarded.

## Terminal records and budgets

`src/job-finalize.ts` owns the terminal shape of a record. It runs once, when the stream is already complete in memory, and parses it a single time to recover `opencodeSessionId` and the event count. Branch order is cancellation, **stall**, timeout, spawn error, stdin error, structured JSONL error, then exit code. Cancellation stays first so a cancelled job can never be recorded as a success; the stall branch sits ahead of timeout because a stalled run is ended before its budget expires, and only checks itself when the run did not also time out.

Every terminal branch writes `terminalSummary` onto the record — state, `resultComplete`, a bounded `finalTextPreview`, `permissionDenied`, `deniedPaths`, and the evidence counters — so a finished job stays diagnosable from `opencode_status` alone after its logs are rotated away.

There is one incremental reader on the hot path, and only one: `readStreamProgress()` (same module), which `job-worker.ts` calls per stdout chunk to enforce `maxToolCalls`. A half-written JSONL line still cannot be parsed, so the worker buffers the trailing partial line and hands `readStreamProgress()` complete lines only; it extracts nothing but the tool-call delta and the session id. Everything else about a record's shape stays in the single end-of-stream pass — do not grow this reader into a second finalizer.

A `timeout` is a spent budget rather than a failed job. The record keeps the recovered session id, sets `resumable` when one exists, and its guidance routes to `opencode_continue` with a larger budget. `opencode_status` republishes `openCodeSessionId` and `resumable` so the cheapest poll carries the recovery handle. Records written before 0.2.0 have no `resumable` field and are read as false. Timeout guidance splits on `toolCallCount`: a timeout with zero tool calls is a provider or model hang, not a budget that was too small.

`errorClass: "stalled"` is the opposite case and comes from the no-progress watchdog in `src/job-worker.ts`, whose rule is the pure `isProviderStall()` in `src/job-finalize.ts` (the worker is an executable and cannot be imported by a test). A run is ended early only when all three hold: it has emitted **under 4000 characters** of stdout, it has made **zero tool calls**, and it has been silent for 45s. All three bounds matter: after real output, 45s of silence is a long tool call, and a first tool call that is a build or a test run stays under 4000 characters for minutes — killing either would discard work the timeout branch could have resumed and would file it as a provider hang, with guidance that says a larger `timeoutMs` will not help. The worker therefore counts tool calls for every job, not only for jobs carrying a `maxToolCalls` ceiling. The recorded stalls held a 304-byte stdout and no tool call at all until their whole budget expired. A stall is retryable and its guidance points at the model, provider, or proxy rather than at a larger `timeoutMs`.

`src/timeout-budget.ts` owns the budget policy: floor `10000`, ceiling `86400000`, default `600000`, foreground clamp `240000`, and the per-kind p90 table with its sample sizes and measurement window. Warnings from it are advisory and never refuse a call.

## Transfer

Current Codex rollouts may contain injected user context in `response_item` records. The parser therefore prefers current visible events:

- `event_msg.user_message`
- `event_msg.agent_message`

Legacy response messages are used only when no visible event messages exist. System/developer messages, reasoning, and tool output are not transferred.

An explicit rollout is path-contained before reading. Transfer takes the same optional `model` as every other tool (`server.ts` hands it `commonShape.model`): omitting it falls back to OpenCode's configured default and reports `modelSelection`, and only a configuration that cannot be read at all is a refusal. It then imports the generated session JSON, requires `Imported session: <id>`, runs `opencode export <id> --sanitize`, and verifies `info.id`.

If `runAfterImport` fails, the response keeps `opencodeSessionId`, sets `importSucceeded: true`, and makes overall `ok` reflect continuation failure.

## Registration script

`scripts/register-opencode-collaboration-skills.mjs` may expose selected reusable Codex skills to OpenCode. It intentionally excludes `codex-opencode-collaboration` because that Skill is Codex-host orchestration. Existing conflicting targets are never overwritten. Security skills and Superpowers remain explicit opt-ins.

## TDD and verification

For behavior changes:

1. Add one minimal failing test and confirm the expected RED.
2. Implement the smallest source change and confirm GREEN.
3. Refactor only while targeted and full suites remain green.

Core commands:

```bash
npm run check
npm run test:integration
npm run smoke:opencode-cli
npm run smoke:background
npm audit --json
git diff --check
```

Use the official current plugin-creator validator in addition to the repository validator. Validate the built-in Skill and Dong-skills source with the current skill-creator `quick_validate.py`.

Live transfer is opt-in and must use a known authorized model. The script uses a synthetic visible rollout fixture; it must not import the current private task by default.

## Refreshing an installed plugin

Follow the current plugin-creator update flow:

1. Run `update_plugin_cachebuster.py` against the plugin directory. It may only append
   `+codex.<timestamp>` build metadata; the release core in front of `+` must stay equal to
   `package.json`. `npm run validate:plugin` and `test/version-sync.test.ts` enforce that, together
   with the MCP `serverInfo` version in `src/server.ts`, so an installed plugin can never advertise
   a version whose tool contract it no longer implements. Bump all three together when the contract changes.
2. Read the configured marketplace name with the plugin-creator helper.
3. Reinstall with `codex plugin add <plugin>@<marketplace>`.
4. Verify skills/tools in a new Codex task.

Do not hand-edit `marketplace.json` or Codex configuration, and do not commit/push as part of validation unless the user separately requests it.
