# Failure routing and polling contract (0.2.1)

This file ships with the plugin, so it is version-bound to the code that implements
it. It carries only contract facts: which code means what, which field is the
answer, and how to wait. The orchestration workflow — how to write a packet, when to
ask for a second review, how to run a handoff — lives in the Codex
`codex-opencode-collaboration` Skill, not here.

`test/skill-contract.test.ts` fails the build when a code or field named here no
longer exists in `plugins/opencode-plugin-codex/src`, **and** when `src` learns a
code this table does not list. That test is the whole point of vendoring this file:
the previous release had no way to notice that its declared authority had drifted
away from the code, in either direction.

## Every response

```
{ ok, error?: { code, message, retryable, details? }, warnings: [], data }
```

`data` holds the payload. Small scalars (`terminal`, `nextAction`, `waited`,
`resumable`, `openCodeSessionId`, `errorClass`, `exitCode`, `maxChars`,
`maxCharsClamped`, `view`, `modelSelection`, `background`) are mirrored at the top
level for the 0.2 transition; bulk fields are not.

## Boundary refusals

Returned, never thrown. All are `retryable: false` except `cli_probe_timeout`.

| `code` | What to do |
| --- | --- |
| `workspace_unavailable` | No usable workspace root. `opencode_check` still returns CLI and model diagnostics; execution tools stay refused. Do not fall back to a raw CLI call. |
| `workspace_out_of_bounds` | The message lists the roots that are available. A new worktree is rejected until it is added to the Codex workspace. |
| `file_attachment_invalid` | Attachments must resolve inside `cwd`. Copy the file in, or inline its contents in `prompt`. |
| `private_path_blocked` | The prompt referenced a Codex private path. `details.hits` gives the offset and a masked preview; edit that span. |
| `rollout_invalid` | The rollout file is missing, not JSONL, or outside the allowed roots. |
| `state_write_failed` | The plugin's own state directory could not be written. The message names the directory and errno. |
| `cli_not_found` | OpenCode was not found. The message lists what was tried and why each failed. |
| `cli_probe_timeout` | A candidate binary existed but never answered `--version`. Retryable. |
| `job_not_found` | No record under that job id: it belongs to another machine or state directory, or it is gone. Stop polling it. `opencode_sessions` lists sessions this workspace can resume with `opencode_continue`. |
| `model_not_found` | Also raised before submission when an explicit provider id differs only in case from an enumerated lowercase id. |

## Workspace-source diagnostic codes

These values occur only in `opencode_check.data.workspaceSources.rootsList.errorCode`;
they are not envelope errors and do not make `opencode_check.ok` false. The diagnostic
contains no URI, path, raw metadata, or client error message.

| `errorCode` | Meaning |
| --- | --- |
| `method_not_found` | The client did not implement `roots/list`; `supported` is false unless it advertised the capability anyway. |
| `request_timeout` | The `roots/list` request did not answer before the MCP SDK deadline. |
| `parse_error` | The client returned malformed JSON-RPC data. |
| `invalid_request` | The client rejected the roots request as invalid. |
| `invalid_params` | The client rejected the roots request parameters. |
| `internal_error` | The client reported an internal roots-handler failure. |
| `request_failed` | The roots request failed without a recognized MCP error code. |
| `invalid_root_uri` | A returned root was not a usable local file URL. |
| `unsupported_root_protocol` | A returned root used a protocol other than `file:`. |
| `provider_failed` | The installed server-side roots provider threw before returning its structured diagnostic. |

## Job failure classes

`errorClass` on the record, and `error.code` on `opencode_status` / `opencode_result`
/ `opencode_cancel` for a terminal failure.

