import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { startGeneration, type GenerationOp } from "@/lib/chat-service";
import { isSameOrigin } from "@/lib/http";
import { resolveModel, resolveReasoningValue } from "@/lib/models";
import { sanitizeMessages, type ChatEvent, type WireMessage } from "@/lib/protocol";
import { providerForModel } from "@/lib/providers";
import type { ChatProvider } from "@/lib/providers/base";
import { appendEvent, createRun, finishRun, type Run } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 建一个 run 并立刻返回 runId，生成在服务端后台继续跑。
 * 真正的读取入口是 GET /api/chat/stream?runId=&afterSeq=
 *
 * 两种调用方式：
 *   登录用户：{ sessionId, content, model? } —— 服务端取历史、写消息、流式落盘
 *   游客    ：{ messages: [...], model? }    —— 只生成，不写库（数据在浏览器本地）
 *
 * model 只接受公开 id（如 deepseek:v4.1-flash），服务端查目录决定路由。
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
    model?: unknown;
    reasoning?: unknown;
  };
  const user = await getCurrentUser();

  // 只收字符串 id；数字 / 对象一律拒绝，避免"类型不对就悄悄用默认值"
  if (body.model !== undefined && body.model !== null && typeof body.model !== "string") {
    return Response.json({ error: "model 必须是字符串 id" }, { status: 400 });
  }
  const requestedModel = typeof body.model === "string" ? body.model.trim() || null : null;

  if (body.reasoning !== undefined && body.reasoning !== null && typeof body.reasoning !== "string") {
    return Response.json({ error: "reasoning 必须是字符串 id" }, { status: 400 });
  }
  const requestedReasoning = typeof body.reasoning === "string" ? body.reasoning.trim() : null;

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

    const result = await startGeneration(user.id, sessionId, op, requestedModel, requestedReasoning);
    if (!result.ok) {
      return Response.json(
        { error: result.message, ...(result.hint ? { hint: result.hint } : {}) },
        { status: result.status },
      );
    }

    return Response.json({
      runId: result.runId,
      model: result.model,
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

  // 游客也要过服务端目录：客户端只传公开 id，不能自己指定 upstream / 地址
  const model = resolveModel(requestedModel);
  if (!model) {
    return Response.json({ error: "未知模型", hint: "模型 id 不在服务端目录里" }, { status: 400 });
  }
  if (model.status === "off") {
    return Response.json(
      {
        error: `${model.provider.label} 还没有配置`,
        hint: `在 .env.local 里补 ${model.provider.keyEnv} 和 ${model.provider.baseUrlEnv}`,
      },
      { status: 400 },
    );
  }

  const reasoning = resolveReasoningValue(model, requestedReasoning);
  if (!reasoning.ok) {
    return Response.json({ error: reasoning.error }, { status: 400 });
  }

  const run = createRun();
  // 故意不 await：生成跑在后台，POST 只负责把 runId 交出去
  void driveEphemeral(providerForModel(model, reasoning.value), run, messages);

  return Response.json({
    runId: run.id,
    model: model.definition.id,
    afterSeq: 0,
    mode: "guest",
  });
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
    let finishReason: "stop" | "length" = "stop";
    for await (const event of provider({ messages, signal: run.abort.signal })) {
      // 和登录路径同一套规则：error 事件转异常，completed 由这里统一发
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "completed") {
        if (event.finish_reason === "length") finishReason = "length";
        continue;
      }
      emit(event);
    }

    if (run.abort.signal.aborted) {
      emit({ type: "completed", finish_reason: "aborted" });
      finishRun(run, "aborted");
      return;
    }

    emit({ type: "completed", finish_reason: finishReason });
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
