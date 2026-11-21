# 侧边聊天（Codex 风格）— DSH 插件

[English](README.md) | 简体中文

一个给 Web 聊天加上 **Codex 风格侧边聊天** 的 DSH 插件。在聊天里框选文字后会自动浮出两个动作：

| 动作 | 行为 |
| --- | --- |
| **引用到当前聊天** | 把选段作为 Markdown 块引用插入**当前**输入框；不发送。 |
| **在侧边聊天中提问** | 调用 `session.fork()`（省略 `atSeq`，从最后完成回合分叉），把选段作为子会话的开场上下文预填，并在右侧栏以 **Chat** 标签并排打开子会话；主视图不变；不发送。 |

针对 **DeepSeek Harness 0.2.2-rc.5** 开发并核查。包内不声明 `engines.dsh`，避免预发布版本号阻断安装。

## 安装

在具备 Plugin Manager 工具的 DSH 会话中安装本地目录：

```
plugin_manager action=install_bundle target=<path-to-checkout>
```

随后**刷新现有 Web 页面**（打开 `dsh web` 打印的 URL）。本地目录安装是链接到本 checkout，因此本仓库即真源。检查 `application` 为 `applied`，且 `include:side-chat` 行已启用 / active。

回滚：`plugin_manager action=remove_bundle target=@local/dsh-side-chat`，然后刷新页面。

## 使用

1. 在一条有内容的 Chat 里**选中一段文字**，双按钮浮层会自动出现——不需要右键。右键保留浏览器原生菜单，可以正常复制选区。
2. 点「引用到当前聊天」→ 输入框出现块引用，未发送。
3. 点「在侧边聊天中提问」→ 创建真实的子 Session 并出现在会话列表；右侧栏打开 `sidechat` Chat 标签；草稿只有选段块引用（developer 边界藏在 system prompt 里），仍未发送。
4. 在侧边聊天里输入并按 **Enter** 才真正发起一次模型回合（可能包含工具调用）。关闭标签不会影响主会话。

## 侧边聊天的实际语义

- 是用 `ctx.sessions.fork()` 创建的**普通 Session**（不传 `atSeq` = 从最后完成回合分叉）。它留在会话列表里；关闭标签**不会**删除它，不是无痕线程。
- 选段截断到 8000 字符，以 Markdown 块引用预填。developer 边界（继承历史仅作参考、不要继续执行主任务、不要改文件、除非明确要求否则不要运行工具）作为**隐藏**的 system prompt section 下发，不写进草稿。
- 标签体复用共享 Conversation 装配（`conversation.content`，`variant: 'embedded'`）并固定 Chat View，外面用 `SessionProvider` 包住一个 `sessions.retain()` 引用。标签关闭或插件卸载时会 `release()` 该引用。
- 草稿初始化发生在标签自己的引用持有期间，因此草稿不会因 Session scope 拆卸而丢失，重复打开同一地址时也不会重复预填。

## v2 批次 A（当前版本）

`client.js` 现在有四个入口，且关闭的标签可以重新并排打开：

| 入口 | 行为 |
| --- | --- |
| **在 Chat 里框选文字** | 双按钮浮层自动出现（引用到当前聊天 / 在侧边聊天中提问） |
| **`/side`** | 斜杠命令，从当前会话分叉一个空白侧边聊天 |
| **右栏引导页卡片** | 打开「侧边聊天」首页 |
| **首页** | 说明用法、新建空白侧边聊天、列出**最近的侧边聊天** |

- **最近的侧边聊天**存在浏览器 `localStorage`（`dsh.sidechat.recent`，最多 20 条）。关闭标签不会删除子会话；点列表项会用**同一个地址** `openResource`，揭示已有标签——不会重新 fork、不会重复预填。若子会话已不在会话列表，记录会被移除并给出本地化提示。
- `/side` 与首页创建的是空白侧边聊天：草稿里是本地化的「无选段」说明，没有空块引用；批次 B 之后也不再带边界说明。
- **递归上限 3 层**（地址里带 `depth`；v1 地址按 depth 0 解析，旧标签仍可用）。从过深的侧边聊天再分叉会给出本地化错误，而不是创建孙级会话。
- **超长选段有可见的截断说明**，位置在块引用之后，不会污染块引用。
- 打开标签失败时会把该子会话**连同尚未写入的草稿**一起记录，从首页重试会恢复原来的引用选段，而不是打开一个空白草稿；重试成功后草稿记录会被清除。
- 批次 A **只改 Client 半部**：不动 Host、不新增 Config schema、不新增 Session 事件、不换行名，刷新页面即可生效。

## v2 批次 B（当前版本）

Host 半部现在把 developer 边界作为**隐藏**的 system prompt section 下发，所以侧边聊天草稿里只剩选段引用——没有可见的说明文字。创建侧边聊天**不涉及任何 Client→Host 远程调用**。

| 部分 | 职责 |
| --- | --- |
| Client（`client.js`） | 用已验证的 `ctx.sessions.fork()` 建子会话，暂存干净草稿（块引用 + 可选的无选段/截断说明），打开标签 |
| Host（`index.js`） | `agent/created` 时安装 `ctx.systemPrompt.section()`，其 `text()` 只对 fork 出来的 Session 返回边界文案 |
| Agent 工具 | `side_chat_create` 仍调用 Host 的 `createSideChat()` |

