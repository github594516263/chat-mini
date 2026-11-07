// 认证端到端自检
//   node scripts/e2e-auth.mjs
// 需要：dev 已启动 + 已用 create-user.mjs 建好 demo 账号（密码见下方 PASSWORD）
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const USERNAME = process.env.E2E_USER ?? "demo";
const PASSWORD = process.env.E2E_PASS ?? "DemoPass2026!";

let cookie = null;

function absorbCookie(response) {
  const list = response.headers.getSetCookie?.() ?? [];
  for (const raw of list) {
    const pair = raw.split(";")[0];
    if (pair.startsWith("chat_session=")) {
      const value = pair.slice("chat_session=".length);
      cookie = value ? pair : null;
    }
  }
  return list;
}

async function post(path, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  absorbCookie(response);
  const text = await response.text();
  return { status: response.status, body: text, json: safeJson(text), headers: response.headers };
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  absorbCookie(response);
  const text = await response.text();
  return { status: response.status, json: safeJson(text) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. 注册默认关闭
const register = await post("/api/auth/register", { username: "someone", password: "whatever123" });
check("注册默认关闭（403）", register.status === 403, `HTTP ${register.status} ${register.json?.error ?? ""}`);

// 2. 未登录 /api/auth/me → 401
const meAnon = await get("/api/auth/me");
check("未登录 me → 401", meAnon.status === 401, `HTTP ${meAnon.status}`);

// 3. 密码错误
const wrong = await post("/api/auth/login", { username: USERNAME, password: "definitely-wrong" });
check("密码错 → 401", wrong.status === 401, `HTTP ${wrong.status} ${wrong.json?.error ?? ""}`);

// 4. 用户不存在 → 同一句话（防枚举）
const nobody = await post("/api/auth/login", { username: "no_such_user", password: "whatever123" });
check(
  "用户不存在与密码错返回同一句",
  nobody.status === 401 && nobody.json?.error === wrong.json?.error,
  `"${nobody.json?.error}"`,
);

// 5. 正确登录
const login = await post("/api/auth/login", { username: USERNAME, password: PASSWORD });
const setCookie = login.headers.getSetCookie?.() ?? [];
const cookieLine = setCookie.find((c) => c.startsWith("chat_session=")) ?? "";
check("正确登录 → 200", login.status === 200, `HTTP ${login.status}`);
check("Set-Cookie 带 HttpOnly", /HttpOnly/i.test(cookieLine), cookieLine.split(";").slice(1).join(";").trim());
check("Set-Cookie 带 SameSite=Lax", /SameSite=Lax/i.test(cookieLine));
check("本地不带 Secure（否则浏览器不存）", !/;\s*Secure/i.test(cookieLine));
check("cookie 里有 token", Boolean(cookie), cookie ? `${cookie.length} 字节` : "无");

// 6. 带 cookie 取 me
const me = await get("/api/auth/me");
check("登录后 me → 200", me.status === 200 && me.json?.user?.username === USERNAME, JSON.stringify(me.json?.user ?? null));

// 7. 跨站 Origin 被拒
const cross = await post(
  "/api/auth/login",
  { username: USERNAME, password: PASSWORD },
  { Origin: "http://evil.example" },
);
check("跨站 Origin → 403", cross.status === 403, `HTTP ${cross.status}`);

// 8. 非 JSON 的 Content-Type 被拒（跨站表单发不出 application/json）
const form = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "username=demo&password=x",
});
check("表单 Content-Type → 400", form.status === 400, `HTTP ${form.status}`);

// 9. 登出后 cookie 失效
const logout = await post("/api/auth/logout", {});
check("登出 → 200", logout.status === 200, `HTTP ${logout.status}`);
const meAfter = await get("/api/auth/me");
check("登出后 me → 401", meAfter.status === 401, `HTTP ${meAfter.status}`);

// 10. 暴力破解限流（用独立用户名，别把 demo 锁了）
const rlUser = "ratelimit_probe";
const attempts = [];
for (let i = 0; i < 6; i += 1) {
  attempts.push((await post("/api/auth/login", { username: rlUser, password: `wrong-${i}` })).status);
}
const locked = attempts[attempts.length - 1] === 429;
check("连错 5 次后锁定（429）", locked, `状态序列 ${attempts.join(",")}`);
const afterLock = await post("/api/auth/login", { username: rlUser, password: "wrong-again" });
check("锁定期内仍 429", afterLock.status === 429, afterLock.json?.hint ?? "");

// 11. 未登录访问不了的接口存在但要有 401 —— 会话接口还没做（P3），这里只记录
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
