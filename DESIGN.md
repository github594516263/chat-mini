# 服务端化设计：MySQL 存储 + 登录

> 状态：**P1 已实施并验证**，P2 起待做
> 最后更新：2026-11-07
> 相关代码：`src/lib/db.ts`、`scripts/schema.sql`、`scripts/selfcheck.sql`、`src/app/api/health/route.ts`

---

## 1. 为什么要做

改造前，会话和消息全部存在浏览器 `localStorage` 里。实测出来的问题：

| 问题 | 后果 |
|---|---|
| `localStorage` 约 5MB 上限，`saveStore()` 里 `catch { }` 静默吞掉写入失败 | 顶到上限后，新消息看起来发出去了，一刷新就没了 |
| 数据只活在一台机器的那个浏览器里 | 换设备、换浏览器、清缓存 = 全丢 |
| 多标签页各自整包写入，后写覆盖先写 | 两边互相踩 |
| 服务端没有历史 | 每轮都要前端把完整 `messages` 重发（token 随对话长度线性上涨） |
| 服务端没有历史 | 做不了搜索、统计、审计、RAG、内容审核 |
| 历史在客户端 | 用户可随意篡改，服务端没有权威版本 |

**生成**在上一轮已经搬到服务端（`src/lib/runs.ts`，方案 B 断线续传），这次要搬的是**状态**。

---

## 2. 目标 / 非目标

### 目标

1. 会话与消息入库，跨设备、跨浏览器可见，容量不再受 5MB 限制
2. 服务端持有历史，生成时服务端自己取历史拼 prompt（前端不再上传整包）
3. 有登录：多用户隔离，别人看不到别人的对话
4. 服务端能查询：会话搜索（标题 + 正文全文检索）

### 非目标（本轮明确不做）

- 邮箱/短信验证、找回密码（忘记密码只能管理员重置）
- 第三方登录（GitHub / 微信）——将来可选
- 附件、多模态、语音
- 跨实例部署（单机 MySQL 足够；要扩容时把数据访问层换成 Postgres）

### 一条必须写清楚的天花板

> **MySQL 存不下"正在跑的 DeepSeek 响应"。**
> 上游 SSE 连接一旦断开（进程重启、崩溃），那条流就真的没了。
> 所以"run 落库"的价值不是完美续传，而是：**重启后知道哪些回答没写完 → 自动标成"生成中断" → 提供"继续生成"按钮**。
> 进程不重启时的刷新续传，仍由内存 run 表 + seq 缓冲负责（已验证）。

---

## 3. 已确认的决策（决策记录）

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| D1 | 注册接口保留但**默认关闭**（`ALLOW_REGISTER=false`，关闭时返回 403） | 全开放注册 / 删掉接口 | 个人站，别人进来不该能注册；代码保留，将来开一个环境变量即可 |
| D2 | 登录名用**用户名**，不用邮箱 | 邮箱 + 验证邮件 | 邮箱会引入 SMTP、验证链接、找回密码一整套 |
| D3 | **游客模式 B**：未登录也能聊，但数据只在浏览器；登录后看的是自己账号的数据 | A 强制登录 / B+合并本地会话 | 首次进来就能用；明确**不做**本地数据迁移合并，省掉一堆冲突处理 |
| D4 | 数据库用 **MySQL**（放弃 SQLite / Postgres） | SQLite 单文件 | 本机已有 MySQL 9.4；顺便作为学习目标。代价是要多一个常驻服务，见 §11 |
| D5 | 模型目录写在 `src/lib/models.ts`，客户端只传公开 id | 数据库动态目录 / 前端写死模型名 | 现在 4 家 7 条，代码即配置；upstream、base URL、key 全在服务端。详见 [docs/model-switcher.md](docs/model-switcher.md) |

---

## 4. 架构总览

