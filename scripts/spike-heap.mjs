// 【临时】量 keep-alive 的真实内存代价
//   node scripts/spike-heap.mjs [baseUrl]
//
// 在**同一个文档**内逐步打开会话（变体 D 把访问过的会话树全部保留挂载），
// 每开一条量一次 JS 堆与 DOM 节点，得到"每条会话的保活成本"，再与状态提升对比。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ids = JSON.parse(readFileSync(join(root, "scripts", ".spike-sessions.json"), "utf8"));
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:3123").replace(/\/$/, "");
const cdpPort = Number(process.env.CDP_PORT ?? 9223);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = targets.find((t) => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
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
await call("HeapProfiler.enable");

const evaluate = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};
const waitFor = async (expression, timeout = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
};

async function measure() {
  await call("HeapProfiler.collectGarbage");
  await sleep(150);
  await call("HeapProfiler.collectGarbage");
  await sleep(150);
  return evaluate(`({
    heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
    nodes: document.getElementsByTagName('*').length,
    kept: document.querySelectorAll('[data-kept-session]').length
  })`);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

await call("Page.navigate", { url: `${baseUrl}/spike/keepalive` });
await waitFor("document.readyState === 'complete' && document.querySelectorAll('[data-kept-session]').length === 1");
await sleep(800);

const rows = [];
const first = await measure();
rows.push({ n: 1, ...first });

// 逐步多开几条，每条都保留挂载
for (let i = 1; i <= 11; i += 1) {
  await evaluate(`document.querySelector('[data-nav-index="${i}"]').click(); true`);
  await sleep(500);
  await waitFor(`document.querySelectorAll('[data-kept-session]').length === ${i + 1}`, 10000);
  await sleep(300);
  rows.push({ n: i + 1, ...(await measure()) });
}

console.log("=== keep-alive：同时保活 N 条会话的真实成本 ===");
console.log("保活条数   JS 堆      DOM 节点   相较 1 条增量");
for (const row of rows) {
  const delta = row.heap - first.heap;
  console.log(
    `${String(row.n).padStart(6)}   ${mb(row.heap).padEnd(10)} ${String(row.nodes).padStart(7)}    ` +
      `${delta === 0 ? "-" : `+${mb(delta)}`}`,
  );
}

const last = rows[rows.length - 1];
const firstRow = rows[0];
const perSession = (last.heap - firstRow.heap) / (last.n - firstRow.n);
const perSessionNodes = (last.nodes - firstRow.nodes) / (last.n - firstRow.n);
console.log(
  `\n→ 每多保活 1 条会话：JS 堆 +${mb(perSession)}，DOM +${Math.round(perSessionNodes)} 个节点` +
    `（20 条消息的纯文本正文；真实应用带 Markdown 渲染会显著更高）`,
);
console.log("\n=== 外推（同一份数据）===");
for (const n of [5, 10, 20, 50]) {
  console.log(`  keep-alive 保活 ${String(n).padStart(2)} 条 ≈ ${mb(perSession * n)}`);
}
console.log("  状态提升：每会话只存 草稿字符串 + run 元数据 ≈ 几个 KB 量级，与条数近似无关");

ws.close();
process.exit(0);
