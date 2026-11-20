/**
 * Unit tests for the real `client.js`, loaded through `vm` with a fake
 * `window.__ModuleLoader__`. No DSH package, DOM or React renderer is needed:
 * the module table's `require('react')` is satisfied with a tiny stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const fakeReact = {
  Fragment: Symbol('React.Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useEffect() {},
  useState(initialValue) { return [initialValue, () => {}]; },
};

function loadPlugin() {
  let factory;
  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) { factory = registration.factory; },
      },
      localStorage,
    },
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    console,
  };
  runInNewContext(source, sandbox, { filename: 'client.js' });
  return {
    face: factory(specifier => (specifier === 'react' ? fakeReact : {})),
    resetStorage: () => { storage.clear(); },
    seedRecent: entries => {
      storage.set('dsh.sidechat.recent', JSON.stringify(entries));
    },
  };
}

function writableBinding() {
  return { session: { getSnapshot: () => ({ removed: false, subagent: null }) }, ctx: {} };
}

/** A minimal fake of the Client root context and its injected scope. */
function createFakeCtx() {
  const captured = {
    interactions: [],
    resources: [],
    tabs: [],
    commands: [],
    executed: [],
    refreshed: 0,
    slotRegistrations: [],
    opened: [],
    notices: [],
    draftInits: [],
    released: 0,
    dismissed: 0,
    cleared: 0,
    bindings: { 'parent-1': writableBinding() },
    sessionRows: { 'child-1': {} },
  };
  const dispose = () => {};
  const t = key => `t:${key}`;

  const ctx = {
    locale: {
      bind: () => t,
      register: () => dispose,
    },
    uiConversation: {
      interactions: {
        register(definition) { captured.interactions.push(definition); return dispose; },
      },
    },
    sessions: {
      binding: id => captured.bindings[id],
      fork: async () => 'child-1',
      retain: () => ({
        binding: { sessionId: 'child-1', ctx: {} },
        release() { captured.released += 1; },
      }),
      using: async () => undefined,
      refresh: async () => { captured.refreshed += 1; },
      list: { getSnapshot: () => ({ byId: captured.sessionRows }) },
    },
    sidebarRight: {
      openResource(address, options) { captured.opened.push({ address, options }); },
    },
    commandUi: {
      register(contribution) { captured.commands.push(contribution); return dispose; },
    },
    remote: {
      commands: {
        async execute(sessionId, line) {
          const payload = JSON.parse(line.replace(/^\/side-chat-fork\s*/u, ''));
          captured.executed.push({ sessionId, payload });
          const text = String(payload.text ?? '');
          const label = text.trim() === ''
            ? 't:home.untitled'
            : text.split('\n').find(candidate => candidate.trim() !== '').trim().slice(0, 28);
          const draftText = text.trim() === ''
            ? 't:draft.noSelection\n\nt:draft.boundary'
            : `> ${text}\n\nt:draft.boundary`;
          return {
            ok: true,
            value: {
              result: {
                kind: 'success',
                text: JSON.stringify({
                  ok: true,
                  childSessionId: 'child-1',
                  draftText,
                  label,
                  depth: (payload.depth ?? 0) + 1,
                  successNotice: false,
                }),
              },
            },
          };
        },
      },
    },
    slots: {
      inject(name, factory) {
        factory();
        return dispose;
      },
      register(options, component) {
        captured.slotRegistrations.push({ name: options.name, options, component });
        return dispose;
      },
    },
    get(name) {
      if (name !== 'conversation') return undefined;
      return {
        input: {
          for: () => ({ notify: (level, text) => captured.notices.push({ level, text }) }),
          requestDraftInitialization(binding, options) {
            captured.draftInits.push({ binding, options });
            return 'applied';
          },
        },
      };
    },
    effect(factory) {
      const result = factory();
      return typeof result === 'function' ? result : dispose;
    },
    inject(names, callback) {
      callback(scope);
      return dispose;
    },
  };

  const scope = {
    ...ctx,
    resources: { register(provider) { captured.resources.push(provider); return dispose; } },
    sidebarRightTabs: { register(definition) { captured.tabs.push(definition); return dispose; } },
    get: ctx.get,
  };

  return { ctx, captured, t };
}

