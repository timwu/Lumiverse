import { describe, expect, test } from "bun:test";
import { OpenCodeProvider, resolveOpenCodeSessionId, stringToUuidV5 } from "./opencode";
import { getProvider } from "../registry";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("OpenCodeProvider", () => {
  const provider = new OpenCodeProvider();

  test("is registered in LLM registry under 'opencode'", () => {
    const registered = getProvider("opencode");
    expect(registered).toBeDefined();
    expect(registered?.name).toBe("opencode");
    expect(registered?.displayName).toBe("OpenCode Go");
  });

  test("has expected defaultUrl and capabilities", () => {
    expect(provider.defaultUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(provider.capabilities.apiKeyRequired).toBe(true);
    expect(provider.capabilities.supportsStreaming).toBe(true);
    expect(provider.capabilities.modelListStyle).toBe("openai");
  });

  describe("resolveOpenCodeSessionId", () => {
    test("preserves valid UUID chatId", () => {
      const explicitUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      const resolved = resolveOpenCodeSessionId({
        model: "m",
        messages: [],
        chatId: explicitUuid,
      });
      expect(resolved).toBe(explicitUuid);
      expect(UUID_REGEX.test(resolved)).toBe(true);
    });

    test("maps non-UUID chatId deterministically to UUID v5", () => {
      const chatId = "lumiverse-chat-42";
      const resolved1 = resolveOpenCodeSessionId({
        model: "m",
        messages: [],
        chatId,
      });
      const resolved2 = resolveOpenCodeSessionId({
        model: "m",
        messages: [],
        chatId,
      });
      expect(resolved1).toBe(resolved2);
      expect(UUID_REGEX.test(resolved1)).toBe(true);
      expect(resolved1).toBe(stringToUuidV5(`lumiverse:chat:${chatId}`));
    });

    test("derives stable UUID across multi-turn agent sessions without chatId", () => {
      const initialTurn = [
        { role: "system" as const, content: "You are a helpful assistant." },
        { role: "user" as const, content: "Write a fibonacci function in TS" },
      ];

      const turnTwo = [
        ...initialTurn,
        { role: "assistant" as const, content: "Here is the code..." },
        { role: "user" as const, content: "Tool output: success" },
      ];

      const sessionTurn1 = resolveOpenCodeSessionId({
        model: "m",
        messages: initialTurn,
      });
      const sessionTurn2 = resolveOpenCodeSessionId({
        model: "m",
        messages: turnTwo,
      });

      expect(UUID_REGEX.test(sessionTurn1)).toBe(true);
      expect(UUID_REGEX.test(sessionTurn2)).toBe(true);
      // Both turns of the agent loop have the exact same session UUID
      expect(sessionTurn1).toBe(sessionTurn2);
    });

    test("handles structured message parts for root message", () => {
      const messages = [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Inspect this project" },
          ],
        },
      ];
      const resolved = resolveOpenCodeSessionId({
        model: "m",
        messages,
      });
      expect(UUID_REGEX.test(resolved)).toBe(true);
    });

    test("falls back to a valid random UUID when no messages or chatId exist", () => {
      const resolved = resolveOpenCodeSessionId();
      expect(UUID_REGEX.test(resolved)).toBe(true);

      const resolvedEmpty = resolveOpenCodeSessionId({
        model: "m",
        messages: [],
      });
      expect(UUID_REGEX.test(resolvedEmpty)).toBe(true);
    });
  });

  test("attaches valid x-opencode-session header when chatId is provided in generate", async () => {
    let capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Hello from OpenCode" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    try {
      const explicitUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      const response = await provider.generate("", "", {
        model: "opencode-model",
        messages: [{ role: "user", content: "Hello" }],
        chatId: explicitUuid,
      });

      expect(response.content).toBe("Hello from OpenCode");
      expect(capturedHeaders["x-opencode-session"]).toBe(explicitUuid);
      expect(capturedHeaders["Content-Type"]).toBe("application/json");
      expect(capturedHeaders["Authorization"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("attaches valid x-opencode-session header even when chatId is absent (extension calls)", async () => {
    let capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Agent turn complete" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    try {
      await provider.generate("", "", {
        model: "opencode-model",
        messages: [{ role: "user", content: "Extension task prompt" }],
      });

      const sessionHeader = capturedHeaders["x-opencode-session"];
      expect(sessionHeader).toBeDefined();
      expect(UUID_REGEX.test(sessionHeader)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("attaches valid x-opencode-session header in generateStream", async () => {
    let capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;

    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Streaming "}}]}',
      'data: {"choices":[{"delta":{"content":"response"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join("\n\n") + "\n\n";

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    try {
      const chunks: string[] = [];
      for await (const chunk of provider.generateStream("", "", {
        model: "opencode-model",
        messages: [{ role: "user", content: "Hello" }],
      })) {
        if (chunk.token) chunks.push(chunk.token);
      }

      expect(chunks.join("")).toBe("Streaming response");
      const sessionHeader = capturedHeaders["x-opencode-session"];
      expect(sessionHeader).toBeDefined();
      expect(UUID_REGEX.test(sessionHeader)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
