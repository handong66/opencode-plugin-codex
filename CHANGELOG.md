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

### Added

- **OC-1** Execution tools return a top-level `warnings: string[]`. Two advisory warnings
  exist so far: a foreground clamp, and a budget below the recorded p90 wall time for that
  job kind (`continue` 179000, `rescue` 283000, `run` 306000, `review` 347000,
  `adversarial_review` 370000; sample sizes and window are carried in the warning text).
  Neither warning changes whether the call runs.
