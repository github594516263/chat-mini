"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { decodeEvent, type SeqEvent, type WireMessage } from "@/lib/protocol";
import {
  createSession,
  deriveTitle,
  loadStore,
  newId,
  saveStore,
  sortSessions,
  type ChatSession,
  type ChatUIMessage,
} from "@/lib/sessions";

export type { ChatSession, ChatUIMessage };

export type ChatUser = { id: string; username: string };

/** 续写用的隐藏指令（游客模式才由前端拼；登录模式这条在服务端拼，前端不显示） */
const CONTINUE_PROMPT =
  "（上一条回答因为刷新或断网中断了。请紧接着断掉的地方继续写下去，不要重复已经输出过的内容，也不要重新开头。）";

type RunHandle = { runId: string; sessionId: string; assistantId: string };

/** 一条会话的订阅状态 */
type RunEntry = {
  /** 只掐订阅，不掐服务端生成 */
  controller: AbortController;
  /** 服务端分配的 run；POST 还没回来时是 null */
  handle: RunHandle | null;
  /** 区分"用户点了停止"和"只是切走/关页面" —— 后者回来还能续 */
  stoppedByUser: boolean;
};

// ---------------------------------------------------------------- 服务端 DTO

type ApiMessage = {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  thinking: string | null;
  status: "streaming" | "complete" | "interrupted" | "stopped" | "error";
  errorText: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  runId: string | null;
  baseLen: number;
  createdAt: string;
};

type ApiSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

function toUiMessage(m: ApiMessage): ChatUIMessage {
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
    thinking: m.thinking ?? undefined,
    usage:
      m.promptTokens !== null || m.completionTokens !== null
        ? { prompt_tokens: m.promptTokens ?? 0, completion_tokens: m.completionTokens ?? 0 }
        : undefined,
    pending: m.status === "streaming",
    interrupted: m.status === "interrupted",
    stopped: m.status === "stopped",
    error: m.errorText ?? undefined,
    runId: m.runId ?? undefined,
    appliedSeq: 0,
    baseLen: m.baseLen,
  };
}

function toUiSession(s: ApiSession, messages: ChatUIMessage[] = [], loaded = false): ChatSession {
  return {
    id: s.id,
    title: s.title,
    createdAt: Date.parse(s.createdAt) || Date.now(),
    updatedAt: Date.parse(s.updatedAt) || Date.now(),
    messages,
    loaded,
  };
}

/** 登录模式下只记"上次看的是哪个会话"，消息本体永远以服务端为准 */
const activeKey = (userId: string) => `chat-mini/active/v1/${userId}`;

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 会话 + 生成的唯一状态源。
 *
 * 两种模式共用同一套生成引擎（run + seq 续传），只换"数据从哪来"：
 *   游客   localStorage 就是真相（不登录也能用，但换设备就没了）
 *   登录   服务端是真相，本地只是缓存；刷新后从 /api/sessions 重新拉
 */
