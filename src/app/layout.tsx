import type { Metadata, Viewport } from "next";
import { Suspense } from "react";

import { THEME_INIT_SCRIPT } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: "chat-mini",
  description: "一个不到 300 行的最小 LLM 聊天站：自研事件协议 + streamdown 渲染",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1b1d" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/*
          首屏防闪白：这段脚本在 React 之前跑，先把 .dark 挂到 <html> 上，
          否则深色用户会先看到一帧白色再切过去。
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full antialiased">
        <Suspense fallback={null}>{children}</Suspense>
      </body>
    </html>
  );
}
