# 会话路由改造 v2 · 实测定稿

> 本文件推翻 v1（`rewrite` + native history 浅跳）。
> v1 的核心假设是"真实路由会让切会话变贵"，实测证明**贵不是问题，状态丢失才是问题**；
> 而状态丢失可以用"状态提升到 layout"解决 —— 所以正确的解法是**主流 Next 做法 + 一处改造**，
> 不需要任何自研历史栈。

---

## 一、实测结论（先看数字）

同一份 UI（4301 字正文 + 输入框草稿 + 100ms 心跳），在 dev server 上跑 5 轮取中位数。
心跳 tick 是"正在生成的流还在不在"的代理指标：remount 会让它归零。

| 场景 | 切换耗时 | RSC 请求 | page remount | 草稿存活 | 后退键 |
|---|---|---|---|---|---|
| **A** 真实路由 `/spike/route/[id]`（带 prefetch） | **63ms** | 1 | 是 | ❌ 丢失 | ✅ 正确回溯 |
| **A-** 同 A，关掉 prefetch（冷 RSC） | 64ms | 1 | 是 | ❌ 丢失 | ✅ |
| **C** 真实路由 + **状态提升到 layout** | **66ms** | 1 | 是 | ✅ 存活 | ✅ |
| **B** 单路由浅导航（客户端取数） | **36ms** | 0 | 否 | ✅ 存活 | ❌ 退出应用 |

复现：`node scripts/spike-routing.mjs http://127.0.0.1:3123`（脚本与页面都是临时的，见 §八）。

### 三个决定性事实

1. **真实路由会 remount page 子树**（`mounts` 5→6，草稿被清空）。
   这就是"切走把生成掐断"的形态 —— 也是我们必须处理的东西。
2. **layout 不会随 param 变化重挂**。把草稿/run 提到 layout 层（变体 C），
   page 照样 remount，但草稿存活、心跳不归零。**这一处改造就消灭了 ① 的唯一硬伤。**
3. **A/C 与 B 的耗时差是 30ms**（66 vs 36），而 B 付出的代价是后退键失效、深链不存在、
   多标签互相踩。用 30ms 换一套自研历史栈 + 丢失后退键，**不划算**。

> dev server 下 prefetch 是关闭的（Next 开发模式行为），所以 A 与 A- 数字一致；
> 生产构建下 A/C 会命中 Router Cache，实际只会更快，不会更慢。
> 因此"63~66ms"应当理解为**悲观上界**。

### 关于 B 变体后退键的现象

按下后退后 URL 变成上一个**页面**（`/spike/route/...`），也就是说浏览器退出了应用，
而不是回到上一条会话。这正是"URL 不承载身份"的可观测后果。

---

## 二、定稿形态：① + 状态提升（记作 ①+C）

```
app/layout.tsx                    ← 全局壳
  └ SessionStateProvider          ← 提升层：run 订阅、流式状态、草稿、最近列表缓存
      └ app/c/[id]/page.tsx       ← 服务端取会话 + 消息，SSR 首屏（真实路由）
      └ app/page.tsx              ← 草稿态（无 id），发包后才 replace 到 /c/<id>
```

三条不变量：

| # | 不变量 |
|---|---|
| I1 | URL 是"哪条会话"的唯一真相（pathname 载体，不用 query） |
| I2 | 页面切换会 remount，因此**任何跨会话要存活的状态都必须住在 layout 之上** |
| I3 | 导航一律走路由（`router.push` / `router.replace`），不手写 `history.pushState` |

为什么这次不做第二套机制：跳转成本已经只有 60ms 量级，不值得为 30ms 自建历史栈。

---

## 三、状态提升：到底哪些要上去

这是本次改造的真正工作量所在。逐个判定：

| 状态 | 现在住哪 | 改造后 | 理由 |
|---|---|---|---|
| **流式 run 订阅**（`abortRef`/`runRef`/SSE） | `use-chat.ts`（在 page 内） | **提到 Provider** | 切走不能掐断生成；这是变体 C 救回来的核心 |
| **输入框草稿** | `chat.tsx` 内部 `useState` | **按会话 id 存在 Provider** | 切走再回来草稿要还在 |
| 消息正文 | `sessions[].messages` | 仍可在 page（SSR 注入）+ Provider 缓存 | SSR 首屏 → 首帧就有内容 |
| 流式中已收到的增量 | `use-chat.ts` | Provider（按 runId + seq 水位） | 切走后回来要能续上已收内容 |
| 滚动位置 | DOM | 暂不做（见 §七） | 价值低，成本高 |
| 侧栏折叠/主题/设置开关 | `AppShell` | 不动 | 本来就在 layout 层 |

