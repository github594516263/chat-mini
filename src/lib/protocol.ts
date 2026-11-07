/**
 * 自研类型化事件协议（对齐目标站 /messages/stream 的设计，先实现最小集合）。
 *
 * 传输格式：NDJSON —— 一行一个 JSON 事件，最后一个字符固定是 "\n"。
 * 每个事件带单调递增的 seq，客户端据此做去重与断线补读。
 */

export type ChatEvent =
  | { type: "delta"; delta: string }
  | { type: "think_delta"; delta: string }
  | { type: "usage"; prompt_tokens: number; completion_tokens: number }
  | { type: "completed"; finish_reason: "stop" | "length" | "aborted" }
  | { type: "error"; message: string }
  /**
   * 续传快照：服务端把旧事件压缩后，用一个"覆盖式"事件把已有正文一次性给客户端。
   * 客户端收到它就整体替换 content/thinking，而不是往后追加。
   */
  | { type: "sync"; content: string; thinking: string };

export type SeqEvent = ChatEvent & { seq: number };

export type ChatRole = "user" | "assistant";

/** 上行报文：只传协议需要的最小字段 */
export type WireMessage = { role: ChatRole; content: string };

export const STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export function encodeEvent(event: SeqEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function decodeEvent(line: string): SeqEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null) return null;
    if (typeof (value as { type?: unknown }).type !== "string") return null;
    return value as SeqEvent;
  } catch {
    return null;
  }
}

/** 把任意上行 body 收敛成干净的 WireMessage[]，脏数据直接丢掉。 */
export function sanitizeMessages(input: unknown): WireMessage[] {
  if (!Array.isArray(input)) return [];
  const out: WireMessage[] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const text = content.trim();
    if (!text) continue;
    out.push({ role, content: text });
  }
  return out;
}
