"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { decodeEvent, type ChatEvent, type WireMessage } from "@/lib/protocol";
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

/**
 * 会话 + 流式的唯一状态源。
 *
 * 关键点：事件回填必须带 sessionId —— 用户在流式过程中切走会话时，
 * 增量不能串到另一个会话里。切会话时我们也会主动 abort。
 */
export function useChat() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
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

  const applyEvent = useCallback(
    (sessionId: string, messageId: string, event: ChatEvent) => {
      switch (event.type) {
        case "delta":
          patchMessage(sessionId, messageId, (m) => ({ ...m, content: m.content + event.delta }));
          break;
        case "think_delta":
          patchMessage(sessionId, messageId, (m) => ({
            ...m,
            thinking: (m.thinking ?? "") + event.delta,
          }));
          break;
        case "usage":
          patchMessage(sessionId, messageId, (m) => ({
            ...m,
            usage: { prompt_tokens: event.prompt_tokens, completion_tokens: event.completion_tokens },
          }));
          break;
        case "error":
          patchMessage(sessionId, messageId, (m) => ({ ...m, error: event.message }));
          break;
        case "completed":
          patchMessage(sessionId, messageId, (m) => ({
            ...m,
            pending: false,
            stopped: event.finish_reason === "aborted",
          }));
          break;
      }
    },
    [patchMessage],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    // 切走时终止当前生成：事件不再回填到旧会话，避免后台空转
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

  const deleteSession = useCallback(
    (sessionId: string) => {
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
    },
    [],
  );

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

  /** 把一段历史发出去并把事件流回填到 assistantId 这条消息上 */
  const streamInto = useCallback(
    async (sessionId: string, history: ChatUIMessage[], assistantId: string) => {
      const payload: WireMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

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
        if (!response.body) throw new Error("响应没有 body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastSeq = 0;

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
            // seq 幂等：重连/重复投递都靠这一行兜住
            if (typeof event.seq === "number" && event.seq <= lastSeq) continue;
            if (typeof event.seq === "number") lastSeq = event.seq;
            applyEvent(sessionId, assistantId, event);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          patchMessage(sessionId, assistantId, (m) => ({ ...m, error: message }));
        } else {
          patchMessage(sessionId, assistantId, (m) => ({ ...m, stopped: true }));
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
        patchMessage(sessionId, assistantId, (m) => ({ ...m, pending: false }));
        updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }));
      }
    },
    [applyEvent, patchMessage, updateSession],
  );

  /** 取当前会话 + 某个消息的下标，其它动作都基于它 */
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

      await streamInto(sessionId, history, assistantId);
    },
    [streamInto, updateSession],
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

      await streamInto(session.id, history, assistantId);
    },
    [locate, streamInto, updateSession],
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

      await streamInto(session.id, history, assistantId);
    },
    [locate, streamInto, updateSession],
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
    newSession,
    selectSession,
    deleteSession,
    renameSession,
  };
}
