/**
 * Boundary refusals with stable codes.
 *
 * Every boundary rejection used to be a bare `throw new Error(...)`, so 9,892
 * recorded events carried exactly one error code between them. The guards
 * themselves are correct and are not relaxed here — the change is that a refusal
 * now says what it is and what would make it succeed. The attachment message in
 * particular repeated verbatim six times in one month precisely because it never
 * said what a legal value looks like.
 *
 * Codes shared with grok-plugin-codex (`workspace_unavailable`,
 * `private_path_blocked`) are reused verbatim so one orchestrator learns one table.
 */
export type BoundaryErrorCode =
  | "workspace_unavailable"
  | "workspace_out_of_bounds"
  | "file_attachment_invalid"
  | "private_path_blocked"
  | "rollout_invalid"
  | "state_write_failed"
  | "cli_not_found"
  | "cli_probe_timeout"
  | "job_not_found"
  /** Shares the OC-3 errorClass name so one orchestrator learns one table. */
  | "model_not_found";

/**
 * Retrying the same call unchanged: only a probe timeout can plausibly succeed
 * later (a cold binary that answered slowly once may answer in time next call).
 */
const BOUNDARY_RETRYABLE: Record<BoundaryErrorCode, boolean> = {
  workspace_unavailable: false,
  workspace_out_of_bounds: false,
  file_attachment_invalid: false,
  private_path_blocked: false,
  rollout_invalid: false,
  state_write_failed: false,
  cli_not_found: false,
  cli_probe_timeout: true,
  job_not_found: false,
  model_not_found: false
};

export class BoundaryError extends Error {
  readonly code: BoundaryErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: BoundaryErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BoundaryError";
    this.code = code;
    this.retryable = BOUNDARY_RETRYABLE[code];
    this.details = details;
  }
}

export function isBoundaryError(value: unknown): value is BoundaryError {
  return value instanceof BoundaryError;
}

/** The explicit caller cwd is itself a per-call workspace source. */
export const WORKSPACE_ROOTS_EXPLANATION =
  "Pass the target as an explicit absolute cwd to grant that canonical directory for this call, or choose a cwd " +
  "inside one of the available roots. The caller cwd grant is not remembered for later calls.";

export function workspaceOutOfBounds(candidate: string, roots: string[]): BoundaryError {
  return new BoundaryError(
    "workspace_out_of_bounds",
    `Working directory is outside the MCP workspace roots: ${candidate}. ` +
      `Available roots: ${roots.length ? roots.join(", ") : "(none)"}. ${WORKSPACE_ROOTS_EXPLANATION}`,
    { candidate, roots }
  );
}

export function workspaceUnavailable(message: string, details?: Record<string, unknown>): BoundaryError {
  return new BoundaryError("workspace_unavailable", message, details);
}

/**
 * Fail a provider id that differs from the enumerated one only by case.
 *
 * `AIHubMix/deep-deepseek-v4-pro` ran five jobs and succeeded zero times, while
 * `aihubmix/...` ran 62 and succeeded 50. The spelling is never rewritten silently
 * — that was rejected — but spending a whole job to be told
 * `Did you mean: aihubmix?` is worse than saying it here.
 */
export function providerIdCaseMismatch(params: {
  requested: string;
  provider: string;
  knownProvider: string;
  knownProviders: string[];
}): BoundaryError {
  return new BoundaryError(
    "model_not_found",
    `OpenCode has no provider "${params.provider}", but it does have "${params.knownProvider}" — provider ids are ` +
      `case-sensitive. Resubmit with model "${params.requested.replace(params.provider, params.knownProvider)}". ` +
      "The plugin does not rewrite the id for you.",
    { requested: params.requested, provider: params.provider, knownProviders: params.knownProviders }
  );
}

/**
 * No job record under that id.
 *
 * This is the one call a caller makes precisely because it has lost its handle, and
 * it used to answer with Node's raw ENOENT: an MCP exception with no code, no
 * `retryable`, no envelope — and the absolute state path of a private directory in
 * its text, which is the leak `toPublicJob()` exists to prevent everywhere else.
 * The id is the only thing echoed back here.
 */
export function jobNotFound(jobId: string): BoundaryError {
  return new BoundaryError(
    "job_not_found",
    `No OpenCode job record for "${jobId}". Job ids come back from opencode_run / opencode_continue / ` +
      "opencode_review / opencode_adversarial_review / opencode_rescue, and are private to the machine and " +
      "state directory that started them. If the handle is lost, opencode_sessions lists the OpenCode sessions " +
      "this workspace can resume with opencode_continue.",
    { jobId }
  );
}

/**
 * Wrap a filesystem write to the private state directory.
 *
 * One recorded ENOSPC surfaced as a raw errno from `JobStore.write`'s temp file,
 * with no mention of which directory had filled up.
 */
export function stateWriteFailed(error: unknown, stateDir: string): BoundaryError {
  const errno = error as NodeJS.ErrnoException;
  const reason = errno?.code ? `${errno.code}: ${errno.message}` : String(errno?.message ?? error);
  return new BoundaryError(
    "state_write_failed",
    `Could not write the OpenCode job state under ${stateDir} (${reason}). ` +
      "The job record, not OpenCode, is what failed: free space or fix permissions on that directory, then retry. " +
      "Set OPENCODE_PLUGIN_STATE_DIR to move the state elsewhere.",
    { stateDir, errno: errno?.code }
  );
}
