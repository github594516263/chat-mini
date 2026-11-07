// 端到端自检（消息动作版）：重新生成 / 编辑重发 / 复制
// 用法：node scripts/e2e-actions.mjs   环境变量：CDP_PORT、BASE_URL
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
await call("Runtime.enable");

const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};

const store = () =>
  evaluate(`(() => {
    const raw = window.localStorage.getItem(${JSON.stringify(STORE_KEY)});
    if (!raw) return { count: 0, messages: [] };
    const parsed = JSON.parse(raw);
    const active = parsed.sessions.find((s) => s.id === parsed.activeId) ?? parsed.sessions[0];
    return {
      count: active?.messages?.length ?? 0,
      messages: (active?.messages ?? []).map((m) => ({ role: m.role, content: m.content.slice(0, 120), len: m.content.length })),
    };
  })()`);

const busy = () => evaluate(`!!document.querySelector('button[aria-label="停止生成"]')`);
const waitIdle = async (label) => {
  for (let i = 0; i < 60; i += 1) {
    if (!(await busy())) return true;
    await sleep(500);
  }
  throw new Error(`等 ${label} 结束超时`);
};

// 注入：可控剪贴板 + 直接设 textarea 值（React 受控组件需要原生 setter）
const helpers = `(() => {
  window.__copied = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t) => { window.__copied = t; } },
  });
  window.__type = (selector, value) => {
    const el = document.querySelector(selector);
    if (!el) return 'no-element';
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  };
  return 'ok';
})()`;

// 1) 清空历史并打开页面
await call("Page.navigate", { url: `${baseUrl}/` });
await sleep(2500);
await evaluate(`window.localStorage.removeItem(${JSON.stringify(STORE_KEY)})`);
await call("Page.reload", { ignoreCache: false });
await sleep(3000);
await evaluate(helpers);

// 2) 发一条消息
await evaluate(`window.__type('textarea', '用一句话说明什么是事件协议')`);
await sleep(300);
await evaluate(`document.querySelector('button[aria-label="发送"]').click()`);
await waitIdle("首次生成");
const first = await store();
console.log(`1. 首次回答: 消息数=${first.count} 助手长度=${first.messages[1]?.len}`);

// 3) 重新生成
await evaluate(`document.querySelector('button[aria-label="重新生成"]').click()`);
await waitIdle("重新生成");
const regen = await store();
console.log(
  `2. 重新生成: 消息数=${regen.count} 新回答长度=${regen.messages[1]?.len} 内容变了=${regen.messages[1]?.content !== first.messages[1]?.content}`,
);

// 4) 编辑重发
await evaluate(`document.querySelector('button[aria-label="编辑这条消息"]').click()`);
await sleep(500);
const editBox = await evaluate(`!!document.querySelector('main textarea')`);
await evaluate(`window.__type('main textarea', '换一个问题：只回答两个字「好的」')`);
await sleep(300);
const submitted = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('main button')].find((b) => b.textContent.includes('保存并重发'));
  if (!btn) return 'no-submit';
  btn.click();
  return 'clicked';
})()`);
await waitIdle("编辑重发");
const edited = await store();
console.log(
  `3. 编辑重发: 编辑框出现=${editBox} 提交=${submitted} 消息数=${edited.count} 用户消息="${edited.messages[0]?.content}" 新回答长度=${edited.messages[1]?.len}`,
);

// 5) 复制：用户气泡和助手气泡各验证一次
const copyResults = await evaluate(`(async () => {
  const btns = [...document.querySelectorAll('main button[aria-label="复制"]')];
  if (btns.length < 2) return { error: 'copy buttons missing', count: btns.length };
  const out = [];
  for (const [i, label] of [[0, '用户'], [btns.length - 1, '助手']]) {
    window.__copied = null;
    btns[i].click();
    await new Promise((r) => setTimeout(r, 200));
    out.push({ 角色: label, 长度: window.__copied ? window.__copied.length : 0, 开头: (window.__copied ?? '').slice(0, 24) });
  }
  return { 按钮数: btns.length, out };
})()`);
console.log("4. 复制:", JSON.stringify(copyResults));

// 6) 刷新后动作条仍在、历史没丢
await call("Page.reload", { ignoreCache: false });
await sleep(3200);
const afterReload = await store();
const ui = await evaluate(`(() => ({
  regenBtn: !!document.querySelector('button[aria-label="重新生成"]'),
  editBtn: !!document.querySelector('button[aria-label="编辑这条消息"]'),
  copyBtn: !!document.querySelector('main button[aria-label="复制"]'),
}))()`);
console.log(
  `5. 刷新后: 消息数=${afterReload.count} 重新生成=${ui.regenBtn} 编辑=${ui.editBtn} 复制=${ui.copyBtn}`,
);

ws.close();