判定口诀：**跨会话存活的（生成、草稿）上提；属于某条会话的（消息、滚动）留在页面。**

---

## 四、分步实施（每步可独立验收、独立回滚）

### Step 1 · 打通真实路由（不动状态）
- 新增 `app/c/[id]/page.tsx`：`getCurrentUser` → `listMessages(userId, id)` → 渲染 `<Chat initial={{session, messages}} />`
- 不存在/非本人 → `notFound()`（与 `/api/sessions/[id]` 的 404 语义一致，不泄露存在性）
- 侧栏点击从 `selectSession(id)` 改为 `router.push(`/c/${id}`)`
- **验收**：粘 `/c/<id>` 直开正确；刷新不跳走；点侧栏 URL 变化且界面更新
- **已知代价**：此时草稿与生成会在切换时丢失（Step 2 修）
- **回滚**：删一个文件 + 还原侧栏 onClick

### Step 2 · 状态提升（核心）
- 新建 `src/components/session-state-provider.tsx`（client）：持有 run 订阅、`streaming` 集合（按 sessionId）、草稿映射
- `use-chat.ts` 拆成两层：`useChatState()`（Provider 内）与 `useChatView(sessionId)`（页面内取视图数据）
- 页面 remount 后，从 Provider 拿"这条会话是否正在生成 + 已收水位"，命中则继续订阅并补齐增量
- **验收**：生成中切走 5 秒再切回 → 正文连续、无重复前缀；草稿跨会话保留
- **回滚**：Provider 是新增文件，页面侧有开关可回退到旧 hook

### Step 3 · 草稿态（`/`）
- `/` 上发第一条消息 → 服务端建出会话 → `router.replace(`/c/${id}`)`
- 空对话不写历史格；`/` 本身不产生 URL 身份
- **验收**：新建→发送→URL 变 `/c/<真id>`；再按后退不会停在空对话

### Step 4 · 删除与重定位
- 删当前会话 → `router.replace(下一条 ?? "/")`（**必须 replace**，不能让后退回到已删资源）

### Step 5 · 深链鉴权回跳
- 未登录访问 `/c/<id>` → 登录页带 `?next=/c/<id>`
- `login-form.tsx:52` 的 `router.replace("/")` 改为读 `next`，并做同源白名单（只接受单个 `/` 开头）
- **验收**：`?next=//evil.com` 落到 `/`

### Step 6 · 清理
- 删掉 `use-chat.ts` 里的 `activeKey` localStorage 逻辑（`84`、`190-197` 行）；URL 已是真相
- 游客模式例外：游客没有服务端会话，只能继续用 localStorage，需**单独标注**（见 §七）

### Step 7 · 回归
- 复用现有 `scripts/e2e-*.mjs`，新增 `scripts/e2e-routing.mjs`：直链、后退、草稿、流式切走、删除重定位、登录回跳、404

---

## 五、实施中必须踩准的四个细节

1. **SSR 快照 + 流式续传会打架**：SSR 拿的是请求时刻的快照，客户端起来后如果该消息 `status=streaming` 且有 `runId`，要用现有 `resumeRun` 从 `afterSeq` 续，**不能把 SSR 内容当基线再全量追加**。
2. **切换要 abort 的是订阅，不是生成**：现有 `selectSession` 的注释已经写对了（"只断订阅，不掐生成"），提层后要保持这个语义。
3. **`streaming` 必须是"按 sessionId 的集合"**，不能是单个布尔：提层后可能同时有两条会话在生成（另一个标签发起的）。
4. **`router.push` 到当前会话要短路**：否则点同一项会堆历史。

---

## 六、验收清单

- [ ] 粘 `/c/<id>` 直开 → 正确会话，刷新不跳走
- [ ] 切 3 条会话，后退 3 次 → 精确回溯，正文一致
- [ ] 新建 → 发送 → URL 变 `/c/<真id>`，后退不停在空对话
- [ ] 生成中切走 5 秒再切回 → 正文连续、无重复前缀、按钮状态正确
- [ ] 切走再回来，草稿还在；切到别的会话，草稿是**那一条**的
- [ ] 删除当前会话 → URL 变下一条或 `/`，后退不回已删资源
- [ ] 改名 → URL 不变
- [ ] 未登录粘深链 → 登录后回原会话；`?next=//evil.com` → 回 `/`
- [ ] 不存在的 id / 别人的 id → 404 文案（不泄露存在性）
- [ ] 全流程无 document 请求；每切一次恰好 1 个 RSC 请求

