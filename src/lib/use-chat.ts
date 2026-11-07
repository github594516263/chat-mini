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

/** 续写用的隐藏指令：不展示在界面里，只发给模型 */
const CONTINUE_PROMPT =
  "（上一条回答因为刷新或断网中断了。请紧接着断掉的地方继续写下去，不要重复已经输出过的内容，也不要重新开头。）";

type RunHandle = { runId: string; sessionId: string; assistantId: string };

/**
 * 会话 + 生成的唯一状态源。
 *
 * 生成模型（方案 B）：POST /api/chat 建 run → 生成跑在服务端 → 客户端用
 * runId + appliedSeq 订阅 /api/chat/stream。刷新只影响"订阅"，不影响"生成"，
 * 回来带上水位就能续传。appliedSeq 和正文写在同一条消息里，落盘天然原子。
 */
export function useChat() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [hydrated, setHydrated] = useState(false);

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

  // 首帧之后才读 localStorage，避免 SSR / 水合不一致
  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveStore({ sessions, activeId });
  }, [sessions, activeId, hydrated]);

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
            return { ...m, content: m.content + event.delta, appliedSeq: event.seq, interrupted: false };
          case "think_delta":
            return { ...m, thinking: (m.thinking ?? "") + event.delta, appliedSeq: event.seq };
          case "usage":
            return {
              ...m,
              usage: { prompt_tokens: event.prompt_tokens, completion_tokens: event.completion_tokens },
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

  /** 建 run + 订阅。历史由调用方算好，send/regenerate/editAndResend/继续 共用 */
  const startRun = useCallback(
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

      await startRun(sessionId, assistantId, history);
    },
    [startRun, updateSession],
  );

  /** 重新生成：丢掉这条助手消息，用它前面最近的那条用户消息重发 */
  const regenerate = useCallback(
    async (assistantMessageId: string) => {
      if (abortRef.current) return;
      const located = locate(assistantMessageId);
      if (!located) return;

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

      await startRun(session.id, assistantId, history);
    },
    [locate, startRun, updateSession],
  );

  /** 编辑重发：改掉那条用户消息，把它之后的全部内容丢弃后重发 */
  const editAndResend = useCallback(
    async (userMessageId: string, text: string) => {
      const content = text.trim();
      if (!content || abortRef.current) return;
      const located = locate(userMessageId);
      if (!located) return;

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

      await startRun(session.id, assistantId, history);
    },
    [locate, startRun, updateSession],
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

      await startRun(session.id, assistantMessageId, history);
    },
    [locate, patchMessage, startRun, updateSession],
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

  // 刷新/重新进入后：如果还有跑着的 run，带着水位自动续上
  useEffect(() => {
    if (!hydrated || !active) return;
    if (abortRef.current) return;

    const target = [...active.messages].reverse().find((m) => m.pending && m.runId);
    if (!target?.runId) return;
    if (resumedRef.current.has(target.runId)) return;
    resumedRef.current.add(target.runId);

    const sessionId = active.id;
    const messageId = target.id;
    const runId = target.runId;
    const fromSeq = target.appliedSeq ?? 0;
    const controller = new AbortController();
    abortRef.current = controller;
    stoppedByUserRef.current = false;
    setStreaming(true);

    void (async () => {
      try {
        await consumeRun(sessionId, messageId, runId, fromSeq, controller.signal);
      } catch {
        markInterrupted(sessionId, messageId);
      } finally {
        abortRef.current = null;
        setStreaming(false);
        patchMessage(sessionId, messageId, (m) =>
          m.pending ? { ...m, pending: false, interrupted: !m.error } : m,
        );
      }
    })();
  }, [active, consumeRun, hydrated, markInterrupted, patchMessage]);

  const selectSession = useCallback((sessionId: string) => {
    // 只断订阅，不掐生成：切回来还能接着续
    abortRef.current?.abort();
    setActiveId(sessionId);
  }, []);

  const newSession = useCallback(() => {
    abortRef.current?.abort();
    const session = createSession();
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    return session.id;
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    abortRef.current?.abort();
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
  }, []);

  /** 重命名：不改 updatedAt，避免仅仅改个名字就把会话顶到列表最前 */
  const renameSession = useCallback(
    (sessionId: string, title: string) => {
      const next = title.replace(/\s+/g, " ").trim();
      if (!next) return;
      updateSession(sessionId, (s) => ({
        ...s,
        title: next.length > 40 ? `${next.slice(0, 40)}…` : next,
      }));
    },
    [updateSession],
  );

  return {
    sessions: ordered,
    activeId,
    activeSession: active,
    messages: active?.messages ?? [],
    streaming,
    hydrated,
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
