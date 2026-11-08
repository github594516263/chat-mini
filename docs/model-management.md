# 账户级模型管理：从截图到 chat-mini 实现

> 目标：做一个「配置了哪些模型，就只显示哪些模型」的模型管理页，并且配置跟登录账户绑定。
>
> 本文按**实现后的状态**整理：先拆截图和参考项目，再落到 chat-mini 的库表、接口、页面与安全边界。
> 代码位置：`scripts/schema.sql`、`src/lib/model-crypto.ts`、`src/lib/model-config.ts`、
> `src/app/api/models/*`、`src/components/models-settings.tsx`。

---

## 1. 需求边界

这里的「账户」指 **chat-mini 自己的登录账号**，不是 DeepSeek 官方 OAuth 账号。

三条硬要求：

1. **归属**：provider 和 model 都有 `user_id`，A 用户配置的模型 B 用户看不到、改不了。
2. **可用性**：登录用户只看到自己配置且启用的模型；没配置就是空状态，不偷偷混入系统目录。
3. **密钥**：API Key 属于账户，服务端加密存储，前端永远拿不到明文。

已确认的产品决策：

| 决策 | 结论 |
| --- | --- |
| 配置粒度 | 每个 chat-mini 用户各自一份 |
| 零配置行为 | 空状态 + 显式「没有可用自定义模型时，使用系统默认模型」开关 |
| 系统默认来源 | 服务器环境变量里的 `DEEPSEEK_*` / 其他 `*_API_KEY` 目录 |
| 自建 provider 的地址 | 默认拒绝 localhost / 内网 / 链路本地地址（防 SSRF） |
| 第一版范围 | provider / model CRUD + 测试连接 / 发现；推理档位、图片输入、OAuth 放 P4b |

---

## 2. 截图拆解

截图里的页面不是「模型切换器」，而是**模型配置中心**：

```
设置
├─ 账号与余额
├─ 通用设置
├─ 模型                    ← 当前
│  ├─ DeepSeek 账号（已登录）
│  ├─ DeepSeek
│  ├─ 星链（自定义）        ← 展开
│  │  ├─ API 密钥
│  │  ├─ 显示名称
│  │  ├─ API 地址
│  │  ├─ API 协议
│  │  └─ 模型目录
│  │     ├─ 模型 ID
│  │     ├─ 显示名称
│  │     ├─ 上下文窗口
│  │     ├─ 最大输出 token
│  │     ├─ 输入类型
│  │     └─ 推理等级（P4）
│  └─ 添加模型提供商
├─ 记忆与进化
└─ 关于
```

几个容易做错的点：

- **provider 行不是模型行**：一家 provider 下可以有多个模型，composer 里显示的是模型。
- **密钥只写不读**：编辑已有 provider 时，密钥框显示「已保存 •••• 1234，留空不修改」，不是把明文填回去。
- **状态要能解释**：已配置 / 缺密钥 / 没有模型 / 已停用。只画一个绿点不够。
- **空状态要有出口**：没有模型时，composer 的模型按钮应该变成「配置模型」，点了直接落到设置页，而不是给一个空下拉框。

---

## 3. 参考实现对照

### 3.1 DeepSeek Harness（DSH）

DSH 的模型设置是「provider 列表 → 展开卡片 → 模型目录」的结构：

- provider 行展示名称、账号/密钥状态、模型数量；
- 展开后编辑 API 密钥、显示名称、API 地址、API 协议；
- 模型目录逐行编辑模型 ID、显示名、上下文窗口、最大输出 token、输入类型；
- 自定义 API 还带推理等级，每档映射一个请求参数值；
- 密钥在桌面端存本地，由主进程持有，渲染进程只拿「有没有配」。

**可借鉴**：provider / model 两级信息架构、展开式编辑、状态可解释、密钥不出主进程。
**不照搬**：DSH 是单机桌面应用，没有多用户隔离；chat-mini 需要把「本地凭据」换成「按 user_id 加密存库」。

### 3.2 其他项目的常见做法

| 项目 | 做法 | 对 chat-mini 的启示 |
| --- | --- | --- |
| Open WebUI | 管理员配全局模型，用户可覆盖部分参数 | 适合团队，不适合「每人一份私有 key」 |
| LobeChat | provider 列表 + 模型开关，密钥存设置 | 交互接近截图，但默认单用户 |
| Vercel AI Chatbot | 模型主要是代码/环境变量里的静态目录 | 简单、类型安全，但没有用户自建 |
| chat-mini 现状 | `src/lib/models.ts` 静态目录 + env 凭据 | 游客够用，登录用户无法自建 |