```
浏览器                          Next.js (Node runtime)              MySQL 9.4
┌─────────────────┐            ┌──────────────────────┐           ┌──────────────┐
│ 页面 / 组件      │  fetch     │ /api/auth/*          │           │ users        │
│ use-chat        │ ─────────► │ /api/sessions*       │  mysql2   │ auth_sessions│
│ （服务端为真相） │            │ /api/chat            │ ────────► │ chat_sessions│
│                 │            │ /api/health          │  连接池   │ messages     │
│ localStorage    │ ◄───────── │                      │           │ runs         │
│ = 只读缓存      │   NDJSON   │ runs.ts（内存事件缓冲）│           │              │
└─────────────────┘            └──────────┬───────────┘           └──────────────┘
                                          │ SSE (stream:true)
                                          ▼
                                 OpenAI 兼容网关 /chat/completions
                                 （DeepSeek / 星链 / DevPoolAi / 肥猫005，
                                   由 models.ts 决定这次打哪家）
```

三层职责：

- **持久层（MySQL）**：会话、消息、账号、登录会话、run 元信息
- **运行时层（进程内存 `runs.ts`）**：正在生成的事件缓冲 + seq 水位（不逐条落库，见 §8）
- **协议层（NDJSON 自定义事件）**：`delta / think_delta / usage / completed / error / sync`

---

## 5. 数据模型

### 命名约定

| 表 | 含义 | 备注 |
|---|---|---|
| `users` | 账号 | |
| `auth_sessions` | **登录**会话（一次登录 = 一行 = 一个 cookie） | 与下者刻意区分命名 |
| `chat_sessions` | **聊天**会话（一个对话框） | 原设计叫 `sessions`，加登录后改名避免歧义 |
| `messages` | 消息 | |
| `runs` | 生成任务元信息 | 事件明细不入库 |

时间统一 `DATETIME(3)`（毫秒精度，前端 `Date.now()` 对得上）。

### users

```
id            CHAR(36)     PK
username      VARCHAR(32)  UNIQUE NOT NULL      登录名，存小写
display_name  VARCHAR(64)  NOT NULL DEFAULT ''
password_hash VARCHAR(255) NOT NULL             scrypt$N$r$p$salt$hash
created_at    DATETIME(3)  NOT NULL
last_login_at DATETIME(3)  NULL
disabled      TINYINT(1)   DEFAULT 0            封禁用，不删数据
```

### auth_sessions

```
id           CHAR(36)     PK
user_id      CHAR(36)     FK→users ON DELETE CASCADE
token_hash   CHAR(64)     UNIQUE NOT NULL       sha256(cookie 原始 token)，库里不存明文
created_at   DATETIME(3)
expires_at   DATETIME(3)  NOT NULL
last_seen_at DATETIME(3)
user_agent   VARCHAR(255)                      用于"已登录设备"列表
ip           VARCHAR(45)                       IPv6 也放得下
INDEX (user_id, expires_at)
```

### chat_sessions

```
id         CHAR(36)     PK
user_id    CHAR(36)     FK→users ON DELETE CASCADE    数据隔离的主键条件
title      VARCHAR(120) NOT NULL DEFAULT '新对话'
created_at DATETIME(3)
updated_at DATETIME(3)
deleted_at DATETIME(3)  NULL    软删除：误删可救，也不连带删消息
INDEX (user_id, deleted_at, updated_at DESC)          ← 列表查询一条索引走完
```

### messages

```
id                CHAR(36)   PK
session_id        CHAR(36)   FK→chat_sessions ON DELETE CASCADE
seq               INT        NOT NULL     会话内顺序号 1,2,3…
role              ENUM('user','assistant','system')
content           MEDIUMTEXT NOT NULL
thinking          MEDIUMTEXT NULL         思维链单独一列，便于折叠与不计入正文
prompt_tokens     INT NULL
completion_tokens INT NULL
status            ENUM('streaming','complete','interrupted','stopped','error')
error_text        VARCHAR(500) NULL
run_id            VARCHAR(24)  NULL
created_at / updated_at DATETIME(3)
UNIQUE (session_id, seq)
INDEX (session_id, seq)
FULLTEXT (content) WITH PARSER ngram     中文搜索用 MySQL 内置 ngram 分词
```

**三个刻意的选择**

1. **用 `seq` 排序，不用 `created_at`**：同一毫秒写入的两条消息时间戳拉不开顺序，序号可以。它和流式协议里的 `seq` 是同一个思想。
2. **`MEDIUMTEXT` 而不是 `TEXT`**：`TEXT` 上限 64KB，`utf8mb4` 下每字符最多 4 字节 → 约 1.6 万字符。一篇 2000 词英文作文 + Markdown 很容易逼近。
3. **状态收敛成枚举**：改造前有 `pending / stopped / interrupted / error` 四个布尔，组合出没人验证过的状态；现在一个 `status` 五值，前端一个 `switch` 就够。

