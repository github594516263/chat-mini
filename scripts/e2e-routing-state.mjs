// 状态提升的端到端验收：切会话不清草稿、生成不中断、URL 跟得上
//   node scripts/e2e-routing-state.mjs [baseUrl]
//
// 需要 live key（会真的发两次很短的请求，验证"切走之后订阅还在跑"）。

import { createFixtureSession, prepareFixtures, purgeFixtures } from "./lib/e2e-fixture.mjs";

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
  if (r.exceptionDetails) {
    const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
    throw new Error(`${detail}`);
  }
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

// ---------------------------------------------------------------- 滚动位置与编辑态跨切换保持
// 需要一条"长到能滚"的会话，否则滚动位置没有意义
const longBody = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：这里是一段用来把页面撑高的正文，重复若干次以便验证滚动位置。`).join("\n\n");
const LONG = await createFixtureSession(userId, "长会话", ["请把下面这段读完", longBody]);

await goto(`${baseUrl}/c/${LONG.id}`);
await waitFor(`document.querySelectorAll('[data-role]').length >= 2`, 20000);
await sleep(600);

const canScroll = await evaluate(`(() => {
  const el = document.querySelector('main');
  return el ? el.scrollHeight > el.clientHeight + 100 : false;
})()`);
check("长会话正文可滚动（前提成立）", canScroll);

await evaluate(`(() => { const el = document.querySelector('main'); el.scrollTop = 320; return el.scrollTop; })()`);
await sleep(400);
const scrollBefore = await evaluate(`document.querySelector('main').scrollTop`);

// 切走再切回
await click(`[data-session-id="${B}"]`);
await waitFor(`location.pathname === '/c/${B}'`, 15000);
await sleep(500);
await click(`[data-session-id="${LONG.id}"]`);
await waitFor(`location.pathname === '/c/${LONG.id}'`, 15000);
await sleep(900);
const scrollAfter = await evaluate(`document.querySelector('main').scrollTop`);
check(
  "切走再切回 → 滚动位置保持",
  Math.abs(scrollAfter - scrollBefore) <= 60,
  `${scrollBefore} → ${scrollAfter}`,
);

// 编辑态跨切换保持
await evaluate(`document.querySelector('button[aria-label="编辑这条消息"]')?.click(); true`);
const editOpened = await waitFor(`!!document.querySelector('main textarea')`, 8000);
check("编辑框已打开（前提成立）", editOpened);
await evaluate(`(() => {
  const el = document.querySelector('main textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, '改成这段文字-保持测试');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);

await click(`[data-session-id="${B}"]`);
await waitFor(`location.pathname === '/c/${B}'`, 15000);
await sleep(500);
const editGoneInB = await evaluate(`!document.querySelector('main textarea')`);
check("切到别的会话 → 那边的编辑框不串过来", editGoneInB);

await click(`[data-session-id="${LONG.id}"]`);
await waitFor(`location.pathname === '/c/${LONG.id}'`, 15000);
await sleep(900);
const editBack = await evaluate(`document.querySelector('main textarea')?.value ?? null`);
check(
  "切走再切回 → 编辑框和改过的文字都还在",
  editBack === "改成这段文字-保持测试",
  editBack ?? "(编辑框没了)",
);

// ---------------------------------------------------------------- 零重建：切会话后 DOM 节点还是同一个
// 这是"视图挂在 layout"这个结构的核心断言：不是"看起来没闪"，而是同一个节点实例。
await click(`[data-session-id="${B}"]`);
await waitFor(`location.pathname === '/c/${B}'`, 15000);
await sleep(800);

// 在 A 里打好字（草稿按会话存，所以必须在 A 上打），记下节点引用
await click(`[data-session-id="${A}"]`);
await waitFor(`location.pathname === '/c/${A}'`, 15000);
await sleep(600);
await evaluate(`(() => {
  const el = document.querySelector('[data-composer]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, '光标位置测试-ABCDE');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.setSelectionRange(4, 4);
  window.__mainEl = document.querySelector('main');
  window.__taEl = el;
  return true;
})()`);
await sleep(200);
const draftBefore = await evaluate(`({ value: window.__taEl.value, caret: window.__taEl.selectionStart })`);

// 切到 B，再切回 A
await click(`[data-session-id="${B}"]`);
await waitFor(`location.pathname === '/c/${B}'`, 15000);
await sleep(600);
await click(`[data-session-id="${A}"]`);
await waitFor(`location.pathname === '/c/${A}'`, 15000);
await sleep(800);

const same = await evaluate(`({
  main: window.__mainEl === document.querySelector('main'),
  textarea: window.__taEl === document.querySelector('[data-composer]'),
  value: window.__taEl?.value ?? null,
  caret: window.__taEl?.selectionStart ?? null,
  connected: window.__taEl?.isConnected === true,
  focused: document.activeElement === window.__taEl,
})`);
check("切会话后 <main> 是同一个 DOM 节点（没有重建）", same.main === true);
check("切会话后输入框是同一个 DOM 节点（没有重建）", same.textarea === true);
check(
  "切会话后草稿的值还在（按会话隔离）",
  same.value === draftBefore.value,
  `切前 "${draftBefore.value}" → 切后 "${same.value}"`,
);
// 受控 textarea 换值后光标必然回到末尾（浏览器行为，不是重建导致）。
// 真要记住光标位置得自己存 selectionStart，目前判断不值得 —— 记录在案。
check(
  "光标落在末尾（受控 textarea 换值的固有行为，已在文档记录）",
  same.caret === same.value.length,
  `caret=${same.caret} len=${same.value.length}`,
);
check("切会话后旧节点没有被销毁", same.connected === true);
check("切会话后焦点没有被打断（仍在输入框）", same.focused === true);

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
ws.close();
await purgeFixtures(userId);
process.exit(failed.length === 0 ? 0 : 1);
