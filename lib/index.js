/**
 * Host half of dsh-desktop-bridge.
 *
 * The desktop app ships no remote debugging port: the window is an Electron
 * renderer whose only inspector is the DevTools behind F12, and nothing
 * outside the process can reach its DOM. This plugin opens a narrow door
 * instead. A local caller submits one expression; the browser half of this
 * plugin, running inside the page, picks it up, evaluates it and sends the
 * value back.
 *
 * Two faces onto one state machine:
 *
 *   1. Five plain HTTP routes on the harness web server, under ROUTE_PREFIX.
 *      `exec` is the caller's side and holds its response open until the
 *      browser half answers or its deadline passes; `next` is the browser
 *      half's long poll; `result` closes the matching `exec`; `state`
 *      reports whether a browser half is listening. No WebSocket: the web
 *      server hands a route its raw request and response, and holding a
 *      response open is what its own SSE routes already do.
 *   2. Five model-facing tools on the same queue, so the two faces never race
 *      each other: `desktop_eval` (arbitrary expression), `desktop_inspect`
 *      (structured read-only selectors), `desktop_status` (diagnosis),
 *      `desktop_wait` (late result of a timed-out command), and
 *      `desktop_record` (timeline capture).
 *
 * A third piece serves debugging that has to start before the page does: a
 * fixed loader in the boot page's injection table runs the script the command
 * line armed in the page's storage, ahead of every plugin bundle.
 *
 * Fence: the socket address, the Host header and the browser's own cross-site
 * signals. The bridge evaluates arbitrary script in the page, so it refuses
 * anything that did not arrive over the loopback interface, whatever the Host
 * header claims. Loading the plugin is the opt-in; there is no second switch.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-desktop-bridge'

/** Route prefix this plugin owns. */
const ROUTE_PREFIX = '/dsh-desktop-bridge'
/** Caller side: submit one expression, hold until it is answered. */
const EXEC_PATH = `${ROUTE_PREFIX}/exec`
/** Browser half: long poll for the next expression. */
const NEXT_PATH = `${ROUTE_PREFIX}/next`
/** Browser half: hand back one evaluated expression. */
const RESULT_PATH = `${ROUTE_PREFIX}/result`
/** Caller side: start, read or stop one recording. */
const RECORD_PATH = `${ROUTE_PREFIX}/record`
/** Diagnosis: is a browser half listening, and what is in flight. */
const STATE_PATH = `${ROUTE_PREFIX}/state`

/** Longest a poll may be held, in ms. */
const MAX_POLL_WAIT_MS = 60_000
/** Hold used when a poll names no wait, in ms. */
const DEFAULT_POLL_WAIT_MS = 25_000
/** Deadline used when a caller names none, in ms. */
const DEFAULT_EXEC_TIMEOUT_MS = 15_000
/** Longest deadline a caller may ask for, in ms. */
const MAX_EXEC_TIMEOUT_MS = 120_000
/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 256 * 1024
/** Largest result body accepted from the browser half, in bytes. */
const MAX_RESULT_BYTES = 1024 * 1024
/**
 * How stale the newest poll may be before the browser half counts as gone, in
 * ms. The page holds one poll for DEFAULT_POLL_WAIT_MS and starts the next the
 * moment it ends, so a gap past that plus one scheduling margin means no page
 * is listening. A poll held right now is checked first, so a page that asked
 * for a longer wait is never counted out while it is waiting.
 */
const AGENT_STALE_MS = DEFAULT_POLL_WAIT_MS + 10_000
/**
 * Margin between the page's own await window and the caller's deadline, in ms.
 * The page gives up first, so a promise that never settles is reported as a
 * page failure naming the expression rather than as a bridge timeout.
 */
const PAGE_AWAIT_MARGIN_MS = 1500
/** Shortest await window handed to the page, in ms. */
const PAGE_AWAIT_MIN_MS = 500
/** Characters of one answer the model reads before the rest goes to a spill file. */
const RENDER_LIMIT_CHARS = 20000
/** Stack frames of a thrown expression kept for the model, after the message. */
const STACK_FRAMES = 6
/** Console entries rendered per answer. */
const CONSOLE_RENDERED = 20
/** Spill files kept under the results directory; older ones are dropped. */
const SPILL_KEEP = 20
/** The recording actions the page's recorder answers. */
const RECORD_ACTIONS = ['start', 'read', 'stop']
/** The extra action the host half answers itself: write the timeline to a file. */
const RECORD_EXPORT = 'export'
/** Every recording action a caller may name. */
const RECORD_REQUEST_ACTIONS = [...RECORD_ACTIONS, RECORD_EXPORT]
/** Exported recordings kept under the recordings directory; older ones are dropped. */
const RECORDING_KEEP = 20
/** How the operator's own face (the command line, which has no session) reads in a refusal. */
const OPERATOR_LABEL = 'the command line'
/** Deadline for one recording action, in ms: the actions themselves are quick. */
const RECORD_TIMEOUT_MS = 15000
/** Protocol version shared by both halves; a mismatch is reported, not fatal. */
const PROTOCOL_VERSION = 1
/** This package's version, read once for the status answer. */
const HOST_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()
/** How long a late result stays available to `desktop_wait`, in ms. */
const RECENT_TTL_MS = 60_000
/** How many late results are kept. */
const RECENT_MAX = 50
/** Longest `desktop_wait` may block, in ms. */
const WAIT_MAX_MS = 60_000
/** Largest selector batch `desktop_inspect` accepts. */
const INSPECT_MAX_SELECTORS = 16
/** Largest per-selector entry count `desktop_inspect` accepts. */
const INSPECT_MAX_LIMIT = 50
/** Largest serialized inspect answer, in characters. */
const INSPECT_MAX_BUDGET = 65_536

/**
 * One recording action's arguments, taken from the declared fields only, so the
 * page's recorder never sees a key this plugin did not promise it.
 * @param action - start, read or stop.
 * @param body - the caller's payload.
 * @returns the arguments to send.
 */
function recordArgs(action, body) {
  const args = { action }
  if (Array.isArray(body.channels)) args.channels = body.channels.filter((name) => typeof name === 'string')
  if (typeof body.selector === 'string') args.selector = body.selector
  if (typeof body.maxMs === 'number') args.maxMs = body.maxMs
  if (typeof body.limit === 'number') args.limit = body.limit
  if (typeof body.afterSeq === 'number') args.afterSeq = body.afterSeq
  if (typeof body.runId === 'string' && body.runId !== '') args.runId = body.runId
  return args
}

/**
 * Where the page keeps one armed boot script: `{ code, until }`. Local storage
 * rather than session storage: on the desktop a reload brings the whole app
 * back up, and session storage does not outlive the process.
 */
const BOOT_STORAGE_KEY = 'dsh-desktop-bridge:boot'
/**
 * The loader the host half adds to the boot page as a head script row. It runs
 * after the host's entry module and before any plugin bundle, so a script it
 * starts sees every plugin callback from its registration on.
 *
 * Reading does not remove the script: on the desktop a reload boots a page in
 * the app that is going down and then another in the app that comes back, and
 * a script the first one consumed would never reach the second. The command
 * line removes it once a fresh page reports back; until then every boot inside
 * the expiry runs it, and an expired one is removed here.
 */
const BOOT_LOADER = `(() => {
  const key = ${JSON.stringify(BOOT_STORAGE_KEY)}
  let raw = null
  try { raw = localStorage.getItem(key) } catch { return }
  if (raw === null) return
  let entry = null
  try { entry = JSON.parse(raw) } catch { return }
  if (entry === null || typeof entry.code !== 'string' || typeof entry.until !== 'number' || Date.now() > entry.until) {
    try { localStorage.removeItem(key) } catch {}
    return
  }
  const report = { ranAt: performance.now(), chars: entry.code.length, error: null }
  try { (0, eval)(entry.code) } catch (error) {
    report.error = String(error && error.stack || error)
    console.error('dsh-desktop-bridge: the boot script failed', error)
  }
  globalThis.__DSH_BRIDGE_BOOT__ = report
})()`

