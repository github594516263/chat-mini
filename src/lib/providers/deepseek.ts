import type { ChatProvider } from "@/lib/providers/base";

/**
 * 兼容官方与各种 OpenAI 兼容中转站：
 *   DEEPSEEK_BASE_URL 不填 → https://api.deepseek.com
 *   填 https://xxx.com          → https://xxx.com/chat/completions
 *   填 https://xxx.com/v1       → https://xxx.com/v1/chat/completions
 *   填 .../chat/completions     → 原样使用
 */
function resolveEndpoint(): string {
  const raw = process.env.DEEPSEEK_BASE_URL?.trim();
  if (!raw) return "https://api.deepseek.com/chat/completions";
  const base = raw.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

type DeepSeekChunk = {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

/**
 * 真数据流：DeepSeek 的 OpenAI 兼容接口，把它的 SSE 增量翻译成我们自己的事件。
 * 这就是「替身 vs 原配」的分界线——协议是我们的，模型是别人的。
 */
export function deepseekProvider(options: {
  apiKey: string;
  model?: string;
}): ChatProvider {
  const model = options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const endpoint = resolveEndpoint();

  return async function* ({ messages, signal }) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      });
    } catch (error) {
      yield { type: "error", message: `连接 DeepSeek 失败：${(error as Error).message}` };
      return;
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      const hint =
        response.status === 401 || response.status === 403
          ? "（key 无效或不属于该服务商；如果你用的是中转站，需要同时设置 DEEPSEEK_BASE_URL）"
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

          let chunk: DeepSeekChunk;
          try {
            chunk = JSON.parse(payload) as DeepSeekChunk;
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
        yield { type: "error", message: `读取流失败：${(error as Error).message}` };
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
