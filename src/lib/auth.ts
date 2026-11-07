import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { RowDataPacket } from "mysql2/promise";

import { execute, query, queryOne } from "@/lib/db";
import type { PublicUser } from "@/lib/users";

/**
 * 登录会话（auth_sessions）。
 *
 * 设计要点：
 * - cookie 里放的是 32 字节随机 token；数据库里只存 sha256(token)。
 *   万一库被拖走，拿到的哈希不能直接当 cookie 用。
 * - cookie 属性 HttpOnly（JS 读不到 → XSS 偷不走）+ SameSite=Lax（挡 CSRF）。
 * - 7 天有效。在路由处理器里调用 getCurrentUser({ renew: true }) 会滑动续期；
 *   在 Server Component 里不能写 cookie，所以那里只更新 last_seen_at。
 */

export const SESSION_COOKIE = "chat_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 剩余有效期不足一半时续期，避免每个请求都写库 */
const RENEW_THRESHOLD_MS = SESSION_TTL_MS / 2;

type SessionRow = RowDataPacket & {
  session_id: string;
  expires_at: Date;
  user_id: string;
  username: string;
  display_name: string;
  disabled: number | boolean;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  await execute(
    `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      userId,
      hashToken(token),
      now,
      expiresAt,
      now,
      (meta.userAgent ?? "").slice(0, 255),
      (meta.ip ?? "").slice(0, 45),
    ],
  );

  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // 本地是 http://localhost，加了 Secure 浏览器根本不会存
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}

export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value || null;
}

export async function deleteSessionByToken(token: string): Promise<void> {
  await execute(`DELETE FROM auth_sessions WHERE token_hash = ?`, [hashToken(token)]);
}

export type SessionUser = PublicUser & { sessionId: string };

/**
 * 读当前登录用户。
 * renew=true 时顺带滑动续期（只能在路由处理器里用，Server Component 里写 cookie 会抛错）。
 */
export async function getCurrentUser(options: { renew?: boolean } = {}): Promise<SessionUser | null> {
  let token: string | null = null;
  try {
    token = await readSessionToken();
  } catch {
    // 在 Server Component 之外的某些上下文里 cookies() 不可用，当作未登录
    return null;
  }
  if (!token) return null;

  let row: SessionRow | null = null;
  try {
    row = await queryOne<SessionRow>(
      `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.username, u.display_name, u.disabled
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
        LIMIT 1`,
      [hashToken(token), new Date()],
    );
  } catch {
    // 数据库不可用时不要让人整站 500，退化成"未登录"
    return null;
  }
  if (!row || row.disabled) return null;

  const now = new Date();
  const remaining = row.expires_at.getTime() - now.getTime();
  const shouldRenew = options.renew === true && remaining < RENEW_THRESHOLD_MS;

  // 更新活跃时间 + 按需续期，失败不影响这次请求
  void (async () => {
    try {
      if (shouldRenew) {
        const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
        await execute(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`, [
          now,
          expiresAt,
          row!.session_id,
        ]);
        await setSessionCookie(token!, expiresAt);
      } else {
        await execute(`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`, [now, row!.session_id]);
      }
    } catch {
      // 续期失败不影响本次请求，下次请求再试
    }
  })();

  return {
    id: row.user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    sessionId: row.session_id,
  };
}

/** 清掉过期登录会话。启动时 + 每次登录时顺手跑一次，成本极低。 */
export async function sweepExpiredSessions(): Promise<number> {
  try {
    const rows = await query<RowDataPacket & { n: number }>(
      `SELECT COUNT(*) AS n FROM auth_sessions WHERE expires_at <= ?`,
      [new Date()],
    );
    const stale = Number(rows[0]?.n ?? 0);
    if (stale > 0) await execute(`DELETE FROM auth_sessions WHERE expires_at <= ?`, [new Date()]);
    return stale;
  } catch {
    return 0;
  }
}

/** 当前用户登录过哪些设备（用于"踢设备"） */
export async function listUserSessions(userId: string) {
  return query<
    RowDataPacket & {
      id: string;
      created_at: Date;
      last_seen_at: Date;
      user_agent: string;
      ip: string;
    }
  >(
    `SELECT id, created_at, last_seen_at, user_agent, ip
       FROM auth_sessions
      WHERE user_id = ? AND expires_at > ?
      ORDER BY last_seen_at DESC`,
    [userId, new Date()],
  );
}
