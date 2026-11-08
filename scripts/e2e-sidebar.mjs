// 端到端自检（侧栏版）：重命名 / 搜索 / 清空搜索 / 刷新后仍在
// 用法：node scripts/e2e-sidebar.mjs   环境变量：CDP_PORT、BASE_URL
const port = Number(process.env.CDP_PORT ?? 9223);
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const STORE_KEY = "chat-mini/sessions/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await call("Page.enable");
await call("Network.enable");
// 必须先把 cookie 清掉：这两个套件跑的是游客路径，若浏览器还带着登录态，
// 侧栏读的会是服务端会话，整个用例的前提就不成立了（真实踩过）。
await call("Network.clearBrowserCookies");
await call("Runtime.enable");

const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};

const titles = () =>
  evaluate(`(() => {
    const rows = [...document.querySelectorAll('aside [data-session-id]')];
    return rows.map((b) => b.title);
  })()`);

const storedTitles = () =>
  evaluate(`(() => {
    const raw = window.localStorage.getItem(${JSON.stringify(STORE_KEY)});
    if (!raw) return [];
    return JSON.parse(raw).sessions.map((s) => s.title);
  })()`);

// 准备：造 3 个会话，标题分别可控
await call("Page.navigate", { url: `${baseUrl}/` });
await sleep(2500);
await evaluate(`(() => {
  const now = Date.now();
  const mk = (id, title, offset) => ({
    id, title, createdAt: now - offset, updatedAt: now - offset,
    messages: [
      { id: id + '-u', role: 'user', content: title },
      { id: id + '-a', role: 'assistant', content: '回答：' + title },
    ],
  });
  const store = {
    sessions: [mk('s1', 'Rust 所有权讲解', 3000), mk('s2', 'React 防抖 hook', 2000), mk('s3', '事件协议设计', 1000)],
    activeId: 's3',
  };
  window.localStorage.setItem(${JSON.stringify(STORE_KEY)}, JSON.stringify(store));
})()`);
await call("Page.reload", { ignoreCache: false });
await sleep(3000);
console.log("1. 初始列表:", JSON.stringify(await titles()));

// 2) 搜索
await evaluate(`(() => {
  const el = document.querySelector('aside input[aria-label="搜索会话"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'react');
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(600);
console.log("2. 搜『react』:", JSON.stringify(await titles()));

await evaluate(`(() => {
  const el = document.querySelector('aside input[aria-label="搜索会话"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'zzz');
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(600);
const emptyHint = await evaluate(`(() => {
  const t = document.querySelector('aside')?.innerText ?? '';
  return t.includes('没有匹配');
})()`);
console.log(`3. 搜『zzz』: 结果=${JSON.stringify(await titles())} 空态提示=${emptyHint}`);

// 3) 清空搜索
await evaluate(`document.querySelector('aside button[aria-label="清空搜索"]').click()`);
await sleep(500);
console.log("4. 清空后:", JSON.stringify(await titles()));

// 4) 重命名：点铅笔 → 输入 → Enter
await evaluate(`(() => {
  const row = document.querySelector('aside [data-session-row="s1"]');
  row.querySelector('button[aria-label="重命名会话"]').click();
})()`);
await sleep(400);
await evaluate(`(() => {
  const el = document.querySelector('aside input[aria-label="会话名称"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '改名后的会话');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await sleep(800);
console.log(
  `5. 重命名后: 列表=${JSON.stringify(await titles())} 存储=${JSON.stringify(await storedTitles())}`,
);

// 5) 刷新后仍在
await call("Page.reload", { ignoreCache: false });
await sleep(3200);
console.log(`6. 刷新后: 列表=${JSON.stringify(await titles())}`);

// 6) 重命名不影响顺序（s1 仍应排在最后，因为它 updatedAt 最旧）
const order = await titles();
console.log(`7. 顺序保持: ${JSON.stringify(order)} → ${order[order.length - 1] === "改名后的会话"}`);

// 7) Esc 取消改名
await evaluate(`(() => {
  const row = document.querySelector('aside [data-session-row="s2"]');
  row.querySelector('button[aria-label="重命名会话"]').click();
})()`);
await sleep(400);
const escResult = await evaluate(`(() => {
  const el = document.querySelector('aside input[aria-label="会话名称"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '不该保存的名字');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return 'esc-sent';
})()`);
await sleep(700);
console.log(`8. Esc 取消(${escResult}): ${JSON.stringify(await titles())}`);

ws.close();
