// 账户模型设置 UI 自检
//   node scripts/e2e-models-ui.mjs
// 前置：dev 跑在 3123、headless Chrome 带 --remote-debugging-port=9223、测试账号 demo2 存在。
const port = Number(process.env.CDP_PORT ?? 9223);
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const username = process.env.E2E_USER ?? "demo2";
const password = process.env.E2E_PASS ?? "DemoPass2026!";
const providerName = `[e2e] UI 网关 ${Date.now().toString().slice(-5)}`;

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
    return;
  }
  if (message.method === "Page.javascriptDialogOpening") {
    void call("Page.handleJavaScriptDialog", { accept: true });
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

const waitFor = async (expression, timeoutMs = 6000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return true;
    await sleep(180);
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

const setInput = (placeholder, value) =>
  evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find((item) => item.placeholder === ${JSON.stringify(placeholder)});
    if (!input) throw new Error('找不到输入框: ' + ${JSON.stringify(placeholder)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

const textIncludes = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;

try {
  console.log("账户模型设置 UI");

  await call("Page.navigate", { url: `${baseUrl}/` });
  await sleep(2400);
  const login = await evaluate(`fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)} }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
  check("浏览器里登录测试账号", login.status === 200, JSON.stringify(login.body));
  await call("Page.reload");
  await sleep(2600);

  const emptyPicker = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.includes('配置模型'));
    const send = document.querySelector('button[aria-label="发送"]');
    return {
      picker: button?.innerText.trim() ?? null,
      sendDisabled: send?.disabled ?? null,
      hint: document.body.innerText.includes('还没有可用模型'),
    };
  })()`);
  check("空目录时触发器显示「配置模型」", emptyPicker.picker?.includes("配置模型"), JSON.stringify(emptyPicker));
  check("空目录时发送按钮禁用", emptyPicker.sendDisabled === true);
  check("空目录时显示提示", emptyPicker.hint);

  await evaluate(`[...document.querySelectorAll('button')].find((item) => item.innerText.includes('配置模型')).click()`);
  await sleep(900);
  const settings = await evaluate(`(() => ({
    dialog: document.querySelector('[role="dialog"][aria-label="设置"]') !== null,
    heading: document.body.innerText.includes('配置了哪些模型'),
    empty: document.body.innerText.includes('还没有模型提供商'),
    section: [...document.querySelectorAll('button')].some((item) => item.innerText.trim() === '模型'),
  }))()`);
  check("点空触发器打开设置", settings.dialog);
  check("落在「模型」设置页", settings.heading);
  check("设置页显示空状态", settings.empty);
  check("导航里有「模型」分类", settings.section);

  await clickText("添加模型提供商");
  await setInput("例如：星链", providerName);
  await setInput("https://gateway.example/v1", "https://gateway.example.com/v1");
  await setInput("sk-…", "sk-e2e-ui-not-a-real-key");
  await clickText("创建");
  check("UI 创建 provider 成功", await waitFor(textIncludes(providerName)));

  const statusAfterCreate = await evaluate(`document.body.innerText.includes('没有模型')`);
  check("新 provider 显示「没有模型」状态", statusAfterCreate);

  await clickText("添加模型");
  await sleep(250);
  await setInput("deepseek-v4-flash", "e2e-ui-model");
  await setInput("跟模型 ID 一样", "E2E UI 模型");
  await setInput("256K", "128K");
  await setInput("32K", "16K");
  await clickText("添加");
  check("UI 添加模型成功", await waitFor(textIncludes("E2E UI 模型")));
  check("provider 状态变为已配置", await waitFor(textIncludes("已配置")));

  await clickText("添加等级");
  await sleep(250);
  await setInput("名称，例如 高", "高");
  await setInput("上游值，例如 high", "high");
  await clickText("保存");
  check("UI 保存推理等级", await waitFor(textIncludes("模型已保存")));

  await evaluate(`document.querySelector('button[aria-label="关闭设置"]').click()`);
  await sleep(600);
  const reasoningPicker = await evaluate(`(() => {
    const select = document.querySelector('select[title="推理等级"]');
    return select
      ? { value: select.value, options: [...select.options].map((item) => item.textContent) }
      : null;
  })()`);
  check("composer 出现推理等级选择", Boolean(reasoningPicker), JSON.stringify(reasoningPicker));
  check(
    "推理等级选项来自账户模型",
    reasoningPicker?.options?.includes("高"),
    JSON.stringify(reasoningPicker),
  );
  const afterModel = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.includes('E2E UI 模型'));
    return button?.innerText.trim() ?? null;
  })()`);
  check("composer 只显示账户模型", afterModel?.includes("E2E UI 模型"), String(afterModel));

  await evaluate(`document.querySelector('[data-composer]').focus()`);
  await evaluate(`(() => {
    const textarea = document.querySelector('[data-composer]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '测试');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(250);
  check(
    "有模型时输入后可以发送",
    (await evaluate(`document.querySelector('button[aria-label="发送"]').disabled`)) === false,
  );
  await evaluate(`(() => {
    const textarea = document.querySelector('[data-composer]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.includes('E2E UI 模型'));
    button.click();
  })()`);
  await sleep(400);
  const options = await evaluate(`[...document.querySelectorAll('[role="option"]')].map((item) => item.innerText.replace(/\\n/g, ' '))`);
  check("选择器里只有账户模型", options.length === 1, JSON.stringify(options));
  check("选项名正确", options[0]?.includes("E2E UI 模型"));
  check("系统模型没有混进来", !options.some((text) => text.includes("DeepSeek-V4")));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(250);

  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
  await sleep(700);
  await clickText("模型");
  await sleep(700);

  const toggle = await evaluate(`(() => {
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((item) => item.parentElement?.innerText.includes('使用系统默认模型'));
    return checkbox ? checkbox.checked : null;
  })()`);
  check("系统默认开关默认关闭", toggle === false, String(toggle));
  await evaluate(`(() => {
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((item) => item.parentElement?.innerText.includes('使用系统默认模型'));
    checkbox.click();
  })()`);
  await sleep(900);
  check(
    "系统默认开关可打开",
    (await evaluate(`(() => {
      const checkbox = [...document.querySelectorAll('input[type="checkbox"]')]
        .find((item) => item.parentElement?.innerText.includes('使用系统默认模型'));
      return checkbox.checked;
    })()`)) === true,
  );
  await evaluate(`(() => {
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((item) => item.parentElement?.innerText.includes('使用系统默认模型'));
    checkbox.click();
  })()`);
  await sleep(900);
  check(
    "系统默认开关可以再关掉",
    (await evaluate(`(() => {
      const checkbox = [...document.querySelectorAll('input[type="checkbox"]')]
        .find((item) => item.parentElement?.innerText.includes('使用系统默认模型'));
      return checkbox.checked;
    })()`)) === false,
  );

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label')?.startsWith('删除 ' + ${JSON.stringify(providerName)}));
    if (!button) throw new Error('找不到删除按钮');
    button.click();
  })()`);
  await sleep(1200);
  check("UI 删除 provider 后回到空状态", await waitFor(textIncludes("还没有模型提供商"), 6000));

  await evaluate(`document.querySelector('button[aria-label="关闭设置"]')?.click()`);
  await sleep(500);
  check("删除后 composer 回到空状态", await waitFor(textIncludes("还没有可用模型"), 5000));

  console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : "，全部通过"}`);
  if (failures.length) {
    console.error(failures.map((failure) => `  - ${failure}`).join("\n"));
    process.exitCode = 1;
  }
} catch (error) {
  console.error("\n脚本异常:", error);
  process.exitCode = 1;
} finally {
  // 不论成败，按名字清理这次 UI 测试造的数据
  try {
    await evaluate(`(async () => {
      const list = await fetch('/api/models/providers').then((response) => response.json());
      const target = (list.providers ?? []).find((provider) => provider.name === ${JSON.stringify(providerName)});
      if (target) {
        await fetch('/api/models/providers/' + encodeURIComponent(target.id), { method: 'DELETE' });
      }
      return true;
    })()`);
  } catch {
    // 页面可能已经关了，忽略
  }
  ws.close();
}
