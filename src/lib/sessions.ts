/**
 * 会话存储层：一个 localStorage 槽位放全部会话 + 当前选中项。
 * 刻意不分片、不建索引——几百条会话的量级，整存整取最简单也最不容易坏。
 */

export type ChatUIMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: string;
  stopped?: boolean;
  pending?: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatUIMessage[];
};

export type ChatStore = {
  sessions: ChatSession[];
  activeId: string | null;
};

const STORE_KEY = "chat-mini/sessions/v1";
/** 上一版的单会话存储，加载时迁移一次然后删掉 */
const LEGACY_MESSAGES_KEY = "chat-mini/messages/v1";

const UNTITLED = "新对话";

export function newId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return Math.random().toString(36).slice(2);
}

/** 用首条用户消息当标题：去掉换行、压掉多余空格、截断 */
export function deriveTitle(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (!flat) return UNTITLED;
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

export function createSession(): ChatSession {
  const now = Date.now();
  return { id: newId(), title: UNTITLED, createdAt: now, updatedAt: now, messages: [] };
}

function isMessage(value: unknown): value is ChatUIMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<ChatUIMessage>;
  if (typeof m.id !== "string") return false;
  if (m.role !== "user" && m.role !== "assistant") return false;
  if (typeof m.content !== "string") return false;
  // 生成到一半被刷新留下的空壳，不值得恢复
  if (m.role === "assistant" && !m.content.trim() && !m.thinking) return false;
  return true;
}

function isSession(value: unknown): value is ChatSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<ChatSession>;
  if (typeof s.id !== "string") return false;
  if (!Array.isArray(s.messages)) return false;
  return true;
}

export function loadStore(): ChatStore {
  if (typeof window === "undefined") return { sessions: [], activeId: null };
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const store = parsed as { sessions?: unknown; activeId?: unknown };
        const sessions = Array.isArray(store.sessions)
          ? store.sessions.filter(isSession).map((session) => ({
              ...session,
              title: typeof session.title === "string" && session.title ? session.title : UNTITLED,
              createdAt: Number(session.createdAt) || Date.now(),
              updatedAt: Number(session.updatedAt) || Date.now(),
              messages: session.messages.filter(isMessage),
            }))
          : [];
        const activeId =
          typeof store.activeId === "string" && sessions.some((s) => s.id === store.activeId)
            ? store.activeId
            : (sessions[0]?.id ?? null);
        return { sessions, activeId };
      }
    }

    // 迁移上一版的单会话数据
    const legacy = window.localStorage.getItem(LEGACY_MESSAGES_KEY);
    if (legacy) {
      const parsed: unknown = JSON.parse(legacy);
      const messages = Array.isArray(parsed) ? parsed.filter(isMessage) : [];
      window.localStorage.removeItem(LEGACY_MESSAGES_KEY);
      if (messages.length > 0) {
        const firstUser = messages.find((m) => m.role === "user");
        const now = Date.now();
        const session: ChatSession = {
          id: newId(),
          title: firstUser ? deriveTitle(firstUser.content) : UNTITLED,
          createdAt: now,
          updatedAt: now,
          messages,
        };
        return { sessions: [session], activeId: session.id };
      }
    }
  } catch {
    // 数据坏了就当空的，别让聊天打不开
  }
  return { sessions: [], activeId: null };
}

export function saveStore(store: ChatStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // 隐私模式 / 配额满了：静默失败，不影响聊天
  }
}

/** 列表展示用：最近更新的在前 */
export function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}
