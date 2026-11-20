# 侧边聊天（Codex 风格）— DSH 插件

一个给 Web 聊天加上 **Codex 风格侧边聊天** 的 DSH 插件。右键选中聊天里的文字后会出现两个动作：

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

1. 在一条有内容的 Chat 里**选中一段文字并右键**。（拖选仍归内置的「引用文本」；本插件只认领 `contextmenu` 手势，二者不冲突。）
2. 点「引用到当前聊天」→ 输入框出现块引用，未发送。
3. 点「在侧边聊天中提问」→ 创建真实的子 Session 并出现在会话列表；右侧栏打开 `sidechat` Chat 标签；草稿含选段块引用 + 可见的边界说明，仍未发送。
4. 在侧边聊天里输入并按 **Enter** 才真正发起一次模型回合（可能包含工具调用）。关闭标签不会影响主会话。

## 侧边聊天的实际语义

- 是用 `ctx.sessions.fork()` 创建的**普通 Session**（不传 `atSeq` = 从最后完成回合分叉）。它留在会话列表里；关闭标签**不会**删除它，不是无痕线程。
- 选段截断到 8000 字符，以 Markdown 块引用预填，后面跟一段**可见**的本地化边界说明：继承历史仅作参考、不要继续执行主任务、不要改文件、除非明确要求否则不要运行工具。
- 标签体复用共享 Conversation 装配（`conversation.content`，`variant: 'embedded'`）并固定 Chat View，外面用 `SessionProvider` 包住一个 `sessions.retain()` 引用。标签关闭或插件卸载时会 `release()` 该引用。
- 草稿初始化发生在标签自己的引用持有期间，因此草稿不会因 Session scope 拆卸而丢失，重复打开同一地址时也不会重复预填。

## 与 Codex 的差异（v1 范围）

| Codex | 本插件 v1 |
| --- | --- |
| 隐藏的 developer/system 边界提示 | 预填草稿里的**可见**说明 |
| 关闭即丢弃的临时线程 | 保留在会话列表里的**持久** Session |
| 只显示边界之后的新回合 | 继承历史在子会话中可见 |
| `chatgpt.addToThread` | 同一浮层的「引用到当前聊天」动作（加上内置拖选引用） |
| `/side` 命令、侧栏选择器、agent 工具 | v1 不做 |

v1 还**不做**：隐藏 system prompt 注入（需要 Host `agent/created` 监听 + `ctx.systemPrompt.section()` + Host service 和 agent tool，让一次操作有两个调用者）、关标签自动归档、子会话标题定制、更多语言、发布到 npm / 插件市场。

## 交互说明与 v1 已知限制

- **只有在选区范围内右键**才会出现自定义浮层；在选区外右键仍是浏览器原生菜单。插件认领手势时会调用 `preventDefault()` 抑制原生菜单，因此复制请用 Cmd/Ctrl+C 或拖选。拖选 `selection` 手势刻意仍归内置的「引用文本」——正因为要与之共存，v1 没有应用内提示、斜杠命令或右栏引导卡片；发现入口只有 `meta.description` 和本文档。
- **`sessions.fork()` 进行中**两个按钮会禁用，第二个按钮显示「正在创建侧边聊天…」。失败时在主会话输入框显示本地化错误提示，不开空标签、保留选区；成功后浮层消失、标签打开（没有额外的成功 toast）。
- **v1 无法把已关闭的标签重新以并排方式打开。** 子会话是普通 Session，可以在主视图打开；暂无「最近关闭的侧边聊天」入口。
- **fork 成功但打开标签失败时**，已创建的子会话仍留在会话列表里（错误文案会说明）。标签体本身有本地化的加载 / 失败状态，不会一直停在「正在打开侧边聊天…」。
- **选段截断到 8000 字符**（不会把代理对切成半个 emoji），预填草稿里没有可见的「已截断」标记。
- **在侧边聊天里也可以右键**，因此可以再分叉出孙级侧边聊天；v1 不限制这种递归。
- 草稿里的边界说明只写给模型看；「不会自动发送」的保证写在 `meta.description` 和文档里，而不是写进会被发送出去的草稿。

## 与 `dsh-select-ask` 的区别

`dsh-select-ask` 打开的是一个不留 Session 的一次性小窗，并用模块级单例桥取回来源 `sessionId`。本插件用 `sessions.fork()` 创建真实且列入列表的 Session，用完整的右侧栏 Chat 标签承载，并且从交互浮层的 **session 作用域 slot props** 直接取 `sessionId`——没有全局桥、没有共享单例。子会话会出现在会话列表中，之后还能继续。

## 开发注意

- **Host 半部**（`index.js`）是空的 `apply()`。全部行为在 Client 半部，所以改 `client.js` 只需**刷新页面**（只有当 DSH checkout 里 `pnpm run dev:web` 监视器运行时 HMR 才会自动生效）。
- 改 **Host 半部**需要重启 DSH，或 `remove_bundle` + `install_bundle` 且**换一个新的行名**，因为 Host 模块按行 specifier 缓存。
- 不要手工改 `$DSH_PROFILE_DIR/package.json` 或 `cordis.patch.yml`，也不要在 profile 目录跑 `pnpm`；这些步骤由 `install_bundle` 负责。
- Client 模块不 `require` 任何 DSH Client 包、不向 `document.body` 追加节点、不加全局 DOM 监听、不新增 Session 事件类型。所有注册（locale、interaction、resource provider、tab 类型、slot 注入）都在 `ctx.effect` / `ctx.inject` 生命周期内，禁用插件即全部撤销。
- 在本目录运行 `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --check client.js` 与 `--test test/*.test.mjs` 校验语法和纯函数。

## 文件

`package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md`、`README.zh.md`、`test/client.test.mjs`、`.gitignore`、`PLAN.md`。
