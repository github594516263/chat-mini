"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";

import type { AccountUser } from "@/lib/account";
import type {
  DiscoveredModel,
  DiscoveryResult,
  ModelSettings,
  ModelSettingsModel,
  ModelSettingsProvider,
  ProviderStatus,
} from "@/lib/model-config";
import type { ReasoningLevel } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * 设置 → 模型。
 *
 * provider 行、展开卡片、模型行，以及推理等级。
 * 图片输入 / OAuth 按约定放到 P4c，这里不提前长出来。
 */

const INPUT =
  "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60";

const LABEL = "text-[11px] font-medium text-muted-foreground";

const STATUS_META: Record<ProviderStatus, { label: string; dot: string; text: string }> = {
  live: { label: "已配置", dot: "bg-emerald-500", text: "text-emerald-600" },
  needs_key: { label: "缺密钥", dot: "bg-rose-500", text: "text-rose-600" },
  no_models: { label: "没有模型", dot: "bg-amber-500", text: "text-amber-600" },
  disabled: { label: "已停用", dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
};

type ProviderDraft = {
  name: string;
  baseUrl: string;
  protocol: string;
  noKey: boolean;
  enabled: boolean;
};

type ModelDraft = {
  modelKey: string;
  displayName: string;
  contextWindow: string;
  maxOutputTokens: string;
  enabled: boolean;
  reasoningLevels: ReasoningLevel[];
  defaultReasoning: string;
};

function providerDraftOf(provider: ModelSettingsProvider): ProviderDraft {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    noKey: provider.authType === "none",
    enabled: provider.enabled,
  };
}

function modelDraftOf(model: ModelSettingsModel): ModelDraft {
  return {
    modelKey: model.modelKey,
    displayName: model.displayName,
    contextWindow: model.contextWindow === null ? "" : String(model.contextWindow),
    maxOutputTokens: model.maxOutputTokens === null ? "" : String(model.maxOutputTokens),
    enabled: model.enabled,
    reasoningLevels: model.reasoningLevels.map((level) => ({ ...level })),
    defaultReasoning: model.defaultReasoning ?? "",
  };
}

function sameModelDraft(a: ModelDraft, b: ModelDraft): boolean {
  return (
    a.modelKey === b.modelKey &&
    a.displayName === b.displayName &&
    a.contextWindow === b.contextWindow &&
    a.maxOutputTokens === b.maxOutputTokens &&
    a.enabled === b.enabled &&
    a.defaultReasoning === b.defaultReasoning &&
    JSON.stringify(a.reasoningLevels) === JSON.stringify(b.reasoningLevels)
  );
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `请求失败（${response.status}）`;
    const hint = typeof body.hint === "string" ? body.hint : "";
    throw new Error(hint ? `${message}：${hint}` : message);
  }
  return body as T;
}

/**
 * 设置面板每次切到「模型」都会重新挂载 → 重新拉一次 providers。
 * dev 下这条接口实测能到 0.5–1.3s（Turbopack 冷启动 + 数据库），用户感受就是
 * "点一下要等一下"。所以这里留一份内存缓存：切回来先用缓存立刻出画，
 * 超过 TTL 再后台刷新；写操作（增删改）照样显式 refresh。
 */
const SETTINGS_CACHE_TTL_MS = 30_000;
let settingsCache: { data: ModelSettings; at: number } | null = null;

function readSettingsCache(): ModelSettings | null {
  if (!settingsCache) return null;
  return Date.now() - settingsCache.at < SETTINGS_CACHE_TTL_MS ? settingsCache.data : null;
}

