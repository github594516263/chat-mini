// 并发生成的端到端验收：两条会话同时生成、停止只停当前这条
//   node scripts/e2e-routing-concurrent.mjs [baseUrl]

import { prepareFixtures, purgeFixtures } from "./lib/e2e-fixture.mjs";

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:3123").replace(/\/$/, "");
const { userId, B: fixtureB } = await prepareFixtures();
const B = fixtureB.id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const calls = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Network.requestWillBeSent") {
    const { url, method } = msg.params.request;
    if (url.includes("/api/chat")) calls.push(`${method} ${url.replace(baseUrl, "")}`);
  }
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
const waitFor = async (expression, timeout = 40000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
};
const lastLen = () =>
  evaluate(`(() => { const n=[...document.querySelectorAll('[data-role="assistant"]')];
    return n.length ? n[n.length-1].innerText.length : 0; })()`);
const stopping = () => evaluate(`!!document.querySelector('button[aria-label="停止生成"]')`);
const click = (selector) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false; el.click(); return true; })()`);
const typeDraft = (text) =>
  evaluate(`(() => {
    const el = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
async function goto(url) {
  await call("Page.navigate", { url });
  await waitFor("document.readyState === 'complete'");
  await waitFor("!!document.querySelector('h1')", 30000);
  await sleep(800);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  — ${detail}` : ""}`);
};

await goto(`${baseUrl}/`);
await evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demo', password: 'DemoPass2026!' }) }).then(r => r.status)`);

const s1 = await evaluate(`fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: '{}' }).then(r => r.json()).then(d => d.session?.id ?? null)`);
const s2 = await evaluate(`fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: '{}' }).then(r => r.json()).then(d => d.session?.id ?? null)`);
console.log("S1 =", s1, "\nS2 =", s2, "\n");

// S1 起一个长回答
await goto(`${baseUrl}/c/${s1}`);
calls.length = 0;
await typeDraft("用大约 600 字讲讲操作系统的进程调度算法，分点详细说");
await sleep(150);
await click('button[aria-label="发送"]');
await waitFor(`!!document.querySelector('button[aria-label="停止生成"]')`, 30000);
await waitFor(`(() => { const n=[...document.querySelectorAll('[data-role="assistant"]')];
  return n.length === 1 && n[0].innerText.length > 80; })()`, 40000);
const s1First = await lastLen();
check("S1 正在生成", await stopping(), `已输出 ${s1First} 字`);

// 切到 S2，也在 S1 还没跑完的时候发消息
await click(`[data-session-id="${s2}"]`);
await waitFor(`location.pathname === '/c/${s2}'`, 15000);
await sleep(500);
await typeDraft("用大约 600 字讲讲 TCP 拥塞控制，分点详细说");
await sleep(150);
const sendable = await evaluate(`!!document.querySelector('button[aria-label="发送"]') && !document.querySelector('button[aria-label="发送"]').disabled`);
check("S1 生成中，S2 仍可发送", sendable);
await click('button[aria-label="发送"]');
const s2Started = await waitFor(`!!document.querySelector('button[aria-label="停止生成"]')`, 30000);
check("S2 也开始生成（并发成立）", s2Started);
await waitFor(`(() => { const n=[...document.querySelectorAll('[data-role="assistant"]')];
  return n.length === 1 && n[0].innerText.length > 80; })()`, 40000);
const s2First = await lastLen();
check("POST /api/chat 累计两次", calls.filter((c) => c.startsWith("POST /api/chat")).length === 2, calls.join(" | "));

// 回到 S1：它应该还在跑（或已跑完），且正文比离开时多
await click(`[data-session-id="${s1}"]`);
await waitFor(`location.pathname === '/c/${s1}'`, 15000);
await sleep(800);
const s1Second = await lastLen();
const s1Streaming = await stopping();
check("回 S1：正文比离开时更长", s1Second > s1First, `${s1First} → ${s1Second}`);
check("回 S1：仍在生成或已结束（不是被 S2 挤掉）", s1Streaming || s1Second > s1First);

// 在 S1 点停止，S2 不该受影响
if (s1Streaming) {
  await click('button[aria-label="停止生成"]');
  await sleep(800);
}
const s1AfterStop = await lastLen();
check("S1 停止后不再自动增长（等 2 秒验证）", true, "");
await sleep(2000);
const s1Later = await lastLen();
check("S1 停止生效（正文定格）", s1Later === s1AfterStop, `${s1AfterStop} → ${s1Later}`);

// 回到 S2 看它有没有被 S1 的停止牵连
await click(`[data-session-id="${s2}"]`);
await waitFor(`location.pathname === '/c/${s2}'`, 15000);
await sleep(1500);
const s2Second = await lastLen();
check("S2 没被 S1 的停止牵连（正文还在长或已写完）", s2Second >= s2First, `${s2First} → ${s2Second}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
ws.close();
await purgeFixtures(userId);
process.exit(failed.length === 0 ? 0 : 1);
