// 命令行建号 / 重置密码（因为注册接口默认关闭）
//
//   node scripts/create-user.mjs <用户名> [--display "显示名"] [--reset]
//
// 密码从终端交互输入（带掩码，不进 shell history、不进命令历史）。
// 哈希参数必须和 src/lib/password.ts 保持一致，否则登录永远失败。

import { randomBytes, randomUUID, scrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const N = 65536;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;
const MAX_MEM = 256 * 1024 * 1024;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const file = join(root, ".env.local");
  const env = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    console.error("找不到 .env.local，请先复制 .env.example 并填好数据库配置");
    process.exit(1);
  }
  return env;
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(SALT_BYTES);
    scrypt(password.normalize("NFKC"), salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM }, (error, key) => {
      if (error) reject(error);
      else resolve(`scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`);
    });
  });
}

/**
 * 非交互输入（管道/重定向）要按"行队列"读：
 * 一次 data 事件可能同时带来两行（密码 + 确认密码），
 * 如果每条读取各自挂一个监听器，第一行读完会把第二行一起吞掉。
 */
function makeLineReader(stream) {
  const queue = [];
  const waiters = [];
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
      index = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter(buffer);
      else queue.push(buffer);
      buffer = "";
    }
    while (waiters.length > 0) waiters.shift()(null);
  });

  return () =>
    new Promise((resolve) => {
      if (queue.length > 0) resolve(queue.shift());
      else waiters.push(resolve);
    });
}

const nextLine = makeLineReader(process.stdin);

/** TTY 下读一行并打星号 */
function readMaskedLine() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const onData = (chunk) => {
      const ch = chunk.toString();
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (ch === "\u0003") {
        process.stdout.write("\n已取消\n");
        process.exit(1);
      }
      if (ch === "\u007f" || ch === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      value += ch;
      process.stdout.write("*");
    };

    stdin.on("data", onData);
  });
}

async function readPassword(prompt) {
  process.stdout.write(prompt);
  if (process.stdin.isTTY) return readMaskedLine();

  const line = await nextLine();
  if (line === null) {
    console.error("\n没有读到输入");
    process.exit(1);
  }
  return line;
}

function parseArgs(argv) {
  const args = { username: null, display: null, reset: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--reset") args.reset = true;
    else if (item === "--display") args.display = argv[++i] ?? null;
    else if (!item.startsWith("--") && !args.username) args.username = item;
  }
  return args;
}

const { username: rawUsername, display, reset } = parseArgs(process.argv.slice(2));
if (!rawUsername) {
  console.error('用法: node scripts/create-user.mjs <用户名> [--display "显示名"] [--reset]');
  process.exit(1);
}

const username = rawUsername.trim().toLowerCase();
if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
  console.error("用户名需要 3–32 个字符，只能包含字母、数字、下划线、连字符");
  process.exit(1);
}

const password = await readPassword("设置密码（输入不回显）: ");if (password.length < 8) {
  console.error("密码至少 8 位");
  process.exit(1);
}
const again = await readPassword("再输一次: ");
if (password !== again) {
  console.error("两次输入不一致");
  process.exit(1);
}

const env = loadEnv();
const conn = await mysql.createConnection({
  host: env.DB_HOST || "127.0.0.1",
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  charset: "utf8mb4",
  timezone: "Z",
});

try {
  const [existing] = await conn.query("SELECT id FROM users WHERE username = ? LIMIT 1", [username]);
  const passwordHash = await hashPassword(password);
  const now = new Date();

  if (existing.length > 0) {
    if (!reset) {
      console.error(`用户 ${username} 已存在。要改密码加 --reset`);
      process.exitCode = 1;
    } else {
      await conn.query("UPDATE users SET password_hash = ? WHERE id = ?", [
        passwordHash,
        existing[0].id,
      ]);
      console.log(`✅ 已重置 ${username} 的密码`);
    }
  } else {
    const id = randomUUID();
    await conn.query(
      `INSERT INTO users (id, username, display_name, password_hash, created_at, disabled)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [id, username, display || username, passwordHash, now],
    );
    console.log(`✅ 已创建用户 ${username}（id=${id}）`);
    console.log("   现在可以去 /login 登录了");
  }
} catch (error) {
  if (error.code === "ECONNREFUSED") {
    console.error("连不上 MySQL：先 `net start MySQL94`，再检查 .env.local 的 DB_HOST/DB_PORT");
  } else if (error.code === "ER_NO_SUCH_TABLE") {
    console.error("表还没建：先执行 scripts/schema.sql");
  } else {
    console.error("失败：", error.message);
  }
  process.exitCode = 1;
} finally {
  await conn.end();
}
