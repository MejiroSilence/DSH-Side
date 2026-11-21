# 计划 v2：Codex 风格侧边聊天（可发现性 / 可恢复性 / 隐藏边界）

> **文档状态**：**已定稿（2026-11-20）**。批次 A（纯 Client）与批次 B（Host 半部）均已实现、安装并通过验收；**批次 C 经用户决定不做**。本文保留其原始规划仅作记录，下文「建议执行顺序」「批次 C」等章节是当时的设计稿，**不代表待办任务**。
> **最终实现要点**：v1 用 `ctx.sessions.fork()` 分叉真实子 Session；批次 A 增加 `/side` 命令、右栏引导卡片与首页、可重开的最近列表、嵌套深度上限与截断说明；批次 B 把 developer 边界改为隐藏的 system prompt section —— Client 给子会话打 `Side chat: ` 标题前缀，Host 通过 `title` 投影识别，**普通手动 fork 不受影响**。创建过程不经过 session command（该通道会往主会话日志写命令事件，已不作为主路径）。Host 行改名为 `side-chat-v2` 并带 Config schema；改 Host 代码需 `remove_bundle` + `install_bundle` 或重启 DSH，只改 Client 需完全退出并重开应用。**后续（2026-11-22）把入口改为 Codex 式：框选文本自动弹出双按钮浮层，`contextmenu` 不再认领（右键恢复浏览器原生菜单）；因 dispatch 注册顺序无法抢占，改用 `key:'quote'` + `priority:-100` 的 slot entry 遮蔽内置单按钮「引用文本」，并以 `key:'side-chat'` 兜底，两者共用同一组件。**
> **前置与验收**：v1 已完成，[PLAN.md](PLAN.md) 第 6 节全部验收通过（静态检查、单测、`application: applied`、6 项手工流程、控制台/明暗主题/横向溢出、禁用后入口消失、UX 评审）。v2 最终状态：静态检查通过、**50/50 单测通过**、`application: applied` 且 `warnings: []`、`include:side-chat-v2` enabled/active；历次用户手工验收见各次交付报告。**本次（框选自动弹出双按钮 / 右键恢复原生菜单）待用户完全退出并重开 DSH 应用后确认。** `git status` 干净，提交历史见 `git log`。
> **项目根目录**：`<path-to-checkout>`（bundle 以 link 方式装在当前 `desktop` profile，仓库即真源；**请勿删除或移动该目录**，否则插件失效）。
> **运行环境**：`@deepseek-ai/dsh` **0.2.2-rc.5**，`DSH_PROFILE=desktop`，Web bundle 已启用。实现时按 `dsh-doc` 技能的 `references/locate-docs.md` 逐项复核了运行安装的 API。

---

## 目标与成功标准

在不破坏 v1 已验收主流程的前提下，补齐三块能力：

1. **可发现** —— 不再只有「选区内右键」这一个隐藏入口；
2. **可恢复** —— 关闭的侧边聊天标签能重新并排打开；
3. **更接近 Codex** —— 用隐藏的 developer/system 边界替代草稿里的可见说明，并让核心操作同时服务 UI 与 agent tool。

验收标准（分批次）：
- 批次 A 完成后：`/side` 命令与右栏引导卡片可打开侧边聊天；关闭的标签可从「最近侧边聊天」重新并排打开；v1 的 6 项手工流程**全部回归通过**；`git status` 干净；仍只需刷新页面、无需重启 DSH。
- 批次 B 完成后：子会话收到隐藏边界（草稿里不再出现可见说明）；同一操作经 UI 与 agent tool 调用得到一致的状态变化与失败（按 `user-actions.md` 的验证要求）；Config 可在 `cordis.patch.yml` 调整；新 Loader 行 active，旧行已清理。
- 全程：不新增 Session 事件类型、不 `require` 任何 DSH Client 包、样式仅 `--dsw-alias-*`、禁用 bundle 后所有注册消失。

---

## 前置事实（已核实 / 实现时需核实）

