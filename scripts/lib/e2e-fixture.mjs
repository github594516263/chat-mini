// e2e 用的数据准备：自己建自己的会话，跑完自己清理。
// 这样路由相关的回归脚本不再依赖任何"临时脚手架留下的固定 id"。
//
// 只认 `[e2e]` 前缀，绝不碰其它会话。

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq > 0) env[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return env;
}

const PREFIX = "[e2e]";

async function connect() {
  const env = loadEnv();
  return mysql.createConnection({
    host: env.DB_HOST || "127.0.0.1",
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: "utf8mb4",
    timezone: "Z",
  });
}

/** 建一条带消息的会话。返回 { id, title } */
export async function createFixtureSession(userId, title, messages = []) {
  const conn = await connect();
  try {
    const id = randomUUID();
    const now = new Date();
    const fullTitle = `${PREFIX} ${title}`;
    await conn.execute(
      "INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [id, userId, fullTitle, now, now],
    );

    let seq = 0;
    for (const [index, body] of messages.entries()) {
      seq += 1;
      await conn.execute(
        `INSERT INTO messages (id, session_id, seq, role, content, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)`,
        [
          randomUUID(),
          id,
          seq,
          index % 2 === 0 ? "user" : "assistant",
          body,
          new Date(now.getTime() + seq * 1000),
          new Date(now.getTime() + seq * 1000),
        ],
      );
    }
    return { id, title: fullTitle };
  } finally {
    await conn.end();
  }
}

export async function findUserId(username = "demo") {
  const conn = await connect();
  try {
    const [rows] = await conn.execute("SELECT id FROM users WHERE username = ? LIMIT 1", [username]);
    if (rows.length === 0) throw new Error(`用户 ${username} 不存在`);
    return rows[0].id;
  } finally {
    await conn.end();
  }
}

/** 软删除所有 `[e2e]` 会话（清理尸体，不动别人的数据） */
export async function purgeFixtures(userId) {
  const conn = await connect();
  try {
    const [result] = await conn.execute(
      "UPDATE chat_sessions SET deleted_at = NOW(3) WHERE user_id = ? AND title LIKE ? AND deleted_at IS NULL",
      [userId, `${PREFIX}%`],
    );
    return result.affectedRows;
  } finally {
    await conn.end();
  }
}

/** 默认取两条会话，各带一对消息，够验收用 */
export async function prepareFixtures() {
  const userId = await findUserId("demo");
  await purgeFixtures(userId);
  const A = await createFixtureSession(userId, "会话 A", [
    "这是 A 会话的第一条用户消息",
    "这是 A 会话的第一条助手回复",
  ]);
  const B = await createFixtureSession(userId, "会话 B", [
    "这是 B 会话的第一条用户消息",
    "这是 B 会话的第一条助手回复",
  ]);
  return { userId, A, B };
}