export function ModelsPane({ user }: { user: AccountUser | null }) {
  const router = useRouter();
  const cached = readSettingsCache();
  const [settings, setSettings] = useState<ModelSettings | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(cached?.providers[0]?.id ?? null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [addingModelFor, setAddingModelFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    // 有缓存就先别闪 loading：直接后台对齐
    setLoading((current) => (settingsCache ? current : true));
    try {
      const data = await apiJson<ModelSettings>("/api/models/providers");
      settingsCache = { data, at: Date.now() };
      setSettings(data);
      setError(null);
      setExpanded((current) =>
        current && data.providers.some((provider) => provider.id === current)
          ? current
          : (data.providers[0]?.id ?? null),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [load, user?.id]);

  const refresh = useCallback(async () => {
    await load();
    // 让 layout 的 server catalog 重新生成，composer 立刻看到新模型
    router.refresh();
  }, [load, router]);

  const createProvider = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await apiJson<{ provider: ModelSettingsProvider }>("/api/models/providers", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setAddingProvider(false);
        setNotice(`已添加 ${result.provider.name}`);
        await refresh();
        setExpanded(result.provider.id);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const updateProvider = useCallback(
    async (providerId: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await apiJson(`/api/models/providers/${providerId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setNotice("provider 已保存");
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const deleteProvider = useCallback(
    async (provider: ModelSettingsProvider) => {
      if (
        !window.confirm(
          `删除「${provider.name}」？会同时删除 ${provider.modelCount} 个模型和已保存的密钥。`,
        )
      ) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await apiJson(`/api/models/providers/${provider.id}`, { method: "DELETE" });
        setNotice(`已删除 ${provider.name}`);
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const createModel = useCallback(
    async (providerId: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await apiJson(`/api/models/providers/${providerId}/models`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        setAddingModelFor(null);
        setNotice("模型已添加");
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const importModels = useCallback(
    async (providerId: string, models: DiscoveredModel[]) => {
      if (models.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const result = await apiJson<{ created: ModelSettingsModel[]; skipped: number }>(
          `/api/models/providers/${providerId}/models/import`,
          {
            method: "POST",
            body: JSON.stringify({ models }),
          },
        );
        setNotice(
          result.created.length > 0
            ? `已导入 ${result.created.length} 个模型${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`
            : "这些模型已经添加过了",
        );
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const updateModel = useCallback(
    async (modelId: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await apiJson(`/api/models/${modelId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setNotice("模型已保存");
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const deleteModel = useCallback(
    async (model: ModelSettingsModel) => {
      if (!window.confirm(`删除模型「${model.displayName}」？`)) return;
      setBusy(true);
      setError(null);
      try {
        await apiJson(`/api/models/${model.id}`, { method: "DELETE" });
        setNotice("模型已删除");
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!user) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
        <Server size={22} className="mx-auto text-muted-foreground" />
        <p className="mt-3 text-[13px] text-foreground">登录后才能配置模型</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          provider 和 API Key 跟账户绑定，游客只使用系统默认目录。
        </p>
        <a
          href="/login"
          className="mt-4 inline-flex rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          去登录
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-medium text-foreground">模型</h3>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
            配置了哪些模型，composer 里就只显示哪些。密钥只写不读。
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setAddingProvider((value) => !value);
            setError(null);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Plus size={13} />
          添加模型提供商
        </button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3.5 py-2.5 text-[12px] text-rose-600">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}

      {notice ? (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3.5 py-2 text-[12px] text-emerald-600">
          <Check size={14} />
          {notice}
        </div>
      ) : null}

      {addingProvider ? (
        <AddProviderForm
          busy={busy}
          onCancel={() => setAddingProvider(false)}
          onCreate={(body) => void createProvider(body)}
        />
      ) : null}

      {loading && !settings ? (
        <div className="flex items-center gap-2 px-1 py-8 text-[12px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          读取模型配置…
        </div>
      ) : null}

      {settings && settings.providers.length === 0 && !addingProvider ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <Server size={22} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-[13px] text-foreground">还没有模型提供商</p>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            添加一个 OpenAI 兼容的端点，填上 API Key 和模型名，就能在输入框里选它。
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        {settings?.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            expanded={expanded === provider.id}
            busy={busy}
            addingModel={addingModelFor === provider.id}
            onToggle={() => setExpanded((current) => (current === provider.id ? null : provider.id))}
            onDelete={() => void deleteProvider(provider)}
            onSave={(body) => void updateProvider(provider.id, body)}
            onStartAddModel={() => setAddingModelFor(provider.id)}
            onCancelAddModel={() => setAddingModelFor(null)}
            onCreateModel={(body) => void createModel(provider.id, body)}
            onImportModels={(modelKeys) => void importModels(provider.id, modelKeys)}
            onUpdateModel={(modelId, body) => void updateModel(modelId, body)}
            onDeleteModel={(model) => void deleteModel(model)}
          />
        ))}
      </div>

      <p className="px-0.5 text-[11px] leading-5 text-muted-foreground">
        P4c 再加：图片输入、OAuth。现在只支持 OpenAI Chat Completions。
      </p>
    </div>
  );
}

function AddProviderForm({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [noKey, setNoKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<DiscoveryResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    setTestResult(null);
    setTestError(null);
  }, [baseUrl, apiKey, noKey]);

  const runTest = async () => {
    setTestLoading(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await apiJson<DiscoveryResult>("/api/models/providers/test", {
        method: "POST",
        body: JSON.stringify({
          baseUrl,
          authType: noKey ? "none" : "api_key",
          apiKey: noKey ? "" : apiKey,
        }),
      });
      setTestResult(result);
    } catch (error) {
      setTestError((error as Error).message);
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-primary/40 bg-muted/20 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-foreground">新的模型提供商</p>
        <button type="button" onClick={onCancel} className="text-[11px] text-muted-foreground hover:text-foreground">
          取消
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={LABEL}>显示名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：星链"
            className={INPUT}
            autoFocus
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>API 地址</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://gateway.example/v1"
            className={INPUT}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>API 协议</span>
          <select value="openai-chat" disabled className={INPUT}>
            <option value="openai-chat">OpenAI Chat Completions</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className={LABEL}>API 密钥</span>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              disabled={noKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={noKey ? "该端点不需要密钥" : "sk-…"}
              className={cn(INPUT, "pr-8")}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowKey((value) => !value)}
              disabled={noKey || !apiKey}
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={noKey}
          onChange={(event) => setNoKey(event.target.checked)}
          className="size-3.5 accent-primary"
        />
        这个端点不需要 API 密钥（本地或内网无鉴权网关）
      </label>

      {testError ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-2.5 py-2 text-[11px] text-rose-600">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{testError}</span>
        </div>
      ) : null}

      {testResult ? (
        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2">
          <p className="text-[11px] text-emerald-700">
            连接成功 · {testResult.latencyMs}ms · 发现 {testResult.models.length} 个模型
          </p>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {testResult.models
              .slice(0, 4)
              .map((model) => model.modelKey)
              .join("、")}
            {testResult.models.length > 4 ? "…" : ""}
          </p>
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={testLoading || !baseUrl.trim() || (!noKey && !apiKey.trim())}
          onClick={() => void runTest()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-muted disabled:opacity-40"
        >
          {testLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          测试连接
        </button>
        <button
          type="button"
          disabled={busy || !name.trim() || !baseUrl.trim()}
          onClick={() =>
            onCreate({
              name,
              baseUrl,
              protocol: "openai-chat",
              authType: noKey ? "none" : "api_key",
              apiKey: noKey ? "" : apiKey,
              enabled: true,
            })
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          创建
        </button>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  expanded,
  busy,
  addingModel,
  onToggle,
  onDelete,
  onSave,
  onStartAddModel,
  onCancelAddModel,
  onCreateModel,
  onImportModels,
  onUpdateModel,
  onDeleteModel,
}: {
  provider: ModelSettingsProvider;
  expanded: boolean;
  busy: boolean;
  addingModel: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSave: (body: Record<string, unknown>) => void;
  onStartAddModel: () => void;
  onCancelAddModel: () => void;
  onCreateModel: (body: Record<string, unknown>) => void;
  onImportModels: (models: DiscoveredModel[]) => void;
  onUpdateModel: (modelId: string, body: Record<string, unknown>) => void;
  onDeleteModel: (model: ModelSettingsModel) => void;
}) {
  const meta = STATUS_META[provider.status];
  const [draft, setDraft] = useState<ProviderDraft>(() => providerDraftOf(provider));
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  useEffect(() => {
    setDraft(providerDraftOf(provider));
    setApiKey("");
    setClearKey(false);
    setShowKey(false);
    setDiscovery(null);
    setDiscoverError(null);
    setSelectedKeys([]);
  }, [provider.id, provider.revision]);

  const existingKeys = useMemo(
    () => new Set(provider.models.map((model) => model.modelKey)),
    [provider.models],
  );
  const candidates = useMemo(
    () => (discovery?.models ?? []).filter((model) => !existingKeys.has(model.modelKey)),
    [discovery, existingKeys],
  );
  const candidateKeys = useMemo(() => new Set(candidates.map((model) => model.modelKey)), [candidates]);
  const selectedAvailable = selectedKeys.filter((key) => candidateKeys.has(key));
  const selectedModels = candidates.filter((model) => selectedAvailable.includes(model.modelKey));

  const runDiscovery = async () => {
    setDiscoverLoading(true);
    setDiscoverError(null);
    try {
      const result = await apiJson<DiscoveryResult>(
        `/api/models/providers/${provider.id}/discover`,
        { method: "POST" },
      );
      setDiscovery(result);
      const existing = new Set(provider.models.map((model) => model.modelKey));
      setSelectedKeys(
        result.models.filter((model) => !existing.has(model.modelKey)).map((model) => model.modelKey),
      );
    } catch (error) {
      setDiscoverError((error as Error).message);
      setDiscovery(null);
      setSelectedKeys([]);
    } finally {
      setDiscoverLoading(false);
    }
  };

  const dirty =
    draft.name !== provider.name ||
    draft.baseUrl !== provider.baseUrl ||
    draft.protocol !== provider.protocol ||
    draft.noKey !== (provider.authType === "none") ||
    draft.enabled !== provider.enabled ||
    apiKey.length > 0 ||
    clearKey;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
          )}
          <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {provider.name}
          </span>
          <span className={cn("shrink-0 text-[10px]", meta.text)}>{meta.label}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {provider.modelCount} 个模型
          </span>
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          编辑
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`删除 ${provider.name}`}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-600"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {expanded ? (
        <div className="border-t border-border/70 bg-muted/10 p-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className={LABEL}>显示名称</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                className={INPUT}
              />
            </label>
            <label className="space-y-1">
              <span className={LABEL}>API 地址</span>
              <input
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                placeholder="https://gateway.example/v1"
                className={INPUT}
              />
            </label>
            <label className="space-y-1">
              <span className={LABEL}>API 协议</span>
              <select
                value={draft.protocol}
                onChange={(event) => setDraft({ ...draft, protocol: event.target.value })}
                className={INPUT}
              >
                <option value="openai-chat">OpenAI Chat Completions</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className={LABEL}>API 密钥</span>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  disabled={draft.noKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setClearKey(false);
                  }}
                  placeholder={
                    draft.noKey
                      ? "该端点不需要密钥"
                      : provider.hasKey
                        ? `已保存 •••• ${provider.keyLast4 ?? "****"}，留空不修改`
                        : "输入 API 密钥"
                  }
                  className={cn(INPUT, "pr-8 font-mono")}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((value) => !value)}
                  disabled={draft.noKey || !apiKey}
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </label>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={draft.noKey}
                onChange={(event) => {
                  setDraft({ ...draft, noKey: event.target.checked });
                  setClearKey(event.target.checked);
                }}
                className="size-3.5 accent-primary"
              />
              不需要密钥
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                className="size-3.5 accent-primary"
              />
              启用这家 provider
            </label>
            {provider.hasKey ? (
              <button
                type="button"
                onClick={() => {
                  setClearKey(true);
                  setApiKey("");
                }}
                className="inline-flex items-center gap-1 text-[11px] text-rose-600 hover:underline"
              >
                <KeyRound size={11} />
                {clearKey ? "保存后清除密钥" : "清除已保存密钥"}
              </button>
            ) : null}
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(providerDraftOf(provider));
                setApiKey("");
                setClearKey(false);
              }}
              disabled={!dirty || busy}
              className="rounded-lg px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!dirty || busy}
              onClick={() =>
                onSave({
                  name: draft.name,
                  baseUrl: draft.baseUrl,
                  protocol: draft.protocol,
                  authType: draft.noKey ? "none" : "api_key",
                  apiKey: draft.noKey ? "" : apiKey,
                  clearKey: draft.noKey ? true : clearKey,
                  enabled: draft.enabled,
                  revision: provider.revision,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              保存 provider
            </button>
          </div>

          <div className="mt-4 border-t border-border/70 pt-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-[12px] font-medium text-foreground">模型目录</p>
                <p className="text-[10px] text-muted-foreground">
                  模型 ID 是发给上游的名字；显示名称只影响界面。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void runDiscovery()}
                  disabled={busy || discoverLoading}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] text-foreground transition-colors hover:bg-muted disabled:opacity-40"
                >
                  {discoverLoading ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  测试连接
                </button>
                <button
                  type="button"
                  onClick={onStartAddModel}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
                >
                  <Plus size={12} />
                  添加模型
                </button>
              </div>
            </div>

            {discoverError ? (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-2.5 py-2 text-[11px] text-rose-600">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">{discoverError}</span>
              </div>
            ) : null}

            {discovery ? (
              <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-emerald-700">
                    连接成功 · {discovery.latencyMs}ms · 发现 {discovery.models.length} 个模型
                  </p>
                  {candidates.length > 0 ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedKeys(
                            selectedAvailable.length === candidates.length
                              ? []
                              : candidates.map((model) => model.modelKey),
                          )
                        }
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        {selectedAvailable.length === candidates.length ? "取消全选" : "全选"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || selectedAvailable.length === 0}
                        onClick={() => {
                          onImportModels(selectedModels);
                          setSelectedKeys([]);
                        }}
                        className="rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                      >
                        添加选中（{selectedAvailable.length}）
                      </button>
                    </div>
                  ) : (
                    <span className="text-[10px] text-emerald-700">全部已添加</span>
                  )}
                </div>

                {candidates.length > 0 ? (
                  <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
                    {candidates.map((model) => (
                      <label
                        key={model.modelKey}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-emerald-500/10"
                      >
                        <input
                          type="checkbox"
                          checked={selectedKeys.includes(model.modelKey)}
                          onChange={(event) =>
                            setSelectedKeys((current) =>
                              event.target.checked
                                ? [...current, model.modelKey]
                                : current.filter((key) => key !== model.modelKey),
                            )
                          }
                          className="size-3.5 accent-emerald-600"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-foreground">
                            {model.modelKey}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {[
                              model.displayName && model.displayName !== model.modelKey
                                ? model.displayName
                                : null,
                              model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K ctx` : null,
                              model.maxOutputTokens
                                ? `${Math.round(model.maxOutputTokens / 1000)}K out`
                                : null,
                              model.reasoningLevels.length > 0
                                ? `推理 ${model.reasoningLevels.map((level) => level.label).join("/")}`
                                : null,
                              model.ownedBy,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-2 space-y-2">
              {provider.models.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                  还没有模型。添加一个模型 ID 后，composer 才会出现它。
                </p>
              ) : (
                provider.models.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    busy={busy}
                    onSave={(body) => onUpdateModel(model.id, body)}
                    onDelete={() => onDeleteModel(model)}
                  />
                ))
              )}
            </div>

            {addingModel ? (
              <AddModelForm
                busy={busy}
                onCancel={onCancelAddModel}
                onCreate={onCreateModel}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ModelRow({
  model,
  busy,
  onSave,
  onDelete,
}: {
  model: ModelSettingsModel;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<ModelDraft>(() => modelDraftOf(model));
  useEffect(() => setDraft(modelDraftOf(model)), [model.id, model.modelKey, model.displayName, model.contextWindow, model.maxOutputTokens, model.enabled, model.reasoningLevels, model.defaultReasoning]);
  const dirty = !sameModelDraft(draft, modelDraftOf(model));

  const addReasoningLevel = () => {
    let index = draft.reasoningLevels.length + 1;
    while (draft.reasoningLevels.some((level) => level.id === `level-${index}`)) index += 1;
    const next = { id: `level-${index}`, label: "", value: "" };
    setDraft({
      ...draft,
      reasoningLevels: [...draft.reasoningLevels, next],
      defaultReasoning: draft.defaultReasoning || next.id,
    });
  };

  const updateReasoningLevel = (index: number, patch: Partial<ReasoningLevel>) => {
    setDraft({
      ...draft,
      reasoningLevels: draft.reasoningLevels.map((level, current) =>
        current === index ? { ...level, ...patch } : level,
      ),
    });
  };

  const removeReasoningLevel = (index: number) => {
    const removed = draft.reasoningLevels[index];
    const reasoningLevels = draft.reasoningLevels.filter((_, current) => current !== index);
    setDraft({
      ...draft,
      reasoningLevels,
      defaultReasoning:
        draft.defaultReasoning === removed?.id ? (reasoningLevels[0]?.id ?? "") : draft.defaultReasoning,
    });
  };

  return (
    <div className="rounded-lg border border-border/80 bg-background p-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={LABEL}>模型 ID</span>
          <input
            value={draft.modelKey}
            onChange={(event) => setDraft({ ...draft, modelKey: event.target.value })}
            placeholder="deepseek-v4-flash"
            className={cn(INPUT, "font-mono")}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>显示名称</span>
          <input
            value={draft.displayName}
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
            placeholder="DeepSeek-V4-Flash"
            className={INPUT}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>上下文窗口</span>
          <input
            value={draft.contextWindow}
            onChange={(event) => setDraft({ ...draft, contextWindow: event.target.value })}
            placeholder="256K"
            inputMode="numeric"
            className={INPUT}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>最大输出 token 数</span>
          <input
            value={draft.maxOutputTokens}
            onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.value })}
            placeholder="32K"
            inputMode="numeric"
            className={INPUT}
          />
        </label>
      </div>

      <div className="mt-2 rounded-lg border border-border/70 bg-muted/10 p-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[11px] font-medium text-foreground">推理等级</p>
            <p className="text-[10px] text-muted-foreground">
              配了才会在输入框旁边出现档位选择；请求里发 reasoning_effort。
            </p>
          </div>
          <button
            type="button"
            onClick={addReasoningLevel}
            disabled={draft.reasoningLevels.length >= 8}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-foreground transition-colors hover:bg-muted disabled:opacity-40"
          >
            <Plus size={10} />
            添加等级
          </button>
        </div>

        {draft.reasoningLevels.length === 0 ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            没有配置；这个模型不会发送推理参数。
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {draft.reasoningLevels.map((level, index) => (
              <div key={level.id} className="flex items-center gap-1.5">
                <input
                  value={level.label}
                  onChange={(event) => updateReasoningLevel(index, { label: event.target.value })}
                  placeholder="名称，例如 高"
                  aria-label={`推理等级 ${index + 1} 名称`}
                  className={cn(INPUT, "h-7 min-w-0 flex-1 text-[11px]")}
                />
                <input
                  value={level.value}
                  onChange={(event) => updateReasoningLevel(index, { value: event.target.value })}
                  placeholder="上游值，例如 high"
                  aria-label={`推理等级 ${index + 1} 参数值`}
                  className={cn(INPUT, "h-7 min-w-0 flex-1 font-mono text-[11px]")}
                />
                <button
                  type="button"
                  onClick={() => removeReasoningLevel(index)}
                  aria-label={`删除推理等级 ${level.label || level.id}`}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-600"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            <label className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
              默认档位
              <select
                value={draft.defaultReasoning}
                onChange={(event) => setDraft({ ...draft, defaultReasoning: event.target.value })}
                className={cn(INPUT, "h-7 w-auto min-w-[9rem] text-[11px]")}
              >
                <option value="">第一个等级</option>
                {draft.reasoningLevels.map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.label || level.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            className="size-3.5 accent-primary"
          />
          在模型选择器里显示
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onDelete}
            aria-label={`删除模型 ${model.displayName}`}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-600"
          >
            <Trash2 size={12} />
          </button>
          <button
            type="button"
            disabled={!dirty || busy}
            onClick={() =>
              onSave({
                modelKey: draft.modelKey,
                displayName: draft.displayName,
                contextWindow: draft.contextWindow,
                maxOutputTokens: draft.maxOutputTokens,
                enabled: draft.enabled,
                reasoningLevels: draft.reasoningLevels,
                defaultReasoning: draft.defaultReasoning || null,
              })
            }
            className="rounded-lg bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/70 disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function AddModelForm({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<ModelDraft>({
    modelKey: "",
    displayName: "",
    contextWindow: "",
    maxOutputTokens: "",
    enabled: true,
    reasoningLevels: [],
    defaultReasoning: "",
  });

  return (
    <div className="mt-2 rounded-lg border border-primary/30 bg-muted/20 p-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-foreground">新模型</p>
        <button type="button" onClick={onCancel} className="text-[10px] text-muted-foreground hover:text-foreground">
          取消
        </button>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={LABEL}>模型 ID</span>
          <input
            value={draft.modelKey}
            onChange={(event) => setDraft({ ...draft, modelKey: event.target.value })}
            placeholder="deepseek-v4-flash"
            className={cn(INPUT, "font-mono")}
            autoFocus
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>显示名称（可留空）</span>
          <input
            value={draft.displayName}
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
            placeholder="跟模型 ID 一样"
            className={INPUT}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>上下文窗口（可留空）</span>
          <input
            value={draft.contextWindow}
            onChange={(event) => setDraft({ ...draft, contextWindow: event.target.value })}
            placeholder="256K"
            inputMode="numeric"
            className={INPUT}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>最大输出 token 数（可留空）</span>
          <input
            value={draft.maxOutputTokens}
            onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.value })}
            placeholder="32K"
            inputMode="numeric"
            className={INPUT}
          />
        </label>
      </div>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          disabled={busy || !draft.modelKey.trim()}
          onClick={() =>
            onCreate({
              modelKey: draft.modelKey,
              displayName: draft.displayName,
              contextWindow: draft.contextWindow,
              maxOutputTokens: draft.maxOutputTokens,
              enabled: true,
            })
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          添加
        </button>
      </div>
    </div>
  );
}
