import type { NextRequest } from "next/server";

import { sanitizeMessages, type ChatEvent, type WireMessage } from "@/lib/protocol";
import { deepseekProvider } from "@/lib/providers/deepseek";
import { fakeProvider } from "@/lib/providers/fake";
import type { ChatProvider } from "@/lib/providers/base";
import { appendEvent, createRun, finishRun, type Run } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 建一个 run 并立刻返回 runId，生成在服务端后台继续跑。
 * 真正的读取入口是 GET /api/chat/stream?runId=&afterSeq=
 *
 * 这样刷新/断网只影响"订阅"，不影响"生成"，回来带上 afterSeq 就能接着续。
 */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const messages = sanitizeMessages((raw as { messages?: unknown } | null)?.messages);
  if (messages.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const provider = apiKey ? deepseekProvider({ apiKey }) : fakeProvider;

  const run = createRun();
  // 故意不 await：生成跑在后台，POST 只负责把 runId 交出去
  void drive(provider, run, messages);

  return Response.json({ runId: run.id, afterSeq: 0 });
}

/** 把 provider 的事件流按 seq 记进 run，并推给所有订阅者 */
async function drive(provider: ChatProvider, run: Run, messages: WireMessage[]): Promise<void> {
  let seq = 0;
  const emit = (event: ChatEvent) => {
    appendEvent(run, { ...event, seq: ++seq });
  };

  try {
    for await (const event of provider({ messages, signal: run.abort.signal })) {
      emit(event);
    }
    finishRun(run, "done");
  } catch (error) {
    if (run.abort.signal.aborted) {
      emit({ type: "completed", finish_reason: "aborted" });
      finishRun(run, "aborted");
    } else {
      emit({ type: "error", message: (error as Error).message || "stream failed" });
      finishRun(run, "error");
    }
  }
}
