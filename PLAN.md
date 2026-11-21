# 计划：Codex 风格侧边聊天 DSH 插件

> **文档状态**：本文件是 v1 计划原稿（2026-11-20）。**项目已完成并验收通过**，后续迭代见 [PLAN.v2.md](PLAN.v2.md)。**交互决策以第 23 行「交互决策（2026-11-22 修订）」为准**：框选自动弹出双按钮浮层、右键恢复浏览器原生菜单；正文其余「右键选区」描述是当时的 v1 设计，仅作历史记录。
> **项目根目录**：`<path-to-checkout>`（bundle 以 link 方式装在当前 `desktop` profile，仓库即真源；请勿删除或移动该目录）。

---

## 目标与成功标准

在 `<path-to-checkout>` 建独立项目并 `git init`，产出一个可安装、可启用的 DSH bundle：在 Web 聊天里**右键选中文本**，浮出「引用到当前聊天 / 在侧边聊天中提问」两个动作；后者用真实的 `session.fork` 从主会话分叉出子 Session，在**右侧 Sidebar 并排显示这个子会话的 Chat**，把选段预填进子会话草稿，主会话保持不变、不被打断。

验收标准：插件安装后 `application: applied` 且行已启用；右键选区出现两个动作；引用动作把 Markdown 块引用写进当前输入框（不发送）；侧边聊天动作打开右侧栏 Chat 标签、子会话出现在会话列表、主视图不变、草稿预填且未自动发送；关闭标签不破坏主会话；禁用插件后所有注册消失；静态检查与纯函数测试通过。

---

## 已核实的环境事实（只读排查）

