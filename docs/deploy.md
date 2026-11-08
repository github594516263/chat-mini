# chat-mini 生产部署记录

> 腾讯云轻量应用服务器 · 新加坡二区 · Ubuntu 22.04
> 部署时间：2026-11-08 ｜ 部署方式：Docker Compose + Next.js standalone

## 0. 现状速查

| 项目 | 值 |
|---|---|
| 访问地址 | **https://chat.hhyapi.top** |
| 服务器 IP | `43.156.136.197`（实例 `lhins-rv0i32vj`） |
| 部署目录 | `/opt/chat-mini` |
| 对外端口 | 80 / 443（nginx），3001 **只绑 127.0.0.1** |
| 容器 | `chat-mini`（应用）、`chat-mini-mysql`（MySQL 8.0.46） |
| 镜像大小 | `chat-mini-app` 296MB ／ `mysql:8.0` 799MB |
| 账号 | `admin`（首个账号，密码部署时生成，建议尽早重置） |
| 证书 | Let's Encrypt，`chat.hhyapi.top`，有效期至 **2027-02-06**，自动续期 |
| 系统 | Ubuntu 22.04 LTS / 5.15.0-106 / nginx 1.18.0 / Docker + Compose v2 |
| 运行时 | Node v22.23.4（容器内）/ MySQL 8.0.46 |

---

## 1. 硬件约束（决定了后面所有设计）

```
CPU   2 核
内存  1.9 GiB（可用原本只剩 317MB）
磁盘  50 GiB（部署前已用 11G，剩 37G）
Swap  0  ← 致命
```

第 2 节的内存账是一切的前提：**2G 机器上 `next build` 峰值会顶到 ~1.5G，没有 swap 会被内核 OOM Killer 静默杀掉**（表现是 SSH 突然断开、没有任何报错，极易误判成网络问题）。

---

## 2. 部署前盘点：这台机器原来跑着什么

`/opt` 下五个目录，对应三套 compose 项目 + Docker 运行时：

| 目录 | 容器 | 内存 | 端口 | 处置 |
|---|---|---|---|---|
| `/opt/containerd` | — | — | — | Docker 运行时，保留 |
| `/opt/WindsurfAPI` | `windsurf-lb` + `windsurfapi-windsurf-api-1` | **~620MB** | 3003 | 删除 |
| `/opt/proxy` | `new-api` + `postgres` + `redis` + `cpa` | ~220MB | 3000 | 删除 |
| `/opt/sub2api` | `sub2api` + `sub2api-redis` + `sub2api-postgres` | ~110MB | 9090 | **保留** |
| `/opt/gpt-image-playground` | `gpt-image-playground` | — | 8080 | 停用（未删目录） |

内存大头：

```
/opt/windsurf/language_server_linux_x64   514MB  ← 单进程占 25% 内存
postgres (checkpointer)                   141MB
node src/index.js (WindsurfAPI 入口)       65MB
/app/sub2api                               63MB
python vnc.py（VNC 桌面）                  61MB  ← 一并关闭
/new-api                                   36MB
```

### 关键判据：`/opt/proxy` 能整套删

先看 `docker-compose.yml` 自带的注释：

```yaml
cpa:
#   ports: - "9999:8317"  # ❓因为这次是通过newapi对外提供服务，cpa只是作为认证文件管理工具
```

`cpa` 从未对公网开放，只是给 new-api 供认证的零件；`postgres` 存的是 new-api 的用户/额度，`redis` 是它的缓存。**四个容器互为依赖，拆掉任何一个剩下的都是僵尸**——所以必须整套 `compose down`，而不是单独 `docker rm` 一个。

再交叉验证 nginx 的域名映射（`conf.d/hhyapi.conf`）：

| 域名 | 转发到 | 是谁 | 结论 |
|---|---|---|---|
| `api.hhyapi.top` | `127.0.0.1:3000` | new-api | 死 |
| `wind.hhyapi.top` | `127.0.0.1:3003` | WindsurfAPI | 死 |
| `kiro.hhyapi.top` | `127.0.0.1:8990` | kiro-rs（容器早已不存在） | 死 |
| `sub2.hhyapi.top` | `127.0.0.1:9090` | sub2api | **活的，保留** |

