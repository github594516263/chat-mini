// 真实路由 /c/[id] 的端到端验收
//   node scripts/e2e-routing-link.mjs [baseUrl]
//
// 覆盖：登录态直开、侧栏切换写 URL、后退键回溯、刷新保持、404、游客路径。
// 会话数据由脚本自己建、自己清（scripts/lib/e2e-fixture.mjs）。

import { prepareFixtures, purgeFixtures } from "./lib/e2e-fixture.mjs";

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:3123").replace(/\/$/, "");
const { userId, A, B } = await prepareFixtures();
const cdpPort = Number(process.env.CDP_PORT ?? 9223);
const USERNAME = process.env.E2E_USER ?? "demo";
const PASSWORD = process.env.E2E_PASS ?? "DemoPass2026!";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = targets.find((t) => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await call("Page.enable");
await call("Runtime.enable");
await call("Network.enable");

const evaluate = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const state = () =>
  evaluate(`({
    path: location.pathname,
    title: document.querySelector('h1')?.textContent?.trim() ?? null,
    bubbles: document.querySelectorAll('[data-role]').length,
    text: document.body.innerText
  })`);

async function goto(url) {
  await call("Page.navigate", { url });
  await waitFor("document.readyState === 'complete'");
  await waitFor("!!document.querySelector('h1')", 25000);
  await sleep(700);
}

// ---------------------------------------------------------------- 登录
await goto(`${baseUrl}/`);
const loginStatus = await evaluate(`fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: ${JSON.stringify(USERNAME)}, password: ${JSON.stringify(PASSWORD)} })
}).then(r => r.status)`);
check("登录成功", loginStatus === 200, `status ${loginStatus}`);

// ---------------------------------------------------------------- 直开 /c/[id]
const targetId = A.id;
const expectedTitle = A.title;
await goto(`${baseUrl}/c/${targetId}`);
let s = await state();
check("直开 /c/[id] → URL 保持", s.path === `/c/${targetId}`, s.path);
check("直开 /c/[id] → 标题正确", s.title === expectedTitle, `h1 = ${s.title}`);
check("直开 /c/[id] → 消息已渲染", s.bubbles > 0, `${s.bubbles} 条气泡`);

// ---------------------------------------------------------------- 侧栏切换
const otherId = B.id;
await evaluate(`document.querySelector('[data-session-id="${otherId}"]')?.click(); true`);
await waitFor(`location.pathname === '/c/${otherId}'`, 15000);
await sleep(800);
s = await state();
check("侧栏切换 → URL 变成 /c/<新id>", s.path === `/c/${otherId}`, s.path);
check("侧栏切换 → 标题跟着变", s.title === B.title, `h1 = ${s.title}`);
check("侧栏切换 → 消息换成了新会话", s.bubbles > 0, `${s.bubbles} 条气泡`);

// ---------------------------------------------------------------- 后退键
await evaluate("history.back(); true");
await waitFor(`location.pathname === '/c/${targetId}'`, 15000);
await sleep(900);
s = await state();
check("后退 → URL 回到上一会话", s.path === `/c/${targetId}`, s.path);
check("后退 → 内容是上一会话", s.title === expectedTitle, `h1 = ${s.title}`);

// ---------------------------------------------------------------- 刷新保持
await call("Page.reload");
await waitFor("document.readyState === 'complete'");
await waitFor(`!!document.querySelector('h1')`, 25000);
await sleep(900);
s = await state();
check("刷新 → URL 不跳走", s.path === `/c/${targetId}`, s.path);
check("刷新 → 内容和刷新前一致", s.title === expectedTitle && s.bubbles > 0, `h1 = ${s.title}, ${s.bubbles} 条`);

// ---------------------------------------------------------------- 404
const fakeId = "00000000-0000-4000-8000-000000000000";
await goto(`${baseUrl}/c/${fakeId}`);
s = await state();
check(
  "不存在的会话 → 404（不泄露存在性）",
  s.text.includes("404") || s.text.includes("could not be found"),
  s.text.replace(/\s+/g, " ").slice(0, 60),
);

// ---------------------------------------------------------------- 游客路径
await call("Network.clearBrowserCookies");
await goto(`${baseUrl}/`);
const guest = await evaluate(`(() => {
  const raw = window.localStorage.getItem('chat-mini/sessions/v1');
  const parsed = raw ? JSON.parse(raw) : null;
  const first = parsed?.sessions?.[0];
  return first ? { id: first.id, title: first.title } : null;
})()`);
if (guest) {
  await goto(`${baseUrl}/c/${guest.id}`);
  s = await state();
  check("游客直开 /c/<本地会话> → 能还原", s.path === `/c/${guest.id}`, s.path);
  check("游客直开 → 标题与本地会话一致", s.title === guest.title, `h1 = ${s.title}`);
} else {
  check("游客本地会话存在", false, "localStorage 里没有会话");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
ws.close();
await purgeFixtures(userId);
process.exit(failed.length === 0 ? 0 : 1);
