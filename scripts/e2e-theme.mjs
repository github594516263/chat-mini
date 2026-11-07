// 端到端自检（主题版）：首屏不闪白 / 三态切换 / 持久化 / 代码高亮跟随
// 用法：node scripts/e2e-theme.mjs   环境变量：CDP_PORT、BASE_URL
const port = Number(process.env.CDP_PORT ?? 9223);
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const THEME_KEY = "chat-mini/theme/v1";
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

const state = () =>
  evaluate(`(() => {
    const root = document.documentElement;
    const bg = getComputedStyle(document.body).backgroundColor;
    const token = document.querySelector('main pre code span[style]');
    return {
      dark: root.classList.contains("dark"),
      colorScheme: getComputedStyle(root).colorScheme,
      bg,
      stored: window.localStorage.getItem(${JSON.stringify(THEME_KEY)}),
      tokenColor: token ? getComputedStyle(token).color : null,
      menuOpen: !!document.querySelector('[role="menu"]'),
    };
  })()`);

const pickTheme = async (label) => {
  await evaluate(`document.querySelector('button[aria-label^="主题"]').click()`);
  await sleep(350);
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!item) return 'no-item';
    item.click();
    return 'clicked';
  })()`);
  await sleep(500);
  return clicked;
};

// 0) 首屏防闪：页面注入采样器，记录 .dark 出现时刻 vs 首次绘制时刻
await call("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__trace = [];
    (function () {
      const push = () => window.__trace.push({
        t: Math.round(performance.now()),
        dark: document.documentElement.classList.contains('dark'),
      });
      document.addEventListener('DOMContentLoaded', push);
      new MutationObserver(push).observe(document.documentElement, {
        attributes: true, attributeFilter: ['class'],
      });
      push();
    })();`,
});

// 1) 准备：一条带代码块的会话 + 主题设为深色后再刷新，用来测"首屏是否闪白"
await call("Page.navigate", { url: `${baseUrl}/` });
await sleep(2500);
await evaluate(`(() => {
  const now = Date.now();
  const fence = String.fromCharCode(96, 96, 96);
  const code = fence + 'js\\nconst a = 1;\\nconst b = 2;\\nconsole.log(a + b);\\n' + fence;
  window.localStorage.setItem(${JSON.stringify(STORE_KEY)}, JSON.stringify({
    sessions: [{
      id: 'theme-1', title: '代码高亮检查', createdAt: now, updatedAt: now,
      messages: [
        { id: 'theme-1-u', role: 'user', content: '给段代码' },
        { id: 'theme-1-a', role: 'assistant', content: code },
      ],
    }],
    activeId: 'theme-1',
  }));
  window.localStorage.setItem(${JSON.stringify(THEME_KEY)}, 'dark');
})()`);
await call("Page.reload", { ignoreCache: false });
await sleep(3000);

const trace = await evaluate(`(() => {
  const fcp = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
  const firstDark = (window.__trace ?? []).find((s) => s.dark);
  return {
    fcp: fcp ? Math.round(fcp.startTime) : null,
    firstDarkAt: firstDark ? firstDark.t : null,
    samples: (window.__trace ?? []).length,
    domContentLoadedAt: null,
  };
})()`);
console.log(
  `1. 首屏: .dark 出现于 ${trace.firstDarkAt}ms，首次绘制 ${trace.fcp}ms，闪白=${trace.firstDarkAt === null || (trace.fcp !== null && trace.firstDarkAt > trace.fcp)}`,
);

const html = await evaluate(`fetch('/').then((r) => r.text())`);
console.log(
  `2. SSR 内联脚本: 含主题初始化=${html.includes("chat-mini/theme/v1") && html.includes('classList.toggle("dark"')} 位置在 </head> 前=${html.indexOf("chat-mini/theme/v1") < html.indexOf("</head>")}`,
);

// 2) 深色态现状
const dark = await state();
console.log(`3. 深色: class=${dark.dark} colorScheme=${dark.colorScheme} bg=${dark.bg} 存储=${dark.stored} 代码色=${dark.tokenColor}`);

// 3) 切浅色
console.log(`4. 点「浅色」: ${await pickTheme("浅色")}`);
const light = await state();
console.log(`   结果: class=${light.dark} bg=${light.bg} 存储=${light.stored} 代码色=${light.tokenColor}`);
console.log(`   代码高亮随主题变化=${dark.tokenColor !== light.tokenColor}`);

// 4) 刷新后保持浅色
await call("Page.reload", { ignoreCache: false });
await sleep(2800);
const afterReload = await state();
console.log(`5. 刷新后: class=${afterReload.dark} 存储=${afterReload.stored}`);

// 5) 跟随系统：模拟系统深色
console.log(`6. 点「跟随系统」: ${await pickTheme("跟随系统")}`);
const sysLight = await state();
await call("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "dark" }],
});
await sleep(800);
const sysDark = await state();
console.log(
  `   系统浅色时 dark=${sysLight.dark} / 系统深色时 dark=${sysDark.dark} 存储=${sysDark.stored} 跟随生效=${sysLight.dark === false && sysDark.dark === true}`,
);

// 6) 切回浅色后系统仍是深色，验证"手动"能压过系统
await call("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "light" }],
});
await sleep(500);
await pickTheme("浅色");
await call("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "dark" }],
});
await sleep(800);
const forcedLight = await state();
console.log(`7. 手动浅色 + 系统深色: dark=${forcedLight.dark}（应为 false）存储=${forcedLight.stored}`);

await call("Emulation.setEmulatedMedia", { features: [] });
ws.close();
