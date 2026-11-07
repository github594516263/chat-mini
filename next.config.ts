import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next 16 的 dev 服务器会校验静态资源请求的来源，不在白名单里的 origin 直接 403。
  // 用 127.0.0.1 而不是 localhost 打开页面时，客户端 chunk 会被拦掉（样式能出来、高亮不出来）。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
