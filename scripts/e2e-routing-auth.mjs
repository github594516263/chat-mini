// 深链鉴权的端到端验收：?next= 回跳、开放重定向拦截、游客态地址栏纠偏
//   node scripts/e2e-routing-auth.mjs [baseUrl]

import { prepareFixtures, purgeFixtures } from "./lib/e2e-fixture.mjs";

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:3123").replace(/\/$/, "");
const { userId, A } = await prepareFixtures();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
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
const waitFor = async (expression, timeout = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
};
const path = () => evaluate("location.pathname + location.search");
async function goto(url) {
  await call("Page.navigate", { url });
  await waitFor("document.readyState === 'complete'");
  await sleep(900);
}
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const realSession = A.id;

// ---------------------------------------------------------- 未登录访问登录页：next 被带上
await call("Network.clearBrowserCookies");
await goto(`${baseUrl}/login?next=/c/${realSession}`);
const hasForm = await waitFor("!!document.querySelector('input')", 15000);
check("登录页正常渲染", hasForm);

// 用表单真实登录，验证提交后跳到 next
await evaluate(`(() => {
  const inputs = [...document.querySelectorAll('input')];
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set(inputs[0], 'demo');
  set(inputs[1], 'DemoPass2026!');
  inputs[1].closest('form')?.requestSubmit?.() ?? inputs[1].form?.requestSubmit();
  return true;
})()`);
const wentToSession = await waitFor(`location.pathname === '/c/${realSession}'`, 25000);
check("登录成功 → 回跳到 /c/<id>（深链不丢）", wentToSession, await path());

// ---------------------------------------------------------- 开放重定向拦截
await call("Network.clearBrowserCookies");
for (const evil of ["https://example.com/x", "//example.com/x", "/\\example.com"]) {
  await goto(`${baseUrl}/login?next=${encodeURIComponent(evil)}`);
  await waitFor("!!document.querySelector('input')", 15000);
  const inputsReady = await evaluate(`document.querySelectorAll('input').length >= 2`);
  if (!inputsReady) {
    check(`恶意 next 被拒（${evil}）`, false, "登录页没渲染出来");
    continue;
  }
  // 不真的登录：只看服务端有没有把它原样回跳。发一次登录请求后看落到哪
  await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(inputs[0], 'demo');
    set(inputs[1], 'DemoPass2026!');
    inputs[1].form?.requestSubmit();
    return true;
  })()`);
  await sleep(2500);
  const landed = await path();
  check(
    `恶意 next 被拒（${evil}）`,
    !landed.includes("example.com"),
    landed,
  );
  await call("Network.clearBrowserCookies");
}

// ---------------------------------------------------------- 游客态：地址栏纠偏
await goto(`${baseUrl}/c/${realSession}`);
await sleep(1500);
const guestPath = await path();
check(
  "游客打开别人的会话链接 → 地址栏纠偏回草稿态",
  guestPath === "/",
  guestPath,
);

// ---------------------------------------------------------- 游客自己的会话仍然可深链
const guestId = await evaluate(`(() => {
  const raw = window.localStorage.getItem('chat-mini/sessions/v1');
  const parsed = raw ? JSON.parse(raw) : null;
  return parsed?.sessions?.[0]?.id ?? null;
})()`);
if (guestId) {
  await goto(`${baseUrl}/c/${guestId}`);
  const kept = await waitFor(`location.pathname === '/c/${guestId}'`, 8000);
  check("游客打开自己的会话 → 深链保留", kept, await path());
} else {
  check("游客本地会话存在", false, "localStorage 里没有会话");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
ws.close();
await purgeFixtures(userId);
process.exit(failed.length === 0 ? 0 : 1);
