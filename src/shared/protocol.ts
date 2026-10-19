/**
 * The wire contract between the two halves.
 *
 * The host half and the browser half talk over five HTTP routes, so nothing in
 * the compiler used to connect what one half sends to what the other reads:
 * a renamed field showed up as `undefined` in a page far from the rename. This
 * module is that connection. Both halves import it; tsdown erases the type-only
 * imports and inlines `PROTOCOL_VERSION`, so the bundle carries the constant
 * and no runtime module.
 *
 * These types describe what the code ALREADY does. When a type does not fit the
 * implementation, the type is wrong — never change the behaviour to satisfy it.
 */

/** Protocol version shared by both halves; a mismatch is reported, not fatal. */
export const PROTOCOL_VERSION = 1

/** The recording actions the page's recorder answers. */
export type RecordAction = 'start' | 'read' | 'stop'
/** The extra action the host half answers itself: write the timeline to a file. */
export type RecordExportAction = 'export'
/** Every recording action a caller may name. */
export type RecordRequestAction = RecordAction | RecordExportAction
/** One recording channel. */
export type RecordChannel = 'dom' | 'network' | 'console'
/** One field `desktop_inspect` can project per match. */
export type InspectField = 'count' | 'rect' | 'text' | 'attrs' | 'styles' | 'html'

/**
 * One thrown value, in the shape the page serialises it into. `stack` is null
 * when the value carried no stack.
 */
export interface ErrorPayload {
  __type: 'error'
  name: string
  message: string
  stack: string | null
}

/** Which document answered, and whether it is in a state where timing means anything. */
export interface PageInfo {
  href: string
  title: string
  visibility: string
  focused: boolean
  uptime: number
}

/** One console call the expression made, captured while it ran. */
export interface ConsoleEntry {
  level: string
  text: string
}

/** One attribute change in the `since` fingerprint of `body`. */
export interface SinceAttribute {
  name: string
  before: string | null
  after: string | null
}

/** The page-level signals that changed between two calls from one source. */
export interface SinceView {
  baseline?: boolean
  windowMs?: number
  changed?: boolean
  page?: {
    titleBefore?: string
    titleAfter?: string
    hrefBefore?: string
    hrefAfter?: string
    visibilityBefore?: string
    visibilityAfter?: string
    focusedBefore?: boolean
    focusedAfter?: boolean
  }
  bodyAttrs?: SinceAttribute[]
  nodes?: { before: number; after: number }
}

/**
 * The arguments the page's recorder receives. Only the fields the tool
 * declares are ever forwarded, so the recorder never sees a key this plugin
 * did not promise it.
 */
export interface RecordArgs {
  action: RecordAction
  channels?: string[]
  selector?: string
  maxMs?: number
  limit?: number
  afterSeq?: number
  runId?: string
}

/** The arguments one structured, read-only inspection receives. */
export interface InspectArgs {
  selectors: string[]
  fields: string[]
  styleProps?: string[]
  waitMs: number
  limit: number
  budget: number
}

/** Fields every command carries, whatever its kind. */
export interface CommandBase {
  id: string
  timeoutMs: number
  /** Absolute deadline; the page skips a command whose deadline has passed. */
  expiresAt: number
  /** The `since` fingerprint key: one key per caller. */
  source?: string
}

/** One expression to evaluate in the page's global scope. */
export interface ExecCommand extends CommandBase {
  code: string
  /** How long the page waits on a returned promise. */
  awaitMs: number
}

/** One recording action for the page's recorder. */
export interface RecordCommand extends CommandBase {
  kind: 'record'
  args: RecordArgs
}

/** One structured, read-only inspection: the page runs no caller code. */
export interface InspectCommand extends CommandBase {
  kind: 'inspect'
  args: InspectArgs
  awaitMs: number
}

/** What the host half hands a waiting poll. */
export type Command = ExecCommand | RecordCommand | InspectCommand

/**
 * One result the page posts back to `/result`.
 *
 * `value` is whatever the page produced — an expression's value, a recording
 * read, an inspection answer — so it is opaque here on purpose: the page owns
 * its shape, and the host half only renders it.
 */
export interface PageResult {
  id: string
  ok: boolean
  value?: unknown
  error?: ErrorPayload
  ms?: number
  page?: PageInfo
  console?: ConsoleEntry[]
  since?: SinceView
}

/** A handle to an answer too large to render whole, written under `results/`. */
export interface Spill {
  id: string
  path: string
  total: number
  shown: number
  nextOffset?: number
}

/**
 * The envelope both faces answer with — the model tools, the command line and
 * the HTTP routes all hand back this shape.
 *
 * A field with no value is ABSENT, never null: the harness's output schema
 * accepts one type per field, and a null would make the whole tool result fail
 * validation with "invalid output", hiding the real reason. See DESIGN.md,
 * "输出契约：absent, not null".
 */
export interface Answer {
  id: string
  ok: boolean
  /** Arbitrary JSON from the page; the page owns its shape. */
  value?: any
  error?: ErrorPayload
  ms?: number
  page?: PageInfo
  console?: ConsoleEntry[]
  since?: SinceView
  /** A spill continuation: `value` is the raw slice, not JSON to stringify. */
  continued?: boolean
  spill?: Spill
  agentSeenMsAgo?: number
  timedOut?: boolean
  unavailable?: boolean
  waiting?: boolean
  /** A result that arrived after its caller gave up, fetched by `desktop_wait`. */
  late?: boolean
}
