// 清掉端到端测试造出来的会话（软删除，可恢复）
//   node scripts/clean-test-data.mjs            # 只列出会被清理的
//   node scripts/clean-test-data.mjs --apply    # 真的删
//
// 只认固定前缀/固定提示词，不碰任何其它会话。
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

/** 测试脚本固定用过的提示词 / 标题 */
const TEST_TITLES = [
  "[fixture]%",
  "[spike]%",
  "用大约%",
  "用三句话解释一下什么是数据库事务%",
  "用一句话解释什么是数据库索引%",
  "详细写 900 字讲解 InnoDB 的 Buffer Pool%",
  "详细写 800 字讲讲 MySQL 的 redo log%",
  "改名验证%",
  "缺 sessionId%",
];

const apply = process.argv.includes("--apply");

const conn = await mysql.createConnection({
  host: env.DB_HOST || "127.0.0.1",
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  charset: "utf8mb4",
  timezone: "Z",
});

const where = TEST_TITLES.map(() => "s.title LIKE ?").join(" OR ");
const params = TEST_TITLES;

const [rows] = await conn.query(
  `SELECT s.id, u.username, s.title, s.created_at
     FROM chat_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.deleted_at IS NULL AND (${where})
    ORDER BY u.username, s.created_at`,
  params,
);

if (rows.length === 0) {
  console.log("没有测试会话需要清理。");
} else {
  console.log(`找到 ${rows.length} 个测试会话：\n`);
  for (const row of rows) {
    const at = row.created_at.toISOString().slice(5, 16).replace("T", " ");
    console.log(`  ${row.username.padEnd(7)} ${at}  ${row.title}`);
  }
}

if (!apply) {
  console.log("\n（这是预演。加 --apply 才会真的软删除）");
  await conn.end();
  process.exit(0);
}

const [result] = await conn.query(
  `UPDATE chat_sessions s JOIN users u ON u.id = s.user_id
      SET s.deleted_at = NOW(3)
    WHERE s.deleted_at IS NULL AND (${where})`,
  params,
);
console.log(`\n✅ 已软删除 ${result.affectedRows} 个会话（数据还在库里，deleted_at 有值）`);
console.log("恢复办法：UPDATE chat_sessions SET deleted_at = NULL WHERE deleted_at > NOW() - INTERVAL 1 HOUR;");

await conn.end();
process.exit(0);