---

## 3. 清理：怎么删才真的释放内存

```bash
# 按 compose 项目停：停容器 + 删容器 + 删网络，保留数据卷（可回滚）
cd /opt/WindsurfAPI && sudo docker compose down
cd /opt/proxy       && sudo docker compose down

# 宿主机上的残留进程要单独杀
sudo pkill -f 'language_server_linux_x64'
sudo pkill -f 'vnc.py'
```

### 三条铁律

1. **必须先 `docker compose down`，再 `rm -rf` 目录。** 反过来做，容器还在跑、镜像还在占盘、内存一点没释放。
2. **`down` 不要顺手加 `-v`。** 加了会连数据卷一起删，不可恢复；不加的话三天后想回滚只要 `docker compose up -d`。
3. **应用和它的数据库要一起下。** 只删 web 服务会留下 MySQL/Postgres 继续吃 200MB+。

清理后可用内存：**317MB → 1.1GB**。

---

## 4. 加 swap（前置条件，不是优化）

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab      # 开机自动挂
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl -p /etc/sysctl.d/99-swappiness.conf
```

- `vm.swappiness=10`：尽量不用 swap，只在真不够时垫一下。默认 60 会让构建时疯狂换页，卡到怀疑人生。
- 写进 `/etc/fstab` 才会重启后自动生效，**漏了这步机器一重启 swap 就没了**。

---

## 5. 容器化方案

### 新增文件

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 三阶段构建（deps / builder / runner）+ 一个 `tools` 阶段 |
| `.dockerignore` | 排除 `node_modules`、`.next`、`.env`、本地产物 |
| `docker-compose.yml` | `app` + `mysql` 两个服务 |
| `.env.docker.example` | compose 读取的环境变量模板 |
| `deploy/mysql-init/02-grants.sql` | 收紧应用账号权限（收回 DDL） |
| `next.config.ts` | 加 `output: "standalone"` + `serverExternalPackages: ["mysql2"]` |
| `scripts/create-user.mjs` | 无 `.env.local` 时改读环境变量（容器内可用） |

### 三个关键决策

**① `output: "standalone"`**
产物变成 `.next/standalone + node server.js`，镜像里不需要完整 `node_modules`，镜像体积从 ~700MB 降到 296MB。

**② `serverExternalPackages: ["mysql2"]`**
`mysql2` 是 CJS 驱动，交给 Turbopack 打包容易丢动态 `require`。声明为外部包后由 Next 的 output tracing 处理，避免运行时 `Cannot find module 'mysql2'`。

**③ 单独的 `tools` 阶段装 mysql2**
这是部署时踩出来的坑（见 §12）：`scripts/create-user.mjs` 要 `import mysql2`，但 standalone 产物只含被 bundle 进 `server.js` 的代码，**没有原始包文件**，建号会直接报错。而 pnpm 的 `node_modules` 是一堆指向 `.pnpm` 的软链接，`COPY` 过来全会断，所以用干净的 npm 扁平安装单独拿一份：

```dockerfile
FROM node:22-slim AS tools
WORKDIR /tools
RUN npm install mysql2@3 --omit=dev --no-package-lock --no-audit --no-fund
# …runner 阶段：
COPY --from=tools /tools/node_modules ./node_modules
```

### 为什么用 debian slim 而不是 alpine

Next 16 的 Turbopack / SWC 是原生二进制，alpine 的 musl 版本偶发缺包且报错难读。磁盘有 37G，多花 100MB 换「一次构建成功」。

### 网络与端口策略

```yaml
app:
  ports:
    - "127.0.0.1:3001:3001"   # 只绑本机，交给 nginx 反代
mysql:
  # 故意不写 ports：完全不出网
