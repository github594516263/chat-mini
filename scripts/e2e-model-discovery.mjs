// 模型发现 / 连接测试自检
//   node scripts/e2e-model-discovery.mjs
// 前置：dev 已启动、demo 账号存在、.env.local 里有真实的 DEEPSEEK_API_KEY。
// 只调用上游 /models（免费、不消耗 token），不会发聊天请求。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const username = process.env.E2E_USER ?? "demo";
const password = process.env.E2E_PASS ?? "DemoPass2026!";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq > 0) env[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return env;
}

const env = loadEnv();
const deepseekKey = env.DEEPSEEK_API_KEY;
const providerName = `[e2e] discovery ${Date.now().toString().slice(-5)}`;

let cookie = "";
let passed = 0;
let failed = 0;
let providerId = null;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
    if (pair.startsWith("chat_session=")) cookie = pair;
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

try {
  if (!deepseekKey) throw new Error(".env.local 里没有 DEEPSEEK_API_KEY，跳过真实发现测试");
  console.log("模型发现 / 连接测试");

  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  check(login.status === 200, "登录 demo");

  // 清掉上次失败留下的同名 provider
  const before = await request("/api/models/providers");
  for (const provider of before.body?.providers ?? []) {
    if (provider.name.startsWith("[e2e] discovery")) {
      await request(`/api/models/providers/${provider.id}`, { method: "DELETE" });
    }
  }

  const preflight = await request("/api/models/providers/test", {
    method: "POST",
    body: JSON.stringify({
      baseUrl: "https://api.deepseek.com",
      authType: "api_key",
      apiKey: deepseekKey,
    }),
  });
  check(preflight.status === 200, "创建前测试连接", JSON.stringify(preflight.body));
  check((preflight.body?.models?.length ?? 0) > 0, "创建前能看到模型");
  check(!JSON.stringify(preflight.body).includes(deepseekKey), "创建前测试不含密钥");

  const noKeyTest = await request("/api/models/providers/test", {
    method: "POST",
    body: JSON.stringify({ baseUrl: "https://api.deepseek.com", authType: "api_key", apiKey: "" }),
  });
  check(noKeyTest.status === 400, "没填密钥时拒绝测试", String(noKeyTest.status));

  const privateTest = await request("/api/models/providers/test", {
    method: "POST",
    body: JSON.stringify({ baseUrl: "http://127.0.0.1:8080", authType: "none" }),
  });
  check(privateTest.status === 400, "创建前测试也拒绝内网地址", String(privateTest.status));

  const created = await request("/api/models/providers", {
    method: "POST",
    body: JSON.stringify({
      name: providerName,
      baseUrl: "https://api.deepseek.com",
      protocol: "openai-chat",
      authType: "api_key",
      apiKey: deepseekKey,
      enabled: true,
    }),
  });
  check(created.status === 201, "创建真实 DeepSeek provider", JSON.stringify(created.body));
  providerId = created.body?.provider?.id ?? null;
  check(Boolean(providerId), "拿到 provider id");

  const discovered = await request(`/api/models/providers/${providerId}/discover`, {
    method: "POST",
  });
  check(discovered.status === 200, "连接并拉取 /models", JSON.stringify(discovered.body));
  const models = discovered.body?.models ?? [];
  check(models.length > 0, "发现至少一个模型", String(models.length));
  check(typeof discovered.body?.latencyMs === "number", "返回延迟");
  check(!JSON.stringify(discovered.body).includes(deepseekKey), "发现响应不含密钥");

  const first = models[0];
  if (first) {
    console.log(`    示例：${first.modelKey} / ${first.displayName ?? "-"} / ctx=${first.contextWindow ?? "-"}`);
    check(typeof first.modelKey === "string" && first.modelKey.length > 0, "模型有 id");
    check(Array.isArray(first.inputModalities), "模型有输入类型");
    check(first.contextWindow === null || typeof first.contextWindow === "number", "上下文窗口类型正确");
  }

  const picked = models.slice(0, 2);
  const imported = await request(`/api/models/providers/${providerId}/models/import`, {
    method: "POST",
    body: JSON.stringify({
      models: picked.map((model) => ({
        modelKey: model.modelKey,
        displayName: model.displayName,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        inputModalities: model.inputModalities,
      })),
    }),
  });
  check(imported.status === 201, "批量导入发现结果", JSON.stringify(imported.body));
  check((imported.body?.created?.length ?? 0) === picked.length, "创建数量正确");

  const after = await request("/api/models/providers");
  const saved = after.body?.providers?.find((provider) => provider.id === providerId);
  check((saved?.models?.length ?? 0) === picked.length, "模型目录里有导入的模型", String(saved?.models?.length));
  if (saved?.models?.[0]) {
    check(
      saved.models[0].contextWindow === picked[0].contextWindow,
      "上下文窗口跟着发现结果写入",
      `${saved.models[0].contextWindow}`,
    );
  }

  const importedAgain = await request(`/api/models/providers/${providerId}/models/import`, {
    method: "POST",
    body: JSON.stringify({ models: picked }),
  });
  check(importedAgain.status === 201, "重复导入不报错");
  check((importedAgain.body?.skipped ?? 0) === picked.length, "重复项全部跳过");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error("\n脚本异常:", error);
  process.exitCode = 1;
} finally {
  if (providerId) {
    await request(`/api/models/providers/${providerId}`, { method: "DELETE" }).catch(() => {});
  }
}