function findActions(captured) {
  return captured.slotRegistrations.find(entry => entry.name === 'conversation.chat.text-interaction');
}

function findTab(captured) {
  return captured.slotRegistrations.find(entry => entry.name === 'sidebar.right.pane.tab'
    && entry.options.key === '@local/dsh-side-chat');
}

function findHomeTab(captured) {
  return captured.slotRegistrations.find(entry => entry.name === 'sidebar.right.pane.tab'
    && entry.options.key === '@local/dsh-side-chat/home');
}

function resourceTab(captured) {
  return captured.tabs.find(definition => definition.id === '@local/dsh-side-chat');
}

function homeTab(captured) {
  return captured.tabs.find(definition => definition.id === '@local/dsh-side-chat/home');
}

function actionProps(captured, overrides = {}) {
  return {
    sessionId: 'parent-1',
    inputActions: { insertQuote: () => true },
    useSession: selector => selector({ removed: false, subagent: null }),
    t: key => `t:${key}`,
    dismiss: () => { captured.dismissed += 1; },
    readText: () => 'selected text',
    clearSelection: () => { captured.cleared += 1; },
    trigger: 'contextmenu',
    ...overrides,
  };
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

const plugin = loadPlugin();
const face = plugin.face;
const helpers = face.helpers;

/** Values created inside `vm` have foreign prototypes; normalize before deepEqual. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

test('plugin face exports inject, apply and the pure helpers', () => {
  assert.ok(Array.isArray(face.inject));
  assert.equal(typeof face.apply, 'function');
  for (const key of [
    'encodeAddress', 'parseAddress', 'capText', 'quoteBlock', 'firstLine',
    'buildOpeningDraft', 'admitInteraction', 'waitForAbort',
    'isRecentEntry', 'sanitizeRecent', 'addRecent', 'removeRecent', 'depthFor',
  ]) {
    assert.equal(typeof helpers[key], 'function', `${key} must be exported`);
  }
  assert.equal(helpers.MAX_DEPTH, 3);
  assert.equal(helpers.RECENT_LIMIT, 20);
});

test('encodeAddress/parseAddress round-trip and canonical form', () => {
  const address = helpers.encodeAddress({
    child: 'child/with space', parent: 'parent-1', label: 'First line',
  });
  assert.ok(address.startsWith('dsh-resource://sidechat/session/'));
  assert.deepEqual(plain(helpers.parseAddress(address)), {
    child: 'child/with space', parent: 'parent-1', label: 'First line', depth: 0,
  });
  assert.deepEqual(plain(helpers.parseAddress('dsh-resource://SIDECHAT/session/c?parent=p')), {
    child: 'c', parent: 'p', label: '', depth: 0,
  });
});

test('v2 depth round-trips and v1 addresses stay backwards compatible', () => {
  const withDepth = helpers.encodeAddress({ child: 'c', parent: 'p', label: 'Q', depth: 2 });
  assert.ok(withDepth.includes('depth=2'));
  assert.deepEqual(plain(helpers.parseAddress(withDepth)), {
    child: 'c', parent: 'p', label: 'Q', depth: 2,
  });
  // depth=0 is omitted so v1 addresses are byte-for-byte unchanged.
  assert.equal(helpers.encodeAddress({ child: 'c', parent: 'p', depth: 0 }),
    'dsh-resource://sidechat/session/c?parent=p');
  // Invalid depths fall back to 0 instead of poisoning the entry.
  for (const bad of ['-1', 'abc', '99999999999999999999']) {
    assert.equal(helpers.parseAddress(
      `dsh-resource://sidechat/session/c?parent=p&depth=${bad}`).depth, 0);
  }
});

test('parseAddress rejects foreign, malformed and incomplete addresses', () => {
  const invalid = [
    '',
    'not a url',
    'https://example.com/session/c?parent=p',
    'dsh-resource://subagentchat/session/c?parent=p',
    'dsh-resource://sidechat/session/c',                    // no parent
    'dsh-resource://sidechat/session/c?parent=',            // empty parent
    'dsh-resource://sidechat/session/c/extra?parent=p',     // extra path part
    'dsh-resource://sidechat/other/c?parent=p',             // wrong first part
    'dsh-resource://sidechat/session/%E0%A4%A?parent=p',   // bad percent encoding
    null,
    42,
  ];
  for (const value of invalid) {
    assert.equal(helpers.parseAddress(value), undefined, `should reject ${String(value)}`);
  }
  assert.equal(helpers.encodeAddress({ child: 'c' }), undefined);
  assert.equal(helpers.encodeAddress({ parent: 'p' }), undefined);
  assert.equal(helpers.encodeAddress({ child: '', parent: 'p' }), undefined);
});

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

test('capText truncates at 8000 by default and at a custom limit', () => {
  assert.equal(helpers.capText('abc'), 'abc');
  assert.equal(helpers.capText('x'.repeat(9000)).length, 8000);
  assert.equal(helpers.capText('abcdef', 3), 'abc');
  assert.equal(helpers.capText('abc', 0), 'abc');
});

test('capText never splits a UTF-16 surrogate pair', () => {
  // '😀' is a high+low surrogate pair; a naive slice(0, 3) would leave a lone high surrogate.
  const text = 'ab😀cd';
  const capped = helpers.capText(text, 3);
  assert.equal(capped, 'ab');
  assert.equal(capped.charCodeAt(capped.length - 1), 'b'.charCodeAt(0));
  assert.equal(helpers.capText(text, 4), 'ab😀');
});

test('quoteBlock prefixes every line and normalizes CRLF', () => {
  assert.equal(helpers.quoteBlock('one\r\ntwo\rthree'), '> one\n> two\n> three');
  assert.equal(helpers.quoteBlock('single'), '> single');
  assert.equal(helpers.quoteBlock('a\n\nb'), '> a\n> \n> b');
});

test('firstLine skips blank lines and truncates with an ellipsis', () => {
  assert.equal(helpers.firstLine('\n\n  Hello world  \nsecond'), 'Hello world');
  assert.equal(helpers.firstLine('x'.repeat(40), 10), `${'x'.repeat(10)}…`);
  assert.equal(helpers.firstLine(''), '');
});

test('buildOpeningDraft contains a blockquote and the localized boundary note', () => {
  const draft = helpers.buildOpeningDraft('alpha\nbeta', key => `T(${key})`);
  assert.equal(draft, '> alpha\n> beta\n\nT(draft.boundary)');
  assert.ok(draft.includes('> alpha'));
  assert.ok(draft.includes('boundary'));
});

// ---------------------------------------------------------------------------
// Interaction admission
// ---------------------------------------------------------------------------

test('admitInteraction claims only contextmenu with text in a writable Session', () => {
  const binding = writableBinding();
  const request = (trigger, text) => ({ trigger, readText: () => text });
  assert.equal(helpers.admitInteraction(request('contextmenu', 'x'), binding), true);
  assert.equal(helpers.admitInteraction(request('selection', 'x'), binding), false);
  assert.equal(helpers.admitInteraction(request('contextmenu', null), binding), false);
  assert.equal(helpers.admitInteraction(request('contextmenu', 'x'), undefined), false);
  assert.equal(helpers.admitInteraction(request('contextmenu', 'x'), {
    session: { getSnapshot: () => ({ removed: true, subagent: null }) },
  }), false);
  assert.equal(helpers.admitInteraction(request('contextmenu', 'x'), {
    session: { getSnapshot: () => ({ removed: false, subagent: { address: { mode: 'one-shot' } } }) },
  }), false);
  assert.equal(helpers.admitInteraction(request('contextmenu', 'x'), {
    session: { getSnapshot: () => ({ removed: false, subagent: { address: { mode: 'continuable' } } }) },
  }), true);
});

// ---------------------------------------------------------------------------
// apply(): registered interaction, tab type, resource provider
// ---------------------------------------------------------------------------

test('apply registers the side-chat interaction with the message-quotes gate', () => {
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);

  assert.equal(captured.interactions.length, 1);
  const definition = captured.interactions[0];
  assert.equal(definition.id, 'side-chat');

  let opened = 0;
  let prevented = 0;
  const request = {
    trigger: 'contextmenu',
    sessionId: 'parent-1',
    readText: () => 'x',
    open: () => { opened += 1; },
    preventDefault: () => { prevented += 1; },
  };
  definition.onInteraction(request);
  assert.equal(opened, 1, 'writable contextmenu selection is claimed');
  assert.equal(prevented, 1, 'the native context menu is suppressed when claimed');

  definition.onInteraction({ ...request, trigger: 'selection' });
  definition.onInteraction({ ...request, readText: () => null });
  definition.onInteraction({ ...request, sessionId: 'missing' });
  assert.equal(opened, 1, 'selection, empty text and missing binding are ignored');
  assert.equal(prevented, 1, 'unclaimed gestures keep the browser default');

  captured.bindings['parent-1'] = {
    session: { getSnapshot: () => ({ removed: true, subagent: null }) },
  };
  definition.onInteraction(request);
  captured.bindings['parent-1'] = {
    session: { getSnapshot: () => ({ removed: false, subagent: { address: { mode: 'one-shot' } } }) },
  };
  definition.onInteraction(request);
  assert.equal(opened, 1, 'removed and one-shot Sessions are refused');

  captured.bindings['parent-1'] = {
    session: { getSnapshot: () => ({ removed: false, subagent: { address: { mode: 'continuable' } } }) },
  };
  definition.onInteraction(request);
  assert.equal(opened, 2, 'continuable subagent Sessions are admitted');
});

test('apply registers a sidechat tab type with a parsed title', () => {
  const { ctx, captured, t } = createFakeCtx();
  face.apply(ctx);
  assert.equal(captured.tabs.length, 2, 'resource type + home page type');
  const tab = resourceTab(captured);
  assert.equal(tab.id, '@local/dsh-side-chat');
  assert.equal(tab.kind, 'sidechat');
  assert.equal(tab.priority, 'extension');
  assert.deepEqual(plain(tab.patterns), ['dsh-resource://sidechat/**']);

  const address = helpers.encodeAddress({ child: 'c', parent: 'p', label: 'A question' });
  assert.equal(tab.canOpen(address), true);
  assert.equal(tab.canOpen('dsh-resource://sidechat/session/c'), false);
  assert.equal(tab.title(address), 'A question');
  assert.equal(tab.title(helpers.encodeAddress({ child: 'c', parent: 'p' })), t('tab.title'));
});

test('apply registers the actions, tab body and conversation slot without a global bridge', () => {
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const names = captured.slotRegistrations.map(entry => entry.name);
  assert.ok(names.includes('conversation.chat.text-interaction'));
  assert.ok(names.includes('sidebar.right.pane.tab'));
  assert.ok(names.includes('sidechat.conversation'));
  assert.equal(captured.resources.length, 1);
  assert.equal(captured.resources[0].protocol, 'sidechat');
});

// ---------------------------------------------------------------------------
// Main flow: right-click "Ask in side chat" -> fork -> open resource -> prefill
// ---------------------------------------------------------------------------

test('quote action inserts a blockquote without sending and dismisses', () => {
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const actions = findActions(captured);
  const tree = actions.component(actionProps(captured));
  const buttons = tree.children[1].children;
  assert.equal(buttons.length, 2);
  buttons[0].props.onClick();
  assert.equal(captured.cleared, 1);
  assert.equal(captured.dismissed, 1);
  assert.equal(captured.opened.length, 0, 'quote must not fork or open a tab');
});

test('side chat action forks, opens a tab and prefills the draft exactly once', async () => {
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const actions = findActions(captured);
  const tree = actions.component(actionProps(captured));
  const buttons = tree.children[1].children;

  buttons[1].props.onClick();
  await settle();

  assert.equal(captured.opened.length, 1, 'one resource is opened');
  assert.deepEqual(plain(captured.opened[0].options), { kind: 'sidechat', preferNewPane: true });
  const parsed = helpers.parseAddress(captured.opened[0].address);
  assert.equal(parsed.child, 'child-1');
  assert.equal(parsed.parent, 'parent-1');
  assert.equal(parsed.label, 'selected text');
  assert.equal(captured.cleared, 1);
  assert.equal(captured.dismissed, 1);

  const provider = captured.resources[0];
  const controller = new AbortController();
  const iterator = provider.open(captured.opened[0].address, { signal: controller.signal });
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.ok, true);
  assert.equal(first.value.value.child, 'child-1');
  assert.equal(captured.draftInits.length, 1, 'draft is initialized while the tab holds the reference');
  assert.equal(captured.draftInits[0].options.prompt, '> selected text\n\nt:draft.boundary');
  assert.equal(captured.draftInits[0].options.whenDraftExists, 'append');

  controller.abort();
  const second = await iterator.next();
  assert.equal(second.done, true, 'the stream ends on abort');
  assert.equal(captured.released, 1, 'the child reference is released');

  // Revealing the same tab again must not prefill a second time.
  const again = captured.resources[0].open(captured.opened[0].address, { signal: new AbortController().signal });
  await again.next();
  assert.equal(captured.draftInits.length, 1);
  await again.return();
});

test('resource provider rejects an invalid address', async () => {
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const provider = captured.resources[0];
  const iterator = provider.open('dsh-resource://sidechat/session/c', { signal: new AbortController().signal });
  await assert.rejects(() => iterator.next(), /invalid resource address/);
  assert.equal(captured.released, 0);
});

function commandFailure(code, reason) {
  return async () => ({
    ok: true,
    value: { result: { kind: 'error', text: JSON.stringify({ code, reason }) } },
  });
}

test('fork failure shows a localized notice and opens no tab', async () => {
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  ctx.remote.commands.execute = commandFailure('session/fork-unavailable', 'fork unavailable');
  const actions = findActions(captured);
  const buttons = actions.component(actionProps(captured)).children[1].children;
  buttons[1].props.onClick();
  await settle();

  assert.equal(captured.opened.length, 0, 'no empty tab on failure');
  assert.equal(captured.cleared, 0, 'selection is kept on failure');
  assert.equal(captured.dismissed, 0);
  assert.equal(captured.notices.length, 1);
  assert.equal(captured.notices[0].level, 'error');
  assert.equal(captured.notices[0].text, 't:error.fork');
});

test('migration-required fork failure uses the migration-specific message', async () => {
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  ctx.remote.commands.execute = commandFailure('session/migration-required', 'migration required');
  const actions = findActions(captured);
  const buttons = actions.component(actionProps(captured)).children[1].children;
  buttons[1].props.onClick();
  await settle();
  assert.equal(captured.notices[0].text, 't:error.migration');
});

// ---------------------------------------------------------------------------
// Tab body states: loading, failure, and a live reference
// ---------------------------------------------------------------------------

test('tab body shows localized loading, failure and live Chat states', () => {
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const tabBody = findTab(captured);
  const baseProps = {
    useTabInfo: () => ({ tab: { contentId: 'dsh-resource://sidechat/session/c?parent=p' } }),
    SessionProvider: () => null,
    renderSlot: () => 'CHAT',
  };

  const loading = tabBody.component({
    ...baseProps,
    useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
  });
  assert.equal(loading.children[0].children[0], 't:tab.loading');

  const failed = tabBody.component({
    ...baseProps,
    useResource: () => ({ status: 'failed', value: undefined, failure: { message: 'boom' } }),
  });
  assert.equal(failed.children[0].children[0], 't:tab.failed', 'no endless loading on a failed resource');

  const reference = {};
  const live = tabBody.component({
    ...baseProps,
    useResource: () => ({ status: 'live', value: { child: 'c', parent: 'p', label: '', reference }, failure: undefined }),
  });
  assert.equal(live.children[0].type, baseProps.SessionProvider);
  assert.equal(live.children[0].props.session, reference);
  assert.equal(live.children[0].children[0], 'CHAT');
});

// ---------------------------------------------------------------------------
// v2 batch A: recent side chats, depth, /side command, guide + home page
// ---------------------------------------------------------------------------

function recentEntry(child, depth = 1, createdAt = 1) {
  return {
    child,
    parent: 'parent-1',
    address: helpers.encodeAddress({ child, parent: 'parent-1', depth }),
    label: `Q ${child}`,
    depth,
    createdAt,
  };
}

test('addRecent de-duplicates, orders newest first and enforces the cap', () => {
  const first = helpers.addRecent([], recentEntry('a', 1, 1));
  assert.equal(first.length, 1);
  const second = helpers.addRecent(first, recentEntry('b', 1, 2));
  assert.equal(second[0].child, 'b');
  const deduped = helpers.addRecent(second, recentEntry('a', 1, 3));
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].child, 'a', 're-adding a child moves it to the front');
  let many = [];
  for (let i = 0; i < 25; i += 1) many = helpers.addRecent(many, recentEntry(`c${i}`, 1, i));
  assert.equal(many.length, helpers.RECENT_LIMIT);
  assert.deepEqual(plain(helpers.addRecent([{ junk: true }], { junk: true })), []);
});

test('depthFor returns the conversation depth (no off-by-one)', () => {
  const list = [recentEntry('a', 1, 1), recentEntry('b', 2, 2)];
  assert.equal(helpers.depthFor(list, 'a'), 1);
  assert.equal(helpers.depthFor(list, 'b'), 2);
  assert.equal(helpers.depthFor(list, 'parent-1'), 0);
  assert.equal(helpers.removeRecent(list, 'a').length, 1);
  // A three-level chain must reach depth 3, not be cut off at 2.
  const chain = [recentEntry('a', 1, 1), recentEntry('b', 2, 2), recentEntry('c', 3, 3)];
  assert.equal(helpers.depthFor(chain, 'c'), 3);
});

test('isRecentEntry rejects an address that points at another child', () => {
  const entry = recentEntry('child-1', 1, 1);
  assert.equal(helpers.isRecentEntry(entry), true);
  assert.equal(helpers.isRecentEntry({ ...entry, address: helpers.encodeAddress({ child: 'other', parent: 'parent-1' }) }), false);
  assert.equal(helpers.isRecentEntry({ ...entry, address: 'not-a-url' }), false);
  assert.equal(helpers.isRecentEntry({ ...entry, prompt: '> quoted\n\nnotes' }), true);
  assert.equal(helpers.isRecentEntry({ ...entry, prompt: 42 }), false);
});

test('buildOpeningDraft handles no selection and truncation without polluting the quote', () => {
  const t = key => `T(${key})`;
  assert.equal(helpers.buildOpeningDraft('', t), 'T(draft.noSelection)\n\nT(draft.boundary)');
  const truncated = helpers.buildOpeningDraft('alpha', t, true);
  assert.equal(truncated, '> alpha\n\nT(draft.boundary)\n\nT(draft.truncated)');
  assert.ok(truncated.indexOf('T(draft.truncated)') > truncated.indexOf('T(draft.boundary)'),
    'the truncation note goes after the boundary, never inside the blockquote');
  // v1 call shape is unchanged.
  assert.equal(helpers.buildOpeningDraft('alpha\nbeta', t), '> alpha\n> beta\n\nT(draft.boundary)');
});

test('apply registers the /side command with a writable-session gate', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  assert.equal(captured.commands.length, 1);
  const command = captured.commands[0];
  assert.equal(command.name, 'side');
  assert.equal(command.ui.kind, 'action');
  assert.equal(command.label(), 't:command.label');
  assert.equal(command.available({ sessionId: 'parent-1' }), true);
  assert.equal(command.available({ sessionId: 'missing' }), false);

  command.ui.run({ sessionId: 'parent-1' });
  await settle();
  assert.equal(captured.opened.length, 1, '/side forks a blank side chat');
  const parsed = helpers.parseAddress(captured.opened[0].address);
  assert.equal(parsed.label, 't:home.untitled');
  assert.equal(parsed.depth, 1);
});

test('apply registers a separate home page type with a unique guide capsule', () => {
  const { ctx, captured, t } = createFakeCtx();
  face.apply(ctx);
  const home = homeTab(captured);
  assert.equal(home.kind, helpers.HOME_KIND);
  assert.equal(home.patterns, undefined, 'a page type must omit patterns');
  assert.equal(home.title('sidebar://sidechat-home'), t('home.title'));
  assert.equal(home.guide.length, 1);
  assert.equal(home.guide[0].id, 'side-chat');
  assert.equal(home.guide[0].title(), t('guide.title'));
  assert.ok(findHomeTab(captured), 'home tab body is registered under HOME_ID');
});

test('home page renders an empty state and can create a blank side chat', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const tree = findHomeTab(captured).component({ sessionId: 'parent-1' });
  assert.equal(tree.children[1].children[0], 't:home.title');
  assert.equal(tree.children[5].children[0], 't:home.empty');
  tree.children[3].props.onClick();
  await settle();
  assert.equal(captured.opened.length, 1);
});

test('home page lists recent side chats and reopens an existing child', () => {
  plugin.resetStorage();
  plugin.seedRecent([recentEntry('child-1', 1, 1)]);
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const tree = findHomeTab(captured).component({ sessionId: 'parent-1' });
  assert.equal(tree.children[5].type, 'ul');
  const rowButton = tree.children[5].children[0].children[0];
  assert.ok(rowButton.children[0].includes('t:home.open'));
  rowButton.props.onClick();
  assert.equal(captured.opened.length, 1, 'reopening reveals the existing tab');
  assert.equal(captured.opened[0].address, recentEntry('child-1', 1, 1).address);
});

test('reopening a child that is no longer listed removes the entry with a notice', () => {
  plugin.resetStorage();
  plugin.seedRecent([recentEntry('gone', 1, 1)]);
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const tree = findHomeTab(captured).component({ sessionId: 'parent-1' });
  tree.children[5].children[0].children[0].props.onClick();
  assert.equal(captured.opened.length, 0, 'no tab for a missing child');
  assert.equal(captured.notices[0].level, 'info', 'an archived child is informational, not an error');
  assert.equal(captured.notices[0].text, 't:home.missing');
});

test('recursion depth limit blocks a fork from a too-deep side chat', async () => {
  plugin.resetStorage();
  // parent-1 is itself recorded as a depth-3 child -> forking from it is refused.
  plugin.seedRecent([recentEntry('parent-1', helpers.MAX_DEPTH, 1)]);
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  captured.commands[0].ui.run({ sessionId: 'parent-1' });
  await settle();
  assert.equal(captured.opened.length, 0, 'no fork beyond MAX_DEPTH');
  assert.equal(captured.notices[0].text, 't:error.depth');
});

test('a failed tab open still records the child so the home page can retry', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  ctx.sidebarRight.openResource = () => { throw new Error('placement failed'); };
  captured.commands[0].ui.run({ sessionId: 'parent-1' });
  await settle();
  assert.equal(captured.notices[0].text, 't:error.open');
  const tree = findHomeTab(captured).component({ sessionId: 'parent-1' });
  assert.equal(tree.children[5].type, 'ul', 'the failed child is still listed for retry');
});

test('a retry restores the selected context instead of opening an empty draft', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  ctx.sidebarRight.openResource = () => { throw new Error('placement failed'); };
  const actions = findActions(captured);
  actions.component(actionProps(captured)).children[1].children[1].props.onClick();
  await settle();
  assert.equal(captured.draftInits.length, 0, 'the tab never opened, so no draft was applied');

  // Recover placement, then click the recent entry from the home page.
  ctx.sidebarRight.openResource = (address, options) => { captured.opened.push({ address, options }); };
  const tree = findHomeTab(captured).component({ sessionId: 'parent-1' });
  tree.children[5].children[0].children[0].props.onClick();
  assert.equal(captured.opened.length, 1, 'retry opens the same address');

  const provider = captured.resources[0];
  const iterator = provider.open(captured.opened[0].address, { signal: new AbortController().signal });
  await iterator.next();
  assert.equal(captured.draftInits.length, 1, 'the staged prompt is restored');
  assert.equal(captured.draftInits[0].options.prompt, '> selected text\n\nt:draft.boundary');
  await iterator.return();
});

test('depth is not double-counted across a second-level fork', async () => {
  plugin.resetStorage();
  plugin.seedRecent([recentEntry('parent-1', 1, 1)]);
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  captured.commands[0].ui.run({ sessionId: 'parent-1' });
  await settle();
  assert.equal(captured.opened.length, 1);
  assert.equal(helpers.parseAddress(captured.opened[0].address).depth, 2);
});

test('/side is guarded against concurrent forks', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  const slow = ctx.remote.commands.execute;
  ctx.remote.commands.execute = async (...args) => {
    await new Promise(resolve => { setTimeout(resolve, 10); });
    return slow(...args);
  };
  face.apply(ctx);
  captured.commands[0].ui.run({ sessionId: 'parent-1' });
  captured.commands[0].ui.run({ sessionId: 'parent-1' });
  await new Promise(resolve => { setTimeout(resolve, 40); });
  assert.equal(captured.opened.length, 1, 'only one fork/tab from two rapid /side invocations');
});

// ---------------------------------------------------------------------------
// v2 batch B: the Host operation is the single source of fork + draft
// ---------------------------------------------------------------------------

test('openSideChat calls the Host fork command and refreshes the catalog', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const actions = findActions(captured);
  actions.component(actionProps(captured)).children[1].children[1].props.onClick();
  await settle();
  assert.equal(captured.executed.length, 1, 'one Host command invocation');
  assert.equal(captured.executed[0].sessionId, 'parent-1');
  assert.equal(captured.executed[0].payload.text, 'selected text');
  assert.equal(captured.refreshed, 1, 'Host-side fork needs a Client catalog refresh before retain');
  assert.equal(captured.opened.length, 1);
});

test('the Host command result drives the draft and the tab label', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const actions = findActions(captured);
  actions.component(actionProps(captured)).children[1].children[1].props.onClick();
  await settle();
  const provider = captured.resources[0];
  const iterator = provider.open(captured.opened[0].address, { signal: new AbortController().signal });
  await iterator.next();
  assert.equal(captured.draftInits[0].options.prompt, '> selected text\n\nt:draft.boundary');
  await iterator.return();
});

test('a Host successNotice produces an informational notice', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  const original = ctx.remote.commands.execute;
  ctx.remote.commands.execute = async (...args) => {
    const response = await original(...args);
    const value = JSON.parse(response.value.result.text);
    return {
      ok: true,
      value: { result: { kind: 'success', text: JSON.stringify({ ...value, successNotice: true }) } },
    };
  };
  face.apply(ctx);
  captured.commands[0].ui.run({ sessionId: 'parent-1' });
  await settle();
  assert.ok(captured.notices.some(notice => notice.level === 'info'
    && notice.text === 't:notice.opened'));
});

test('the Client reads CommandResult from RemoteResult.value.result (regression)', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  const actions = findActions(captured);
  actions.component(actionProps(captured)).children[1].children[1].props.onClick();
  await settle();
  assert.equal(captured.opened.length, 1, 'a nested CommandResult succeeds');
  assert.equal(captured.notices.length, 0, 'no failure notice');
});

test('a flat CommandResult without value.result is rejected, not misread', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  ctx.remote.commands.execute = async () => ({
    ok: true,
    value: { kind: 'success', text: '{}' },
  });
  const actions = findActions(captured);
  actions.component(actionProps(captured)).children[1].children[1].props.onClick();
  await settle();
  assert.equal(captured.opened.length, 0);
  assert.equal(captured.notices[0].text, 't:error.fork');
});

test('a transport-level command failure stays localized and opens no tab', async () => {
  plugin.resetStorage();
  const { ctx, captured } = createFakeCtx();
  face.apply(ctx);
  ctx.remote.commands.execute = async () => ({ ok: false, error: { code: 'gateway/internal' } });
  captured.commands[0].ui.run({ sessionId: 'parent-1' });
  await settle();
  assert.equal(captured.opened.length, 0);
  assert.equal(captured.notices[0].text, 't:error.fork');
});
