/**
 * Browser half of the Codex-style Side Chat bundle.
 *
 * A right-click on a Chat text selection claims the `contextmenu` gesture (the
 * built-in `message-quotes` plugin keeps `selection`), and offers two actions:
 * quote into the current composer, or fork a real child Session and show its
 * Chat in a right-Sidebar tab. Nothing is sent automatically.
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

    // ---------------------------------------------------------------------
    // Pure helpers. Exported on the plugin face's `helpers` seat so the unit
    // tests exercise this exact source through `vm`.
    // ---------------------------------------------------------------------

    function encodeAddress({ child, parent, label }) {
      if (child === undefined || child === null || child === ''
        || parent === undefined || parent === null || parent === '') return undefined;
      const query = new URLSearchParams();
      query.set('parent', String(parent));
      if (label !== undefined && label !== null && label !== '') query.set('label', String(label));
      return `${ADDRESS_PREFIX}${encodeURIComponent(String(child))}?${query.toString()}`;
    }

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
      return { child, parent, label: url.searchParams.get('label') ?? '' };
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

    function buildOpeningDraft(text, t) {
      return `${quoteBlock(text)}\n\n${t('draft.boundary')}`;
    }

    /**
     * Mirror the built-in Quote plugin's writable-Session gate. Only a
     * `contextmenu` gesture with a real text selection in a continuable Session
     * is admitted; drag-selection stays with `message-quotes`.
     */
    function admitInteraction(request, binding) {
      if (request === undefined || request === null || request.trigger !== 'contextmenu') return false;
      if (typeof request.readText !== 'function' || request.readText() === null) return false;
      if (binding === undefined || binding === null || binding.session === undefined) return false;
      const session = binding.session.getSnapshot();
      if (session.removed) return false;
      if (session.subagent !== null && session.subagent !== undefined
        && session.subagent.address.mode !== 'continuable') return false;
      return true;
    }

    function waitForAbort(signal) {
      if (signal.aborted) return Promise.resolve();
      return new Promise(resolve => {
        signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
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
      'draft.boundary': '上面的引用来自主会话；继承的历史仅作参考。请在侧边聊天中回答，不要继续执行主任务、不要修改文件，除非明确要求否则不要运行工具。',
      'error.fork': '无法创建侧边聊天，请重试。',
      'error.migration': '请先打开原会话完成迁移，再创建侧边聊天。',
      'error.open': '侧边聊天标签打开失败；已创建的子会话仍在会话列表中，可直接打开。',
    };

    const en = {
      'action.quote': 'Quote in current chat',
      'action.ask': 'Ask in side chat',
      'action.busy': 'Creating side chat…',
      'surface.label': 'Selection actions',
      'tab.title': 'Side chat',
      'tab.loading': 'Opening side chat…',
      'tab.failed': 'Could not open this side chat. The child Session is still in the session list.',
      'draft.boundary': 'The quoted text above comes from the parent chat. Inherited history is for reference only. Please answer in this side chat; do not continue the parent task, do not change files, and do not run tools unless explicitly asked.',
      'error.fork': 'Could not create a side chat. Please try again.',
      'error.migration': 'Open the original chat once to finish migration before creating a side chat.',
      'error.open': 'Could not open the side chat tab. The child Session was created and is still in the session list.',
    };

    // The floating surface is host-styled; only --dsw-alias-* theme tokens are
    // used for color, so it inherits light/dark switching automatically.
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

      /** Best-effort localized failure notice on the parent Session's composer. */
      function notifyError(sessionId, message) {
        try {
          const binding = ctx.sessions.binding(sessionId);
          const conversation = ctx.get('conversation');
          if (binding !== undefined && conversation !== undefined) {
            conversation.input.for(binding.ctx).notify('error', message);
          }
        } catch (_error) {
          // A missing composer must not turn a fork failure into a crashed slot;
          // at least leave a diagnostic so the failure is not completely silent.
          console.warn('side-chat: could not show the error notice', _error);
        }
      }

      function forkErrorMessage(error) {
        if (error !== null && typeof error === 'object'
          && error.name === 'SessionForkError'
          && error.rpcError !== undefined && error.rpcError !== null
          && error.rpcError.code === 'session/migration-required') {
          return t('error.migration');
        }
        return t('error.fork');
      }

      async function openSideChat(parent, text, onError) {
        let child;
        try {
          // Omitting `atSeq` forks from the latest completed-turn prefix.
          child = await ctx.sessions.fork({ sessionId: parent, increaseTitle: true });
        } catch (error) {
          onError(forkErrorMessage(error));
          return false;
        }
        const prompt = buildOpeningDraft(text, t);
        pendingDrafts.set(child, prompt);
        try {
          ctx.sidebarRight.openResource(
            encodeAddress({ child, parent, label: firstLine(text) }),
            { kind: 'sidechat', preferNewPane: true },
          );
          return true;
        } catch (_error) {
          pendingDrafts.delete(child);
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
          void openSideChat(sessionId, capText(text), message => notifyError(sessionId, message))
            .then(ok => {
              if (ok) { clearSelection(); dismiss(); }
              else setBusy(false);
            });
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

      ctx.effect(() => {
        const dispose = ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
          name: 'conversation.chat.text-interaction',
          key: INTERACTION_ID,
          locale: NS,
        }, SideChatActions));
        return typeof dispose === 'function' ? dispose : () => {};
      }, 'side-chat: text interaction actions');

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

        scope.effect(() => {
          const dispose = scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: PLUGIN_ID,
            children: { 'sidechat.conversation': { kind: 'single', scope: 'session' } },
          }, SideChatTab));
          return typeof dispose === 'function' ? dispose : () => {};
        }, 'side-chat: tab body');

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
      },
    };
  },
});
