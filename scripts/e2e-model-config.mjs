// 账户级模型配置 API 自检
//   node scripts/e2e-model-config.mjs
// 前置：dev 已启动（默认 3123）、测试账号 demo2 存在（可用 E2E_USER 覆盖）、scripts/schema.sql 已执行。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const username = process.env.E2E_USER ?? "demo2";
const crossUsername = process.env.E2E_CROSS_USER ?? "demo";
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
let cookie = "";
let passed = 0;
let failed = 0;

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
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
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
  return { status: response.status, body, text };
}

async function connect() {
  return mysql.createConnection({
    host: env.DB_HOST || "127.0.0.1",
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: "utf8mb4",
    timezone: "Z",
  });
}

const fakeKey = "sk-e2e-model-config-not-a-real-key";
let providerId = null;
let modelId = null;
let beforeUseSystem = null;

try {
  console.log("账户模型配置 API");

  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  check(login.status === 200, "登录测试账号成功", JSON.stringify(login.body));

  // 清掉上次异常退出留下的测试 provider，避免默认模型/数量断言被污染
  const leftovers = await request("/api/models/providers");
  for (const item of leftovers.body?.providers ?? []) {
    if (item.name.startsWith("[e2e]")) {
      await request(`/api/models/providers/${item.id}`, { method: "DELETE" });
    }
  }

  const empty = await request("/api/models/providers");
  check(empty.status === 200, "读取 provider 列表");
  check(Array.isArray(empty.body?.providers), "列表结构正确");
  beforeUseSystem = empty.body?.useSystemModels === true;
  const beforeCount = empty.body?.providers?.length ?? 0;
  console.log(`    当前已有 ${beforeCount} 个 provider`);

  const created = await request("/api/models/providers", {
    method: "POST",
    body: JSON.stringify({
      name: `[e2e] 测试网关 ${Date.now()}`,
      baseUrl: "https://gateway.example.com/v1",
      protocol: "openai-chat",
      authType: "api_key",
      apiKey: fakeKey,
      enabled: true,
    }),
  });
  check(created.status === 201, "创建 provider", JSON.stringify(created.body));
  providerId = created.body?.provider?.id ?? null;
  check(Boolean(providerId), "返回 provider id");
  check(created.body?.provider?.hasKey === true, "返回 hasKey=true");
  check(created.body?.provider?.keyLast4 === fakeKey.slice(-4), "只返回 last4");
  check(!created.text.includes(fakeKey), "响应里没有明文密钥");

  const duplicate = await request("/api/models/providers", {
    method: "POST",
    body: JSON.stringify({
      name: created.body.provider.name,
      baseUrl: "https://gateway.example.com/v1",
      protocol: "openai-chat",
      authType: "api_key",
      apiKey: fakeKey,
    }),
  });
  check(duplicate.status === 409, "同名 provider 返回 409");

  const badUrl = await request("/api/models/providers", {
    method: "POST",
    body: JSON.stringify({
      name: "[e2e] bad url",
      baseUrl: "file:///etc/passwd",
      authType: "api_key",
      apiKey: fakeKey,
    }),
  });
  check(badUrl.status === 400, "拒绝非 http(s) 地址");

  const privateUrl = await request("/api/models/providers", {
    method: "POST",
    body: JSON.stringify({
      name: "[e2e] private url",
      baseUrl: "http://127.0.0.1:8080/v1",
      authType: "api_key",
      apiKey: fakeKey,
    }),
  });
  check(privateUrl.status === 400, "默认拒绝内网地址（SSRF）", JSON.stringify(privateUrl.body));

  const mappedUrl = await request("/api/models/providers", {
    method: "POST",
    body: JSON.stringify({
      name: "[e2e] mapped url",
      baseUrl: "http://[::ffff:127.0.0.1]:8080/v1",
      authType: "api_key",
      apiKey: fakeKey,
    }),
  });
  check(mappedUrl.status === 400, "拒绝 IPv4-mapped IPv6 回环", JSON.stringify(mappedUrl.body));

  const addModel = await request(`/api/models/providers/${providerId}/models`, {
    method: "POST",
    body: JSON.stringify({
      modelKey: "e2e-model",
      displayName: "E2E 模型",
      contextWindow: "256K",
      maxOutputTokens: "32K",
      enabled: true,
    }),
  });
  check(addModel.status === 201, "添加模型", JSON.stringify(addModel.body));
  modelId = addModel.body?.model?.id ?? null;
  check(addModel.body?.model?.contextWindow === 256000, "256K 解析为 256000");
  check(addModel.body?.model?.maxOutputTokens === 32000, "32K 解析为 32000");
  check(
    Array.isArray(addModel.body?.model?.reasoningLevels) &&
      addModel.body.model.reasoningLevels.length === 0,
    "新模型默认没有推理等级",
  );
  check(addModel.body?.model?.defaultReasoning === null, "新模型默认推理等级为空");

  const catalog = await request("/api/models/catalog");
  check(catalog.status === 200, "读取 catalog");
  check(catalog.body?.origin === "user", "catalog origin=user", catalog.body?.origin);
  check(catalog.body?.groups?.some((group) => group.id === providerId), "catalog 含新 provider");
  check(catalog.body?.defaultId === modelId, "新模型自动成为默认");
  check(
    catalog.body?.groups?.some(
      (group) =>
        group.system === true &&
        group.models?.some((model) => model.id === "deepseek:v4.1-flash" && model.status !== "off"),
    ),
    "有自建模型时也展示可选的系统默认模型",
  );

  const list = await request("/api/models/providers");
  const provider = list.body?.providers?.find((item) => item.id === providerId);
  check(list.body?.providers?.some((item) => item.id === providerId), "列表里能找到新 provider");
  check(provider?.status === "live", "provider 状态 live", provider?.status);
  check(provider?.models?.length === 1, "provider 下有一个模型");

  const patchModel = await request(`/api/models/${modelId}`, {
    method: "PATCH",
    body: JSON.stringify({
      modelKey: "e2e-model",
      displayName: "E2E 模型改名",
      contextWindow: "64K",
      maxOutputTokens: "8K",
      enabled: false,
    }),
  });
  check(patchModel.status === 200, "修改模型", JSON.stringify(patchModel.body));
  check(patchModel.body?.model?.displayName === "E2E 模型改名", "模型显示名已更新");
  check(patchModel.body?.model?.contextWindow === 64000, "模型上下文窗口已更新");
  check(patchModel.body?.model?.enabled === false, "模型可以停用");

  const reasoningLevels = [
    { id: "low", label: "低", value: "low" },
    { id: "high", label: "高", value: "high" },
    { id: "max", label: "最高", value: "max" },
  ];
  const patchReasoning = await request(`/api/models/${modelId}`, {
    method: "PATCH",
    body: JSON.stringify({
      modelKey: "e2e-model",
      displayName: "E2E 模型改名",
      contextWindow: "64K",
      maxOutputTokens: "8K",
      enabled: true,
      reasoningLevels,
      defaultReasoning: "high",
    }),
  });
  check(patchReasoning.status === 200, "保存推理等级", JSON.stringify(patchReasoning.body));
  check(patchReasoning.body?.model?.reasoningLevels?.length === 3, "三个推理等级都保存");
  check(patchReasoning.body?.model?.defaultReasoning === "high", "默认推理等级已保存");

  const catalogWithReasoning = await request("/api/models/catalog");
  const catalogModel = catalogWithReasoning.body?.groups
    ?.flatMap((group) => group.models)
    .find((model) => model.id === modelId);
  check(catalogModel?.reasoningLevels?.length === 3, "catalog 下发推理等级");
  check(catalogModel?.defaultReasoning === "high", "catalog 下发默认档位");

  const badDefault = await request(`/api/models/${modelId}`, {
    method: "PATCH",
    body: JSON.stringify({
      modelKey: "e2e-model",
      displayName: "E2E 模型改名",
      contextWindow: "64K",
      maxOutputTokens: "8K",
      enabled: false,
      reasoningLevels,
      defaultReasoning: "nope",
    }),
  });
  check(badDefault.status === 400, "拒绝不存在的默认推理等级", String(badDefault.status));

  const duplicateLevel = await request(`/api/models/${modelId}`, {
    method: "PATCH",
    body: JSON.stringify({
      modelKey: "e2e-model",
      displayName: "E2E 模型改名",
      contextWindow: "64K",
      maxOutputTokens: "8K",
      enabled: false,
      reasoningLevels: [reasoningLevels[0], reasoningLevels[0]],
      defaultReasoning: "low",
    }),
  });
  check(duplicateLevel.status === 400, "拒绝重复的推理等级 id", String(duplicateLevel.status));

  await request(`/api/models/${modelId}`, {
    method: "PATCH",
    body: JSON.stringify({
      modelKey: "e2e-model",
      displayName: "E2E 模型",
      contextWindow: "256K",
      maxOutputTokens: "32K",
      enabled: true,
    }),
  });

  const session = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "[e2e] reasoning" }),
  });
  const sessionId = session.body?.session?.id ?? null;
  check(Boolean(sessionId), "创建推理校验用会话");
  const badReasoningChat = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      kind: "send",
      content: "hi",
      model: modelId,
      reasoning: "nope",
    }),
  });
  check(badReasoningChat.status === 400, "聊天请求拒绝不存在的推理等级", String(badReasoningChat.status));
  if (sessionId) {
    await request(`/api/sessions/${sessionId}`, { method: "DELETE" });
  }

  // 换另一个账号：看不到当前账号的配置，也不能改
  const demo2Login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: crossUsername, password }),
  });
  check(demo2Login.status === 200, "登录对照组账号");
  const demo2List = await request("/api/models/providers");
  check(
    !demo2List.body?.providers?.some((item) => item.id === providerId),
    "对照组看不到当前账号的 provider",
  );
  const crossPatch = await request(`/api/models/providers/${providerId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: "越权改名",
      baseUrl: "https://gateway.example.com/v1",
      protocol: "openai-chat",
      authType: "api_key",
      apiKey: "",
      enabled: true,
    }),
  });
  check(crossPatch.status === 404, "对照组改不了 provider", String(crossPatch.status));
  const crossDeleteModel = await request(`/api/models/${modelId}`, { method: "DELETE" });
  check(crossDeleteModel.status === 404, "对照组删不了模型", String(crossDeleteModel.status));
  const crossDiscover = await request(`/api/models/providers/${providerId}/discover`, {
    method: "POST",
  });
  check(crossDiscover.status === 404, "对照组不能测试连接", String(crossDiscover.status));
  const crossImport = await request(`/api/models/providers/${providerId}/models/import`, {
    method: "POST",
    body: JSON.stringify({ models: [{ modelKey: "hijack" }] }),
  });
  check(crossImport.status === 404, "对照组不能导入模型", String(crossImport.status));

  // 换回 demo 继续
  const demoLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  check(demoLogin.status === 200, "切回测试账号");

  const update = await request(`/api/models/providers/${providerId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: created.body.provider.name,
      baseUrl: "https://gateway.example.com/v1",
      protocol: "openai-chat",
      authType: "api_key",
      apiKey: "",
      enabled: true,
      revision: provider.revision,
    }),
  });
  check(update.status === 200, "修改 provider", JSON.stringify(update.body));
  check(update.body?.provider?.revision === provider.revision + 1, "revision 递增");

  const stale = await request(`/api/models/providers/${providerId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: created.body.provider.name,
      baseUrl: "https://gateway.example.com/v1",
      protocol: "openai-chat",
      authType: "api_key",
      apiKey: "",
      enabled: true,
      revision: provider.revision,
    }),
  });
  check(stale.status === 409, "旧 revision 返回 409");

  const prefs = await request("/api/models/preferences", {
    method: "PUT",
    body: JSON.stringify({ useSystemModels: true }),
  });
  check(prefs.status === 200, "切换系统默认开关");

  const conn = await connect();
  try {
    const [rows] = await conn.execute(
      "SELECT secret_cipher, last4 FROM model_credentials WHERE provider_id = ?",
      [providerId],
    );
    check(rows.length === 1, "数据库里有凭据行");
    check(!rows[0]?.secret_cipher?.toString("utf8").includes(fakeKey), "数据库不是明文");
    check(rows[0]?.last4 === fakeKey.slice(-4), "数据库只存 last4");
  } finally {
    await conn.end();
  }

  const deleteModel = await request(`/api/models/${modelId}`, { method: "DELETE" });
  check(deleteModel.status === 200, "删除模型");
  const deleteProvider = await request(`/api/models/providers/${providerId}`, { method: "DELETE" });
  check(deleteProvider.status === 200, "删除 provider");
  providerId = null;
  modelId = null;

  await request("/api/models/preferences", {
    method: "PUT",
    body: JSON.stringify({ useSystemModels: true }),
  });
  const systemCatalog = await request("/api/models/catalog");
  check(systemCatalog.body?.origin === "system", "没有自建模型时回退系统目录", systemCatalog.body?.origin);
  check((systemCatalog.body?.groups?.length ?? 0) > 0, "系统目录不为空");

  await request("/api/models/preferences", {
    method: "PUT",
    body: JSON.stringify({ useSystemModels: false }),
  });
  const noneCatalog = await request("/api/models/catalog");
  check(noneCatalog.body?.origin === "none", "关闭开关后回到空目录", noneCatalog.body?.origin);
  check((noneCatalog.body?.groups?.length ?? -1) === 0, "空目录没有分组");

  const after = await request("/api/models/providers");
  check(
    (after.body?.providers?.length ?? -1) === beforeCount,
    "清理后数量回到初始值",
    `${after.body?.providers?.length}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error("\n脚本异常:", error);
  process.exitCode = 1;
} finally {
  // 失败时也尽量清掉自己造的数据
  if (providerId) {
    await request(`/api/models/providers/${providerId}`, { method: "DELETE" }).catch(() => {});
  }
  if (beforeUseSystem !== null) {
    await request("/api/models/preferences", {
      method: "PUT",
      body: JSON.stringify({ useSystemModels: beforeUseSystem }),
    }).catch(() => {});
  }
}
