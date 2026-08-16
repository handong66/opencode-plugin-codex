# Changelog

Notable changes to `opencode-plugin-codex`. Proposal ids (`OC-*`, `M*`) refer to the
2026-08-16 Grok/OpenCode plugin collaboration audit.

## Unreleased — 0.2.0

### Contract

- **OC-9 (breaking)** Every tool now returns one envelope:
  `{ ok, error?: { code, message, retryable, details? }, warnings: string[], data }`.
  There used to be four shapes (background submit, foreground result, status,
  result), only `opencode_transfer` ever emitted `{code,message}`, and boundary
  failures were bare MCP exceptions with no code at all — which is how 9,892 recorded
  events carried exactly one error code between them.
  - The payload moved into `data`: `job`, `record`, `stdout`, `stderr`,
    `outputSummary`, `providersRaw`, `modelsRaw`, `continuation`, `importedMessages`,
    `workspace`, `effectiveModel`, `tried`, `errors`, `source`, `rolloutFile`, `model`.
    Read `structuredContent.data`.
  - Small scalars are still mirrored at the top level for the transition:
    `background`, `terminal`, `nextAction`, `waited`, `resumable`,
    `openCodeSessionId`, `opencodeSessionId`, `errorClass`, `exitCode`, `bin`,
    `version`, `opencodeBin`, `stdoutTruncated`, `stderrTruncated`, `maxChars`,
    `maxCharsClamped`, `view`, `rawOmitted`, `modelSelection`, `importSucceeded`,
    `continuationStarted`, `continuationResultComplete`. Bulk fields are deliberately
    **not** mirrored: duplicating them would undo OX2.
  - Boundary refusals are **returned, not thrown**. `opencode_run` with a `cwd`
    outside the workspace roots now returns
    `{ ok: false, error: { code: "workspace_out_of_bounds", retryable: false, details: { roots } } }`
    instead of raising an MCP error with no code.
  - `warnings` is always present and always an array.
  - `error.code` shares one vocabulary with the OC-3 `errorClass` values and with
    grok-plugin-codex, and `retryable` follows the same table: `quota_exhausted`,
    `auth_required`, `model_unauthorized`, `model_not_found`, every boundary code and
    `cli_not_found` are not retryable; `timeout`, `terminated`, `rate_limited`,
    `network_error`, `opencode_failed`, `cli_probe_timeout`, `unknown` are.
  - A failed foreground run now also carries `error`, matching what `opencode_status`
    already did for background jobs.
- **OX5 (breaking)** Job records are projected before they cross the wire.
  `opencode_status` used to return the resolved executable path, the complete argv
  (including `--model`), `workerPid`, `pid`, and the absolute
  `~/.local/state/...` log paths; a recorded response shows all of it. `data.job` and
  `data.record` now carry only `id`, `kind`, `status`, `cwd`, the timestamps,
  `timeoutMs`, `maxToolCalls`, `toolBudgetReached`, `opencodeSessionId`,
  `modelSelection`, `resumable`, `exitCode`, `signal`, `errorClass`, `errorMessage`,
  `cancelRequestedAt` and `outputTruncated`. The projection matches
  grok-plugin-codex's `toPublicJob()`, field names included, and a test asserts no
  argv entry, pid, or state path appears in a tool result.

### Changed

