// 端到端自检（多会话版）：
//   清历史 → 发送并确认流式增长 → 新对话 → 切回原会话 → 刷新验证持久化 → 删除会话 → 截图
// 用法：node scripts/e2e-chat.mjs [outDir]   环境变量：CDP_PORT、BASE_URL
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT ?? 9223);
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const outDir = process.argv[2] ?? ".";
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

const snapshot = () =>
  evaluate(`(() => {
    const main = document.querySelector('main');
    const aside = document.querySelector('aside');
    const store = window.localStorage.getItem(${JSON.stringify(STORE_KEY)});
    let parsed = null;
    try { parsed = store ? JSON.parse(store) : null; } catch {}
    return {
      mainLen: main ? main.innerText.length : 0,
      mainText: main ? main.innerText.slice(0, 200) : '',
      hero: !!main && main.innerText.includes('有什么可以帮你的'),
      sessionCount: parsed?.sessions?.length ?? 0,
      activeId: parsed?.activeId ?? null,
      titles: (parsed?.sessions ?? []).map((s) => s.title),
      sidebarTitles: aside ? [...aside.querySelectorAll('button[data-session-id]')].map((b) => b.title) : [],
      streaming: !!document.querySelector('button[aria-label="停止生成"]'),
      newChatBtn: !!document.querySelector('button[aria-label="新对话"]'),
    };
  })()`);

// 1) 清空历史，回到空态
await call("Page.navigate", { url: `${baseUrl}/` });
await sleep(2500);
await evaluate(`window.localStorage.removeItem(${JSON.stringify(STORE_KEY)}); window.localStorage.removeItem('chat-mini/messages/v1');`);
await call("Page.reload", { ignoreCache: false });
await sleep(3000);
console.log("1. 空态:", JSON.stringify(await snapshot()));

// 2) 点建议 → 发送
const clicked = await evaluate(`(() => {
  const chip = document.querySelector('main button');
  if (!chip) return 'no-chip';
  chip.click();
  return chip.textContent.trim();
})()`);
console.log("2. 建议:", clicked);
await sleep(400);

const sent = await evaluate(`(() => {
  const btn = document.querySelector('button[aria-label="发送"]');
  if (!btn) return 'no-send-button';
  const wasDisabled = btn.disabled;
  btn.click();
  return wasDisabled ? 'was-disabled' : 'sent';
})()`);
console.log("3. 发送:", sent);

// 3) 采样确认在流式增长
const samples = [];
for (let i = 0; i < 5; i += 1) {
  await sleep(900);
  const s = await snapshot();
  samples.push({ len: s.mainLen, streaming: s.streaming });
}
console.log("4. 采样:", JSON.stringify(samples));

// 等流式结束
for (let i = 0; i < 25; i += 1) {
  const s = await snapshot();
  if (!s.streaming) break;
  await sleep(600);
}
const afterAnswer = await snapshot();
console.log(
  `5. 首条会话: 标题="${afterAnswer.titles[0]}" 会话数=${afterAnswer.sessionCount} 正文=${afterAnswer.mainLen}字`,
);

// 4) 新对话
await evaluate(`document.querySelector('button[aria-label="新对话"]').click()`);
await sleep(1200);
const afterNew = await snapshot();
console.log(`6. 新对话: 空态=${afterNew.hero} 会话数=${afterNew.sessionCount} 标题=${JSON.stringify(afterNew.titles)}`);

// 5) 切回第一个会话（新建的空会话排最前，取最后一个 = 刚才聊过的那条）
const switched = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('aside button[data-session-id]')];
  const target = buttons[buttons.length - 1];
  if (!target) return 'no-session';
  target.click();
  return target.title;
})()`);
await sleep(1200);
const afterSwitch = await snapshot();
console.log(`7. 切回 "${switched}": 正文=${afterSwitch.mainLen}字 空态=${afterSwitch.hero} 标题一致=${afterSwitch.sidebarTitles[afterSwitch.sidebarTitles.length - 1] === switched}`);

// 6) 刷新验证持久化
await call("Page.reload", { ignoreCache: false });
await sleep(3200);
const afterReload = await snapshot();
console.log(
  `8. 刷新后: 会话数=${afterReload.sessionCount} 正文=${afterReload.mainLen}字 空态=${afterReload.hero} activeId一致=${afterReload.activeId === afterSwitch.activeId}`,
);

// 7) 删除当前会话
const deletedActive = await evaluate(`(() => {
  const active = document.querySelector('aside button[data-session-id]');
  if (!active) return 'no-session';
  const row = active.closest('[data-session-row]');
  const btn = row?.querySelector('button[aria-label="删除会话"]');
  if (!btn) return 'no-delete-button';
  btn.click();
  return 'deleted';
})()`);
await sleep(1200);
const afterDelete = await snapshot();
console.log(`9. 删除列表第一条(${deletedActive}): 会话数=${afterDelete.sessionCount} 标题=${JSON.stringify(afterDelete.titles)}`);

mkdirSync(outDir, { recursive: true });
for (const [name, url] of [
  ["chat-sessions.png", `${baseUrl}/`],
  ["preview-page.png", `${baseUrl}/preview`],
]) {
  await call("Page.navigate", { url });
  await sleep(4200);
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(shot.data, "base64"));
  console.log("screenshot:", join(outDir, name));
}

ws.close();
