// 模型切换器自检：默认值 / 搜索 / 选择 / 持久化 / 键盘 / 请求体 / 服务端校验
// 用法：node scripts/e2e-model-picker.mjs
// 环境变量：CDP_PORT（默认 9223）、BASE_URL（默认 http://127.0.0.1:3123）
// 前置：无头 Chrome 已带 --remote-debugging-port 启动，dev server 已跑起来。
//
// 注意：这里不发真实模型请求。发送那一步用 CDP Fetch 域把 /api/chat 拦下来，
// 只检查报文里的 model 字段，然后故意 fail 掉，避免烧 token。

const port = Number(process.env.CDP_PORT ?? 9223);
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const MODEL_KEY = "chat-mini/model/v1/guest";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
let pausedChatBody = null;
let resolvePaused;
const pausedOnce = new Promise((resolve) => {
  resolvePaused = resolve;
});

const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    return;
  }
  if (message.method === "Fetch.requestPaused") {
    const { requestId, request } = message.params;
    if (request.url.endsWith("/api/chat")) {
      pausedChatBody = request.postData ?? "";
      resolvePaused?.();
      void call("Fetch.failRequest", { requestId, errorReason: "Failed" });
    } else {
      void call("Fetch.continueRequest", { requestId });
    }
  }
});

await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};

const triggerState = () =>
  evaluate(`(() => {
    const trigger = document.querySelector('button[aria-haspopup="listbox"]');
    return {
      text: trigger?.innerText.replace(/\\n/g, ' ') ?? null,
      expanded: trigger?.getAttribute('aria-expanded') ?? null,
      saved: localStorage.getItem(${JSON.stringify(MODEL_KEY)}),
      open: !!document.querySelector('[role="dialog"][aria-label="选择模型"]'),
    };
  })()`);

const openPicker = async () => {
  await evaluate(`document.querySelector('button[aria-haspopup="listbox"]').click()`);
  await sleep(300);
};

const search = async (text) => {
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="搜索模型"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(220);
};

const options = () =>
  evaluate(`[...document.querySelectorAll('[role="option"]')].map((option) => ({
    text: option.innerText.replace(/\\n/g, ' '),
    selected: option.getAttribute('aria-selected') === 'true',
    disabled: option.disabled,
  }))`);

await call("Page.navigate", { url: `${baseUrl}/` });
await sleep(3200);
// 这个脚本验的是游客目录；如果浏览器里还留着上一个脚本的登录态，先退出。
await evaluate(`fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})`);
await sleep(300);
await evaluate(`localStorage.removeItem(${JSON.stringify(MODEL_KEY)})`);
await call("Page.reload");
await sleep(3000);

console.log("1. 默认值与弹层结构");
let state = await triggerState();
check("默认模型是 DeepSeek-V4.1-Flash", state.text?.includes("DeepSeek-V4.1-Flash"), state.text);
check("默认有 1017 徽标", state.text?.includes("1017"), state.text);

await openPicker();
state = await triggerState();
check("弹层已打开", state.open);
const groups = await evaluate(
  `[...document.querySelectorAll('[role="group"]')].map((group) => group.innerText.replace(/\\n/g, ' | '))`,
);
check("四个 provider 分组", groups.length === 4, JSON.stringify(groups));
check("分组按 DeepSeek → 星链 → DevPoolAi → 肥猫005 排序", groups[0].startsWith("DeepSeek 账号") && groups[3].startsWith("肥猫005"), JSON.stringify(groups));
check("搜索框自动聚焦", (await evaluate(`document.activeElement?.getAttribute('aria-label')`)) === "搜索模型");
let list = await options();
check("共 7 条模型", list.length === 7, String(list.length));
check("选中项唯一", list.filter((option) => option.selected).length === 1);
check("未配置 provider 的模型不可选", list.filter((option) => option.disabled).length === 5);

console.log("2. 搜索");
await search("星链");
list = await options();
check("搜分组名能过滤到 3 条", list.length === 3, JSON.stringify(list));
check("搜索时保留分组标题", (await evaluate(`document.querySelector('[role="group"]').innerText`)).includes("星链"));
await search("没有这个模型");
check("空结果显示提示", await evaluate(`document.body.innerText.includes('没有匹配的模型')`));
await search("");
check("清空搜索恢复 7 条", (await options()).length === 7);

console.log("3. 点选与持久化");
await evaluate(`(() => {
  const option = [...document.querySelectorAll('[role="option"]')]
    .find((item) => item.innerText.includes('DeepSeek-V4-Pro'));
  option.click();
})()`);
await sleep(250);
state = await triggerState();
check("触发器更新为 DeepSeek-V4-Pro", state.text?.includes("DeepSeek-V4-Pro"), state.text);
check("弹层选择后关闭", !state.open);
check("选择写入 localStorage", state.saved === "deepseek:v4-pro", String(state.saved));

await call("Page.reload");
await sleep(2800);
state = await triggerState();
check("刷新后仍记住 DeepSeek-V4-Pro", state.text?.includes("DeepSeek-V4-Pro"), state.text);

console.log("4. 键盘操作");
await openPicker();
await evaluate(`(() => {
  const input = document.activeElement;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
})()`);
// 两次按键在真实键盘上必然隔一帧；合成事件放同一个 task 里 React 还没来得及重渲染
await sleep(120);
await evaluate(`(() => {
  const input = document.activeElement;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await sleep(250);
state = await triggerState();
check("ArrowDown 跳过 5 条未配置项并循环回 DeepSeek-V4.1-Flash", state.text?.includes("DeepSeek-V4.1-Flash"), state.text);
check("键盘选择也落盘", state.saved === "deepseek:v4.1-flash", String(state.saved));

console.log("5. 请求体里带 model");
await call("Fetch.enable", {
  patterns: [{ urlPattern: "*api/chat*", requestStage: "Request" }],
});
await evaluate(`(() => {
  const textarea = document.querySelector('[data-composer]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '只在测试里发一条');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(150);
await evaluate(`document.querySelector('button[aria-label="发送"]').click()`);
await Promise.race([pausedOnce, sleep(2500)]);
check("拦截到 /api/chat 请求", pausedChatBody !== null);
if (pausedChatBody) {
  const body = JSON.parse(pausedChatBody);
  check("报文含所选模型 id", body.model === "deepseek:v4.1-flash", String(body.model));
  check("游客报文仍带 messages", Array.isArray(body.messages) && body.messages.length > 0);
}
await call("Fetch.disable");

console.log("6. 服务端校验");
for (const [label, model, expected] of [
  ["未知模型返回 400", "nope", "未知模型"],
  ["未配置 provider 返回 400", "starlink:v4-flash", "还没有配置"],
  ["model 类型不对返回 400", 123, "model 必须是字符串"],
]) {
  const result = await evaluate(`fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: ${JSON.stringify(model)} }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
  check(label, result.status === 400 && result.body.error?.includes(expected), JSON.stringify(result));
}

console.log(`\n${passes(failures.length)}`);
ws.close();
if (failures.length > 0) {
  console.error(failures.map((failure) => `  - ${failure}`).join("\n"));
  process.exitCode = 1;
}

function passes(failureCount) {
  return `通过 ${passed} 项${failureCount > 0 ? `，失败 ${failureCount} 项` : "，全部通过"}`;
}
