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

Results:

- Dependency audit: 0 vulnerabilities.
- Unit suite: 8 files and 43 tests passed.
- Cross-MCP background lifecycle and installed-cache workspace-root integration: 4 tests passed.
- Repository validator and current official plugin-creator validator passed.
- MCP smoke listed all 10 tools and verified the current schemas: no public `opencodeBin`, separate permission/private-path flags, and job lifecycle tools keyed only by `jobId`.
- OpenCode CLI smoke passed `--version`, `--help`, and the `run`, `providers`, `models`, and `import` help probes.
- Built-in, Dong-skills source, and installed collaboration Skills passed the current quick validator.
- Both repositories passed `git diff --check`.

## 0.2.0 — 2026-08-16 (OpenCode CLI 1.18.16, Node v25.9.0, macOS)

- `npm test`: 31 files, 228 tests passed.
- `npm run check`: build, typecheck, unit suite, repository plugin validation, and the
  MCP smoke (11 tools) passed.
- `npm run test:integration`: background lifecycle, workspace roots, tool contract,
  and tool-call budget suites passed against the built `dist/`.
- CI: `.github/workflows/pull-request-ci.yml` runs `npm run check` and
  `npm run test:integration` on ubuntu-latest and macos-latest for pull requests and
  `release/**` pushes. Before this the repository had no CI at all and every gate ran
  by hand on one macOS machine.
- Release gate: `npm run validate:plugin` fails when a tagged commit (or
  `OPENCODE_PLUGIN_RELEASE=1`) carries the local `+codex.<timestamp>` cachebuster.
- Live OpenCode CLI smokes (`npm run smoke:opencode-cli`, `npm run smoke:background`,
  `npm run smoke:live-transfer`) are not part of this record: they call the real CLI
  and provider, and this release was verified without spending provider quota.

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

Background jobs run in an independent worker with private central state. A new MCP process can use the original `jobId` for status, result, and cancellation. `timeoutMs` is enforced by the worker; missing workers reconcile to `worker_unavailable`; cancellation has durable precedence over stale worker writes; and prompt input is removed after it is read. Only `outputSummary.resultComplete === true` is a final OpenCode conclusion.

## Installed plugin pickup

After a cachebuster update and `codex plugin add opencode-plugin-codex@opencode-plugin-codex`, verify from a new Codex task that the built-in Skill is current, all 10 tools are discoverable, the current schemas are present, and `opencode_check` accepts the project root supplied by current Codex per-call workspace metadata when standard MCP roots are empty. The check must discover OpenCode 1.17.15 without calling a model. Fresh Codex CLI task `019f4b94-5975-7b23-a2a3-9848c0826361` passed this pickup check against installed cache `0.1.0+codex.20260710103034` on 2026-07-10.
