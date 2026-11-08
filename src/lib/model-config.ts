import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { RowDataPacket } from "mysql2/promise";

import { execute, query, queryOne, withTransaction } from "@/lib/db";
import { decryptSecret, encryptSecret, last4Of } from "@/lib/model-crypto";
import {
  getModelCatalog,
  resolveModel,
  toChatCompletionsUrl,
  type ModelCatalog,
  type ReasoningLevel,
  type ResolvedModel,
} from "@/lib/models";

/**
 * 账户级模型配置的数据访问层。
 *
 * 边界：
 * - 所有查询都带 user_id；越权统一 null → 调用方转 404。
 * - API Key 只在这里解密，且只在真正发请求时解密。
 * - 对外 DTO 只有 hasKey / keyLast4，没有密文和明文。
 */

export const MODEL_PROTOCOLS = ["openai-chat"] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];
export type ProviderAuthType = "api_key" | "none";

export type ProviderStatus = "live" | "needs_key" | "no_models" | "disabled";

export type ModelSettingsModel = {
  id: string;
  modelKey: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[];
  reasoningLevels: ReasoningLevel[];
  defaultReasoning: string | null;
  enabled: boolean;
  status: "live" | "off";
};

export type ModelSettingsProvider = {
  id: string;
  name: string;
  protocol: ModelProtocol;
  baseUrl: string;
  authType: ProviderAuthType;
  enabled: boolean;
  revision: number;
  hasKey: boolean;
  keyLast4: string | null;
  modelCount: number;
  enabledModelCount: number;
  status: ProviderStatus;
  models: ModelSettingsModel[];
};

export type ModelSettings = {
  providers: ModelSettingsProvider[];
  useSystemModels: boolean;
  defaultModelId: string | null;
};

export class ModelConfigError extends Error {
  status: number;
  hint?: string;

  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.name = "ModelConfigError";
    this.status = status;
    this.hint = hint;
  }
}

type ProviderRow = RowDataPacket & {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  auth_type: ProviderAuthType;
  enabled: number | boolean;
  revision: number;
  created_at: Date;
  model_count: number;
  enabled_model_count: number;
  has_key: number | boolean;
  key_last4: string | null;
};

type ModelRow = RowDataPacket & {
  id: string;
  provider_id: string;
  model_key: string;
  display_name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  input_modalities: unknown;
  reasoning_levels: unknown;
  default_reasoning: string | null;
  enabled: number | boolean;
  source: string;
  created_at: Date;
};

type CredentialRow = {
  secret_cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_version: number;
};

type PreferenceRow = RowDataPacket & {
  default_model_id: string | null;
  use_system_models: number | boolean;
};

function bool(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseReasoningLevels(value: unknown): ReasoningLevel[] {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const levels: ReasoningLevel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; label?: unknown; value?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const valueText = typeof record.value === "string" ? record.value.trim() : "";
    if (!id || !valueText || seen.has(id)) continue;
    seen.add(id);
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : id;
    levels.push({ id, label, value: valueText });
  }
  return levels;
}

function normalizeReasoningLevels(value: unknown): ReasoningLevel[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ModelConfigError(400, "推理等级必须是数组");
  }
  if (value.length > 8) {
    throw new ModelConfigError(400, "最多配置 8 个推理等级");
  }

  const seen = new Set<string>();
  const levels: ReasoningLevel[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new ModelConfigError(400, "每个推理等级都要有 id、label、value");
    }
    const record = item as { id?: unknown; label?: unknown; value?: unknown };
    const id = cleanText(record.id, "推理等级 id", 32);
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
      throw new ModelConfigError(400, "推理等级 id 只能用小写字母、数字、-、_");
    }
    if (seen.has(id)) throw new ModelConfigError(400, `推理等级 id 重复：${id}`);
    seen.add(id);
    const label = cleanText(record.label, "推理等级名称", 32);
    const levelValue = cleanText(record.value, "推理等级参数值", 64);
    levels.push({ id, label, value: levelValue });
  }
  return levels;
}

function normalizeDefaultReasoning(value: unknown, levels: ReasoningLevel[]): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ModelConfigError(400, "默认推理等级必须是 id");
  }
  const id = value.trim();
  if (!id) return null;
  if (!levels.some((level) => level.id === id)) {
    throw new ModelConfigError(400, "默认推理等级不在已配置的等级里");
  }
  return id;
}

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new ModelConfigError(400, `${field} 必须是字符串`);
  }
  const text = value.trim();
  if (!text) throw new ModelConfigError(400, `${field} 不能为空`);
  if (text.length > max) throw new ModelConfigError(400, `${field} 最多 ${max} 个字符`);
  return text;
}

/** 接受 8192 / 32K / 1M / 1,048,576，返回整数 token 数 */
export function parseTokenCount(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0 || value > 10_000_000) {
      throw new ModelConfigError(400, `${field} 必须是正数`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new ModelConfigError(400, `${field} 必须是数字或 256K 这样的写法`);
  }

  const text = value.trim().toLowerCase().replace(/,/g, "");
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text);
  if (!match) {
    throw new ModelConfigError(400, `${field} 必须是正数，例如 131072、256K 或 1M`);
  }
  const base = Number(match[1]);
  const unit = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const result = Math.round(base * unit);
  if (!Number.isFinite(result) || result <= 0 || result > 10_000_000) {
    throw new ModelConfigError(400, `${field} 超出范围`);
  }
  return result;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase();
  // :: / ::1 / IPv4-compatible / IPv4-mapped（如 ::ffff:7f00:1）都归到本地/映射地址
  if (value.startsWith("::")) return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true; // fc00::/7
  if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) {
    return true; // fe80::/10
  }
  return false;
}