```

- `app` 绑 `127.0.0.1`：直连公网会绕开 HTTPS，而 HTTPS 是登录功能的前提（见 §12）。
- `mysql` 一个端口都不开：只在 compose 内网可达。

### MySQL 内存限制（2G 机器必调）

```yaml
command:
  - --innodb-buffer-pool-size=256M
  - --performance-schema=OFF     # 单独就省 ~100MB
  - --max-connections=50
  - --default-time-zone=+00:00   # 项目内部统一 UTC
```

---

## 6. 构建与启动

```bash
cd /opt/chat-mini
cp .env.docker.example .env && chmod 600 .env
# 编辑 .env（见下表）
sudo docker compose up -d --build
```

`.env` 必填项：

| 变量 | 说明 |
|---|---|
| `DB_NAME=chat_mini` / `DB_USER=chat_app` | **别改**，`02-grants.sql` 里写死了 |
| `DB_PASSWORD` | 应用账号密码，随机生成 |
| `DB_ROOT_PASSWORD` | root 密码，只在容器内用 |
| `MODEL_SECRET_KEY` | `openssl rand -base64 32`，**必须是 32 字节 base64** |
| `DEEPSEEK_API_KEY` | 留空则走假数据流 |

> ⚠️ `MODEL_SECRET_KEY` 用于加密用户在「设置 → 模型」里填的 API Key。**换掉它 = 所有已保存的密钥解不开，用户必须重填。** 部署后立刻备份到 `~/chat-mini-env-备份.txt`。

实际构建耗时：拉镜像 + 装依赖约 1 分钟，`next build` 约 **42 秒**（远快于最初 10~20 分钟的预估）。

---

## 7. 数据库初始化（全自动）

首次启动时 MySQL 数据目录为空，`docker-entrypoint` 按字母序执行挂载进去的脚本：

```yaml
volumes:
  - ./scripts/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro
  - ./deploy/mysql-init/02-grants.sql:/docker-entrypoint-initdb.d/02-grants.sql:ro