### runs

```
id         VARCHAR(24) PK
user_id    CHAR(36)    NULL     游客的 run 没有归属
session_id CHAR(36)    NULL
message_id CHAR(36)    NULL
status     ENUM('running','done','error','aborted')
created_at / updated_at DATETIME(3)
INDEX (status, updated_at)
INDEX (session_id)
```

**启动清理**：服务启动时把 `status='running'` 的行对应的消息标成 `interrupted` —— 这是"进程重启后自动降级"的落地方式。

---

## 6. 认证设计

### 方案选型

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **Cookie + 服务端会话表** | 可立即撤销（登出/改密/踢设备）；token 不给 JS 读（防 XSS 偷）；实现直白 | 每次请求查一次库（走唯一索引，亚毫秒） | ✅ 采用 |
| JWT | 无状态，不查库 | 登出无法真正失效；需要黑名单才能撤销；存 localStorage 会被 XSS 偷 | ❌ |
| 第三方 OAuth | 不管密码 | 要外部应用注册 + 回调域名，本地开发麻烦 | 将来可选 |

### 密码存储

```
格式（单字段）：scrypt$65536$8$1$<salt_base64>$<hash_base64>
                算法    N   r p   16字节随机盐      64字节派生密钥
```

四条硬规则：

1. 绝不明文；绝不用裸 SHA-256/MD5（GPU 一秒几十亿次，等于没加密）
2. 每个用户独立随机盐（`crypto.randomBytes(16)`）
3. 用 Node 内置 `node:crypto` 的 scrypt，不引第三方包
4. **用异步 `crypto.scrypt`，不用 `scryptSync`** —— 同步版会阻塞事件循环 ~160ms，而本项目同一进程正在流式生成，一堵所有正在看的流都会卡。这是本项目特有的理由。

本机实测（决定参数）：

```
N=16384  r=8 p=1 →  40 ms / 16 MB
N=65536  r=8 p=1 → 158 ms / 64 MB      ← 采用（每次登录付一次）
N=131072 r=8 p=1 → 310 ms / 128 MB     OWASP 推荐档位，可调
```

校验用 `crypto.timingSafeEqual` 比较（防时序侧信道）；登录失败统一返回「用户名或密码错误」，不区分"用户不存在"与"密码错"。

### 登录令牌

```
① token = crypto.randomBytes(32).toString("base64url")     // 43 字符
② cookie 放原始 token
③ 库里只存 sha256(token)                                   ← 库泄露也不能直接当 cookie 用
④ 每次请求：sha256(cookie) 查 auth_sessions，检查 expires_at
```

cookie 属性：

| 属性 | 值 | 原因 |
|---|---|---|
| `HttpOnly` | 开 | JS 读不到 → XSS 偷不走 |
| `SameSite` | `Lax` | 挡住绝大多数 CSRF |
| `Secure` | 生产开 / 本地关 | 本地是 `http://localhost`，开了浏览器不存 |
| `Max-Age` | 7 天（滑动续期） | 活跃一次顺延 |

### 其他防护

| 威胁 | 措施 |
|---|---|
| CSRF | SameSite=Lax + 写操作必须 `Content-Type: application/json` + 校验 `Origin` |
| 用户枚举 | 登录失败措辞统一 |
| 暴力破解 | 同一 username+IP 连错 5 次锁 5 分钟（内存计数，单实例够） |
| 越权读 | 所有查询强制带 `user_id`；越权返回 **404**（403 等于承认资源存在） |
| SQL 注入 | 全部 `?` 预处理语句，不拼字符串；应用账号无 DDL 权限 |
| 会话堆积 | 过期行定期删除（启动时 + 每小时）；支持"踢掉某设备" |

---

## 7. 游客模式（决策 D3）

```
游客：  POST /api/chat   body = { messages: [...] }     服务端只跑生成，不写库
        → 会话与消息存浏览器 localStorage
        → 刷新续传靠 runId + afterSeq（不落库，进程重启即丢）

登录：  POST /api/chat   body = { sessionId, content }   服务端取历史 + 写库
        → 前端不持有权威数据，只做缓存
```

