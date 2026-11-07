// 【临时·路由改造 A/B 实测用】造大体量数据：60 个会话 × 20 条消息
//   node scripts/fixture-spike.mjs
// 只给 demo 用户造，按标题前缀 [spike] 识别，重复执行会先清掉上次的。
// 会话 id 写到 scripts/.spike-sessions.json 供测量脚本读取。

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

const [[demo]] = await conn.query("SELECT id FROM users WHERE username = 'demo'");
if (!demo) throw new Error("demo 用户不存在");
const demoId = demo.id;

await conn.query("DELETE FROM chat_sessions WHERE title LIKE '[spike]%'");

const SESSIONS = 60;
const MSGS = 20;
const BASE = Date.now();
const ids = [];

function body(round, index, role) {
  if (role === "user") {
    return `第 ${round} 轮提问：我们在做一个流式对话的应用，第 ${index} 个话题想请你分析一下 ` +
      `服务端 run 与 seq 水位在断线重连时的边界情况。举几个真实会踩到的例子，别只给结论。`;
  }
  return (
    `第 ${round} 轮回答。先说结论：run 表要能表达"这次生成归谁、开到哪",` +
    `seq 水位要能表达"客户端已经确认到哪"。两者分开存，才能做到断线后既不重复也不丢字。` +
    `\n\n` +
    `具体到实现，有三个细节容易漏：\n` +
    `第一，base_len 必须随 run 一起落库，否则续传时前端无法区分"旧内容"和"新内容",会重复拼接；\n` +
    `第二，run 结束时先写库再关流，顺序反了就会出现"库里还是 streaming 但流已经断了"的僵尸状态；\n` +
    `第三，进程重启后要把残留的 running 行批量标成 interrupted,否则用户看到一个永远转圈的按钮。\n\n` +
    `至于第 ${index} 个话题里提到的并发场景，建议按会话维度加一把轻量锁，别用全局锁——` +
    `全局锁会让两个不同会话的生成互相排队，体感很差。`
  );
}

for (let s = 0; s < SESSIONS; s += 1) {
  const sessionId = randomUUID();
  const at = new Date(BASE - s * 60_000);
  await conn.query(
    `INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [sessionId, demoId, `[spike] 压力测试会话 ${String(s).padStart(2, "0")}`, at, at],
  );

  const rows = [];
  for (let m = 0; m < MSGS; m += 1) {
    const role = m % 2 === 0 ? "user" : "assistant";
    rows.push([randomUUID(), sessionId, m + 1, role, body(Math.floor(m / 2) + 1, s + 1, role), at, at]);
  }
  await conn.query(
    `INSERT INTO messages (id, session_id, seq, role, content, thinking, prompt_tokens,
                           completion_tokens, status, error_text, run_id, created_at, updated_at)
     VALUES ${rows.map(() => "(?, ?, ?, ?, ?, NULL, NULL, NULL, 'complete', NULL, NULL, ?, ?)").join(",")}`,
    rows.flat(),
  );
  ids.push(sessionId);
}

writeFileSync(join(root, "scripts", ".spike-sessions.json"), JSON.stringify(ids, null, 2));

const [[count]] = await conn.query("SELECT COUNT(*) n FROM messages m JOIN chat_sessions s ON s.id = m.session_id WHERE s.title LIKE '[spike]%'");
await conn.end();
console.log(`插入 ${SESSIONS} 个会话 / ${count.n} 条消息（demo）`);
