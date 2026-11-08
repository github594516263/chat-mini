import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next 16 的 dev 服务器会校验静态资源请求的来源，不在白名单里的 origin 直接 403。
  // 用 127.0.0.1 而不是 localhost 打开页面时，客户端 chunk 会被拦掉（样式能出来、高亮不出来）。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Docker 部署用：产物变成 .next/standalone，只需要 node server.js 就能跑，
  // 镜像里不用装完整 node_modules（镜像从 ~700MB 降到 ~200MB）。
  output: "standalone",
  // mysql2 是 CJS 驱动，交给 Turbopack 打包容易在 standalone 里丢动态 require。
  // 声明成外部包后，Next 的 output tracing 会把 node_modules/mysql2 原样拷进产物。
  serverExternalPackages: ["mysql2"],
};

export default nextConfig;