**同一端点两种 body 语义**是刻意的取舍：游客不留任何服务端痕迹，登录后也**不合并**游客历史。代价是端点实现要分支，收益是不用写"本地会话 → 账号"的合并与冲突逻辑。

---

## 8. 写路径与事务边界

### 发一条消息（登录用户）

```sql
-- ① 建会话（仅首条消息时需要）
BEGIN;
  INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at) ...;
  INSERT INTO messages (id, session_id, seq=1, role='user', content=?, status='complete') ...;
  INSERT INTO messages (id, session_id, seq=2, role='assistant', content='', status='streaming', run_id=?) ...;
  INSERT INTO runs (id, user_id, session_id, message_id, status='running') ...;
COMMIT;

-- ② 生成（进程内存，事件不逐条写库）

-- ③ 流式期间：每 ~1 秒 UPDATE 一次半截正文
UPDATE messages SET content = ?, updated_at = ? WHERE id = ?;

-- ④ 结束
BEGIN;
  UPDATE messages SET content=?, thinking=?, prompt_tokens=?, completion_tokens=?,
         status='complete', run_id=NULL, updated_at=? WHERE id = ?;
  UPDATE runs SET status='done', updated_at=? WHERE id = ?;
COMMIT;
```

**为什么 delta 不逐条写库**：一次长回答可能 800+ 个 delta，逐条 INSERT 是每秒几百次写——MySQL 扛得住但没意义。落盘的是"1 秒粒度的正文快照"，用来兜崩溃；逐字续传由内存事件缓冲负责。

### 事务必须走同一个连接

`db.ts` 的 `withTransaction()` 传下 `conn`，事务内**必须**用 `conn.query`，用模块级 `query()` 会从池里另取连接、跑在事务外面。这条写在代码注释里。

---

## 9. API 契约

```
# 认证
POST   /api/auth/register   { username, password }   ALLOW_REGISTER=false 时 403
POST   /api/auth/login      { username, password }   → Set-Cookie
POST   /api/auth/logout                              删行 + 清 cookie
GET    /api/auth/me                                  → { id, username, displayName } | 401
GET    /api/auth/sessions                            已登录设备
DELETE /api/auth/sessions/:id                        踢掉某设备

# 会话
GET    /api/sessions?limit=50&cursor=<updated_at>    列表（游标分页，不用 offset）
POST   /api/sessions                                 新建
PATCH  /api/sessions/:id      { title }              改名
DELETE /api/sessions/:id                             软删除

# 消息
GET    /api/sessions/:id/messages[?afterSeq=N]       历史 / 增量
GET    /api/sessions/search?q=断线                   标题 + 正文（ngram FULLTEXT）

# 生成
POST   /api/chat                                      游客 { messages } / 登录 { sessionId, content }
GET    /api/chat/stream?runId=&afterSeq=              订阅（回放 + 实时）
POST   /api/chat/cancel                               { runId }

# 运维
GET    /api/health                                   不需要登录（出问题时也要能看原因）
```

**为什么列表用游标而不是 `offset`**：翻到第 10 页时数据库要扫前 500 行再丢掉，越翻越慢；游标（从上次最后一条的 `updated_at` 往后取）永远只走索引。

---

## 10. 前端职责变化

| | 改造前 | 改造后 |
|---|---|---|
| 真相来源 | `localStorage` | **MySQL**（经 API） |
| `localStorage` | 全部数据 | 只留主题偏好 + 列表/消息**只读缓存**（首屏不闪） |
| 发送 | 前端拼完整 history 上传 | 只传 `sessionId + 文本` |
| 多标签 | 互相覆盖 | `visibilitychange` 时按 `updated_at` 拉增量 |
| 写入 | 直接落盘 | 乐观更新 + 服务端确认 + 失败回滚 |

`use-chat.ts` 的**对外接口不变**（`send / stop / regenerate / editAndResend / continueGeneration / newSession`），只换内部实现，组件层零改动。

---

## 11. 运维与代价

