/**
 * Host-half tests. `index.js` is an ESM module whose two DSH helpers are loaded
 * with createRequire anchored at the running installation; here we strip the
 * import lines and inject the same real `schemastery` / `defineTool` modules so
 * the exact Host source is exercised (real ESM activation is verified by
 * install_bundle's `application: applied`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

const dshRoot = process.env.DSH_INSTALL_DIR;
const requireFromDsh = createRequire(`${dshRoot}/package.json`);
const z = requireFromDsh('@deepseek-ai/schemastery');
const { defineTool } = requireFromDsh('@deepseek-ai/dsh-tools');

let source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
source = source.replace(/^import .*$/gmu, '').replace(/^export /gmu, '');
source += '\nmodule.exports = { Config, helpers, apply, inject, name };\n';

const disposer = () => {};

function loadHost() {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    z,
    defineTool,
    createRequire,
    process,
    console,
    JSON, Number, String, Map, Set, Error, Promise, AbortController,
  };
  runInNewContext(source, sandbox, { filename: 'index.js' });
  return sandbox.module.exports;
}

function makeAgent(sessionId = 'session-1') {
  return {
    sessionId,
    ctx: {
      inject: (_names, callback) => {
        const scope = {
          systemPrompt: {
            getSectionOrder: () => 10100,
            section: section => { agentState.sections.push(section); return disposer; },
          },
        };
        callback(scope);
        return { dispose: async () => { agentState.disposed += 1; } };
      },
    },
  };
}

let agentState;

const DEFAULT_HEADERS = {
  'session-1': { isSeeded: false },
  'child-1': { isSeeded: true },
};

function makeCtx(options = {}) {
  agentState = { sections: [], disposed: 0 };
  const registered = { commands: [], tools: [], events: [], effects: [] };
  const agent = makeAgent(options.sessionId ?? 'session-1');
  const headers = options.headers ?? DEFAULT_HEADERS;
  const ctx = {
    sessionController: {
      fork: options.fork ?? (async () => ({ sessionId: 'child-1' })),
    },
    sessions: {
      get: id => (headers[id] === undefined ? undefined : { header: headers[id] }),
    },
    commands: { register: definition => { registered.commands.push(definition); return disposer; } },
    tools: { register: definition => { registered.tools.push(definition); return disposer; } },
    systemPrompt: { getSectionOrder: () => 10100, section: () => disposer },
    agents: { list: () => [agent] },
    on: name => { registered.events.push(name); return disposer; },
    effect: factory => {
      const result = factory();
      registered.effects.push(result);
      return typeof result === 'function' ? result : disposer;
    },
  };
  return { ctx, registered, agent };
}

const host = loadHost();

test('Host exports a callable Config with the documented defaults', () => {
  const config = host.Config({});
  assert.equal(config.hiddenBoundary, true);
  assert.equal(config.successNotice, false);
  assert.ok(config.boundaryText.includes('Inherited history'));
  assert.equal(host.name, 'side-chat');
  assert.ok(host.inject.includes('sessionController'));
  assert.ok(host.inject.includes('commands'));
  assert.ok(host.inject.includes('tools'));
  assert.ok(host.inject.includes('systemPrompt'));
  assert.ok(host.inject.includes('agents'));
  assert.ok(host.inject.includes('sessions'));
});

test('apply registers one command, one tool, one scoped section and both agent events', () => {
  const { ctx, registered } = makeCtx();
  const service = host.apply(ctx, host.Config({}));
  assert.equal(typeof service.createSideChat, 'function');
  assert.equal(registered.commands.length, 1);
  assert.equal(registered.commands[0].name, 'side-chat-fork');
  assert.equal(registered.tools.length, 1);
  assert.equal(registered.tools[0].name, 'side_chat_create');
  assert.equal(agentState.sections.length, 1);
  assert.equal(agentState.sections[0].name, 'side-chat:boundary');
  assert.ok(registered.events.includes('agent/created'));
  assert.ok(registered.events.includes('agent/disposed'));
});

test('createSideChat forks once and keeps the boundary out of the draft', async () => {
  let forks = 0;
  const { ctx } = makeCtx({ fork: async () => { forks += 1; return { sessionId: 'child-1' }; } });
  const service = host.apply(ctx, host.Config({}));
  const result = await service.createSideChat({ sessionId: 'session-1', text: 'alpha\nbeta', depth: 0 });
  assert.equal(forks, 1);
  assert.equal(result.ok, true);
  assert.equal(result.childSessionId, 'child-1');
  assert.equal(result.label, 'alpha');
  assert.equal(result.depth, 1);
  assert.equal(result.draftText, '> alpha\n> beta', 'hidden boundary is not written into the draft');
  assert.ok(service.boundaryFor('child-1').includes('Inherited history'));
  assert.equal(service.boundaryFor('session-1'), undefined, 'the parent is not a fork');
});

test('the hidden section is installed only for forked, non-subagent Sessions', () => {
  const { ctx } = makeCtx({ headers: { 's-fork': { isSeeded: true }, 's-main': { isSeeded: false }, 's-sub': { isSeeded: true, origin: 'subagent' } } });
  host.apply(ctx, host.Config({}));
  const text = agentState.sections[0].text;
  assert.ok(typeof text === 'function');
  // Rebind the agent's sessionId through the closure is not possible; instead
  // verify the pure predicate directly.
  assert.equal(host.helpers.isSideChatSession(ctx, 's-fork'), true);
  assert.equal(host.helpers.isSideChatSession(ctx, 's-main'), false);
  assert.equal(host.helpers.isSideChatSession(ctx, 's-sub'), false);
  assert.equal(host.helpers.isSideChatSession(ctx, 'missing'), false);
});

test('hiddenBoundary=false yields an empty section even for a fork', () => {
  const { ctx } = makeCtx({ sessionId: 'child-1' });
  host.apply(ctx, host.Config({ hiddenBoundary: false }));
  assert.equal(agentState.sections[0].text(), '');
});

test('the hidden section text is the boundary for a fork, and empty otherwise', () => {
  const { ctx } = makeCtx({ sessionId: 'child-1' });
  host.apply(ctx, host.Config({}));
  assert.ok(agentState.sections[0].text().includes('Inherited history'));
});

test('a blank side chat gets a no-selection line, and long text a truncation note', async () => {
  const { ctx } = makeCtx();
  const service = host.apply(ctx, host.Config({}));
  const blank = await service.createSideChat({ sessionId: 'session-1', text: '', depth: 0 });
  assert.ok(blank.draftText.includes('No selection'));
  assert.equal(blank.label, 'Blank side chat');
  const long = await service.createSideChat({ sessionId: 'session-1', text: 'x'.repeat(9000), depth: 0 });
  assert.ok(long.draftText.includes('capped at 8000 characters'));
  assert.ok(long.draftText.startsWith('> '));
});

test('fork failures carry a stable code for the Client to localize', async () => {
  const { ctx } = makeCtx({
    fork: async () => {
      const error = new Error('needs migration');
      error.code = 'session/migration-required';
      throw error;
    },
  });
  const service = host.apply(ctx, host.Config({}));
  const result = await service.createSideChat({ sessionId: 'session-1', text: 'x', depth: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session/migration-required');
  assert.equal(service.boundaryFor('missing-child'), undefined);
});

test('one operation, two callers: UI command and agent tool produce the same result', async () => {
  const { ctx, registered, agent } = makeCtx();
  host.apply(ctx, host.Config({}));
  const line = `/side-chat-fork ${JSON.stringify({ text: 'shared question', depth: 0 })}`;
  const commandResult = await registered.commands[0].handler({
    agent,
    rawInput: line.replace(/^\/side-chat-fork\s*/u, ''),
    attachments: [],
    signal: new AbortController().signal,
  });
  const toolResult = await registered.tools[0].execute({ text: 'shared question' }, { agent });
  assert.equal(commandResult.kind, 'success');
  const fromUi = JSON.parse(commandResult.text);
  assert.equal(fromUi.ok, toolResult.ok);
  assert.equal(fromUi.childSessionId, toolResult.childSessionId);
  assert.equal(fromUi.draftText, toolResult.draftText);
  assert.equal(fromUi.label, toolResult.label);
  assert.equal(fromUi.depth, toolResult.depth);
});