/**
 * 用户填的 base_url 是服务端 fetch 的地址，默认拒绝 localhost/内网/IPv6 本地地址。
 * 本地网关可以显式设置 ALLOW_PRIVATE_MODEL_ENDPOINTS=true 放行。
 *
 * 说明：这里只做字面地址校验；域名解析到内网的 DNS rebinding 需要在 P4
 * 的发现/连接测试里做「解析后校验 + 固定 IP」。
 */
function assertPublicEndpoint(hostname: string): void {
  if (process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS === "true") return;

  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    (isIP(host) === 4 && isPrivateIpv4(host)) ||
    (isIP(host) === 6 && isPrivateIpv6(host));

  if (privateHost) {
    throw new ModelConfigError(
      400,
      "API 地址不能指向 localhost 或内网地址",
      "这是为了阻止服务端被当成 SSRF 跳板。确实要连本地网关时，在 .env.local 设置 ALLOW_PRIVATE_MODEL_ENDPOINTS=true。",
    );
  }
}

function normalizeBaseUrl(value: unknown): string {
  const text = cleanText(value, "API 地址", 512);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ModelConfigError(400, "API 地址必须是合法的 http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ModelConfigError(400, "API 地址只支持 http / https");
  }
  if (url.username || url.password) {
    throw new ModelConfigError(400, "API 地址不能包含用户名或密码");
  }
  if (url.search || url.hash) {
    throw new ModelConfigError(400, "API 地址不能包含查询参数或片段");
  }
  assertPublicEndpoint(url.hostname);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function normalizeProtocol(value: unknown): ModelProtocol {
  if (value === undefined || value === null || value === "") return "openai-chat";
  if (typeof value !== "string" || !MODEL_PROTOCOLS.includes(value as ModelProtocol)) {
    throw new ModelConfigError(
      400,
      "暂不支持这个 API 协议",
      "第一版只支持 OpenAI Chat Completions；Responses / Anthropic Messages 放在 P4。",
    );
  }
  return value as ModelProtocol;
}

function normalizeAuthType(value: unknown): ProviderAuthType {
  if (value === "none") return "none";
  return "api_key";
}

function normalizeApiKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ModelConfigError(400, "API 密钥必须是字符串");
  const key = value.trim();
  if (!key) return null;
  if (key.length > 4096) throw new ModelConfigError(400, "API 密钥太长");
  if (!/^[\x21-\x7E]+$/.test(key)) {
    throw new ModelConfigError(400, "API 密钥只能包含可打印 ASCII 字符");
  }
  return key;
}

function statusOf(row: {
  enabled: boolean;
  authType: ProviderAuthType;
  hasKey: boolean;
  enabledModelCount: number;
}): ProviderStatus {
  if (!row.enabled) return "disabled";
  if (row.authType === "api_key" && !row.hasKey) return "needs_key";
  if (row.enabledModelCount === 0) return "no_models";
  return "live";
}

function toModelView(row: ModelRow): ModelSettingsModel {
  const enabled = bool(row.enabled);
  return {
    id: row.id,
    modelKey: row.model_key,
    displayName: row.display_name,
    contextWindow: row.context_window === null ? null : Number(row.context_window),
    maxOutputTokens: row.max_output_tokens === null ? null : Number(row.max_output_tokens),
    inputModalities: parseJsonArray(row.input_modalities),
    reasoningLevels: parseReasoningLevels(row.reasoning_levels),
    defaultReasoning: row.default_reasoning ?? null,
    enabled,
    status: enabled ? "live" : "off",
  };
}

function toProviderView(
  row: ProviderRow,
  models: ModelSettingsModel[],
): ModelSettingsProvider {
  const enabled = bool(row.enabled);
  const hasKey = bool(row.has_key);
  const enabledModelCount = Number(row.enabled_model_count ?? 0);
  return {
    id: row.id,
    name: row.name,
    protocol: (row.protocol as ModelProtocol) ?? "openai-chat",
    baseUrl: row.base_url,
    authType: row.auth_type,
    enabled,
    revision: Number(row.revision),
    hasKey,
    keyLast4: row.key_last4 ?? null,
    modelCount: Number(row.model_count ?? 0),
    enabledModelCount,
    status: statusOf({
      enabled,
      authType: row.auth_type,
      hasKey,
      enabledModelCount,
    }),
    models,
  };
}

const PROVIDER_SELECT = `
  SELECT p.id, p.name, p.protocol, p.base_url, p.auth_type, p.enabled, p.revision, p.created_at,
         (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id) AS model_count,
         (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id AND m.enabled = 1) AS enabled_model_count,
         (c.provider_id IS NOT NULL) AS has_key,
         c.last4 AS key_last4
    FROM model_providers p
    LEFT JOIN model_credentials c ON c.provider_id = p.id
   WHERE p.user_id = ?
   ORDER BY p.sort_order ASC, p.created_at ASC`;

