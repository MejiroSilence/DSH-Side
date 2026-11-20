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

## v2 batch A (current)

`client.js` now has four ways in, and a closed tab can be brought back side-by-side:

| Entry | What it does |
| --- | --- |
| **Right-click inside a selection** | The original two-button surface (Quote / Ask in side chat) |
| **`/side`** | Slash command that forks a blank side chat from the current session |
| **Right-Sidebar guide capsule** | Opens the **Side chat** home page |
| **Home page** | Explains the flows, starts a blank side chat, lists **Recent side chats** |

- **Recent side chats** live in browser `localStorage` (`dsh.sidechat.recent`, 20 entries max). Closing a tab does not delete the child; clicking an entry calls `openResource` on the **same address**, so the existing tab is revealed — no new fork, no duplicate draft. An entry whose child is no longer in the session list is removed with a localized notice.
- `/side` and the home page create a blank side chat: the draft has a localized "no selection" line plus the boundary note, no empty blockquote.
- **Recursion is capped at 3 levels** (`depth` in the address; v1 addresses parse as depth 0, so old tabs still work). Forking from a too-deep side chat shows a localized error instead of creating a grandchild.
- **Truncated selections get a visible note** after the boundary, never inside the quoted text.
- A failed tab open still records the child **together with its staged prompt**, so retrying from the home page restores the original quoted selection instead of opening an empty draft. The prompt is cleared once the retry succeeds.
- Batch A is **Client-only**: no Host changes, no Config schema, no new Session events, no new row name. A page refresh is enough.

## Differences from Codex

| Codex | This bundle |
| --- | --- |
| Hidden developer/system boundary between inherited history and the new question | A **visible** note in the prefilled draft (hidden boundary is batch B) |
| Ephemeral side thread discarded on close | A **persistent** Session in the list |
| Only new turns after the boundary are shown | Inherited history is visible in the child Session |
| `chatgpt.addToThread` | The same floating surface's **Quote in current chat** action (plus the built-in drag-selection quote) |
| `/side` command, side-chat picker, agent tool | `/side` + guide capsule + home page (batch A); agent tool is batch B |

Still **not** implemented (see [PLAN.v2.md](PLAN.v2.md)): hidden system-prompt injection, Host service + agent tool, Config schema, a success-notice toggle, custom child titles, more languages, auto-archiving on close, boundary-only turn filtering, publishing to npm / a plugin market.

## UX notes and current limitations

- **Right-click still only works inside the selection rect**; outside it the native browser menu stays. Claiming the gesture calls `preventDefault()`, so copy with Cmd/Ctrl+C or drag-selection. Drag-selection still belongs to the built-in **Quote text**.
- **While `sessions.fork()` is in flight** the two buttons are disabled and the second reads "Creating side chat…". On failure a localized error notice appears on the parent composer, no empty tab opens, and the selection stays. On success the surface dismisses and the tab opens — there is still **no success toast** (a `successNotice` Config switch is planned for batch B).
- The child is a **normal persistent Session**; closing the tab does not delete it. It can now be reopened side-by-side from Recent side chats, but there is no auto-archiving.
- The tab body shows localized loading and failure states instead of an endless "Opening side chat…".
- **Selections are capped at 8000 characters** (surrogate pairs are never split in half); a visible truncated note is appended.
- Right-clicking inside a side chat still works, up to the depth limit.
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

`package.json`, `cordis.patch.yml`, `index.js`, `client.js`, `locale/en.json`, `locale/zh.json`, `icon.svg`, `README.md`, `README.zh.md`, `test/client.test.mjs`, `.gitignore`, `PLAN.md`, `PLAN.v2.md`.