```

`02-grants.sql` 把 entrypoint 默认给的 `ALL` 收成 CRUD：

```sql
REVOKE ALL PRIVILEGES ON `chat_mini`.* FROM 'chat_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `chat_mini`.* TO 'chat_app'@'%';
FLUSH PRIVILEGES;
```

**这两个脚本只在「数据目录为空」时执行一次。** 之后再改 schema 要手动 `mysql < scripts/schema.sql`。

建出的 9 张表：

```
auth_sessions  chat_sessions  messages  model_credentials  model_providers
models  runs  user_model_preferences  users
```

---

## 8. 建账号（注册接口默认关闭）

```bash
sudo docker compose exec app node scripts/create-user.mjs admin
# 改密码：
sudo docker compose exec app node scripts/create-user.mjs admin --reset
```

脚本支持非交互输入，可以用来批量建号：

```bash
printf '%s\n%s\n' "$PW" "$PW" | sudo docker compose exec -T app node scripts/create-user.mjs someone
```

---

## 9. nginx 反向代理

配置文件：`/etc/nginx/conf.d/chat-mini.conf`

```nginx
server {
    listen 443 ssl;
    server_name chat.hhyapi.top;

    client_max_body_size 10m;

    ssl_certificate     /etc/letsencrypt/live/chat.hhyapi.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.hhyapi.top/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # ⚠️ 流式输出的命门
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
}
```

### 为什么这四行是命门

项目用自研 NDJSON 事件协议做流式输出。nginx 默认开启 `proxy_buffering`，会**攒够一个缓冲区才转发给客户端**，表现为「等很久 → 一大段字突然全出来」。生成功能看起来像坏了，其实只是被 nginx 扣住了。

- `proxy_buffering off` 关缓冲
- `proxy_read_timeout/send_timeout 3600s` 防止长回答被 60 秒默认值截断

### 同时做的清理

`conf.d/hhyapi.conf` 里三个后端已删除的站点（`api.` / `wind.` / `kiro.`）已注释，原件备份为 `hhyapi.conf.bak.20261108-185233`。

> 备份文件故意不以 `.conf` 结尾——nginx 的 `include conf.d/*.conf` 不会加载它，否则会出现「配置重复」的诡异问题。

---

## 10. HTTPS 证书

**方案：Let's Encrypt（免费）+ certbot 自动续期。不需要购买腾讯云的付费证书。**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d chat.hhyapi.top \
  --agree-tos --register-unsafely-without-email --redirect --non-interactive
```

| 项目 | 值 |
|---|---|
| 证书路径 | `/etc/letsencrypt/live/chat.hhyapi.top/fullchain.pem` |
| 私钥路径 | `/etc/letsencrypt/live/chat.hhyapi.top/privkey.pem` |
| 到期时间 | 2027-02-06（89 天） |
| 续期 | `certbot.timer` 系统定时器，自动续 + 自动 reload nginx |
| HTTP → HTTPS | `--redirect` 已生成 301 跳转块 |

### 前置条件（缺一不可）

1. DNS `A` 记录：`chat` → `43.156.136.197`
2. 腾讯云轻量控制台 → 防火墙 → 放通 `TCP 443`（80 早就开了）
3. 80 端口能通（Let's Encrypt 的 HTTP-01 验证走 80）

### 为什么不用腾讯云的证书

腾讯云文档讲的是「买证书 → 下载压缩包 → 手动贴 pem 路径 → 到期手动换」。Let's Encrypt 免费、一条命令、自动续期，自用站没有买的理由。付费证书的优势只有「多年期」和「通配符」，这里都不需要。

---

## 11. 验收清单（实测结果）

| 检查项 | 命令 | 结果 |
|---|---|---|
| 应用健康 | `curl -s http://127.0.0.1:3001/api/health` | `{"ok":true,"db":{"connected":true,"tables":9}}` |
| 外网 HTTPS | `curl https://chat.hhyapi.top/` | `200`，TLS 校验通过 |
| 登录接口 | `POST /api/auth/login` | 返回 `{"user":{"username":"admin"}}` |
| Cookie 下发 | 看响应头 | `chat_session=…; Secure; HttpOnly; SameSite=lax` |
| HTTP 跳转 | 访问 `http://` | `301 → https://` |
| 容器状态 | `docker compose ps` | 两个都 `(healthy)` |
| 流式配置 | 检查 443 段 | `proxy_buffering off` 保留 |
| 旧业务未受影响 | `curl -H 'Host: sub2.hhyapi.top'` | `200` |

最终资源占用：

```
内存   1.9GiB 总量，可用 1.0GiB
Swap   2.0GiB（用了 335MB）
磁盘   50G 用 16G，剩 32G
```

---

## 12. 踩坑记录

| # | 现象 | 原因 | 解决 |
|---|---|---|---|
| 1 | `git clone` 报 `Permission denied` 建不了目录 | `/opt` 属主是 root | `sudo mkdir` + `sudo chown ubuntu:ubuntu` 后再 clone。**不要 `sudo git clone`**，否则文件全是 root 的，后续编辑要一路 sudo |
| 2 | 服务器上找不到 `.env.docker.example` | `git clone` 默认拉默认分支 `main`，部署文件当时只在 `v1.1` | `git checkout v1.1`，或把 `v1.1` 合并推到 `main` |
| 3 | SSH 报 `REMOTE HOST IDENTIFICATION HAS CHANGED` | 本机 `known_hosts` 里存的是**旧服务器**的主机公钥（同 IP 复用） | 先从**服务器本地**跑 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 拿指纹，与客户端收到的比对；一致才 `ssh-keygen -R <IP>` 清掉旧记录 |
| 4 | `ERR_MODULE_NOT_FOUND: Cannot find package 'mysql2'` | standalone 产物只含 bundle 后的代码；pnpm 的 node_modules 是软链接，不能直接 COPY | 加 `tools` 阶段用 npm 扁平安装 mysql2，`COPY --from=tools` 合入 |
| 5 | 构建突然中断、SSH 断开、没有任何报错 | 内存不足被 OOM Killer 杀掉 | 先加 2G swap；`Dockerfile` 里 `NODE_OPTIONS=--max-old-space-size=1536` 让它失败得干脆；排查 `dmesg \| grep -i oom` |
| 6 | 登录「成功」但立刻跳回登录页 | 生产构建下 cookie 带 `Secure`，而浏览器**只在 HTTPS 或 localhost 下保存 Secure cookie** | 必须挂 HTTPS；临时可用 `ssh -L 3001:127.0.0.1:3001` 走 `http://localhost:3001` |
| 7 | 生成时「憋很久然后一大段字突然出现」 | nginx 默认 `proxy_buffering on` 扣住了流 | `proxy_buffering off` + 拉长 `proxy_read_timeout` |
| 8 | `curl -c` 拿到的 cookie 罐看着是空的 | curl 存 HttpOnly cookie 时行首是 `#HttpOnly_`，被 `grep -v '^#'` 误过滤 | 别用 `#` 过滤，或看 `set-cookie` 响应头 |
| 9 | PowerShell 里 `ssh "复杂命令"` 引号被吃掉，远端报语法错 | PowerShell 到原生程序的参数转义规则 | 复杂命令写成 `.sh` 文件 `scp` 上去再 `bash` 执行；注意先统一成 LF（`-replace "\r\n","\n"`） |

---

## 13. 运维手册

### 日常

```bash
cd /opt/chat-mini

sudo docker compose ps                      # 容器状态
sudo docker compose logs -f app             # 应用日志
sudo docker compose logs --tail=100 mysql   # 数据库日志
sudo docker compose restart app             # 只重启应用
```

### 更新代码

```bash
cd /opt/chat-mini
git pull
sudo docker compose up -d --build     # ⚠️ 必须带 --build，否则跑的还是旧镜像
```

### 改配置（.env）

```bash
nano /opt/chat-mini/.env
cd /opt/chat-mini && sudo docker compose up -d    # 重建容器让新环境变量生效
```

### 数据库备份 / 恢复

```bash
# 备份（-p 后跟 .env 里的 DB_ROOT_PASSWORD）
sudo docker compose exec -T mysql \
  mysqldump -uroot -p"$ROOT_PW" --single-transaction --routines chat_mini \
  | gzip > ~/chat-mini-$(date +%F).sql.gz

# 恢复
gunzip -c ~/chat-mini-2026-11-08.sql.gz \
  | sudo docker compose exec -T mysql mysql -uroot -p"$ROOT_PW" chat_mini
```

### 证书

```bash
sudo certbot certificates          # 看有效期
sudo certbot renew --dry-run       # 演练续期
```

### 健康检查

```bash
curl -s http://127.0.0.1:3001/api/health
```

---

## 14. 安全事项

| 事项 | 说明 |
|---|---|
| **DeepSeek API Key 已泄露** | 部署过程中密钥随截图外泄，**必须去平台删除并重新生成**，再写回 `.env` |
| `.env` 权限 | `chmod 600`，已在 `.gitignore` 与 `.dockerignore` 中 |
| `MODEL_SECRET_KEY` | 备份在服务器 `~/chat-mini-env-备份.txt`；丢失则用户模型密钥全部失效 |
| MySQL | 不对公网开放任何端口；`bind-address=127.0.0.1` |
| 应用端口 | 只绑 `127.0.0.1:3001`，不直接暴露 |
| 部署密钥 | 本机 `.ssh-deploy/id_ed25519`（已加入 `.gitignore`）。撤销方式：删服务器 `~/.ssh/authorized_keys` 里 `chat-mini-deploy` 那一行 |
| 旧密码习惯 | `docker-compose` 里曾出现与 GitHub 用户名同号的明文密码，已随服务删除；**别让同一个数字同时当账号名和密码** |
| admin 密码 | 部署时随机生成，建议 `create-user.mjs admin --reset` 改掉 |

---

## 15. 跨境访问性能（中国大陆 → 新加坡）

### 结论：慢在网络，不在服务器

| 实测项 | 数值 | 判断 |
|---|---|---|
| 服务器负载 | `load average: 0.00, 0.07, 0.18`（2 核） | 几乎全闲 |
| 本机 TTFB（首页） | **7 ms** | 服务端极快 |
| 本机 TTFB（/api/health） | 4 ms | — |

服务器渲染一个页面只要 7 毫秒。用户体验到的延迟几乎全部来自「中国 ↔ 新加坡」的往返与出口拥塞。

### 链路慢的四个原因

1. **物理 RTT**：华南 ~30ms，华东 60~90ms，北方 80~120ms
2. **晚高峰国际出口拥塞**：20:00–24:00 丢包率可达 5~15%，TCP 吞吐断崖
3. **线路等级**：轻量新加坡走公网国际出口，**不是 CN2 GIA**
4. **带宽**：30Mbps 峰值共享 + 1024GB/月流量包

### 已做的调优

| 项 | 之前 | 之后 | 作用 |
|---|---|---|---|
| HTTP 协议 | HTTP/1.1 | **HTTP/2** | 15 个静态资源多路复用一条连接，跨境高延迟下收益最大 |
| 拥塞控制 | `cubic` | **`bbr`** | 高丢包链路上吞吐显著优于 cubic |
| 上游连接 | 每次新建 | `keepalive 32` | 省掉与 app 容器反复握手的开销 |
| gzip | Next 自己压缩（已生效） | nginx 兜底 | 防某个响应漏压缩 |

配置位置：`/etc/nginx/conf.d/chat-mini.conf`（`listen 443 ssl http2`）、`/etc/sysctl.d/99-bbr.conf`。

### 页面体积现状（真正的大头）

```
首屏 JS/CSS:  1436 KB 未压缩  /  424 KB gzip 后
HTML:         20.5 KB
script 标签:  15 个
```

`424KB` 在 30~100ms 往返的链路上仍是主要成本，且 Next 16 + React 19 + streamdown + 代码高亮本身就重。

### 进一步优化（按性价比排序）

| 方案 | 成本 | 效果 | 说明 |
|---|---|---|---|
| 应用侧减包 | 中 | ★★★ | 代码高亮改动态 `import()`（只在出现代码块时加载）、检查 lucide 图标是否按需引入 |
| 换到**香港**节点 | 中（重建实例 + 按本文档重跑） | ★★★★ | 国内→香港 RTT 30~50ms，且**香港服务器无需 ICP 备案** |
| 上 CDN | 低~中 | ★★ | 静态资源缓存到边缘。⚠️ Cloudflare 免费版对大陆常绕美国，可能更慢；EdgeOne 国际版可走香港节点，但境内节点需备案 |
| 回大陆节点 | 低 | ★★★★★ | 最快，但 `hhyapi.top` 必须做 **ICP 备案**才能解析到大陆机房 |

### 自测方法

```bash
# 1. 看丢包和 RTT（Windows）
ping 43.156.136.197

# 2. 看每跳延迟（哪一段开始劣化）
tracert 43.156.136.197

# 3. 浏览器 F12 → Network → 看 TTFB 与 Content Download
#    若 TTFB 大而下载小 → 服务端/握手问题
#    若 TTFB 小但下载慢、资源多 → 就是链路带宽与并发问题
```

> **判断是否为「晚高峰拥塞」**：分别在 15:00 和 22:00 各 ping 100 个包对比丢包率。白天正常、夜间劣化 = 国际出口拥塞，与服务器无关，换线路/换地域才有用。

---

## 16. 待办

- [ ] 填入新的 `DEEPSEEK_API_KEY` 并 `docker compose up -d`
- [ ] 重置 `admin` 密码
- [ ] 提交 `Dockerfile`（mysql2 修复）与 `.gitignore`（忽略 `.ssh-deploy/`）的改动
- [ ] 清理遗留目录：`/opt/proxy`（315M）、`/opt/WindsurfAPI`（187M）、`/opt/gpt-image-playground`（8K）
      —— 先 `docker compose down` 保数据卷，确认一周无问题后再删卷
- [ ] 清理构建缓存：`sudo docker builder prune -af`（可回收 1.2GB）
- [ ] 如需备份，配一个每日 `mysqldump` 的 cron
