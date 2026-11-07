// P3 端到端：会话/消息接口 + 用户隔离 + 搜索 + 游标分页
//   node scripts/e2e-sessions-api.mjs
// 前置：dev 已启动；已建 demo / demo2 两个账号；已跑 scripts/fixture-sessions.mjs
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const PASSWORD = process.env.E2E_PASS ?? "DemoPass2026!";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function loginCookie(username) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const line = (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("chat_session="));
  if (!line) throw new Error(`${username} 登录失败：HTTP ${response.status}`);
  return line.split(";")[0];
}

function client(cookie) {
  const request = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Cookie: cookie,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 响应 */
    }
    return { status: response.status, json };
  };
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    patch: (path, body) => request("PATCH", path, body ?? {}),
    del: (path) => request("DELETE", path),
  };
}

const cookieA = await loginCookie("demo");
const cookieB = await loginCookie("demo2");
const A = client(cookieA);
const B = client(cookieB);

// 1. 未登录 401
const anon = await fetch(`${baseUrl}/api/sessions`);
check("未登录访问 /api/sessions → 401", anon.status === 401, `HTTP ${anon.status}`);

// 2. A 的列表里只有自己的会话
const listA = await A.get("/api/sessions");
const titlesA = (listA.json?.sessions ?? []).map((s) => s.title);
check("A 能读到自己的会话", listA.status === 200 && titlesA.length >= 3, `${titlesA.length} 个`);
check(
  "A 的列表里没有 demo2 的会话",
  !titlesA.some((t) => t.includes("demo2")),
  titlesA.join(" / "),
);

// 3. B 的列表里没有 A 的会话
const listB = await B.get("/api/sessions");
const titlesB = (listB.json?.sessions ?? []).map((s) => s.title);
check(
  "B 的列表里没有 demo 的会话",
  !titlesB.some((t) => t.includes("断线续传") || t.includes("React")),
  titlesB.join(" / "),
);

// 4. 消息按 seq 升序
const targetA = (listA.json?.sessions ?? []).find((s) => s.title.includes("断线续传"));
const msgsA = await A.get(`/api/sessions/${targetA.id}/messages`);
const seqs = (msgsA.json?.messages ?? []).map((m) => m.seq);
check("消息按 seq 升序返回", msgsA.status === 200 && seqs.join(",") === "1,2,3,4", `seq=${seqs.join(",")}`);

// 5. afterSeq 增量
const partial = await A.get(`/api/sessions/${targetA.id}/messages?afterSeq=2`);
check(
  "afterSeq=2 只返回 3、4",
  (partial.json?.messages ?? []).map((m) => m.seq).join(",") === "3,4",
  (partial.json?.messages ?? []).map((m) => m.seq).join(","),
);

// 6. 越权：B 读 A 的会话 → 404（不是 403）
const crossGet = await B.get(`/api/sessions/${targetA.id}`);
check("B 读 A 的会话 → 404", crossGet.status === 404, `HTTP ${crossGet.status}`);

const crossMsgs = await B.get(`/api/sessions/${targetA.id}/messages`);
check("B 读 A 的消息 → 404", crossMsgs.status === 404, `HTTP ${crossMsgs.status}`);

const crossPatch = await B.patch(`/api/sessions/${targetA.id}`, { title: "被改了" });
check("B 改 A 的标题 → 404", crossPatch.status === 404, `HTTP ${crossPatch.status}`);

const crossDelete = await B.del(`/api/sessions/${targetA.id}`);
check("B 删 A 的会话 → 404", crossDelete.status === 404, `HTTP ${crossDelete.status}`);

// 7. A 的会话仍在（没被越权操作影响）
const stillThere = await A.get(`/api/sessions/${targetA.id}`);
check("A 的会话未被越权操作影响", stillThere.status === 200 && stillThere.json?.session?.title === targetA.title);

// 8. 搜索：标题命中
const searchTitle = await A.get("/api/sessions/search?q=React");
check(
  "搜索标题命中",
  searchTitle.status === 200 && (searchTitle.json?.hits ?? []).some((h) => h.session.title.includes("React")),
  `${(searchTitle.json?.hits ?? []).length} 条`,
);

// 9. 搜索：中文正文命中（ngram 全文索引）
const searchContent = await A.get("/api/sessions/search?q=服务端");
const contentHits = searchContent.json?.hits ?? [];
check(
  "搜索正文命中（ngram）",
  contentHits.length > 0,
  contentHits.map((h) => `${h.session.title.slice(0, 12)}…(${h.matchedIn})`).join(" | "),
);
check("命中带片段", contentHits.some((h) => typeof h.snippet === "string" && h.snippet.length > 0));

// 10. 搜索隔离：B 搜不到 A 的暗号，A 也搜不到 B 的
const bSecret = await A.get("/api/sessions/search?q=紫色河马");
check("A 搜不到 B 的私密内容", (bSecret.json?.hits ?? []).length === 0, `${(bSecret.json?.hits ?? []).length} 条`);

const bSelf = await B.get("/api/sessions/search?q=紫色河马");
check("B 自己能搜到自己的内容", (bSelf.json?.hits ?? []).length > 0);

// 11. 新建 + 改名
const created = await A.post("/api/sessions", { title: "P3 新建的会话" });
check("新建会话 → 201", created.status === 201 && Boolean(created.json?.session?.id));
const renamed = await A.patch(`/api/sessions/${created.json.session.id}`, { title: "改名后的会话" });
check(
  "改名 → 200 且标题变了",
  renamed.status === 200 && renamed.json?.session?.title === "改名后的会话",
  renamed.json?.session?.title ?? "",
);

// 12. 空标题应被拒
const emptyTitle = await A.patch(`/api/sessions/${created.json.session.id}`, { title: "   " });
check("空标题 → 400", emptyTitle.status === 400, `HTTP ${emptyTitle.status}`);

// 13. 软删除
const removed = await A.del(`/api/sessions/${created.json.session.id}`);
const afterDelete = await A.get(`/api/sessions/${created.json.session.id}`);
const listAfter = await A.get("/api/sessions");
check(
  "删除 → 200，之后 GET → 404，列表里消失",
  removed.status === 200 &&
    afterDelete.status === 404 &&
    !(listAfter.json?.sessions ?? []).some((s) => s.id === created.json.session.id),
);

// 14. 游标分页：limit=2 连续翻两页，不重不漏
const page1 = await A.get("/api/sessions?limit=2");
const page1Ids = (page1.json?.sessions ?? []).map((s) => s.id);
const page2 = await A.get(`/api/sessions?limit=2&cursor=${encodeURIComponent(page1.json?.nextCursor ?? "")}`);
const page2Ids = (page2.json?.sessions ?? []).map((s) => s.id);
const overlap = page1Ids.filter((id) => page2Ids.includes(id));
check(
  "游标分页两页不重复",
  page1Ids.length === 2 && page2Ids.length > 0 && overlap.length === 0,
  `第一页 ${page1Ids.length} 条 / 第二页 ${page2Ids.length} 条 / 重复 ${overlap.length}`,
);
check("分页游标可用", Boolean(page1.json?.nextCursor), page1.json?.nextCursor ?? "无");

// 15. 排序：按 updated_at 倒序
const ordered = (listAfter.json?.sessions ?? []).map((s) => s.updatedAt);
const sorted = [...ordered].sort().reverse();
check("列表按 updatedAt 倒序", ordered.join() === sorted.join());

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
