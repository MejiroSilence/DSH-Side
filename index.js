/**
 * Host half of the Side Chat bundle (v2 batch B).
 *
 * One operation, two callers: `createSideChat` is the single implementation of
 * "create a side chat" (fork a Session, decide the draft text, register the
 * hidden boundary). The Web UI reaches it through the `side-chat-fork` session
 * command; the `side_chat_create` agent tool calls the very same method. No
 * fork logic is duplicated in the Client half.
 *
 * The hidden developer boundary is delivered through
 * `ctx.systemPrompt.section()` on each agent's scoped context — never written
 * into the session log as a new event type.
 */
import { createRequire } from 'node:module'

// A linked local bundle resolves ESM imports from its real directory, which is
// outside DSH's node_modules tree. Load the two DSH-provided helpers through
// createRequire anchored at the running installation instead. Only `node:`
// built-ins are imported here, so activation never depends on a bare package
// specifier resolving from this checkout.
const dshRoot = process.env.DSH_INSTALL_DIR
  ?? `${process.resourcesPath ?? ''}/app.asar/dsh`
const requireFromDsh = createRequire(`${dshRoot}/package.json`)
const z = requireFromDsh('@deepseek-ai/schemastery')
const { defineTool } = requireFromDsh('@deepseek-ai/dsh-tools')

const DEFAULT_BOUNDARY = 'You are in a side chat forked from a parent conversation. '
  + 'Inherited history is for reference only. Answer here; do not continue the parent task, '
  + 'do not change files, and do not run tools unless explicitly asked.'

/** Tunable values live in cordis.patch.yml under this row's `config`. */
export const Config = z.object({
  /** Deliver the boundary as a hidden prompt section instead of visible draft text. */
  hiddenBoundary: z.boolean().default(true),
  /** Show an informational composer notice after a successful create. */
  successNotice: z.boolean().default(false),
  /** Developer boundary text; override to customise the side-chat contract. */
  boundaryText: z.string().default(DEFAULT_BOUNDARY),
})

export const inject = ['sessionController', 'commands', 'tools', 'systemPrompt', 'agents']

export const name = 'side-chat'

const MAX_TEXT = 8000
const NO_SELECTION = '(No selection was attached. Add what you want to ask below.)'
const TRUNCATED = '(The selection was too long and was capped at 8000 characters; the quote contains only the first part.)'
const UNTITLED = 'Blank side chat'
const SECTION_NAME = 'side-chat:boundary'
const COMMAND_NAME = 'side-chat-fork'

// ---------------------------------------------------------------------------
// Pure helpers (also exported for tests; intentionally small — the Client half
// owns presentation, the Host half owns the operation).
// ---------------------------------------------------------------------------

export const helpers = {
  capText(text, max = MAX_TEXT) {
    const value = String(text ?? '')
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_TEXT
    if (value.length <= limit) return value
    const last = value.charCodeAt(limit - 1)
    const end = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit
    return value.slice(0, end)
  },
  quoteBlock(text) {
    return String(text ?? '').replace(/\r\n?/gu, '\n')
      .split('\n').map(line => `> ${line}`).join('\n')
  },
  firstLine(text, max = 28) {
    const line = String(text ?? '').split('\n').find(candidate => candidate.trim() !== '') ?? ''
    const trimmed = line.trim()
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 28
    return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
  },
  /** Compose the draft for one side chat; `boundary` is omitted when hidden. */
  draftText(text, boundary, includeBoundary) {
    const hasQuote = String(text ?? '').trim() !== ''
    const quote = hasQuote ? `${helpers.quoteBlock(helpers.capText(text))}\n\n` : `${NO_SELECTION}\n\n`
    const truncation = String(text ?? '').length > MAX_TEXT ? `\n\n${TRUNCATED}` : ''
    return `${quote}${includeBoundary ? '' : `${boundary}\n\n`}${truncation}`.trimEnd()
  },
}

/**
 * Create one side chat. Returns an explicit result; failures carry a stable
 * `code` so the Client can map them to localized notices.
 */
