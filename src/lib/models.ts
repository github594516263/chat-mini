/**
 * 模型目录：把「界面里能选的东西」和「服务端真正怎么发请求」分开。
 *
 * 一条原则：客户端只拿到公开 id（如 `deepseek:v4.1-flash`），
 * 永远不碰 upstream 模型名、base URL、API Key。切换模型时上行报文里只有这个 id，
 * 服务端查表决定路由——用户改不了请求去哪，这是模型选择器的安全边界。
 *
 * 目录本身写在代码里（而不是数据库）是有意的：
 *   - 现在只有一家、两条模型，改一次发一次版最省事
 *   - 模型名 / 倍率 / 能力是产品配置，不是用户数据
 *   - 以后要动态化，只需要把 MODELS 换成一次查询，下面的解析逻辑不用动
 *
 * 状态两态：
 *   live = 这家 provider 的 key + base URL 都齐了，真的能发
 *   off  = 没配 key，界面直接不展示这家（不再有假数据流兜底）
 */

export type ModelCapability = "reasoning" | "vision" | "tools";

/** 一个推理档位：id 是稳定标识，label 给界面看，value 是真正发给上游的参数值 */
export type ReasoningLevel = {
  id: string;
  label: string;
  value: string;
};

export type ModelStatus = "live" | "off";

export type ProviderConfig = {
  id: string;
  label: string;
  /** 服务端读哪个环境变量拿 key */
  keyEnv: string;
  /** 服务端读哪个环境变量拿 base URL */
  baseUrlEnv: string;
  /** 官方服务可以给默认地址；中转站必须显式配置 */
  defaultBaseUrl?: string;
};

export type ModelDefinition = {
  /** 对外的稳定 id：provider:model，可安全地存 localStorage / 发到前端 */
  id: string;
  provider: string;
  /** 界面上展示的名字 */
  label: string;
  /**
   * 真正发给上游的模型名。和 label 分开的好处：
   * 界面可以叫「DeepSeek-V4.1-Flash」，上游仍然映射到 deepseek-chat，
   * 换供应商 / 改叫法时不用动数据库和前端。
   */
  upstream: string;
  /** 行尾的小徽标，例如截图里的倍率 1017 */
  badge?: string;
  /** 当前选中的模型在输入框旁额外展示的标记（截图里的 Max） */
  tag?: string;
  description?: string;
  capabilities?: ModelCapability[];
};

export type PublicModel = {
  id: string;
  label: string;
  badge?: string;
  tag?: string;
  description?: string;
  capabilities?: ModelCapability[];
  /** 账户自建模型可选的推理档位；系统目录没有 */
  reasoningLevels?: ReasoningLevel[];
  defaultReasoning?: string | null;
  status: ModelStatus;
  /** 来自系统目录（环境变量），不是用户自己配的 */
  system?: boolean;
};

export type PublicProviderGroup = {
  id: string;
  label: string;
  status: ModelStatus;
  models: PublicModel[];
  /** 系统目录分组（只读），用于和用户自建 provider 区分 */
  system?: boolean;
};

export type ModelCatalog = {
  groups: PublicProviderGroup[];
  defaultId: string;
  /** user=账户自建目录；system=系统默认目录；none=读取失败/空 */
  origin?: "user" | "system" | "none";
};

/** 服务端解析结果：多带路由需要的字段，绝不下发到客户端 */
export type ResolvedModel = {
  definition: ModelDefinition;
  provider: ProviderConfig;
  status: ModelStatus;
  apiKey: string | null;
  /** 已经补全到 /chat/completions 的完整地址 */
  endpoint: string | null;
  maxOutputTokens?: number | null;
  reasoningLevels?: ReasoningLevel[];
  defaultReasoning?: string | null;
};

export type ReasoningResolution =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/** 把界面选的档位 id 翻成上游参数值；没配档位的模型不发这个参数 */
export function resolveReasoningValue(
  model: ResolvedModel,
  requested?: string | null,
): ReasoningResolution {
  const levels = model.reasoningLevels ?? [];
  if (levels.length === 0) return { ok: true, value: null };

  const id = requested?.trim() || model.defaultReasoning || levels[0]?.id || null;
  if (!id) return { ok: true, value: null };
  const level = levels.find((item) => item.id === id);
  if (!level) return { ok: false, error: "这个推理等级不存在" };
  return { ok: true, value: level.value };
}

/**
 * 弹层里的分组顺序。
 * 只保留真正在用的官方账号；需要接中转站时在这里加一条即可。
 */
export const PROVIDERS: ProviderConfig[] = [
  {
    id: "deepseek",
    label: "DeepSeek 账号",
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
  },
];

/**
 * 演示目录。接自己的网关时改这里就行：
 *   - id 必须全局唯一，建议 `provider:model` 格式
 *   - upstream 填网关文档里那个模型名
 *   - badge / tag / description 纯展示，可以删
 *
 * DeepSeek 官方那两条特意把 upstream 映射到 deepseek-chat / deepseek-reasoner，
 * 这样截图里的「新名字」在本地也能直接跑通真实流；接真 V4 之后改 upstream 即可。
 */
