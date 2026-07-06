import { describe, expect, test } from "vitest";
import { toOpenCodeSession } from "../plugins/opencode-plugin-codex/src/opencode-session.js";

describe("toOpenCodeSession", () => {
  test("creates importable OpenCode session JSON with linked text parts", () => {
    const session = toOpenCodeSession(
      [
        { role: "user", text: "Build the plugin." },
        { role: "assistant", text: "I will inspect the repository." }
      ],
      {
        idSuffix: "test",
        cwd: "/repo",
        title: "Codex transfer test",
        model: "example/example-model",
        now: 1782589587543
      }
    );

    expect(session.info.id).toBe("ses_codex_transfer_test");
    expect(session.info.model).toEqual({
      providerID: "example",
      id: "example-model",
      variant: "default"
    });
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].info.role).toBe("user");
    expect(session.messages[1].info.parentID).toBe(session.messages[0].info.id);
    expect(session.messages[0].parts[0]).toMatchObject({
      type: "text",
      text: "Build the plugin.",
      sessionID: "ses_codex_transfer_test",
      messageID: session.messages[0].info.id
    });
  });

  test("prepends a user bootstrap when truncated transcript starts with assistant", () => {
    const session = toOpenCodeSession(
      [{ role: "assistant", text: "I already inspected the repository." }],
      {
        idSuffix: "assistant_first",
        cwd: "/repo",
        model: "example/example-model",
        now: 1782589587543
      }
    );

    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].info.role).toBe("user");
    expect(session.messages[1].info.role).toBe("assistant");
    expect(session.messages[1].info.parentID).toBe(session.messages[0].info.id);
  });
});
