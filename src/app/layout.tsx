import type { Metadata } from "next";
import { Suspense } from "react";

import { ApiKeySettingsProvider } from "@/components/ApiKeySettingsProvider";
import { AppShell } from "@/components/AppShell";
import { warnMissingRuntimeConfigOnce } from "@/lib/runtime-config";

import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 知识库管理平台",
  description: "本地优先的 AI 知识库：导入、混合检索、RAG 问答与知识图谱，数据留在本机。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const runtimeConfig = warnMissingRuntimeConfigOnce();

  return (
    <html lang="zh-CN">
      <body>
        <ApiKeySettingsProvider runtimeConfig={runtimeConfig}>
          <Suspense fallback={<div className="app-shell" aria-hidden="true" />}>
            <AppShell>{children}</AppShell>
          </Suspense>
        </ApiKeySettingsProvider>
      </body>
    </html>
  );
}