export const MODELS: ModelDefinition[] = [
  {
    id: "deepseek:v4.1-flash",
    provider: "deepseek",
    label: "DeepSeek-V4.1-Flash",
    upstream: "deepseek-chat",
    badge: "1017",
    tag: "Max",
    description: "日常对话与代码，速度优先",
    capabilities: ["tools"],
  },
  {
    id: "deepseek:v4-pro",
    provider: "deepseek",
    label: "DeepSeek-V4-Pro",
    upstream: "deepseek-reasoner",
    description: "复杂推理，会输出思维链",
    capabilities: ["reasoning"],
  },
];

type ProviderState = {
  config: ProviderConfig;
  apiKey: string | null;
  baseUrl: string | null;
  configured: boolean;
};

type RuntimeModel = {
  definition: ModelDefinition;
  status: ModelStatus;
};

type RuntimeGroup = {
  state: ProviderState;
  status: ModelStatus;
  models: RuntimeModel[];
};

type RuntimeCatalog = {
  groups: RuntimeGroup[];
  defaultId: string;
};

/** 「https://x.com」「https://x.com/v1」「.../chat/completions」→ 完整地址 */
export function toChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function readProviderState(config: ProviderConfig): ProviderState {
  const apiKey = process.env[config.keyEnv]?.trim() || null;
  const rawBase = process.env[config.baseUrlEnv]?.trim() || config.defaultBaseUrl || "";
  const baseUrl = rawBase ? toChatCompletionsUrl(rawBase) : null;
  // 只有 key 和地址同时存在才算真的能发：中转站只填 key 不知道往哪打，等于没配
  return { config, apiKey, baseUrl, configured: Boolean(apiKey && baseUrl) };
}

function pickDefaultId(groups: RuntimeGroup[]): string {
  const all = groups.flatMap((group) => group.models);
  const explicit = process.env.DEFAULT_MODEL?.trim();
  if (explicit) {
    const matched = all.find((item) => item.definition.id === explicit);
    // 默认值也不能落在没配置的 provider 上，否则界面一打开就是个不可用的选中项
    if (matched && matched.status !== "off") return explicit;
  }

  // 兼容老配置：DEEPSEEK_MODEL=deepseek-reasoner 时默认落到对应的那条
  const legacy = process.env.DEEPSEEK_MODEL?.trim();
  if (legacy) {
    const matched = all.find(
      (item) => item.definition.provider === "deepseek" && item.definition.upstream === legacy,
    );
    if (matched && matched.status !== "off") return matched.definition.id;
  }

  return (
    all.find((item) => item.status === "live")?.definition.id ??
    all.find((item) => item.status !== "off")?.definition.id ??
    all[0]?.definition.id ??
    ""
  );
}

function buildRuntimeCatalog(): RuntimeCatalog {
  const groups: RuntimeGroup[] = PROVIDERS.map((config) => {
    const state = readProviderState(config);
    // 只分两种：key + 地址齐了就是 live，否则 off（界面上直接不展示）
    const status: ModelStatus = state.configured ? "live" : "off";
    return {
      state,
      status,
      models: MODELS.filter((model) => model.provider === config.id).map((definition) => ({
        definition,
        status,
      })),
    };
  }).filter((group) => group.models.length > 0);

  return {
    groups,
    defaultId: pickDefaultId(groups),
  };
}

/** 给服务端组件 / API 用：只有公开字段，没有 key、地址和 upstream */
export function getModelCatalog(): ModelCatalog {
  const runtime = buildRuntimeCatalog();

  // 没配 key 的组直接不展示：菜单里不再堆一排「未配置」，看不到就不存在。
  const visible = runtime.groups.filter((group) => group.status === "live");

  return {
    defaultId: runtime.defaultId,
    origin: "system",
    groups: visible.map((group) => ({
      id: group.state.config.id,
      label: group.state.config.label,
      status: group.status,
      models: group.models.map(({ definition, status }) => ({
        id: definition.id,
        label: definition.label,
        badge: definition.badge,
        tag: definition.tag,
        description: definition.description,
        capabilities: definition.capabilities,
        status,
      })),
    })),
  };
}

/**
 * 把客户端传来的公开 id 解析成路由信息。
 * 未知 id 返回 null（调用方给 400），绝不静默替换成别的模型 ——
 * 静默 fallback 会让用户以为自己在用 A，实际跑的是 B。
 */
export function resolveModel(requestedId?: string | null): ResolvedModel | null {
  const runtime = buildRuntimeCatalog();
  const id = requestedId?.trim() || runtime.defaultId;
  if (!id) return null;

  for (const group of runtime.groups) {
    const model = group.models.find((item) => item.definition.id === id);
    if (!model) continue;
    return {
      definition: model.definition,
      provider: group.state.config,
      status: model.status,
      apiKey: group.state.apiKey,
      endpoint: group.state.baseUrl,
    };
  }
  return null;
}