/**
 * One directory this plugin keeps its own files under, inside the DSH home.
 * @param parts - path segments below `dsh-desktop-bridge`.
 * @returns the absolute directory path.
 */
function pluginDirectory(...parts) {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-desktop-bridge', ...parts)
}

/**
 * The directory each live host half records its port in, one file per process.
 * The desktop binds a fresh port on every start; the command line reads these
 * instead of asking for `--port`. Only the port and the process id are written.
 */
function endpointDirectory() {
  return pluginDirectory('endpoints')
}

/**
 * Write one answer too large to render whole, and return its file.
 *
 * The answer is already in memory; the file is what lets a caller read the rest
 * after the model-facing render was cut short. Older spills are dropped so a
 * long session cannot fill the directory.
 * @param id - the answer's command id, which names the file.
 * @param text - the full JSON text of the answer's value.
 * @returns the file path.
 */
function writeSpill(id, text) {
  const directory = pluginDirectory('results')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${id}.json`)
  writeFileSync(file, text)
  try {
    const kept = readdirSync(directory)
      .filter((name) => name.endsWith('.json') && name !== `${id}.json`)
      .map((name) => ({ name, at: statSync(join(directory, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const entry of kept.slice(SPILL_KEEP - 1)) rmSync(join(directory, entry.name), { force: true })
  } catch { /* the directory is being pruned by another host half; the new file is written */ }
  return file
}

/** A spill id as this plugin writes it: the command id, which is a UUID. */
const SPILL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Read one slice of a spilled answer.
 *
 * @param id - the spill id from an earlier answer.
 * @param offset - character offset into the stored text.
 * @returns an answer envelope carrying the slice, in the shape the tool's
 *          output schema declares.
 * @throws when the id is not a spill id, or no such file is kept.
 */
function readSpill(id, offset) {
  if (!SPILL_ID.test(id)) throw new Error('desktop_eval: `spill` must be the id an earlier answer reported')
  const file = join(pluginDirectory('results'), `${id}.json`)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`desktop_eval: the spilled answer ${id} is no longer kept under ${file}`)
  }
  const from = clampInt(offset, 0, 0, text.length)
  const slice = text.slice(from, from + RENDER_LIMIT_CHARS)
  const next = from + slice.length
  const answer = {
    id,
    ok: true,
    value: slice,
    continued: true,
    spill: { id, path: file, total: text.length, shown: slice.length },
  }
  // The output schema declares a single type per field, so "there is no next
  // slice" is an absent key, never a null.
  if (next < text.length) answer.spill.nextOffset = next
  return answer
}

/**
 * Attach a spill handle to an answer whose value does not fit the render limit.
 * @param answer - the bridge's answer.
 * @returns the answer, with `spill` when the value was written to a file.
 */
function withSpill(answer) {
  if (answer === null || typeof answer !== 'object' || answer.ok !== true) return answer
  let text
  try {
    text = JSON.stringify(answer.value)
  } catch {
    return answer
  }
  if (text === undefined || text.length <= RENDER_LIMIT_CHARS) return answer
  const file = writeSpill(answer.id, text)
  return {
    ...answer,
    spill: { id: answer.id, path: file, total: text.length, shown: RENDER_LIMIT_CHARS, nextOffset: RENDER_LIMIT_CHARS },
  }
}

/** The model-facing tool name. */
const TOOL_NAME = 'desktop_eval'
/**
 * What the model reads before calling the tool. Kept short on purpose: this is
 * the whole reminder an agent gets, and the tool list is paid for on every
 * request.
 */
const TOOL_DESCRIPTION =
  'Evaluate a JavaScript expression inside the running DeepSeek Harness GUI page (the desktop window or a dsh web tab) and return its value, or continue reading an answer too large to return at once. ' +
  'Use it to inspect the live DOM, layout, computed styles and page activity: selectors, getBoundingClientRect(), getComputedStyle(), plugin attributes, and console output the expression itself produces. ' +
  'The expression runs in the page global scope; a returned promise is awaited inside the deadline. Values come back as JSON, DOM nodes as tag/id/class/text/rect, and every answer names the page it came from. ' +
  'Fails at once when no browser half is polling. From a shell the same bridge is `node <plugin>/bin/bridge.cjs "<expr>"`.'
/** Parameter copy for the expression. */
const TOOL_CODE_DESCRIPTION =
  'JavaScript expression to evaluate in the page global scope; required unless `spill` continues an earlier answer. ' +
  'Values: DOM nodes as tag/id/class/text/rect, depth 6 and 200 entries at most, 20000 characters rendered per answer with the rest written to a file.'
/** Parameter copy for the deadline. */
const TOOL_TIMEOUT_DESCRIPTION =
  'Deadline in milliseconds for the whole call, default 15000, maximum 120000. The page stops waiting on a promise 1500ms before it, so a promise that never settles is reported as a page failure naming the expression.'
/** Parameter copy for continuing a spilled answer. */
const TOOL_SPILL_DESCRIPTION = 'Id of a spilled answer to continue reading, as `spill.id` of an earlier answer; exclusive with `code`.'
/** Parameter copy for the continuation offset. */
const TOOL_OFFSET_DESCRIPTION = 'Character offset into that spilled answer; start at the `spill.nextOffset` an earlier read reported.'

/**
 * The model-facing tool's parameters.
 *
 * `code` is not required: a call that continues a spilled answer names `spill`
 * and `offset` instead, and the two shapes are told apart in `execute`.
 */
const TOOL_PARAMETERS = {
  code: { type: 'string', description: TOOL_CODE_DESCRIPTION },
  timeoutMs: { type: 'number', description: TOOL_TIMEOUT_DESCRIPTION },
  spill: { type: 'string', description: TOOL_SPILL_DESCRIPTION },
  offset: { type: 'number', description: TOOL_OFFSET_DESCRIPTION },
}

/** The model-facing name of the recorder tool. */
const RECORD_TOOL_NAME = 'desktop_record'
/**
 * What the model reads before calling the recorder.
 *
 * The two tools are separate rather than one tool with an action parameter:
 * evaluating an expression and watching the page over a window of time are
 * different intentions, and the recorder's parameters have nothing to do with
 * an expression.
 */
const RECORD_TOOL_DESCRIPTION =
  'Record what the GUI page does over a window of time — DOM attribute and child changes, fetch/XHR/WebSocket frames, and console output, including what your own calls print — then read it back in order. ' +
  'start begins one recording, read returns the entries after `afterSeq`, stop ends it. The recording keeps running in the page while you make other calls, so start it, then trigger the action (with desktop_eval, or by asking the reader to do it), then read. ' +
  'Every entry carries `seq`, `ch` and `t`, milliseconds since the recording\'s `startedAt`, so a timeline can be placed on the wall clock; a fetch\'s end names the `seq` of its start in `pair`, and an attribute change carries `from` and `to`, `null` when the attribute was absent. ' +
  'One recording runs at a time and belongs to the session that started it; its entries stay readable after it stops. ' +
  'read answers with what the recording holds so far and says whether more entries are waiting; the page keeps the newest 5000, dropping the oldest first, and reports what it dropped. ' +
  'Frame previews are capped at 200 characters. Use it to see what happened between two moments, such as which request a control sent and what the page did while it was in flight.'
/** The recorder tool's parameters. */
const RECORD_PARAMETERS = {
  action: { type: 'string', required: true, enum: RECORD_REQUEST_ACTIONS, description: 'start, read, stop or export.' },
  channels: { type: 'array', items: { type: 'string' }, description: 'start: which channels to record — dom, network, console; every channel when omitted.' },
  selector: { type: 'string', description: 'start: CSS selector for the element the dom channel watches, together with its subtree; the whole document when omitted.' },
  maxMs: { type: 'number', description: 'start: how long the recording runs before it stops itself, default and maximum 120000.' },
  afterSeq: { type: 'number', description: 'read: return entries whose sequence number is above this; continue from the `nextSeq` an earlier read reported.' },
  limit: { type: 'number', description: 'read: how many entries to return, default 200, maximum 1000.' },
  timeoutMs: { type: 'number', description: 'Deadline for this action in milliseconds, default 15000.' },
}

/** The model-facing name of the diagnostic tool. */
const STATUS_TOOL_NAME = 'desktop_status'
/** What the model reads before asking for the bridge state. */
const STATUS_TOOL_DESCRIPTION =
  'Report whether the browser half is polling, what the queue and in-flight set hold, the last page that answered, the plugin protocol versions, ' +
  'and any active recording. Call this after a timeout or an unavailable answer, before retrying a mutating expression. ' +
  'It is read-only and cheap: it never queues a command for the page.'
/** The diagnostic tool has no parameters. */
const STATUS_PARAMETERS = {}

/** The model-facing name of the read-only inspection tool. */
const INSPECT_TOOL_NAME = 'desktop_inspect'
/** What the model reads before inspecting the page. */
const INSPECT_TOOL_DESCRIPTION =
  'Inspect the live GUI page without evaluating arbitrary code: batch CSS selectors, optionally wait for them, and return count/rect/text/attrs/styles/html ' +
  'for a bounded number of matches. A selector that matches nothing answers matched:0; an invalid selector is reported for that selector only. ' +
  'Read-only, and safe to call while other work runs. Use desktop_eval only when the answer needs computation or the page must be changed.'
/** The inspection tool's parameters. */
const INSPECT_FIELDS = ['count', 'rect', 'text', 'attrs', 'styles', 'html']
const INSPECT_PARAMETERS = {
  selectors: { type: 'array', items: { type: 'string' }, description: `CSS selectors to inspect, 1-${String(INSPECT_MAX_SELECTORS)}.` },
  fields: { type: 'array', items: { type: 'string', enum: INSPECT_FIELDS }, description: 'What to return per match; default count, rect, text and attrs.' },
  styleProps: { type: 'array', items: { type: 'string' }, description: 'Computed CSS property names, used when fields includes styles; default display, position, width, height, color, background-color, font-size and z-index.' },
  waitMs: { type: 'number', description: 'Wait up to this long for the first selector to match, default 0, maximum 5000.' },
  limit: { type: 'number', description: `Maximum entries per selector, default 5, maximum ${String(INSPECT_MAX_LIMIT)}.` },
  budget: { type: 'number', description: `Maximum serialized characters, default ${String(RENDER_LIMIT_CHARS)}, maximum ${String(INSPECT_MAX_BUDGET)}.` },
  timeoutMs: { type: 'number', description: 'Deadline for the whole call in milliseconds, default 15000, maximum 120000.' },
}

/** The model-facing name of the late-result tool. */
const WAIT_TOOL_NAME = 'desktop_wait'
/** What the model reads before waiting for a late result. */
const WAIT_TOOL_DESCRIPTION =
  'Wait for a late result of a desktop_eval or desktop_record command whose caller already timed out. ' +
  'Pass the command id from the earlier answer. Waiting never resends or cancels the command; a NotReady answer means it is still not finished. ' +
  'Use this before retrying a mutating expression: the page may still have performed the original action.'
/** The late-result tool's parameters. */
const WAIT_PARAMETERS = {
  commandId: { type: 'string', required: true, description: 'The command id an earlier desktop_eval or desktop_record answer reported.' },
  waitMs: { type: 'number', description: `How long to wait, default 5000, maximum ${String(WAIT_MAX_MS)}.` },
}

/**
 * The answer envelope both tools declare: the bridge's own fields, with `value`
 * and `error` left to the author-only `json` node for arbitrary JSON.
 */
const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    ok: { type: 'boolean' },
    value: { type: 'json' },
    error: { type: 'json' },
    ms: { type: 'number' },
    page: { type: 'json' },
    console: { type: 'json' },
    since: { type: 'json' },
    continued: { type: 'boolean' },
    spill: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        path: { type: 'string' },
        total: { type: 'number' },
        shown: { type: 'number' },
        nextOffset: { type: 'number' },
      },
    },
    agentSeenMsAgo: { type: 'number' },
    // The host half's own answers, without the page.
    timedOut: { type: 'boolean' },
    unavailable: { type: 'boolean' },
    waiting: { type: 'boolean' },
    late: { type: 'boolean' },
  },
}

/**
 * The status answer. Its fields are diagnostic prose and counters rather than
 * a fixed command envelope, so nested objects use the author-only `json` node.
 */
const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent: { type: 'json' },
    queue: { type: 'number' },
    pending: { type: 'number' },
    served: { type: 'number' },
    tool: { type: 'boolean' },
    record: { type: 'json' },
    page: { type: 'json' },
    versions: { type: 'json' },
    limits: { type: 'json' },
    endpoint: { type: 'json' },
  },
}

/**
 * Refuse an argument the tool's own parameters do not declare.
 *
 * `defineTool` validates the declared fields and lets an undeclared one through
 * in silence, so a mistyped key would read as a missing one and send the caller
 * to fix the wrong thing. Naming the accepted keys is the answer.
 * @param toolName - the tool's public name, for the message.
 * @param declared - the parameter names it accepts.
 * @param args - the model's arguments.
 * @throws when an argument is undeclared.
 */
function assertDeclaredArguments(toolName, declared, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName}: invalid arguments; this tool accepts ${declared.join(', ')}`)
  }
  const unknown = Object.keys(args).filter((key) => !declared.includes(key))
  if (unknown.length > 0) {
    throw new Error(`${toolName}: unknown ${unknown.length === 1 ? 'argument' : 'arguments'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}; this tool accepts ${declared.join(', ')}`)
  }
}

