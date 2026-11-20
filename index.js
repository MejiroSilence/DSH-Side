/**
 * Host half of the Side Chat bundle.
 *
 * v1 is deliberately empty: the bundle needs exactly one Loader row so that the
 * Web Client module can be discovered and mounted. All behavior lives in
 * `client.js`, where Sessions, Slots, resources and the right Sidebar live.
 *
 * The "boundary" note that separates inherited history from the new question is
 * therefore visible text prefilled into the child Session's draft, not a hidden
 * developer/system message. A v2 hidden boundary would be registered here:
 * `ctx.on('agent/created', ...)` plus `agent.ctx.effect(() =>
 * ctx.systemPrompt.section(...))`, and would need a Host service and an agent
 * tool so that one operation has both a UI caller and a tool caller. That work
 * is intentionally out of v1 scope (see README.md).
 *
 * Nothing is registered here, so no Host restart is needed when iterating on
 * the Client half: a Web page refresh is enough.
 */
export function apply() {}
