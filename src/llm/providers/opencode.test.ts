import { describe, expect, test } from "bun:test";
import { OpenCodeProvider } from "./opencode";
import { getProvider } from "../registry";

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

  test("attaches x-opencode-session header when chatId is provided in generate", async () => {
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
      const response = await provider.generate("", "", {
        model: "opencode-model",
        messages: [{ role: "user", content: "Hello" }],
        chatId: "chat-session-12345",
      });

      expect(response.content).toBe("Hello from OpenCode");
      expect(capturedHeaders["x-opencode-session"]).toBe("chat-session-12345");
      expect(capturedHeaders["Content-Type"]).toBe("application/json");
      expect(capturedHeaders["Authorization"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("omits x-opencode-session header when chatId is absent in generate", async () => {
    let capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "No session" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    try {
      await provider.generate("", "", {
        model: "opencode-model",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(capturedHeaders["x-opencode-session"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("attaches x-opencode-session header in generateStream", async () => {
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
        chatId: "stream-session-67890",
      })) {
        if (chunk.token) chunks.push(chunk.token);
      }

      expect(chunks.join("")).toBe("Streaming response");
      expect(capturedHeaders["x-opencode-session"]).toBe("stream-session-67890");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