/** Stable source keys for callers that have no string session id. */
const anonymousSources = new WeakMap()
let anonymousSourceSeq = 0

/**
 * The `since` source key for one tool call.
 *
 * A model tool call carries its agent session; every call from that session
 * shares one key, so the page can compare the state at this call with the
 * state at the previous one. The command line and HTTP callers have no
 * session: they are the operator, or a source string they name themselves.
 * @param exec - the tool execution context.
 * @returns the source key.
 */
function sourceOf(exec) {
  const session = exec?.agent?.session
  if (session === undefined || session === null) return 'operator'
  if (typeof session.id === 'string' && session.id !== '') return `session:${session.id}`
  const existing = anonymousSources.get(session)
  if (existing !== undefined) return existing
  anonymousSourceSeq += 1
  const key = `session:anonymous-${String(anonymousSourceSeq)}`
  anonymousSources.set(session, key)
  return key
}

/** The source key an HTTP body names, or the operator. */
function routeSource(body) {
  return typeof body.source === 'string' && body.source !== '' ? body.source : 'operator'
}

/**
 * Whether the request arrived over the loopback interface.
 *
 * Read from the socket rather than the Host header: a server bound to all
 * interfaces would otherwise answer a remote caller that simply claims a
 * loopback Host.
 * @param req - node request.
 * @returns true for 127.0.0.0/8, ::1 and their IPv4-mapped forms.
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/**
 * Why a request must be refused, or undefined when it may proceed.
 *
 * The fence is deliberately NOT the host's `connection.requestRejection()`:
 * that one wants the browser session cookie, and the bridge's caller is a
 * command line with no browser session at all (measured on a live host: it
 * answers 401). What has to stay out is a web page, so the checks are the
 * browser's own cross-site signals — the socket address, the Host header, the
 * fetch metadata and the Origin — which a local process does not send and a
 * browser cannot forge for a loopback target.
 * @param req - node request.
 * @returns 403, or undefined when the request may proceed.
 */
function refusalOf(req) {
  if (!isLoopback(req)) return 403
  const host = req.headers.host
  if (host !== undefined) {
    let name
    try {
      name = new URL(`http://${host}`).hostname
    } catch {
      return 403
    }
    if (name !== 'localhost' && name !== '[::1]' && !/^127\.\d+\.\d+\.\d+$/.test(name)) return 403
  }
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 403
  const origin = req.headers.origin
  if (origin === undefined) return undefined
  try {
    return new URL(origin).host === host ? undefined : 403
  } catch {
    return 403
  }
}

