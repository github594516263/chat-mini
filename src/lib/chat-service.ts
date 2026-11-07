import type { ChatEvent } from "@/lib/protocol";
import type { ChatProvider } from "@/lib/providers/base";
import { deepseekProvider } from "@/lib/providers/deepseek";
import { fakeProvider } from "@/lib/providers/fake";
import { appendEvent, createRun, finishRun, type Run } from "@/lib/runs";
import {
  appendMessage,
  createRunRow,
  deriveTitle,
  finishRunRow,
  getSession,
  listHistory,
  renameSession,
  updateMessage,
  type MessageDto,
  type SessionDto,
} from "@/lib/chat-repo";
import { explainDbError } from "@/lib/db";

/**
 * 登录用户的生成：服务端自己取历史、自己写消息。
 *
 * 与游客路径的区别（很重要）：
 *   - 历史从数据库读，不再由前端上传
 *   - 用户消息 + 助手占位消息在开跑前就落库（seq 连续）
 *   - 流式期间按 1 秒节流把半截正文写回库：进程崩了，库里还有已输出的部分
 *   - 结束时定稿状态：complete / stopped / error
 */

/** 半截正文的落盘间隔。太频繁没必要（一秒钟的内容谁也看不出差别），太慢兜不住崩溃 */
const FLUSH_INTERVAL_MS = 1000;

export type StartResult =
  | {
      ok: true;
      runId: string;
      session: SessionDto;
      userMessage: MessageDto;
      assistantMessage: MessageDto;
    }
  | { ok: false; status: number; message: string; hint?: string };

function pickProvider(): ChatProvider {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  return apiKey ? deepseekProvider({ apiKey }) : fakeProvider;
}

export async function startServerRun(
  userId: string,
  sessionId: string,
  content: string,
): Promise<StartResult> {
  const session = await getSession(userId, sessionId);
  if (!session) {
    return { ok: false, status: 404, message: "会话不存在" };
  }

  try {
    const userMessage = await appendMessage(userId, sessionId, {
      role: "user",
      content,
      status: "complete",
    });
    if (!userMessage) return { ok: false, status: 404, message: "会话不存在" };

    // 首条消息自动命名（和前端原来的习惯保持一致）
    const title =
      session.messageCount === 0 && session.title === "新对话" ? deriveTitle(content) : null;
    if (title) await renameSession(userId, sessionId, title);

    // 注意顺序：先落用户消息，再取历史（这样历史里包含这句新问题）
    const history = await listHistory(userId, sessionId);

    const assistantMessage = await appendMessage(userId, sessionId, {
      role: "assistant",
      content: "",
      status: "streaming",
    });
    if (!assistantMessage) return { ok: false, status: 404, message: "会话不存在" };

    const run = createRun({ userId, sessionId, messageId: assistantMessage.id });
    // 落一行元信息：进程重启后靠它把这条消息标成 interrupted
    await createRunRow({
      id: run.id,
      userId,
      sessionId,
      messageId: assistantMessage.id,
    });

    // 故意不 await：POST 只负责把 runId 交出去
    void driveServerRun({
      run,
      userId,
      sessionId,
      messageId: assistantMessage.id,
      history,
    });

    return {
      ok: true,
      runId: run.id,
      session: (await getSession(userId, sessionId)) ?? session,
      userMessage,
      assistantMessage,
    };
  } catch (error) {
    return { ok: false, status: 500, message: "创建生成任务失败", hint: explainDbError(error) };
  }
}

async function driveServerRun(args: {
  run: Run;
  userId: string;
  sessionId: string;
  messageId: string;
  history: { role: "user" | "assistant"; content: string }[];
}): Promise<void> {
  const { run, userId, sessionId, messageId, history } = args;

  let seq = 0;
  let content = "";
  let thinking = "";
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let lastFlushAt = 0;
  let flushedContent = "";
  let flushedThinking = "";

  const emit = (event: ChatEvent) => {
    appendEvent(run, { ...event, seq: ++seq });
  };

  /** 节流落盘：内容没变就跳过，免得每秒白写一次 */
  const flush = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastFlushAt < FLUSH_INTERVAL_MS) return;
    if (content === flushedContent && thinking === flushedThinking) return;
    lastFlushAt = now;
    flushedContent = content;
    flushedThinking = thinking;
    try {
      await updateMessage(userId, sessionId, messageId, { content, thinking });
    } catch (error) {
      // 落盘失败不能打断生成：内存里还有完整内容，最后定稿会再写一次
      console.error("[chat] 中途落盘失败:", error);
    }
  };

  const finalize = async (status: "complete" | "stopped" | "error", errorText?: string) => {
    try {
      await updateMessage(userId, sessionId, messageId, {
        content,
        thinking,
        status,
        errorText: errorText ?? null,
        promptTokens,
        completionTokens,
        clearRun: true,
      });
    } catch (error) {
      // 定稿失败就只能靠下一轮启动清理兜底
      console.error("[chat] 定稿失败:", error);
    }
    try {
      await finishRunRow(
        run.id,
        status === "complete" ? "done" : status === "stopped" ? "aborted" : "error",
      );
    } catch (error) {
      console.error("[chat] 更新 run 状态失败:", error);
    }
  };

  try {
    for await (const event of pickProvider()({ messages: history, signal: run.abort.signal })) {
      if (event.type === "delta") content += event.delta;
      else if (event.type === "think_delta") thinking += event.delta;
      else if (event.type === "usage") {
        promptTokens = event.prompt_tokens;
        completionTokens = event.completion_tokens;
      }

      emit(event);
      await flush();
    }

    // 上游 provider 可能在被 abort 时"正常结束"（生成器 return 而不是 throw），
    // 所以这里必须以 abort 信号为准，否则用户点了停止却被记成"完成"。
    if (run.abort.signal.aborted) {
      emit({ type: "completed", finish_reason: "aborted" });
      await flush(true);
      await finalize("stopped");
      finishRun(run, "aborted");
      return;
    }

    emit({ type: "completed", finish_reason: "stop" });
    await flush(true);
    await finalize("complete");
    finishRun(run, "done");
  } catch (error) {
    if (run.abort.signal.aborted) {
      emit({ type: "completed", finish_reason: "aborted" });
      await flush(true);
      await finalize("stopped");
      finishRun(run, "aborted");
    } else {
      const message = (error as Error).message || "stream failed";
      emit({ type: "error", message });
      await flush(true);
      await finalize("error", message);
      finishRun(run, "error");
    }
  }
}
