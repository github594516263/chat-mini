// 【临时·路由改造 A/B 实测】用 CDP 驱动无头 Chrome 量四个指标
//
//   node scripts/spike-routing.mjs [baseUrl]
//   默认 http://127.0.0.1:3133（生产构建）。环境变量：CDP_PORT
//
// 量的是同一份 UI 在三种导航方式下的表现：
//   A   真实嵌套路由 + RSC（主流 Next 做法，带 prefetch）
//   A-  同上但关掉 Link 预取（冷 RSC，最坏情况）
//   B   单路由 + 客户端取数（浅导航）
//
// 指标：切换耗时（点击→新内容上屏）、客户端状态是否存活（草稿 / 心跳）、
//       是否 remount、服务端请求形态。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ids = JSON.parse(readFileSync(join(root, "scripts", ".spike-sessions.json"), "utf8"));

const cdpPort = Number(process.env.CDP_PORT ?? 9223);
const baseUrl = (process.argv[2] ?? process.env.BASE_URL ?? "http://127.0.0.1:3133").replace(/\/$/, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Number(((s[mid - 1] + s[mid]) / 2).toFixed(1));
};

// ---------------------------------------------------------------- CDP 连接
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = targets.find((t) => t.type === "page");
if (!target) throw new Error("找不到 page target");

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;

let requests = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method === "Network.requestWillBeSent") {
    const url = msg.params.request.url;
    requests.push({
      url,
      rsc: url.includes("_rsc"),
      document: msg.params.type === "Document",
    });
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
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};

async function waitFor(expression, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(50);
  }
  return false;
}

const ready = () =>
  waitFor("!!(window.__probe && document.querySelector('[data-spike-draft]'))");

/** 在输入框里打草稿（走原生 setter，确保 React 状态真的更新了） */
const typeDraft = (text) =>
  evaluate(`(() => {
    const el = document.querySelector('[data-spike-draft]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(text)};
  })()`);

const snapshot = () =>
  evaluate(`(() => {
    const el = document.querySelector('[data-spike-draft]');
    return {
      probe: window.__probe ?? null,
      readyAt: window.__readyAt ?? null,
      fetchMs: window.__fetchMs ?? null,
      draft: el ? el.value : null,
      bodyLen: (document.querySelector('[data-spike-body]')?.innerText ?? '').length,
      path: location.pathname,
    };
  })()`);

const DRAFT = "DRAFT-TOKEN-还在吗";

async function switchOnce(index, currentId) {
  await typeDraft(DRAFT);
  await sleep(700); // 攒够心跳

  const before = await snapshot();
  requests = [];

  const t0 = await evaluate(`window.__readyAt = null; performance.now()`);
  await evaluate(
    `(() => { const el = document.querySelector('[data-nav-index="${index}"]'); if (!el) return false; el.click(); return true; })()`,
  );

  const changed = await waitFor(
    `!!(window.__probe && window.__probe.id && window.__probe.id !== ${JSON.stringify(currentId)})`,
    20000,
  );
  await sleep(500); // 让 re-render 与心跳稳定

  const after = await snapshot();

  return {
    index,
    changed,
    switchMs: after.readyAt !== null ? Number((after.readyAt - t0).toFixed(1)) : null,
    fetchMs: after.fetchMs !== null ? Number(after.fetchMs.toFixed(1)) : null,
    rscRequests: requests.filter((r) => r.rsc).length,
    documentRequests: requests.filter((r) => r.document).length,
    totalRequests: requests.length,
    mountsBefore: before.probe?.mounts ?? 0,
    mountsAfter: after.probe?.mounts ?? 0,
    remounted: (after.probe?.mounts ?? 0) > (before.probe?.mounts ?? 0),
    ticksBefore: before.probe?.ticks ?? 0,
    ticksAfter: after.probe?.ticks ?? 0,
    tickReset: (after.probe?.ticks ?? 0) < (before.probe?.ticks ?? 0),
    draftSurvived: after.draft === DRAFT,
    bodyLen: after.bodyLen,
    path: after.path,
    newId: after.probe?.id ?? null,
  };
}

async function navigate(url) {
  requests = [];
  await call("Page.navigate", { url });
  await waitFor("document.readyState === 'complete'");
  await ready();
  await sleep(400);
}

