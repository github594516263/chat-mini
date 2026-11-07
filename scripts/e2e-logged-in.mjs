// P5 端到端：登录用户走服务端（浏览器里真实操作）
//   node scripts/e2e-logged-in.mjs
// 前置：dev 已启动、demo 账号存在
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const port = Number(process.env.CDP_PORT ?? 9250);
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
/** 取第一行（mysql2 的 query 返回 [rows, fields]，少一层括号就会拿到 undefined） */
const one = async (sql, params = []) => (await conn.query(sql, params))[0][0];
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- CDP ----
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pendingCalls = new Map();
let seq = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pendingCalls.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pendingCalls.has(msg.id)) {
    const { resolve, reject } = pendingCalls.get(msg.id);
    pendingCalls.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await call("Page.enable");
await call("Runtime.enable");

const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};

const goto = async (path) => {
  await call("Page.navigate", { url: `${baseUrl}${path}` });
  await sleep(1600);
};

/** 页面快照：侧栏标题、当前正文、是否生成中、按钮状态 */
const snapshot = () =>
  evaluate(`(() => {
    const main = document.querySelector('main');
    const aside = document.querySelector('aside');
    const bubbles = [...main.querySelectorAll('[data-role]')].map((el) => ({
      role: el.getAttribute('data-role'),
      len: (el.innerText || '').trim().length,
      text: (el.innerText || '').trim().slice(0, 40),
    }));
    const sidebarTitles = aside
      ? [...aside.querySelectorAll('button, a, div')]
          .map((el) => (el.textContent || '').trim())
          .filter((t) => t && t.length < 60)
      : [];
    return {
      url: location.pathname,
      bubbles,
      streaming: !!document.querySelector('button[aria-label="停止生成"]'),
      sidebarText: aside ? (aside.innerText || '').replace(/\\s+/g, ' ') : '',
      hasContinue: [...document.querySelectorAll('main button')].some((b) => b.textContent.includes('继续生成')),
      hasRegen: !!document.querySelector('button[aria-label="重新生成"]'),
      emptyHero: (main.innerText || '').includes('有什么可以帮你的'),
      sidebarTitles,
    };
  })()`);

const waitIdle = async (timeoutMs = 60000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const busy = await evaluate(`!!document.querySelector('button[aria-label="停止生成"]')`);
    if (!busy) return true;
    await sleep(500);
  }
  return false;
};

// ---- 1. 登录 ----
await goto("/login");
const alreadyIn = (await evaluate("location.pathname")) === "/";
if (!alreadyIn) {
  await evaluate(`(() => {
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')];
    setValue(inputs[0], 'demo');
    setValue(inputs[1], ${JSON.stringify(PASSWORD)});
    document.querySelector('form button[type="submit"]').click();
  })()`);
  await sleep(2500);
}
const afterLogin = await evaluate("location.pathname");
check("登录成功并跳到聊天页", afterLogin === "/", `path=${afterLogin}${alreadyIn ? "（原本已登录）" : ""}`);

// ---- 2. 会话列表来自服务端 ----
const serverCount = (
  await one(
    `SELECT COUNT(*) AS n FROM chat_sessions s JOIN users u ON u.id = s.user_id
      WHERE u.username = 'demo' AND s.deleted_at IS NULL`,
  )
).n;
const initial = await snapshot();
check(
  "侧栏显示服务端的会话（不是空白）",
  initial.sidebarText.includes("fixture") || serverCount > 0,
  `库里 ${serverCount} 个会话`,
);