test('one operation, two callers: both report the same failure', async () => {
  const { ctx, registered, agent } = makeCtx({
    fork: async () => {
      const error = new Error('unavailable');
      error.code = 'session/fork-unavailable';
      throw error;
    },
  });
  host.apply(ctx, host.Config({}));
  const commandResult = await registered.commands[0].handler({
    agent, rawInput: JSON.stringify({ text: 'x', depth: 0 }),
    attachments: [], signal: new AbortController().signal,
  });
  const toolResult = await registered.tools[0].execute({ text: 'x' }, { agent });
  assert.equal(commandResult.kind, 'error');
  assert.equal(JSON.parse(commandResult.text).code, 'session/fork-unavailable');
  assert.equal(toolResult.code, 'session/fork-unavailable');
  assert.equal(toolResult.ok, false);
});

test('the agent tool refuses a call without an agent scope', async () => {
  const { ctx, registered } = makeCtx();
  host.apply(ctx, host.Config({}));
  const result = await registered.tools[0].execute({ text: 'x' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-agent');
});

test('plugin teardown disposes every agent-scoped prompt fiber', async () => {
  const { ctx, registered } = makeCtx();
  host.apply(ctx, host.Config({}));
  const cleanup = registered.effects.find(result => typeof result === 'function');
  assert.ok(cleanup, 'the plugin owns a cleanup effect for agent fibers');
  cleanup();
  await Promise.resolve();
  assert.equal(agentState.disposed, 1);
});