| 事实 | 状态 | 来源 |
|---|---|---|
| `ctx.sessions.fork({sessionId, atSeq?, increaseTitle, onCreated, allowMigration})`、省略 `atSeq` = 最后完成回合前缀 | 已核实 | `dsh-api-session-controller/src/client/contract/sessions.ts:125-143` |
| `sessions.retain/using/binding`、`SessionReference.ready/release` | 已核实 | 同上 `:25-68` |
| `conversation.input.requestDraftInitialization(binding, {prompt, whenDraftExists})` | 已核实 | `dsh-client-ui-conversation/src/client/contract/input.ts:238-252` |
| `sidebarRightTabs.register({id, kind, patterns, priority, canOpen, title, guide?})`，`guide?: readonly SidebarRightGuideEntry[]`，`guide[].id` 必须唯一 | 已核实字段存在 | `dsh-client-ui-sidebar-right/src/client/tab-registry.ts:61,137,255-256`；`SidebarRightGuideEntry` 的完整字段（title/description/order/glyph）**实现时复核** |
| `reference.binding.session.rename(title)`（返回 `RemoteResult`） | 已核实 | `dsh-client-ui-workspace/src/client/index.ts:208-215` |
| `ctx.slots.register` 的 `locale` 选项提供 `t`；`ctx.locale.register(ns, {zh,en})` | 已核实（v1 已用） | `dsh-message-quotes/src/client/index.ts:33-49` |
| `ctx.systemPrompt.section()` 用于追加 prompt 文本；per-agent 行为注册在 `agent.ctx` | 文档记载，**实现时复核签名** | `dsh-doc/references/practices.md` |
| `ctx.on('agent/created', ...)` 获取 `agent.ctx` | 文档记载，**实现时复核事件名** | 同上 |
| `ctx.remote.commands.execute()` 作为 Client 可调用的 Host 入口 | 文档记载，**实现时复核** | `dsh-doc/references/user-actions.md` |
| 「一次操作两个调用者」：UI 与 agent tool 必须调同一个 Host service method | 文档约束 | `dsh-doc/references/user-actions.md` |
| 不新增 Session 事件类型；`appendPluginRecord()` 保留给实验包 | 文档约束 | `dsh-doc/references/practices.md` |
| Host 模块按行 specifier 缓存 → 改 Host 半部需 `remove_bundle` + `install_bundle` **且换行名**，或重启 DSH | 已核实（v1 设计前提） | [PLAN.md](PLAN.md) 第 7 节、README「开发注意」 |

---

## 关键架构约束（硬约束，v2 不得违反）

1. **不新增 Session 事件类型**、不往 session log 写数据。隐藏边界只能走 `ctx.systemPrompt.section()`；live `Session.append()` 无法带 `ignorable`，会让 Session 拒绝重开。
2. **per-agent 注册双 owner**：挂在 `agent.ctx` 的 effect，同时把 disposer 也存进插件自己的 `ctx.effect`；插件卸载不会自动 dispose `agent.ctx` 上的注册。
3. **一次操作两个调用者**：「开侧边聊天」若同时暴露给 UI 和 agent tool，必须共用一个 Host service method，不允许两处各写一份逻辑；授权/确认类动作保持 user-only。
4. **批次 B 一次性把 Host 面设计到位**（systemPrompt section + Host service + agent tool + Config）。Host 改动每次都要重启/换行名，分批反复改代价极高。
5. **不破坏 v1 手势分工**：`contextmenu` 仍归本插件（interaction id `side-chat`），拖选 `selection` 仍归内置 `message-quotes`；`/side` 命令是**新增第三个入口**，不替换右键。
6. **Client 模块纪律**：不 `require` 任何 `@deepseek-ai/dsh-client-ui-*`；不向 `document.body` 追加节点；不写 DOM 之外的全局监听；样式只用 `--dsw-alias-*`；所有注册在 `ctx.effect` / `ctx.inject` 内。
7. **资源标识不变**：协议 `sidechat`、tab kind `sidechat`、地址 `dsh-resource://sidechat/session/<child>?parent=<parent>&label=<firstLine>`、`interaction id='side-chat'`、Client 模块 id `@local/dsh-side-chat` 全部保持不变 —— 否则用户已打开的标签地址会失效，且重复注册会抛错（resource protocol 唯一、interaction id 唯一）。
8. **换名只换 Loader 行**：批次 B 换行名时，只改 `cordis.patch.yml` 的 `id`；`list_plugins` 的 entryId 会随之从 `include:side-chat` 变为新值。**旧行必须清理**，不能两行并存。

