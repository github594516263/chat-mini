// 验证：生成中刷新不再弹「重新加载站点？」
//   node scripts/probe-beforeunload.mjs
const port = Number(process.env.CDP_PORT ?? 9280);
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const PASSWORD = process.env.E2E_PASS ?? "DemoPass2026!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const dialogs = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Page.javascriptDialogOpening") dialogs.push(msg.params);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await call("Page.enable");
await call("Runtime.enable");

const ev = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.result.description ?? r.exceptionDetails.text);
  return r.result.value;
};

// 登录
await call("Page.navigate", { url: `${baseUrl}/login` });
await sleep(1800);
if ((await ev("location.pathname")) !== "/") {
  await ev(`(() => {
    const setValue = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')];
    setValue(inputs[0], 'demo');
    setValue(inputs[1], ${JSON.stringify(PASSWORD)});
    document.querySelector('form button[type="submit"]').click();
  })()`);
  await sleep(2500);
}
console.log("登录后路径:", await ev("location.pathname"));

// 发一条长一点的，趁生成中刷新
await call("Page.navigate", { url: `${baseUrl}/` });
await sleep(1500);
await ev(`document.querySelector('[aria-label="新对话"]').click()`);
await sleep(800);
await ev(`(() => {
  const ta = document.querySelector('textarea');
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, '详细写 800 字讲讲 MySQL 的 redo log 和 undo log');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('button[aria-label="发送"]').click();
})()`);
await sleep(2000);
const streaming = await ev(`!!document.querySelector('button[aria-label="停止生成"]')`);
console.log("刷新前是否在生成中:", streaming);

dialogs.length = 0;
await call("Page.reload");
await sleep(2500);
console.log(`\n刷新时弹出的浏览器对话框数量: ${dialogs.length}`);
console.log(dialogs.length === 0 ? "✅ 不再拦截刷新" : `❌ 仍然弹窗: ${JSON.stringify(dialogs[0])}`);

// 顺便确认刷新后自己接上了
await sleep(2500);
const resumed = await ev(`!!document.querySelector('button[aria-label="停止生成"]')
  || (document.querySelector('main')?.innerText || '').length > 50`);
console.log("刷新后页面有用内容:", resumed);
process.exit(dialogs.length === 0 ? 0 : 1);
