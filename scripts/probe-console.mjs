// 一次性诊断脚本：连上无头 Chrome 的 CDP，把页面 console / 异常 / 日志打出来。
// 用法：node scripts/probe-console.mjs <url> [seconds]
const port = Number(process.env.CDP_PORT ?? 9222);
const url = process.argv[2];
const seconds = Number(process.argv[3] ?? 12);

if (!url) {
  console.error("usage: node scripts/probe-console.mjs <url> [seconds]");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target found");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const sent = [];
let seq = 0;
const send = (method, params = {}) => {
  ws.send(JSON.stringify({ id: ++seq, method, params }));
};

ws.addEventListener("open", () => {
  send("Runtime.enable");
  send("Log.enable");
  send("Page.enable");
  send("Page.navigate", { url });
});

ws.addEventListener("message", (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }

  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args ?? [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type)
      .join(" ");
    sent.push(`[console.${msg.params.type}] ${text}`);
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    sent.push(`[exception] ${d.exception?.description ?? d.text}`);
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    sent.push(`[log.${e.level}] ${e.text}${e.url ? ` @ ${e.url}` : ""}`);
  }
});

await sleep(seconds * 1000);
ws.close();

if (sent.length === 0) {
  console.log("(no console output captured)");
} else {
  console.log(sent.join("\n"));
}