---

## 范围决策与批次总览

| 批次 | 项目 | 面 | 重启成本 | 优先级 | 风险 |
|---|---|---|---|---|---|
| A1 | `/side` 斜杠命令 + 右栏引导页卡片 | Client | 仅刷新 | **P0** | 低 |
| A2 | 关标签后并排重开（最近侧边聊天） | Client | 仅刷新 | **P0** | 低 |
| A3 | 反馈细化：成功提示、递归深度上限、截断标记、失败残留 child 策略 | Client | 仅刷新 | P1 | 低 |
| A4 | 子会话标题定制、更多语言 | Client | 仅刷新 | P1 | 低 |
| B1 | 隐藏 developer/system 边界 | Host | **重启/换名** | P1 | 中 |
| B2 | Host service + agent tool「一次操作两个调用者」 | Host + Client | **重启/换名** | P1 | 中 |
| B3 | Config schema（ephemeral / 自动归档 / 递归深度 / 隐藏边界开关） | Host | **重启/换名** | P1 | 中 |
| C1 | 关标签自动归档（ephemeral） | Client + 配置 | 仅刷新 | P2 | **高**（误删风险） |
| C2 | 只显示边界之后的新回合 | Client（Conversation 装配） | 仅刷新 | P2 | **高** |
| C3 | 自定义 Markdown 面板、发布 npm / 插件市场 | 混合 | — | P2 | 流程性 |

**建议执行顺序**：先做 A1 + A2（纯 Client、零重启、正好补齐 UX 评审标为 MAJOR 的两项）→ 批次 B 设计定稿后一次性实现 → C 单独评估。每批结束都重跑 v1 的 6 项手工流程作为回归。

---

## 批次 A：P0，纯 Client（零重启成本）

### A1 可发现性

- **目标**：用户不必知道「选区内右键」也能找到侧边聊天。
- **路径**：
  - `/side` 斜杠命令：通过 `dsh-client-ui-commands` 的 `commandUi` 注册（`ctx.inject(['commandUi'], ...)`），命令复用 `openSideChat(parent, text)`；无选区时用当前草稿或空上下文，命令面板给出本地化说明。**实现时复核命令注册 API 与 `InputTrigger` 词库接入方式。**
  - 右栏引导页卡片：在 `sidebarRightTabs.register` 增加 `guide: [{ id: 'side-chat', title: ..., description: ..., order: ... }]`；卡片打开 `sidebar://guide` 时列出，点击后走 `openTab('sidechat')` 或引导用户右键/用命令。**实现时复核 `SidebarRightGuideEntry` 的确切字段与 `guide()` 的消费方式**（`tab-registry.ts:326-330,409-410`）。
- **注意**：`guide[].id` 在注册表内必须唯一；不要与内置 `subagentchat` 的引导项抢 id。
- **验收**：从未选区状态也能通过命令/卡片进入侧边聊天；右键与拖选行为不变。

### A2 关标签后并排重开

- **目标**：v1 关闭标签后，子 Session 只能在主视图打开，并排视图不可恢复。
- **路径**：
  - 维护「最近侧边聊天」地址列表，键为子 Session id，值为完整 `dsh-resource://sidechat/...` 地址 + 首行标题。放在 Client 侧存储（`localStorage`，与 `dsh.conversation` 草稿存储同层级）或新增 Client 侧 service；**不写 Host 存储、不新增 Session 事件**。
  - 在引导卡片或新增的「最近」入口里对已有地址调用 `ctx.sidebarRight.openResource(address, { kind:'sidechat', preferNewPane:true })` —— 同一地址会揭示已有标签，不重复 fork、不重复预填（v1 的 `pendingDrafts` 一次性消费机制保持不变）。
  - 标签关闭（`signal` abort）时**不删除**记录，只标记；记录有上限（如 20 条）并在插件卸载时清理。
- **验收**：关闭标签后可从入口重新并排打开同一个子会话（不是新 fork）；会话列表不新增重复子会话；草稿不重复预填。

