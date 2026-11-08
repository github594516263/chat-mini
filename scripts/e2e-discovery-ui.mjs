// 模型发现 UI 自检：真实 DeepSeek /models + 一键导入
//   node scripts/e2e-discovery-ui.mjs
// 前置：dev 在 3123、headless Chrome 9223、.env.local 有真实 DEEPSEEK_API_KEY。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CDP_PORT ?? 9223);
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const username = process.env.E2E_USER ?? "demo2";
const password = process.env.E2E_PASS ?? "DemoPass2026!";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq > 0) env[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return env;
}

const env = loadEnv();
const deepseekKey = env.DEEPSEEK_API_KEY;
const providerName = `[e2e] discovery-ui ${Date.now().toString().slice(-5)}`;

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

const waitFor = async (expression, timeoutMs = 20000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return true;
    await sleep(250);
  }
  return false;
};

const clickText = (text) =>
  evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('找不到按钮: ' + ${JSON.stringify(text)});
    button.click();
    return true;
  })()`);

const fillInput = (placeholderPart, value) =>
  evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find((item) => item.placeholder.includes(${JSON.stringify(placeholderPart)}));
    if (!input) throw new Error('找不到输入框: ' + ${JSON.stringify(placeholderPart)});
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

try {
  if (!deepseekKey) throw new Error(".env.local 里没有 DEEPSEEK_API_KEY，跳过真实发现 UI 测试");
  console.log("模型发现 UI");

  await call("Page.navigate", { url: `${baseUrl}/` });
  await sleep(2200);
  const login = await evaluate(`fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)} }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
  check("登录测试账号", login.status === 200);
  await call("Page.reload");
  await sleep(2200);

  const prepared = await evaluate(`(async () => {
    const list = await fetch('/api/models/providers').then((response) => response.json());
    for (const provider of list.providers ?? []) {
      if (provider.name.startsWith('[e2e] discovery-ui')) {
        await fetch('/api/models/providers/' + encodeURIComponent(provider.id), { method: 'DELETE' });
      }
    }
    const response = await fetch('/api/models/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ${JSON.stringify(providerName)},
        baseUrl: 'https://api.deepseek.com',
        protocol: 'openai-chat',
        authType: 'api_key',
        apiKey: ${JSON.stringify(deepseekKey)},
        enabled: true,
      }),
    });
    return { status: response.status, body: await response.json() };
  })()`);
  check("准备真实 provider", prepared.status === 201, JSON.stringify(prepared.body));
  await call("Page.reload");
  await sleep(2200);

  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
  await sleep(700);
  await clickText("模型");
  await sleep(700);

  await clickText("添加模型提供商");
  await sleep(300);
  check(
    "新建表单里能看到测试连接",
    await evaluate(`(() => [...document.querySelectorAll('button')].some((item) => item.innerText.trim() === '测试连接'))()`),
  );
  await fillInput("gateway.example", "https://api.deepseek.com");
  await fillInput("sk-", deepseekKey);
  await sleep(400);
  await clickText("测试连接");
  check("新建前测试连接成功", await waitFor(`document.body.innerText.includes('连接成功')`, 20000));
  check(
    "新建前测试显示发现数量",
    await evaluate(`document.body.innerText.includes('发现') && document.body.innerText.includes('个模型')`),
  );
  await clickText("取消");
  await sleep(300);

  await clickText("测试连接");
  const discovered = await waitFor(`document.body.innerText.includes('连接成功')`, 20000);
  check("UI 连接成功", discovered);
  check(
    "UI 显示发现数量",
    await evaluate(`document.body.innerText.includes('发现') && document.body.innerText.includes('个模型')`),
  );
  check(
    "UI 有添加选中按钮",
    await evaluate(`(() => [...document.querySelectorAll('button')].some((item) => item.innerText.includes('添加选中')))()`),
  );

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.includes('添加选中'));
    button.click();
  })()`);
  check("UI 一键导入", await waitFor(`document.body.innerText.includes('已导入')`, 10000));

  await evaluate(`document.querySelector('button[aria-label="关闭设置"]')?.click()`);
  await sleep(700);
  const picker = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.includes('DeepSeek') || item.innerText.includes('配置模型'));
    return button?.innerText.trim() ?? null;
  })()`);
  check("composer 出现导入的模型", Boolean(picker) && !picker.includes("配置模型"), String(picker));

  console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : "，全部通过"}`);
  if (failures.length) {
    console.error(failures.map((failure) => `  - ${failure}`).join("\n"));
    process.exitCode = 1;
  }
} catch (error) {
  console.error("\n脚本异常:", error);
  process.exitCode = 1;
} finally {
  try {
    await evaluate(`(async () => {
      const list = await fetch('/api/models/providers').then((response) => response.json());
      const target = (list.providers ?? []).find((provider) => provider.name === ${JSON.stringify(providerName)});
      if (target) await fetch('/api/models/providers/' + encodeURIComponent(target.id), { method: 'DELETE' });
      return true;
    })()`);
  } catch {
    // ignore
  }
  ws.close();
}