/** Send one JSON response; a caller that already left is not an error. */
function sendJson(res, status, payload) {
  let body
  try {
    body = Buffer.from(JSON.stringify(payload ?? null))
  } catch (error) {
    body = Buffer.from(JSON.stringify({ error: `unserialisable payload: ${error?.message ?? error}` }))
    status = 500
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch { /* the socket is gone; the caller's own timeout covers it */ }
}

/**
 * Read and parse a JSON request body.
 * @param req - node request.
 * @param limit - byte cap.
 * @returns the parsed value.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.byteLength
      if (size > limit) {
        reject(new Error(`body larger than ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`body is not JSON: ${error?.message ?? error}`))
      }
    })
  })
}

/** One query value as an integer, clamped, or the fallback. */
function queryInt(req, key, fallback, min, max) {
  const raw = new URL(req.url ?? '/', 'http://x').searchParams.get(key)
  if (raw === null) return fallback
  return clampInt(Number(raw), fallback, min, max)
}

/** A number clamped into range, or the fallback when it is not finite. */
function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** One error payload in the shape the browser half sends. */
function errorPayload(name, message) {
  return { __type: 'error', name, message, stack: null }
}

/**
 * The queue, the held callers and the waiting polls.
 *
 * One state machine behind both faces: an expression submitted by the tool and
 * one submitted over HTTP wait in the same queue and are served in the same
 * order.
 * @param flags - shared status flags the owner sets (currently whether the tool
 *   registered, reported by `state`).
 * @returns the two faces' handlers plus their status.
 */
function createBridge(flags) {
  /** Expressions waiting for a browser half to poll. */
  const queue = []
  /** Held callers by command id: routes settle a response, the tool a promise. */
  const pending = new Map()
  /** Long polls waiting for an expression. */
  const waiters = []
  let lastPollAt = 0
  let served = 0
  /** The last page information a result carried, for `desktop_status`. */
  let lastPage
  /** The browser half's own version and protocol, learned from its poll. */
  let lastClientVersion
  let lastClientProtocol
  /** Late results kept for `desktop_wait`, keyed by command id. */
  const recent = new Map()
  /** Told on every poll: the owner records the endpoint once a port is known. */
  let onPollListener = null

  /** Drop expired late results; called before every read/write of `recent`. */
  const pruneRecent = () => {
    const cutoff = Date.now() - RECENT_TTL_MS
    for (const [id, entry] of recent) {
      if (entry.at < cutoff) recent.delete(id)
    }
    while (recent.size > RECENT_MAX) {
      const oldest = recent.keys().next().value
      if (oldest === undefined) break
      recent.delete(oldest)
    }
  }

  /** Keep one late result for `desktop_wait`. */
  const remember = (id, payload) => {
    recent.delete(id)
    recent.set(id, { at: Date.now(), payload })
    pruneRecent()
  }

  const dropWaiter = (waiter) => {
    const at = waiters.indexOf(waiter)
    if (at !== -1) waiters.splice(at, 1)
    if (waiter.timer !== null) clearTimeout(waiter.timer)
    waiter.done = true
  }

  /** Answer a waiting poll with one command, or with 204 when it timed out. */
  const settleWaiter = (waiter, command) => {
    if (waiter.done) return
    dropWaiter(waiter)
    if (command === undefined) {
      try {
        waiter.res.writeHead(204)
        waiter.res.end()
      } catch { /* the poll already left */ }
      return
    }
    sendJson(waiter.res, 200, command)
  }

  /** Hand one command to a waiting poll, or queue it. */
  const dispatch = (command) => {
    const waiter = waiters.shift()
    if (waiter === undefined) {
      queue.push(command)
      return
    }
    settleWaiter(waiter, command)
  }

  /** Milliseconds since the newest poll, or null when this host half has seen none. */
  const agentSeenMsAgo = () => (lastPollAt === 0 ? null : Date.now() - lastPollAt)

  /**
   * The await window the page gets for one call: the deadline, less the margin
   * that lets the page answer before the host half stops waiting.
   */
  const pageAwaitMs = (timeoutMs) => Math.max(PAGE_AWAIT_MIN_MS, timeoutMs - PAGE_AWAIT_MARGIN_MS)

  /**
   * The diagnostic snapshot shared by `GET /state` and `desktop_status`.
   *
   * Everything a caller needs to tell "the page is gone" from "the page is
   * busy" is here, and every field is either present or absent — never null.
   * @returns the status object.
   */
  const status = () => {
    const seen = agentSeenMsAgo()
    const stale = seen !== null && seen > AGENT_STALE_MS
    const recordView = record === null
      ? undefined
      : {
          running: record.running,
          owner: record.ownerLabel,
          channels: record.channels,
          selector: record.selector,
          startedAt: record.startedAt,
          ...(record.runId === undefined ? {} : { runId: record.runId }),
        }
    return {
      agent: {
        state: seen === null ? 'never' : stale ? 'stale' : 'live',
        lastPollMsAgo: seen,
        stale,
        waiters: waiters.length,
      },
      queue: queue.length,
      pending: pending.size,
      served,
      tool: flags.tool === true,
      record: recordView ?? null,
      ...(lastPage === undefined ? {} : { page: lastPage }),
      versions: {
        host: HOST_VERSION,
        protocol: PROTOCOL_VERSION,
        ...(lastClientVersion === undefined ? {} : { client: lastClientVersion }),
        ...(lastClientProtocol === undefined ? {} : { clientProtocol: lastClientProtocol }),
      },
      limits: {
        defaultExecTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
        maxExecTimeoutMs: MAX_EXEC_TIMEOUT_MS,
        maxPollWaitMs: MAX_POLL_WAIT_MS,
        renderLimitChars: RENDER_LIMIT_CHARS,
        spillKeep: SPILL_KEEP,
        recordMaxMs: 120_000,
        recordMaxEntries: 5000,
        inspectMaxSelectors: INSPECT_MAX_SELECTORS,
        inspectMaxLimit: INSPECT_MAX_LIMIT,
        inspectMaxBudget: INSPECT_MAX_BUDGET,
      },
      endpoint: flags.endpoint ?? null,
    }
  }

  /**
   * Why the browser half counts as gone right now, or null when it is there.
   *
   * A held poll is the browser half being alive, and so is a poll inside the
   * stale window — unless an expression is already in flight, which means the
   * page may simply be busy with it. Refusing here is what keeps a caller from
   * waiting out the whole deadline to learn that nothing is listening.
   * @returns the reason, or null.
   */
  const agentUnavailable = () => {
    if (waiters.length > 0) return null
    if (lastPollAt === 0) return 'no browser half has polled this host half yet; open the DeepSeek Harness GUI page'
    const age = Date.now() - lastPollAt
    if (age > AGENT_STALE_MS && pending.size === 0) return `the browser half last polled ${age}ms ago; the page is closed, unloaded, or blocked`
    return null
  }

  /**
   * Submit one task — an expression, or a recording action — and call `settle`
   * with the answer.
   * @returns the command id, for cancellation.
   */
  const begin = (task, timeoutMs, settle) => {
    const id = randomUUID()
    const unavailable = agentUnavailable()
    if (unavailable !== null) {
      const seen = agentSeenMsAgo()
      settle({
        id,
        ok: false,
        error: errorPayload('Unavailable', unavailable),
        timedOut: false,
        unavailable: true,
        ...(seen === null ? {} : { agentSeenMsAgo: seen }),
      })
      return id
    }
    const entry = { done: false, timer: null, settle }
    entry.timer = setTimeout(() => {
      if (entry.done) return
      entry.done = true
      pending.delete(id)
      // A timeout is not a cancellation. Drop a command that never reached the
      // page, so it cannot run (and mutate the page) after its caller left.
      const queuedAt = queue.findIndex((command) => command.id === id)
      if (queuedAt !== -1) queue.splice(queuedAt, 1)
      const seen = agentSeenMsAgo()
      settle({
        id,
        ok: false,
        error: errorPayload('Timeout', `the browser half did not answer within ${timeoutMs}ms`),
        timedOut: true,
        ...(seen === null ? {} : { agentSeenMsAgo: seen }),
      })
    }, timeoutMs)
    pending.set(id, entry)
    dispatch({ id, timeoutMs, expiresAt: Date.now() + timeoutMs, ...task })
    return id
  }

  /** Forget one command: its caller left before the browser half answered. */
  const cancel = (id) => {
    const entry = pending.get(id)
    if (entry !== undefined && !entry.done) {
      entry.done = true
      clearTimeout(entry.timer)
      pending.delete(id)
    }
    const at = queue.findIndex((command) => command.id === id)
    if (at !== -1) queue.splice(at, 1)
  }

  /** Submit from the tool face: a promise instead of a held response. */
  const submitTask = (task, timeoutMs, signal) => new Promise((resolve) => {
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve(payload)
    }
    const id = begin(task, timeoutMs, finish)
    if (signal === undefined || signal === null || typeof signal.addEventListener !== 'function') return
    const onAbort = () => {
      cancel(id)
      const seen = agentSeenMsAgo()
      finish({
        id,
        ok: false,
        error: errorPayload('Aborted', 'the tool call was cancelled'),
        ...(seen === null ? {} : { agentSeenMsAgo: seen }),
      })
    }
    if (signal.aborted === true) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  /**
   * Submit one expression. The page gives up on a returned promise before this
   * deadline does, so a stuck expression is reported by the page rather than as
   * a bridge timeout.
   */
  const submit = (code, timeoutMs, signal, source) =>
    submitTask({ code, awaitMs: pageAwaitMs(timeoutMs), ...(source === undefined ? {} : { source }) }, timeoutMs, signal)

  /** Submit one recording action to the page's recorder. */
  const submitRecord = (args, timeoutMs, signal, source) =>
    submitTask({ kind: 'record', args, ...(source === undefined ? {} : { source }) }, timeoutMs, signal)

  /** Submit one structured, read-only inspection to the page. */
  const submitInspect = (args, timeoutMs, signal, source) =>
    submitTask({ kind: 'inspect', args, awaitMs: pageAwaitMs(timeoutMs), ...(source === undefined ? {} : { source }) }, timeoutMs, signal)

  /**
   * Wait for a late result of a command whose caller already timed out.
   *
   * Stays quiet about the command's original outcome: the only answers are the
   * late payload, or a `NotReady` failure when the wait itself expires.
   * @param id - the command id an earlier answer reported.
   * @param waitMs - how long to wait, in ms.
   * @returns the late answer, or a `NotReady` failure.
   */
  const waitFor = async (id, waitMs) => {
    const deadline = Date.now() + waitMs
    for (;;) {
      pruneRecent()
      const hit = recent.get(id)
      if (hit !== undefined) {
        return { ...hit.payload, late: true }
      }
      if (Date.now() >= deadline) {
        return {
          id,
          ok: false,
          error: errorPayload('NotReady', `no result for ${id} arrived within ${waitMs}ms; the page may still be running it`),
          waiting: true,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))))
    }
  }

  /**
   * The one recording in the page, and who holds it.
   *
   * The entries live in the page; this is only what a caller has to know before
   * acting on them: whether a recording runs, and which session started it. The
   * operator's own face (the command line, which has no session) is never
   * refused, and a session manages only the recording it started.
   */
  let record = null

  /** Why a caller may not act on the recording, or null when it may. */
  const recordRefusal = (owner) => {
    if (record === null) return 'no recording has been started in this host half; start one with action "start"'
    if (owner === null || record.owner === owner) return null
    return `the recording was started by ${record.ownerLabel}; a session reads and stops only the recording it started`
  }

  /** Fold one recording answer into what this host half knows about the recording. */
  const noteRecord = (owner, ownerLabel, args, payload) => {
    if (payload.ok !== true || payload.value === null || typeof payload.value !== 'object') return
    if (args.action === 'start') {
      record = {
        owner,
        ownerLabel,
        running: payload.value.running !== false,
        channels: payload.value.channels ?? [],
        selector: payload.value.selector ?? null,
        startedAt: payload.value.startedAt ?? Date.now(),
        ...(typeof payload.value.runId === 'string' ? { runId: payload.value.runId } : {}),
      }
      return
    }
    if (record !== null && payload.value.running === false) record.running = false
  }

  /**
   * Read a whole recording from the page and write it to a file.
   *
   * Exporting is a host-side composition of `read` calls: the page keeps its
   * buffers and ring-buffer accounting, and the host owns the file. The result
   * names the run, the path and how many entries were written.
   * @param owner - the calling session, or null for the operator's own face.
   * @param ownerLabel - how that owner reads in a refusal.
   * @param timeoutMs - the deadline for each read.
   * @param signal - the caller's abort signal.
   * @returns the export answer envelope.
   */
  const exportRecording = async (owner, ownerLabel, timeoutMs, signal, source) => {
    const refusal = recordRefusal(owner)
    if (refusal !== null) {
      const seen = agentSeenMsAgo()
      return {
        id: randomUUID(),
        ok: false,
        error: errorPayload('Unavailable', refusal),
        ...(seen === null ? {} : { agentSeenMsAgo: seen }),
      }
    }
    const entries = []
    let after = 0
    for (let pass = 0; pass < 10; pass += 1) {
      const payload = await submitRecord({ action: 'read', afterSeq: after, limit: 1000 }, timeoutMs, signal, source)
      if (payload.ok !== true) return payload
      const value = payload.value
      if (value === null || typeof value !== 'object' || !Array.isArray(value.entries)) return payload
      for (const entry of value.entries) entries.push(entry)
      if (value.complete !== false) break
      const next = value.nextSeq
      if (typeof next !== 'number' || next === after) break
      after = next
    }
    const id = randomUUID()
    const runId = typeof record?.runId === 'string' ? record.runId : id
    const directory = pluginDirectory('recordings')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, `${runId}.json`)
    const text = JSON.stringify({
      runId,
      exportedAt: Date.now(),
      startedAt: record?.startedAt ?? null,
      channels: record?.channels ?? [],
      selector: record?.selector ?? null,
      entries,
    }, null, 1)
    writeFileSync(file, text)
    try {
      const kept = readdirSync(directory)
        .filter((name) => name.endsWith('.json') && name !== `${runId}.json`)
        .map((name) => ({ name, at: statSync(join(directory, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
      for (const entry of kept.slice(RECORDING_KEEP - 1)) rmSync(join(directory, entry.name), { force: true })
    } catch { /* the directory is being pruned by another host half; the new file is written */ }
    return { id, ok: true, value: { runId, path: file, entries: entries.length, bytes: text.length } }
  }

  /**
   * One recording action from a caller, with the ownership rule applied.
   * @param args - the action and its parameters.
   * @param owner - the calling session, or null for the operator's own face.
   * @param ownerLabel - how that owner reads in a refusal.
   * @param timeoutMs - the call deadline.
   * @param signal - the caller's abort signal.
   * @returns the answer envelope.
   */
  const recordAction = (args, owner, ownerLabel, timeoutMs, signal, source) => {
    const prepared = { ...args }
    if (prepared.action === 'start' && typeof prepared.runId !== 'string') prepared.runId = randomUUID()
    if (prepared.action === RECORD_EXPORT) {
      return exportRecording(owner, ownerLabel, timeoutMs, signal, source)
    }
    if (prepared.action !== 'start') {
      const refusal = recordRefusal(owner)
      if (refusal !== null) {
        const seen = agentSeenMsAgo()
        return Promise.resolve({
          id: randomUUID(),
          ok: false,
          error: errorPayload('Unavailable', refusal),
          ...(seen === null ? {} : { agentSeenMsAgo: seen }),
        })
      }
    }
    return submitRecord(prepared, timeoutMs, signal, source).then((payload) => {
      noteRecord(owner, ownerLabel, prepared, payload)
      return payload
    })
  }

  const onRecord = async (req, res) => {
    const refused = refusalOf(req)
    if (refused !== undefined) {
      res.writeHead(refused)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let body
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
      return
    }
    const action = typeof body.action === 'string' ? body.action : ''
    if (!RECORD_REQUEST_ACTIONS.includes(action)) {
      sendJson(res, 400, { error: `action must be one of ${RECORD_REQUEST_ACTIONS.join(', ')}` })
      return
    }
    const timeoutMs = clampInt(body.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 1000, MAX_EXEC_TIMEOUT_MS)
    if (action === RECORD_EXPORT) {
      const payload = await exportRecording(null, OPERATOR_LABEL, timeoutMs, undefined, routeSource(body))
      sendJson(res, payload.unavailable === true ? 503 : 200, payload)
      return
    }
    const args = recordArgs(action, body)
    if (action === 'start' && typeof args.runId !== 'string') args.runId = randomUUID()
    const id = begin({ kind: 'record', args, source: routeSource(body) }, timeoutMs, (payload) => {
      noteRecord(null, OPERATOR_LABEL, { action }, payload)
      const status = payload.unavailable === true ? 503 : payload.timedOut === true ? 504 : 200
      sendJson(res, status, payload)
    })
    req.on('close', () => cancel(id))
  }

  const onExec = async (req, res) => {
    const refused = refusalOf(req)
    if (refused !== undefined) {
      res.writeHead(refused)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let body
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
      return
    }
    const code = typeof body.code === 'string' ? body.code : ''
    if (code.trim() === '') {
      sendJson(res, 400, { error: 'code must be a non-empty string' })
      return
    }
    const timeoutMs = clampInt(body.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 1000, MAX_EXEC_TIMEOUT_MS)
    // 503 says no page is listening, 504 says the page took the expression and
    // never answered; an expression that threw is a completed round trip and
    // stays 200 with `ok: false`, so a caller can tell "the bridge is down" from
    // "your script failed".
    const id = begin({ code, awaitMs: pageAwaitMs(timeoutMs), source: routeSource(body) }, timeoutMs, (payload) => {
      const status = payload.unavailable === true ? 503 : payload.timedOut === true ? 504 : 200
      sendJson(res, status, payload)
    })
    req.on('close', () => cancel(id))
  }

  const onNext = (req, res) => {
    const refused = refusalOf(req)
    if (refused !== undefined) {
      res.writeHead(refused)
      res.end()
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    lastPollAt = Date.now()
    // The browser half names its own version and protocol. A stale client
    // bundle after an update is then visible in desktop_status instead of
    // showing up as a mysterious schema or command error.
    const pollQuery = new URL(req.url ?? '/', 'http://x').searchParams
    const clientVersion = pollQuery.get('client')
    if (clientVersion !== null && clientVersion !== '') lastClientVersion = clientVersion
    const clientProtocol = Number(pollQuery.get('protocol'))
    if (Number.isFinite(clientProtocol)) lastClientProtocol = clientProtocol
    if (onPollListener !== null) onPollListener()
    const command = queue.shift()
    if (command !== undefined) {
      sendJson(res, 200, command)
      return
    }
    const waitMs = queryInt(req, 'wait', DEFAULT_POLL_WAIT_MS, 0, MAX_POLL_WAIT_MS)
    const waiter = { res, timer: null, done: false }
    waiters.push(waiter)
    if (waitMs > 0) waiter.timer = setTimeout(() => settleWaiter(waiter), waitMs)
    res.on('close', () => dropWaiter(waiter))
  }

  const onResult = async (req, res) => {
    const refused = refusalOf(req)
    if (refused !== undefined) {
      res.writeHead(refused)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let body
    try {
      body = await readBody(req, MAX_RESULT_BYTES)
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
      return
    }
    const id = typeof body.id === 'string' ? body.id : ''
    // "Nothing to report" is an absent key, never a null: the output schema
    // declares single types only.
    const payload = {
      id,
      ok: body.ok !== false,
      ...(body.value === undefined ? {} : { value: body.value }),
      ...(body.error === undefined ? {} : { error: body.error }),
      ...(typeof body.ms === 'number' ? { ms: body.ms } : {}),
      ...(body.page === undefined ? {} : { page: body.page }),
      ...(body.console === undefined ? {} : { console: body.console }),
      ...(body.since === undefined ? {} : { since: body.since }),
    }
    if (body.page !== undefined && body.page !== null) lastPage = body.page
    const entry = pending.get(id)
    if (entry === undefined) {
      // The caller already timed out, but the page may still finish the work.
      // Keep the late answer for desktop_wait instead of discarding it.
      remember(id, payload)
      sendJson(res, 404, { error: 'no command is waiting under that id' })
      return
    }
    if (entry.done) {
      sendJson(res, 409, { error: 'that command was already answered' })
      return
    }
    entry.done = true
    clearTimeout(entry.timer)
    pending.delete(id)
    served += 1
    entry.settle(payload)
    sendJson(res, 200, { ok: true })
  }

  const onState = (req, res) => {
    const refused = refusalOf(req)
    if (refused !== undefined) {
      res.writeHead(refused)
      res.end()
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    sendJson(res, 200, status())
  }

  /** Take every held caller down; the routes and the tool go with the plugin. */
  const dispose = () => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      waiter.done = true
    }
    for (const [id, entry] of pending) {
      entry.done = true
      clearTimeout(entry.timer)
      entry.settle({
        id,
        ok: false,
        error: errorPayload('Unloaded', 'the bridge was unloaded'),
      })
    }
    pending.clear()
    queue.length = 0
    record = null
  }

  const onPoll = (listener) => { onPollListener = listener }

  return { onExec, onNext, onResult, onState, onRecord, onPoll, submit, submitInspect, waitFor, status, recordAction, dispose }
}

/** One thrown value as the model reads it: the message, then where it was thrown. */
function renderError(error) {
  const name = String(error?.name ?? 'Error')
  const message = String(error?.message ?? 'the expression failed')
  const stack = typeof error?.stack === 'string'
    ? error.stack.split('\n').slice(1, STACK_FRAMES + 1).map((line) => line.trim()).filter((line) => line !== '')
    : []
  return stack.length === 0 ? `${name}: ${message}` : `${name}: ${message}\n${stack.join('\n')}`
}

/** The line naming the page that answered: which document, and whether it can animate. */
function renderPage(page) {
  if (page === null || page === undefined || typeof page !== 'object') return null
  const where = typeof page.href === 'string' ? page.href : '(page unknown)'
  const title = typeof page.title === 'string' && page.title !== '' ? ` "${page.title}"` : ''
  const state = [typeof page.visibility === 'string' ? page.visibility : null, page.focused === true ? 'focused' : 'unfocused'].filter((part) => part !== null).join(', ')
  const uptime = typeof page.uptime === 'number' ? `, up ${String(Math.round(page.uptime / 1000))}s` : ''
  return `page: ${where}${title} (${state}${uptime})`
}

/** The console output an expression produced, one line per entry. */
function renderConsole(entries) {
  const lines = [`console: ${String(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'}`]
  for (const entry of entries.slice(0, CONSOLE_RENDERED)) {
    const level = String(entry?.level ?? 'log')
    const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim()
    lines.push(`  [${level}] ${text}`)
  }
  if (entries.length > CONSOLE_RENDERED) lines.push(`  … ${String(entries.length - CONSOLE_RENDERED)} more`)
  return lines.join('\n')
}

/**
 * One recording read in words.
 *
 * The value's own fields say how far the read got and what the ring buffer
 * dropped; a caller reading a page of entries should not have to decode them to
 * know whether to read again, so the same facts are stated beside the JSON.
 * @returns the line, or null for an answer that is not a read.
 */
function renderRecordCoverage(value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.entries)) return null
  const head = [`record: ${String(value.entries.length)} entr${value.entries.length === 1 ? 'y' : 'ies'}`]
  if (typeof value.nextSeq === 'number') head.push(`through seq ${String(value.nextSeq)}`)
  head.push(value.running === true ? 'still recording' : 'stopped')
  const lines = [head.join(', ')]
  if (value.complete === false && typeof value.nextSeq === 'number') {
    lines.push(`  more entries are waiting; read again with afterSeq=${String(value.nextSeq)}`)
  }
  if (typeof value.lost === 'number' && value.lost > 0) {
    lines.push(`  ${String(value.lost)} entries were dropped before this read's cursor`)
  } else if (typeof value.dropped === 'number' && value.dropped > 0) {
    lines.push(`  ${String(value.dropped)} entries were dropped in total, the oldest first`)
  }
  return lines.join('\n')
}

/** The model-facing text for one `desktop_status` answer. */
function renderStatus(value) {
  const agent = value?.agent ?? {}
  const last = typeof agent.lastPollMsAgo === 'number' ? `${String(agent.lastPollMsAgo)}ms ago` : 'never'
  const lines = [`agent: ${String(agent.state ?? 'unknown')}, last poll ${last}, waiters ${String(agent.waiters ?? 0)}`]
  if (agent.stale === true) lines.push('  the last poll is outside the live window; the page may be closed, unloaded, or blocked')
  lines.push(`queue: ${String(value?.queue ?? 0)}, pending: ${String(value?.pending ?? 0)}, served: ${String(value?.served ?? 0)}`)
  const record = value?.record
  if (record === null || record === undefined) {
    lines.push('record: none')
  } else {
    lines.push(`record: ${record.running === true ? 'running' : 'stopped'}, owner ${String(record.owner ?? '?')}${typeof record.runId === 'string' ? `, run ${record.runId}` : ''}`)
  }
  const page = renderPage(value?.page)
  if (page !== null) lines.push(page)
  const versions = value?.versions ?? {}
  lines.push(`versions: host ${String(versions.host ?? '?')}, client ${String(versions.client ?? 'not seen')}, protocol ${String(versions.clientProtocol ?? versions.protocol ?? '?')}`)
  const limits = value?.limits ?? {}
  lines.push(`limits: ${String(limits.maxExecTimeoutMs ?? '?')}ms max, ${String(limits.renderLimitChars ?? '?')} chars rendered, ${String(limits.spillKeep ?? '?')} spills kept`)
  return lines.join('\n')
}

/** A one-line coverage summary for a structured inspect answer. */
function renderInspectCoverage(value) {
  if (value === null || typeof value !== 'object' || typeof value.coverage !== 'object' || value.coverage === null) return null
  const coverage = value.coverage
  const parts = [`inspect: ${String(coverage.selectorCount ?? 0)} selector(s)`]
  if (typeof coverage.matched === 'number') parts.push(`${String(coverage.matched)} match(es)`)
  parts.push(coverage.complete === true ? 'complete' : 'partial')
  if (typeof coverage.waitedMs === 'number' && coverage.waitedMs > 0) parts.push(`waited ${String(coverage.waitedMs)}ms`)
  if (coverage.omitted > 0) parts.push(`${String(coverage.omitted)} omitted`)
  if (coverage.pageHidden === true) parts.push('page hidden')
  return parts.join(', ')
}


/** The page changes one caller accumulated since its previous call. */
function renderSince(since) {
  if (since === null || since === undefined || typeof since !== 'object') return null
  const seconds = typeof since.windowMs === 'number' ? (since.windowMs / 1000).toFixed(1) : '0.0'
  if (since.baseline === true) {
    return since.windowMs > 0
      ? `since: baseline (no earlier call from this source within the last ${seconds}s)`
      : 'since: baseline (first call from this source)'
  }
  const parts = []
  const page = since.page ?? {}
  if (page.titleBefore !== undefined) parts.push(`title ${JSON.stringify(page.titleBefore)} → ${JSON.stringify(page.titleAfter)}`)
  if (page.hrefBefore !== undefined) parts.push(`href ${JSON.stringify(page.hrefBefore)} → ${JSON.stringify(page.hrefAfter)}`)
  if (page.visibilityBefore !== undefined) parts.push(`visibility ${String(page.visibilityBefore)} → ${String(page.visibilityAfter)}`)
  if (page.focusedBefore !== undefined) parts.push(`focus ${String(page.focusedBefore)} → ${String(page.focusedAfter)}`)
  if (Array.isArray(since.bodyAttrs)) {
    for (const attr of since.bodyAttrs.slice(0, 8)) {
      parts.push(`${String(attr.name)} ${JSON.stringify(attr.before)} → ${JSON.stringify(attr.after)}`)
    }
    if (since.bodyAttrs.length > 8) parts.push(`… ${String(since.bodyAttrs.length - 8)} more body attributes`)
  }
  if (since.nodes !== undefined) parts.push(`nodes ${String(since.nodes.before)} → ${String(since.nodes.after)}`)
  if (parts.length === 0) return `since: no page change in ${seconds}s`
  return `since your previous call (${seconds}s ago): ${parts.join('; ')}`
}

/** The model-facing text for one bridge answer. */
function renderToolResult(value) {
  if (value === null || value === undefined) return 'the bridge returned nothing'
  if (value.ok === false) {
    const lines = [renderError(value.error ?? {})]
    if (value.timedOut === true && typeof value.id === 'string') {
      lines.push(`command: ${value.id}`)
      lines.push(`the page may still be running; call desktop_wait({ commandId: "${value.id}", waitMs: 5000 }) before retrying a mutating expression`)
    }
    if (value.unavailable === true && typeof value.agentSeenMsAgo === 'number') {
      lines.push(`last browser poll: ${String(value.agentSeenMsAgo)}ms ago`)
    }
    if (value.waiting === true) lines.push('the command is still pending; inspect it before running it again')
    return lines.join('\n')
  }
  const spill = value.spill ?? null
  let text
  if (value.continued === true && typeof value.value === 'string') {
    // A continuation already is the slice the caller asked for: printing it
    // through JSON.stringify would spend the answer's characters on escaping.
    text = value.value
  } else {
    try {
      text = JSON.stringify(value.value, null, 1)
    } catch (error) {
      text = `unserialisable value: ${error?.message ?? error}`
    }
  }
  if (text === undefined) text = 'undefined'
  const limit = spill === null ? RENDER_LIMIT_CHARS : spill.shown
  const blocks = [text.length > limit ? text.slice(0, limit) : text]
  if (spill !== null) {
    const rest = spill.nextOffset === null || spill.nextOffset === undefined
      ? `the whole value is in ${spill.path}`
      : `the rest is in ${spill.path}; continue with desktop_eval({ spill: "${String(spill.id)}", offset: ${String(spill.nextOffset)} })`
    blocks.push(`… truncated at ${String(spill.shown)} of ${String(spill.total)} characters; ${rest}.`)
  }
  if (Array.isArray(value.console) && value.console.length > 0) blocks.push(renderConsole(value.console))
  const coverage = renderRecordCoverage(value.value)
  if (coverage !== null) blocks.push(coverage)
  const inspected = renderInspectCoverage(value.value)
  if (inspected !== null) blocks.push(inspected)
  const page = renderPage(value.page)
  if (page !== null) blocks.push(page)
  const since = renderSince(value.since)
  if (since !== null) blocks.push(since)
  return blocks.join('\n\n')
}

/**
 * Normalize one `desktop_inspect` call.
 *
 * The page answers every selector separately, so one malformed selector does
 * not fail the whole batch; this only rejects a call that names no selector at
 * all. Fields are filtered to the ones the page implements.
 * @param args - the model's arguments.
 * @returns the normalized inspect arguments.
 * @throws when no selector is supplied.
 */
function normalizeInspectArgs(args) {
  const selectors = Array.isArray(args.selectors)
    ? args.selectors.filter((selector) => typeof selector === 'string' && selector.trim() !== '').slice(0, INSPECT_MAX_SELECTORS)
    : []
  if (selectors.length === 0) {
    throw new Error(`desktop_inspect needs \`selectors\`: 1-${String(INSPECT_MAX_SELECTORS)} CSS selectors`)
  }
  const fields = Array.isArray(args.fields)
    ? args.fields.filter((field) => INSPECT_FIELDS.includes(field))
    : ['count', 'rect', 'text', 'attrs']
  const styleProps = Array.isArray(args.styleProps)
    ? args.styleProps.filter((prop) => typeof prop === 'string' && prop !== '').slice(0, 20)
    : []
  return {
    selectors,
    fields: fields.length === 0 ? ['count'] : fields,
    ...(styleProps.length === 0 ? {} : { styleProps }),
    waitMs: clampInt(args.waitMs, 0, 0, 5000),
    limit: clampInt(args.limit, 5, 1, INSPECT_MAX_LIMIT),
    budget: clampInt(args.budget, RENDER_LIMIT_CHARS, 1024, INSPECT_MAX_BUDGET),
  }
}

/**
 * Register the bridge routes and the model-facing tool.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  const flags = { tool: false }
  const bridge = createBridge(flags)

  const registerRoutes = (scope) => {
    scope.effect(() => {
      const disposers = []
      const warn = (message) => ctx.logger?.warn?.(`dsh-desktop-bridge: ${message}`)
      const add = (path, handler) => {
        try {
          disposers.push(scope.webServer.register({ kind: 'exact', path, handler }))
        } catch (error) {
          warn(`route ${path} unavailable: ${error?.message ?? error}`)
        }
      }
      add(EXEC_PATH, bridge.onExec)
      add(RECORD_PATH, bridge.onRecord)
      add(NEXT_PATH, bridge.onNext)
      add(RESULT_PATH, bridge.onResult)
      add(STATE_PATH, bridge.onState)

      // The endpoint file is written once the listener has a port: the
      // injection table is collected after the server binds (the desktop
      // collects it once at startup, `dsh web` on every index it serves).
      const endpointFile = join(endpointDirectory(), `${process.pid}.json`)
      let recordedPort
      // What `state` reports about the endpoint file, so a command line that
      // cannot find it can ask the host half why.
      flags.endpoint = { file: endpointFile, port: null, error: null }
      const recordEndpoint = () => {
        const port = scope.webServer.port
        if (typeof port !== 'number') {
          flags.endpoint.error = `the web server reports no port (${typeof port})`
          return
        }
        if (port === recordedPort) return
        try {
          mkdirSync(endpointDirectory(), { recursive: true })
          writeFileSync(endpointFile, JSON.stringify({ port, pid: process.pid, at: Date.now() }))
          recordedPort = port
          flags.endpoint.port = port
          flags.endpoint.error = null
        } catch (error) {
          flags.endpoint.error = String(error?.message ?? error)
          warn(`endpoint file ${endpointFile} unwritable: ${flags.endpoint.error}`)
        }
      }
      if (typeof scope.on === 'function') {
        disposers.push(scope.on('webserver/index-inject', (table) => {
          table.push({ kind: 'script', placement: 'head', text: BOOT_LOADER })
          recordEndpoint()
        }))
      } else {
        warn('this host has no index injection; boot scripts are unavailable')
      }
      bridge.onPoll(recordEndpoint)

      return () => {
        if (recordedPort !== undefined) rmSync(endpointFile, { force: true })
        bridge.dispose()
        for (const dispose of disposers) {
          try {
            dispose()
          } catch { /* the route may already be gone */ }
        }
      }
    }, 'dsh-desktop-bridge: routes')
  }

  const registerTool = (scope) => {
    scope.effect(() => {
      const definition = defineTool({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        parameters: TOOL_PARAMETERS,
        output: {
          // The bridge answer: `value` and `error` are arbitrary JSON, covered
          // by the author-only `json` node; the rest is a fixed shape.
          schema: ANSWER_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
        },
        execute: (args, exec) => {
          assertDeclaredArguments(TOOL_NAME, Object.keys(TOOL_PARAMETERS), args)
          const spill = typeof args.spill === 'string' && args.spill !== '' ? args.spill : null
          if (spill !== null) return Promise.resolve(readSpill(spill, args.offset))
          const code = typeof args.code === 'string' ? args.code : ''
          if (code.trim() === '') {
            throw new Error('desktop_eval needs `code` (an expression to evaluate) or `spill` (the id of an earlier answer to continue reading)')
          }
          return bridge.submit(
            code,
            clampInt(args.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 1000, MAX_EXEC_TIMEOUT_MS),
            exec === undefined || exec === null ? undefined : exec.signal,
            sourceOf(exec),
          ).then(withSpill)
        },
      })
      const recorder = defineTool({
        name: RECORD_TOOL_NAME,
        description: RECORD_TOOL_DESCRIPTION,
        parameters: RECORD_PARAMETERS,
        output: {
          schema: ANSWER_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
        },
        execute: (args, exec) => {
          assertDeclaredArguments(RECORD_TOOL_NAME, Object.keys(RECORD_PARAMETERS), args)
          const session = exec === undefined || exec === null || exec.agent === undefined || exec.agent === null
            ? null
            : exec.agent.session ?? null
          const ownerLabel = session === null ? OPERATOR_LABEL : 'another session'
          const action = typeof args.action === 'string' ? args.action : ''
          return bridge.recordAction(
            recordArgs(action, args),
            session,
            ownerLabel,
            clampInt(args.timeoutMs, RECORD_TIMEOUT_MS, 1000, MAX_EXEC_TIMEOUT_MS),
            exec === undefined || exec === null ? undefined : exec.signal,
            sourceOf(exec),
          ).then(withSpill)
        },
      })
      const statusTool = defineTool({
        name: STATUS_TOOL_NAME,
        description: STATUS_TOOL_DESCRIPTION,
        parameters: STATUS_PARAMETERS,
        output: {
          schema: STATUS_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
        },
        execute: (args) => {
          assertDeclaredArguments(STATUS_TOOL_NAME, [], args ?? {})
          return Promise.resolve(bridge.status())
        },
      })
      const waitTool = defineTool({
        name: WAIT_TOOL_NAME,
        description: WAIT_TOOL_DESCRIPTION,
        parameters: WAIT_PARAMETERS,
        output: {
          schema: ANSWER_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
        },
        execute: (args) => {
          assertDeclaredArguments(WAIT_TOOL_NAME, Object.keys(WAIT_PARAMETERS), args)
          const commandId = typeof args.commandId === 'string' ? args.commandId : ''
          if (commandId.trim() === '') throw new Error('desktop_wait needs `commandId` (the id an earlier answer reported)')
          return bridge.waitFor(commandId, clampInt(args.waitMs, 5000, 0, WAIT_MAX_MS)).then(withSpill)
        },
      })
      const inspectTool = defineTool({
        name: INSPECT_TOOL_NAME,
        description: INSPECT_TOOL_DESCRIPTION,
        parameters: INSPECT_PARAMETERS,
        isConcurrencySafe: () => true,
        output: {
          schema: ANSWER_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
        },
        execute: (args, exec) => {
          assertDeclaredArguments(INSPECT_TOOL_NAME, Object.keys(INSPECT_PARAMETERS), args)
          const timeoutMs = clampInt(args.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 1000, MAX_EXEC_TIMEOUT_MS)
          return bridge.submitInspect(
            normalizeInspectArgs(args),
            timeoutMs,
            exec === undefined || exec === null ? undefined : exec.signal,
            sourceOf(exec),
          ).then(withSpill)
        },
      })
      const disposers = [
        scope.tools.register(definition),
        scope.tools.register(recorder),
        scope.tools.register(statusTool),
        scope.tools.register(waitTool),
        scope.tools.register(inspectTool),
      ]
      flags.tool = true
      return () => {
        flags.tool = false
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-desktop-bridge: tools')
  }

  // Both surfaces wait for their service through inject: a host without a web
  // server or without a tool registry still activates, and one that mounts
  // later still gets its surface.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], registerRoutes)
    ctx.inject(['tools'], registerTool)
    return
  }
  registerRoutes(ctx)
}