- **OC-7** The `model` parameter description no longer encourages passing a model on
  every call ("Pass an actually authorized model from the user's OpenCode provider
  config."). It now says to omit `model` for normal collaboration and to pass one only
  for a requested override or a continuation that requires a previously verified model.
  The bundled Skill and README also state that the OpenCode CLI must never be invoked
  directly through exec or shell: the one recorded direct call created a session the
  plugin never saw and a 403 it could not explain.

- **Release metadata** `package.json`, `.codex-plugin/plugin.json` and the MCP `serverInfo`
  now all report `0.2.0`. They disagreed for the whole 0.1 era (`0.1.0` vs
  `0.1.0+codex.20260710103034`), so a caller could not pin the contract by version — and
  since the `timeoutMs` floor below is a wire-level refusal, shipping it under `0.1.0`
  would have advertised a contract the code no longer honours. The manifest's local
  cachebuster is now build metadata only: `npm run validate:plugin` and
  `test/version-sync.test.ts` fail when the release core in front of `+` is not the
  version that was built.

- **OC-1** `timeoutMs` is now a documented budget instead of a bare positive integer.
  The schema accepts `10000..86400000` (was: any positive integer up to `86400000`), so
  budgets too small to finish an OpenCode job are refused at the schema layer, while the
  30–45s budgets that did succeed are still accepted. The published `.describe()` states
  the `600000` default, the measured timeout rate per budget, and that lowering
  `timeoutMs` discards work rather than making OpenCode faster.
- **OC-1** Foreground calls (`background:false`) clamp the budget to `240000` instead of
  passing an unusable value to a call Codex aborts at 300s. The clamp is reported, never
  refused.

- **OC-2** A timed-out job is no longer reported as a generic failure. `errorMessage`
  now states the budget, how many events OpenCode produced, and whether the session
  survives; `outputSummary.guidance` routes to `opencode_continue` with a larger budget
  instead of "rerun with a narrower prompt", which discarded the work.

- **M6** `opencode_result`'s `maxChars` no longer has two disagreeing rules. The schema
  used to hard-reject above `100000` while the job store silently clamped, so a caller
  widening its window (80000 → 100000 → 120000) got `MCP error -32602 … too_big` instead
  of a tail. The schema now accepts up to `1000000`, the store clamps to `1..100000`, and
  the response reports the effective `maxChars` and `maxCharsClamped`.

- **OC-10 / M5** A foreground (`background:false`) call now captures at most 100000
  characters per stream and returns the last 20000, with `stdoutTruncated` /
  `stderrTruncated` saying so. It used to capture 1000000 and return all of it, making
  the synchronous path 10–50× wider than the background path for no reason: 1,061
  recorded payloads exceeded 50,000 characters and the largest was 1,341,598. The
  complete buffers still feed `outputSummary` and the JSONL error detector, so
  diagnosis is unaffected — and `outputSummary.finalText` (OC-5) now carries the answer
  the tail no longer has to.
- **OX4** OpenCode discovery is memoised for the life of the MCP server process, an
  explicitly configured binary (`opencodeBin`, `OPENCODE_BIN`) is trusted once it is
  executable instead of being gated on `--version`, and the probe budget rose from 5s to
  15s. Previously every call re-walked up to 19 candidates with a 5s probe each and no
  cache anywhere, which is how `opencode_check` could report the CLI available and
  `opencode_run` report it missing 27 seconds later — while listing the caller's own
  explicit path among the 19 it tried. A remembered binary is re-checked for existence,
  and failures are never remembered. `discoverOpenCode` reports `source`
  (`explicit` | `probe` | `cache`).
- **OX4** Discovery failures now separate `cli_not_found` from `cli_probe_timeout`, and
  the thrown message carries the reasons (`errors[]`), not just the list of paths.
- **OX3** `opencode_status`, `opencode_result` and `opencode_cancel` no longer hardcode
  `ok: true`. `ok` now mirrors the **job's** outcome: a `failed` or `cancelled` job
  returns `ok: false` with `error: { code, message, retryable }` (the code is the
  OC-3 `errorClass`, or `cancelled`). `{"ok": true, "job": {…"status":"failed"…}}` was
  the old shape. This ships in the same version as the OC-3 vocabulary so callers adapt
  once.
- **OX2** Responses are no longer sent twice. Every tool result used to be serialised
  pretty-printed into `content[0].text` *and* as `structuredContent` — about 195,000,000
  characters of duplicate across the audit window, with one `opencode_result` payload at
  265,570 characters for a 100,000-character request. The text copy is now compact, and
  above 8192 characters it is replaced by a one-line notice
  (`{"ok":…,"structuredContentOnly":true,"payloadChars":…}`) while the full payload
  travels once, in `structuredContent`. Callers must read `structuredContent`.
- **OC-3** `errorClass` is no longer inferred from OpenCode's own prose. Classification
  now reads only real error channels, in order: the wall-clock timeout, a terminating
  signal, a structured JSONL `{"type":"error"}` event (branching on
  `error.data.statusCode`), then stderr. stdout is model output — a review that discusses
  a 403 used to be filed as `model_unauthorized`. Wording the table does not recognise
  degrades to `unknown` plus the provider's full message instead of a wrong class, and
  the provider message (for example `Did you mean: aihubmix?`) is passed through verbatim.
- **OC-3** A bare `"timeout"` substring in an error stream is no longer `network_error`;
  transport failures are matched by their own tokens (`ECONNREFUSED`, `ENOTFOUND`,
  `ETIMEDOUT`, …).
- **OC-3** Every failed job now carries an `errorMessage`. The generic non-zero-exit
  branch previously set a class and no message.
- **OC-5** A step's text parts are joined instead of overwritten, so a final answer split
  across several `text` parts is no longer reduced to its last fragment. Hardening: no
  recorded log did this.
- **OC-4** `outputSummary.guidance` for a permission-denied job replaces "rerun with a
  narrower target" (which shrank the scope of a job that had inspected nothing) with the
  denied paths, a statement that absence of findings is not evidence of correctness, and
  the cheap remedy first: choose a `cwd` that contains those paths, and only then, with
  the user's explicit approval, `autoApprovePermissions`.
- **OC-3** `outputSummary.guidance` for a non-retryable failure (`quota_exhausted`,
  `auth_required`, `model_unauthorized`, `model_not_found`) says what to do instead of
  retrying, rather than "rerun with a narrower prompt".

- **X2** The review prompts now require every finding to cite `file:line` and require a
  no-findings verdict to list the files actually opened. `opencode_adversarial_review`'s
  `Return at most 5 findings` became "report every finding, sorted by severity, and mark
  the five most severe as primary" — the old cap silently truncated adversarial coverage.

- **X1** `opencode_review` and `opencode_adversarial_review` prompts now open with a
  headless-delegation preamble telling OpenCode to ignore repository bootstrap
  instructions that load interactive skills or personas, and not to narrate. 89 of 231
  surviving job logs loaded a skill before starting the requested work.

### Added

- **X3** `opencode_adversarial_review` accepts `threatModel`: the operating context
  findings are judged against, in the user's own words. Every finding is then
  labelled in-model or out-of-model, and an out-of-model finding is advisory only —
  never a blocker, a NO_GO, or a reason to stop work in progress. When no context is
  supplied the plugin does not invent one (it cannot know that a system has no
  network exposure); it asks for a robustness review of the named target and marks
  context-dependent findings advisory. The prompt is also worded in failure-mode
  terms rather than attacker/attack-chain terms: a recorded adversarial review
  tripped the client's own content filter (`cyber_policy`) and stopped the user's
  turn mid-task.
- **OX9** `opencode_check`, `opencode_status` and `opencode_result` are annotated
  `readOnlyHint` / `idempotentHint` / `openWorldHint: false`. One recorded 85-minute
  window held 18 client approval evaluations — 7 `opencode_status`, 6
  `opencode_result` — every one allowed, each with 5–19s of waiting, each concluding
  that the call only reads. Tools that start or end OpenCode work stay unannotated.
- **X7** The `timeoutMs` description and `opencode_status` now publish the typical
  wall time per kind (continue ~62s, run ~129s, review ~171s, adversarial_review
  ~223s; ~99s median overall, ~278s p90) and say not to cancel before `timeoutMs`
  unless status shows `waitingForAuth` or no events for 45s. 43 recorded
  cancellations came at a median of 107s elapsed — 26 of them under 120s — while the
  job was still on schedule.
- **OX7** A no-progress watchdog. The background worker records `lastEventAt` on
  every chunk (persisted at most every 10s, and returned on the record), and a run
  that has produced almost nothing (under 4000 characters) and then falls silent for
  45s is ended early as `errorClass: "stalled"` (retryable) instead of holding its
  whole budget. Two recorded jobs held a 304-byte stdout — one `step_start` — until
  their budget expired, and a foreground pair burned 120000ms and 180000ms the same
  way before the same task finished in about 15 seconds on an explicit lighter model.
  The watchdog deliberately stops applying once real output is flowing: after that,
  silence is a long tool call, and killing it would discard resumable work.
- **OX7** `timeout` guidance now branches on what the run actually did. Zero tool
  calls plus a spent budget is reported as a provider or model hang — raise nothing,
  change model or check the provider and proxy — while a timeout after real tool
  calls keeps the resume-the-session advice.
- **OX6** `opencode_check` is cached for the life of the MCP server process and no
  longer re-runs the CLI on every call: 471 recorded calls in two months, 124 of them
  on one day, 456 of which returned the same binary, version, and provider banner.
  Discovery, the effective-model probe, and the provider/model listings are all
  cached; `force: true` re-reads them after a CLI install or a configuration change,
  and the response reports `cache.providersCachedAt` / `cache.providersCacheHit`. The
  tool description now says the result is stable for the session.
- **OX6** Provider and model listings are returned as parsed arrays (`providers`,
  `providerIds`, `models`) with ANSI escapes stripped, and `providersRaw`/`modelsRaw`
  are stripped too — every one of those 471 responses used to push terminal control
  bytes into the caller's context as content.
- **OX10(a)** An explicit `model` whose provider id differs only in case from one
  `opencode_check` already enumerated in this process is refused before the job
  starts, with `error.code: "model_not_found"`, the correct spelling, and
  `details.knownProviders`. `AIHubMix/deep-deepseek-v4-pro` ran five jobs and
  succeeded zero times while `aihubmix/…` ran 62 and succeeded 50. Nothing is
  rewritten silently — that was rejected — and a provider that is simply absent from
  the listing is not refused, since it may have been configured since.
- **OX6 / OX10(a)** A failing provider or model listing is no longer wrapped in
  `ok: true`. `Provider not found: AIHubMix` arrived five times inside a successful
  envelope, and the caller went on to submit `AIHubMix/…` jobs (five jobs, zero
  successes) anyway; it is now `ok: false` with `error.code: "provider_listing_failed"`.
- **OC-8** Boundary refusals are typed. `workspace_unavailable`,
  `workspace_out_of_bounds`, `file_attachment_invalid`, `private_path_blocked`,
  `rollout_invalid` and `state_write_failed` replace bare `Error` throws, each with a
  stable code, `retryable: false`, and details. 9,892 recorded events carried exactly
  one error code between them. The guards themselves are unchanged and still
  fail-closed — including the deliberate `Promise.all` over workspace roots, which is
  not relaxed to `allSettled`: no recorded event ever hit a root resolution failure.
- **OC-8** `workspace_out_of_bounds` now lists the roots that *are* available and says
  that they are Codex's per-call workspace roots, so a newly created worktree is
  rejected until it is added to the Codex workspace. That sentence covers three of the
  four recorded refusals.
- **OC-8** The attachment refusal says what a legal value is —
  `Attachments must resolve inside cwd (<cwd>). Copy the file into the workspace, or
  inline its contents in prompt.` The old message repeated verbatim six times in one
  month while never saying that.
- **OC-8** `opencode_check` degrades instead of failing whole: with no usable workspace
  root it returns `workspace: { ok: false, error: { code, message, retryable } }` and
  still reports CLI discovery and the effective model (probed from a neutral
  directory), while provider and model listings are skipped. Every execution tool
  remains fail-closed, and the response says so rather than inviting a raw CLI call.
- **OC-8** A failed job-record write is `state_write_failed` and names the state
  directory, the errno, and `OPENCODE_PLUGIN_STATE_DIR`. The one recorded ENOSPC
  surfaced as a raw errno from a temp file with no mention of which directory filled.
  Not implemented (rejected in the spec): default retention cleanup of the state
  directory — the surviving job logs are the only forensic surface there is.
- **OC-7** `modelSelection` on every execution result and job record: `source` is
  `opencode_config` when the caller omitted `model` (943 of 1,051 recorded jobs) and
  `explicit` when it did not, plus `requested`, the `configured` default, and the
  build/plan agent models. An explicit model that differs from OpenCode's configured
  default adds a warning naming both — it never refuses the call, and there is no new
  "authorization verified" field: a configured or listed model is still not proof of
  authorization. The effective configuration comes from `opencode debug config`, of
  which only the root/build/plan models and variants are parsed; the raw config is
  never returned. The probe is memoised per binary and directory, and on the submit
  path it runs only when an explicit model was passed, so the common case spawns
  nothing extra. `opencode_check` reports it as `effectiveModel`.
- **OC-6** `waitMs` on `opencode_status` and `opencode_result`. The server now blocks
  until the record is terminal (backing off 500ms → 5s, re-reading the record each
  round so an `opencode_cancel` from elsewhere ends the wait) and reports `waited`.
  Any request above `240000` is clamped to `240000` and the clamp is reported, because
  the MCP client aborts a `tools/call` at 300s. Polling was previously the only option:
  3,819 poll rounds across 685 jobs, at a median interval of 36s against a median job
  time of 99s.
- **OX3** `terminal: boolean` and `nextAction: string` on `opencode_status`,
  `opencode_result` and `opencode_cancel`. A terminal record says
  `do not poll again; the record is final`; a live one says to wait and not to call
  status and result at the same instant. Polling a job that has been terminal for more
  than five minutes adds a warning naming how long ago it finished. Without these the
  only viable strategy was busy polling: 3,819 poll rounds over 685 jobs.
- **OX1** `maxToolCalls` on `opencode_run`, `opencode_rescue`, `opencode_review` and
  `opencode_adversarial_review`. Wall-clock used to be the only knob, and 86 timed-out
  job logs hold 1,360 tool calls (median 13, p90 37, max 81) against 202 text events —
  one job made 53 tool calls and produced no text at all. Reaching the ceiling does not
  SIGTERM the job: the worker ends that pass and asks the same OpenCode session to
  produce its final answer from what it already gathered, then reports
  `toolBudgetReached: true` on the record. Enforced by the background worker only; a
  `background:false` call reports the ignored ceiling in `warnings[]`.
- **OX1** Both review prompts now carry a hard file budget ("do not open more than 20
  files; say which subset you reviewed and which you skipped").
- **X2/X1** `outputSummary` now reports what the run actually did: `toolCallCount`,
  `filesInspected` (distinct paths), `turnsUsed`, `skillsLoaded[]`, the derived
  `evidenceLevel` (`none` | `thin` | `substantive`), and `warnings[]`.
- **X2** A `review` or `adversarial_review` that made **zero tool calls** is no longer
  `resultComplete: true`. It reports `resultComplete: false` plus the warning
  `verdict produced with 0 tool calls — treat as opinion, not review`, and its guidance
  says not to count it as a passing vote. In the sibling plugin 30 of 64 "succeeded"
  review jobs had opened no file at all. `finalText` is still returned — the caller has
  to be able to read what was claimed.
- **X1** `outputSummary.warnings[]` names interactive skills a headless delegation loaded
  (89 of 231 recorded logs loaded one before starting the requested work).
- **OC-5** `outputSummary.finalText` and `outputSummary.finalTextTruncated`. The final
  answer was already parsed out of the stream and thrown away after producing a 500-char
  preview; recorded answers are median 4,226 / p90 8,784 / max 24,811 characters, so the
  preview showed 2–12% of one and every caller re-implemented the `step_finish` parser.
  Field name and semantics match grok-plugin-codex's `outputSummary.finalText`. Bounded
  at 32000 characters.
- **OC-5** `opencode_result` accepts `view: "raw" | "final"`. `raw` stays the default —
  the installed `codex-opencode-collaboration` Skill still tells callers to read
  stderr/JSONL evidence, so the default cannot flip before that document ships the same
  version. `final` drops the stdout/stderr tails and sets `rawOmitted: true`.
- **OC-4** `outputSummary.permissionDenied` and `outputSummary.deniedPaths` (capped at 5)
  report permissions OpenCode asked for and did not get, read from the
  `permission requested: <tool> (<path>); auto-rejecting` stderr lines and from rejected
  tool states in the JSONL stream. All six recorded `succeeded_without_text` jobs were
  this, and none of them had asked for `--auto`.
- **OC-4** `opencode_continue` and `opencode_rescue` now accept `autoApprovePermissions`.
  Four of the six recorded auto-rejections were kinds that had no way to ask for it.
  `opencode_review` and `opencode_adversarial_review` still do not accept it: their
  prompts end with "Stay read-only" and OpenCode's `--auto` also approves writes.
- **OC-3** New `errorClass` values: `quota_exhausted`, `model_not_found`, `auth_required`,
  `rate_limited`, and `terminated`. The first four were previously reported as
  `model_unauthorized` or `opencode_failed`; `terminated` covers a job ended by a signal,
  which used to be run through the keyword classifier. Names shared with
  grok-plugin-codex are reused verbatim so one orchestrator learns one table.
- **OC-3** `isRetryableOpenCodeFailure(errorClass)` is exported for callers that route on
  the class: `quota_exhausted`, `auth_required`, `model_unauthorized` and
  `model_not_found` are not retryable; everything else is.
- **OC-2** `JobRecord.opencodeSessionId` is recovered from the job's own output when the
  job ends, not only from the caller's arguments. All 113 recorded `run` timeouts had a
  usable session id in their stream and kept none of it.
- **OC-2** `JobRecord.resumable` (and `opencode_status`'s top-level `resumable` and
  `openCodeSessionId`) tell a caller whether the work can be continued. Records written
  before 0.2.0 omit `resumable`; a missing value means false.
- **OC-1** Execution tools return a top-level `warnings: string[]`. Two advisory warnings
  exist so far: a foreground clamp, and a budget below the recorded p90 wall time for that
  job kind (`continue` 179000, `rescue` 283000, `run` 306000, `review` 347000,
  `adversarial_review` 370000; sample sizes and window are carried in the warning text).
  Neither warning changes whether the call runs.