结论：**保留静态目录给游客/系统兜底，新增一套账户级动态目录给登录用户**。两套目录不要混在一起。

---

## 4. 数据模型

四张表，全部按 `user_id` 隔离。完整 DDL 见 `scripts/schema.sql`。

### 4.1 `model_providers`

一家 provider 一行：

- `id CHAR(36)`：公开 id（UUID），客户端只认这个；
- `user_id`：归属；
- `name`：用户可见名称，`(user_id, name)` 唯一；
- `protocol`：第一版只有 `openai-chat`；
- `base_url`：服务端 fetch 的地址，写入前做 URL 与 SSRF 校验；
- `auth_type`：`api_key` / `none`（`oauth` 预留给 P4）；
- `enabled`、`sort_order`、`revision`；
- `revision` 用于乐观并发：设置页保存时带上读到的版本，旧版本返回 409。

### 4.2 `model_credentials`

密钥单独一张表，`provider_id` 主键：

- `secret_cipher VARBINARY(4096)`、`iv VARBINARY(12)`、`tag VARBINARY(16)`；
- `key_version` 预留给密钥轮换；
- `last4` 只用于「已保存 •••• 1234」；
- 外键级联删除：删 provider 自动删凭据。

### 4.3 `models`

一个模型一行：

- `provider_id` + `model_key` 唯一；
- `model_key` 是真正发给上游的模型名，`display_name` 只影响界面；
- `context_window`、`max_output_tokens` 可空；
- `input_modalities` 默认 `["text"]`，P4 再支持 image；
- `reasoning_levels`、`default_reasoning` 预留 P4；
- `enabled` 控制是否出现在 composer；
- `source`：`manual` / `discovered` / `seed`。

### 4.4 `user_model_preferences`

- `default_model_id`：用户偏好的默认模型，删除模型时 `SET NULL`；
- `use_system_models`：**显式**回退开关，默认 0；
- 一行一个用户。

> 为什么不用一个 JSON 列存全部配置？
> 因为需要按 provider 做唯一约束、按 user 查询、乐观并发、级联删除和密钥分表。
> JSON 列写起来快，但后面每个需求都要在应用层补约束。

---

## 5. 服务端解析链路

### 5.1 目录生成

`getUserModelCatalog(userId)`：

1. 查该用户的 provider / model / preference；
2. 只保留 `provider.enabled && provider.status === "live"` 的分组；
3. 只保留 `model.enabled` 的模型；
4. 有可用自定义模型 → `origin: "user"`；
5. 没有自定义模型，但 `use_system_models=1` → 返回系统目录，`origin: "system"`；
6. 否则 → `groups: []`、`origin: "none"`。

`status === "live"` 的条件：

- provider 已启用；
- `auth_type=api_key` 时必须有凭据；
- 至少有一个启用的模型。

### 5.2 请求解析

`resolveModelForUser(userId, requestedId)`：

- 有 `requestedId`：先按 `(model.id, user_id)` 查自定义模型；查不到且用户确实没有可用自定义模型、并显式开了系统兜底，才查系统目录；
- 没有 `requestedId`：用目录的 `defaultId`，再按 `origin` 决定走自定义还是系统；
- 返回的 `ResolvedModel` 只包含服务端路由需要的字段：上游模型名、base URL、解密后的 key、max tokens。

客户端永远只传 `model`（模型行 UUID 或系统目录 id），**不传 baseURL / upstream / key**。

### 5.3 游客

游客不查这四张表，继续用 `getModelCatalog()` 的静态目录 + 环境变量。
游客的 localStorage key 仍是 `chat-mini/model/v1/guest`；登录用户按 `user.id` 分 key。

### 5.4 测试连接 / 发现

`POST /api/models/providers/[id]/discover`：

1. 重新校验数据库里的 `base_url`，解密凭据；
2. 把 base URL 补成 `/models`（已经以 `/models` 或 `/chat/completions` 结尾时不重复拼）；
3. 用 `Authorization: Bearer <key>` 请求，禁止跟随跳转，12 秒超时，响应上限 2MB；
4. 兼容 `{ data: [...] }` 和裸数组，提取 `id`、`name`、`context_window`、`max_output_tokens`、`input_modalities`；
5. 只把模型列表和延迟返回给前端，不返回密钥。

