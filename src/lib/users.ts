import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";

import { execute, queryOne } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";

/**
 * 账号的数据访问层。只做 SQL + 校验，不碰 cookie。
 */

export type UserRow = RowDataPacket & {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  disabled: number | boolean;
};

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
};

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/** 统一小写，避免 "Alice" 和 "alice" 被当成两个账号 */
export function normalizeUsername(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function validateUsername(
  raw: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = normalizeUsername(raw);
  if (value.length < USERNAME_MIN_LENGTH || value.length > USERNAME_MAX_LENGTH) {
    return { ok: false, message: `用户名需要 ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} 个字符` };
  }
  // 只允许字母数字下划线连字符：不引入空格/emoji/全角字符，省掉后续一堆归一化麻烦
  if (!/^[a-z0-9_-]+$/.test(value)) {
    return { ok: false, message: "用户名只能包含字母、数字、下划线、连字符" };
  }
  return { ok: true, value };
}

export function toPublicUser(row: Pick<UserRow, "id" | "username" | "display_name">): PublicUser {
  return { id: row.id, username: row.username, displayName: row.display_name || row.username };
}

export async function findUserByUsername(username: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `SELECT id, username, display_name, password_hash, disabled
       FROM users WHERE username = ? LIMIT 1`,
    [username],
  );
}

export async function createUser(input: {
  username: string;
  password: string;
  displayName?: string;
}): Promise<PublicUser> {
  const id = randomUUID();
  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  await execute(
    `INSERT INTO users (id, username, display_name, password_hash, created_at, disabled)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [id, input.username, input.displayName?.trim() || input.username, passwordHash, now],
  );

  return { id, username: input.username, displayName: input.displayName?.trim() || input.username };
}

/**
 * 校验账号密码。
 * 注意：用户不存在时也走一次「假验证」，让耗时相近，
 * 避免通过响应时间判断某个用户名是否存在。
 */
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<PublicUser | null> {
  const row = await findUserByUsername(username);

  if (!row) {
    await hashPassword(password).catch(() => undefined);
    return null;
  }
  if (row.disabled) return null;

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;

  return toPublicUser(row);
}

export async function markLogin(userId: string): Promise<void> {
  await execute(`UPDATE users SET last_login_at = ? WHERE id = ?`, [new Date(), userId]);
}
