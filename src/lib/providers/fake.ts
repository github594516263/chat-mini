import type { ChatEvent } from "@/lib/protocol";
import { chunkText, sleep, type ChatProvider } from "@/lib/providers/base";

/**
 * 假数据流：不需要任何 key 就能跑，用来验证「协议 + 渲染 + 交互」这条链路。
 * 它刻意在开头吐一段 think_delta，并包含表格 / 代码块 / 引用 / 列表，
 * 这样一眼就能看出 streamdown 有没有正常工作。
 */
export const fakeProvider: ChatProvider = async function* ({ messages, signal }) {
  const prompt = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const shown = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;

  const thinking = [
    "用户发来的是：",
    shown,
    "。当前没有配置 DEEPSEEK_API_KEY，所以走假数据流。",
    "这条回复的目的不是回答问题，而是验证三件事：事件协议能通、流式渲染不闪、停止按钮能真的打断。",
  ].join("");

  for (const piece of chunkText(thinking)) {
    if (signal.aborted) return;
    yield { type: "think_delta", delta: piece };
    await sleep(10, signal);
  }

  const fenced = [
    "```ts",
    "for await (const event of provider({ messages, signal })) {",
    "  emit(event); // → JSON.stringify(event) + \"\\n\"",
    "}",
    "```",
  ].join("\n");

  const body = [
    "### 现在是假数据流",
    "",
    "你刚才说的是：",
    "",
    `> ${shown}`,
    "",
    "这条回复由 `src/lib/providers/fake.ts` 逐段吐出来，走的是和目标站同一套**类型化事件协议**：",
    "",
    "| 事件 | 作用 | 本次是否出现 |",
    "| --- | --- | --- |",
    "| `think_delta` | 思维链增量 | 出现了，就是上面折叠的那块 |",
    "| `delta` | 正文增量 | 正在出现 |",
    "| `usage` | token 用量 | 收尾时出现 |",
    "| `completed` | 正常结束 | 收尾时出现 |",
    "",
    "服务端其实只干一件事：把 provider 吐出的事件按行编码。",
    "",
    fenced,
    "",
    "要接真实模型，把 `DEEPSEEK_API_KEY` 写进 `.env.local` 就行——同一套协议立刻换成真的 token 流，",
    "前端 `useChatStream` 一行都不用改。这就是把协议握在自己手里的好处。",
  ].join("\n");

  for (const piece of chunkText(body)) {
    if (signal.aborted) break;
    yield { type: "delta", delta: piece };
    await sleep(16, signal);
  }

  if (!signal.aborted) {
    yield {
      type: "usage",
      prompt_tokens: Math.max(1, Math.round(prompt.length / 1.6)),
      completion_tokens: Math.max(1, Math.round((thinking.length + body.length) / 1.6)),
    };
  }

  yield { type: "completed", finish_reason: signal.aborted ? "aborted" : "stop" };
};

export type { ChatEvent };
