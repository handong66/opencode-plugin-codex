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
  | "state_write_failed";

/** None of these succeed on a retry of the same call; each needs a different input. */
const BOUNDARY_RETRYABLE: Record<BoundaryErrorCode, boolean> = {
  workspace_unavailable: false,
  workspace_out_of_bounds: false,
  file_attachment_invalid: false,
  private_path_blocked: false,
  rollout_invalid: false,
  state_write_failed: false
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

/**
 * The sentence that resolves three of the four recorded out-of-bounds refusals: all
 * three named a `.worktrees/...` directory that started running jobs normally the
 * next day, once Codex's per-call workspace metadata caught up with it.
 */
export const WORKSPACE_ROOTS_EXPLANATION =
  "These are the per-call Codex workspace roots. A newly created worktree is rejected until it is added to the " +
  "Codex workspace, so add it there (or pass a cwd inside an existing root) rather than working around this.";

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
