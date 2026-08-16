# Changelog

Notable changes to `opencode-plugin-codex`. Proposal ids (`OC-*`, `M*`) refer to the
2026-08-16 Grok/OpenCode plugin collaboration audit.

## Unreleased — 0.2.0

### Changed

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