async function runScenario(label, url, rounds) {
  await navigate(url);
  let currentId = (await snapshot()).probe?.id ?? ids[0];
  const results = [];

  // 留一轮预热，避免把首帧抖动算进来
  const warmup = await switchOnce(1, currentId);
  currentId = warmup.newId ?? currentId;

  for (let i = 0; i < rounds; i += 1) {
    const index = 2 + (i % 4); // 2,3,4,5 循环
    const result = await switchOnce(index, currentId);
    currentId = result.newId ?? currentId;
    results.push(result);
  }

  return { label, url, results };
}

const scenarios = [
  ["A · 真实路由（带 prefetch）", `${baseUrl}/spike/route/${ids[0]}`, 5],
  ["A- · 真实路由（关 prefetch）", `${baseUrl}/spike/route/${ids[0]}?noprefetch=1`, 3],
  ["C · 真实路由 + 状态提升到 layout", `${baseUrl}/spike/route/${ids[0]}?hoist=1`, 5],
  ["B · 单路由浅导航", `${baseUrl}/spike/shallow`, 5],
];

const report = [];
for (const [label, url, rounds] of scenarios) {
  const outcome = await runScenario(label, url, rounds);
  report.push(outcome);
  console.log(`\n=== ${label} ===`);
  for (const r of outcome.results) {
    console.log(
      `  切换 #${r.index}: ${r.switchMs}ms | fetch ${r.fetchMs ?? "-"}ms | RSC ${r.rscRequests} | ` +
        `doc ${r.documentRequests} | remount ${r.remounted ? "是" : "否"} | ` +
        `心跳归零 ${r.tickReset ? "是" : "否"} | 草稿存活 ${r.draftSurvived ? "是" : "否"} | ` +
        `正文 ${r.bodyLen} 字 | ${r.path}`,
    );
  }
}

console.log("\n=== 汇总（中位数） ===");
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("场景", 28) + pad("切换ms", 10) + pad("RSC", 6) + pad("remount", 10) + pad("草稿", 8) + "心跳归零");
for (const s of report) {
  const withTiming = s.results.filter((r) => r.switchMs !== null);
  console.log(
    pad(s.label, 26) +
      pad(median(withTiming.map((r) => r.switchMs)), 10) +
      pad(median(s.results.map((r) => r.rscRequests)), 6) +
      pad(s.results.some((r) => r.remounted) ? "是" : "否", 10) +
      pad(s.results.every((r) => r.draftSurvived) ? "是" : "否", 8) +
      (s.results.some((r) => r.tickReset) ? "是" : "否"),
  );
}

// ---------------------------------------------------------------- 后退键
async function backCheck(label, url) {
  await navigate(url);
  const start = await snapshot();
  await evaluate(`window.__readyAt = null; true`);
  await evaluate(
    `(() => { const el = document.querySelector('[data-nav-index="2"]'); if (!el) return false; el.click(); return true; })()`,
  );
  await waitFor(
    `!!(window.__probe && window.__probe.id && window.__probe.id !== ${JSON.stringify(start.probe?.id)})`,
    20000,
  );
  await sleep(600);

  const afterSwitch = await snapshot();
  // 关键对照：后退时如果 RSC 请求为 0，说明 RSC payload 被 Router Cache 命中了，
  // 但组件状态（草稿）会不会回来？这一组数据用来区分"缓存数据"和"缓存状态"。
  await typeDraft("BACK-DRAFT-还在吗");
  await sleep(400);
  requests = [];
  await evaluate("history.back(); true");
  await sleep(1200);
  const afterBack = await snapshot();

  const returned =
    afterBack.path === start.path && afterBack.probe?.id === start.probe?.id;

  console.log(
    `${pad(label, 26)} 切换后 ${afterSwitch.path}\n` +
      `${pad("", 26)} 后退后 ${afterBack.path} → ${returned ? "回到原会话 ✅" : "未回到原会话 ❌"}` +
      ` | 后退期间 RSC ${requests.filter((r) => r.rsc).length} 次` +
      ` | 后退后草稿 ${afterBack.draft === "BACK-DRAFT-还在吗" ? "还在" : "没了"}` +
      ` | remount 数 ${afterBack.probe?.mounts ?? "-"}`,
  );
  return returned;
}

console.log("\n=== 后退键 ===");
await backCheck("A/C · 真实路由", `${baseUrl}/spike/route/${ids[0]}?hoist=1`);
await backCheck("B · 单路由浅导航", `${baseUrl}/spike/shallow`);

ws.close();
process.exit(0);