新建表单里的「测试连接」走 `POST /api/models/providers/test`，复用同一段 fetch 逻辑，但不落库、不保存密钥。

`POST /api/models/providers/[id]/models/import`：

- 接受 `models: [{ modelKey, displayName?, contextWindow?, maxOutputTokens?, inputModalities? }]`；
- 已存在的 `model_key` 跳过，不覆盖用户改过的显示名/参数；
- 新模型写 `source='discovered'`，并在用户还没有默认模型时设为默认；
- 单次最多 200 个，事务内插入。

---

## 6. 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/models/providers` | 设置页：provider 列表 + 模型 + 脱敏凭据状态 |
| POST | `/api/models/providers` | 新建 provider，可同时写密钥 |
| POST | `/api/models/providers/test` | 新建前测试连接，不落库、不保存密钥 |
| PATCH | `/api/models/providers/[id]` | 改名 / 改地址 / 改密钥 / 启停；`apiKey` 空 = 不改 |
| DELETE | `/api/models/providers/[id]` | 级联删除模型和凭据 |
| POST | `/api/models/providers/[id]/discover` | 测试连接 + 拉取上游 `/models` |
| POST | `/api/models/providers/[id]/models` | 添加模型 |
| POST | `/api/models/providers/[id]/models/import` | 批量导入发现结果 |
| PATCH | `/api/models/[id]` | 修改模型 |
| DELETE | `/api/models/[id]` | 删除模型 |
| PUT | `/api/models/preferences` | 切换「使用系统默认模型」 |
| GET | `/api/models/catalog` | 当前用户可用目录（调试/刷新用） |

所有写接口都：

- `requireUser()`，未登录 401；
- `isSameOrigin()`，跨站 403；
- 目标不存在或不属于当前用户统一 404，不区分「不存在」和「不是你的」。

响应里没有 `secret_cipher`、没有明文 key，只有 `hasKey` / `keyLast4`。

---

## 7. 安全

### 7.1 密钥加密

`src/lib/model-crypto.ts`：

- AES-256-GCM；
- 密钥来自 `MODEL_SECRET_KEY`，必须是 32 字节 base64；
- 每次写入随机 12 字节 IV；
- AAD 绑定 `userId + providerId`，把 A 的密文搬到 B 的记录上解不开；
- `key_version=1` 预留轮换；
- 解密只发生在真正发请求前，设置页永远不解密。

**运维注意**：换掉 `MODEL_SECRET_KEY` 会导致旧密钥无法解密，需要让用户重填。

### 7.2 SSRF

用户填的 `base_url` 是服务端 fetch 的目标，默认拒绝：

- `localhost`、`*.localhost`、`*.local`、`*.internal`；
- IPv4：`0.0.0.0/8`、`10/8`、`127/8`、`169.254/16`、`172.16/12`、`192.168/16`、`100.64/10`、`198.18/15`、组播/保留段；
- IPv6：`::`、`::1`、`fc00::/7`、`fe80::/10`、IPv4-mapped（`::ffff:...`）。

本地网关确实需要连时，显式设置：

```bash
ALLOW_PRIVATE_MODEL_ENDPOINTS=true
```

注意：第一版只做字面地址校验。域名解析到内网的 DNS rebinding，需要在后续的「连接测试 / 模型发现」里做「解析后校验 + 固定 IP」。
发现接口在发请求前会重新校验数据库里的 `base_url`，并禁止 `fetch` 跟随跳转，避免 302 把请求带到内网。

### 7.3 越权

- 所有查询都带 `user_id`；
- 跨用户 PATCH/DELETE 返回 404；
- `model_credentials` 同时带 `provider_id` 和 `user_id`，双保险；
- 测试脚本覆盖 demo2 看不到、改不了、删不了 demo 的配置。

---

## 8. 页面与交互

### 8.1 设置 → 模型

`src/components/models-settings.tsx`：

- 顶部「添加模型提供商」；
- 系统默认开关卡片；
- provider 行：状态点、名称、状态文案、模型数量、编辑、删除；
- 展开卡片：显示名称、API 地址、协议、密钥、无需密钥、启用、保存/取消；
- 「测试连接」：新建表单里可以先测；已有 provider 卡片里也能测。请求上游 `/models`，显示延迟和发现的模型，可勾选后一键导入；
- 模型目录：逐行编辑模型 ID、显示名、上下文窗口、最大输出、是否显示；添加/删除；
- 空状态：还没有 provider；
- 游客：显示登录引导，不发请求。

密钥输入框：

