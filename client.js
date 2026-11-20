/**
 * Browser half of the Codex-style Side Chat bundle.
 *
 * A right-click on a Chat text selection claims the `contextmenu` gesture (the
 * built-in `message-quotes` plugin keeps `selection`), and offers two actions:
 * quote into the current composer, or fork a real child Session and show its
 * Chat in a right-Sidebar tab. Nothing is sent automatically.
 *
 * v2 batch A adds three more entry points and recovery: a `/side` command, a
 * right-Sidebar guide capsule + home page, and a "recent side chats" list that
 * reopens a closed tab side-by-side. It also caps recursion depth, marks
 * truncated selections, and keeps failed opens retryable.
 *
 * The module is a lazy `window.__ModuleLoader__` factory. React comes from the
 * browser module table; no DSH Client package is required at runtime.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-side-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'sideChat';
    const PLUGIN_ID = '@local/dsh-side-chat';
    const INTERACTION_ID = 'side-chat';
    const ADDRESS_PREFIX = 'dsh-resource://sidechat/session/';
    const ADDRESS_PATTERN = 'dsh-resource://sidechat/**';
    const MAX_TEXT = 8000;
    // v2: the resource-only `sidechat` kind cannot be opened as a page, so the
    // guide capsule and `/side` lead to a separate page kind.
    const HOME_KIND = 'sidechat-home';
    const HOME_ID = '@local/dsh-side-chat/home';
    const RECENT_KEY = 'dsh.sidechat.recent';
    const RECENT_LIMIT = 20;
    const MAX_DEPTH = 3;

    // ---------------------------------------------------------------------
    // Pure helpers. Exported on the plugin face's `helpers` seat so the unit
    // tests exercise this exact source through `vm`.
    // ---------------------------------------------------------------------

    /** `depth` is v2-only; omitting it keeps the v1 address byte-for-byte. */
    function encodeAddress({ child, parent, label, depth }) {
      if (child === undefined || child === null || child === ''
        || parent === undefined || parent === null || parent === '') return undefined;
      const query = new URLSearchParams();
      query.set('parent', String(parent));
      if (label !== undefined && label !== null && label !== '') query.set('label', String(label));
      if (Number.isFinite(depth) && depth > 0) query.set('depth', String(Math.floor(depth)));
      return `${ADDRESS_PREFIX}${encodeURIComponent(String(child))}?${query.toString()}`;
    }

    /** v1 addresses without `depth` parse as depth 0 (backwards compatible). */
    function parseAddress(value) {
      if (typeof value !== 'string' || value === '') return undefined;
      let url;
      try {
        url = new URL(value);
      } catch (_invalidUrl) {
        return undefined;
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'sidechat') return undefined;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 2 || parts[0] !== 'session') return undefined;
      const parent = url.searchParams.get('parent');
      if (parent === null || parent === '') return undefined;
      let child;
      try {
        child = decodeURIComponent(parts[1]);
      } catch (_invalidEncoding) {
        return undefined;
      }
      if (child === '') return undefined;
      const rawDepth = Number.parseInt(url.searchParams.get('depth') ?? '0', 10);
      const depth = Number.isSafeInteger(rawDepth) && rawDepth > 0 ? rawDepth : 0;
      return { child, parent, label: url.searchParams.get('label') ?? '', depth };
    }

    function capText(text, max = MAX_TEXT) {
      const value = String(text ?? '');
      const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_TEXT;
      if (value.length <= limit) return value;
      // Never cut a UTF-16 surrogate pair in half (a broken emoji at the cap).
      const last = value.charCodeAt(limit - 1);
      const end = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
      return value.slice(0, end);
    }

    function quoteBlock(text) {
      return String(text ?? '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
    }

    function firstLine(text, max = 28) {
      const line = String(text ?? '').split('\n').find(candidate => candidate.trim() !== '') ?? '';
      const trimmed = line.trim();
      const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 28;
      return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
    }

    /**
     * v1 text with no selection produces no blockquote; a truncated selection
     * gets a visible note AFTER the boundary, never inside the quoted text.
     */
    function buildOpeningDraft(text, t, truncated = false) {
      const value = String(text ?? '');
      const hasQuote = value.trim() !== '';
      const quote = hasQuote ? `${quoteBlock(value)}\n\n` : '';
      const noSelection = hasQuote ? '' : `${t('draft.noSelection')}\n\n`;
      const truncation = truncated ? `\n\n${t('draft.truncated')}` : '';
      return `${noSelection}${quote}${t('draft.boundary')}${truncation}`;
    }

    /** Shared writable-Session gate for both the right-click and `/side`. */
    function writableSession(binding) {
      if (binding === undefined || binding === null || binding.session === undefined) return false;
      const session = binding.session.getSnapshot();
      if (session.removed) return false;
      if (session.subagent !== null && session.subagent !== undefined
        && session.subagent.address.mode !== 'continuable') return false;
      return true;
    }

    /**
     * Mirror the built-in Quote plugin's writable-Session gate. Only a
     * `contextmenu` gesture with a real text selection in a continuable Session
     * is admitted; drag-selection stays with `message-quotes`.
     */
    function admitInteraction(request, binding) {
      if (request === undefined || request === null || request.trigger !== 'contextmenu') return false;
      if (typeof request.readText !== 'function' || request.readText() === null) return false;
      return writableSession(binding);
    }

    function waitForAbort(signal) {
      if (signal.aborted) return Promise.resolve();
      return new Promise(resolve => {
        signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
    }

    // ---------------------------------------------------------------------
    // v2: recent side chats. Pure list functions + a localStorage-backed
    // store. No Host storage, no new Session events, no module-level singleton
    // holding a sessionId.
    // ---------------------------------------------------------------------

    function isRecentEntry(value) {
      if (value === null || typeof value !== 'object'
        || typeof value.child !== 'string' || value.child === ''
        || typeof value.parent !== 'string' || value.parent === ''
        || typeof value.address !== 'string'
        || typeof value.label !== 'string'
        || !Number.isSafeInteger(value.depth) || value.depth < 0
        || !Number.isFinite(value.createdAt)
        || !(value.prompt === undefined || typeof value.prompt === 'string')) return false;
      // Cross-check the address: never validate one child and open another.
      const parsed = parseAddress(value.address);
      return parsed !== undefined && parsed.child === value.child && parsed.parent === value.parent;
    }

    function sanitizeRecent(list) {
      return Array.isArray(list) ? list.filter(isRecentEntry) : [];
    }

    /** Newest first, de-duplicated by child, bounded by `limit`. */
    function addRecent(list, entry, limit = RECENT_LIMIT) {
      const clean = sanitizeRecent(list);
      if (!isRecentEntry(entry)) return clean;
      const without = clean.filter(item => item.child !== entry.child);
      const capped = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : RECENT_LIMIT;
      return [entry, ...without].slice(0, capped);
    }

    /**
     * Depth of the conversation `sessionId` itself (0 for the main chat).
     * `openSideChat` adds 1 for the new child, so this must NOT add 1 here —
     * doing so double-counts and caps nesting at MAX_DEPTH - 1.
     */
    function depthFor(list, sessionId) {
      const entry = sanitizeRecent(list).find(item => item.child === sessionId);
      return entry === undefined ? 0 : entry.depth;
    }

    function removeRecent(list, child) {
      return sanitizeRecent(list).filter(item => item.child !== child);
    }

    function loadRecent() {
      try {
        const raw = window.localStorage.getItem(RECENT_KEY);
        return raw === null ? [] : sanitizeRecent(JSON.parse(raw));
      } catch (_error) {
        return [];
      }
    }

    function saveRecent(list) {
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
      } catch (_error) {
        console.warn('side-chat: could not persist recent side chats', _error);
      }
    }

    // ---------------------------------------------------------------------
    // Runtime dictionaries (separate from the Plugin Manager locale/*.json).
    // ---------------------------------------------------------------------

    const zh = {
      'action.quote': '引用到当前聊天',
      'action.ask': '在侧边聊天中提问',
      'action.busy': '正在创建侧边聊天…',
      'surface.label': '选区操作',
      'tab.title': '侧边聊天',
      'tab.loading': '正在打开侧边聊天…',
      'tab.failed': '无法打开此侧边聊天；子会话仍保留在会话列表中。',
      'command.label': '侧边聊天',
      'command.description': '从当前会话分叉一个新的侧边聊天（不带选段）。',
      'guide.title': '侧边聊天',
      'guide.description': '打开侧边聊天首页：新建侧边聊天，或重新打开最近的一个。',
      'home.title': '侧边聊天',
      'home.intro': '在聊天里选中文字并右键可选择「在侧边聊天中提问」，也可以输入 /side，或直接在下方新建一个空白侧边聊天。',
      'home.new': '新建空白侧边聊天',
      'home.recent': '最近的侧边聊天',
      'home.empty': '还没有侧边聊天。新建一个，或从聊天里右键选段开始。',
      'home.missing': '这个子会话已不在会话列表中，记录已移除。',
      'home.untitled': '空白侧边聊天',
      'home.open': '重新打开',
      'draft.boundary': '上面的引用来自主会话；继承的历史仅作参考。请在侧边聊天中回答，不要继续执行主任务、不要修改文件，除非明确要求否则不要运行工具。',
      'draft.noSelection': '（本次没有附带选段，请在下面补充你想问的内容。）',
      'draft.truncated': '（选段过长，已截断到 8000 字符；块引用中只包含前半部分。）',
      'error.fork': '无法创建侧边聊天，请重试。',
      'error.migration': '请先打开原会话完成迁移，再创建侧边聊天。',
      'error.open': '侧边聊天标签打开失败；已创建的子会话可从「最近的侧边聊天」重新打开。',
      'error.depth': '侧边聊天嵌套层数已达上限，请回到主会话再新建。',
      'notice.opened': '侧边聊天已创建。',
    };

    const en = {
      'action.quote': 'Quote in current chat',
      'action.ask': 'Ask in side chat',
      'action.busy': 'Creating side chat…',
      'surface.label': 'Selection actions',
      'tab.title': 'Side chat',
      'tab.loading': 'Opening side chat…',
      'tab.failed': 'Could not open this side chat. The child Session is still in the session list.',
      'command.label': 'Side chat',
      'command.description': 'Fork a new side chat from this conversation without a selection.',
      'guide.title': 'Side chat',
      'guide.description': 'Open the side chat home page: start a new one or reopen a recent one.',
      'home.title': 'Side chat',
      'home.intro': 'Select text in a chat and right-click it to "Ask in side chat", type /side, or start a blank side chat below.',
      'home.new': 'New blank side chat',
      'home.recent': 'Recent side chats',
      'home.empty': 'No side chats yet. Create one, or start from a right-click on selected text.',
      'home.missing': 'That child Session is no longer in the session list; the entry was removed.',
      'home.untitled': 'Blank side chat',
      'home.open': 'Reopen',
      'draft.boundary': 'The quoted text above comes from the parent chat. Inherited history is for reference only. Please answer in this side chat; do not continue the parent task, do not change files, and do not run tools unless explicitly asked.',
      'draft.noSelection': '(No selection was attached. Add what you want to ask below.)',
      'draft.truncated': '(The selection was too long and was capped at 8000 characters; the quote contains only the first part.)',
      'error.fork': 'Could not create a side chat. Please try again.',
      'error.migration': 'Open the original chat once to finish migration before creating a side chat.',
      'error.open': 'Could not open the side chat tab. The child Session can be reopened from "Recent side chats".',
      'error.depth': 'Side chat nesting limit reached. Return to the main chat to start a new one.',
      'notice.opened': 'Side chat created.',
    };

    // The floating surface and home page are host-styled; only --dsw-alias-*
    // theme tokens are used for color, so they inherit light/dark switching.
    const ACTION_CSS = `
[data-side-chat-actions] {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  box-sizing: border-box;
  max-width: 100%;
  flex-wrap: wrap;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  background: var(--dsw-alias-button-floating-fill);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
[data-side-chat-actions] button {
  padding: 5px 10px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
[data-side-chat-actions] button:hover,
[data-side-chat-actions] button:focus-visible {
  background: var(--dsw-alias-button-floating-hover);
}
[data-side-chat-actions] button:focus-visible {
  outline: 2px solid var(--dsw-alias-border-selected);
  outline-offset: 1px;
}
[data-side-chat-actions] button:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
`;

    const HOME_CSS = `
[data-side-chat-home] {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  min-width: 0;
  height: 100%;
  padding: 16px;
  overflow: auto;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-l1);
  font: inherit;
}
[data-side-chat-home] h2,
[data-side-chat-home] h3 {
  margin: 0;
  font: inherit;
  font-weight: 600;
}
[data-side-chat-home] h2 { font-size: 1.15em; }
[data-side-chat-home] h3 {
  font-size: 1em;
  color: var(--dsw-alias-label-secondary);
}
[data-side-chat-home] p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  line-height: 1.5;
}
[data-side-chat-home] button {
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: var(--dsw-alias-button-floating-fill);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
  text-align: left;
}
[data-side-chat-home] button:hover,
[data-side-chat-home] button:focus-visible {
  background: var(--dsw-alias-button-floating-hover);
}
[data-side-chat-home] button:focus-visible {
  outline: 2px solid var(--dsw-alias-border-selected);
  outline-offset: 1px;
}
[data-side-chat-home] button:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
[data-side-chat-home] [data-side-chat-list] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-side-chat-home] [data-side-chat-list] li {
  min-width: 0;
}
[data-side-chat-home] [data-side-chat-list] button {
  max-width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
`;

    const TAB_ROOT_STYLE = {
      display: 'flex',
      width: '100%',
      height: '100%',
      minWidth: 0,
      minHeight: 0,
    };

    const LOADING_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
    };

    // ---------------------------------------------------------------------
    // Client plugin face.
    // ---------------------------------------------------------------------

    function apply(ctx) {
      const t = ctx.locale.bind(NS);

      // Opening prompts staged by `openSideChat` and consumed exactly once by
      // the resource provider, while the tab itself holds the child reference.
      // Applying the draft here (instead of in a short `sessions.using()`
      // borrow) keeps the input shell alive: the shell is owned by the Session
      // scope fiber, and releasing the last reference before the tab mounts
      // would dispose it and lose the draft.
      const pendingDrafts = new Map();

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat: dictionaries');

      ctx.effect(() => ctx.uiConversation.interactions.register({
        id: INTERACTION_ID,
        onInteraction(request) {
          if (!admitInteraction(request, ctx.sessions.binding(request.sessionId))) return;
          // The host only exposes preventDefault to plugins; it never cancels
          // the browser event itself. Claiming the gesture means showing our
          // own surface instead of the native context menu.
          request.preventDefault();
          request.open();
        },
      }), 'side-chat: contextmenu interaction');

      /** Best-effort localized notice on the parent Session's composer. */
      function notify(sessionId, level, message) {
        try {
          const binding = ctx.sessions.binding(sessionId);
          const conversation = ctx.get('conversation');
          if (binding !== undefined && conversation !== undefined) {
            conversation.input.for(binding.ctx).notify(level, message);
          }
        } catch (_error) {
          // A missing composer must not turn a failure into a crashed slot;
          // at least leave a diagnostic so it is not completely silent.
          console.warn('side-chat: could not show the notice', _error);
        }
      }

      function notifyError(sessionId, message) {
        notify(sessionId, 'error', message);
      }

      /** Parse the Host command's structured result/error payload. */
      function parseCommandPayload(text) {
        try {
          const value = JSON.parse(String(text ?? ''));
          return value !== null && typeof value === 'object' ? value : {};
        } catch (_error) {
          return {};
        }
      }

      /** One fork per parent at a time; `/side` has no component-local busy state. */
      const inFlightParents = new Set();

      /**
       * Create a side chat through the Host's single `createSideChat` operation
       * (reached via the `side-chat-fork` session command; the agent tool calls
       * the same method). The Host returns the child id, the composed draft and
       * the label; this Client half only owns presentation: refresh the catalog,
       * stage the draft and open the tab.
       *
       * `depth` is the depth of the conversation we are forking FROM. A failed
       * tab open keeps the prompt in the recent entry so a retry restores it.
       */
      async function openSideChat(parent, text, onError, depth = 0) {
        if (inFlightParents.has(parent)) return false;
        if (depth >= MAX_DEPTH) {
          onError(t('error.depth'));
          return false;
        }
        inFlightParents.add(parent);
        try {
          let response;
          try {
            response = await ctx.remote.commands.execute(
              parent,
              `/side-chat-fork ${JSON.stringify({ text: String(text ?? ''), depth })}`,
              [],
            );
          } catch (_error) {
            onError(t('error.fork'));
            return false;
          }
          const commandResult = response.ok === true ? response.value : undefined;
          if (commandResult === undefined || commandResult.kind !== 'success') {
            const failure = parseCommandPayload(commandResult === undefined ? '' : commandResult.text);
            onError(failure.code === 'session/migration-required'
              ? t('error.migration')
              : t('error.fork'));
            return false;
          }
          const result = parseCommandPayload(commandResult.text);
          const child = result.childSessionId;
          if (typeof child !== 'string' || child === ''
            || typeof result.draftText !== 'string') {
            onError(t('error.fork'));
            return false;
          }
          const label = typeof result.label === 'string' && result.label !== ''
            ? result.label : t('home.untitled');
          // A Host-side fork does not update the Client catalog; refresh before
          // the resource provider calls sessions.retain(child).
          try {
            await ctx.sessions.refresh();
          } catch (_error) {
            console.warn('side-chat: session catalog refresh failed', _error);
          }
          const prompt = result.draftText;
          const address = encodeAddress({ child, parent, label, depth: depth + 1 });
          pendingDrafts.set(child, prompt);
          const entry = {
            child, parent, address, label, depth: depth + 1, createdAt: Date.now(),
          };
          try {
            ctx.sidebarRight.openResource(address, { kind: 'sidechat', preferNewPane: true });
            saveRecent(addRecent(loadRecent(), entry));
            if (result.successNotice === true) notify(parent, 'info', t('notice.opened'));
            return true;
          } catch (_error) {
            pendingDrafts.delete(child);
            // Retain the prompt so reopenSideChat can prefill on retry.
            saveRecent(addRecent(loadRecent(), { ...entry, prompt }));
            onError(t('error.open'));
            return false;
          }
        } finally {
          inFlightParents.delete(parent);
        }
      }

      /** Reveal an existing side-chat tab; verify the child is still listed. */
      function reopenSideChat(entry, onError) {
        if (!isRecentEntry(entry) || parseAddress(entry.address) === undefined) {
          onError(t('home.missing'));
          return false;
        }
        try {
          const row = ctx.sessions.list.getSnapshot().byId[entry.child];
          if (row === undefined) {
            saveRecent(removeRecent(loadRecent(), entry.child));
            // Informational, not a failure: an archived child is not an error.
            notify(entry.parent, 'info', t('home.missing'));
            return false;
          }
          // Restore a failed open's context; consume it once on success.
          if (typeof entry.prompt === 'string' && entry.prompt !== '') {
            pendingDrafts.set(entry.child, entry.prompt);
          }
          try {
            ctx.sidebarRight.openResource(entry.address, { kind: 'sidechat', preferNewPane: true });
            if (entry.prompt !== undefined) {
              const { prompt: _used, ...rest } = entry;
              saveRecent(addRecent(loadRecent(), rest));
            }
            return true;
          } catch (_error) {
            if (typeof entry.prompt === 'string') pendingDrafts.delete(entry.child);
            onError(t('error.open'));
            return false;
          }
        } catch (_error) {
          onError(t('error.open'));
          return false;
        }
      }

      function SideChatActions(props) {
        const {
          sessionId, inputActions, useSession, dismiss, readText, clearSelection,
        } = props;
        const enabled = useSession(state => !state.removed
          && (state.subagent === null || state.subagent === undefined
            || state.subagent.address.mode === 'continuable'));
        const [busy, setBusy] = React.useState(false);
        React.useEffect(() => { if (!enabled) dismiss(); }, [enabled, dismiss]);
        if (!enabled) return null;

        const onQuote = () => {
          if (busy) return;
          const text = readText();
          if (text === null) { dismiss(); return; }
          // A refused insertion keeps the selection so the user can retry.
          if (!inputActions.insertQuote(capText(text))) return;
          clearSelection();
          dismiss();
        };

        const onAsk = () => {
          if (busy) return;
          const text = readText();
          if (text === null) { dismiss(); return; }
          // Disable both buttons while the fork RPC is in flight: a second
          // click would create another numbered child and another tab.
          setBusy(true);
          void openSideChat(sessionId, text,
            message => notifyError(sessionId, message), depthFor(loadRecent(), sessionId))
            .then(ok => {
              if (ok) { clearSelection(); dismiss(); }
              else setBusy(false);
            })
            .catch(() => { setBusy(false); });
        };

        return h(React.Fragment, null,
          h('style', { 'data-side-chat-styles': '' }, ACTION_CSS),
          h('div', {
            'data-side-chat-actions': '',
            role: 'group',
            'aria-label': t('surface.label'),
            'aria-busy': busy,
          },
          h('button', {
            type: 'button',
            disabled: busy,
            'aria-label': t('action.quote'),
            onPointerDown: event => { event.preventDefault(); },
            onClick: onQuote,
          }, t('action.quote')),
          h('button', {
            type: 'button',
            disabled: busy,
            'aria-label': busy ? t('action.busy') : t('action.ask'),
            onPointerDown: event => { event.preventDefault(); },
            onClick: onAsk,
          }, busy ? t('action.busy') : t('action.ask'))),
        );
      }

      /** v2: guide-page capsule and `/side` both lead here. */
      function SideChatHome(props) {
        const { sessionId } = props;
        const [recent, setRecent] = React.useState(loadRecent());
        const [busy, setBusy] = React.useState(false);
        const items = sanitizeRecent(recent);
        React.useEffect(() => { setRecent(loadRecent()); }, []);

        const onNew = () => {
          if (busy) return;
          setBusy(true);
          void openSideChat(sessionId, '',
            message => notifyError(sessionId, message), depthFor(loadRecent(), sessionId))
            .then(() => { setBusy(false); setRecent(loadRecent()); })
            .catch(() => { setBusy(false); });
        };

        const onReopen = (entry) => {
          const ok = reopenSideChat(entry, message => notifyError(sessionId, message));
          if (!ok) setRecent(loadRecent());
        };

        return h('div', { 'data-side-chat-home': '' },
          h('style', { 'data-side-chat-home-styles': '' }, HOME_CSS),
          h('h2', null, t('home.title')),
          h('p', null, t('home.intro')),
          h('button', { type: 'button', disabled: busy, onClick: onNew },
            busy ? t('action.busy') : t('home.new')),
          h('h3', null, t('home.recent')),
          items.length === 0
            ? h('p', null, t('home.empty'))
            : h('ul', { 'data-side-chat-list': '' },
              ...items.map(item => h('li', { key: item.child },
                h('button', { type: 'button', onClick: () => onReopen(item) },
                  `${item.label} · ${t('home.open')}`)))),
        );
      }

      ctx.effect(() => {
        const dispose = ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
          name: 'conversation.chat.text-interaction',
          key: INTERACTION_ID,
          locale: NS,
        }, SideChatActions));
        return typeof dispose === 'function' ? dispose : () => {};
      }, 'side-chat: text interaction actions');

      // v2: /side command. `commandUi` is optional via ctx.inject so a profile
      // without the commands package parks only this entry, not the plugin.
      ctx.inject(['commandUi'], commandScope => {
        commandScope.effect(() => commandScope.commandUi.register({
          name: 'side',
          label: () => t('command.label'),
          description: () => t('command.description'),
          available: session => writableSession(ctx.sessions.binding(session.sessionId)),
          ui: {
            kind: 'action',
            run: session => {
              void openSideChat(session.sessionId, '',
                message => notifyError(session.sessionId, message),
                depthFor(loadRecent(), session.sessionId));
            },
          },
        }), 'side-chat: /side command');
      });

      ctx.inject(['slots', 'resources', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'conversation'], scope => {
        function FixedChatView(viewProps) {
          return h(React.Fragment, null, viewProps.renderSlot('conversation.session', { view: 'chat' }));
        }

        /** Mirror `ConversationSlotPanel`: compute the embedded Conversation phase. */
        function SideChatConversation({
          sessionId, useSession, useConversation, useSessions, renderFactorySlot,
        }) {
          const session = useSession(value => value);
          const conversation = useConversation(value => value);
          const active = conversation.activeTargets.size > 0
            || (!session.blank && !session.awaitingFirstTurn)
            || session.running;
          const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank';
          const summaryBlank = useSessions(state => state.byId[sessionId]?.blank);
          const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true;
          const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true);
          const phase = settling ? 'settling' : hero ? 'hero' : 'active';
          return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
            slots: { views: FixedChatView },
          });
        }

        function SideChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
          const { tab } = useTabInfo();
          const resource = useResource(tab.contentId);
          const failed = resource.status === 'failed' || resource.failure !== undefined;
          return h('div', { 'data-side-chat': '', style: TAB_ROOT_STYLE },
            failed
              ? h('div', { style: LOADING_STYLE }, t('tab.failed'))
              : resource.value === undefined
                ? h('div', { style: LOADING_STYLE }, t('tab.loading'))
                : h(SessionProvider, { session: resource.value.reference },
                  renderSlot('sidechat.conversation', {})));
        }

        scope.effect(() => scope.resources.register({
          protocol: 'sidechat',
          async *open(address, { signal }) {
            const parsed = parseAddress(address);
            if (parsed === undefined) {
              throw new Error(`side-chat: invalid resource address "${address}"`);
            }
            if (signal.aborted) return;
            const reference = scope.sessions.retain(parsed.child, { source: 'sideChat', signal });
            try {
              const prompt = pendingDrafts.get(parsed.child);
              if (prompt !== undefined) {
                pendingDrafts.delete(parsed.child);
                const conversation = scope.get('conversation');
                if (conversation !== undefined) {
                  try {
                    conversation.input.requestDraftInitialization(reference.binding, {
                      prompt,
                      whenDraftExists: 'append',
                    });
                  } catch (error) {
                    console.warn('side-chat: draft initialization failed', error);
                  }
                }
              }
              yield { ok: true, value: { ...parsed, reference } };
              await waitForAbort(signal);
            } finally {
              reference.release();
            }
          },
        }), 'side-chat: resource provider');

        // v1: resource-only kind. `canOpen` still gates every address.
        scope.effect(() => scope.sidebarRightTabs.register({
          id: PLUGIN_ID,
          kind: 'sidechat',
          patterns: [ADDRESS_PATTERN],
          priority: 'extension',
          canOpen: address => parseAddress(address) !== undefined,
          title: address => {
            const parsed = parseAddress(address);
            return parsed !== undefined && parsed.label !== '' ? parsed.label : t('tab.title');
          },
        }), 'side-chat: tab type');

        // v2: separate page kind for the guide capsule and the home page.
        // A resource-only type cannot be opened via openTab(kind), which is
        // exactly what a guide capsule does.
        scope.effect(() => scope.sidebarRightTabs.register({
          id: HOME_ID,
          kind: HOME_KIND,
          priority: 'extension',
          title: () => t('home.title'),
          guide: [{
            id: 'side-chat',
            order: 10,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
          }],
        }), 'side-chat: home tab type');

        scope.effect(() => {
          const dispose = scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: PLUGIN_ID,
            children: { 'sidechat.conversation': { kind: 'single', scope: 'session' } },
          }, SideChatTab));
          return typeof dispose === 'function' ? dispose : () => {};
        }, 'side-chat: tab body');

        scope.effect(() => {
          const dispose = scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: HOME_ID,
            locale: NS,
          }, SideChatHome));
          return typeof dispose === 'function' ? dispose : () => {};
        }, 'side-chat: home tab body');

        scope.effect(() => {
          const dispose = scope.slots.inject('sidechat.conversation', () => scope.slots.register({
            name: 'sidechat.conversation',
          }, SideChatConversation));
          return typeof dispose === 'function' ? dispose : () => {};
        }, 'side-chat: conversation panel');
      });
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'uiConversation', 'sidebarRight', 'conversation'],
      apply,
      helpers: {
        encodeAddress,
        parseAddress,
        capText,
        quoteBlock,
        firstLine,
        buildOpeningDraft,
        admitInteraction,
        waitForAbort,
        isRecentEntry,
        sanitizeRecent,
        addRecent,
        removeRecent,
        depthFor,
        MAX_DEPTH,
        RECENT_LIMIT,
        HOME_KIND,
        HOME_ID,
      },
    };
  },
});