| 项 | 说明 |
|---|---|
| 依赖 | 多一个常驻服务：`net start MySQL94`（没起来站点直接报错，`/api/health` 会给出中文诊断） |
| 账号 | 应用用 `chat_app`，只有 `SELECT/INSERT/UPDATE/DELETE ON chat_mini.*`；建表用 root 跑 `scripts/schema.sql` |
| 备份 | `mysqldump chat_mini > backup.sql` |
| 时区 | 连接池 `timezone: "Z"`，**业务代码禁止 `NOW()`**，时间一律从 JS 传 `new Date()` |
| 连接池 | 挂 `globalThis`，否则 dev 热重载会不断新建池吃满连接数 |

---

## 12. 实施阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | 建库建表 + 连接层 + 健康检查 | ✅ **已完成** |
| **P2** | 注册/登录/登出/me + `/login` 页面 + 命令行建号脚本 | ✅ **已完成** |
| **P3** | 会话/消息 CRUD（带 `user_id` 隔离）+ 搜索 | ✅ **已完成** |
| **P4** | 生成端改造（服务端取历史 + 秒级落盘 + 启动清理 running） | ✅ **已完成** |
| **P5** | 前端接入（服务端为真相 + 本地缓存降级） | ✅ **已完成** |
| P6 | 回归 7 个 e2e + 新增认证/越权/重启 3 个 | 待做 |

### P2 验收证据

```
node scripts/e2e-auth.mjs → 16/16 通过

✅ 注册默认关闭（403）
✅ 未登录 me → 401
✅ 密码错 → 401「用户名或密码错误」
✅ 用户不存在与密码错返回同一句（防枚举）
✅ 正确登录 → 200
✅ Set-Cookie: Path=/; Expires=…; HttpOnly; SameSite=lax（本地无 Secure）
✅ 登录后 me → 200 {"username":"demo"}
✅ 跨站 Origin → 403
✅ 表单 Content-Type → 400
✅ 登出 → 200，之后 me → 401
✅ 连错 5 次后锁定：401,401,401,401,401,429
✅ 锁定期内仍 429（"请 300 秒后再试"）

直接查库验证（不是看代码猜）：
✅ 按 sha256(token) 能查到登录会话
✅ 按原始 token 查不到（库里不存明文令牌）
✅ token_hash 列长度 64（sha256 hex）
✅ password_hash = scrypt$65536$8$1$…（130 字符，不含明文密码）
✅ 登出后 auth_sessions 行被删除
```

浏览器端（CDP 实测）：

```
游客首页 header   → 新对话 | 登录 | deepseek-chat   输入框可用（游客能聊）
登录页            → 用户名/密码两个输入框 + 登录按钮 + "本实例未开放注册"
登录后首页 header → 新对话 | demo | deepseek-chat   有登出按钮
已登录访问 /login → 自动跳回 /                     ✅
点登出            → 顶栏变回"登录"入口
```

回归：`e2e-chat` 9 步、`e2e-actions` 5 步全部通过——游客链路没被登录改造破坏。

### P3 验收证据

```
node scripts/e2e-sessions-api.mjs → 23/23 通过

隔离（两个账号互相看不到、改不了、删不了）
✅ 未登录访问 /api/sessions → 401
✅ A 的列表里没有 demo2 的会话
✅ B 的列表里没有 demo 的会话
✅ B 读 A 的会话 → 404（不是 403，不泄露 id 是否存在）
✅ B 读 A 的消息 → 404
✅ B 改 A 的标题 → 404
✅ B 删 A 的会话 → 404
✅ 越权操作后 A 的会话原样还在

读取
✅ 消息按 seq 升序
✅ afterSeq=2 只返回 seq 3、4
✅ 列表按 updatedAt 倒序
✅ 游标分页两页不重复（limit=2：第一页 2 条 / 第二页 1 条 / 重复 0）

写入
✅ 新建会话 → 201
✅ 改名 → 200 且标题变了
✅ 空标题 → 400
✅ 删除 → 200，之后 GET → 404，列表里消失

搜索
✅ 标题命中（LIKE）
✅ 正文命中（ngram 全文索引，中文"服务端"直接命中）
✅ 命中带上下文片段
✅ A 搜不到 B 的私密内容（搜索同样按 user_id 隔离）
```

直接查库：

