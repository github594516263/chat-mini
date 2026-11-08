import type { ResolvedModel } from "@/lib/models";
import type { ChatProvider } from "@/lib/providers/base";
import { openAICompatibleProvider } from "@/lib/providers/openai-compatible";

/**
 * 把「解析后的模型」变成一条可执行的 provider。
 *
 *   live → 用这家 provider 的 key / 地址 / upstream 模型名发真请求
 *   off  → 这家没配 key。调用方应该在进入这里之前就拒绝（400）；
 *          这里直接抛错，绝不静默退回假流 —— 那会让用户以为自己在用真模型。
 */
export function providerForModel(model: ResolvedModel, reasoningEffort?: string | null): ChatProvider {
  if (model.status === "live" && model.endpoint) {
    return openAICompatibleProvider({
      apiKey: model.apiKey,
      endpoint: model.endpoint,
      model: model.definition.upstream,
      maxTokens: model.maxOutputTokens ?? null,
      reasoningEffort: reasoningEffort ?? null,
      label: model.provider.label,
    });
  }
  throw new Error(`${model.provider.label} 还没有配置`);
}