export function useChat(
  options: {
    user?: ChatUser | null;
    /** URL 里的会话 id（/c/[id]）；它比 localStorage 的"上次看的"优先级更高 */
    initialSessionId?: string | null;
    /**
     * 当前选中的模型（公开 id）。只影响「下一次请求」，不影响正在跑的 run：
     * 生成到一半切模型，这条回答仍然用发起时的模型跑完，符合直觉。
     */
    modelId?: string | null;
    /** 当前模型选中的推理等级 id；null 表示用模型默认档位 */
    reasoningId?: string | null;
  } = {},
) {
  const userId = options.user?.id ?? null;
  const remote = Boolean(userId);
  // 只在首次水合时用一次。放进 ref 是为了让"后续 URL 变化"走 syncFromUrl，
  // 而不是让水合 effect 依赖它——否则每切一次会话就会重拉一遍会话列表。
  const initialSessionIdRef = useRef<string | null>(options.initialSessionId ?? null);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * 正在生成的会话集合。必须是**集合**而不是布尔、也不是单值：
   * A 在后台继续生成的同时，用户可能在 B 里发消息 —— 两件事都要能成立。
   */
  const [streamingIds, setStreamingIds] = useState<string[]>([]);
  /**
   * 输入框草稿按会话存：切走再回来还在。
   *
   * 故意用 ref 而不是 state：草稿是**输入框自己的状态**，一次按键不该让
   * ChatShell → Sidebar / 消息列表整棵树重渲染。改成 state 时实测每个按键
   * 23ms 的主线程 JS（dev 构建），而这里只需要"记住字符串"。
   * 输入框组件自己用 useState 渲染，写完再回写这里，两边各管一层。
   */
  const draftsRef = useRef<Map<string, string>>(new Map());
  /**
   * 正在编辑的那条消息，也按会话存。
   * 不这么做的话，切走再回来编辑框就没了 —— 草稿能活、编辑态不能活，
   * 这种"一半有记忆一半没有"最让人困惑。
   */
  const [editing, setEditing] = useState<Record<string, { messageId: string; draft: string }>>({});
  const [hydrated, setHydrated] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  /**
   * URL 里的 id 在服务端不存在（或不属于你）时记在这里。
   *
   * 为什么不在服务端 notFound()：界面挂在 layout 上，page 是空壳，
   * 服务端已经没有任何"会话内容"可以拦，拦下来也只会得到
   * 「404 页面 + layout 里照常渲染的聊天界面」这种怪异组合。
   * 所以存在性判断交给客户端：拉一次 /api/sessions/[id]，404 就进入 not-found 态。
   */
  const [missingSessionId, setMissingSessionId] = useState<string | null>(null);

  /**
   * 每个会话各自的订阅。sessionId → 这一路的 controller / 服务端 run / 是否用户手动停。
   * 只掐订阅不掐生成：断掉之后服务端还在跑，回来能续上。
   */
  const runsRef = useRef<Map<string, RunEntry>>(new Map());
  /**
   * 每条会话的滚动位置。滚动位置本质是 DOM 状态，page 重建就会归零，
   * 所以只能由 Provider 记着 —— 但它跟"消息内容"一样属于视图记忆，不该进 URL。
   */
  const scrollMemoryRef = useRef<Map<string, number>>(new Map());
  const resumedRef = useRef<Set<string>>(new Set());
  /**
   * 模型选择在组件外（ChatShell）保存，请求发出时通过 ref 取最新值。
   * 不用 state 依赖：否则每换一次模型，所有 send/regenerate 回调都要重建。
   */
  const modelRef = useRef<string | null>(options.modelId ?? null);
  const reasoningRef = useRef<string | null>(options.reasoningId ?? null);
  const stateRef = useRef<{ sessions: ChatSession[]; activeId: string | null }>({
    sessions: [],
    activeId: null,
  });

  useEffect(() => {
    modelRef.current = options.modelId ?? null;
  }, [options.modelId]);

  useEffect(() => {
    reasoningRef.current = options.reasoningId ?? null;
  }, [options.reasoningId]);

  useEffect(() => {
    stateRef.current = { sessions, activeId };
  }, [sessions, activeId]);

  // ---------------------------------------------------------------- 水合

  // 首帧之后才读存储，避免 SSR / 水合不一致
  useEffect(() => {
    const urlId = initialSessionIdRef.current;
    if (!remote) {
      const store = loadStore();
      // 优先级：URL 里的 id > 上次看的 > 第一条
      const fromUrl =
        urlId && store.sessions.some((s) => s.id === urlId) ? urlId : null;

      if (store.sessions.length > 0) {
        setSessions(store.sessions);
        setActiveId(fromUrl ?? store.activeId ?? store.sessions[0].id);
      } else {
        const session = createSession();
        setSessions([session]);
        setActiveId(session.id);
      }
      setHydrated(true);
      return;
    }

    // 登录模式：列表来自服务端
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/sessions");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await readJsonResponse(response)) as { sessions?: ApiSession[] };
        let list = (data.sessions ?? []).map((s) => toUiSession(s));

        if (list.length === 0) {
          const created = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (created.ok) {
            const payload = (await readJsonResponse(created)) as { session?: ApiSession };
            if (payload.session) list = [toUiSession(payload.session)];
          }
        }
        if (cancelled) return;

        setSessions(list);
        // 优先级：URL 里的 id > localStorage 的"上次看的" > 第一条
        const fromUrl = urlId && list.some((s) => s.id === urlId) ? urlId : null;
        const saved = window.localStorage.getItem(activeKey(userId));
        setActiveId(
          fromUrl ?? (list.some((s) => s.id === saved) ? saved : null) ?? (list[0]?.id ?? null),
        );
      } catch {
        // 服务端不可用：保持空列表，界面上会显示没有会话
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [remote, userId]);

  // 游客：整存整取落 localStorage
  useEffect(() => {
    if (remote || !hydrated) return;
    saveStore({ sessions, activeId });
  }, [sessions, activeId, hydrated, remote]);

  // 登录：只记当前会话 id
  useEffect(() => {
    if (!remote || !userId || !hydrated || !activeId) return;
    try {
      window.localStorage.setItem(activeKey(userId), activeId);
    } catch {
      // 隐私模式写不进去也没关系
    }
  }, [remote, userId, hydrated, activeId]);

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);
  const ordered = useMemo(() => sortSessions(sessions), [sessions]);

  /** 只有"当前这条会话"在生成时才算 streaming；别的会话在后台跑不影响这里 */
  const streaming = activeId !== null && streamingIds.includes(activeId);

  /** 这条会话有没有在跑（守卫用；读 ref，不触发渲染） */
  const isRunning = useCallback((sessionId: string) => runsRef.current.has(sessionId), []);

  const markStreaming = useCallback((sessionId: string, on: boolean) => {
    setStreamingIds((prev) => {
      const has = prev.includes(sessionId);
      if (on) return has ? prev : [...prev, sessionId];
      return has ? prev.filter((id) => id !== sessionId) : prev;
    });
  }, []);

  /**
   * 读/写某条会话的草稿（纯 ref，不触发渲染）。
   * 输入框拿到会话切换时用 getDraft 重新起稿，按键时 setDraft 回写 —— 都不惊动这棵大树。
   */
  const getDraft = useCallback(
    (sessionId: string | null) => (sessionId ? (draftsRef.current.get(sessionId) ?? "") : ""),
    [],
  );

  const setDraft = useCallback((sessionId: string, value: string) => {
    draftsRef.current.set(sessionId, value);
  }, []);

  // ---------------------------------------------------------------- 编辑态（按会话）

  const editState = activeId ? (editing[activeId] ?? null) : null;

  const beginEdit = useCallback(
    (messageId: string, content: string) => {
      if (!activeId) return;
      setEditing((prev) => ({ ...prev, [activeId]: { messageId, draft: content } }));
    },
    [activeId],
  );

  const updateEditDraft = useCallback(
    (draft: string) => {
      if (!activeId) return;
      setEditing((prev) => {
        const current = prev[activeId];
        if (!current) return prev;
        return { ...prev, [activeId]: { ...current, draft } };
      });
    },
    [activeId],
  );

  /** 退出编辑态（取消 / 提交都走这里） */
  const endEdit = useCallback(() => {
    if (!activeId) return;
    setEditing((prev) => {
      if (!(activeId in prev)) return prev;
      const next = { ...prev };
      delete next[activeId];
      return next;
    });
  }, [activeId]);

  // ---------------------------------------------------------------- 滚动位置（按会话）

  const rememberScroll = useCallback((sessionId: string, top: number) => {
    scrollMemoryRef.current.set(sessionId, top);
  }, []);

  const recallScroll = useCallback((sessionId: string): number | null => {
    return scrollMemoryRef.current.get(sessionId) ?? null;
  }, []);

  const updateSession = useCallback(
    (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? updater(s) : s)));
    },
    [],
  );

  const patchMessage = useCallback(
    (sessionId: string, messageId: string, updater: (m: ChatUIMessage) => ChatUIMessage) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                messages: session.messages.map((m) => (m.id === messageId ? updater(m) : m)),
              }
            : session,
        ),
      );
    },
    [],
  );

  const markInterrupted = useCallback(
    (sessionId: string, messageId: string) => {
      patchMessage(sessionId, messageId, (m) => ({
        ...m,
        pending: false,
        interrupted: true,
        runId: undefined,
      }));
    },
    [patchMessage],
  );

  /** 单个事件落到消息上。appliedSeq 和正文一起写，保证续传水位不会跟正文脱节 */
  const applyEvent = useCallback(
    (sessionId: string, messageId: string, event: SeqEvent) => {
      patchMessage(sessionId, messageId, (m) => {
        switch (event.type) {
          case "delta":
            return {
              ...m,
              content: m.content + event.delta,
              appliedSeq: event.seq,
              interrupted: false,
            };
          case "think_delta":
            return { ...m, thinking: (m.thinking ?? "") + event.delta, appliedSeq: event.seq };
          case "usage":
            return {
              ...m,
              usage: {
                prompt_tokens: event.prompt_tokens,
                completion_tokens: event.completion_tokens,
              },
              appliedSeq: event.seq,
            };
          case "sync":
            // 覆盖式：服务端压缩过旧事件时用这个把正文一次性对齐
            return {
              ...m,
              content: event.content,
              thinking: event.thinking,
              appliedSeq: event.seq,
            };
          case "completed":
            // runId 故意保留：出问题能对着服务端 run 复盘，续传逻辑只看 pending
            return {
              ...m,
              pending: false,
              interrupted: false,
              stopped: event.finish_reason === "aborted",
              appliedSeq: event.seq,
            };
          case "error":
            return {
              ...m,
              error: event.message,
              pending: false,
              interrupted: false,
              appliedSeq: event.seq,
              runId: undefined,
            };
        }
      });
    },
    [patchMessage],
  );

  /** 订阅一个 run：先回放 afterSeq 之后的，再吃实时推送 */
  const consumeRun = useCallback(
    async (
      sessionId: string,
      assistantId: string,
      runId: string,
      fromSeq: number,
      signal: AbortSignal,
    ): Promise<"done" | "missing"> => {
      const response = await fetch(
        `/api/chat/stream?runId=${encodeURIComponent(runId)}&afterSeq=${fromSeq}`,
        { signal },
      );

      if (response.status === 404) {
        markInterrupted(sessionId, assistantId);
        return "missing";
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error("响应没有 body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastSeq = fromSeq;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");

          const event = decodeEvent(line);
          if (!event) continue;
          // seq 幂等：续传/重放都不会导致重复追加
          if (typeof event.seq === "number" && event.seq <= lastSeq) continue;
          if (typeof event.seq === "number") lastSeq = event.seq;
          applyEvent(sessionId, assistantId, event);
        }
      }

      return "done";
    },
    [applyEvent, markInterrupted],
  );

  /** 登录模式：拉一遍服务端消息，覆盖本地缓存（生成结束后用它对齐权威内容） */
  const refreshMessages = useCallback(
    async (sessionId: string): Promise<ChatUIMessage[] | null> => {
      try {
        const response = await fetch(`/api/sessions/${sessionId}/messages`);
        if (!response.ok) return null;
        const data = (await readJsonResponse(response)) as { messages?: ApiMessage[] };
        const messages = (data.messages ?? [])
          .filter((m) => m.role !== "system")
          .map(toUiMessage);
        updateSession(sessionId, (s) => ({ ...s, messages, loaded: true }));
        return messages;
      } catch {
        return null;
      }
    },
    [updateSession],
  );

  /** 登录模式：订阅一个刚建好的 run，结束后用服务端内容对齐 */
  const runRemote = useCallback(
    async (sessionId: string, assistantId: string, runId: string, startFrom = 0) => {
      const controller = new AbortController();
      runsRef.current.set(sessionId, {
        controller,
        handle: { runId, sessionId, assistantId },
        stoppedByUser: false,
      });
      markStreaming(sessionId, true);

      try {
        await consumeRun(sessionId, assistantId, runId, startFrom, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          patchMessage(sessionId, assistantId, (m) => ({ ...m, error: message, pending: false }));
        }
      } finally {
        runsRef.current.delete(sessionId);
        markStreaming(sessionId, false);
        // 以服务端为准：定稿的正文、用量、状态都在库里
        const messages = await refreshMessages(sessionId);
        const finalMessage = messages?.find((m) => m.id === assistantId);
        if (finalMessage && finalMessage.pending) markInterrupted(sessionId, assistantId);
        // 列表里的标题/更新时间也顺手对齐
        void fetch("/api/sessions")
          .then((r) => (r.ok ? readJsonResponse(r) : null))
          .then((data) => {
            const list = (data as { sessions?: ApiSession[] } | null)?.sessions;
            if (!list) return;
            setSessions((prev) =>
              prev.map((s) => {
                const fresh = list.find((x) => x.id === s.id);
                return fresh
                  ? { ...s, title: fresh.title, updatedAt: Date.parse(fresh.updatedAt) || s.updatedAt }
                  : s;
              }),
            );
          })
          .catch(() => {
            // 列表刷新失败不影响正文
          });
      }
    },
    [consumeRun, markInterrupted, markStreaming, patchMessage, refreshMessages],
  );

  /** 游客模式的建 run + 订阅。历史由调用方算好 */
  const startGuestRun = useCallback(
    async (sessionId: string, assistantId: string, history: ChatUIMessage[]) => {
      const controller = new AbortController();
      runsRef.current.set(sessionId, { controller, handle: null, stoppedByUser: false });
      markStreaming(sessionId, true);

      const payload: WireMessage[] = history
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: payload,
            ...(modelRef.current ? { model: modelRef.current } : {}),
            ...(reasoningRef.current ? { reasoning: reasoningRef.current } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`.trim());
        }

        const data = (await response.json()) as { runId?: string };
        if (!data.runId) throw new Error("服务端没有返回 runId");

        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          runId: data.runId,
          appliedSeq: 0,
          pending: true,
        }));
        const entry = runsRef.current.get(sessionId);
        if (entry) entry.handle = { runId: data.runId, sessionId, assistantId };

        await consumeRun(sessionId, assistantId, data.runId, 0, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          patchMessage(sessionId, assistantId, (m) => ({ ...m, stopped: true }));
        } else {
          const message = error instanceof Error ? error.message : String(error);
          patchMessage(sessionId, assistantId, (m) => ({ ...m, error: message }));
        }
      } finally {
        const entry = runsRef.current.get(sessionId);
        runsRef.current.delete(sessionId);
        markStreaming(sessionId, false);
        patchMessage(sessionId, assistantId, (m) => {
          if (!m.pending) return m;
          if (entry?.stoppedByUser) return { ...m, pending: false, stopped: true };
          // 只是切走会话/关页面：保留 pending + runId，回来还能续
          if (controller.signal.aborted) return m;
          return { ...m, pending: false, interrupted: !m.error };
        });
        updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }));
      }
    },
    [consumeRun, markStreaming, patchMessage, updateSession],
  );

  /** 登录模式：向服务端发起一个生成操作，拿回服务端分配的消息 id 再订阅 */
  const startRemoteOperation = useCallback(
    async (
      sessionId: string,
      body: { kind: "send"; content: string } | { kind: "regenerate" | "continue" | "edit"; messageId: string; content?: string },
      options: { truncateFrom?: string; dropMessagesAlso?: boolean } = {},
    ) => {
      if (isRunning(sessionId)) return;
      markStreaming(sessionId, true);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            ...body,
            ...(modelRef.current ? { model: modelRef.current } : {}),
            ...(reasoningRef.current ? { reasoning: reasoningRef.current } : {}),
          }),
        });
        const data = (await readJsonResponse(response)) as {
          runId?: string;
          session?: ApiSession;
          userMessage?: ApiMessage | null;
          assistantMessage?: ApiMessage;
          error?: string;
          hint?: string;
        };

        if (!response.ok || !data.runId || !data.assistantMessage) {
          const detail = data.error ?? `HTTP ${response.status}`;
          throw new Error(data.hint ? `${detail}（${data.hint}）` : detail);
        }

        const assistant = toUiMessage(data.assistantMessage);

        // 本地对齐服务端：截断+替换，避免本地和服务端 seq 打架
        updateSession(sessionId, (session) => {
          let messages = session.messages;
          if (options.truncateFrom) {
            const index = messages.findIndex((m) => m.id === options.truncateFrom);
            if (index >= 0) messages = messages.slice(0, index);
          }
          const next = [...messages];
          if (data.userMessage) next.push(toUiMessage(data.userMessage));
          next.push({ ...assistant, content: "", pending: true, appliedSeq: 0 });
          return {
            ...session,
            title: data.session?.title ?? session.title,
            updatedAt: Date.parse(data.session?.updatedAt ?? "") || Date.now(),
            messages: next,
            loaded: true,
          };
        });

        await runRemote(sessionId, assistant.id, data.runId, 0);
      } catch (error) {
        markStreaming(sessionId, false);
        const message = error instanceof Error ? error.message : String(error);
        // 失败时留一条可见的错误消息，别让用户对着空气等
        updateSession(sessionId, (session) => ({
          ...session,
          messages: [
            ...session.messages,
            { id: newId(), role: "assistant", content: "", error: message },
          ],
        }));
      }
    },
    [runRemote, updateSession],
  );

  /** 取当前会话 + 某条消息的下标 */
  const locate = useCallback((messageId: string) => {
    const { sessions: currentSessions, activeId: currentActiveId } = stateRef.current;
    const session = currentSessions.find((s) => s.id === currentActiveId);
    if (!session) return null;
    const index = session.messages.findIndex((m) => m.id === messageId);
    if (index < 0) return null;
    return { session, index };
  }, []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content) return;

      const { sessions: currentSessions, activeId: currentActiveId } = stateRef.current;
      const session = currentSessions.find((s) => s.id === currentActiveId);
      if (!session) return;
      // 只挡"这条会话自己在生成"；别的会话在后台跑不影响这里发消息
      if (isRunning(session.id)) return;

      if (remote) {
        await startRemoteOperation(session.id, { kind: "send", content });
        return;
      }

      const sessionId = session.id;
      const userMessage: ChatUIMessage = { id: newId(), role: "user", content };
      const assistantId = newId();
      const history = [...session.messages, userMessage];

      updateSession(sessionId, (s) => ({
        ...s,
        title: s.messages.length === 0 ? deriveTitle(content) : s.title,
        updatedAt: Date.now(),
        messages: [...history, { id: assistantId, role: "assistant", content: "", pending: true }],
      }));

      await startGuestRun(sessionId, assistantId, history);
    },
    [remote, startGuestRun, startRemoteOperation, updateSession],
  );

  /** 重新生成：丢掉这条助手消息，用它前面最近的那条用户消息重发 */
  const regenerate = useCallback(
    async (assistantMessageId: string) => {
      const located = locate(assistantMessageId);
      if (!located) return;
      if (isRunning(located.session.id)) return;

      if (remote) {
        await startRemoteOperation(
          located.session.id,
          { kind: "regenerate", messageId: assistantMessageId },
          { truncateFrom: assistantMessageId },
        );
        return;
      }

      const { session, index } = located;
      let userIndex = index - 1;
      while (userIndex >= 0 && session.messages[userIndex].role !== "user") userIndex -= 1;
      if (userIndex < 0) return;

      const history = session.messages.slice(0, userIndex + 1);
      const assistantId = newId();
      updateSession(session.id, (s) => ({
        ...s,
        updatedAt: Date.now(),
        messages: [...history, { id: assistantId, role: "assistant", content: "", pending: true }],
      }));

      await startGuestRun(session.id, assistantId, history);
    },
    [isRunning, locate, remote, startGuestRun, startRemoteOperation, updateSession],
  );

  /** 编辑重发：改掉那条用户消息，把它之后的全部内容丢弃后重发 */
  const editAndResend = useCallback(
    async (userMessageId: string, text: string) => {
      const content = text.trim();
      if (!content) return;
      const located = locate(userMessageId);
      if (!located) return;
      if (isRunning(located.session.id)) return;

      if (remote) {
        await startRemoteOperation(
          located.session.id,
          { kind: "edit", messageId: userMessageId, content },
          { truncateFrom: userMessageId },
        );
        return;
      }

      const { session, index } = located;
      const edited: ChatUIMessage = { ...session.messages[index], content };
      const history = [...session.messages.slice(0, index), edited];
      const assistantId = newId();

      updateSession(session.id, (s) => ({
        ...s,
        title: index === 0 ? deriveTitle(content) : s.title,
        updatedAt: Date.now(),
        messages: [...history, { id: assistantId, role: "assistant", content: "", pending: true }],
      }));

      await startGuestRun(session.id, assistantId, history);
    },
    [isRunning, locate, remote, startGuestRun, startRemoteOperation, updateSession],
  );

  /**
   * 继续生成（方案 A 的兜底）：把半截回答当上下文，让模型接着往下写。
   * 输出仍然落在同一条消息里，所以视觉上是"接着写"，不是另起一条。
   */
  const continueGeneration = useCallback(
    async (assistantMessageId: string) => {
      const located = locate(assistantMessageId);
      if (!located) return;
      if (isRunning(located.session.id)) return;

      const { session, index } = located;
      const target = session.messages[index];
      if (target.role !== "assistant" || !target.content.trim()) return;

      if (remote) {
        patchMessage(session.id, assistantMessageId, (m) => ({
          ...m,
          interrupted: false,
          stopped: false,
          error: undefined,
          pending: true,
          appliedSeq: 0,
          baseLen: m.content.length,
        }));
        await startRemoteOperation(session.id, {
          kind: "continue",
          messageId: assistantMessageId,
        });
        return;
      }

      const history: ChatUIMessage[] = [
        ...session.messages.slice(0, index + 1),
        { id: newId(), role: "user", content: CONTINUE_PROMPT },
      ];

      patchMessage(session.id, assistantMessageId, (m) => ({
        ...m,
        interrupted: false,
        stopped: false,
        error: undefined,
        pending: true,
      }));
      updateSession(session.id, (s) => ({ ...s, updatedAt: Date.now() }));

      await startGuestRun(session.id, assistantMessageId, history);
    },
    [locate, patchMessage, remote, startGuestRun, startRemoteOperation, updateSession],
  );

  /** 停止当前会话的生成：先让服务端真的停（否则 token 继续烧），再掐掉本地订阅 */
  const stop = useCallback(() => {
    if (!activeId) return;
    const entry = runsRef.current.get(activeId);
    if (!entry) return;
    entry.stoppedByUser = true;
    if (entry.handle) {
      void fetch("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: entry.handle.runId }),
      }).catch(() => {
        // 取消失败不影响本地停止
      });
    }
    entry.controller.abort();
  }, [activeId]);

  // ---------------------------------------------------------------- 续传

  /** 把一条 status=streaming 的消息接上：前缀 + 重新回放这条 run 的增量 */
  const resumeRun = useCallback(
    (sessionId: string, message: ChatUIMessage) => {
      if (!message.runId || isRunning(sessionId)) return;
      if (resumedRef.current.has(message.runId)) return;
      resumedRef.current.add(message.runId);

      const controller = new AbortController();
      runsRef.current.set(sessionId, {
        controller,
        handle: { runId: message.runId, sessionId, assistantId: message.id },
        stoppedByUser: false,
      });
      markStreaming(sessionId, true);

      // 两种模式的重放起点不一样：
      //   服务端：库里存的是"前缀 + 已输出"，而 run 的事件里只有本次输出。
      //           所以先砍回前缀（baseLen 个字），再从 seq 0 重放，正文不会重复。
      //   游客：  正文只存在本地，水位 appliedSeq 也是本地记的，直接用那个水位接着放。
      const fromSeq = remote ? 0 : (message.appliedSeq ?? 0);
      patchMessage(sessionId, message.id, (m) => ({
        ...m,
        content: remote ? m.content.slice(0, m.baseLen ?? 0) : m.content,
        appliedSeq: fromSeq,
        pending: true,
        interrupted: false,
      }));

      void (async () => {
        try {
          await consumeRun(sessionId, message.id, message.runId!, fromSeq, controller.signal);
        } catch {
          markInterrupted(sessionId, message.id);
        } finally {
          runsRef.current.delete(sessionId);
          markStreaming(sessionId, false);
          if (remote) {
            const messages = await refreshMessages(sessionId);
            const finalMessage = messages?.find((m) => m.id === message.id);
            if (finalMessage && finalMessage.pending) markInterrupted(sessionId, message.id);
          } else {
            patchMessage(sessionId, message.id, (m) =>
              m.pending ? { ...m, pending: false, interrupted: !m.error } : m,
            );
          }
        }
      })();
    },
    [consumeRun, isRunning, markInterrupted, markStreaming, patchMessage, refreshMessages, remote],
  );

  // 游客：从本地仓里找没跑完的 run 续上（数据本来就在本地）
  useEffect(() => {
    if (remote || !hydrated || !active) return;
    if (isRunning(active.id)) return;
    const target = [...active.messages].reverse().find((m) => m.pending && m.runId);
    if (target) resumeRun(active.id, target);
  }, [active, hydrated, isRunning, remote, resumeRun]);

  // 登录：切到哪个会话就拉哪份消息；拉到正在生成的消息就接上
  const loadMessages = useCallback(
    async (sessionId: string) => {
      setMessagesLoading(true);
      try {
        const messages = await refreshMessages(sessionId);
        if (!messages) {
          // 拉失败（网络错误 / 404）：也要把 loaded 置掉，
          // 否则界面会永远停在骨架屏上等着一个不会来的响应
          updateSession(sessionId, (s) => (s.loaded === false ? { ...s, loaded: true } : s));
          return;
        }
        const streamingMessage = [...messages].reverse().find((m) => m.pending && m.runId);
        if (streamingMessage) resumeRun(sessionId, streamingMessage);
      } finally {
        setMessagesLoading(false);
      }
    },
    [refreshMessages, resumeRun, updateSession],
  );

  useEffect(() => {
    if (!remote || !hydrated || !active) return;
    if (active.loaded !== false) return;
    void loadMessages(active.id);
  }, [active, hydrated, loadMessages, remote]);

  /**
   * 切会话：**不断订阅、不掐生成**。
   * 状态活在 Provider 里，切走之后订阅继续把增量写进 sessionId 对应的消息上，
   * 切回来直接就是完整正文 —— 这是 Step 2 要达到的效果。
   */
  const selectSession = useCallback((sessionId: string) => {
    setActiveId((current) => (current === sessionId ? current : sessionId));
  }, []);

  /**
   * URL → 当前会话（单向：URL 是真相）。后退、前进、直接粘链接都走这里。
   * 老会话可能不在列表前 50 条内：登录模式下补一条并回填标题，
   * 避免出现"URL 有 id、侧栏却没这条会话"的割裂状态。
   */
  const syncFromUrl = useCallback(
    (sessionId: string | null) => {
      if (!sessionId) {
        setMissingSessionId(null);
        return;
      }
      setActiveId((current) => (current === sessionId ? current : sessionId));

      const list = stateRef.current.sessions;
      if (list.some((s) => s.id === sessionId)) {
        setMissingSessionId(null);
        return;
      }
      if (!remote || list.length === 0) return; // 游客 / 列表还没水合完

      void (async () => {
        try {
          const response = await fetch(`/api/sessions/${sessionId}`);
          if (!response.ok) {
            // 404 = 不存在或不属于你，两种都不泄露
            setMissingSessionId(sessionId);
            return;
          }
          const data = (await readJsonResponse(response)) as { session?: ApiSession };
          if (!data.session) {
            setMissingSessionId(sessionId);
            return;
          }
          const fetched = toUiSession(data.session);
          setMissingSessionId(null);
          setSessions((prev) => (prev.some((s) => s.id === sessionId) ? prev : [fetched, ...prev]));
        } catch {
          // 网络错误不等于不存在：保持未知状态，别误报 404
        }
      })();
    },
    [remote],
  );

  const newSession = useCallback(
    (options: { onCreated?: (id: string) => void } = {}) => {
      // 注意：这里不再打断别的会话的生成 —— 新建一条会话不该杀掉后台还在跑的回答

      if (remote) {
        const tempId = newId();
        const now = Date.now();
        const draft: ChatSession = {
          id: tempId,
          title: "新对话",
          createdAt: now,
          updatedAt: now,
          messages: [],
          loaded: true,
        };
        setSessions((prev) => [draft, ...prev]);
        setActiveId(tempId);

        void (async () => {
          try {
            const response = await fetch("/api/sessions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = (await readJsonResponse(response)) as { session?: ApiSession };
            if (!data.session) throw new Error("服务端没有返回会话");
            const real = toUiSession(data.session, [], true);
            // 草稿跟着 id 走：建会话可能比用户打字慢，临时 id 换成真 id 时别把已经写的字弄丢
            const carried = draftsRef.current.get(tempId);
            if (carried) {
              draftsRef.current.set(real.id, carried);
              draftsRef.current.delete(tempId);
            }
            // 把临时 id 换成服务端 id
            setSessions((prev) => prev.map((s) => (s.id === tempId ? real : s)));
            setActiveId((current) => (current === tempId ? real.id : current));
            // 真 id 到手，通知外层把地址栏换成 /c/<真id>（草稿态到此结束）
            options.onCreated?.(real.id);
          } catch {
            draftsRef.current.delete(tempId);
            setSessions((prev) => prev.filter((s) => s.id !== tempId));
            setActiveId((current) =>
              current === tempId ? (stateRef.current.sessions[0]?.id ?? null) : current,
            );
          }
        })();

        return tempId;
      }

      const session = createSession();
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      options.onCreated?.(session.id);
      return session.id;
    },
    [remote],
  );

  /**
   * 删除会话。删掉的若是当前会话，用 onActivated 告诉外层把地址栏 replace 到下一条
   * （必须是 replace：不能让后退键回到一条已经不存在的会话）。
   */
  const deleteSession = useCallback(
    (sessionId: string, options: { onActivated?: (id: string | null) => void } = {}) => {
      // 只掐这条会话自己的订阅，别的会话在后台跑的不受影响
      runsRef.current.get(sessionId)?.controller.abort();

      const { sessions: current, activeId: currentActive } = stateRef.current;
      const remaining = current.filter((s) => s.id !== sessionId);
      const wasActive = sessionId === currentActive;
      const nextId = remaining.length > 0 ? sortSessions(remaining)[0].id : null;

      setSessions(remaining);
      draftsRef.current.delete(sessionId);
      setEditing((prev) => {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      scrollMemoryRef.current.delete(sessionId);

      if (remote) {
        void fetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {
          // 删失败就以服务端为准，下次刷新会回来
        });
        if (!wasActive) return;
        if (nextId) {
          setActiveId(nextId);
          options.onActivated?.(nextId);
        } else {
          // 删光了：补一条新的，等真 id 到手再把地址栏换过去
          newSession({ onCreated: (id) => options.onActivated?.(id) });
        }
        return;
      }

      if (remaining.length === 0) {
        const session = createSession();
        setSessions([session]);
        setActiveId(session.id);
        options.onActivated?.(session.id);
        return;
      }
      if (wasActive && nextId) {
        setActiveId(nextId);
        options.onActivated?.(nextId);
      }
    },
    [newSession, remote],
  );

  /** 重命名：不改 updatedAt，避免仅仅改个名字就把会话顶到列表最前 */
  const renameSession = useCallback(
    (sessionId: string, title: string) => {
      const next = title.replace(/\s+/g, " ").trim();
      if (!next) return;
      const capped = next.length > 40 ? `${next.slice(0, 40)}…` : next;

      updateSession(sessionId, (s) => ({ ...s, title: capped }));

      if (remote) {
        void fetch(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: capped }),
        }).catch(() => {
          // 改名失败不回滚：下次刷新会以服务端为准
        });
      }
    },
    [remote, updateSession],
  );

  return {
    sessions: ordered,
    activeId,
    activeSession: active,
    messages: active?.messages ?? [],
    streaming,
    streamingIds,
    getDraft,
    setDraft,
    editState,
    beginEdit,
    updateEditDraft,
    endEdit,
    rememberScroll,
    recallScroll,
    hydrated,
    messagesLoading,
    missingSessionId,
    send,
    stop,
    regenerate,
    editAndResend,
    continueGeneration,
    newSession,
    selectSession,
    syncFromUrl,
    deleteSession,
    renameSession,
  };
}
