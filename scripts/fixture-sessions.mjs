// 造测试数据（只用于 P3 验证，不属于应用逻辑）
//   node scripts/fixture-sessions.mjs
// 会给 demo 和 demo2 各插几个会话与消息；重复执行会先清掉旧的 fixture 会话。

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const conn = await mysql.createConnection({
  host: env.DB_HOST || "127.0.0.1",
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  charset: "utf8mb4",
  timezone: "Z",
});

async function userId(username) {
  const [rows] = await conn.query("SELECT id FROM users WHERE username = ?", [username]);
  if (rows.length === 0) throw new Error(`用户 ${username} 不存在，先跑 node scripts/create-user.mjs ${username}`);
  return rows[0].id;
}

// 先清掉上次的 fixture（按标题前缀识别，不动真实数据）
await conn.query(`DELETE FROM chat_sessions WHERE title LIKE '[fixture]%'`);

const demoId = await userId("demo");
const demo2Id = await userId("demo2");

const base = Date.now();
const fixtures = [
  {
    user: demoId,
    title: "[fixture] 断线续传是怎么实现的",
    messages: [
      ["user", "刷新浏览器后生成就断了，怎么回事？"],
      ["assistant", "因为生成挂在 HTTP 连接上。现在改成服务端 run + seq 水位，刷新后从断点续传。"],
      ["user", "那服务端重启呢？"],
      ["assistant", "上游 SSE 连接断了就是断了，MySQL 存不下正在跑的流，只能标成生成中断。"],
    ],
  },
  {
    user: demoId,
    title: "[fixture] React 防抖 hook",
    messages: [
      ["user", "写一个 React 的防抖 hook"],
      ["assistant", "用 useEffect + setTimeout，注意清理定时器，否则依赖变化会泄漏。"],
    ],
  },
  {
    user: demoId,
    title: "[fixture] Rust 所有权讲解",
    messages: [
      ["user", "Rust 所有权是什么"],
      ["assistant", "每个值有唯一所有者，离开作用域就释放；借用检查器保证引用不悬垂。"],
    ],
  },
  {
    user: demo2Id,
    title: "[fixture] demo2 的私密会话",
    messages: [
      ["user", "这是 demo2 的私有内容"],
      ["assistant", "demo 用户不应该能搜到这句话：独一无二的暗号是 紫色河马。"],
    ],
  },
];

let inserted = 0;
for (let index = 0; index < fixtures.length; index += 1) {
  const item = fixtures[index];
  const sessionId = randomUUID();
  // 让 updated_at 拉开，便于测排序
  const at = new Date(base - index * 60_000);

  await conn.query(
    `INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [sessionId, item.user, item.title, at, at],
  );

  let seq = 1;
  for (const [role, content] of item.messages) {
    await conn.query(
      `INSERT INTO messages (id, session_id, seq, role, content, thinking, prompt_tokens,
                             completion_tokens, status, error_text, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'complete', NULL, NULL, ?, ?)`,
      [randomUUID(), sessionId, seq, role, content, at, at],
    );
    seq += 1;
  }
  inserted += 1;
  console.log(`+ ${item.title}（${item.messages.length} 条消息）`);
}

await conn.end();
console.log(`\n共插入 ${inserted} 个 fixture 会话`);