| `errorClass` | Retryable | Route |
| --- | --- | --- |
| `timeout` | yes | A spent budget, not an error. With tool calls: resume the session with `opencode_continue` and a larger `timeoutMs`. With **zero** tool calls: treat as a provider or model hang, not a budget problem. |
| `stalled` | yes | The run produced almost nothing and then went silent. Retry with a lighter explicit model, or check provider, credentials and proxy. A larger budget repeats it. |
| `quota_exhausted` | no | Switch provider or account. Do not retry. |
| `auth_required` | no | Sign in or fix credentials first. |
| `model_unauthorized` | no | The account may not use that model. Choose another. |
| `model_not_found` | no | Check the provider/model spelling; the provider's own suggestion is passed through. |
| `rate_limited` | yes | Retry after the provider's limit resets. |
| `network_error` | yes | Check network, proxy and certificates. |
| `terminated` | yes | Something outside OpenCode ended it. |
| `opencode_failed` | yes | Generic non-zero exit; read `errorMessage`. |
| `worker_unavailable` | yes | The background worker died without a terminal record. |
| `worker_error` | yes | The worker itself threw — its own state write or log flush failed, not OpenCode. `errorMessage` carries the exception. Resubmit; if it repeats, run `opencode_check` for the state directory. |
| `spawn_error` / `stdin_error` | yes | The process could not start, or the prompt was not delivered. |
| `unknown` | yes | Wording the table did not recognise; the provider's full message is in `errorMessage`. |
| `cancelled` | yes | `opencode_cancel` was called. Partial logs only. |

## Tool refusals

One tool's own failure, in the same envelope. These never appear as `errorClass`.

| `code` | Retryable | Where | What to do |
| --- | --- | --- | --- |
| `provider_listing_failed` | yes | `opencode_check` | `opencode providers list` / `models <provider>` exited non-zero. The CLI's own text is in the message — `Provider not found: AIHubMix` means the provider id is wrong, not that the check failed. Never wrapped in `ok: true` any more. |
| `session_listing_failed` | yes | `opencode_sessions` | `opencode session list` exited non-zero or returned unparseable JSON. Check the CLI with `opencode_check` before retrying. |
| `codex_thread_missing` | no | `opencode_transfer` | No Codex rollout JSONL was found. Pass `rolloutFile`, or inline the context in `prompt` instead — usually cheaper than a transfer. |
| `codex_transcript_empty` | no | `opencode_transfer` | The rollout has no visible user/assistant messages. Nothing to transfer. |
| `opencode_model_required` | no | `opencode_transfer` | An imported session file has to name a model and the OpenCode configuration could not be read, or names none at all (no root `model`, no `agent.build`/`agent.plan` model). The message says which. Fix the configuration, or pass `model` for this call only. Every other tool falls back to the configured default. |
| `opencode_import_failed` | yes | `opencode_transfer` | `opencode import` exited non-zero or never confirmed a session id. |
| `opencode_import_verify_failed` | yes | `opencode_transfer` | The session imported but could not be read back, so the id is not trustworthy. Do not continue against it. |

## Which field is the answer

- `outputSummary.finalText` is OpenCode's answer. The stdout tail is evidence.
- `outputSummary.resultComplete === true` is the only "finished" signal.
- A `review` or `adversarial_review` with `toolCallCount === 0` is never complete:
  `evidenceLevel` is `none` and it must not count as a passing vote.
- `permissionDenied` with `deniedPaths` means it could not see what it needed;
  absence of findings there is absence of access.
- `terminalSummary` on the record keeps these facts after the logs are gone.

## Polling

- Prefer one blocking call: `waitMs` on `opencode_status` or `opencode_result`.
  Anything above `240000` is clamped, because the client aborts a call at 300s.
- Without `waitMs`, wait at least the kind's median before the first poll —
  `continue` 60s, `run` 130s, `rescue` 145s, `review` 170s, `adversarial_review`
  225s — then poll every 60s.
- Never call `opencode_status` and `opencode_result` at the same instant:
  `opencode_result` already contains the record.
- `terminal: true` means the record is final; `nextAction` says so. Stop polling.
- Do not cancel before `timeoutMs` unless nothing has arrived for 45s
  (`lastEventAt`) — most recorded cancellations came while the job was on schedule.