```
username  会话数  其中软删除  消息数
demo         4        1         8
demo2        1        0         2

软删除的会话仍在库里（deleted_at 有值，title='改名后的会话'）——数据没被真删
```

### P4 验收证据

```
node scripts/e2e-chat-server.mjs → 21/21 通过

生成与落库
✅ 登录用户 POST /api/chat → 200 mode=server
✅ 返回用户消息 seq=1、助手占位 seq=2 status=streaming
✅ 会话标题按首条消息自动生成
✅ 订阅拿到完整事件流（108 个事件，末事件 completed）
✅ 落库内容与流式内容一字不差（库里 188 字 / 流里 188 字）
✅ 定稿状态 complete、run_id 清空、用量落库（prompt=12 completion=105）
✅ runs 表状态 done

不订阅也在生成（证明生成不挂在连接上）
✅ 1.6 秒后库里已有半截正文且 status=streaming
✅ 取消 → cancelled=true，1.5 秒后 status=stopped 且保留 251 字
✅ runs 表状态 aborted

隔离与游客
✅ B 用 A 的 sessionId 生成 → 404
✅ 游客 POST（messages 数组）→ 200 mode=guest
✅ 游客生成不写库（22 → 22 条）
✅ 缺 sessionId 时降级为游客路径，不报错

进程重启自动降级（手工演练）
重启前：msg-crash-ai status=streaming（残留 14 字），run status=running
重启后：msg-crash-ai status=interrupted（14 字保留），run status=error
dev 日志：[startup] 清理上次残留：4 条消息标为生成中断，1 个 run 标为 error
            ↑ 其中 3 条是调 bug 期间留下的真孤儿，说明孤儿路径也覆盖到了
```

回归：`e2e-auth` 16/16、`e2e-sessions-api` 23/23、`e2e-chat`（游客）9 步、`e2e-resume` 断线续传全部通过。

### P5 验收证据

浏览器里真实点击（`node scripts/e2e-logged-in.mjs`，用 CDP 驱动无头 Chrome）：

```
19/19 通过

服务端真的是真相
✅ 登录成功并跳到聊天页
✅ 侧栏显示服务端的会话（库里 9 个）
✅ 发送后进入生成状态 → 生成正常结束 → 页面上有一问一答
✅ 刷新后消息仍在（刷新前 144 字 / 刷新后 144 字）
✅ 清空 localStorage 后刷新仍能读回（说明不是本地缓存撑着的）
✅ 直接查库：一问一答、status=complete

四个消息操作在服务端也成立
✅ 重新生成后仍是一问一答（没有多出一条）
✅ 编辑重发后仍是一问一答且内容已换
✅ 停止后正文不再增长，刷新后内容保留（433 字）
✅ 用户主动停止不显示「继续生成」（那是 interrupted 的语义）
✅ 模拟崩溃（库里改成 interrupted）后刷新：出现「继续生成」
✅ 继续生成把内容接长：450 → 2034 字，条数 4 → 4（还是同一条）

会话管理
✅ 改名 → 刷新后仍是新名字
✅ 删除 → 库里软删除（10 → 9），刷新后侧栏不再出现
```

游客模式零回归（同一个浏览器换成全新 profile 跑）：

```
✅ e2e-chat        9 步：空态/发送/流式增长/新对话/切回/刷新/删除
✅ e2e-actions     5 步：重新生成/编辑重发/复制/刷新后按钮仍在
✅ e2e-resume      8 步：刷新续传 1012→2305→3393、停止、run 过期降级、
                          继续生成 31→960、回放 209 事件
✅ e2e-theme       三态主题（浅色/深色/跟随系统）
```

一个真 bug（回归测试抓到的）：`resumeRun` 里我把"按 `baseLen` 砍回前缀"写成了无条件执行。
游客消息没有 `baseLen`，于是刷新续传时正文被砍成 0，`e2e-resume` 第 6 步立刻从"正文 31 字 + 有继续按钮"退化成"正文 0 字 + 没有按钮"。改成按模式分支后恢复。

### P1 验收证据

