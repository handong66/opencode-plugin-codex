# OpenCode for Codex

This plugin exposes ten `opencode_*` MCP tools for bounded OpenCode work, review, background lifecycle management, and privacy-filtered visible-thread transfer. The repository README contains installation and verification details; `src/server.ts` and tests define the machine contract.

## Contract summary

- Put task instructions in `prompt`; the plugin sends them through stdin.
- `cwd` is realpath-contained inside roots supplied by standard MCP roots or current Codex per-call workspace metadata; `files` remains inside `cwd`. Configure the CLI with trusted `OPENCODE_BIN`, not a tool parameter.
- Background jobs use private central state plus an independent worker, survive MCP restarts, and enforce `timeoutMs`. Keep the returned `jobId`; status/result/cancel do not take `cwd`.
- Only `outputSummary.resultComplete === true` is a final OpenCode conclusion; `outputSummary.finalText` is that conclusion in full, and `toolCallCount` / `filesInspected` / `evidenceLevel` / `permissionDenied` say how much the run actually looked at. A review with zero tool calls is never complete.
- On `opencode_status`, `opencode_result`, and `opencode_cancel`, `ok` mirrors the job's outcome and comes with `terminal`, `nextAction`, and `error: { code, message, retryable }`. Read payloads from `structuredContent`; above 8192 characters they are not duplicated as text.
- `maxToolCalls` bounds investigation instead of wall time; reaching it triggers a final-answer pass in the same session rather than a kill.
- `autoApprovePermissions` maps to OpenCode `--auto` on run/continue/rescue only. Private Codex paths require separate explicit `allowCodexPrivatePaths` authorization.
- Transfer prefers visible Codex `event_msg` user/assistant text, requires an explicit authorized model, verifies import by export readback, preserves partial-success details when continuation fails, and distinguishes a started background continuation from a complete result.

Codex remains final owner. OpenCode must not commit, push, deploy, clean the worktree, read hidden Codex context, or replace local verification.

## Tools

`opencode_check`, `opencode_run`, `opencode_continue`, `opencode_rescue`, `opencode_review`, `opencode_adversarial_review`, `opencode_transfer`, `opencode_status`, `opencode_result`, and `opencode_cancel`.

From the repository root, run `npm run check`, `npm run test:integration`, `npm run smoke:opencode-cli`, and `npm run smoke:background` before release. Live transfer remains opt-in through `npm run smoke:live-transfer` with an explicitly authorized `OPENCODE_MODEL`.
