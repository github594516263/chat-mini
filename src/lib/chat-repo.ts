import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { execute, query, queryOne, withTransaction } from "@/lib/db";

/**
 * 聊天会话与消息的数据访问层。
 *
 * 三条铁律（P3 的重点就在这里）：
 *   1. 每个查询都必须带 user_id。越权访问统一返回 null → 调用方转 404，
 *      不用 403 —— 403 等于告诉对方"这个 id 确实存在"。
 *   2. seq 在事务里算（MAX(seq)+1），靠 UNIQUE(session_id, seq) 兜底并发；
 *      撞了就重试一次，不在这里加锁。
 *   3. 时间统一由 JS 传入（连接池时区是 Z），不写 NOW()。
 */

export const TITLE_MAX_LENGTH = 120;
export const MESSAGE_PAGE_DEFAULT = 200;

export type SessionRow = RowDataPacket & {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type MessageRow = RowDataPacket & {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  thinking: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  status: "streaming" | "complete" | "interrupted" | "stopped" | "error";
  error_text: string | null;
  created_at: Date;
  updated_at: Date;
};

export type SessionDto = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type MessageDto = {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  thinking: string | null;
  status: MessageRow["status"];
  errorText: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
};

export type MessageStatus = MessageRow["status"];
export type MessageRole = MessageRow["role"];

/** 从首条消息推导标题：取第一行、合并空白、截断 */
export function deriveTitle(content: string): string {
  const firstLine = content.trim().split(/\r?\n/)[0] ?? "";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (!compact) return "新对话";
  return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact;
}

export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > TITLE_MAX_LENGTH ? title.slice(0, TITLE_MAX_LENGTH) : title;
}

function toSessionDto(row: SessionRow & { message_count?: number }): SessionDto {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messageCount: Number(row.message_count ?? 0),
  };
}

export function toMessageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    thinking: row.thinking,
    status: row.status,
    errorText: row.error_text,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------- 会话

/**
 * 列表。游标分页：cursor = "<updatedAt ISO>|<id>"。
 * 用 (updated_at, id) 复合游标而不是 offset：
 * offset 翻页要扫前面所有行，越翻越慢；游标永远只走索引。
 */