### A3 反馈细化

- 成功提示：fork 成功后在父 composer 发一条 `info` 级本地化 notice（用 v1 已核实的 `conversation.input.for(binding.ctx).notify(level, text)`），避免标签在折叠右栏时被忽略。默认可关。
- 递归深度上限：在地址里带一个 `depth` 参数或在 Client 侧记录父链，超过阈值（如 3）时禁用「在侧边聊天中提问」并给本地化提示。**地址格式可变但必须向后兼容**：`parseAddress` 对缺失 `depth` 的地址返回默认值，保证 v1 已打开的标签仍可解析。
- 截断标记：`capText` 超长时在 `buildOpeningDraft` 末尾追加一行本地化「（已截断至 8000 字符）」；**不要**把标记塞进块引用内部（会污染被引用的原文）。
- 失败残留 child：`error.open`（fork 成功但开标签失败）目前只在文案里说明 child 留在列表。v2 给出一个明确的「重试打开」动作（复用 A2 的地址记录），而不是自动归档（自动归档归 C1，风险高）。

### A4 标题定制与多语言

- 标题：`sessions.using(childId, {source:'sideChat'}, ref => ref.binding.session.rename(title))`（已核实用法），标题取选段首行；失败要 toast，不能静默。
- 语言：补 `ja/es/fr/de/ru/pt` 运行时字典 + 对应 `locale/*.json` 的 `meta.title`/`meta.description`；英文标题保持 sentence case。

---

## 批次 B：P1，引入 Host 半部（一次性设计到位）

> ⚠️ 本批次会让 `index.js` 从空 `apply()` 变成有实际注册。按约束 4，**先写设计稿并一次实现**，避免反复重启。

### B1 隐藏 developer/system 边界

- 把 v1 草稿里可见的 `draft.boundary` 文案，改成子会话的 system prompt section；草稿里**只保留块引用**。
- 路径：`ctx.on('agent/created', ...)` 拿到 `agent.ctx` → `agent.ctx.effect(() => ctx.systemPrompt.section(...))`；按约束 2，把 disposer 同时存进插件自己的 `ctx.effect`（keyed by agent）；按约束 1，不往 session log 写边界。
- 边界内容：说明继承历史仅作参考、不要继续执行主任务、不要改文件/跑工具除非明确要求、按 Enter 才发送（这条是给模型的指令，不再是给用户的「未发送」承诺）。
- 需要能识别「哪些 agent 属于本插件 fork 出的子会话」。优先用现有 session 投影/目录派生（practices.md 原则 1：session log 是唯一真源），不要维护插件私有内存映射；**实现时先确认可用的投影来源**。
- 保留 Config 开关 `hiddenBoundary`（默认 true），关闭时回退到 v1 的可见说明，便于回归对比。

### B2 一次操作两个调用者

- 把「开侧边聊天」实现为一个 Host service method（例如 `openSideChat({parentSessionId, text})`），返回显式结果/失败原因。
- UI 动作经 Client 可调用的 Host 入口（`ctx.remote.commands.execute()` 或一个 session command）调用它；agent tool 用相同参数调同一个方法，把结果作为 tool result。
- **验证**（`user-actions.md`）：分别经 tool 与 UI 执行，对比状态变化、返回值与失败是否一致；授权/确认类动作保持 user-only，agent 不能执行。
- 注意：v1 的 `openSideChat` 是纯 Client 的 fork + openResource。拆到 Host 后要确认 fork 仍在 Client 侧可用，或整体迁到 Host；**不要**在 UI 和 tool 两条路径各写一份 fork 逻辑。

### B3 Config schema 与换名

- `index.js` 增加 `export const Config`（z schema），字段建议：`hiddenBoundary: boolean`、`ephemeral: boolean`（默认 **false**）、`maxDepth: number`、`recentLimit: number`、`successNotice: boolean`。字段进 `cordis.patch.yml` 行 `config`，用户的 patch 层在升级后仍存活。
- **换名**：`cordis.patch.yml` 的 `id: side-chat` → 新值（如 `id: side-chat-v2`）。按约束 7/8，其它标识全部不变；`list_plugins` 的 entryId 变为 `include:side-chat-v2`。
- 生效方式：`remove_bundle @local/dsh-side-chat` → `install_bundle <path-to-checkout>`（换行名）→ 读 `application: applied` → 完全退出并重开 DSH 应用；或重启 DSH。
- 回滚：`remove_bundle` 后把行名改回 `side-chat` 且移除 Host 面，再 install。