// ---- 3. 新建会话并发送 ----
await evaluate(`document.querySelector('[aria-label="新对话"]').click()`);
await sleep(900);
await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '用两句话解释 MySQL 的 MVCC');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
})()`);
await sleep(300);
await evaluate(`document.querySelector('button[aria-label="发送"]').click()`);
await sleep(1200);
const duringStream = await snapshot();
check("发送后进入生成状态", duringStream.streaming, `streaming=${duringStream.streaming}`);
const idle = await waitIdle();
check("生成正常结束", idle);
const done = await snapshot();
check(
  "页面上有一问一答",
  done.bubbles.length === 2 && done.bubbles[0].role === "user" && done.bubbles[1].role === "assistant",
  done.bubbles.map((b) => `${b.role}:${b.len}`).join(" "),
);

// ---- 4. 关键：刷新后消息还在（服务端为真相） ----
const lenBefore = done.bubbles[1].len;
await goto("/");
await sleep(1500);
const afterReload = await snapshot();
check(
  "刷新后消息仍在（服务端持久化）",
  afterReload.bubbles.length === 2 && afterReload.bubbles[1].len > 0,
  `刷新前 ${lenBefore} 字 / 刷新后 ${afterReload.bubbles[1].len} 字`,
);

// 换一个"新浏览器"（清掉 localStorage 缓存）再刷新：仍然能看到，说明不是本地缓存撑着的
await evaluate("window.localStorage.clear()");
await goto("/");
await sleep(1500);
const afterClear = await snapshot();
check(
  "清空 localStorage 后刷新仍能读回（真的在服务端）",
  afterClear.bubbles.length === 2,
  `${afterClear.bubbles.length} 条消息`,
);

// ---- 5. 直接查库确认 ----
const [rows] = await conn.query(
  `SELECT m.role, m.status, CHAR_LENGTH(m.content) AS len
     FROM messages m JOIN chat_sessions s ON s.id = m.session_id
     JOIN users u ON u.id = s.user_id
    WHERE u.username = 'demo' AND s.title LIKE '用两句话%'
    ORDER BY m.seq`,
);
check(
  "库里有一问一答且状态 complete",
  rows.length === 2 && rows.every((r) => r.status === "complete") && rows[1].len > 0,
  rows.map((r) => `${r.role}:${r.len}:${r.status}`).join(" "),
);

// ---- 6. 重新生成 ----
await evaluate(`document.querySelector('button[aria-label="重新生成"]').click()`);
await sleep(1200);
const regenStreaming = await evaluate(`!!document.querySelector('button[aria-label="停止生成"]')`);
check("重新生成进入生成状态", regenStreaming);
await waitIdle();
const afterRegen = await snapshot();
check(
  "重新生成后仍是一问一答（没有多出一条）",
  afterRegen.bubbles.length === 2,
  `${afterRegen.bubbles.length} 条：${afterRegen.bubbles.map((b) => b.len).join("/")}`,
);

// ---- 7. 编辑重发 ----
await evaluate(`document.querySelector('button[aria-label="编辑这条消息"]').click()`);
await sleep(600);
await evaluate(`(() => {
  const ta = [...document.querySelectorAll('main textarea')].at(-1);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '用一句话解释什么是数据库索引');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('main button')].find((b) => b.textContent.includes('保存并重发')).click();
})()`);
await sleep(1200);
await waitIdle();
const afterEdit = await snapshot();
check(
  "编辑重发后仍是一问一答且内容已换",
  afterEdit.bubbles.length === 2 && afterEdit.bubbles[0].text.includes("索引"),
  `${afterEdit.bubbles.length} 条，首条="${afterEdit.bubbles[0].text}"`,
);

// ---- 8. 停止 + 刷新 + 继续生成 ----
await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '详细写 900 字讲解 InnoDB 的 Buffer Pool，分多段展开');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('button[aria-label="发送"]').click();
})()`);
await sleep(2500);
const beforeStop = await snapshot();
await evaluate(`document.querySelector('button[aria-label="停止生成"]').click()`);
await sleep(2500);
const afterStop = await snapshot();
check(
  "停止后正文不再增长",
  afterStop.bubbles.at(-1).len >= beforeStop.bubbles.at(-1).len - 5,
  `停前 ${beforeStop.bubbles.at(-1)?.len} → 停后 ${afterStop.bubbles.at(-1)?.len}`,
);

