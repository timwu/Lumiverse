import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as chats from "./chats.service";
import * as connections from "./connections.service";
import * as secrets from "./secrets.service";
import * as pool from "./generation-pool.service";
import * as presets from "./presets.service";
import { startGeneration, stopAllGenerations, stopGenerationSweep } from "./generate.service";

const userId = "provider-outcomes-test";
const ended: any[] = [];
const metricsReady: any[] = [];
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let secretSpy: ReturnType<typeof spyOn>;
let eventSpy: ReturnType<typeof spyOn>;
beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("test-key");
  eventSpy = spyOn(eventBus, "emit").mockImplementation((type, payload) => {
    if (type === EventType.GENERATION_ENDED) ended.push(payload);
    if (type === EventType.GENERATION_METRICS_READY) metricsReady.push(payload);
  });
});
afterEach(async () => { await Bun.sleep(5); fetchSpy?.mockRestore(); });
afterAll(() => {
  stopAllGenerations(); stopGenerationSweep(); pool.stopPoolSweep(); pool.clearAllPoolEntries();
  secretSpy.mockRestore(); eventSpy.mockRestore(); closeDatabase();
});

async function run(provider: string, body: object[], options: { responses?: boolean; nonStreaming?: boolean; presetName?: string } = {}) {
  const connection = await connections.createConnection(userId, {
    name: "Mock", provider, model: "test-model", api_url: "https://example.test",
  });
  const preset = options.presetName
    ? presets.createPreset(userId, {
        name: options.presetName,
        provider,
        prompt_order: [],
      })
    : null;
  const chat = chats.createChat(userId, {
    character_id: null,
    name: "Test",
    metadata: { temporary: true, ...(preset ? {} : { no_preset: true }) },
  });
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello." }, userId);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => options.nonStreaming
    ? Response.json(body[0])
    : new Response(body.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""))) as unknown as typeof fetch);
  const result = await startGeneration({
    userId, chat_id: chat.id, connection_id: connection.id, generation_type: "normal",
    ...(preset ? { preset_id: preset.id } : {}),
    parameters: { ...(options.responses ? { use_responses_api: true } : {}), ...(options.nonStreaming ? { _streaming: false } : {}) },
  });
  const deadline = Date.now() + 3000;
  while (!ended.some(e => e.generationId === result.generationId) && Date.now() < deadline) await Bun.sleep(5);
  const event = ended.find(e => e.generationId === result.generationId);
  expect(event).toBeDefined();
  return { event, generationId: result.generationId, preset };
}
const chatThought = { choices: [{ delta: { reasoning_content: "A thought." } }] };
const responseThought = { type: "response.reasoning_summary_text.delta", delta: "A thought." };
const googleThought = { candidates: [{ content: { parts: [{ thought: true, text: "A thought." }] } }] };