---

## 批次 C：P2，高风险 / 流程性（单独评估）

- **C1 关标签自动归档（ephemeral）**：与 DSH「Session 持久」原生语义冲突，有误删用户数据的风险。必须做成 **Config 默认关闭** 的开关；开启时只在「确属本插件创建且未被用户手动打开过主视图」的条件下归档（`uiWorkspace.archiveSession(sessionId, {stopActivity})` 已见于 `dsh-client-ui-workspace/src/client/navigation.ts`）。README 必须写明「开启后关闭标签会删除子会话」。
- **C2 只显示边界之后的新回合**：要改 Conversation 视图/装配并依赖 fork 边界 seq，风险最高；需先确认 `conversation.content` 的 `variant:'embedded'` 能否按 seq 过滤，且不能破坏 v1 已验收的 Chat 渲染。
- **C3 自定义 Markdown 面板、发布 npm / 插件市场**：打包 `files` 校验、registry、市场审核流程；与本插件功能解耦。

---

## 新增公共标识（v2 增量，v1 标识保持不变）

| 标识 | 值 | 用途 |
|---|---|---|
| Config 字段 | `hiddenBoundary` / `ephemeral` / `maxDepth` / `recentLimit` / `successNotice` | 用户可调开关，写在 patch 行 `config` |
| Loader 行（批次 B） | `id: side-chat-v2`（示例，实际换名时确定） | 绕开 Host 模块按行 specifier 的缓存 |
| 命令 | `/side` | 斜杠命令入口 |
| 引导卡片 id | `side-chat`（注册表内唯一） | `sidebarRightTabs.register({guide})` |
| 最近侧边聊天存储键 | `dsh.sidechat.recent`（建议） | Client 侧 localStorage，存地址 + 标题 + 深度 |
| 地址可选参数 | `depth`（可选，缺省向后兼容） | 递归深度上限 |
| Host service / agent tool | 实现时定名，两者共用同一 method | 「一次操作两个调用者」 |

**保持不变**：包名/Client 模块 id `@local/dsh-side-chat`、协议 `sidechat`、tab kind `sidechat`、interaction id `side-chat`、资源地址格式、`SessionReferenceSource` 标签 `'sideChat'`、locale 命名空间 `sideChat`。

---

## 边界情况与失败模式

- 右键无选区 / 选区外右键：v1 行为不变（不弹浮层、保留原生菜单）。
- `/side` 无选区：用当前草稿或空上下文，命令面板要明确说明将发生什么，不能静默 fork。
- 最近地址指向已被用户删除/归档的 Session：`openResource` 前用 `sessions.list` 校验，失效则移除记录并给本地化提示，不开空标签。
- 同一 child 再次打开：揭示已有标签，`pendingDrafts` 已消费 → 不重复预填。
- 递归超限：禁用「在侧边聊天中提问」并提示；`parseAddress` 对旧地址（无 `depth`）返回默认深度。
- 隐藏边界的 per-agent 注册：插件卸载 / agent 释放两个 owner 任一触发都要撤销；不能残留 system prompt section。
- 换名期间新旧行并存：会导致 interaction id / resource protocol 重复注册抛错，必须 `remove_bundle` 后再 install，不能热切换。
- Config 校验失败：`Config` 在激活时校验行 `config`，要在 README 写明字段类型与默认值。
- 自动归档（C1）只在显式开启时生效；任何失败都要保留 Session，不能「先删后报」。

---

## 测试与验收

**静态检查**（每批结束都跑，不改文件）：`ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --check index.js|client.js`；解析 `package.json`、全部 locale JSON、`cordis.patch.yml`；grep 确认无 DSH Client 包运行时 require、无 `document.body`、无新事件 type、CSS 仅 `--dsw-alias-*`。

