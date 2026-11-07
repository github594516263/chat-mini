import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { startGeneration, type GenerationOp } from "@/lib/chat-service";
import { isSameOrigin } from "@/lib/http";
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
 * 两种调用方式：
 *   登录用户：{ sessionId, content }   —— 服务端取历史、写消息、流式落盘
 *   游客    ：{ messages: [...] }      —— 只生成，不写库（数据在浏览器本地）
 */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const body = (raw ?? {}) as {
    sessionId?: unknown;
    content?: unknown;
    kind?: unknown;
    messageId?: unknown;
    messages?: unknown;
  };
  const user = await getCurrentUser();

  // ---------- 登录用户：服务端持久化路径 ----------
  if (user && typeof body.sessionId === "string" && body.sessionId) {
    if (!isSameOrigin(request)) {
      return Response.json({ error: "跨站请求被拒绝" }, { status: 403 });
    }

    const sessionId = body.sessionId;
    const kind = typeof body.kind === "string" ? body.kind : "send";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const messageId = typeof body.messageId === "string" ? body.messageId : "";

    let op: GenerationOp;
    if (kind === "send") {
      if (!content) return Response.json({ error: "content is required" }, { status: 400 });
      op = { kind: "send", content };
    } else if (kind === "regenerate") {
      if (!messageId) return Response.json({ error: "messageId is required" }, { status: 400 });
      op = { kind: "regenerate", messageId };
    } else if (kind === "edit") {
      if (!messageId || !content) {
        return Response.json({ error: "messageId and content are required" }, { status: 400 });
      }
      op = { kind: "edit", messageId, content };
    } else if (kind === "continue") {
      if (!messageId) return Response.json({ error: "messageId is required" }, { status: 400 });
      op = { kind: "continue", messageId };
    } else {
      return Response.json({ error: `unknown kind: ${kind}` }, { status: 400 });
    }

    const result = await startGeneration(user.id, sessionId, op);
    if (!result.ok) {
      return Response.json(
        { error: result.message, ...(result.hint ? { hint: result.hint } : {}) },
        { status: result.status },
      );
    }

    return Response.json({
      runId: result.runId,
      afterSeq: 0,
      mode: "server",
      session: result.session,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
    });
  }

  // ---------- 游客路径（也兼容 P5 之前的旧前端） ----------
  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) {
    return Response.json(
      { error: "messages is required", hint: "登录用户请传 { sessionId, content }" },
      { status: 400 },
    );
  }

  const run = createRun();
  // 故意不 await：生成跑在后台，POST 只负责把 runId 交出去
  void driveEphemeral(pickProvider(), run, messages);

  return Response.json({ runId: run.id, afterSeq: 0, mode: "guest" });
}

function pickProvider(): ChatProvider {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  return apiKey ? deepseekProvider({ apiKey }) : fakeProvider;
}

/** 游客：把 provider 的事件流按 seq 记进 run，并推给所有订阅者（不落库） */
async function driveEphemeral(
  provider: ChatProvider,
  run: Run,
  messages: WireMessage[],
): Promise<void> {
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
