import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type { GenerationRequest } from "../types";

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

  protected override extraHeaders(_apiKey: string, request?: GenerationRequest): Record<string, string> {
    const headers: Record<string, string> = {};
    if (request?.chatId) {
      headers["x-opencode-session"] = request.chatId;
    }
    return headers;
  }
}