export async function listSessions(
  userId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<{ sessions: SessionDto[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursor = options.cursor ?? null;

  const params: (string | number | Date)[] = [userId];
  let cursorClause = "";
  if (cursor) {
    const [iso, id] = cursor.split("|");
    const at = new Date(iso ?? "");
    if (!Number.isNaN(at.getTime()) && id) {
      cursorClause = " AND (s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))";
      params.push(at, at, id);
    }
  }
  params.push(limit + 1);

  const rows = await query<SessionRow & { message_count: number }>(
    `SELECT s.id, s.title, s.created_at, s.updated_at, s.deleted_at,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM chat_sessions s
      WHERE s.user_id = ? AND s.deleted_at IS NULL${cursorClause}
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT ?`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    sessions: page.map(toSessionDto),
    nextCursor: hasMore && last ? `${last.updated_at.toISOString()}|${last.id}` : null,
  };
}

export async function getSession(userId: string, sessionId: string): Promise<SessionDto | null> {
  const row = await queryOne<SessionRow & { message_count: number }>(
    `SELECT s.id, s.title, s.created_at, s.updated_at, s.deleted_at,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM chat_sessions s
      WHERE s.id = ? AND s.user_id = ? AND s.deleted_at IS NULL
      LIMIT 1`,
    [sessionId, userId],
  );
  return row ? toSessionDto(row) : null;
}

export async function createSession(userId: string, title?: string | null): Promise<SessionDto> {
  const id = randomUUID();
  const now = new Date();
  const safeTitle = normalizeTitle(title) ?? "新对话";

  await execute(
    `INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [id, userId, safeTitle, now, now],
  );

  return { id, title: safeTitle, createdAt: now.toISOString(), updatedAt: now.toISOString(), messageCount: 0 };
}

/** 返回 false 表示"没有这个会话或不属于你"——调用方一律当 404 */
export async function renameSession(userId: string, sessionId: string, title: string): Promise<boolean> {
  const result = await execute(
    `UPDATE chat_sessions SET title = ?, updated_at = ? 
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    [title, new Date(), sessionId, userId],
  );
  return result.affectedRows > 0;
}

export async function softDeleteSession(userId: string, sessionId: string): Promise<boolean> {
  const result = await execute(
    `UPDATE chat_sessions SET deleted_at = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    [new Date(), sessionId, userId],
  );
  return result.affectedRows > 0;
}

// ---------------------------------------------------------------- 消息

export async function listMessages(
  userId: string,
  sessionId: string,
  options: { afterSeq?: number } = {},
): Promise<{ session: SessionDto; messages: MessageDto[] } | null> {
  const session = await getSession(userId, sessionId);
  if (!session) return null;

  const afterSeq = Number.isFinite(options.afterSeq) ? Number(options.afterSeq) : 0;
  const rows = await query<MessageRow>(
    `SELECT m.id, m.session_id, m.seq, m.role, m.content, m.thinking,
            m.prompt_tokens, m.completion_tokens, m.status, m.error_text,
            m.created_at, m.updated_at
       FROM messages m
      WHERE m.session_id = ? AND m.seq > ?
      ORDER BY m.seq ASC
      LIMIT ?`,
    [sessionId, afterSeq, MESSAGE_PAGE_DEFAULT],
  );

  return { session, messages: rows.map(toMessageDto) };
}

export type AppendMessageInput = {
  role: MessageRole;
  content: string;
  thinking?: string | null;
  status?: MessageStatus;
  errorText?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** 传入则视为"首条消息建会话" */
  sessionTitle?: string | null;
};

/**
 * 追加一条消息（P4 生成时用）。
 * seq 在事务里取 MAX+1；并发撞唯一索引时重试一次。
 */
export async function appendMessage(
  userId: string,
  sessionId: string,
  input: AppendMessageInput,
): Promise<MessageDto | null> {
  const now = new Date();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withTransaction(async (conn: PoolConnection) => {
        const [owned] = await conn.query<RowDataPacket[]>(
          `SELECT id FROM chat_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE`,
          [sessionId, userId],
        );
        if (owned.length === 0) return null;

        const [seqRows] = await conn.query<RowDataPacket[]>(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE session_id = ?`,
          [sessionId],
        );
        const seq = Number(seqRows[0]?.next_seq ?? 1);

        const id = randomUUID();
        await conn.query(
          `INSERT INTO messages (id, session_id, seq, role, content, thinking, prompt_tokens,
                                 completion_tokens, status, error_text, run_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          [
            id,
            sessionId,
            seq,
            input.role,
            input.content,
            input.thinking ?? null,
            input.promptTokens ?? null,
            input.completionTokens ?? null,
            input.status ?? "complete",
            input.errorText ?? null,
            now,
            now,
          ],
        );

        await conn.query(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, [now, sessionId]);

        return {
          id,
          seq,
          role: input.role,
          content: input.content,
          thinking: input.thinking ?? null,
          status: input.status ?? "complete",
          errorText: input.errorText ?? null,
          promptTokens: input.promptTokens ?? null,
          completionTokens: input.completionTokens ?? null,
          createdAt: now.toISOString(),
        } satisfies MessageDto;
      });
    } catch (error) {
      // 并发写了同一个 seq：唯一索引拦住，重算一次
      if ((error as { code?: string }).code === "ER_DUP_ENTRY" && attempt === 0) continue;
      throw error;
    }
  }
  return null;
}

export async function updateMessage(
  userId: string,
  sessionId: string,
  messageId: string,
  patch: {
    content?: string;
    thinking?: string | null;
    status?: MessageStatus;
    errorText?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    clearRun?: boolean;
  },
): Promise<boolean> {
  const sets: string[] = [];
  const params: (string | number | Date | null)[] = [];

  // 列名必须带 m. 前缀：messages 和 chat_sessions 都有 updated_at，
  // 不限定表名会报 ER_NON_UNIQ_ERROR: Column 'updated_at' in field list is ambiguous
  if (patch.content !== undefined) {
    sets.push("m.content = ?");
    params.push(patch.content);
  }
  if (patch.thinking !== undefined) {
    sets.push("m.thinking = ?");
    params.push(patch.thinking);
  }
  if (patch.status !== undefined) {
    sets.push("m.status = ?");
    params.push(patch.status);
  }
  if (patch.errorText !== undefined) {
    sets.push("m.error_text = ?");
    params.push(patch.errorText);
  }
  if (patch.promptTokens !== undefined) {
    sets.push("m.prompt_tokens = ?");
    params.push(patch.promptTokens);
  }
  if (patch.completionTokens !== undefined) {
    sets.push("m.completion_tokens = ?");
    params.push(patch.completionTokens);
  }
  if (patch.clearRun) sets.push("m.run_id = NULL");
  if (sets.length === 0) return false;

  sets.push("m.updated_at = ?");
  params.push(new Date());

  // 归属校验放在 SQL 里：会话不是这个人的，就一条都影响不到
  const result = await execute(
    `UPDATE messages m
       JOIN chat_sessions s ON s.id = m.session_id
        SET ${sets.join(", ")}
      WHERE m.id = ? AND m.session_id = ? AND s.user_id = ? AND s.deleted_at IS NULL`,
    [...params, messageId, sessionId, userId],
  );
  return result.affectedRows > 0;
}

// ---------------------------------------------------------------- 生成任务（runs）

export type RunRowStatus = "running" | "done" | "error" | "aborted";

/** 建 run 时落一行元信息：进程重启后据此把没写完的回答标成 interrupted */
export async function createRunRow(input: {
  id: string;
  userId: string;
  sessionId: string;
  messageId: string;
}): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO runs (id, user_id, session_id, message_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    [input.id, input.userId, input.sessionId, input.messageId, now, now],
  );
}

export async function finishRunRow(runId: string, status: RunRowStatus): Promise<void> {
  await execute(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`, [status, new Date(), runId]);
}

/**
 * 启动清理（P4 的核心之一）：
 * 上一进程留下的 status='running' 不可能还活着 —— 生成跑在内存里，进程一没就断了。
 * 所以把它们对应的消息标成 interrupted，让界面显示"生成中断 + 继续生成"，
 * 而不是留一个永远转圈的 streaming。
 */
export async function markStaleRuns(): Promise<{ messages: number; runs: number }> {
  const now = new Date();

  const messages = await execute(
    `UPDATE messages m
       JOIN runs r ON r.message_id = m.id
        SET m.status = 'interrupted', m.run_id = NULL, m.updated_at = ?
      WHERE r.status = 'running' AND m.status = 'streaming'`,
    [now],
  );

  // 没有对应 run 行、但仍卡在 streaming 的消息（极端情况：建完消息进程就崩了）
  const orphans = await execute(
    `UPDATE messages SET status = 'interrupted', run_id = NULL, updated_at = ?
      WHERE status = 'streaming'
        AND id NOT IN (SELECT message_id FROM runs WHERE status = 'running' AND message_id IS NOT NULL)`,
    [now],
  );

  const runs = await execute(`UPDATE runs SET status = 'error', updated_at = ? WHERE status = 'running'`, [now]);

  return { messages: messages.affectedRows + orphans.affectedRows, runs: runs.affectedRows };
}

/** 给 provider 的历史：只要 role + 有内容的正文，取最近 N 条再按 seq 正序返回 */
export async function listHistory(
  userId: string,
  sessionId: string,
  limit = 100,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await query<RowDataPacket & { role: string; content: string }>(
    `SELECT t.role, t.content FROM (
       SELECT m.seq, m.role, m.content
         FROM messages m
         JOIN chat_sessions s ON s.id = m.session_id
        WHERE m.session_id = ? AND s.user_id = ? AND m.content <> '' AND m.status <> 'streaming'
        ORDER BY m.seq DESC
        LIMIT ?
     ) t ORDER BY t.seq ASC`,
    [sessionId, userId, limit],
  );

  return rows.map((row) => ({
    role: row.role === "user" ? "user" : "assistant",
    content: row.content,
  }));
}

// ---------------------------------------------------------------- 搜索

export type SearchHit = { session: SessionDto; snippet: string | null; matchedIn: "title" | "content" };

/**
 * 搜索：标题用 LIKE（能走索引前缀），正文用 ngram 全文索引。
 * 分成两条 SQL 再在 JS 里合并 —— 比写一个 OR 的大查询更容易看懂，
 * 而且两条各自都能用上自己的索引。
 */
export async function searchSessions(userId: string, rawQuery: string, limit = 30): Promise<SearchHit[]> {
  const q = rawQuery.replace(/\s+/g, " ").trim();
  if (!q) return [];
  const capped = Math.min(Math.max(limit, 1), 50);
  const hits = new Map<string, SearchHit>();

  // ① 标题命中
  const titleRows = await query<SessionRow & { message_count: number }>(
    `SELECT s.id, s.title, s.created_at, s.updated_at, s.deleted_at,
            (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = s.id) AS message_count
       FROM chat_sessions s
      WHERE s.user_id = ? AND s.deleted_at IS NULL AND s.title LIKE ?
      ORDER BY s.updated_at DESC
      LIMIT ?`,
    [userId, `%${q}%`, capped],
  );
  for (const row of titleRows) {
    hits.set(row.id, { session: toSessionDto(row), snippet: null, matchedIn: "title" });
  }

  // ② 正文命中（ngram 分词，2 字以上才有意义）
  if (q.length >= 2) {
    const contentRows = await query<
      SessionRow & { message_count: number; snippet: string | null; hit_seq: number }
    >(
      `SELECT s.id, s.title, s.created_at, s.updated_at, s.deleted_at,
              (SELECT COUNT(*) FROM messages m3 WHERE m3.session_id = s.id) AS message_count,
              SUBSTRING(m.content, GREATEST(1, LOCATE(?, m.content) - 20), 100) AS snippet,
              m.seq AS hit_seq
         FROM messages m
         JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.user_id = ? AND s.deleted_at IS NULL
          AND MATCH(m.content) AGAINST (? IN NATURAL LANGUAGE MODE)
        ORDER BY m.seq ASC
        LIMIT ?`,
      [q, userId, q, capped],
    );

    for (const row of contentRows) {
      if (hits.has(row.id)) continue; // 标题已经命中过，保留标题那条
      hits.set(row.id, {
        session: toSessionDto(row),
        snippet: row.snippet ? row.snippet.replace(/\s+/g, " ").trim() : null,
        matchedIn: "content",
      });
    }
  }

  return [...hits.values()].slice(0, capped);
}