```
/api/health → HTTP 200
{ ok: true, db: { connected: true, version: "9.4.0", database: "chat_mini", tables: 5 } }

scripts/selfcheck.sql:
  1. 5 张表存在
  2. 中文注释正常（UTF-8）
  3. 插入/读取 seq 1,2 正常
  4. ngram 中文检索：搜「服务端」命中 ✅
  5. 级联删除：删用户 → 会话/消息归零
  6. 唯一约束 (session_id, seq)：重复插入 → ERROR 1062 ✅
  7. 清理后 5 张表全部 0 行

权限越界自检：CREATE TABLE → ERROR 1142 CREATE command denied ✅
```

---

## 13. 风险与回退

| 风险 | 应对 |
|---|---|
| MySQL 没起来 → 站点打不开 | `/api/health` 明确中文诊断；README 写 `net start MySQL94` |
| 前端改造面大（`use-chat.ts` 489 行） | 对外接口不变，只换内部；逐阶段灰度 |
| 流式落盘频繁写 | 1 秒节流，内容未变不写 |
| 忘记密码 | 管理员用 `scripts/create-user.mjs --reset` 重置，无自助找回 |
| 想换 Postgres | SQL 全部收在 `db.ts` 之上的一层；方言差异（自增、`ON DUPLICATE KEY`）集中处理 |

---

## 14. 已知坑（实施时踩到的）

1. **InnoDB 全文索引只在事务提交时更新**：未提交事务里 `MATCH ... AGAINST` 搜不到刚插入的行。验证必须在 `COMMIT` 之后。
2. **`mysql2` 的 `ExecuteValues` 类型不接受 `unknown[]`**：参数类型要写成具体联合（`string | number | Date | null | Buffer …`），`undefined` 会让预处理语句参数数量不匹配，用 `null`。
3. **PowerShell 控制台的 UTF-8 显示**：中文注释显示乱码可能只是控制台编码，查库里实际字节再下结论。
4. **`cookies()` 在 Server Component 里只能读不能写**：写 cookie 会抛错。所以滑动续期只在路由处理器里做（`getCurrentUser({ renew: true })` 只在 `/api/auth/me` 调用），Server Component 里只更新 `last_seen_at`。
5. **非交互式输入要按行缓冲**：`scripts/create-user.mjs` 从管道读两行密码时，一次 `data` 事件可能同时带来两行；每条读取各挂监听器会吞掉第二行。改用行队列后正常。
6. **静态路由优先于动态段**：`/api/sessions/search` 与 `/api/sessions/[id]` 并存时，Next 会先匹配静态的 `search`，不会把它当成一个 id。所以搜索接口可以直接放在同一层级，不用挪到 `/api/search`。
7. **`UPDATE ... JOIN` 的 `SET` 列必须带表别名**：`messages` 和 `chat_sessions` 都有 `updated_at`，写成 `SET content = ?, updated_at = ?` 会报 `ER_NON_UNIQ_ERROR: Column 'updated_at' in field list is ambiguous`。必须写 `SET m.content = ?, m.updated_at = ?`。这个 bug 当时被 `catch {}` 吞掉了，表现是"生成正常但库里一直是空的"，所以**落盘失败一定要打日志**，静默 catch 会让排查成本翻十倍。
8. **上游 provider 被 abort 时可能"正常结束"**（生成器 `return` 而不是 `throw`）。只靠 `catch` 判断用户是否点了停止会把它记成 `complete`。必须以 `run.abort.signal.aborted` 为准。
9. **两种模式的续传起点不一样，不能共享一行代码**：服务端消息在库里是"前缀 + 已输出"，run 事件只有本次输出 → 必须先砍回 `baseLen` 再 `seq=0` 重放；游客正文和 `appliedSeq` 都在本地 → 必须用**已经**存下的水位接着放，绝不能砍。这一天踩过一次（见 P5 证据末尾）。
10. **不要用 PowerShell 的 `Get-Content`/`Set-Content` 改中文源码**：Windows PowerShell 按 GBK 读 UTF-8，写回去就变成乱码，还会吃掉行内换行。改代码一律用编辑工具；要用脚本处理也必须显式 `readFileSync(..., "utf8")`。

---

## 15. 将来可能做

- 登录设备管理 UI（踢设备）已有后端支持
- 会话全文搜索高亮、按时间范围过滤
- 消息编辑历史（当前是覆盖）
- 生成任务落盘策略升级：把压缩后的快照写库，实现跨重启的近似续传
- 数据导出（Markdown / JSON）
