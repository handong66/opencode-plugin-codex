# Development

This document describes the current implementation. Source and tests win if documentation disagrees.

## Responsibility layers

1. `plugins/opencode-plugin-codex/src/` and tests define machine behavior.
2. `plugins/opencode-plugin-codex/skills/opencode/SKILL.md` briefly explains tools, parameters, finality, and safety.
3. Dong-skills `codex-opencode-collaboration` defines the full Codex-owned collaboration workflow. Its personal installed copy is synchronization output, not a second source.

Do not copy the orchestration workflow into the plugin Skill or register the Codex orchestration Skill into OpenCode.

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
5. Spawn with `CODEX_*` variables removed and a bounded stdout/stderr tail.
6. Parse JSONL error/step events and return `outputSummary`.

### Background

1. The MCP server creates a private job record and mode-`0600` prompt input under the central state directory.
2. It starts `dist/job-worker.js` detached and returns `jobId`.
3. The worker removes the input file after reading it, spawns OpenCode in its own process group, enforces `timeoutMs`, keeps bounded log tails, and writes partial logs while running.
4. The worker atomically writes the terminal record. A new MCP process can read/cancel the same job by ID.
5. Status reconciliation turns a nonterminal record with a dead worker into `failed/worker_unavailable`.

State directory order in the implementation (the override is primarily for tests/embedding; the shipped MCP config guarantees `HOME`):

1. `OPENCODE_PLUGIN_STATE_DIR`
2. `$XDG_STATE_HOME/opencode-plugin-codex`
3. `~/.local/state/opencode-plugin-codex`

State directories are `0700`; records, prompt inputs, and logs are `0600`. Job IDs must match `^job_[A-Za-z0-9_-]{1,128}$`. Output paths are derived from the validated ID rather than trusted from JSON.

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

`src/job-finalize.ts` owns the terminal shape of a record. It runs once, when the stream is already complete in memory, and parses it a single time to recover `opencodeSessionId` and the event count. Branch order is cancellation, timeout, spawn error, stdin error, structured JSONL error, then exit code.

There is one incremental reader on the hot path, and only one: `readStreamProgress()` (same module), which `job-worker.ts` calls per stdout chunk to enforce `maxToolCalls`. A half-written JSONL line still cannot be parsed, so the worker buffers the trailing partial line and hands `readStreamProgress()` complete lines only; it extracts nothing but the tool-call delta and the session id. Everything else about a record's shape stays in the single end-of-stream pass — do not grow this reader into a second finalizer.

A `timeout` is a spent budget rather than a failed job. The record keeps the recovered session id, sets `resumable` when one exists, and its guidance routes to `opencode_continue` with a larger budget. `opencode_status` republishes `openCodeSessionId` and `resumable` so the cheapest poll carries the recovery handle. Records written before 0.2.0 have no `resumable` field and are read as false.

`src/timeout-budget.ts` owns the budget policy: floor `10000`, ceiling `86400000`, default `600000`, foreground clamp `240000`, and the per-kind p90 table with its sample sizes and measurement window. Warnings from it are advisory and never refuse a call.

## Transfer

Current Codex rollouts may contain injected user context in `response_item` records. The parser therefore prefers current visible events:

- `event_msg.user_message`
- `event_msg.agent_message`

Legacy response messages are used only when no visible event messages exist. System/developer messages, reasoning, and tool output are not transferred.

An explicit rollout is path-contained before reading. Transfer requires an explicit authorized model, imports the generated session JSON, requires `Imported session: <id>`, then runs `opencode export <id> --sanitize` and verifies `info.id`.

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