async function createSideChat(ctx, config, boundaries, { sessionId, text, depth = 0 }) {
  if (!Number.isFinite(depth) || depth < 0) {
    return { ok: false, code: 'bad-request', reason: 'invalid depth' }
  }
  let forkValue
  try {
    forkValue = await ctx.sessionController.fork({ sessionId })
  } catch (error) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : 'session/fork-unavailable'
    return { ok: false, code, reason: error instanceof Error ? error.message : String(error) }
  }
  const childSessionId = forkValue.sessionId
  const boundary = config.boundaryText
  const draftText = helpers.draftText(text, boundary, config.hiddenBoundary)
  if (config.hiddenBoundary) boundaries.set(childSessionId, boundary)
  const label = helpers.firstLine(text) || UNTITLED
  return {
    ok: true,
    childSessionId,
    draftText,
    label,
    depth: depth + 1,
    successNotice: config.successNotice,
  }
}

export function apply(ctx, config = {}) {
  // Cordis already validated `config` against `Config` (and applied defaults)
  // before calling apply; the fallbacks keep an unvalidated direct call safe.
  const resolved = {
    hiddenBoundary: config.hiddenBoundary ?? true,
    successNotice: config.successNotice ?? false,
    boundaryText: config.boundaryText ?? DEFAULT_BOUNDARY,
  }
  /** Derived cache: child Session id -> hidden boundary text. Not persisted. */
  const boundaries = new Map()
  /** agent -> scoped fiber owning its prompt section (double ownership). */
  const fibers = new Map()

  // One operation, two callers. Both the command handler and the tool below
  // call this exact object; no second implementation exists in the Client.
  const service = {
    createSideChat: request => createSideChat(ctx, resolved, boundaries, request),
    boundaryFor: sessionId => boundaries.get(sessionId),
  }

  const installPrompt = (agent) => {
    if (fibers.has(agent)) return fibers.get(agent)
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: SECTION_NAME,
        order: scope.systemPrompt.getSectionOrder('WEB_SURFACE') + 1,
        text: () => (resolved.hiddenBoundary ? boundaries.get(agent.sessionId) ?? '' : ''),
      })
    })
    fibers.set(agent, fiber)
    return fiber
  }

  for (const agent of ctx.agents.list()) installPrompt(agent)
  ctx.on('agent/created', ({ agent }) => { installPrompt(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = fibers.get(agent)
    if (fiber === undefined) return
    fibers.delete(agent)
    void fiber.dispose()
    boundaries.delete(agent.sessionId)
  })

  // The plugin's own effect must also own every agent-scoped registration:
  // unloading the plugin does not dispose agent.ctx registrations by itself.
  ctx.effect(() => () => {
    for (const fiber of fibers.values()) void fiber.dispose()
    fibers.clear()
    boundaries.clear()
  }, 'side-chat: per-agent prompt sections')

  // Client-callable entry point. `recordInput: false` keeps the selection out
  // of the command log; the operation's own data lives in the session log.
  ctx.effect(() => ctx.commands.register({
    name: COMMAND_NAME,
    description: 'Create a side chat (internal entry point for the Side chat plugin).',
    recordInput: false,
    async handler(invocation) {
      let payload
      try {
        payload = JSON.parse(invocation.rawInput.trim())
      } catch (_error) {
        return { kind: 'error', text: JSON.stringify({ code: 'bad-request', reason: 'invalid payload' }) }
      }
      const result = await service.createSideChat({
        sessionId: invocation.agent.sessionId,
        text: String(payload.text ?? ''),
        depth: Number(payload.depth ?? 0),
      })
      return result.ok
        ? { kind: 'success', text: JSON.stringify(result) }
        : { kind: 'error', text: JSON.stringify({ code: result.code, reason: result.reason }) }
    },
  }), 'side-chat: fork session command')

  // Agent tool: same method, same parameters, same result and failure shape.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'side_chat_create',
    description: 'Fork the current conversation into a separate side-chat Session and return its id. '
      + 'The side chat inherits history as reference context; the main conversation is unchanged. '
      + 'Nothing is sent automatically — the user must open the child Session to continue.',
    // `parameters` is a property map (not a JSON-Schema object); `output.schema`
    // is the JSON-Schema-shaped result description.
    parameters: {
      text: {
        type: 'string',
        description: 'Optional question or excerpt to prefill in the side chat draft.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          childSessionId: { type: 'string' },
          draftText: { type: 'string' },
          label: { type: 'string' },
          code: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Side chat created: ${value.childSessionId} (${value.label})`
          : `Side chat failed: ${value.code} ${value.reason}`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        return { ok: false, code: 'no-agent', reason: 'no agent scope for this tool call' }
      }
      return service.createSideChat({
        sessionId: agent.sessionId,
        text: String(args.text ?? ''),
        depth: 0,
      })
    },
  })), 'side-chat: agent tool')

  return service
}