await goto("/");
await sleep(1800);
const afterStopReload = await snapshot();
check(
  "停止后刷新：内容保留（没被丢掉）",
  (afterStopReload.bubbles.at(-1)?.len ?? 0) > 0,
  `正文=${afterStopReload.bubbles.at(-1)?.len} 字`,
);
check(
  "用户主动停止不显示「继续生成」（interrupted 才显示）",
  afterStopReload.hasContinue === false,
  `hasContinue=${afterStopReload.hasContinue}`,
);

// 崩溃场景：把这条消息改成 interrupted（这正是启动清理会写出的状态），
// 刷新后应该出现「继续生成」，点了要能在同一条消息上接着写。
const lastAssistant = await one(
  `SELECT m.id, m.status, CHAR_LENGTH(m.content) AS len
     FROM messages m JOIN chat_sessions s ON s.id = m.session_id
     JOIN users u ON u.id = s.user_id
    WHERE u.username = 'demo' AND s.deleted_at IS NULL AND m.role = 'assistant'
    ORDER BY m.created_at DESC LIMIT 1`,
);
await conn.query(`UPDATE messages SET status = 'interrupted', run_id = NULL WHERE id = ?`, [
  lastAssistant.id,
]);
await goto("/");
await sleep(1800);
const afterCrashReload = await snapshot();
check(
  "模拟崩溃后刷新：出现「继续生成」",
  afterCrashReload.hasContinue,
  `hasContinue=${afterCrashReload.hasContinue} 正文=${afterCrashReload.bubbles.at(-1)?.len} 字`,
);

const lenBeforeContinue = afterCrashReload.bubbles.at(-1)?.len ?? 0;
await evaluate(
  `[...document.querySelectorAll('main button')].find((b) => b.textContent.includes('继续生成'))?.click()`,
);
await sleep(2000);
await waitIdle();
const afterContinue = await snapshot();
check(
  "继续生成把内容接长了（还是同一条消息）",
  (afterContinue.bubbles.at(-1)?.len ?? 0) > lenBeforeContinue &&
    afterContinue.bubbles.length === afterCrashReload.bubbles.length,
  `${lenBeforeContinue} → ${afterContinue.bubbles.at(-1)?.len} 字，条数 ${afterCrashReload.bubbles.length} → ${afterContinue.bubbles.length}`,
);

// ---- 9. 改名 + 刷新保留 ----
const renamed = `改名验证 ${Date.now() % 10000}`;
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('aside button')].find((b) => b.getAttribute('aria-label') === '重命名会话');
  if (btn) btn.click();
})()`);
await sleep(500);
const renameOk = await evaluate(`(() => {
  // 注意：aside 里第一个 input 是搜索框，改名输入框在会话行内部
  const input = document.querySelector('aside [data-session-row] input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(renamed)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`);
await sleep(1200);
await goto("/");
await sleep(1500);
const afterRename = await snapshot();
check(
  "改名后刷新仍是新名字",
  renameOk && afterRename.sidebarText.includes(renamed),
  `期望出现在侧栏：${renamed}`,
);

// ---- 10. 删除会话 ----
const beforeDelete = (
  await one(
    `SELECT COUNT(*) AS n FROM chat_sessions s JOIN users u ON u.id = s.user_id
      WHERE u.username = 'demo' AND s.deleted_at IS NULL`,
  )
).n;
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('aside button')].find((b) => b.getAttribute('aria-label') === '删除会话');
  if (btn) btn.click();
})()`);
await sleep(1500);
const afterDelete = (
  await one(
    `SELECT COUNT(*) AS n FROM chat_sessions s JOIN users u ON u.id = s.user_id
      WHERE u.username = 'demo' AND s.deleted_at IS NULL`,
  )
).n;
check("删除会话 → 库里软删除生效", afterDelete === beforeDelete - 1, `${beforeDelete} → ${afterDelete}`);

await goto("/");
await sleep(1500);
const afterDeleteReload = await snapshot();
check(
  "刷新后被删的会话不在侧栏",
  !afterDeleteReload.sidebarText.includes(renamed),
  `侧栏仍含旧名=${afterDeleteReload.sidebarText.includes(renamed)}`,
);

await conn.end();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
