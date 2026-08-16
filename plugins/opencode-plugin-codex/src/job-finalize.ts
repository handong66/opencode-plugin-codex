import { classifyOpenCodeFailure, detectOpenCodeJsonlError } from "./opencode-cli.js";
import { summarizeOpenCodeOutput, type JobRecord } from "./job-store.js";

export type JobOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export type FinalizeJobParams = {
  record: JobRecord;
  stdout: string;
  stderr: string;
  outcome: JobOutcome;
  timedOut: boolean;
  cancelRequested: boolean;
  stdinError?: Error;
  outputTruncated?: boolean;
  finishedAt?: string;
};

/**
 * Decide the terminal shape of a job record.
 *
 * This runs once, at the end of the job, when the whole stream is already in
 * memory. It is deliberately not an incremental hot-path parser: a partially
 * written JSONL line during streaming cannot be parsed, while at this point every
 * line is complete.
 */
export function finalizeJobRecord(params: FinalizeJobParams): JobRecord {
  const { record, stdout, stderr, outcome } = params;
  const latest: JobRecord = { ...record };
  latest.exitCode = outcome.exitCode;
  latest.signal = outcome.signal;
  if (params.outputTruncated !== undefined) latest.outputTruncated = params.outputTruncated;
  latest.finishedAt = params.finishedAt ?? new Date().toISOString();

  // One parse for the whole job: the session handle and the event count both come
  // from it. Before this, a run that timed out kept no handle at all, because
  // opencodeSessionId was only ever copied from the caller's arguments.
  const summary = summarizeOpenCodeOutput(latest, stdout, stderr);
  latest.opencodeSessionId ??= summary.openCodeSessionId;
  const eventCount = Object.values(summary.eventCounts).reduce((total, count) => total + count, 0);

  if (latest.status === "cancelled" || latest.cancelRequestedAt || params.cancelRequested) {
    latest.status = "cancelled";
    return latest;
  }

  if (params.timedOut) {
    latest.status = "failed";
    latest.errorClass = "timeout";
    latest.resumable = Boolean(latest.opencodeSessionId);
    latest.errorMessage = latest.opencodeSessionId
      ? `OpenCode exceeded timeoutMs=${latest.timeoutMs} after producing ${eventCount} events. ` +
        `The OpenCode session ${latest.opencodeSessionId} is still resumable.`
      : `OpenCode exceeded timeoutMs=${latest.timeoutMs} after producing ${eventCount} events, ` +
        "and no OpenCode session id was observed in its output, so the work cannot be resumed.";
    return latest;
  }

  if (outcome.error) {
    latest.status = "failed";
    latest.errorClass = "spawn_error";
    latest.errorMessage = outcome.error.message;
    return latest;
  }

  if (params.stdinError) {
    latest.status = "failed";
    latest.errorClass = "stdin_error";
    latest.errorMessage = `OpenCode did not accept the complete prompt on stdin: ${params.stdinError.message}`;
    return latest;
  }

  const structuredError = detectOpenCodeJsonlError(stdout, stderr);
  if (structuredError) {
    latest.status = "failed";
    latest.errorClass = structuredError.errorClass;
    latest.errorMessage = structuredError.message;
    return latest;
  }

  latest.status = outcome.exitCode === 0 ? "succeeded" : "failed";
  if (latest.status === "failed") {
    latest.errorClass = classifyOpenCodeFailure({
      command: latest.command,
      args: latest.args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      durationMs: Date.now() - Date.parse(latest.startedAt ?? latest.createdAt)
    });
  }
  return latest;
}
