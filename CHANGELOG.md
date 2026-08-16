# Changelog

Notable changes to `opencode-plugin-codex`. Proposal ids (`OC-*`, `M*`) refer to the
2026-08-16 Grok/OpenCode plugin collaboration audit.

## Unreleased — 0.2.0

### Changed

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

- **X1** `opencode_review` and `opencode_adversarial_review` prompts now open with a
  headless-delegation preamble telling OpenCode to ignore repository bootstrap
  instructions that load interactive skills or personas, and not to narrate. 89 of 231
  surviving job logs loaded a skill before starting the requested work.

### Added

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