- 运行安装：`@deepseek-ai/dsh` **0.2.2-rc.5**，`DSH_PROFILE=desktop`，Web bundle 已启用；`ui-conversation`、`ui-chat`、`ui-sidebar-right`、`ui-subagent`、`api-session-controller`、`client-resources`、`message-quotes` 均 active。
- **新路径已核实**：`<parent-dir>` 存在且可写；`<path-to-checkout>` 已存在、为空、可写，且不在任何已有 Git 仓库内；父目录另有 `UnrealEngine/`，不会触碰。全局 git identity 未配置，`init.defaultBranch=main`。
- `git 2.54.0`；`node` 不在 PATH，语法检查/测试改用 `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --check|--test`。
- 现有 Web GUI URL 为 `<web-gui-url>`；本轮 cua 浏览器控制调用因参数序列化报错不可用，因此**页面视觉验证能力受限**，会在交付报告中明确说明。
- 关键 API 均已从源码确认：`ctx.sessions.fork({sessionId, atSeq?, increaseTitle, onCreated})`（省略 `atSeq` = 从最后完成回合分叉）、`ctx.sessions.retain/using`、`ctx.get('conversation').input.requestDraftInitialization(binding, {prompt, whenDraftExists})`、`ctx.resources.register`、`ctx.sidebarRightTabs.register`、`ctx.sidebarRight.openResource(addr,{kind,preferNewPane})`、`ctx.uiConversation.interactions.register`、`ctx.slots.inject`。
- **交互决策（2026-11-22 修订）**：`ConversationInteractionRegistry.dispatch` 按注册顺序返回**第一个** `open()` 的插件；内置 `message-quotes` 先注册并占用 `selection`，且 Loader patch 的 `insert` 只能追加行、无法把本插件插到它之前。因此本插件改**只认领 `selection` 手势**（不再认领 `contextmenu`，右键恢复浏览器原生菜单），并在 `conversation.chat.text-interaction` 上注册两个 slot entry：`key:'quote'`（`priority:-100`，遮蔽内置单按钮「引用文本」）与 `key:'side-chat'`（兜底，供本插件自己的 definition 赢时渲染），两者都指向同一个双按钮 `SideChatActions`。这顺带避开 `dsh-select-ask` 单例桥坑：`sessionId` 从 **session 作用域 slot props** 直接取得，不使用全局 bridge。
- 参考实现：[subagentchat 侧栏聊天](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx#L173>)、[openChildAside](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-subagent/src/client/index.ts#L59>)、[message-quotes 选区注册](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-message-quotes/src/client/index.ts#L35>)、[interaction dispatch](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/interaction-registry.ts#L27>)、[chat forkAt](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/src/client/apply.ts#L304>)、[sessions 契约](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/src/client/contract/sessions.ts#L125>)。

---

## 范围决策：把「照着 Codex 做」落到 DSH 语义

Codex 的 Side Chat = `thread/fork` 出真 Thread + 继承历史边界 + 右侧并排 + 选段作为开场上下文 + 主线程不受影响。DSH v1 对应实现：

| Codex | 本插件 v1 |
|---|---|
| `thread/fork` 从最后完成回合分叉 | `ctx.sessions.fork()` 省略 `atSeq`，等价语义 |
| 右侧并排 Side Chat | 右侧栏 `sidechat` tab，内嵌 `conversation.content` 的 `variant:'embedded'` + 固定 Chat View |
| 选段 → Ask in side chat | 右键选区 → 「在侧边聊天中提问」 |
| `chatgpt.addToThread` | 同一浮层的「引用到当前聊天」 + 内置拖选「引用文本」 |
| 隐藏 developer 边界提示 | **v1 用预填草稿中的可见说明代替**（明确写入 README 作为差异） |
| 临时/ephemeral 或 attached 两种存储 | v1 子会话作为普通 Session 保留在会话列表；关标签不删除（显式说明） |
| `/side` 命令、侧栏选择器、agent 工具 | v1 不做，列为 v2 |

**不做**：不改写 DSH 源码、不新增 Session 事件类型、不新增 Host Remote 命名空间、不新增 Config schema、不自动发送任何模型请求（按 Enter 才发起正常 agent turn，这一点写进 `meta.description`）。

---

## 新增的公共标识（API / schema / 数据流）

| 标识 | 值 | 用途 |
|---|---|---|
| 包名 / Loader 行 | `@local/dsh-side-chat` / `id: side-chat` | bundle 身份；patch 只 `- insert` 一行 |
| Client 模块 id | `@local/dsh-side-chat` | `window.__ModuleLoader__.load({id,...})` |
| locale 命名空间 | `sideChat`（`zh`/`en` 运行时字典） | 按钮、toast、边界说明；`locale/*.json` 另供 Plugin Manager 的 `meta.title/description` |
| Session 引用来源 | `'sideChat'` | `sessions.retain/using` 的 source 标签 |
| 资源协议与地址 | `sidechat`；`dsh-resource://sidechat/session/<child>?parent=<parent>&label=<firstLine>` | 右栏 tab 的 `contentId` |
| tab 类型 | `kind: 'sidechat'`，`id: '@local/dsh-side-chat'`，`priority: 'extension'`，`patterns: ['dsh-resource://sidechat/**']` | 与内置 `subagentchat` 不冲突 |
| 文本交互 | `id: 'side-chat'`（同时是 `conversation.chat.text-interaction` 的 keyed key） | 只认领 `contextmenu` |
| 私有子 slot | `sidechat.conversation`（`single`, `session`），作为 tab body 的 child | 复用共享 Conversation 装配 |

数据流：`鼠标右键选区 → interaction dispatch → 我方 keyed 浮层 → 「侧边聊天」→ sessions.fork → sessions.using(预填草稿) → sidebarRight.openResource → resources.register 保留 child SessionReference → tab body 用 SessionProvider + conversation.content 渲染 → 关闭/卸载时 signal abort → reference.release()`。

---

## 1. 项目与仓库（subsystem: repo）

- **根目录：`<path-to-checkout>`**。实现开始时把会话工作目录切到该路径（`working_directory(cd=...)`），并在每个 bash 调用显式传 `workdir`，避免误写到默认工作区；这只改变相对路径解析，不改文件策略。
- 先复核目录仍为空；**若实现时发现非空，停止并报告，不覆盖任何已有文件**（当前已确认为空）。目录已存在，无需 `mkdir -p`（若复核时发现被删除，则用 `mkdir -p` 重建）。
- 在该目录 `git init -b main`；写 `.gitignore`（`node_modules/`、`.DS_Store`、`*.log`）。
- 文件清单：`package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md`、`README.zh.md`、`test/client.test.mjs`、`.gitignore`、`PLAN.md`（本文件）。
- 全部文件写完后 `git add -A`；因全局 git identity 缺失，用 `git -c user.name="DSH Plugin" -c user.email="plugin@local" commit -m "feat: Codex-style side chat plugin"` 做**仅本仓库**的初始提交，不修改全局 git 配置；随后 `git status --short` 应为空。

---

## 2. 打包与显示元数据（subsystem: manifest）

- `package.json`：`name: "@local/dsh-side-chat"`, `version: "0.1.0"`, `private: true`, `type: "module"`；`exports` 含 `"."`（`./index.js`）、`"./client"`（`./client.js`）、`"./locale/*.json"`、`"./icon"`（`./icon.svg`）；`files` 含 `index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`README.zh.md`。
- `dsh.bundle.patch = "./cordis.patch.yml"`；`dsh.client = { platform: "web", immediately: true, inject: [...] }`，inject 列表参照 `ui-subagent`/`ui-plan`：`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-resources`、`@deepseek-ai/dsh-client-ui-chat`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-sidebar-right`、`@deepseek-ai/dsh-client-ui-session`、`@deepseek-ai/dsh-client-ui-renderer`。**不声明 `engines.dsh`**（避免预发布 semver 阻断安装），README 注明「针对 0.2.2-rc.5 开发」。
- `cordis.patch.yml`：仅 `- insert: - id: side-chat \n name: '@local/dsh-side-chat'`。
- `locale/en.json` / `locale/zh.json`：只写 `meta.title`、`meta.description`（句子式英文标题；中文「侧边聊天」）。**不写 `meta.detail`**，因此不生成 `docs/`，Plugin Manager 回退到 README（按 `plugin-details.md`，预览图可选）。
- `meta.description` 必须写清：右键选中聊天文字 → 两个按钮；分叉出真实 Session 并保留在会话列表；预填草稿、不自动发送；按 Enter 才产生模型请求（含工具）；关闭标签不删除 Session；禁用插件即移除入口；与 Codex 的差异（无隐藏边界、继承历史在子会话中可见）。
- `icon.svg`：按 `artwork.md` 画原创 36×36 图标（双气泡/分叉轮廓，扁平填色、透明背景、无 `<text>`/脚本/外链），明暗主题皆可。不复制 Codex/OpenAI 品牌资产。
- `README.md` / `README.zh.md`：功能、用法、限制、安装（`plugin_manager action=install_bundle target=<path-to-checkout>` → 刷新 Web 页面）、开发注意（**Client 半部改动需刷新页面；Host 半部改动需重启 DSH 或 remove+install 且换行名**）、与 Codex 及 `dsh-select-ask` 的区别。

---

## 3. Host 半部（`index.js`）

`export function apply() {}` 空实现（bundle 需要一行 Loader home）。注释写明：v1 全部行为在 Client，边界提示目前是草稿中的可见文字；v2 若要做隐藏边界，需在此 `ctx.on('agent/created', ...)` + `agent.ctx.effect(() => ctx.systemPrompt.section(...))`，并配一个 Host service / agent tool（「一次操作两个调用者」）。不注册任何 Remote、命令或事件，避免无谓的重启要求。

---

## 4. Client 半部（`client.js`，核心）

单个 `window.__ModuleLoader__.load({ id, factory(require) {...} })` 惰性工厂；`require('react')` 取 React，禁止 `require` 任何 DSH Client 包。

**纯函数（挂在返回对象的 `helpers` 上，供测试直接调用）**：

- `encodeAddress({child,parent,label})` / `parseAddress(str)`：校验 `dsh-resource:` 协议、host=`sidechat`、path=`session/<child>`、必填 `parent`，`encodeURIComponent`/`URLSearchParams` 往返；非法返回 `undefined`。
- `capText(text, max=8000)`、`quoteBlock(text)`（每行 `> `）、`firstLine(text, 28)`、`buildOpeningDraft(text, t)`（块引用 + 空行 + 本地化边界说明：继承历史仅作参考、不要继续执行主任务、不要改文件、除非明确要求）。
- 这些函数同时导出到工厂返回对象（`{ inject, apply, helpers }`），测试用 `vm` 加载同一份 `client.js` 验证真实代码。

**`apply(ctx)`**：

1. `ctx.effect(() => ctx.locale.register('sideChat', { zh, en }), ...)`。
2. `ctx.effect(() => ctx.uiConversation.interactions.register({ id: 'side-chat', onInteraction(request) { ... } }), ...)`：仅当 `request.trigger === 'contextmenu' && request.readText() !== null` 时 `request.open()`；用 `ctx.sessions.binding(request.sessionId)` + snapshot 做与 `message-quotes` 相同的可写门控（`removed` 或 `subagent.mode !== 'continuable'` 则不认领）。
3. `ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({ name, key: 'side-chat', locale: 'sideChat' }, SideChatActions))`：组件从 **session 作用域 props** 取 `sessionId`、`inputActions`、`useSession`、`t`、`dismiss`、`readText`、`clearSelection`、`trigger`。渲染两枚按钮，样式只用 `--dsw-alias-*` token：
   - 「引用到当前聊天」→ `inputActions.insertQuote(text)` → `clearSelection()` → `dismiss()`（失败则保留选区）。
   - 「在侧边聊天中提问」→ `openSideChat(sessionId, text)`（**sessionId 来自本组件 props，不使用模块级单例**）。
4. `openSideChat(parent, text)`：截断到 8000 字符；`await ctx.sessions.fork({ sessionId: parent, increaseTitle: true })`；成功后 `await ctx.sessions.using(childId, { source: 'sideChat' }, ref => ctx.get('conversation').input.requestDraftInitialization(ref.binding, { prompt: buildOpeningDraft(text, t), whenDraftExists: 'append' }))`（`using` 短暂保留并自动释放，避免与 tab 的 retain 冲突、也避免重复预填）；再 `ctx.sidebarRight.openResource(encodeAddress({child: childId, parent, label: firstLine(text)}), { kind: 'sidechat', preferNewPane: true })`。失败时：toast 本地化错误，**不开空 tab、不清选区**；`SessionForkError` 且 `rpcError.code === 'session/migration-required'` 时提示「请先打开原会话完成迁移」（照 `ui-workspace` 的处理）。
5. `ctx.inject(['resources','sidebarRightTabs','sidebarRight','sessions','conversation'], scope => { ... })` 内注册（每项用 `ctx.effect(...)` 包好，保证卸载清理）：
   - `scope.resources.register({ protocol: 'sidechat', async *open(address, { signal }) { const p = parseAddress(address); if (!p) throw ...; const reference = scope.sessions.retain(p.child, { source: 'sideChat', signal }); try { yield { ok: true, value: { ...p, reference } }; await waitForAbort(signal) } finally { reference.release() } } })`。
   - `scope.sidebarRightTabs.register({ id, kind: 'sidechat', patterns: ['dsh-resource://sidechat/**'], priority: 'extension', canOpen: a => parseAddress(a) !== undefined, title: () => t('tab.title') })`。
   - `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: id, locale: 'sideChat', children: { 'sidechat.conversation': { kind: 'single', scope: 'session' } } }, SideChatTab))`：`useResource(tab.contentId)` 取 `value.reference`，用 `SessionProvider session={...}` 包住 `renderSlot('sidechat.conversation', {})`；`value === undefined` 时渲染本地化 loading。
   - `ctx.slots.inject('sidechat.conversation', () => ctx.slots.register({ name: 'sidechat.conversation' }, SideChatConversation))`：照 `ConversationSlotPanel` 计算 `phase`（`settling`/`hero`/`active`），调用 `renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, { slots: { views: FixedChatView } })`；`FixedChatView` 固定 `renderSlot('conversation.session', { view: 'chat' })`。
   - 可选 `ctx.slots.inject('sidebar.right.pane.tab.title', ...)` 显示选段首行。

**硬约束**：不 `require` 任何 `@deepseek-ai/dsh-client-ui-*`；不向 `document.body` 追加节点；不写 DOM 之外的全局监听；不新增未知 Session 事件；所有资源（locale、interaction、resource provider、tab 类型、slot 注入）都在 effect / inject 生命周期内，插件卸载即撤销。

---

## 5. 边界情况与失败模式

- 右键但无选区（`readText() === null`）→ 不弹浮层；拖选仍由内置 `message-quotes` 处理。
- 只读/one-shot 子会话 → 两个动作都不出现（沿用 `message-quotes` 门控）。
- 会话还没开始（无完成回合）或迁移未完成 → fork 失败 → toast，不开 tab，主视图不变。
- 选段超长 → 截断并保留首行标题；不把超大文本塞进草稿。
- 同一 child 再次打开 → `openResource` 揭示已有 tab；资源按 occurrence 保留，不重复预填。
- 关闭 tab / 切会话 / 卸载插件 → `signal` abort → `reference.release()`；主会话的 draft、滚动、选中状态不受影响。
- 子会话是**普通 Session**：会出现在左侧列表，关标签不删除；README 明确说明（与 Codex ephemeral 的差异），避免用户误以为「无痕」。
- 不自动发送：只有用户在侧栏按 Enter 才产生模型请求和工具调用；`meta.description` 明示这个成本。
- 不覆盖内置 `quote`、不与 `subagentchat` 抢 pattern、不替换应用 root。

---

## 6. 测试与验收

**静态检查**（在 `<path-to-checkout>` 下进行，不改文件）：`ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --check index.js` 与 `--check client.js`；解析 `package.json`、两个 locale JSON、`cordis.patch.yml`；grep 确认无 `@deepseek-ai/dsh-client-ui-*` 运行时 require、无 `document.body`、无新事件 type、CSS 仅 `--dsw-alias-*`。

**单元测试** `test/client.test.mjs`：用 `vm.runInNewContext` + 伪造 `window.__ModuleLoader__.load` 捕获工厂，调用 `factory(() => ({}))` 得到 `helpers`；断言：地址编解码往返与非法地址拒绝、`capText`/`quoteBlock`/`firstLine`、`buildOpeningDraft` 含块引用与边界说明、`onInteraction` 只认领 `contextmenu` 且有文本、只读会话被拒。用 `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/*.test.mjs` 运行。

**安装与启用**（会改 profile，需以计划获批为前提）：`plugin_manager action=list_bundles` 确认无同名 bundle → `action=install_bundle target=<path-to-checkout>`（本地绝对路径，链接该 checkout；无依赖/无 build script，无需 `approvedBuilds`）→ 读 `application`，必须 `applied`；`list_plugins` 确认 `include:side-chat` 为 enabled/active。**不手工改 `$DSH_PROFILE_DIR` 的 package.json/patch，不在 profile 目录跑 pnpm**。

**页面验证**：刷新**现有** `<web-gui-url>`（不启动替代服务器；HMR 自动生效只在 `pnpm run dev:web` 监视器运行时成立，先核实该 watcher，未运行就明确要求刷新）。按 `verification.md`：检查控制台无 `slot entry crashed`、明暗主题下浮层/标签样式、无横向溢出；若 cua 仍不可用，明确报告「已验证代码与安装状态，运行页面视觉未验证」。

**手工流程验证**：在一条有内容的 Chat 里拖选一段文字并**右键** → 出现两个按钮 → 「引用到当前聊天」后输入框出现块引用且未发送 → 「在侧边聊天中提问」后右侧栏展开 `sidechat` Chat 标签、草稿含选段引用 + 边界说明且未发送、主会话仍在原位、会话列表出现分叉子会话 → 标签可浮动/关闭、关闭后主会话完好 → 禁用 bundle 后入口消失。按 Enter 一次确认子会话能正常跑一个 agent turn。

**UX 评审**：按 `verification.md` 跑一次 subagent 的 UI/UX 专家评审（发现可发现性、主流程、反馈、视觉一致性问题），把结论与「哪些验证未能运行」写进交付报告。

---

## 7. 对 profile 的影响与回滚

`install_bundle` 影响该 profile 的所有会话并持久保存；本地目录安装是链接 `<path-to-checkout>` 这个 checkout，因此仓库即真源。回滚：`plugin_manager action=remove_bundle target=@local/dsh-side-chat`，然后刷新页面。Client 半部迭代只需刷新页面；Host 半部改动需要 `remove_bundle` + `install_bundle`（且行名换一个新的）或重启 DSH（Host 模块按行 specifier 缓存）。

---

## 8. 明确不在 v1 范围（v2 候选）

隐藏的 developer/system 边界提示（需 Host `agent/created` + `ctx.systemPrompt.section()`）、Host service + agent tool 的「一次操作两个调用者」、`/side` 斜杠命令、右侧栏引导页卡片、关标签自动归档（ephemeral）、只显示边界之后的新回合、自定义 Markdown 面板、子会话标题定制、更多语言、发布到 npm/插件市场。

---

## 9. 假设

1. 「照着 codex 做」按**基于 fork 的侧边聊天**理解（而非 `dsh-select-ask` 那种不留 Session 的一次性小窗）；若你要的是后者，计划需替换。
2. 触发方式选右键选区是为了与已启用的内置「引用文本」共存；拖选保持内置行为。
3. v1 允许子会话持久存在于会话列表（DSH 原生语义），Codex 的「关闭即丢弃」作为 v2 可选项。
4. 允许把插件安装并启用到当前 desktop profile 以完成验证；若只想要 `<path-to-checkout>` 里的仓库产物、不装进 profile，可删去第 6 节的安装步骤。
5. `<path-to-checkout>` 作为实现阶段的工作目录；会话默认工作区 `<default-workspace>` 保持不动。