const MODEL_SELECT = `
  SELECT id, provider_id, model_key, display_name, context_window, max_output_tokens,
         input_modalities, reasoning_levels, default_reasoning, enabled, source, created_at
    FROM models
   WHERE user_id = ?
   ORDER BY sort_order ASC, created_at ASC`;

async function readPreferences(userId: string): Promise<PreferenceRow | null> {
  return queryOne<PreferenceRow>(
    `SELECT default_model_id, use_system_models
       FROM user_model_preferences
      WHERE user_id = ?
      LIMIT 1`,
    [userId],
  );
}

export async function listModelSettings(userId: string): Promise<ModelSettings> {
  const [providerRows, modelRows, preference] = await Promise.all([
    query<ProviderRow>(PROVIDER_SELECT, [userId]),
    query<ModelRow>(MODEL_SELECT, [userId]),
    readPreferences(userId),
  ]);

  const byProvider = new Map<string, ModelSettingsModel[]>();
  for (const row of modelRows) {
    const list = byProvider.get(row.provider_id) ?? [];
    list.push(toModelView(row));
    byProvider.set(row.provider_id, list);
  }

  return {
    providers: providerRows.map((row) => toProviderView(row, byProvider.get(row.id) ?? [])),
    useSystemModels: bool(preference?.use_system_models),
    defaultModelId: preference?.default_model_id ?? null,
  };
}

async function getProviderView(userId: string, providerId: string): Promise<ModelSettingsProvider | null> {
  const row = await queryOne<ProviderRow>(`${PROVIDER_SELECT.replace("WHERE p.user_id = ?", "WHERE p.user_id = ? AND p.id = ?")}`, [
    userId,
    providerId,
  ]);
  if (!row) return null;
  const models = await query<ModelRow>(`${MODEL_SELECT.replace("WHERE user_id = ?", "WHERE user_id = ? AND provider_id = ?")}`, [
    userId,
    providerId,
  ]);
  return toProviderView(row, models.map(toModelView));
}

async function getModelView(userId: string, modelId: string): Promise<ModelSettingsModel | null> {
  const row = await queryOne<ModelRow>(
    `SELECT id, provider_id, model_key, display_name, context_window, max_output_tokens,
            input_modalities, reasoning_levels, default_reasoning, enabled, source, created_at
       FROM models
      WHERE id = ? AND user_id = ?
      LIMIT 1`,
    [modelId, userId],
  );
  return row ? toModelView(row) : null;
}

export type CreateProviderInput = {
  name: unknown;
  baseUrl: unknown;
  protocol?: unknown;
  authType?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
};

export async function createProvider(
  userId: string,
  input: CreateProviderInput,
): Promise<ModelSettingsProvider> {
  const name = cleanText(input.name, "显示名称", 64);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const protocol = normalizeProtocol(input.protocol);
  const authType = normalizeAuthType(input.authType);
  const apiKey = authType === "api_key" ? normalizeApiKey(input.apiKey) : null;
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  const id = randomUUID();
  const now = new Date();
  // 先加密再写库：MODEL_SECRET_KEY 没配时不要留下一个没有凭据的半截 provider
  const encrypted = apiKey ? encryptSecret(apiKey, { userId, providerId: id }) : null;

  try {
    await execute(
      `INSERT INTO model_providers
         (id, user_id, name, protocol, base_url, auth_type, enabled, sort_order, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      [id, userId, name, protocol, baseUrl, authType, enabled ? 1 : 0, now, now],
    );

    if (encrypted) {
      await execute(
        `INSERT INTO model_credentials
           (provider_id, user_id, kind, secret_cipher, iv, tag, key_version, last4, created_at, updated_at)
         VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          userId,
          encrypted.cipher,
          encrypted.iv,
          encrypted.tag,
          encrypted.keyVersion,
          last4Of(apiKey ?? ""),
          now,
          now,
        ],
      );
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new ModelConfigError(409, "这个显示名称已经用过了");
    }
    throw error;
  }

  const provider = await getProviderView(userId, id);
  if (!provider) throw new ModelConfigError(500, "创建后读不到 provider");
  return provider;
}

export type UpdateProviderInput = CreateProviderInput & {
  revision?: unknown;
  clearKey?: unknown;
};

