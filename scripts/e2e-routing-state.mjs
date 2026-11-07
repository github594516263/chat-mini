// 状态提升的端到端验收：切会话不清草稿、生成不中断、URL 跟得上
//   node scripts/e2e-routing-state.mjs [baseUrl]
//
// 需要 live key（会真的发两次很短的请求，验证"切走之后订阅还在跑"）。

import { prepareFixtures, purgeFixtures } from "./lib/e2e-fixture.mjs";

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:3123").replace(/\/$/, "");
const { userId, A: fx, B: fy } = await prepareFixtures();
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
  if (msg.method === "Page.javascriptDialogOpening") {
    void call("Page.handleJavaScriptDialog", { accept: true });
    return;
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
const waitFor = async (expression, timeout = 25000) => {
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

const path = () => evaluate("location.pathname");
const title = () => evaluate("document.querySelector('h1')?.textContent?.trim() ?? null");
const inputValue = () => evaluate("document.querySelector('textarea')?.value ?? null");
const lastAssistant = () =>
  evaluate(
    `(() => {
      const nodes = [...document.querySelectorAll('[data-role="assistant"]')];
      const last = nodes[nodes.length - 1];
      return last ? { len: last.innerText.length, text: last.innerText.slice(0, 80) } : null;
    })()`,
  );

/** 用 React 认的方式改 textarea 的值（直接改 value 不会触发 onChange） */
const typeDraft = (text) =>
  evaluate(`(() => {
    const el = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);

const click = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

async function goto(url) {
  await call("Page.navigate", { url });
  await waitFor("document.readyState === 'complete'");
  await waitFor("!!document.querySelector('h1')", 30000);
  await sleep(700);
}

// ---------------------------------------------------------------- 登录 + 打开 A
const A = fx.id;
const B = fy.id;
await goto(`${baseUrl}/`);
await evaluate(`fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: ${JSON.stringify(USERNAME)}, password: ${JSON.stringify(PASSWORD)} })
}).then(r => r.status)`);

await goto(`${baseUrl}/c/${A}`);
await waitFor(`document.querySelectorAll('[data-role]').length > 0`, 20000);

// ---------------------------------------------------------------- 草稿跨会话
await typeDraft("A 的草稿-abc");
await sleep(200);
check("A 里打字 → 输入框有值", (await inputValue()) === "A 的草稿-abc");

await click(`[data-session-id="${B}"]`);
await waitFor(`location.pathname === '/c/${B}'`, 15000);
await sleep(700);
check("切到 B → 输入框是空的（草稿不串会话）", (await inputValue()) === "", `value=${await inputValue()}`);

await typeDraft("B 的草稿-xyz");
await sleep(200);

await click(`[data-session-id="${A}"]`);
await waitFor(`location.pathname === '/c/${A}'`, 15000);
await sleep(700);
check("切回 A → 草稿还在", (await inputValue()) === "A 的草稿-abc", `value=${await inputValue()}`);

await click(`[data-session-id="${B}"]`);
await waitFor(`location.pathname === '/c/${B}'`, 15000);
await sleep(700);
check("再切回 B → B 的草稿还在", (await inputValue()) === "B 的草稿-xyz", `value=${await inputValue()}`);

// ---------------------------------------------------------------- 生成中切走
// 用一条全新会话（避免历史残留干扰判定），并且要求"切回来时还在流式"
const freshId = await evaluate(`fetch('/api/sessions', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: '{}' })
  .then(r => r.json()).then(d => d.session?.id ?? null)`);
await goto(`${baseUrl}/c/${freshId}`);
await typeDraft("用大约 500 字把 HTTP/1.1、HTTP/2、HTTP/3 的区别讲清楚，分点，尽量详细");
await sleep(150);
await click('button[aria-label="发送"]');
const started = await waitFor(
  `!!document.querySelector('button[aria-label="停止生成"]')`,
  30000,
);
check("发送成功 → 出现停止按钮", started);

// 等到正文确实开始输出（单条气泡、有内容）
const grew = await waitFor(
  `(() => {
    const nodes = [...document.querySelectorAll('[data-role="assistant"]')];
    return nodes.length === 1 && nodes[0].innerText.length > 100;
  })()`,
  40000,
);
const before = await lastAssistant();
check("正文已经开始输出", grew, `len=${before?.len}`);

// 生成中切到 B，停 2 秒，再切回来（要赶在生成结束之前）
await click(`[data-session-id="${B}"]`);
await waitFor(`location.pathname === '/c/${B}'`, 15000);
await sleep(500);
check(
  "在 B 里看不到别处的生成（streaming 不是全局布尔）",
  (await evaluate(`!document.querySelector('button[aria-label="停止生成"]')`)) === true,
);
await typeDraft("B 里也能打字");
await sleep(200);
check(
  "B 里发送按钮可用（没被别的会话的生成禁掉）",
  (await evaluate(`!!document.querySelector('button[aria-label="发送"]')`)) === true,
);

await sleep(700);
await click(`[data-session-id="${freshId}"]`);
await waitFor(`location.pathname === '/c/${freshId}'`, 20000);
await sleep(400);
const after = await lastAssistant();
const stillStreaming = await evaluate(
  `!!document.querySelector('button[aria-label="停止生成"]')`,
);
check(
  "切回来：正文比切走前更长（订阅没断）",
  Boolean(after && before && after.len > before.len),
  `${before?.len} → ${after?.len}`,
);
check("切回来：仍在流式中（按会话派生的 streaming）", stillStreaming);

// 等它跑完，确认没有出现重复气泡、正文也没有被回退
await waitFor(`!document.querySelector('button[aria-label="停止生成"]')`, 90000);
await sleep(1000);
const finalCount = await evaluate(
  `document.querySelectorAll('[data-role="assistant"]').length`,
);
const finalLen = (await lastAssistant())?.len ?? 0;
check("跑完后只有一条助手气泡（没有重复插入）", finalCount === 1, `${finalCount} 条`);
check("跑完后正文没有回退", finalLen >= (after?.len ?? 0), `${after?.len} → ${finalLen}`);

// ---------------------------------------------------------------- 新建对话写 URL
await click('button[aria-label="新对话"]');
const gotNewUrl = await waitFor(`/^\\/c\\/[0-9a-zA-Z-]{8,}$/.test(location.pathname)`, 20000);
await sleep(600);
const newPath = await path();
check("新建对话 → URL 换成 /c/<真id>", gotNewUrl && newPath !== `/c/${A}`, newPath);
check("新建对话 → 标题是「新对话」", (await title()) === "新对话", await title());

// ---------------------------------------------------------------- 删除当前会话
const victim = newPath.replace("/c/", "");
// 先试行内的删除按钮（会话标题按钮的兄弟节点）
await evaluate(`(() => {
  const row = document.querySelector('[data-session-row="${victim}"]');
  const btn = row?.querySelector('button[aria-label="删除会话"]');
  btn?.click();
  return !!btn;
})()`);
const left = await waitFor(`location.pathname !== '/c/${victim}'`, 20000);
await sleep(800);
check("删除当前会话 → URL 立刻离开已删 id", left, await path());
check(
  "已删会话从侧栏消失",
  (await evaluate(`!document.querySelector('[data-session-id="${victim}"]')`)) === true,
);

await evaluate("history.back(); true");
await sleep(1200);
check("删除后按后退 → 不会回到已删会话", (await path()) !== `/c/${victim}`, await path());

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
ws.close();
await purgeFixtures(userId);
process.exit(failed.length === 0 ? 0 : 1);