- 已有密钥时 placeholder 显示 `已保存 •••• 1234，留空不修改`；
- 输入新值才覆盖；
- 「清除已保存密钥」需要显式点；
- 支持「这个端点不需要 API 密钥」；
- 输入框默认 password，可切换显示。

### 8.2 composer 的模型选择器

`src/components/model-picker.tsx`：

- 目录为空时，触发器显示「配置模型」，点击直接打开设置 → 模型；
- 有模型时保持原来的搜索、分组、键盘操作、localStorage 持久化；
- 发送按钮在 `selectedId` 为空时禁用，并给出「还没有可用模型」提示。

删除当前选中的模型后，`useModelSelection` 会自动落到目录默认项或空状态。

---

## 9. 分阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 表结构、加密工具、数据访问层 | 已完成 |
| P1 | provider / model CRUD API、账户目录、请求解析 | 已完成 |
| P2 | 设置页 CRUD、空状态、系统默认开关 | 已完成 |
| P3 | 安全加固（密钥只写、越权、SSRF、乐观并发） | 已完成 |
| P4a | 测试连接、`/models` 发现、批量导入 | 已完成 |
| P4b | 推理档位、图片输入、OAuth | 暂缓 |

P4b 未做的显式标记：

- API 协议下拉只有 `OpenAI Chat Completions`；
- 模型行没有「推理等级」；
- 没有图片输入开关；
- 没有 OAuth 登录型 provider。

这些不是隐藏入口，而是明确不渲染，避免做出「看起来能用、实际没接」的假功能。

---

## 10. 验收

已跑通：

```bash
pnpm typecheck
pnpm build

node scripts/e2e-model-config.mjs   # 47 项：隔离 / 加密 / SSRF / 并发 / 系统回退
node scripts/e2e-models-ui.mjs      # 22 项：设置页 CRUD / 空状态 / composer / 回退开关
node scripts/e2e-model-picker.mjs   # 25 项：游客模型切换回归
node scripts/e2e-model-discovery.mjs # 21 项：真实 /models 发现 / 元数据 / 批量导入
node scripts/e2e-discovery-ui.mjs   # 10 项：设置页测试连接 / 一键导入
```

发现相关断言：

- `/models` 请求不跟随跳转，12 秒超时，响应上限 2MB；
- 发现结果只回模型 ID、显示名、上下文窗口、最大输出、输入类型，不回密钥；
- 导入时已存在的模型跳过，不覆盖用户改过的显示名和参数；
- 发现失败会显示可行动的错误（密钥无效 / 没有 `/models` / 连不上），不会把 provider 标记成可用。

基础断言：

- 创建 provider 后响应只有 `hasKey` / `keyLast4`，没有明文；
- 数据库里的 `secret_cipher` 不是明文；
- demo2 看不到、改不了、删不了 demo 的 provider/model；
- 旧 `revision` 返回 409；
- `127.0.0.1`、`[::ffff:127.0.0.1]`、`file://` 都被拒绝；
- 没有自定义模型且开关关闭 → `origin: "none"`、空分组；
- 开关打开 → `origin: "system"`、系统目录；
- 设置页添加 provider/model 后，composer 只显示该模型；
- 删除 provider 后回到空状态。

---

## 11. 部署注意

1. 用 root 执行一次：

   ```bash
   mysql -u root -p --default-character-set=utf8mb4 chat_mini < scripts/schema.sql
   ```

2. `.env.local` 增加：

   ```bash
   # 生成一次，别丢；换掉会让旧密钥失效
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   MODEL_SECRET_KEY=<上面生成的值>
   ```

3. 本地网关才需要：

   ```bash
   ALLOW_PRIVATE_MODEL_ENDPOINTS=true
   ```

4. 应用账号仍然只需要 CRUD 权限，不需要 DDL。

---

## 12. 已知限制

- `max_tokens` 统一按 OpenAI Chat Completions 语义发送；部分新模型使用 `max_completion_tokens`，P4 再按协议适配。
- 系统默认目录的模型 id 与账户模型 id 是两套命名空间；目录切换时 localStorage 里的旧 id 会被自动丢弃。
- 密钥轮换只预留了 `key_version`，还没有管理界面。
- `/models` 发现已经禁用跳转，但 DNS rebinding 的完整防护（解析后校验 + 固定 IP）仍未实现。
- 推理等级、图片输入、OAuth 尚未实现；发现结果里的 `input_modalities` 只做存储，composer 还不支持发图。
