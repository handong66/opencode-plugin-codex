import { describe, expect, test } from "vitest";
import {
  buildFinalAnswerArgs,
  readStreamProgress,
  FINAL_ANSWER_PROMPT
} from "../plugins/opencode-plugin-codex/src/job-finalize.js";

describe("buildFinalAnswerArgs", () => {
  test("continues the session the run already opened", () => {
    const args = buildFinalAnswerArgs(["run", "--format", "json", "--dir", "/repo"], "ses_budget");

    expect(args).toEqual(["run", "--format", "json", "--dir", "/repo", "--session", "ses_budget"]);
  });

  test("replaces a stale session and never forks", () => {
    // Forking would strand the work in a branch the caller has no handle for.
    const args = buildFinalAnswerArgs(
      ["run", "--format", "json", "--session", "ses_old", "--fork", "--dir", "/repo"],
      "ses_live"
    );

    expect(args).not.toContain("--fork");
    expect(args.filter((arg) => arg === "--session")).toHaveLength(1);
    expect(args[args.length - 1]).toBe("ses_live");
  });

  test("keeps the model and permission flags the caller chose", () => {
    const args = buildFinalAnswerArgs(
      ["run", "--format", "json", "--model", "aihubmix/deepseek-v4", "--auto", "--dir", "/repo"],
      "ses_keep"
    );

    expect(args).toContain("--model");
    expect(args).toContain("aihubmix/deepseek-v4");
    expect(args).toContain("--auto");
  });
});

describe("readStreamProgress", () => {
  test("counts tool calls and picks up the session id", () => {
    expect(
      readStreamProgress(
        JSON.stringify({ type: "tool_use", sessionID: "ses_a", part: { type: "tool", tool: "read" } })
      )
    ).toEqual({ toolCalls: 1, sessionId: "ses_a" });
  });

  test("ignores text and malformed lines", () => {
    expect(readStreamProgress(JSON.stringify({ type: "text", part: { type: "text", text: "hi" } }))).toEqual({
      toolCalls: 0,
      sessionId: undefined
    });
    expect(readStreamProgress('{"type":"tool_use"')).toEqual({ toolCalls: 0 });
    expect(readStreamProgress("")).toEqual({ toolCalls: 0 });
  });
});

describe("final answer prompt", () => {
  test("asks for the answer instead of more investigation", () => {
    expect(FINAL_ANSWER_PROMPT).toMatch(/final answer now/i);
    expect(FINAL_ANSWER_PROMPT).toMatch(/no further tool calls|not make any further tool calls/i);
    expect(FINAL_ANSWER_PROMPT).toMatch(/did not get to inspect/i);
  });
});
