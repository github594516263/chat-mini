import type { ChatProvider } from "@/lib/providers/base";

/**
 * 所有 OpenAI 兼容网关共用这一份实现：DeepSeek 官方、星链、DevPoolAi、肥猫005
 * 都是 POST /chat/completions + SSE，区别只有地址、key 和模型名。
 *
 * 把「协议翻译」收在一个文件里，新增一家 provider 只需要在 models.ts 里加三行配置，
 * 不用复制一遍 SSE 解析。
 */

type CompatibleChunk = {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

export type OpenAICompatibleOptions = {
  /** null = 这个端点不需要 Authorization（本地/内网无鉴权网关） */
  apiKey: string | null;
  /** 完整地址，已经补到 /chat/completions */
  endpoint: string;
  model: string;
  /** 单次输出上限；null/undefined 时不发 max_tokens */
  maxTokens?: number | null;
  /** 推理档位的上游参数值；null/undefined 时不发 reasoning_effort */
  reasoningEffort?: string | null;
  /** 出错时告诉用户是哪一家，而不是笼统的 "请求失败" */
  label: string;
};

export function openAICompatibleProvider(options: OpenAICompatibleOptions): ChatProvider {
  const { apiKey, endpoint, model, maxTokens, reasoningEffort, label } = options;

  return async function* ({ messages, signal }) {
    let response: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
        signal,
      });
    } catch (error) {
      // 用户点「停止」也会让 fetch reject；这不是错误，按 aborted 正常收尾
      if (signal.aborted) {
        yield { type: "completed", finish_reason: "aborted" };
        return;
      }
      yield { type: "error", message: `连接 ${label} 失败：${(error as Error).message}` };
      return;
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      const hint =
        response.status === 401 || response.status === 403
          ? `（${label} 的 key 无效或无权访问该模型；中转站还要确认 base URL 配对）`
          : "";
      yield {
        type: "error",
        message: `${endpoint} 返回 ${response.status}${hint}：${detail.slice(0, 300) || "(无响应体)"}`,
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
    let finishReason: "stop" | "length" = "stop";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");

          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let chunk: CompatibleChunk;
          try {
            chunk = JSON.parse(payload) as CompatibleChunk;
          } catch {
            continue;
          }

          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens ?? 0,
              completion_tokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          const choice = chunk.choices?.[0];
          if (choice?.finish_reason === "length") finishReason = "length";

          const reasoning = choice?.delta?.reasoning_content;
          if (typeof reasoning === "string" && reasoning) {
            yield { type: "think_delta", delta: reasoning };
          }

          const content = choice?.delta?.content;
          if (typeof content === "string" && content) {
            yield { type: "delta", delta: content };
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        yield { type: "error", message: `读取 ${label} 的流失败：${(error as Error).message}` };
        return;
      }
    }

    if (usage) yield { type: "usage", ...usage };
    yield {
      type: "completed",
      finish_reason: signal.aborted ? "aborted" : finishReason,
    };
  };
}
