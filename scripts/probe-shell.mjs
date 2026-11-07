// 界面骨架自检：截图看折叠侧栏 / 账号卡片 / 设置面板
// 用法：node scripts/probe-shell.mjs [输出目录]
// 前置：dev 已启动（BASE_URL）、Chrome 带调试端口（CDP_PORT）、demo 账号存在
import { mkdirSync, writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT ?? 9223);
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const outDir = process.argv[2] ?? "./shots-framework";
const PASSWORD = process.env.E2E_PASS ?? "DemoPass2026!";
const LOGIN = process.env.E2E_USER ?? "demo";

mkdirSync(outDir, { recursive: true });
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

const problems = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    problems.push(`exception: ${msg.params.exceptionDetails?.text ?? "?"}`);
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  }
});

await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await call("Page.enable");
await call("Runtime.enable");

const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};

const shot = async (name) => {
  const { data } = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, "base64"));
  console.log("shot:", `${outDir}/${name}.png`);
};

const clickByText = (selector, text) =>
  evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const hit = nodes.find((n) => (n.innerText || n.textContent || "").trim().includes(${JSON.stringify(text)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);

const goto = async (ms = 3200) => {
  await call("Page.navigate", { url: `${baseUrl}/` });
  await sleep(ms);
};

// 先把折叠状态归零，截图才有对照
await goto(2500);
await evaluate(`window.localStorage.removeItem("chat-mini:sidebar-collapsed")`);

// 登录 demo（拿真账号信息来验账号卡片）
const loginResult = await evaluate(`(async () => {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ${JSON.stringify(LOGIN)}, password: ${JSON.stringify(PASSWORD)} }),
  });
  return res.status;
})()`);
console.log("login status:", loginResult);

await goto(4000);
console.log("user in sidebar:", await evaluate(`document.querySelector("aside button[aria-haspopup]")?.innerText.replace(/\\s+/g, " ")`));
await shot("01-expanded");

// 账号卡片（已登录：身份 + 套餐/用量 + 设置入口）
await evaluate(`document.querySelector('aside button[aria-haspopup="dialog"]').click()`);
await sleep(600);
await shot("02-account-card");

// 从卡片进设置：外观
console.log("click 外观:", await clickByText('aside [role="dialog"] button', "外观"));
await sleep(800);
await shot("03-settings-appearance");

// 设置：账号与安全
console.log("click 账号与安全:", await clickByText('[role="dialog"] nav button', "账号与安全"));
await sleep(500);
await shot("04-settings-account");

// 设置：通用
console.log("click 通用:", await clickByText('[role="dialog"] nav button', "通用"));
await sleep(400);
await shot("05-settings-general");

// Esc 关掉设置
await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(500);
console.log("settings closed:", !(await evaluate(`!!document.querySelector('[role="dialog"][aria-label="设置"]')`)));

// 折叠
console.log("collapse:", await evaluate(`(() => { const b = document.querySelector('aside button[aria-label="收起侧栏"]'); if (!b) return false; b.click(); return true; })()`));
await sleep(900);
console.log("aside width:", await evaluate(`getComputedStyle(document.querySelector("aside")).width`));
await shot("06-collapsed");

// 折叠态账号卡片
await evaluate(`document.querySelector('aside button[aria-haspopup="dialog"]').click()`);
await sleep(600);
await shot("07-collapsed-account");
await evaluate(`document.body.click()`);
await sleep(300);

// 刷新后是否记住折叠状态
await goto(4000);
console.log("collapsed after reload:", await evaluate(`document.querySelector("aside")?.dataset.collapsed`));
await shot("08-after-reload");

// 展开回去
await evaluate(`document.querySelector('aside button[aria-label="展开侧栏"]')?.click()`);
await sleep(600);
console.log("flag after expand:", await evaluate(`window.localStorage.getItem("chat-mini:sidebar-collapsed")`));

// 移动端：抽屉
await call("Emulation.setDeviceMetricsOverride", {
  width: 420,
  height: 860,
  deviceScaleFactor: 2,
  mobile: true,
});
await goto(3500);
await shot("09-mobile");
await evaluate(`document.querySelector('button[aria-label="打开侧栏"]')?.click()`);
await sleep(700);
await shot("10-mobile-drawer");
await call("Emulation.clearDeviceMetricsOverride");

console.log(problems.length ? `problems:\n - ${problems.join("\n - ")}` : "no console errors");
ws.close();
