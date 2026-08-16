# Verification

Last verified on 2026-08-16 against OpenCode CLI 1.18.16 (Node v25.9.0, npm 11.12.1,
macOS). Every entry below must carry its own date and CLI version: the previous
record sat undated against CLI 1.17.15 for five weeks while the installed CLI moved on.

## Release matrix

```bash
npm audit --json
npm run check
npm run test:integration
npm run smoke:opencode-cli
npm run smoke:background
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/opencode-plugin-codex
python3 "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" plugins/opencode-plugin-codex/skills/opencode
git diff --check
```

### 0.2.0 — 2026-08-16 (OpenCode CLI 1.18.16, Node v25.9.0, macOS)

- `npm test`: 33 files, 263 tests passed.
- `npm run check`: build, typecheck, the unit suite (33 files, 263 tests), repository
  plugin validation, and the MCP smoke (11 tools) passed. `git status --porcelain` was
  empty after the build, so the committed `dist/` matches `src/`.
- `npm run test:integration`: 4 files, 15 tests passed against the built `dist/` —
  background lifecycle, workspace roots, tool contract, and tool-call budget.
- CI: `.github/workflows/pull-request-ci.yml` runs `npm run check` and
  `npm run test:integration` on ubuntu-latest and macos-latest for pull requests and
  `release/**` pushes. Before this the repository had no CI at all and every gate ran
  by hand on one macOS machine.
- Release gate: `npm run validate:plugin` fails when a tagged commit (or
  `OPENCODE_PLUGIN_RELEASE=1`) carries the local `+codex.<timestamp>` cachebuster.
- Live OpenCode CLI smokes (`npm run smoke:opencode-cli`, `npm run smoke:background`,
  `npm run smoke:live-transfer`) are not part of this record: they call the real CLI
  and provider, and this release was verified without spending provider quota.
- Not covered by any suite here: the no-progress watchdog assumes OpenCode emits a
  tool event when a tool call *starts*. If a provider only emits on completion, a slow
  first tool call is still invisible to it. Confirm with one live
  `npm run smoke:background` run before publishing.

### 0.1.0 — 2026-07-10 (OpenCode CLI 1.17.15)

- Dependency audit: 0 vulnerabilities.
- Unit suite: 8 files and 43 tests passed.
- Cross-MCP background lifecycle and installed-cache workspace-root integration: 4 tests passed.
- Repository validator and current official plugin-creator validator passed.
- MCP smoke listed all 10 tools and verified the current schemas: no public `opencodeBin`, separate permission/private-path flags, and job lifecycle tools keyed only by `jobId`.
- OpenCode CLI smoke passed `--version`, `--help`, and the `run`, `providers`, `models`, and `import` help probes.
- Built-in, Dong-skills source, and installed collaboration Skills passed the current quick validator.
- Both repositories passed `git diff --check`.

## TDD evidence

The regression suite was observed RED before each behavior fix. Reproduced failures included job-ID traversal, hidden transfer text, prompt text in argv, workspace/file escapes, caller-controlled executables, ignored background timeout, leaked `CODEX_*` variables, incomplete JSONL treated as final, exit-zero JSONL errors, unverified imports, continuation partial-success loss, unbounded output, stale workers, missing live partial logs, stdin delivery loss, cancellation overwritten by a stale worker write, an installed MCP process mistaking its plugin-cache cwd for the Codex project root, current Codex returning an empty standard roots list despite carrying per-call workspace metadata, and stale standard roots after a same-connection workspace change. Each targeted test passed after the minimal implementation, then the full matrix passed.

## Runtime smoke

The current authorized model was exercised only with harmless sentinel prompts:

- Real background job `job_1783678207215_ec02730d` reached `succeeded_with_text` and returned `OPENCODE_PLUGIN_CODEX_REAL_BACKGROUND_OK`.
- Final installed-cache job `job_1783679105030_b146cc2a` reached `succeeded_with_text`, returned `OPENCODE_PLUGIN_CODEX_FINAL_CACHE_BACKGROUND_OK`, and had `outputSummary.resultComplete=true`.
- Live transfer imported two synthetic visible user/assistant messages into session `ses_codex_transfer_1783678212540`, continued it successfully, and returned `OPENCODE_PLUGIN_CODEX_LIVE_TRANSFER_OK`.
- Export readback confirmed the visible messages were present and the injected hidden fixture text was absent.

The live-transfer smoke uses a synthetic rollout fixture. It does not export the current Codex task or private runtime context.

## OpenCode second review

Bounded read-only review job `job_1783676581578_c797be85` completed with `outputSummary.resultComplete=true` and did not spawn a subagent. Codex accepted and regression-tested stdin delivery failure and cancellation precedence, narrowed background-continuation ambiguity into explicit `continuationStarted`/`continuationResultComplete` fields, and rejected two claims that contradicted the current polling reconciliation and status re-read code.

Final workspace-boundary review job `job_1783679182891_59f757d2` also completed with `outputSummary.resultComplete=true` and no subagent. Codex accepted its stale `roots/list` cache finding, reproduced it with a same-connection root-change test, and removed the cache. Claims that client-supplied Codex workspace metadata was less trusted than client-supplied standard roots, that attachments should escape `cwd` into sibling roots, or that status reconciliation was an unintended side effect contradicted the current client/source contract and tests.

## Background contract

Background jobs run in an independent worker with private central state. A new MCP process can use the original `jobId` for status, result, and cancellation. `timeoutMs` is enforced by the worker, with one published exception: a job that reaches `maxToolCalls` runs a final-answer pass with a 30000ms floor and can therefore finish up to 30s late. Missing workers reconcile to `worker_unavailable`; a terminal record can no longer be overwritten by a write that started earlier; cancellation has durable precedence over stale worker writes; and prompt input is removed after it is read. Only `outputSummary.resultComplete === true` is a final OpenCode conclusion.

## Installed plugin pickup — run this before publishing

Everything above was verified from the repository checkout. This step is the one
gate the repository cannot run for itself: it proves that what an installed cache
serves is what was built here. **Do not publish a release until it has passed and
been recorded below.**

From the repository root:

```bash
npm run check                       # leaves dist/ matching src/; git status must be empty
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" plugins/opencode-plugin-codex
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py"
codex plugin add opencode-plugin-codex@<marketplace-name>   # 0.1.0 used @opencode-plugin-codex
```

Then open a **new** Codex task — an existing task keeps the MCP server it started,
so it will keep serving the old build — and confirm all five of:

1. `opencode_check` returns `ok: true` and reports the installed OpenCode CLI. It must
   discover the CLI without calling a model, so this costs no provider quota.
2. It accepts the project root that current Codex supplies as per-call workspace
   metadata, with the standard MCP roots list empty.
3. The task lists 11 tools (as of 0.2.0), not 10.
4. The published schemas are the current ones: `timeoutMs` refuses `1..9999`,
   `maxToolCalls` is present on `opencode_run` with range `1..500`, and
   `opencode_review` does **not** accept `autoApprovePermissions`.
5. The built-in Skill served from the cache is this version's — it points at
   `references/failure-routing.md` and names `opencode_sessions`.

Record the date, the plugin version actually picked up, the OpenCode CLI version, and
the tool count each time. A run that is not recorded here did not happen.

- 2026-07-10: fresh Codex CLI task `019f4b94-5975-7b23-a2a3-9848c0826361` passed against installed cache `0.1.0+codex.20260710103034`, OpenCode CLI 1.17.15, 10 tools.
- 0.2.0: **not yet run.** This release was verified from the repository only. Run the
  steps above before publishing and add the result here.
