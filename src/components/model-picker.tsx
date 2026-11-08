"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronUp, Settings2 } from "lucide-react";

import { useAppShell } from "@/components/app-shell";
import type { PublicModel, PublicProviderGroup, ReasoningLevel } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * 输入框右侧的模型选择器。
 *
 * 交互是照着截图做的，但底层刻意不用下拉框组件：
 *   1. 每一行要放「名字 + 倍率徽标 + 未配置状态」，原生 <select> 表达不了
 *   2. 搜索要同时匹配模型名和分组名（搜「星链」也要有结果）
 *   3. 需要键盘上下选择 + Enter 确认 + Esc 关闭，这是一套 listbox 语义
 *
 * 结构上只有「触发器 + 绝对定位的弹层」，不引第三方依赖。
 * 弹层向上开：输入框永远在页面底部，向下开一定会被视口裁掉。
 */

type ModelPickerProps = {
  groups: PublicProviderGroup[];
  selected: PublicModel | null;
  onSelect: (id: string) => void;
};

/** 输入框旁的推理档位选择；模型没配等级时整个组件不渲染 */
export function ReasoningPicker({
  levels,
  value,
  onChange,
}: {
  levels: ReasoningLevel[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (levels.length === 0) return null;
  return (
    <label className="shrink-0">
      <span className="sr-only">推理等级</span>
      <select
        value={value ?? levels[0]?.id ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 max-w-[7.5rem] rounded-full bg-muted/60 px-2 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        title="推理等级"
      >
        {levels.map((level) => (
          <option key={level.id} value={level.id}>
            {level.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ModelPicker({ groups, selected, onSelect }: ModelPickerProps) {
  const { openSettings } = useAppShell();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 账户目录为空时，按钮的职责从「选模型」变成「去配置模型」
  const available = useMemo(
    () => groups.flatMap((group) => group.models).filter((model) => model.status !== "off"),
    [groups],
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return groups;
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter((model) =>
          [model.label, model.id, model.badge ?? "", group.label]
            .join(" ")
            .toLowerCase()
            .includes(keyword),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [groups, query]);

  const flat = useMemo(() => filtered.flatMap((group) => group.models), [filtered]);

  const flatIndex = useMemo(
    () => new Map(flat.map((model, index) => [model.id, index])),
    [flat],
  );

  // 键盘只在「能用」的行之间走：未配置的 provider 不该吃掉一次 Enter
  const enabledIndexes = useMemo(
    () => flat.flatMap((model, index) => (model.status === "off" ? [] : [index])),
    [flat],
  );

  // 打开 / 搜索词变化时，把高亮落在当前选中项（没有就落在第一个可用项）
  useEffect(() => {
    if (!open) return;
    const selectedIndex = flat.findIndex((model) => model.id === selected?.id);
    if (selectedIndex >= 0 && flat[selectedIndex]?.status !== "off") {
      setActiveIndex(selectedIndex);
      return;
    }
    setActiveIndex(enabledIndexes[0] ?? 0);
  }, [open, query, flat, selected?.id, enabledIndexes]);

  function moveActive(delta: 1 | -1) {
    if (enabledIndexes.length === 0) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const next =
      current < 0
        ? delta > 0
          ? 0
          : enabledIndexes.length - 1
        : (current + delta + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[next]);
  }

  // 打开后：焦点进搜索框，选中项滚进可视区
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      searchRef.current?.focus();
      const node = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
      node?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // 点外面关闭。用 pointerdown 而不是 click：拖动选择文字时不会误关
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setQuery("");
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close(restoreFocus = true) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  }

  function choose(model: PublicModel) {
    if (model.status === "off") return;
    onSelect(model.id);
    close();
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const model = flat[activeIndex];
      if (model) choose(model);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      // 弹层不是模态框，Tab 出去就顺势收起，别让它孤零零挂在页面上
      setOpen(false);
      setQuery("");
    }
  }

  const activeModel = flat[activeIndex];
  const activeOptionId = activeModel
    ? `model-option-${activeModel.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
    : undefined;

  return (
    <div ref={wrapperRef} className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (available.length === 0) {
            openSettings("models");
            return;
          }
          if (open) close();
          else setOpen(true);
        }}
        aria-label={
          available.length === 0
            ? "还没有可用模型，去设置"
            : selected
              ? `当前模型：${selected.label}，点击切换`
              : "选择模型"
        }
        aria-haspopup={available.length === 0 ? undefined : "listbox"}
        aria-expanded={available.length === 0 ? undefined : open}
        aria-controls={available.length === 0 ? undefined : "model-picker-list"}
        title={available.length === 0 ? "还没有配置模型，点击去设置" : undefined}
        className={cn(
          "flex h-9 max-w-[60vw] min-w-0 items-center gap-1.5 rounded-full px-2 text-[12px] transition-colors sm:max-w-[280px]",
          open
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {available.length === 0 ? <Settings2 size={13} className="shrink-0" /> : null}
        <span className="truncate font-medium">
          {selected?.label ?? (available.length === 0 ? "配置模型" : "选择模型")}
        </span>
        {selected?.badge ? (
          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums">
            {selected.badge}
          </span>
        ) : null}
        {selected?.tag ? (
          <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
            {selected.tag}
          </span>
        ) : null}
        <ChevronUp
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
            available.length === 0 && "hidden",
          )}
        />
      </button>

      {open ? (
        <div
          className="model-pop absolute right-0 bottom-[calc(100%+6px)] z-50 flex max-h-[min(64vh,520px)] w-[min(88vw,340px)] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-[0_24px_70px_-20px_rgba(0,0,0,0.35),0_2px_8px_rgba(0,0,0,0.06)] sm:right-10"
          role="dialog"
          aria-label="选择模型"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          <div className="shrink-0 border-b border-border/70 px-3 py-2.5">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              role="combobox"
              aria-expanded
              aria-controls="model-picker-list"
              aria-autocomplete="list"
              aria-activedescendant={activeOptionId}
              aria-label="搜索模型"
              placeholder="搜索模型…"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div
            ref={listRef}
            id="model-picker-list"
            role="listbox"
            aria-label="可用模型"
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {filtered.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="text-[13px] text-foreground">没有匹配的模型</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  试试模型名、倍率，或者分组名
                </p>
              </div>
            ) : (
              filtered.map((group) => {
                const labelId = `model-group-${group.id}`;
                return (
                  <div key={group.id} role="group" aria-labelledby={labelId}>
                    <div
                      id={labelId}
                      className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground"
                    >
                      <span className="truncate">{group.label}</span>
                      {group.status === "off" ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground/70">
                          未配置
                        </span>
                      ) : null}
                    </div>

                    {group.models.map((model) => {
                      const isSelected = model.id === selected?.id;
                      const isActive = flatIndex.get(model.id) === activeIndex;
                      const disabled = model.status === "off";
                      return (
                        <button
                          key={model.id}
                          id={`model-option-${model.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          aria-disabled={disabled}
                          disabled={disabled}
                          data-selected={isSelected ? "true" : undefined}
                          // 保持焦点在搜索框里，键盘上下键才不会断
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => {
                            const index = flatIndex.get(model.id);
                            if (index !== undefined && !disabled) setActiveIndex(index);
                          }}
                          onClick={() => choose(model)}
                          title={model.description}
                          tabIndex={-1}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors",
                            disabled && "cursor-not-allowed opacity-45",
                            isSelected
                              ? "bg-muted font-medium text-foreground"
                              : isActive
                                ? "bg-muted/60 text-foreground"
                                : "text-foreground/90 hover:bg-muted/60",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{model.label}</span>
                          {model.badge ? (
                            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums">
                              {model.badge}
                            </span>
                          ) : null}
                          {isSelected ? (
                            <Check size={14} className="shrink-0 text-foreground" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