export async function updateProvider(
  userId: string,
  providerId: string,
  input: UpdateProviderInput,
): Promise<ModelSettingsProvider | null> {
  const name = cleanText(input.name, "显示名称", 64);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const protocol = normalizeProtocol(input.protocol);
  const authType = normalizeAuthType(input.authType);
  const apiKey = authType === "api_key" ? normalizeApiKey(input.apiKey) : null;
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  const clearKey = input.clearKey === true;
  const revision = input.revision === undefined ? null : Number(input.revision);
  if (revision !== null && (!Number.isInteger(revision) || revision < 1)) {
    throw new ModelConfigError(400, "revision 不合法");
  }

  const now = new Date();
  const encrypted = apiKey ? encryptSecret(apiKey, { userId, providerId }) : null;
  const params: (string | number | Date)[] = [
    name,
    protocol,
    baseUrl,
    authType,
    enabled ? 1 : 0,
    now,
    providerId,
    userId,
  ];
  let sql = `UPDATE model_providers
                SET name = ?, protocol = ?, base_url = ?, auth_type = ?, enabled = ?,
                    updated_at = ?, revision = revision + 1
              WHERE id = ? AND user_id = ?`;
  if (revision !== null) {
    sql += " AND revision = ?";
    params.push(revision);
  }

  const result = await execute(sql, params).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new ModelConfigError(409, "这个显示名称已经用过了");
    }
    throw error;
  });
  if (result.affectedRows === 0) {
    const exists = await queryOne<RowDataPacket & { id: string }>(
      `SELECT id FROM model_providers WHERE id = ? AND user_id = ? LIMIT 1`,
      [providerId, userId],
    );
    if (!exists) return null;
    throw new ModelConfigError(409, "配置已在别处修改，请刷新后重试");
  }

  if (clearKey || authType === "none") {
    await execute(`DELETE FROM model_credentials WHERE provider_id = ? AND user_id = ?`, [
      providerId,
      userId,
    ]);
  } else if (encrypted) {
    await execute(
      `INSERT INTO model_credentials
         (provider_id, user_id, kind, secret_cipher, iv, tag, key_version, last4, created_at, updated_at)
       VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         kind = VALUES(kind), secret_cipher = VALUES(secret_cipher), iv = VALUES(iv),
         tag = VALUES(tag), key_version = VALUES(key_version), last4 = VALUES(last4),
         updated_at = VALUES(updated_at)`,
      [
        providerId,
        userId,
        encrypted.cipher,
        encrypted.iv,
        encrypted.tag,
        encrypted.keyVersion,
        last4Of(apiKey ?? ""),
        now,
        now,
      ],
    );
  }

  return getProviderView(userId, providerId);
}

export async function deleteProvider(userId: string, providerId: string): Promise<boolean> {
  const result = await execute(`DELETE FROM model_providers WHERE id = ? AND user_id = ?`, [
    providerId,
    userId,
  ]);
  return result.affectedRows > 0;
}

export type CreateModelInput = {
  modelKey: unknown;
  displayName?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  enabled?: unknown;
  reasoningLevels?: unknown;
  defaultReasoning?: unknown;
};