const cases = [
  { name: "Chat Completions token limit", provider: "openai", reason: "length", error: "output token limit", body: [chatThought, { choices: [{ delta: {}, finish_reason: "length" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138 } }] },
  { name: "Chat Completions filter", provider: "openai", reason: "content_filter", error: "content filter", body: [chatThought, { choices: [{ delta: { content: "Partial answer." }, finish_reason: "content_filter" }] }] },
  { name: "Responses token limit", provider: "openai", responses: true, reason: "max_output_tokens", error: "output token limit", body: [responseThought, { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }] },
  { name: "Responses failure", provider: "openai", responses: true, reason: "failed", error: "Upstream failed", body: [responseThought, { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "Upstream failed" } } }] },
  { name: "Gemini token limit", provider: "google", reason: "MAX_TOKENS", error: "output token limit", body: [googleThought, { candidates: [{ finishReason: "MAX_TOKENS" }] }] },
  { name: "Gemini filter", provider: "google", reason: "SAFETY", error: "Provider explanation", body: [googleThought, { candidates: [{ content: { parts: [{ text: "Partial answer." }] }, finishReason: "SAFETY", finishMessage: "Provider explanation" }] }] },
  { name: "Gemini tool error", provider: "google", reason: "MALFORMED_FUNCTION_CALL", error: "tool call", body: [googleThought, { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: {} } }] }, finishReason: "MALFORMED_FUNCTION_CALL" }] }] },
];
for (const fixture of cases) {
  test(`${fixture.name} reaches the error UI and saves partial output with diagnostics`, async () => {
    const { event, generationId } = await run(fixture.provider, fixture.body, fixture);
    expect(event.finish_reason).toBe(fixture.reason);
    expect(event.error).toContain(fixture.error);
    expect(event.errorMessage).toBe(event.error);
    expect(event.connectionName).toBe("Mock");
    expect(event.errorCode).toBe(
      fixture.name === "Responses failure" ? "server_error" : fixture.reason,
    );
    expect(pool.getPoolEntry(generationId)?.status).toBe("error");
    const saved = chats.getMessage(userId, event.messageId)!;
    expect(saved.extra.reasoning).toBe("A thought.");
    expect(saved.extra.generationOutcome).toMatchObject({ finish_reason: fixture.reason, error: event.error });
    if (event.stop_details) expect(saved.extra.generationOutcome.stop_details).toEqual(event.stop_details);
    if (fixture.name === "Chat Completions token limit") expect(saved.extra.usage.completion_tokens).toBe(128);
    expect(fetchSpy!.mock.calls).toHaveLength(1);
  });
}
for (const provider of ["openai", "google"]) {
  test(`${provider} non-streaming token limit uses the same error path`, async () => {
    const body = provider === "openai"
      ? { choices: [{ message: { reasoning_content: "A thought." }, finish_reason: "length" }] }
      : { candidates: [{ content: { parts: [{ thought: true, text: "A thought." }] }, finishReason: "MAX_TOKENS" }] };
    const { event } = await run(provider, [body], { nonStreaming: true });
    expect(event.error).toContain("output token limit");
    expect(chats.getMessage(userId, event.messageId)?.extra.reasoning).toBe("A thought.");
  });
}
test("Gemini prompt blocks with no candidate produce a clear error and diagnostics", async () => {
  const { event, generationId } = await run("google", [{ promptFeedback: { blockReason: "SAFETY" } }]);
  expect(event.error).toContain("blocked the prompt");
  expect(event.finish_reason).toBe("SAFETY");
  expect(event.stop_details.type).toBe("blocked_prompt");
  expect(pool.getPoolEntry(generationId)?.status).toBe("error");
});
test("OpenAI refusal fields are surfaced even when finish_reason is stop", async () => {
  const { event } = await run("openai", [{ choices: [{ delta: { refusal: "Cannot answer." }, finish_reason: "stop" }] }]);
  expect(event.error).toContain("Cannot answer.");
  expect(event.finish_reason).toBe("stop");
  expect(event.stop_details.type).toBe("refusal");
  expect(chats.getMessage(userId, event.messageId)?.content).toBe("Cannot answer.");
});
for (const fixture of [
  { provider: "openai", body: [chatThought] },
  { provider: "openai", responses: true, body: [responseThought] },
  { provider: "google", body: [googleThought] },
]) {
  test(`${fixture.provider}${fixture.responses ? " Responses" : ""} EOF after reasoning is an error without replaying the request`, async () => {
    const { event } = await run(fixture.provider, fixture.body, fixture);
    expect(event.error).toContain("terminal response");
    expect(chats.getMessage(userId, event.messageId)?.extra.reasoning).toBe("A thought.");
    expect(fetchSpy!.mock.calls).toHaveLength(1);
  });
}

test("generation metrics retain the preset used for the generated swipe", async () => {
  const { generationId, preset } = await run(
    "openai",
    [{ choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] }],
    { presetName: "Raven" },
  );
  const deadline = Date.now() + 3000;
  while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  const metricsEvent = metricsReady.find((event) => event.generationId === generationId);
  expect(metricsEvent?.generationMetrics).toMatchObject({
    presetId: preset!.id,
    presetName: "Raven",
  });
  expect(chats.getMessage(userId, metricsEvent.messageId)?.extra.generationMetrics).toMatchObject({
    presetId: preset!.id,
    presetName: "Raven",
  });
});
for (const fixture of [
  { provider: "openai", body: [{ choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] }] },
  { provider: "google", body: [{ candidates: [{ content: { parts: [{ text: "Hello." }] }, finishReason: "STOP" }] }] },
]) {
  test(`${fixture.provider} normal stop remains successful`, async () => {
    const { event, generationId } = await run(fixture.provider, fixture.body);
    expect(event.error).toBeUndefined();
    expect(pool.getPoolEntry(generationId)?.status).toBe("completed");
    expect(chats.getMessage(userId, event.messageId)?.content).toBe("Hello.");
  });
}
