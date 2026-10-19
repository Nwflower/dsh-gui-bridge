/**
 * Frame attribution probe, for `dsh-desktop-bridge --boot probes/frame-attribution.js`.
 *
 * Times every frame callback, timer, observer callback and event listener by
 * the code that registered it, and keeps the page's long animation frames and
 * frame intervals beside them, in `globalThis.__bridgeFrames`. Read the result
 * with `--stdin < probes/frame-report.js`; `__bridgeFrames.mark()` starts a new
 * stretch.
 *
 * Armed as a boot script it runs after the host's entry module and before every
 * plugin bundle, so a plugin's callbacks are caught from their registration on.
 * The host's own scheduling (React's message channel, the stream socket) is
 * created in the entry module and stays outside the wrappers: the report shows
 * it as the part of the long frames no wrapper accounts for.
 *
 * A plugin's code is told apart inside a combined bundle through the module
 * loader: every module in a bundle opens with its own `__ModuleLoader__.load`
 * call, so the line that call comes from is where the module starts, and a
 * registration line maps to the module whose start precedes it. A minified
 * module may call `require` only deep inside its code, so the first `require`
 * would place its start too late.
 */
(() => {
  if (globalThis.__bridgeFrames !== undefined) return 'already installed'
  const probe = {
    installedAt: performance.now(),
    since: performance.now(),
    cost: new Map(),
    modules: new Map(),
    frames: [],
    loaf: [],
    mark() {
      probe.since = performance.now()
      probe.cost.clear()
      probe.frames.length = 0
      probe.loaf.length = 0
      return probe.since
    },
  }
  globalThis.__bridgeFrames = probe

  /** The first stack frame outside this probe: `{ url, line, column }`, or null. */
  const PROBE_DEPTH = 3
  function caller(skip) {
    const lines = String(new Error().stack).split('\n')
    for (let i = PROBE_DEPTH + skip; i < lines.length; i++) {
      const m = lines[i].match(/((?:dsh-app|https?|file|blob):\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/)
      if (m !== null) return { url: m[1], line: Number(m[2]), column: Number(m[3]) }
    }
    return null
  }

  function record(kind, site, ms) {
    const key = site === null ? kind + ' (no site)' : kind + ' ' + site.url + ':' + site.line + ':' + site.column
    let entry = probe.cost.get(key)
    if (entry === undefined) {
      entry = { kind, site, n: 0, ms: 0, max: 0 }
      probe.cost.set(key, entry)
    }
    entry.n += 1
    entry.ms += ms
    if (ms > entry.max) entry.max = ms
  }

  function timed(kind, site, fn) {
    return function () {
      const started = performance.now()
      try {
        return fn.apply(this, arguments)
      } finally {
        record(kind, site, performance.now() - started)
      }
    }
  }

  // The module loader: note where each registration's `load` call comes from.
  // The loader object can be created after this probe and its `load` replaced
  // later (a queue first, the real loader once the client modules arrive), so
  // both the object and the property are trapped. A registration the loader
  // hands on from its queue arrives again from the loader's own code; only the
  // first sighting, the bundle's own line, is kept.
  function noteModule(registration) {
    if (registration === null || typeof registration !== 'object' || registration.id === undefined) return
    const id = String(registration.id)
    if (probe.modules.has(id)) return
    const site = caller(1)
    if (site !== null) probe.modules.set(id, site)
  }
  function trapLoader(loader) {
    if (loader === null || typeof loader !== 'object') return loader
    let load = loader.load
    Object.defineProperty(loader, 'load', {
      configurable: true,
      enumerable: true,
      get() { return load },
      set(next) {
        load = typeof next === 'function' ? function (registration) {
          noteModule(registration)
          return next.apply(this, arguments)
        } : next
      },
    })
    loader.load = load
    return loader
  }
  let loader = trapLoader(globalThis.__ModuleLoader__)
  Object.defineProperty(globalThis, '__ModuleLoader__', {
    configurable: true,
    enumerable: true,
    get() { return loader },
    set(next) { loader = trapLoader(next) },
  })

  const raf = globalThis.requestAnimationFrame.bind(globalThis)
  globalThis.requestAnimationFrame = function (fn) { return raf(timed('frame', caller(0), fn)) }
  for (const name of ['setTimeout', 'setInterval']) {
    const original = globalThis[name].bind(globalThis)
    const kind = name === 'setTimeout' ? 'timeout' : 'interval'
    globalThis[name] = function (fn) {
      const rest = Array.prototype.slice.call(arguments, 1)
      return typeof fn === 'function' ? original.apply(null, [timed(kind, caller(0), fn)].concat(rest)) : original.apply(null, arguments)
    }
  }
  for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    const Base = globalThis[name]
    if (typeof Base !== 'function') continue
    const kind = name.replace('Observer', '').toLowerCase() + '-observer'
    globalThis[name] = class extends Base {
      constructor(fn, options) { super(timed(kind, caller(0), fn), options) }
    }
  }

  // Listeners: one wrapper per listener, so removeEventListener still finds
  // what addEventListener added.
  const wrapped = new WeakMap()
  const add = EventTarget.prototype.addEventListener
  const remove = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (listener === null || (typeof listener !== 'function' && typeof listener !== 'object')) return add.call(this, type, listener, options)
    let byType = wrapped.get(listener)
    if (byType === undefined) {
      byType = new Map()
      wrapped.set(listener, byType)
    }
    let wrapper = byType.get(type)
    if (wrapper === undefined) {
      const call = typeof listener === 'function' ? listener : function (event) { return listener.handleEvent(event) }
      wrapper = timed('event ' + type, caller(0), call)
      byType.set(type, wrapper)
    }
    return add.call(this, type, wrapper, options)
  }
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const byType = listener === null || listener === undefined ? undefined : wrapped.get(listener)
    const wrapper = byType === undefined ? undefined : byType.get(type)
    return remove.call(this, type, wrapper === undefined ? listener : wrapper, options)
  }

  if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        probe.loaf.push({
          start: e.startTime,
          duration: e.duration,
          blocking: e.blockingDuration,
          renderStart: e.renderStart,
          styleAndLayoutStart: e.styleAndLayoutStart,
        })
      }
    }).observe({ type: 'long-animation-frame' })
  }
  let last = performance.now()
  const tick = (now) => {
    probe.frames.push(now - last)
    last = now
    if (probe.frames.length < 500000) raf(tick)
  }
  raf(tick)
  return 'installed'
})()