export async function createModel(
  userId: string,
  providerId: string,
  input: CreateModelInput,
): Promise<ModelSettingsModel | null> {
  const provider = await queryOne<RowDataPacket & { id: string }>(
    `SELECT id FROM model_providers WHERE id = ? AND user_id = ? LIMIT 1`,
    [providerId, userId],
  );
  if (!provider) return null;

  const modelKey = cleanText(input.modelKey, "模型 ID", 191);
  const displayName =
    input.displayName === undefined || input.displayName === null || input.displayName === ""
      ? modelKey
      : cleanText(input.displayName, "显示名称", 120);
  const contextWindow = parseTokenCount(input.contextWindow, "上下文窗口");
  const maxOutputTokens = parseTokenCount(input.maxOutputTokens, "最大输出 token 数");
  if (contextWindow !== null && maxOutputTokens !== null && maxOutputTokens > contextWindow) {
    throw new ModelConfigError(400, "最大输出 token 数不能大于上下文窗口");
  }
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  const reasoningLevels = normalizeReasoningLevels(input.reasoningLevels);
  const defaultReasoning = normalizeDefaultReasoning(input.defaultReasoning, reasoningLevels);
  const id = randomUUID();
  const now = new Date();

  try {
    await execute(
      `INSERT INTO models
         (id, user_id, provider_id, model_key, display_name, context_window, max_output_tokens,
          input_modalities, reasoning_levels, default_reasoning, enabled, sort_order, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'manual', ?, ?)`,
      [
        id,
        userId,
        providerId,
        modelKey,
        displayName,
        contextWindow,
        maxOutputTokens,
        JSON.stringify(["text"]),
        reasoningLevels.length > 0 ? JSON.stringify(reasoningLevels) : null,
        defaultReasoning,
        enabled ? 1 : 0,
        now,
        now,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new ModelConfigError(409, "这个 provider 下已经有同名模型了");
    }
    throw error;
  }

  // 第一次加模型时顺手设成默认，避免目录有模型却没有选中项
  await execute(
    `UPDATE user_model_preferences
        SET default_model_id = COALESCE(default_model_id, ?), updated_at = ?
      WHERE user_id = ?`,
    [id, now, userId],
  );

  return getModelView(userId, id);
}

export type UpdateModelInput = CreateModelInput & {
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  enabled?: unknown;
};

export async function updateModel(
  userId: string,
  modelId: string,
  input: UpdateModelInput,
): Promise<ModelSettingsModel | null> {
  const current = await queryOne<ModelRow>(
    `SELECT id, provider_id, model_key, display_name, context_window, max_output_tokens,
            input_modalities, reasoning_levels, default_reasoning, enabled, source, created_at
       FROM models WHERE id = ? AND user_id = ? LIMIT 1`,
    [modelId, userId],
  );
  if (!current) return null;

  const modelKey = cleanText(input.modelKey, "模型 ID", 191);
  const displayName =
    input.displayName === undefined || input.displayName === null || input.displayName === ""
      ? modelKey
      : cleanText(input.displayName, "显示名称", 120);
  const contextWindow = parseTokenCount(input.contextWindow, "上下文窗口");
  const maxOutputTokens = parseTokenCount(input.maxOutputTokens, "最大输出 token 数");
  if (contextWindow !== null && maxOutputTokens !== null && maxOutputTokens > contextWindow) {
    throw new ModelConfigError(400, "最大输出 token 数不能大于上下文窗口");
  }
  const enabled = input.enabled === undefined ? bool(current.enabled) : Boolean(input.enabled);
  const currentLevels = parseReasoningLevels(current.reasoning_levels);
  const reasoningLevels =
    input.reasoningLevels === undefined
      ? currentLevels
      : normalizeReasoningLevels(input.reasoningLevels);
  const defaultReasoning =
    input.defaultReasoning === undefined
      ? current.default_reasoning && reasoningLevels.some((level) => level.id === current.default_reasoning)
        ? current.default_reasoning
        : null
      : normalizeDefaultReasoning(input.defaultReasoning, reasoningLevels);

  try {
    await execute(
      `UPDATE models
          SET model_key = ?, display_name = ?, context_window = ?, max_output_tokens = ?,
              reasoning_levels = ?, default_reasoning = ?, enabled = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
      [
        modelKey,
        displayName,
        contextWindow,
        maxOutputTokens,
        reasoningLevels.length > 0 ? JSON.stringify(reasoningLevels) : null,
        defaultReasoning,
        enabled ? 1 : 0,
        new Date(),
        modelId,
        userId,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new ModelConfigError(409, "这个 provider 下已经有同名模型了");
    }
    throw error;
  }

  return getModelView(userId, modelId);
}

export async function deleteModel(userId: string, modelId: string): Promise<boolean> {
  const result = await execute(`DELETE FROM models WHERE id = ? AND user_id = ?`, [modelId, userId]);
  return result.affectedRows > 0;
}

export async function setUseSystemModels(userId: string, value: boolean): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO user_model_preferences (user_id, default_model_id, use_system_models, updated_at)
     VALUES (?, NULL, ?, ?)
     ON DUPLICATE KEY UPDATE use_system_models = VALUES(use_system_models), updated_at = VALUES(updated_at)`,
    [userId, value ? 1 : 0, now],
  );
}

async function countUsableUserModels(userId: string): Promise<number> {
  const row = await queryOne<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n
       FROM models m
       JOIN model_providers p ON p.id = m.provider_id
       LEFT JOIN model_credentials c ON c.provider_id = p.id
      WHERE p.user_id = ? AND m.user_id = ?
        AND p.enabled = 1 AND m.enabled = 1
        AND (p.auth_type = 'none' OR c.provider_id IS NOT NULL)`,
    [userId, userId],
  );
  return Number(row?.n ?? 0);
}

export async function canUseSystemModels(userId: string): Promise<boolean> {
  // 有自建模型时，系统目录会作为补充分组一起展示，用户可以直接选；
  // 只有完全没自建模型时，才需要显式打开「系统默认」开关。
  if ((await countUsableUserModels(userId)) > 0) return true;
  const preference = await readPreferences(userId);
  return bool(preference?.use_system_models);
}

/** 给 composer 用的账户目录：自建 provider + 可用的系统默认分组。 */
export async function getUserModelCatalog(userId: string): Promise<ModelCatalog> {
  const settings = await listModelSettings(userId);
  const groups = settings.providers
    .filter((provider) => provider.enabled && provider.status === "live")
    .map((provider) => ({
      id: provider.id,
      label: provider.name,
      status: "live" as const,
      models: provider.models
        .filter((model) => model.enabled)
        .map((model) => ({
          id: model.id,
          label: model.displayName,
          description: `${provider.name} · ${model.modelKey}`,
          status: "live" as const,
          reasoningLevels: model.reasoningLevels,
          defaultReasoning: model.defaultReasoning,
        })),
    }))
    .filter((group) => group.models.length > 0);

  const system = getModelCatalog();
  const systemGroups = system.groups
    .filter((group) => group.status === "live")
    .map((group) => ({
      ...group,
      system: true,
      label: `系统默认 · ${group.label}`,
      models: group.models.map((model) => ({ ...model, system: true })),
    }));

  // 有自建模型：自建在前，系统默认在后，系统模型始终可选。
  // 没有自建模型：只有显式打开开关才显示系统目录（保留原来的空状态语义）。
  if (groups.length > 0) {
    const allGroups: ModelCatalog["groups"] = [...groups, ...systemGroups];
    const all = allGroups.flatMap((group) => group.models);
    const preferred = settings.defaultModelId
      ? all.find((model) => model.id === settings.defaultModelId)
      : undefined;
    return {
      groups: allGroups,
      defaultId: preferred?.id ?? groups[0]?.models[0]?.id ?? all[0]?.id ?? "",
      mock: false,
      origin: "user",
    };
  }

  if (settings.useSystemModels) {
    return {
      ...system,
      origin: "system",
      groups: system.groups.map((group) => ({
        ...group,
        system: true,
        models: group.models.map((model) => ({ ...model, system: true })),
      })),
    };
  }

  return { groups: [], defaultId: "", mock: false, origin: "none" };
}

/** 把 base_url 补成 OpenAI 兼容的 /models 地址 */
export function toModelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) {
    return `${base.slice(0, -"/chat/completions".length)}/models`;
  }
  if (base.endsWith("/models")) return base;
  return `${base}/models`;
}

export type DiscoveredModel = {
  modelKey: string;
  ownedBy: string | null;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[];
  reasoningLevels: ReasoningLevel[];
  defaultReasoning: string | null;
};

export type DiscoveryResult = {
  latencyMs: number;
  models: DiscoveredModel[];
};

type ProviderRuntimeRow = RowDataPacket & {
  id: string;
  name: string;
  base_url: string;
  auth_type: ProviderAuthType;
  secret_cipher: Buffer | null;
  iv: Buffer | null;
  tag: Buffer | null;
  key_version: number | null;
};

async function readProviderRuntime(
  userId: string,
  providerId: string,
): Promise<{ id: string; name: string; baseUrl: string; apiKey: string | null }> {
  const row = await queryOne<ProviderRuntimeRow>(
    `SELECT p.id, p.name, p.base_url, p.auth_type,
            c.secret_cipher, c.iv, c.tag, c.key_version
       FROM model_providers p
       LEFT JOIN model_credentials c ON c.provider_id = p.id
      WHERE p.id = ? AND p.user_id = ?
      LIMIT 1`,
    [providerId, userId],
  );
  if (!row) throw new ModelConfigError(404, "provider 不存在");

  if (row.auth_type === "api_key" && !row.secret_cipher) {
    throw new ModelConfigError(400, "这家 provider 还没有保存 API 密钥");
  }

  let apiKey: string | null = null;
  if (row.secret_cipher && row.iv && row.tag && row.key_version !== null) {
    try {
      apiKey = decryptSecret(
        {
          cipher: row.secret_cipher,
          iv: row.iv,
          tag: row.tag,
          keyVersion: Number(row.key_version),
        },
        { userId, providerId },
      );
    } catch (error) {
      throw new ModelConfigError(
        500,
        "模型凭据解密失败",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // 重新做一次地址校验：数据库里的值也可能被人工改过
  return {
    id: row.id,
    name: row.name,
    baseUrl: normalizeBaseUrl(row.base_url),
    apiKey,
  };
}

function parseDiscoveredModels(payload: unknown): DiscoveredModel[] {
  const raw =
    Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
        ? ((payload as { data: unknown[] }).data)
        : [];

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  const push = (model: DiscoveredModel) => {
    if (!model.modelKey || seen.has(model.modelKey)) return;
    seen.add(model.modelKey);
    models.push(model);
  };

  for (const item of raw.slice(0, 1000)) {
    if (typeof item === "string") {
      const modelKey = item.trim();
      if (modelKey) {
        push({
          modelKey,
          ownedBy: null,
          displayName: null,
          contextWindow: null,
          maxOutputTokens: null,
          inputModalities: ["text"],
          reasoningLevels: [],
          defaultReasoning: null,
        });
      }
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as {
      id?: unknown;
      model?: unknown;
      name?: unknown;
      owned_by?: unknown;
      ownedBy?: unknown;
      context_window?: unknown;
      max_output_tokens?: unknown;
      input_modalities?: unknown;
      effort?: unknown;
    };
    const key =
      typeof record.id === "string"
        ? record.id
        : typeof record.model === "string"
          ? record.model
          : "";
    const modelKey = key.trim();
    if (!modelKey) continue;

    const owned = record.owned_by ?? record.ownedBy;
    const displayName = typeof record.name === "string" && record.name.trim() ? record.name.trim() : null;
    const contextWindow = safeTokenCount(record.context_window);
    const maxOutputTokens = safeTokenCount(record.max_output_tokens);
    const inputModalities = Array.isArray(record.input_modalities)
      ? record.input_modalities.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];

    const effort =
      record.effort && typeof record.effort === "object"
        ? (record.effort as { supported_levels?: unknown; default_level?: unknown })
        : null;
    const supportedLevels = Array.isArray(effort?.supported_levels)
      ? effort.supported_levels.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const reasoningLevels: ReasoningLevel[] = [];
    const seenLevels = new Set<string>();
    for (const rawLevel of supportedLevels.slice(0, 8)) {
      const levelId = reasoningIdOf(rawLevel);
      if (!levelId || seenLevels.has(levelId)) continue;
      seenLevels.add(levelId);
      reasoningLevels.push({ id: levelId, label: rawLevel.trim(), value: rawLevel.trim() });
    }
    const defaultLevel =
      typeof effort?.default_level === "string" ? reasoningIdOf(effort.default_level) : null;

    push({
      modelKey,
      ownedBy: typeof owned === "string" ? owned : null,
      displayName,
      contextWindow,
      maxOutputTokens,
      inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
      reasoningLevels,
      defaultReasoning:
        defaultLevel && reasoningLevels.some((level) => level.id === defaultLevel)
          ? defaultLevel
          : null,
    });
  }
  return models;
}

function safeTokenCount(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0 || number > 10_000_000) {
    return null;
  }
  return number;
}

function reasoningIdOf(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);
}

async function fetchProviderModels(baseUrl: string, apiKey: string | null): Promise<DiscoveryResult> {
  const endpoint = toModelsUrl(baseUrl);
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      // 禁止跟随跳转：避免 302 把服务端带到内网
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelConfigError(
      502,
      "连不上这家 provider",
      `检查 API 地址和网络：${message.slice(0, 200)}`,
    );
  }

  const text = await response.text();
  if (text.length > 2_000_000) {
    throw new ModelConfigError(502, "provider 返回内容过大");
  }

  if (!response.ok) {
    let detail = text.slice(0, 240);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      const nested = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
      detail = nested || parsed.message || detail;
    } catch {
      // 保留原始文本片段
    }
    if (response.status === 401 || response.status === 403) {
      throw new ModelConfigError(400, "API 密钥无效或没有权限", detail);
    }
    if (response.status === 404) {
      throw new ModelConfigError(
        400,
        "这个端点没有 /models 接口",
        "可以手动添加模型，或检查 API 地址是否多/少了一层 /v1。",
      );
    }
    throw new ModelConfigError(502, `provider 返回 ${response.status}`, detail);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ModelConfigError(502, "provider 返回的不是 JSON", text.slice(0, 200));
  }

  const models = parseDiscoveredModels(payload);
  if (models.length === 0) {
    throw new ModelConfigError(
      404,
      "没有发现可用模型",
      "端点返回了空列表；可以手动添加模型 ID。",
    );
  }

  return { latencyMs: Date.now() - started, models };
}

/** 测试连接并拉取上游 /models；只返回模型名和延迟，不返回密钥 */
export async function discoverProviderModels(
  userId: string,
  providerId: string,
): Promise<DiscoveryResult> {
  const runtime = await readProviderRuntime(userId, providerId);
  return fetchProviderModels(runtime.baseUrl, runtime.apiKey);
}

/** 新建 provider 之前先测：不落库，不保存密钥 */
export async function testProviderConnection(input: unknown): Promise<DiscoveryResult> {
  if (!input || typeof input !== "object") {
    throw new ModelConfigError(400, "请求格式不对");
  }
  const record = input as { baseUrl?: unknown; authType?: unknown; apiKey?: unknown };
  const baseUrl = normalizeBaseUrl(record.baseUrl);
  const authType = normalizeAuthType(record.authType);
  const apiKey = normalizeApiKey(record.apiKey);
  if (authType === "api_key" && !apiKey) {
    throw new ModelConfigError(400, "先填 API 密钥，或勾选「这个端点不需要 API 密钥」");
  }
  return fetchProviderModels(baseUrl, authType === "none" ? null : apiKey);
}

/** 批量导入发现结果：已存在的跳过，不覆盖用户改过的显示名/参数 */
export async function importProviderModels(
  userId: string,
  providerId: string,
  input: unknown,
): Promise<{ created: ModelSettingsModel[]; skipped: number }> {
  const provider = await queryOne<RowDataPacket & { id: string }>(
    `SELECT id FROM model_providers WHERE id = ? AND user_id = ? LIMIT 1`,
    [providerId, userId],
  );
  if (!provider) throw new ModelConfigError(404, "provider 不存在");

  if (!Array.isArray(input) || input.length === 0) {
    throw new ModelConfigError(400, "没有选择要导入的模型");
  }
  if (input.length > 200) {
    throw new ModelConfigError(400, "一次最多导入 200 个模型");
  }

  const normalized = new Map<string, {
    modelKey: string;
    displayName: string;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    inputModalities: string[];
    reasoningLevels: ReasoningLevel[];
    defaultReasoning: string | null;
  }>();

  for (const item of input) {
    const record =
      typeof item === "string"
        ? { modelKey: item }
        : item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : null;
    if (!record) throw new ModelConfigError(400, "导入项格式不对");

    const modelKey = cleanText(record.modelKey, "模型 ID", 191);
    const displayName =
      typeof record.displayName === "string" && record.displayName.trim()
        ? cleanText(record.displayName, "显示名称", 120)
        : modelKey;
    const contextWindow = parseTokenCount(record.contextWindow, "上下文窗口");
    const maxOutputTokens = parseTokenCount(record.maxOutputTokens, "最大输出 token 数");
    if (contextWindow !== null && maxOutputTokens !== null && maxOutputTokens > contextWindow) {
      throw new ModelConfigError(400, `模型 ${modelKey} 的最大输出不能大于上下文窗口`);
    }
    const inputModalities = Array.isArray(record.inputModalities)
      ? record.inputModalities
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .slice(0, 8)
      : [];
    const reasoningLevels = normalizeReasoningLevels(record.reasoningLevels);
    const defaultReasoning = normalizeDefaultReasoning(record.defaultReasoning, reasoningLevels);

    normalized.set(modelKey, {
      modelKey,
      displayName,
      contextWindow,
      maxOutputTokens,
      inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
      reasoningLevels,
      defaultReasoning,
    });
  }

  const existing = await query<RowDataPacket & { model_key: string }>(
    `SELECT model_key FROM models WHERE provider_id = ? AND user_id = ?`,
    [providerId, userId],
  );
  const existingKeys = new Set(existing.map((row) => row.model_key));
  const missing = [...normalized.values()].filter((model) => !existingKeys.has(model.modelKey));
  if (missing.length === 0) return { created: [], skipped: normalized.size };

  const ids: string[] = [];
  const now = new Date();
  await withTransaction(async (conn) => {
    for (const model of missing) {
      const id = randomUUID();
      ids.push(id);
      await conn.execute(
        `INSERT INTO models
           (id, user_id, provider_id, model_key, display_name, context_window, max_output_tokens,
            input_modalities, reasoning_levels, default_reasoning, enabled, sort_order, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'discovered', ?, ?)`,
        [
          id,
          userId,
          providerId,
          model.modelKey,
          model.displayName,
          model.contextWindow,
          model.maxOutputTokens,
          JSON.stringify(model.inputModalities),
          model.reasoningLevels.length > 0 ? JSON.stringify(model.reasoningLevels) : null,
          model.defaultReasoning,
          now,
          now,
        ],
      );
    }
    await conn.execute(
      `UPDATE user_model_preferences
          SET default_model_id = COALESCE(default_model_id, ?), updated_at = ?
        WHERE user_id = ?`,
      [ids[0], now, userId],
    );
  });

  const rows = await query<ModelRow>(
    `SELECT id, provider_id, model_key, display_name, context_window, max_output_tokens,
            input_modalities, reasoning_levels, default_reasoning, enabled, source, created_at
       FROM models
      WHERE id IN (${ids.map(() => "?").join(",")}) AND user_id = ?`,
    [...ids, userId],
  );
  return { created: rows.map(toModelView), skipped: normalized.size - missing.length };
}

/** 真正发请求前解析：只接受模型行 UUID，绝不接受客户端传 baseURL/upstream。 */
export async function resolveUserModel(
  userId: string,
  modelId: string,
): Promise<ResolvedModel | null> {
  const row = await queryOne<
    ModelRow & {
      provider_name: string;
      provider_protocol: string;
      provider_base_url: string;
      provider_auth_type: ProviderAuthType;
      provider_enabled: number | boolean;
      credential: CredentialRow | null;
      secret_cipher: Buffer | null;
      iv: Buffer | null;
      tag: Buffer | null;
      key_version: number | null;
    }
  >(
    `SELECT m.id, m.provider_id, m.model_key, m.display_name, m.context_window, m.max_output_tokens,
            m.input_modalities, m.reasoning_levels, m.default_reasoning, m.enabled, m.source, m.created_at,
            p.name AS provider_name, p.protocol AS provider_protocol, p.base_url AS provider_base_url,
            p.auth_type AS provider_auth_type, p.enabled AS provider_enabled,
            c.secret_cipher, c.iv, c.tag, c.key_version
       FROM models m
       JOIN model_providers p ON p.id = m.provider_id
       LEFT JOIN model_credentials c ON c.provider_id = p.id
      WHERE m.id = ? AND m.user_id = ? AND p.user_id = ?
      LIMIT 1`,
    [modelId, userId, userId],
  );

  if (!row) return null;
  if (!bool(row.enabled) || !bool(row.provider_enabled)) return null;
  if (row.provider_auth_type === "api_key" && !row.secret_cipher) return null;

  let apiKey: string | null = null;
  if (row.secret_cipher && row.iv && row.tag && row.key_version !== null) {
    try {
      apiKey = decryptSecret(
        {
          cipher: row.secret_cipher,
          iv: row.iv,
          tag: row.tag,
          keyVersion: Number(row.key_version),
        },
        { userId, providerId: row.provider_id },
      );
    } catch (error) {
      throw new ModelConfigError(
        500,
        "模型凭据解密失败",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    definition: {
      id: row.id,
      provider: row.provider_id,
      label: row.display_name,
      upstream: row.model_key,
      description: row.provider_name,
    },
    provider: {
      id: row.provider_id,
      label: row.provider_name,
      keyEnv: "",
      baseUrlEnv: "",
    },
    status: "live",
    apiKey,
    endpoint: toChatCompletionsUrl(row.provider_base_url),
    maxOutputTokens:
      row.max_output_tokens === null ? null : Number(row.max_output_tokens),
    reasoningLevels: parseReasoningLevels(row.reasoning_levels),
    defaultReasoning: row.default_reasoning ?? null,
  };
}

/**
 * 解析当前用户的一次请求：
 *   1. 先查账户自建模型；
 *   2. 再查系统目录：有自建模型时系统目录始终可选；没有自建模型时需要显式开关；
 *   3. 都不命中返回 null，调用方 400，绝不静默换成别的模型。
 */
export async function resolveModelForUser(
  userId: string,
  requestedId?: string | null,
): Promise<ResolvedModel | null> {
  if (requestedId) {
    const own = await resolveUserModel(userId, requestedId);
    if (own) return own;
    if (await canUseSystemModels(userId)) {
      const system = resolveModel(requestedId);
      return system && system.status !== "off" ? system : null;
    }
    return null;
  }

  const catalog = await getUserModelCatalog(userId);
  const defaultId = catalog.defaultId || null;
  if (!defaultId) return null;
  if (catalog.origin === "system") {
    const system = resolveModel(defaultId);
    return system && system.status !== "off" ? system : null;
  }
  return resolveUserModel(userId, defaultId);
}
