# chat-mini 生产镜像：三阶段构建
#   1) deps    —— 只装依赖，锁文件不变就命中缓存
#   2) builder —— 编译 Next（吃内存最多的一步）
#   3) runner  —— 只留 standalone 产物 + 一个 node
#
# 为什么用 debian slim 而不是 alpine：
# Next 16 的 Turbopack / SWC 是原生二进制，alpine 的 musl 版本偶尔在特定版本上缺包，
# 报错还很难读。这台机器磁盘有 37G，多花 100M 换「一次构建成功」很值。

# ---------------------------------------------------------------- 1. 依赖
FROM node:22-slim AS deps
WORKDIR /app

# 锁文件是 lockfileVersion 9.0，用 pnpm 9 最稳
RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- 2. 构建
FROM node:22-slim AS builder
WORKDIR /app

RUN npm install -g pnpm@9

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 2C2G 机器上 Turbopack 构建峰值会顶到 1.5G 左右：限个上限让它失败得干脆，
# 而不是被内核 OOM Killer 静默干掉（需要宿主机 2G swap 兜底）。
ENV NODE_OPTIONS=--max-old-space-size=1536
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

# ---------------------------------------------------------------- 2.5 脚本依赖
# create-user.mjs 会直接 import mysql2，需要 node_modules 里真实存在的包；
# standalone 产物只含被 bundle 进 server.js 的代码，不含原始文件。
# pnpm 的 node_modules 是一堆指向 .pnpm 的软链接，COPY 过来全会断，
# 所以用一个干净的 npm 扁平安装，只为拿 mysql2 及其依赖（约 10MB）。
FROM node:22-slim AS tools
WORKDIR /tools
RUN npm install mysql2@3 --omit=dev --no-package-lock --no-audit --no-fund

# ---------------------------------------------------------------- 3. 运行
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0 \
    TZ=Asia/Shanghai

# standalone 产物里带了 server.js 和被 trace 到的运行时代码
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# 建号脚本要用：注册接口默认关闭，第一个账号只能靠它建
#   docker compose exec app node scripts/create-user.mjs 你的用户名
COPY --from=builder /app/scripts ./scripts
# 脚本运行时要能解析到 mysql2 —— 所以把 tools 阶段的扁平依赖合进来
COPY --from=tools /tools/node_modules ./node_modules

# 仓库没有 public/ 目录，所以这里不 COPY public（以后加了就再补一行）

# 非 root 运行。slim 镜像自带 uid 1000 的 node 用户
USER node

EXPOSE 3001

# 健康检查：/api/health 会真的去连 MySQL，比只测端口靠谱。
# slim 镜像没有 wget/curl，用 node 自带的 fetch。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