---

## 七、明确不做 / 已知缺口

| 项 | 结论 |
|---|---|
| 标题进 URL | 不做：标题会自动生成且可改，每次改名都要重写历史链接 |
| 滚动位置恢复 | 暂不做：要自己做 keyed 滚动记忆，收益低于成本；后退时浏览器自带部分行为 |
| 跨标签实时同步（BroadcastChannel） | 不做：URL 方案已消除"看错会话"；列表同步留给后续 |
| 公开分享 `/share/[id]` | 独立需求（鉴权模型不同），单独做 |
| **游客模式** | 游客会话没有服务端实体，`/c/<id>` 无法直开；游客继续走 localStorage + 内存导航，是已知缺口 |

---

## 八、临时脚手架（结论落地后必须删除）

实测用的文件，**上线前必须清理**，其中前两项有安全隐患（硬编码 demo 用户、无鉴权）：

| 路径 | 说明 |
|---|---|
| `src/app/spike/route/[id]/page.tsx` | 变体 A/C 页面，**无鉴权、userId 写死** |
| `src/app/spike/shallow/page.tsx` | 变体 B 页面，同上 |
| `src/app/api/spike/[id]/route.ts` | 变体 B 取数接口，同上 |
| `src/app/spike/route/layout.tsx`、`spike-state.tsx` | 状态提升验证 |
| `src/components/spike-probe.tsx` | 测量探针 |
| `scripts/spike-routing.mjs`、`scripts/fixture-spike.mjs` | 测量脚本、造数脚本 |
| DB 里的 60 个 `[spike]` 会话 | `DELETE FROM chat_sessions WHERE title LIKE '[spike]%'` |

---

## 进度

### Step 1 · 打通真实路由 —— ✅ 已完成（2026-11-07）

改动：

| 文件 | 改了什么 |
|---|---|
| `src/app/c/[id]/page.tsx`（新增） | 服务端 `getCurrentUser()` + `getSession()`；不存在/非本人 → `notFound()`（与 `/api/sessions/[id]` 同为 404，不泄露存在性） |
| `src/components/chat.tsx` | 新增 `initialSessionId` / `initialSession` 两个 props；侧栏 `onSelect` 改为「先 `selectSession` 再 `router.push('/c/'+id)`」 |
| `src/lib/use-chat.ts` | 水合时 `activeId` 优先级改为 **URL > localStorage > 第一条**；服务端确认过的会话若不在列表前 50 条，补进列表（避免「URL 有 id、侧栏没有」） |
| `scripts/probe-step1.mjs`（临时） | 14 项验收脚本 |

验收结果（`node scripts/probe-step1.mjs`）：**14/14 通过** —— 直开、标题正确、侧栏切换写 URL、后退回溯、刷新保持、404、游客直开。

**与计划的偏差（有意为之）**：
- 消息正文**没有做成 SSR**，仍由客户端拉 `/api/sessions/[id]/messages`。Step 1 的目标只是"URL 能承载会话"，一次动太多会把回滚单位搞大。SSR 消息留到 Step 2 之后单独评估。

**已知缺口（下一步要修）**：
- 新建对话、删除当前会话时，URL **不会**跟着变（Step 3 / Step 4）。
- 切会话仍会 remount → 草稿与生成中断（Step 2）。
- 游客：`/c/<id>` 只有同一浏览器能打开，且服务端无法判定归属（§七 已列为已知缺口）。

## 决策记录

| 日期 | 决策 | 结论 |
|---|---|---|
| 2026-11-07 | v1 全 RSC 是否太贵 | 否：63ms（dev，悲观上界） |
| 2026-11-07 | 单路由浅导航（v1）| **放弃**：省 30ms，但丢后退键 + 需自研历史栈 |
| 2026-11-07 | 真实路由的 remount 是否致命 | 否：状态提升到 layout 后草稿与生成均存活（变体 C 实测） |
| 2026-11-07 | **定稿** | **①+C：真实路由 `/c/[id]` + 状态提升 + 不做浅导航** |
