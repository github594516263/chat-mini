// 端到端自检（断线续传版）
//  1. 发长回答 → 中途刷新 → 刷新后是否继续增长（方案 B 的核心）
//  2. 续传后内容是否重复（去重 / 水位正确性）
//  3. 停止生成：服务端 run 是否真的被取消
//  4. run 不存在（伪造过期 runId）→ 是否降级成"生成中断" + 继续生成
//  5. 继续生成：是否落在同一条气泡里接着写
const port = Number(process.env.CDP_PORT ?? 9232);
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const STORE_KEY = "chat-mini/sessions/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await call("Page.enable");
await call("Runtime.enable");
const evaluate = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

const snap = () =>
  evaluate(`(() => {
    const raw = window.localStorage.getItem(${JSON.stringify(STORE_KEY)});
    const store = raw ? JSON.parse(raw) : null;
    const s = store?.sessions?.find((x) => x.id === store.activeId) ?? store?.sessions?.[0];
    const msgs = s?.messages ?? [];
    const last = msgs[msgs.length - 1];
    const main = document.querySelector('main');
    return {
      msgCount: msgs.length,
      len: last?.content?.length ?? 0,
      tail: (last?.content ?? '').slice(-40),
      head: (last?.content ?? '').slice(0, 40),
      pending: last?.pending ?? null,
      interrupted: last?.interrupted ?? null,
      stopped: last?.stopped ?? null,
      runId: last?.runId ?? null,
      appliedSeq: last?.appliedSeq ?? null,
      streaming: !!document.querySelector('button[aria-label="停止生成"]'),
      hasContinueBtn: [...document.querySelectorAll('main button')].some((b) => b.textContent.includes('继续生成')),
      mainLen: main ? main.innerText.length : 0,
    };
  })()`);

const sendLongPrompt = async () => {
  await evaluate(`(() => {
    const el = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el,
      '写一篇1500字英文散文，主题是窗户。要分多段，每段都要长。');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  await evaluate(`document.querySelector('button[aria-label="发送"]').click()`);
};

// ---------- 准备 ----------
await call("Page.navigate", { url: `${baseUrl}/` });
await sleep(2500);
await evaluate(`window.localStorage.removeItem(${JSON.stringify(STORE_KEY)})`);
await call("Page.reload", { ignoreCache: false });
await sleep(3000);

// ---------- 1. 中途刷新 ----------
await sendLongPrompt();
for (let i = 0; i < 30; i += 1) {
  await sleep(400);
  const s = await snap();
  if (s.len > 300) break;
}
const before = await snap();
console.log(
  `1. 刷新前: 长度=${before.len} appliedSeq=${before.appliedSeq} pending=${before.pending} runId=${before.runId ? "有" : "无"}`,
);

await call("Page.reload", { ignoreCache: false });
await sleep(1200);
const justAfter = await snap();
await sleep(2500);
const growing = await snap();
await sleep(2500);
const grown = await snap();
console.log(
  `2. 刷新后瞬间: 长度=${justAfter.len} 界面正在流式=${justAfter.streaming}`,
);
console.log(
  `3. 刷新后继续增长: ${justAfter.len} → ${growing.len} → ${grown.len}（在长=${grown.len > justAfter.len}）`,
);

// 等生成结束
for (let i = 0; i < 120; i += 1) {
  const s = await snap();
  if (!s.streaming && !s.pending) break;
  await sleep(500);
}
const finished = await snap();
const duplicated = finished.tail === finished.head && finished.len > 80;
console.log(
  `4. 生成结束: 长度=${finished.len} pending=${finished.pending} 中断=${finished.interrupted} 头尾重复=${duplicated}`,
);
console.log(`   开头="${finished.head}"`);
console.log(`   结尾="${finished.tail}"`);

// ---------- 2. 停止生成 ----------
await sendLongPrompt();
for (let i = 0; i < 30; i += 1) {
  await sleep(400);
  const s = await snap();
  if (s.len > 200) break;
}
const beforeStop = await snap();
await evaluate(`document.querySelector('button[aria-label="停止生成"]').click()`);
await sleep(2000);
const afterStop = await snap();
await sleep(3000);
const stoppedLater = await snap();
console.log(
  `5. 停止: 停前=${beforeStop.len} → 停后=${afterStop.len} → 3秒后=${stoppedLater.len}（真的停了=${afterStop.len === stoppedLater.len}）stopped标记=${stoppedLater.stopped}`,
);

// ---------- 3. run 不存在 → 降级 ----------
await evaluate(`(() => {
  const raw = window.localStorage.getItem(${JSON.stringify(STORE_KEY)});
  const store = JSON.parse(raw);
  const s = store.sessions.find((x) => x.id === store.activeId) ?? store.sessions[0];
  const now = Date.now();
  s.messages = [
    { id: 'fake-u', role: 'user', content: '写一段英文' },
    { id: 'fake-a', role: 'assistant', content: 'The window frames a world that ', pending: true, runId: 'run_doesnotexist', appliedSeq: 42 },
  ];
  s.updatedAt = now;
  window.localStorage.setItem(${JSON.stringify(STORE_KEY)}, JSON.stringify(store));
})()`);
await call("Page.reload", { ignoreCache: false });
await sleep(3500);
const degraded = await snap();
console.log(
  `6. run 过期降级: pending=${degraded.pending} 中断=${degraded.interrupted} 继续按钮=${degraded.hasContinueBtn} 正文=${degraded.len}`,
);

// ---------- 4. 继续生成 ----------
const clicked = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('main button')].find((b) => b.textContent.includes('继续生成'));
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
})()`);
await sleep(1500);
const continuing = await snap();
for (let i = 0; i < 40; i += 1) {
  const s = await snap();
  if (!s.streaming) break;
  await sleep(500);
}
const continued = await snap();
console.log(
  `7. 继续生成(${clicked}): 消息数=${continued.msgCount}（应为2）长度=${degraded.len}→${continued.len} 开头保留=${continued.head.startsWith('The window frames a world')}`,
);
console.log(`   结尾="${continued.tail}"`);

// ---------- 5. 事件压缩（sync 快照）是否生效 ----------
const replay = await evaluate(`(async () => {
  const raw = window.localStorage.getItem(${JSON.stringify(STORE_KEY)});
  const store = JSON.parse(raw);
  const session = store.sessions.find((x) => x.id === store.activeId) ?? store.sessions[0];
  const target = [...session.messages].reverse().find((m) => m.role === 'assistant' && m.runId);
  if (!target) return { error: 'no runId' };
  const res = await fetch('/api/chat/stream?runId=' + encodeURIComponent(target.runId) + '&afterSeq=0');
  if (!res.ok) return { error: 'HTTP ' + res.status };
  const text = await res.text();
  const events = text.trim().split('\\n').map((l) => JSON.parse(l));
  const first = events[0];
  return {
    runId: target.runId,
    finalLen: target.content.length,
    eventCount: events.length,
    firstType: first?.type,
    firstSeq: first?.seq,
    syncLen: first?.type === 'sync' ? first.content.length : null,
    lastType: events[events.length - 1]?.type,
  };
})()`);
console.log(
  `8. 回放(run=${replay.runId}): 事件数=${replay.eventCount} 首事件=${replay.firstType}@seq${replay.firstSeq} 快照长度=${replay.syncLen} 最终长度=${replay.finalLen} 末事件=${replay.lastType}`,
);
console.log(
  `   压缩生效=${replay.firstType === "sync"} 快照+尾部事件拼回完整=${replay.syncLen !== null && replay.eventCount > 1 && replay.eventCount < 400}`,
);

ws.close();
