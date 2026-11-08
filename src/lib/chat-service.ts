import { resolveModelForUser } from "@/lib/model-config";
import type { ChatEvent, WireMessage } from "@/lib/protocol";
import { providerForModel } from "@/lib/providers";
import type { ChatProvider } from "@/lib/providers/base";
import { appendEvent, createRun, finishRun, type Run } from "@/lib/runs";
import {
  appendMessage,
  createRunRow,
  deriveTitle,
  finishRunRow,
  getMessage,
  getSession,
  listHistory,
  markMessageStreaming,
  renameSession,
  truncateFrom,
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
 *
 * 四个操作都收敛到这里，因为它们只差"怎么准备历史 / 从哪条消息开始"：
 *   send        追加用户消息 + 新助手消息
 *   regenerate  丢掉某条助手消息及其之后，重发它前面那条用户消息
 *   edit        改掉某条用户消息及其之后，用新内容重发
 *   continue    复用那条助手消息接着写（不删内容，只把 run 换成新的）
 */

/** 半截正文的落盘间隔。太频繁没必要（一秒钟的内容谁也看不出差别），太慢兜不住崩溃 */
const FLUSH_INTERVAL_MS = 1000;

/** 续写用的隐藏指令：不进数据库、不显示在界面，只在服务端拼进历史 */
const CONTINUE_PROMPT =
  "（上一条回答中断了。请紧接着断掉的地方继续写下去，不要重复已经输出过的东西，也不要重新开头。）";

export type GenerationOp =
  | { kind: "send"; content: string }
  | { kind: "regenerate"; messageId: string }
  | { kind: "edit"; messageId: string; content: string }
  | { kind: "continue"; messageId: string };

export type StartResult =
  | {
      ok: true;
      runId: string;
      /** 本次实际使用的公开模型 id（服务端解析后的结果，回给前端对齐 UI） */
      model: string;
      session: SessionDto;
      userMessage: MessageDto | null;
      assistantMessage: MessageDto;
    }
  | { ok: false; status: number; message: string; hint?: string };

type Prepared = {
  history: WireMessage[];
  assistantMessage: MessageDto;
  baseLen: number;
  userMessage: MessageDto | null;
};

/** 准备阶段的结果：null=消息不存在（404），{error}=参数不合法（400），否则正常 */
type PrepareResult = Prepared | { error: string } | null;

export async function startGeneration(
  userId: string,
  sessionId: string,
  op: GenerationOp,
  modelId?: string | null,
): Promise<StartResult> {
  const session = await getSession(userId, sessionId);
  if (!session) return { ok: false, status: 404, message: "会话不存在" };

  const model = await resolveModelForUser(userId, modelId);
  if (!model) {
    return {
      ok: false,
      status: 400,
      message: "当前账户还没有可用的模型",
      hint: "打开设置 → 模型，添加一个 provider 和模型；或者在设置里显式启用系统默认模型。",
    };
  }
  if (model.status === "off") {
    return {
      ok: false,
      status: 400,
      message: `${model.provider.label} 还没有配置`,
      hint: "检查这家 provider 的 API 密钥和地址，确认模型已启用。",
    };
  }

  try {
    const prepared = await prepare(userId, sessionId, op);
    if (!prepared) return { ok: false, status: 404, message: "消息不存在" };
    if ("error" in prepared) return { ok: false, status: 400, message: prepared.error };

    const { history, assistantMessage, baseLen, userMessage } = prepared;

    const run = createRun({ userId, sessionId, messageId: assistantMessage.id });
    await markMessageStreaming(userId, sessionId, assistantMessage.id, run.id);
    // 落一行元信息：进程重启后靠它把这条消息标成 interrupted
    await createRunRow({
      id: run.id,
      userId,
      sessionId,
      messageId: assistantMessage.id,
      baseLen,
    });

    // 故意不 await：POST 只负责把 runId 交出去
    void driveServerRun({
      run,
      provider: providerForModel(model),
      userId,
      sessionId,
      messageId: assistantMessage.id,
      baseLen,
      history,
    });

    return {
      ok: true,
      runId: run.id,
      model: model.definition.id,
      session: (await getSession(userId, sessionId)) ?? session,
      userMessage,
      assistantMessage: { ...assistantMessage, status: "streaming", runId: run.id, baseLen },
    };
  } catch (error) {
    return { ok: false, status: 500, message: "创建生成任务失败", hint: explainDbError(error) };
  }
}

async function prepare(
  userId: string,
  sessionId: string,
  op: GenerationOp,
): Promise<PrepareResult> {
  if (op.kind === "send") {
    const userMessage = await appendMessage(userId, sessionId, {
      role: "user",
      content: op.content,
      status: "complete",
    });
    if (!userMessage) return null;

    const session = await getSession(userId, sessionId);
    if (session && session.messageCount <= 1 && session.title === "新对话") {
      await renameSession(userId, sessionId, deriveTitle(op.content));
    }

    // 顺序很重要：先落用户消息，再取历史（这样历史里包含这句新问题）
    const history = await listHistory(userId, sessionId);
    const assistantMessage = await appendMessage(userId, sessionId, {
      role: "assistant",
      content: "",
      status: "streaming",
    });
    if (!assistantMessage) return null;
    return { history, assistantMessage, baseLen: 0, userMessage };
  }

  const target = await getMessage(userId, sessionId, op.messageId);
  if (!target) return null;

  if (op.kind === "regenerate") {
    if (target.role !== "assistant") return { error: "只能对助手消息重新生成" };
    // 丢掉这条助手消息及其之后的所有内容
    await truncateFrom(userId, sessionId, target.seq);
    const history = await listHistory(userId, sessionId);
    const assistantMessage = await appendMessage(userId, sessionId, {
      role: "assistant",
      content: "",
      status: "streaming",
    });
    if (!assistantMessage) return null;
    return { history, assistantMessage, baseLen: 0, userMessage: null };
  }

  if (op.kind === "edit") {
    if (target.role !== "user") return { error: "只能编辑用户消息" };
    // 从这条用户消息开始整段重来（删掉后 appendMessage 会把 seq 重新算成同一个号）
    await truncateFrom(userId, sessionId, target.seq);
    const userMessage = await appendMessage(userId, sessionId, {
      role: "user",
      content: op.content,
      status: "complete",
    });
    if (!userMessage) return null;

    if (userMessage.seq === 1) {
      await renameSession(userId, sessionId, deriveTitle(op.content));
    }

    const history = await listHistory(userId, sessionId);
    const assistantMessage = await appendMessage(userId, sessionId, {
      role: "assistant",
      content: "",
      status: "streaming",
    });
    if (!assistantMessage) return null;
    return { history, assistantMessage, baseLen: 0, userMessage };
  }

  // continue：什么都不删，历史 = 已有消息 + 一条隐藏指令，输出接到同一条消息上
  if (target.role !== "assistant") return { error: "只能续写助手消息" };
  if (!target.content.trim()) return { error: "这条消息还没有内容，无法续写" };

  const history = await listHistory(userId, sessionId);
  history.push({ role: "user", content: CONTINUE_PROMPT });

  return {
    history,
    assistantMessage: target,
    baseLen: target.content.length,
    userMessage: null,
  };
}

async function driveServerRun(args: {
  run: Run;
  provider: ChatProvider;
  userId: string;
  sessionId: string;
  messageId: string;
  baseLen: number;
  history: WireMessage[];
}): Promise<void> {
  const { run, provider, userId, sessionId, messageId, baseLen, history } = args;

  let seq = 0;
  // 续写时库里已有前缀，新的增量接在它后面。
  // 前端断线续传也按同一个 baseLen 留前缀，两边规则一致。
  let content = "";
  if (baseLen > 0) {
    const existing = await getMessage(userId, sessionId, messageId);
    content = (existing?.content ?? "").slice(0, baseLen);
  }
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
    let finishReason: "stop" | "length" = "stop";
    for await (const event of provider({ messages: history, signal: run.abort.signal })) {
      // 上游的错误事件要变成异常，交给下面的 catch 统一定稿；
      // 否则循环正常结束会把一条失败的回答记成 complete。
      if (event.type === "error") throw new Error(event.message);
      // completed 由这里统一发，避免同一个 run 出现两条 completed
      if (event.type === "completed") {
        if (event.finish_reason === "length") finishReason = "length";
        continue;
      }

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

    emit({ type: "completed", finish_reason: finishReason });
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
