// 服务端探针：验证 run 的回放、水位、压缩（sync 快照）
// 用法：node scripts/probe-runs.mjs ["提示词"]
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const prompt = process.argv[2] ?? "写一篇1200字英文散文，主题是窗户，分多段。";

const readStream = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const text = await response.text();
  const events = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return events;
};

const rebuild = (events) => {
  let content = "";
  for (const event of events) {
    if (event.type === "sync") content = event.content;
    else if (event.type === "delta") content += event.delta;
  }
  return content;
};

const started = Date.now();
const created = await (await fetch(`${baseUrl}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
})).json();

if (!created.runId) throw new Error(`建 run 失败: ${JSON.stringify(created)}`);
const runId = created.runId;
console.log(`runId=${runId}`);

// 1) 从头订阅到结束
const live = await readStream(`${baseUrl}/api/chat/stream?runId=${runId}&afterSeq=0`);
const content = rebuild(live);
console.log(
  `1. 首次订阅: 事件=${live.length} 首=${live[0]?.type}@${live[0]?.seq} 末=${live.at(-1)?.type}@${live.at(-1)?.seq} 正文=${content.length}字 用时=${Date.now() - started}ms`,
);

// 2) 结束后再从头回放：应能把正文原样拼回来
const replay = await readStream(`${baseUrl}/api/chat/stream?runId=${runId}&afterSeq=0`);
const replayed = rebuild(replay);
console.log(
  `2. 从头回放: 事件=${replay.length} 首=${replay[0]?.type}@${replay[0]?.seq} 压缩生效=${replay[0]?.type === "sync"} 拼回=${replayed.length}字 与原正文一致=${replayed === content}`,
);

// 3) 带水位回放：只应拿到 afterSeq 之后的事件
const watermark = replay[Math.floor(replay.length / 2)]?.seq ?? 0;
const partial = await readStream(`${baseUrl}/api/chat/stream?runId=${runId}&afterSeq=${watermark}`);
const allAfter = partial.every((event) => event.seq > watermark);
console.log(
  `3. 水位回放(afterSeq=${watermark}): 事件=${partial.length} 全部 seq>水位=${allAfter} 首=${partial[0]?.type}@${partial[0]?.seq}`,
);

// 4) 拼回校验：sync(若有) + 尾部事件 == 完整正文
const prefix = replayed.slice(0, replayed.length - rebuild(partial).length);
const stitched = prefix + rebuild(partial);
console.log(`4. 断点续接: 前缀${prefix.length}字 + 增量${rebuild(partial).length}字 = ${stitched.length}字 与完整正文一致=${stitched === content}`);

// 5) 不存在的 run
const missing = await fetch(`${baseUrl}/api/chat/stream?runId=run_nope&afterSeq=0`);
console.log(`5. 不存在的 run: HTTP ${missing.status} body=${(await missing.text()).slice(0, 60)}`);

// 6) 取消：建一个长任务立刻取消
const second = await (await fetch(`${baseUrl}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
})).json();
await new Promise((r) => setTimeout(r, 1200));
const cancelRes = await (await fetch(`${baseUrl}/api/chat/cancel`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ runId: second.runId }),
})).json();
const afterCancel = await readStream(`${baseUrl}/api/chat/stream?runId=${second.runId}&afterSeq=0`);
const tail = afterCancel.at(-1);
console.log(
  `6. 取消: cancelled=${cancelRes.cancelled} 末事件=${tail?.type} finish_reason=${tail?.finish_reason ?? "-"} 事件数=${afterCancel.length}`,
);
