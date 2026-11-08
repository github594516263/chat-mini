"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ModelCatalog, PublicModel, PublicProviderGroup } from "@/lib/models";

/**
 * 模型选择的前端状态。
 *
 * 目录由服务端组件通过 props 注入（见 (chat)/layout.tsx），所以这里不发请求、
 * 没有 loading 态，首屏就能显示正确的分组和"是否已配置"。
 *
 * 选择只存 localStorage：
 *   - 它是"这台设备上我上次用哪个"，不是用户数据，不值得为它加一张表
 *   - 按账号分 key，换账号不会串
 *   - 以后要做"每个会话记住模型"，把 key 换成 sessionId 即可，其余逻辑不动
 */

const KEY_PREFIX = "chat-mini/model/v1";

function keyOf(scope: string): string {
  return `${KEY_PREFIX}/${scope}`;
}

function readSaved(scope: string): string | null {
  try {
    return window.localStorage.getItem(keyOf(scope));
  } catch {
    // 无痕模式 / 禁用存储：当作没选过
    return null;
  }
}

function writeSaved(scope: string, id: string) {
  try {
    window.localStorage.setItem(keyOf(scope), id);
  } catch {
    // 写不进去就算了，本次会话内的 state 还在
  }
}

export type ModelSelection = {
  groups: PublicProviderGroup[];
  models: PublicModel[];
  selected: PublicModel | null;
  selectedId: string | null;
  select: (id: string) => void;
};

export function useModelSelection(catalog: ModelCatalog, scope = "guest"): ModelSelection {
  const { groups, defaultId } = catalog;

  const models = useMemo(() => groups.flatMap((group) => group.models), [groups]);

  const defaultModel = useMemo(() => {
    const preferred = models.find((model) => model.id === defaultId);
    if (preferred && preferred.status !== "off") return preferred;
    return (
      models.find((model) => model.status === "live") ??
      models.find((model) => model.status !== "off") ??
      models[0] ??
      null
    );
  }, [models, defaultId]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  /** 只接受目录里存在、而且不是 off 的 id */
  const accept = useCallback(
    (candidate: string | null): boolean => {
      if (!candidate) return false;
      const model = models.find((item) => item.id === candidate);
      if (!model || model.status === "off") return false;
      setSelectedId(model.id);
      return true;
    },
    [models],
  );

  // 挂载后再读 localStorage：首帧用服务端给的默认值，SSR 和水合不会打架
  useEffect(() => {
    if (accept(readSaved(scope))) return;
    setSelectedId(defaultModel?.id ?? null);
  }, [accept, defaultModel, scope]);

  // 另一个标签页换了模型：跟过去，保持同一个账号下界面一致
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== keyOf(scope)) return;
      if (!accept(event.newValue)) setSelectedId(defaultModel?.id ?? null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [accept, defaultModel, scope]);

  const select = useCallback(
    (id: string) => {
      if (!accept(id)) return;
      writeSaved(scope, id);
    },
    [accept, scope],
  );

  const selected = useMemo(
    () => models.find((model) => model.id === selectedId) ?? defaultModel,
    [models, selectedId, defaultModel],
  );

  return {
    groups,
    models,
    selected,
    selectedId: selected?.id ?? null,
    select,
  };
}