- **Host 如何认出侧边聊天**：Client 给每个子会话用 `session.rename` 设一个持久化的 `Side chat: ` 标题前缀（用的是已有的 `session/title` 事件）。section 的 `text()` 在组装 prompt 时同时检查：该会话是 fork（`header.isSeeded`）、不是 subagent、且 `title` 投影以该前缀开头。**用户手动 fork 出来的普通会话**（标题形如 `Parent (2)`）不匹配，因此完全不会收到边界。标记存在 session log 里，**DSH 重启后依然有效**——没有进程内缓存、不新增事件类型、不需要 Client→Host 远程调用。
- 注册是双 owner（`agent.ctx` fiber + 插件自己的 effect），并有 `agent/disposed` 清理。
- **Config**（`cordis.patch.yml` 行的 `config`）：`hiddenBoundary`（默认 `true`）、`successNotice`（默认 `false`）、`boundaryText`（覆盖 developer 文案）。关掉 `hiddenBoundary` 会完全移除隐藏 section，草稿里也不会出现边界说明。
- **行改名为 `side-chat-v2`**，以让 Host 模块重新加载（Host 模块按行 specifier 缓存）。`list_plugins` 显示 `include:side-chat-v2`；Client 模块 id、资源协议、tab kind、interaction id、地址格式都不变。
- **改 Host 代码**需要 `remove_bundle @local/dsh-side-chat` → `install_bundle <path-to-checkout>`，或重启 DSH。只改 Client 需要让 DSH 窗口重新加载——可靠做法是 `Cmd+Q` 完全退出再重开（HMR 只重拉模块脚本，不会重跑 `apply`）。

**可见变化**：子会话在会话列表里的标题变成 `Side chat: <选段首行>`，不再是默认的 `Parent (2)`。若这次改名失败，草稿会回退成可见的边界说明，保证指令不会悄悄丢失。

**已知限制**：`maxDepth` / `recentLimit` 仍是 Client 常量（批次 C）。`side-chat-fork` session command 仍保留注册以兼容，但 Web UI 已不再使用它——session command 会往来源 Session 的日志写 `command/run` / `command/done`。

## 与 Codex 的差异

| Codex | 本插件 |
| --- | --- |
| 隐藏的 developer/system 边界提示 | fork 会话上的**隐藏** system prompt section（批次 B） |
| 关闭即丢弃的临时线程 | 保留在会话列表里的**持久** Session |
| 只显示边界之后的新回合 | 继承历史在子会话中可见 |
| `chatgpt.addToThread` | 同一浮层的「引用到当前聊天」动作（框选时取代内置的单按钮「引用文本」） |
| `/side` 命令、侧栏选择器、agent 工具 | `/side` + 引导卡片 + 首页（批次 A）；agent 工具属批次 B |

仍**未实现**（见 [PLAN.v2.md](PLAN.v2.md)）：子会话标题定制、更多语言、关标签自动归档、只显示边界之后的新回合、发布到 npm / 插件市场。批次 C 还包括 `maxDepth` / `recentLimit` 的 Config 化，以及隐藏边界跨重启的持久化。

## 交互说明与当前限制

- **框选即弹出浮层，右键不再触发自定义浮层**。右键在任何位置都保留浏览器原生菜单（复制/粘贴照常）。内置的单按钮「引用文本」在框选时被我们的双按钮浮层取代，因此不再需要右键这一步。
- **`sessions.fork()` 进行中**两个按钮会禁用，第二个显示「正在创建侧边聊天…」。失败时在主会话输入框显示本地化错误、不开空标签、保留选区；成功后浮层消失、标签打开——**仍没有成功 toast**。
- 子会话是**普通持久 Session**；关闭标签不删除，现在可从「最近的侧边聊天」重新并排打开，但还没有自动归档。
- 标签体有本地化的加载 / 失败状态，不会一直停在「正在打开侧边聊天…」。
- **选段截断到 8000 字符**（不会把代理对切成半个 emoji），并有可见的截断说明。
- 在侧边聊天里框选文字同样会弹出浮层，但受递归层数上限约束。
- 隐藏边界只写给模型看；发送出去的草稿只含块引用。「不会自动发送」的保证写在 `meta.description` 和文档里。

## 与 `dsh-select-ask` 的区别

`dsh-select-ask` 打开的是一个不留 Session 的一次性小窗，并用模块级单例桥取回来源 `sessionId`。本插件用 `sessions.fork()` 创建真实且列入列表的 Session，用完整的右侧栏 Chat 标签承载，并且从交互浮层的 **session 作用域 slot props** 直接取 `sessionId`——没有全局桥、没有共享单例。子会话会出现在会话列表中，之后还能继续。

## 开发注意

- **Host 半部**（`index.js`）负责创建操作、隐藏 prompt section、Config schema 与 agent 工具；**Client 半部**（`client.js`）负责全部视图：浮层、首页、最近列表、标签体、资源提供者。
- 改 `client.js` 只需**刷新页面**（只有当 DSH checkout 里 `pnpm run dev:web` 监视器运行时 HMR 才会自动生效）。
- 改 `index.js` / `cordis.patch.yml` 需要重启 DSH，或 `remove_bundle` + `install_bundle` 且**换一个新行名**，因为 Host 模块按行 specifier 缓存。
- 不要手工改 `$DSH_PROFILE_DIR/package.json` 或 `cordis.patch.yml`，也不要在 profile 目录跑 `pnpm`；这些步骤由 `install_bundle` 负责。
- Client 模块不 `require` 任何 DSH Client 包、不向 `document.body` 追加节点、不加全局 DOM 监听、不新增 Session 事件类型。所有注册（locale、interaction、resource provider、tab 类型、slot 注入）都在 `ctx.effect` / `ctx.inject` 生命周期内，禁用插件即全部撤销。
- 在本目录运行 `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --check client.js` 与 `--test test/*.test.mjs` 校验语法和纯函数。

## 文件

`package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md`、`README.zh.md`、`test/client.test.mjs`、`.gitignore`、`PLAN.md`、`PLAN.v2.md`。
