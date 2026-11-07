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
export function useChat(options: { user?: ChatUser | null } = {}) {
  const userId = options.user?.id ?? null;
  const remote = Boolean(userId);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);

  /** 当前订阅的 AbortController（只掐订阅，不掐生成） */
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef<RunHandle | null>(null);
  /** 区分"用户点了停止"和"只是切走/关页面" */
  const stoppedByUserRef = useRef(false);
  const resumedRef = useRef<Set<string>>(new Set());
  const stateRef = useRef<{ sessions: ChatSession[]; activeId: string | null }>({
    sessions: [],
    activeId: null,
  });

  useEffect(() => {
    stateRef.current = { sessions, activeId };
  }, [sessions, activeId]);

  // ---------------------------------------------------------------- 水合

  // 首帧之后才读存储，避免 SSR / 水合不一致
  useEffect(() => {
    if (!remote) {
      const store = loadStore();
      if (store.sessions.length > 0) {
        setSessions(store.sessions);
        setActiveId(store.activeId ?? store.sessions[0].id);
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
        const saved = window.localStorage.getItem(activeKey(userId));
        setActiveId(list.some((s) => s.id === saved) ? saved : (list[0]?.id ?? null));
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
      abortRef.current = controller;
      stoppedByUserRef.current = false;
      setStreaming(true);
      runRef.current = { runId, sessionId, assistantId };

      try {
        await consumeRun(sessionId, assistantId, runId, startFrom, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          patchMessage(sessionId, assistantId, (m) => ({ ...m, error: message, pending: false }));
        }
      } finally {
        abortRef.current = null;
        runRef.current = null;
        setStreaming(false);
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
    [consumeRun, markInterrupted, patchMessage, refreshMessages],
  );

  /** 游客模式的建 run + 订阅。历史由调用方算好 */
  const startGuestRun = useCallback(
    async (sessionId: string, assistantId: string, history: ChatUIMessage[]) => {
      const controller = new AbortController();
      abortRef.current = controller;
      stoppedByUserRef.current = false;
      setStreaming(true);

      const payload: WireMessage[] = history
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payload }),
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
        runRef.current = { runId: data.runId, sessionId, assistantId };

        await consumeRun(sessionId, assistantId, data.runId, 0, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          patchMessage(sessionId, assistantId, (m) => ({ ...m, stopped: true }));
        } else {
          const message = error instanceof Error ? error.message : String(error);
          patchMessage(sessionId, assistantId, (m) => ({ ...m, error: message }));
        }
      } finally {
        abortRef.current = null;
        runRef.current = null;
        setStreaming(false);
        patchMessage(sessionId, assistantId, (m) => {
          if (!m.pending) return m;
          if (stoppedByUserRef.current) return { ...m, pending: false, stopped: true };
          // 只是切走会话/关页面：保留 pending + runId，回来还能续
          if (controller.signal.aborted) return m;
          return { ...m, pending: false, interrupted: !m.error };
        });
        updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }));
      }
    },
    [consumeRun, patchMessage, updateSession],
  );

  /** 登录模式：向服务端发起一个生成操作，拿回服务端分配的消息 id 再订阅 */
  const startRemoteOperation = useCallback(
    async (
      sessionId: string,
      body: { kind: "send"; content: string } | { kind: "regenerate" | "continue" | "edit"; messageId: string; content?: string },
      options: { truncateFrom?: string; dropMessagesAlso?: boolean } = {},
    ) => {
      if (abortRef.current) return;
      setStreaming(true);
      stoppedByUserRef.current = false;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, ...body }),
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
        setStreaming(false);
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
      if (!content || abortRef.current) return;

      const { sessions: currentSessions, activeId: currentActiveId } = stateRef.current;
      const session = currentSessions.find((s) => s.id === currentActiveId);
      if (!session) return;

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
      if (abortRef.current) return;
      const located = locate(assistantMessageId);
      if (!located) return;

      if (remote) {
        await startRemoteOperation(located.session.id, {
          kind: "regenerate",
          messageId: assistantMessageId,
        }, { truncateFrom: assistantMessageId });
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
    [locate, remote, startGuestRun, startRemoteOperation, updateSession],
  );

  /** 编辑重发：改掉那条用户消息，把它之后的全部内容丢弃后重发 */
  const editAndResend = useCallback(
    async (userMessageId: string, text: string) => {
      const content = text.trim();
      if (!content || abortRef.current) return;
      const located = locate(userMessageId);
      if (!located) return;

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
    [locate, remote, startGuestRun, startRemoteOperation, updateSession],
  );

  /**
   * 继续生成（方案 A 的兜底）：把半截回答当上下文，让模型接着往下写。
   * 输出仍然落在同一条消息里，所以视觉上是"接着写"，不是另起一条。
   */
  const continueGeneration = useCallback(
    async (assistantMessageId: string) => {
      if (abortRef.current) return;
      const located = locate(assistantMessageId);
      if (!located) return;

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

  /** 停止：先让服务端真的停（否则 token 继续烧），再掐掉本地订阅 */
  const stop = useCallback(() => {
    stoppedByUserRef.current = true;
    const handle = runRef.current;
    if (handle) {
      void fetch("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: handle.runId }),
      }).catch(() => {
        // 取消失败不影响本地停止
      });
    }
    abortRef.current?.abort();
  }, []);

  // ---------------------------------------------------------------- 续传

  /** 把一条 status=streaming 的消息接上：前缀 + 重新回放这条 run 的增量 */
  const resumeRun = useCallback(
    (sessionId: string, message: ChatUIMessage) => {
      if (!message.runId || abortRef.current) return;
      if (resumedRef.current.has(message.runId)) return;
      resumedRef.current.add(message.runId);

      const controller = new AbortController();
      abortRef.current = controller;
      stoppedByUserRef.current = false;
      setStreaming(true);

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
          abortRef.current = null;
          setStreaming(false);
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
    [consumeRun, markInterrupted, patchMessage, refreshMessages, remote],
  );

  // 游客：从本地仓里找没跑完的 run 续上（数据本来就在本地）
  useEffect(() => {
    if (remote || !hydrated || !active) return;
    if (abortRef.current) return;
    const target = [...active.messages].reverse().find((m) => m.pending && m.runId);
    if (target) resumeRun(active.id, target);
  }, [active, hydrated, remote, resumeRun]);

  // 登录：切到哪个会话就拉哪份消息；拉到正在生成的消息就接上
  const loadMessages = useCallback(
    async (sessionId: string) => {
      setMessagesLoading(true);
      try {
        const messages = await refreshMessages(sessionId);
        if (!messages) return;
        const streamingMessage = [...messages].reverse().find((m) => m.pending && m.runId);
        if (streamingMessage) resumeRun(sessionId, streamingMessage);
      } finally {
        setMessagesLoading(false);
      }
    },
    [refreshMessages, resumeRun],
  );

  useEffect(() => {
    if (!remote || !hydrated || !active) return;
    if (active.loaded !== false) return;
    void loadMessages(active.id);
  }, [active, hydrated, loadMessages, remote]);

  const selectSession = useCallback((sessionId: string) => {
    // 只断订阅，不掐生成：切回来还能接着续
    abortRef.current?.abort();
    setActiveId(sessionId);
  }, []);

  const newSession = useCallback(() => {
    abortRef.current?.abort();

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
          // 把临时 id 换成服务端 id
          setSessions((prev) => prev.map((s) => (s.id === tempId ? real : s)));
          setActiveId((current) => (current === tempId ? real.id : current));
        } catch {
          setSessions((prev) => prev.filter((s) => s.id !== tempId));
          setActiveId((current) => (current === tempId ? (stateRef.current.sessions[0]?.id ?? null) : current));
        }
      })();

      return tempId;
    }

    const session = createSession();
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    return session.id;
  }, [remote]);

  const deleteSession = useCallback(
    (sessionId: string) => {
      abortRef.current?.abort();

      if (remote) {
        setSessions((prev) => {
          const remaining = prev.filter((s) => s.id !== sessionId);
          if (sessionId === stateRef.current.activeId) {
            setActiveId(remaining.length > 0 ? sortSessions(remaining)[0].id : null);
          }
          return remaining;
        });
        void fetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {
          // 删失败就以服务端为准，重新拉一次
        });
        if (stateRef.current.sessions.length <= 1) newSession();
        return;
      }

      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== sessionId);
        if (remaining.length === 0) {
          const session = createSession();
          setActiveId(session.id);
          return [session];
        }
        if (sessionId === stateRef.current.activeId) {
          const next = sortSessions(remaining)[0];
          setActiveId(next.id);
        }
        return remaining;
      });
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
    hydrated,
    messagesLoading,
    send,
    stop,
    regenerate,
    editAndResend,
    continueGeneration,
    newSession,
    selectSession,
    deleteSession,
    renameSession,
  };
}
