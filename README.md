# Side chat (Codex-style) — DSH bundle

A small DSH Web plugin that adds a **Codex-style side chat** to the Chat view. Right-click a selected piece of chat text and you get two actions:

| Action | What it does |
| --- | --- |
| **Quote in current chat** | Inserts the selection as a Markdown blockquote into the *current* composer. Nothing is sent. |
| **Ask in side chat** | Calls `session.fork()` (from the last completed turn), stages the selection as the child's opening context, and opens the child Session's **Chat** in a tab on the right sidebar, next to the unchanged main view. Nothing is sent. |

Developed and verified against **DeepSeek Harness 0.2.2-rc.5**. The package declares no `engines.dsh` so the prerelease version does not block installation.

## Install

In a DSH session with the Plugin Manager tool, install the local directory:

```
plugin_manager action=install_bundle target=<path-to-checkout>
```

Then **refresh the existing Web page** (open the URL printed by `dsh web`). The bundle is linked to this checkout, so this repository is the source of truth. Check that `application` is `applied` and that the `include:side-chat` row is enabled/active.

Rollback: `plugin_manager action=remove_bundle target=@local/dsh-side-chat`, then refresh the page.

## Use

1. In a Chat with content, **select some text and right-click it**. (A plain drag-selection still belongs to the built-in **Quote text** action; this plugin only claims the `contextmenu` gesture, so the two never fight over the same gesture.)
2. **Quote in current chat** → the composer gains a blockquote; the message is not sent.
3. **Ask in side chat** → a real child Session is created and appears in the session list; a `sidechat` Chat tab opens on the right; its draft contains the quoted selection plus a visible boundary note, still unsent.
4. Type anything you like and press **Enter** in the side chat to actually run a model turn (including tool calls). Closing the tab leaves the main Session untouched.

## What the side chat actually is

- A **normal Session** created with `ctx.sessions.fork()` (no `atSeq` → fork from the latest completed-turn prefix). It stays in the session list; closing the tab does **not** delete it. It is not ephemeral.
- The selected text is capped at 8000 characters and prefilled as a Markdown blockquote, followed by a **visible** localized boundary note explaining that inherited history is reference only, that the parent task is not to be continued, and that files/tools should not be touched unless asked.
- The tab body reuses the shared Conversation assembly (`conversation.content` with `variant: 'embedded'`) with a fixed Chat view, wrapped in a `SessionProvider` around a `sessions.retain()` reference. That reference is released when the tab closes or the plugin unloads.
- Draft initialization happens while the tab's own reference is held, so the draft survives scope teardown and is not repeated when an existing tab is revealed again.

## Differences from Codex (and v1 scope)

| Codex | This bundle v1 |
| --- | --- |
| Hidden developer/system boundary between inherited history and the new question | A **visible** note in the prefilled draft |
| Ephemeral side thread discarded on close | A **persistent** Session in the list |
| Only new turns after the boundary are shown | Inherited history is visible in the child Session |
| `chatgpt.addToThread` | The same floating surface's **Quote in current chat** action (plus the built-in drag-selection quote) |
| `/side` command, side-chat picker, agent tool | Not in v1 |

Also **not** in v1: hidden system-prompt injection (would need a Host `agent/created` listener, `ctx.systemPrompt.section()`, a Host service and an agent tool so one operation has two callers), auto-archiving on tab close, custom titles, extra languages, publishing to npm or a plugin market.

## UX notes and known v1 limitations

- **The custom surface appears only when you right-click *inside the selected text*.** Right-clicking outside the selection keeps the browser's native context menu. When the plugin claims the gesture it calls `preventDefault()` to suppress the native menu, so use Cmd/Ctrl+C or drag-selection to copy. The `selection` (drag) gesture deliberately still belongs to the built-in **Quote text** action — that coexistence is why there is no in-app hint, slash command or sidebar guide card in v1. The `meta.description` and this README are the only discovery path.
- **While `sessions.fork()` is in flight** the two buttons are disabled and the second reads "Creating side chat…". On failure a localized error notice appears on the parent composer, no empty tab opens, and the selection stays. On success the surface dismisses and the tab opens (there is no extra success toast).
- **A closed tab cannot be reopened side-by-side in v1.** The child is a normal Session and can be opened in the main view; there is no "recently closed side chats" affordance yet.
- **If tab opening fails after a successful fork**, the already-created child remains in the session list (the error text says so). The tab body itself shows localized loading and failure states instead of an endless "Opening side chat…".
- **Selections are capped at 8000 characters** (surrogate pairs are never split in half). There is no visible "truncated" marker in the prefilled draft.
- **Right-clicking inside a side chat works too**, so a grandchild side chat can be created; v1 does not limit that recursion.
- The boundary note in the draft is model-facing instruction text only. The "nothing is sent automatically" guarantee lives in `meta.description` and the README, not in the draft that gets sent.

## Differences from `dsh-select-ask`

`dsh-select-ask` opens a one-off small window that leaves no Session behind and uses a module-level singleton bridge to recover the source `sessionId`. This bundle instead creates a real, listed Session via `sessions.fork()`, hosts it in a full right-Sidebar Chat tab, and reads `sessionId` from the **session-scoped slot props** of the interaction surface — no global bridge, no shared singleton. The child appears in the session list and can be resumed later.

## Development notes

- **Host half** (`index.js`) is an empty `apply()`. All behavior is in the Client half, so changes to `client.js` only require a **page refresh** (HMR applies automatically only while `pnpm run dev:web` is running from the DSH checkout).
- Changes to the **Host half** need a DSH restart, or `remove_bundle` + `install_bundle` with a **new row name**, because Host modules are cached by row specifier.
- Do not edit `$DSH_PROFILE_DIR/package.json` or `cordis.patch.yml` by hand, and do not run `pnpm` in the profile directory; `install_bundle` owns those steps.
- The Client module never `require`s a DSH Client package, never appends to `document.body`, never adds a global DOM listener, and never writes a new Session event type. Every registration (locale, interaction, resource provider, tab type, slot injections) lives inside `ctx.effect` / `ctx.inject`, so disabling the bundle removes all entries.
- Run `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --check client.js` and `--test test/*.test.mjs` from this directory to validate syntax and pure helpers.

## Files

`package.json`, `cordis.patch.yml`, `index.js`, `client.js`, `locale/en.json`, `locale/zh.json`, `icon.svg`, `README.md`, `README.zh.md`, `test/client.test.mjs`, `.gitignore`, `PLAN.md`.
