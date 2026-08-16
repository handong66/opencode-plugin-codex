# opencode-plugin-codex

Use OpenCode as a bounded second agent from Codex. This repository packages a Codex plugin with a Node stdio MCP server, a concise built-in OpenCode Skill, tests, and runtime smokes.

Codex remains the owner of scope, workspace state, verification, git, and final judgment. OpenCode may review, diagnose, continue a session, or perform explicitly authorized narrow work; it must not commit, push, deploy, clean the worktree, or read hidden Codex context.

Project write-up: [han-dong.link/en/work/opencode-plugin-codex](https://han-dong.link/en/work/opencode-plugin-codex)

## Tools

`plugins/opencode-plugin-codex/src/server.ts` and its tests are the machine-contract authority.

| Need | Tool |
| --- | --- |
| Check CLI/provider/model visibility | `opencode_check` |
| Start a bounded task | `opencode_run` |
| Continue an OpenCode session | `opencode_continue` |
| Rescue diagnosis | `opencode_rescue` |
| Normal second review | `opencode_review` |
| Failure-mode review | `opencode_adversarial_review` |
| Import visible Codex conversation | `opencode_transfer` |
| Find a lost session or job handle | `opencode_sessions` |
| Background lifecycle | `opencode_status`, `opencode_result`, `opencode_cancel` |

Important parameters and boundaries:

- `prompt` is sent through stdin. It is never persisted in job records or placed in CLI argv.
- `cwd` must resolve inside a filesystem root supplied by the MCP client through standard roots or current Codex per-call workspace metadata. `files` accepts at most 32 existing regular files whose real paths stay inside `cwd`; outside paths and escaping symlinks are rejected.
- Configure a nonstandard OpenCode executable in the trusted MCP environment with `OPENCODE_BIN`. Tools do not expose a caller-controlled binary path.
- `opencode_run` defaults to background mode. `timeoutMs` applies to foreground and background work, accepts `10000..86400000`, and defaults to `600000`. Foreground calls are clamped to `240000` because Codex aborts a `tools/call` at 300s; longer budgets require background mode. A clamp, or a budget below the recorded p90 for that job kind, is reported in `warnings[]` and never refuses the call.
- `opencode_check` is cached for the MCP server process (`force: true` re-reads) and reports `workspace`, `effectiveModel`, `providers`/`providerIds`/`models` as parsed ANSI-free arrays, `agents`, the inherited `proxy` variables, and any leftover 0.1-era `.opencode-plugin-codex` / `.grok-plugin-codex` directory in the workspace (reported, never deleted).
- `model` should normally be omitted so OpenCode uses its configured default (943 of 1,051 recorded jobs did). Every execution result and job record carries `modelSelection` with `source: "opencode_config" | "explicit"`; an explicit model that differs from OpenCode's configured default adds a warning. The effective configuration is read with `opencode debug config`, of which only the root, build, and plan models (and their variants) are parsed — never credentials or anything else. `opencode_check` reports it as `effectiveModel`. Never call the OpenCode CLI directly through exec or shell: that bypasses the model, permission, path, and job-record contracts.
- `threatModel` (`opencode_adversarial_review`) states the operating context findings are judged against. Findings are then labelled in-model or out-of-model, and out-of-model findings are advisory — never blockers or NO_GO verdicts. The plugin does not invent a context when none is given.
- `maxToolCalls` (`opencode_run`, `opencode_rescue`, `opencode_review`, `opencode_adversarial_review`) bounds investigation rather than wall time. Reaching it does not kill the job: the background worker asks the same OpenCode session for its final answer and records `toolBudgetReached: true`. It is enforced in background mode only.
- `autoApprovePermissions` maps to current OpenCode `--auto`, which auto-approves permission prompts not explicitly denied, and is available on `opencode_run`, `opencode_continue`, and `opencode_rescue`. The two review tools do not accept it because they are read-only and `--auto` also approves writes. It does not allow Codex private paths. `allowCodexPrivatePaths` is a separate explicit boundary. `dangerouslySkipPermissions` remains a deprecated alias for `autoApprovePermissions` only.
- A foreground call returns the last `20000` characters of each stream (captured at `100000`) with `stdoutTruncated`/`stderrTruncated`; the complete buffers still feed `outputSummary`.
- `data.job` / `data.record` are projected: the resolved executable, the full argv, `workerPid`, `pid`, and the absolute state log paths stay inside the plugin. What a caller can act on — status, timestamps, `timeoutMs`, `opencodeSessionId`, `resumable`, `errorClass`, `errorMessage`, `modelSelection`, `toolBudgetReached` — is returned.
- Background state is stored in the user's private state area (normally `~/.local/state/opencode-plugin-codex`). Directories use mode `0700`; job, input, and log files use `0600`.
- Status/result/cancel use only the returned `jobId`. An independent worker owns the OpenCode process, timeout, bounded logs, cancellation, and terminal state so MCP restarts do not lose control.
- `opencode_status` and `opencode_result` accept `waitMs` and block until the record is terminal. The default is `0`; a request above `240000` is clamped to `240000` and reported in `warnings[]`, because the MCP client aborts a `tools/call` at 300s. The response reports `waited`, and each round re-reads the record so a cancellation from elsewhere ends the wait.

Only `outputSummary.resultComplete === true` is a finished OpenCode answer. Running, queued, cancelled, failed, JSONL-error, truncated, or succeeded-without-final-text results are partial evidence. Codex must verify every accepted finding against current files and commands.

`outputSummary.finalText` carries that answer in full (bounded at `32000`, with `finalTextTruncated`), so the stdout tail is evidence rather than the answer. The summary also reports what the run did — `toolCallCount`, `filesInspected`, `turnsUsed`, `skillsLoaded[]`, `evidenceLevel`, `permissionDenied`/`deniedPaths` — and a `review` or `adversarial_review` that made zero tool calls is reported as `resultComplete: false` with a warning; it is an opinion, not a review.

## Result envelope

Every tool returns the same shape:

```
{ ok, error?: { code, message, retryable, details? }, warnings: string[], data }
```

`data` holds the payload (`job`, `record`, `stdout`, `stderr`, `outputSummary`, `workspace`, `effectiveModel`, `continuation`, …). Small scalars — `terminal`, `nextAction`, `waited`, `resumable`, `openCodeSessionId`, `errorClass`, `exitCode`, `maxChars`, `maxCharsClamped`, `view`, `modelSelection`, `background`, `importSucceeded` and friends — are also mirrored at the top level for the 0.2 transition; the bulk fields are not, because duplicating them is what 0.2.0 removed. Read results from MCP `structuredContent`: a payload above `8192` characters is not duplicated into the text block.

Boundary refusals are returned, not thrown: a `cwd` outside the workspace roots comes back as `{ ok: false, error: { code: "workspace_out_of_bounds", retryable: false, details: { roots } } }`. The codes are `workspace_unavailable`, `workspace_out_of_bounds`, `file_attachment_invalid`, `private_path_blocked`, `rollout_invalid`, `state_write_failed`, `cli_not_found`, `cli_probe_timeout`, plus the `errorClass` vocabulary for OpenCode's own failures. On `opencode_status`, `opencode_result`, and `opencode_cancel`, `ok` describes the **job's** outcome, not the query's: a `failed` or `cancelled` job returns `ok: false` with `error: { code, message, retryable }`, and `terminal`/`nextAction` say whether the record can still change.

## Transfer privacy

`opencode_transfer` is opt-in and rarely the right tool: it was not called once in two months of recorded traffic, it reads a Codex private rollout file, and inlining the relevant context into an `opencode_run` prompt is usually cheaper and keeps the boundary narrower. Use it when the user explicitly asks to hand a long conversation over, or when a follow-up session genuinely needs the earlier turns.

It imports visible user/assistant text into OpenCode's local session database. For current Codex rollouts it prefers `event_msg.user_message` and `event_msg.agent_message`, avoiding injected response-item context; legacy response messages are fallback only. It does not transfer system/developer messages, reasoning, or tool output.

`model` is optional and falls back to OpenCode's configured default, reported as `modelSelection`; only a configuration that cannot be read is a refusal. An explicit rollout must resolve inside an MCP client workspace root or the Codex sessions directory. Import is successful only when OpenCode returns a session ID and `opencode export --sanitize` reads that session back. If an optional continuation then fails, the response preserves `opencodeSessionId`, sets `importSucceeded: true`, and reports overall `ok: false`. A background continuation reports `continuationStarted: true` and `continuationResultComplete: false`; use its job result to establish finality.

## Requirements and CLI discovery

- Node.js `>=22`
- npm
- Codex with local plugin marketplace support
- OpenCode CLI for live actions

Discovery order is trusted `OPENCODE_BIN`, `~/.opencode/bin/opencode`, Homebrew paths, then `PATH`.

## Install from this repository

```bash
npm install
npm run build
codex plugin marketplace add /path/to/opencode-plugin-codex
```

Install `opencode-plugin-codex` from that local marketplace, then start a new Codex task so skills and MCP tools load.

During local development, refresh an existing install through the current plugin-creator cachebuster/reinstall flow; do not hand-edit marketplace or Codex configuration.

## Development and verification

```bash
npm run check
npm run test:integration
npm run smoke:opencode-cli
npm run smoke:background
npm audit --json
git diff --check
```

`npm run check` typechecks, builds both `dist/server.js` and the independent `dist/job-worker.js`, runs Vitest, validates the repository plugin shape, and smoke-tests all MCP schemas. `.github/workflows/pull-request-ci.yml` runs `npm run check` and `npm run test:integration` on ubuntu-latest and macos-latest for every pull request and `release/**` push.

`npm run validate:plugin` refuses a release that carries the local `+codex.<timestamp>` cachebuster: with a tag pointing at `HEAD`, or with `OPENCODE_PLUGIN_RELEASE=1`, that manifest version is an error rather than a warning.

Live transfer is opt-in and uses a synthetic visible-transcript fixture rather than the current private Codex task:

```bash
OPENCODE_BIN="$HOME/.opencode/bin/opencode" \
OPENCODE_MODEL="provider/model-authorized-for-this-user" \
npm run smoke:live-transfer
```

The selected Codex orchestration Skill is intentionally not registered into OpenCode by `npm run register:opencode-skills`; it is host-specific. The script also skips Codex security skills and Superpowers by default unless their explicit opt-in environment flags are set.

## Documentation authority

- Plugin source and tests: machine behavior.
- `plugins/opencode-plugin-codex/skills/opencode/references/failure-routing.md`: the vendored, version-bound failure-routing and polling contract. `test/skill-contract.test.ts` fails the build when it names a code or field that no longer exists in `src/`.
- `plugins/opencode-plugin-codex/skills/opencode/SKILL.md`: concise tool/parameter/safety guidance.
- Dong-skills `codex-opencode-collaboration`: full orchestration, review, recovery, transfer, and acceptance workflow.
- `docs/development.md`: current architecture and maintenance rules.
- `docs/verification.md`: dated evidence ledger.

Keep the installed personal collaboration Skill as a mechanically synchronized copy of Dong-skills; do not evolve it independently.
