import { describe, expect, test } from "vitest";
import {
  classifyOpenCodeFailure,
  detectOpenCodeJsonlError,
  isRetryableOpenCodeFailure
} from "../plugins/opencode-plugin-codex/src/opencode-cli.js";
import { summarizeOpenCodeOutput } from "../plugins/opencode-plugin-codex/src/job-store.js";
import type { ProcessResult } from "../plugins/opencode-plugin-codex/src/types.js";

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: "opencode",
    args: ["run", "--format", "json"],
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1_000,
    ...overrides
  };
}

/** The shape OpenCode actually emits on a provider failure. */
function apiErrorLine(data: Record<string, unknown>, name = "APIError"): string {
  return JSON.stringify({ type: "error", sessionID: "ses_probe", error: { name, data } });
}

describe("classification channels", () => {
  test("never classifies model output prose as an error channel", () => {
    // stdout is the model talking. A review that discusses a 403 is not a 403.
    const result = processResult({
      exitCode: 1,
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "ses_prose" }),
        JSON.stringify({
          type: "text",
          part: { type: "text", text: "The handler returns 403 Forbidden when the caller is unauthorized." }
        })
      ].join("\n")
    });

    expect(classifyOpenCodeFailure(result)).toBe("opencode_failed");
  });

  test("a terminating signal is never an authorization verdict", () => {
    const result = processResult({
      exitCode: null,
      signal: "SIGTERM",
      stdout: JSON.stringify({ type: "text", part: { type: "text", text: "unauthorized access is forbidden" } })
    });

    expect(classifyOpenCodeFailure(result)).toBe("terminated");
  });

  test("timeout wins over every other channel", () => {
    expect(classifyOpenCodeFailure(processResult({ timedOut: true, signal: "SIGKILL" }))).toBe("timeout");
  });

  test("the word timeout in an error stream is not a network error", () => {
    // The old table mapped any "timeout" substring to network_error, so a spent
    // budget and a DNS failure were reported as the same recoverable thing.
    const result = processResult({ stderr: "opencode: request timeout while waiting for the model\n" });

    expect(classifyOpenCodeFailure(result)).toBe("opencode_failed");
  });

  test("real transport failures are still network errors", () => {
    expect(classifyOpenCodeFailure(processResult({ stderr: "connect ECONNREFUSED 127.0.0.1:7897" }))).toBe(
      "network_error"
    );
  });

  test("a clean exit with nothing on any error channel is unknown, not a failure verdict", () => {
    expect(classifyOpenCodeFailure(processResult({ exitCode: 0 }))).toBe("unknown");
  });
});

describe("structured provider errors", () => {
  test("branches on statusCode instead of guessing from wording", () => {
    const cases: Array<[number, string]> = [
      [401, "auth_required"],
      [402, "quota_exhausted"],
      [403, "model_unauthorized"],
      [404, "model_not_found"],
      [429, "rate_limited"]
    ];

    for (const [statusCode, errorClass] of cases) {
      const detected = detectOpenCodeJsonlError(
        apiErrorLine({ message: "provider said something", statusCode })
      );
      expect(detected?.errorClass, `statusCode ${statusCode}`).toBe(errorClass);
      expect(detected?.details?.statusCode, `statusCode ${statusCode}`).toBe(statusCode);
    }
  });

  test("separates an exhausted balance from an unauthorized model", () => {
    // 9 of the 23 recorded model_unauthorized jobs were actually out of quota, and
    // the orchestrator kept retrying because the class said it was worth retrying.
    const detected = detectOpenCodeJsonlError(
      apiErrorLine({ message: "402 Payment Required: balance exhausted for this account" })
    );

    expect(detected?.errorClass).toBe("quota_exhausted");
    expect(isRetryableOpenCodeFailure("quota_exhausted")).toBe(false);
  });

  test("passes OpenCode's own provider suggestion through untouched", () => {
    const detected = detectOpenCodeJsonlError(
      apiErrorLine({
        message: "Model not found: AIHubMix/deep-deepseek-v4-pro. Did you mean: aihubmix?",
        statusCode: 404
      })
    );

    expect(detected?.errorClass).toBe("model_not_found");
    expect(detected?.message).toContain("Did you mean: aihubmix?");
    expect(detected?.details?.providerMessage).toContain("AIHubMix/deep-deepseek-v4-pro");
  });

  test("degrades unfamiliar wording to unknown with the full text instead of misfiling it", () => {
    const detected = detectOpenCodeJsonlError(apiErrorLine({ message: "Unexpected server error" }));

    expect(detected?.errorClass).toBe("unknown");
    expect(detected?.message).toBe("Unexpected server error");
  });

  test("keeps the provider name and raw payload for the caller", () => {
    const detected = detectOpenCodeJsonlError(apiErrorLine({ message: "nope", statusCode: 403 }, "ProviderError"));

    expect(detected?.details?.name).toBe("ProviderError");
    expect(detected?.details?.raw).toMatchObject({ name: "ProviderError" });
  });

  test('treats a literal "error": null as no error', () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_null", error: null }),
      JSON.stringify({ type: "text", error: null, part: { type: "text", text: "still fine" } })
    ].join("\n");

    expect(detectOpenCodeJsonlError(stdout)).toBeNull();
  });

  test("still reports a bare string error event", () => {
    const detected = detectOpenCodeJsonlError(JSON.stringify({ type: "error", error: "403 Forbidden" }));

    expect(detected?.errorClass).toBe("model_unauthorized");
    expect(detected?.message).toBe("403 Forbidden");
  });
});

describe("guidance for a non-retryable provider failure", () => {
  test("tells the caller to route elsewhere instead of rerunning a narrower prompt", () => {
    const summary = summarizeOpenCodeOutput(
      {
        id: "job_quota_guidance",
        kind: "run",
        status: "failed",
        cwd: "/tmp/workspace",
        command: "opencode",
        args: [],
        createdAt: "2026-08-15T00:00:00.000Z",
        timeoutMs: 600_000,
        errorClass: "quota_exhausted",
        stdoutPath: "",
        stderrPath: ""
      },
      "",
      "402 Payment Required\n"
    );

    expect(summary.guidance).toMatch(/quota is exhausted/i);
    expect(summary.guidance).toMatch(/do not retry/i);
    expect(summary.guidance).not.toMatch(/narrower prompt/i);
  });
});

describe("retryability", () => {
  test("routes the orchestrator away from retrying what cannot succeed", () => {
    for (const code of ["quota_exhausted", "auth_required", "model_unauthorized", "model_not_found"]) {
      expect(isRetryableOpenCodeFailure(code), code).toBe(false);
    }
    for (const code of ["timeout", "terminated", "network_error", "rate_limited", "opencode_failed", "unknown"]) {
      expect(isRetryableOpenCodeFailure(code), code).toBe(true);
    }
  });
});
