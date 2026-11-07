// P4 端到端：登录用户的生成走数据库
//   node scripts/e2e-chat-server.mjs
// 前置：dev 已启动，demo / demo2 账号存在
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const PASSWORD = process.env.E2E_PASS ?? "DemoPass2026!";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function loginCookie(username) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const line = (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("chat_session="));
  if (!line) throw new Error(`${username} 登录失败`);
  return line.split(";")[0];
}

function client(cookie) {
  const request = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* empty */
    }
    return { status: response.status, json };
  };
  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b ?? {}),
  };
}

const cookieA = await loginCookie("demo");
const cookieB = await loginCookie("demo2");
const A = client(cookieA);
const B = client(cookieB);

async function messageRow(id) {
  const [rows] = await conn.query(
    "SELECT content, thinking, status, prompt_tokens, completion_tokens, run_id FROM messages WHERE id = ?",
    [id],
  );
  return rows[0] ?? null;
}

// ---------- 1. 正常一轮：建会话 → 生成 → 定稿 ----------
const created = await A.post("/api/sessions", { title: "新对话" });
const sessionId = created.json?.session?.id;
check("建会话", Boolean(sessionId), sessionId ?? "");

const started = await A.post("/api/chat", {
  sessionId,
  content: "用三句话解释一下什么是数据库事务",
});
check(
  "登录用户 POST /api/chat → 200 mode=server",
  started.status === 200 && started.json?.mode === "server",
  `HTTP ${started.status} mode=${started.json?.mode}`,
);
const userMsg = started.json?.userMessage;
const assistantMsg = started.json?.assistantMessage;
check("返回用户消息 seq=1", userMsg?.seq === 1, `seq=${userMsg?.seq}`);
check(
  "返回助手占位消息 seq=2 status=streaming",
  assistantMsg?.seq === 2 && assistantMsg?.status === "streaming",
  `seq=${assistantMsg?.seq} status=${assistantMsg?.status}`,
);
check("会话标题按首条消息自动生成", started.json?.session?.title?.includes("数据库事务"), started.json?.session?.title ?? "");

// 订阅到结束
const streamResponse = await fetch(
  `${baseUrl}/api/chat/stream?runId=${started.json.runId}&afterSeq=0`,
  { headers: { Cookie: cookieA } },
);
const streamText = await streamResponse.text();
const events = streamText
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const streamedContent = events
  .filter((e) => e.type === "delta")
  .map((e) => e.delta)
  .join("");
check(
  "订阅拿到完整事件流",
  events.length > 0 && events.at(-1)?.type === "completed",
  `${events.length} 个事件，末事件 ${events.at(-1)?.type}`,
);

await sleep(600);
const finalRow = await messageRow(assistantMsg.id);
check(
  "落库内容与流式内容一致",
  finalRow?.content?.length === streamedContent.length && finalRow?.content === streamedContent,
  `库里 ${finalRow?.content?.length} 字 / 流里 ${streamedContent.length} 字`,
);
check("定稿状态 complete", finalRow?.status === "complete", `status=${finalRow?.status}`);
check("run_id 已清空", finalRow?.run_id === null, `run_id=${finalRow?.run_id}`);
check(
  "用量落库",
  typeof finalRow?.prompt_tokens === "number" || finalRow?.prompt_tokens === null,
  `prompt=${finalRow?.prompt_tokens} completion=${finalRow?.completion_tokens}`,
);

const [runRow] = await conn.query("SELECT status FROM runs WHERE id = ?", [started.json.runId]);
check("runs 表状态 done", runRow[0]?.status === "done", `status=${runRow[0]?.status}`);

const messagesAfter = await A.get(`/api/sessions/${sessionId}/messages`);
check(
  "messages 接口读到 2 条且顺序正确",
  (messagesAfter.json?.messages ?? []).map((m) => m.seq).join(",") === "1,2",
  (messagesAfter.json?.messages ?? []).map((m) => `${m.seq}:${m.role}`).join(" "),
);

// ---------- 2. 不订阅也在生成：证明生成不挂在连接上 + 1 秒节流落盘 ----------
const run2 = await A.post("/api/chat", {
  sessionId,
  content: "再详细写 600 字讲讲 MVCC 和隔离级别的关系，分多段。",
});
check("第二轮建 run", run2.status === 200, `HTTP ${run2.status}`);

await sleep(1600);
const midRow = await messageRow(run2.json.assistantMessage.id);
check(
  "无订阅者时仍在生成且已落半截正文",
  (midRow?.content?.length ?? 0) > 0 && midRow?.status === "streaming",
  `库里有 ${midRow?.content?.length ?? 0} 字，status=${midRow?.status}`,
);

const cancel = await A.post("/api/chat/cancel", { runId: run2.json.runId });
check("取消 → cancelled", cancel.status === 200 && cancel.json?.cancelled === true, JSON.stringify(cancel.json));

await sleep(1500);
const stoppedRow = await messageRow(run2.json.assistantMessage.id);
check(
  "取消后状态 stopped 且保留已输出内容",
  stoppedRow?.status === "stopped" && (stoppedRow?.content?.length ?? 0) > 0,
  `status=${stoppedRow?.status} 保留 ${stoppedRow?.content?.length} 字`,
);
const [runRow2] = await conn.query("SELECT status FROM runs WHERE id = ?", [run2.json.runId]);
check("runs 表状态 aborted", runRow2[0]?.status === "aborted", `status=${runRow2[0]?.status}`);

// ---------- 3. 越权：B 用 A 的 sessionId 发起生成 ----------
const cross = await B.post("/api/chat", { sessionId, content: "越权测试" });
check("B 用 A 的会话生成 → 404", cross.status === 404, `HTTP ${cross.status}`);

// ---------- 4. 游客路径仍然可用且不落库 ----------
const [[beforeCount]] = await conn.query("SELECT COUNT(*) AS n FROM messages");
const guest = await fetch(`${baseUrl}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "游客问一句" }] }),
});
const guestJson = await guest.json();
check(
  "游客 POST（messages 数组）→ 200 mode=guest",
  guest.status === 200 && guestJson.mode === "guest",
  `HTTP ${guest.status} mode=${guestJson.mode}`,
);
// 等它跑完，确认没有写库
await sleep(3000);
const [[afterCount]] = await conn.query("SELECT COUNT(*) AS n FROM messages");
check("游客生成不写库", beforeCount.n === afterCount.n, `${beforeCount.n} → ${afterCount.n}`);

// ---------- 5. 登录用户不带 sessionId 时给出明确提示 ----------
const noSession = await A.post("/api/chat", { messages: [{ role: "user", content: "缺 sessionId" }] });
check(
  "缺 sessionId 时降级为游客路径（不报错、不落库）",
  noSession.status === 200 && noSession.json?.mode === "guest",
  `mode=${noSession.json?.mode}`,
);

await conn.end();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
