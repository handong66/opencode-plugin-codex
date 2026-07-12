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
| Background lifecycle | `opencode_status`, `opencode_result`, `opencode_cancel` |

Important parameters and boundaries:

- `prompt` is sent through stdin. It is never persisted in job records or placed in CLI argv.
- `cwd` must resolve inside a filesystem root supplied by the MCP client through standard roots or current Codex per-call workspace metadata. `files` accepts at most 32 existing regular files whose real paths stay inside `cwd`; outside paths and escaping symlinks are rejected.
- Configure a nonstandard OpenCode executable in the trusted MCP environment with `OPENCODE_BIN`. Tools do not expose a caller-controlled binary path.
- `opencode_run` defaults to background mode. `timeoutMs` applies to foreground and background work.
- `autoApprovePermissions` maps to current OpenCode `--auto`, which auto-approves permission prompts not explicitly denied. It does not allow Codex private paths. `allowCodexPrivatePaths` is a separate explicit boundary. `dangerouslySkipPermissions` remains a deprecated alias for `autoApprovePermissions` only.
- Background state is stored in the user's private state area (normally `~/.local/state/opencode-plugin-codex`). Directories use mode `0700`; job, input, and log files use `0600`.
- Status/result/cancel use only the returned `jobId`. An independent worker owns the OpenCode process, timeout, bounded logs, cancellation, and terminal state so MCP restarts do not lose control.

Only `outputSummary.resultComplete === true` is a finished OpenCode answer. Running, queued, cancelled, failed, JSONL-error, truncated, or succeeded-without-final-text results are partial evidence. Codex must verify every accepted finding against current files and commands.

## Transfer privacy

`opencode_transfer` imports visible user/assistant text into OpenCode's local session database. For current Codex rollouts it prefers `event_msg.user_message` and `event_msg.agent_message`, avoiding injected response-item context; legacy response messages are fallback only. It does not transfer system/developer messages, reasoning, or tool output.

An explicit authorized `model` is required. An explicit rollout must resolve inside an MCP client workspace root or the Codex sessions directory. Import is successful only when OpenCode returns a session ID and `opencode export --sanitize` reads that session back. If an optional continuation then fails, the response preserves `opencodeSessionId`, sets `importSucceeded: true`, and reports overall `ok: false`. A background continuation reports `continuationStarted: true` and `continuationResultComplete: false`; use its job result to establish finality.

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

`npm run check` typechecks, builds both `dist/server.js` and the independent `dist/job-worker.js`, runs Vitest, validates the repository plugin shape, and smoke-tests all MCP schemas.

Live transfer is opt-in and uses a synthetic visible-transcript fixture rather than the current private Codex task:

```bash
OPENCODE_BIN="$HOME/.opencode/bin/opencode" \
OPENCODE_MODEL="provider/model-authorized-for-this-user" \
npm run smoke:live-transfer
```

The selected Codex orchestration Skill is intentionally not registered into OpenCode by `npm run register:opencode-skills`; it is host-specific. The script also skips Codex security skills and Superpowers by default unless their explicit opt-in environment flags are set.

## Documentation authority

- Plugin source and tests: machine behavior.
- `plugins/opencode-plugin-codex/skills/opencode/SKILL.md`: concise tool/parameter/safety guidance.
- Dong-skills `codex-opencode-collaboration`: full orchestration, review, recovery, transfer, and acceptance workflow.
- `docs/development.md`: current architecture and maintenance rules.
- `docs/verification.md`: dated evidence ledger.

Keep the installed personal collaboration Skill as a mechanically synchronized copy of Dong-skills; do not evolve it independently.