**单元测试**：扩展 [test/client.test.mjs](test/client.test.mjs)（继续用 `vm.runInNewContext` 捕获工厂）。新增断言：
- 地址「可选 depth」的向后兼容解析与非法值拒绝；
- 最近列表的增删改与上限淘汰（纯函数化）；
- 递归深度门控；
- 截断标记不污染块引用内容；
- Config 默认值（若 Host 半部可静态加载）。
跑 `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/*.test.mjs`，v1 的 18 项必须继续全绿。

**安装与启用**：批次 A 只刷新页面；批次 B 必须 `remove_bundle` + `install_bundle`（换行名）或重启 DSH，读 `application: applied` 且 `warnings: []`，`list_plugins` 确认新行 active、旧行消失。不手工改 `$DSH_PROFILE_DIR` 的 package.json/patch，不在 profile 目录跑 pnpm。

**页面与手工流程验证**（按 `verification.md`）：
- 每批结束**重跑 v1 的 6 项手工流程**作为回归；
- 新增：命令/引导卡片入口、最近侧边聊天重开、递归上限提示、Config 开关的行为差异；
- 检查控制台无 `slot entry crashed`、明暗主题下新增 UI、390px 窄栏无横向溢出；
- `cua` 在 v1 期间因参数序列化错误不可用；若 v2 期间仍不可用，明确报告「运行页面视觉由用户手工验证，工具侧视觉未验证」，不要声称自动验证成功。

**Host 面专项（批次 B）**：
- 用 `cordis_inspect_query`（若可用）核对 `Config.listConfigs` 的字段与 `$defs`；不可用时按 `practices.md` 从 owning 包 README/源码核对；
- 按 `user-actions.md`：分别经 agent tool 与 UI 执行同一操作，对比状态变化、返回值与失败；
- 隐藏边界：确认子会话收到 system prompt section、草稿里不再有可见说明、插件卸载后 section 消失。

**UX 评审**：v2 属「新插件 / UX 变更」，按 `verification.md` 再跑一次 subagent UI/UX 评审，把结论与「哪些验证未能运行」写进交付报告。

---

## 对 profile 的影响与回滚

- 批次 A：纯 Client 改动，链接目录即真源，**刷新页面**即可，无 profile 写操作。
- 批次 B：`index.js` 有实际注册 → 影响该 profile 所有会话并持久保存；必须 `remove_bundle` + `install_bundle`（换行名）或重启 DSH。
- 批次 C 的 `ephemeral` 会**删除**用户 Session（默认关闭）；README 与 `meta.description` 必须明示风险。
- 回滚到 v1：`remove_bundle @local/dsh-side-chat` → 把 `cordis.patch.yml` 行名改回 `side-chat`、移除 Host 面与 Config → 重新 install → 完全退出并重开应用。或把仓库回退到 v1 的提交后重新 install。
- 完全卸载：`plugin_manager action=remove_bundle target=@local/dsh-side-chat` + 刷新。

---

## 明确不在 v2 范围（v3 候选）

改写 DSH 源码、新增 Session 事件类型、新增 Host Remote 命名空间（除非 B2 确实需要且经核实）、自动发送任何模型请求（按 Enter 才发起，这条写进 `meta.description`）、替换内置 `quote`、与 `subagentchat` 抢 pattern、替换应用 root、把子会话做成不留 Session 的一次性小窗（那是 `dsh-select-ask` 的语义，与本项目假设冲突，见 [PLAN.md](PLAN.md) 第 9 节假设 1）。

---

## 假设

1. 隐藏边界按 `ctx.systemPrompt.section()` 实现，不是往 session log 写 developer 消息。
2. `ephemeral` / 自动归档默认**关闭**；DSH 原生「Session 持久」仍是默认语义。
3. v1 的 `contextmenu` 手势分工保持不变，`/side` 是新增入口而非替换。
4. 批次 B 允许在 `desktop` profile 通过 `remove_bundle` + `install_bundle`（换行名）验证；若只想要仓库产物、不装进 profile，可删去对应安装步骤。
5. 工作目录仍是 `<path-to-checkout>`；会话默认工作区保持不动。
6. 本文为计划稿；任何 API 在实施前按 `dsh-doc/references/locate-docs.md` 对运行安装复核，不凭记忆落代码。
