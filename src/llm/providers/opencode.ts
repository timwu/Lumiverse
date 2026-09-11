import { createHash, randomUUID } from "node:crypto";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type { GenerationRequest, LlmMessagePart } from "../types";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deterministically maps an arbitrary string to an RFC 4122 v5 UUID.
 */
export function stringToUuidV5(
  name: string,
  namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1")
    .update(Buffer.concat([nsBytes, nameBytes]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function extractMessageText(
  content: string | LlmMessagePart[] | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if ("text" in part && typeof part.text === "string") return part.text;
          if ("content" in part && typeof part.content === "string")
            return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Resolves a valid UUID for the OpenCode Go `x-opencode-session` header.
 *
 * 1. If an explicit `chatId` is given:
 *    - If already a valid UUID, returns it normalized to lowercase.
 *    - Otherwise, derives a deterministic RFC 4122 v5 UUID from the chatId string.
 * 2. If `chatId` is missing (e.g. extension/quiet generation calls):
 *    - Derives a deterministic RFC 4122 v5 UUID from the root prompt of the
 *      conversation (first user message or first message). Because multi-turn
 *      agent sessions preserve the conversation prefix, this keeps the session UUID
 *      stable across turns for prompt caching.
 * 3. If no messages or content exist, falls back to a fresh random UUID v4.
 */
export function resolveOpenCodeSessionId(
  request?: GenerationRequest,
): string {
  const chatId = request?.chatId?.trim();
  if (chatId) {
    if (UUID_REGEX.test(chatId)) {
      return chatId.toLowerCase();
    }
    return stringToUuidV5(`lumiverse:chat:${chatId}`);
  }

  const messages = request?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const userMsg = messages.find((m) => m.role === "user");
    let text = extractMessageText(userMsg?.content).trim();
    if (!text) {
      const firstMsg = messages[0];
      text = extractMessageText(firstMsg?.content).trim();
      if (!text && firstMsg?.content) {
        try {
          text = JSON.stringify(firstMsg.content);
        } catch {
          text = "";
        }
      }
    }
    if (text) {
      return stringToUuidV5(
        `lumiverse:opencode:conversation:${text.slice(0, 8192)}`,
      );
    }
  }

  return randomUUID();
}

export class OpenCodeProvider extends OpenAICompatibleProvider {
  readonly name = "opencode";
  readonly displayName = "OpenCode Go";
  readonly defaultUrl = "https://opencode.ai/zen/go/v1";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
      frequency_penalty: COMMON_PARAMS.frequency_penalty,
      presence_penalty: COMMON_PARAMS.presence_penalty,
      stop: COMMON_PARAMS.stop,
      min_p: COMMON_PARAMS.min_p,
      repetition_penalty: COMMON_PARAMS.repetition_penalty,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "openai",
  };

  protected override extraHeaders(
    _apiKey: string,
    request?: GenerationRequest,
  ): Record<string, string> {
    return {
      "x-opencode-session": resolveOpenCodeSessionId(request),
    };
  }
}
