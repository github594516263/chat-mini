"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";

import type { ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

const LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

export function ThemeMenu({
  mode,
  onSelect,
}: {
  mode: ThemeMode;
  onSelect: (mode: ThemeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const Current = OPTIONS.find((option) => option.value === mode)?.icon ?? Monitor;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`主题：${LABEL[mode]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`主题：${LABEL[mode]}`}
        className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Current size={15} />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-9 right-0 z-40 w-36 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg"
        >
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = option.value === mode;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon size={13} />
                {option.label}
                {active ? <Check size={12} className="ml-auto text-primary" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
