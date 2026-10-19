/**
 * Browser half of dsh-desktop-bridge.
 *
 * Runs inside the GUI page. It holds one long poll open against the host
 * half's `next` route; when an expression arrives it evaluates it in the
 * page's global scope, describes the value as plain JSON and posts it to the
 * `result` route. Nothing else about the page is touched, so the bridge works
 * the same in the desktop window and in a browser tab of `dsh web`.
 *
 * The loop never overlaps its own requests: the next poll is scheduled after
 * the previous response, so a slow evaluation cannot pile up sockets.
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-bridge',
  factory: function () {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** Route prefix, matching the host half. */
    var PREFIX = '/dsh-desktop-bridge'
    /** Long poll for the next expression. */
    var NEXT_ROUTE = PREFIX + '/next'
    /** Hand back one evaluated expression. */
    var RESULT_ROUTE = PREFIX + '/result'
    /** How long one poll is held open, in ms. */
    var POLL_WAIT_MS = 25000
    /** Protocol version shared with the host half; a mismatch is reported, not fatal. */
    var PROTOCOL_VERSION = 1
    /** This bundle's version, reported on every poll so a stale client is visible. */
    var CLIENT_VERSION = '0.3.0'
    /** Delay before polling again after a transport failure, in ms. */
    var RETRY_MS = 1500
    /** Longest delay between reconnect attempts, in ms. */
    var RETRY_MAX_MS = 30000
    /** Consecutive failed polls before the delay reaches its cap. */
    var RETRY_ATTEMPTS = 6
    /** Delay before polling again when the host half serves no such route, in ms. */
    var ABSENT_RETRY_MS = 30000
    /** Longest a returned promise is awaited when the command names no window, in ms. */
    var DEFAULT_AWAIT_MS = 10000
    /** Longest serialised value handed back, in characters. */
    var MAX_VALUE_CHARS = 400000
    /** Deepest object level described. */
    var MAX_DEPTH = 6
    /** Longest array, object or map described. */
    var MAX_ENTRIES = 200
    /** Console entries one answer carries. */
    var CONSOLE_MAX = 200
    /** Characters of one console entry's text. */
    var CONSOLE_TEXT_MAX = 400

    /** Which document answered, and whether it is in a state where timing means anything. */
    function pageInfo() {
      return {
        href: String(location.href),
        title: String(document.title || ''),
        visibility: document.visibilityState || 'unknown',
        focused: document.hasFocus(),
        uptime: Math.round(performance.now()),
      }
    }

    /** One DOM element as tag, identity and box. */
    function describeElement(element) {
      var rect = element.getBoundingClientRect()
      var text = (element.textContent || '').replace(/\s+/g, ' ').trim()
      return {
        __type: 'element',
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        className: typeof element.className === 'string' ? element.className : null,
        text: text.length > 200 ? text.slice(0, 200) + '…' : text,
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }
    }

    /**
     * Convert one value into plain JSON.
     *
     * Every branch is deliberate: a debugging value routinely contains DOM
     * nodes, functions, cycles and promises, and JSON.stringify alone would
     * either throw or hand back an empty object for all of them.
     */
    function describe(value, depth, seen) {
      if (value === null) return null
      var type = typeof value
      if (type === 'undefined') return { __type: 'undefined' }
      if (type === 'string' || type === 'boolean') return value
      if (type === 'number') return isFinite(value) ? value : String(value)
      if (type === 'bigint') return value.toString() + 'n'
      if (type === 'symbol') return value.toString()
      if (type === 'function') return { __type: 'function', name: value.name || '(anonymous)' }
      if (depth > MAX_DEPTH) return { __type: 'depth-limit', kind: Object.prototype.toString.call(value) }
      if (seen.indexOf(value) !== -1) return { __type: 'circular' }
      seen.push(value)
      try {
        if (typeof Element !== 'undefined' && value instanceof Element) return describeElement(value)
        if (value instanceof Error) {
          return { __type: 'error', name: value.name, message: value.message, stack: value.stack || null }
        }
        if (value instanceof Date) return { __type: 'date', iso: value.toISOString() }
        if (Array.isArray(value)) {
          var list = []
          var length = Math.min(value.length, MAX_ENTRIES)
          for (var i = 0; i < length; i++) list.push(describe(value[i], depth + 1, seen))
          if (value.length > MAX_ENTRIES) list.push({ __type: 'truncated', remaining: value.length - MAX_ENTRIES })
          return list
        }
        if (typeof Map !== 'undefined' && value instanceof Map) {
          var entries = []
          var mapped = 0
          value.forEach(function (entryValue, entryKey) {
            if (mapped >= MAX_ENTRIES) return
            mapped += 1
            entries.push([describe(entryKey, depth + 1, seen), describe(entryValue, depth + 1, seen)])
          })
          return { __type: 'map', size: value.size, entries: entries }
        }
        if (typeof Set !== 'undefined' && value instanceof Set) {
          var items = []
          var taken = 0
          value.forEach(function (item) {
            if (taken >= MAX_ENTRIES) return
            taken += 1
            items.push(describe(item, depth + 1, seen))
          })
          return { __type: 'set', size: value.size, items: items }
        }
        var out = {}
        var keys = Object.keys(value)
        for (var k = 0; k < keys.length && k < MAX_ENTRIES; k++) {
          try {
            out[keys[k]] = describe(value[keys[k]], depth + 1, seen)
          } catch (error) {
            out[keys[k]] = { __type: 'unreadable', error: String((error && error.message) || error) }
          }
        }
        if (keys.length > MAX_ENTRIES) out.__truncated = keys.length - MAX_ENTRIES
        return out
      } finally {
        seen.pop()
      }
    }

    /** One thrown value as a describable error object. */
    function describeError(error) {
      if (error && typeof error === 'object') {
        return {
          __type: 'error',
          name: error.name || 'Error',
          message: error.message || String(error),
          stack: error.stack || null,
        }
      }
      return { __type: 'error', name: 'Thrown', message: String(error), stack: null }
    }

    /** Keep one described value inside the payload budget. */
    function cap(value) {
      var text
      try {
        text = JSON.stringify(value)
      } catch (error) {
        return { __type: 'unserialisable', error: String((error && error.message) || error) }
      }
      if (text === undefined) return { __type: 'undefined' }
      if (text.length > MAX_VALUE_CHARS) {
        return { __type: 'truncated', chars: text.length, text: text.slice(0, MAX_VALUE_CHARS) }
      }
      return JSON.parse(text)
    }

    /** Console methods mirrored into an answer or a recording. */
    var CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug']

    /**
     * One console call as text. Arguments are described the way values are, so
     * a logged DOM node arrives as its tag and box rather than as "[object
     * HTMLDivElement]".
     */
    function consoleText(args) {
      var parts = []
      for (var i = 0; i < args.length && i < 10; i++) {
        var value = args[i]
        var text
        if (typeof value === 'string') text = value
        else if (value instanceof Error) text = value.name + ': ' + value.message
        else {
          try { text = JSON.stringify(describe(value, 0, [])) } catch (error) { text = String(value) }
        }
        parts.push(text)
      }
      var joined = parts.join(' ')
      return joined.length > CONSOLE_TEXT_MAX ? joined.slice(0, CONSOLE_TEXT_MAX) + '…' : joined
    }

    /**
     * Mirror console output into one sink until the returned function is called.
     *
     * Taps nest: an expression evaluated while a recording runs feeds both, and
     * each tap restores exactly the method it wrapped. A sink that throws must
     * not break the page's own logging, so it is contained here.
     */
    function tapConsole(sink) {
      var restores = []
      for (var i = 0; i < CONSOLE_LEVELS.length; i++) {
        (function (level) {
          var original = console[level]
          if (typeof original !== 'function') return
          console[level] = function () {
            try { sink(level, arguments) } catch (error) { /* a tap never breaks the page's own logging */ }
            return original.apply(console, arguments)
          }
          restores.push(function () { console[level] = original })
        })(CONSOLE_LEVELS[i])
      }
      return function () {
        for (var i = 0; i < restores.length; i++) restores[i]()
      }
    }

    /** Evaluate one expression in the page's global scope, with its console output. */
    function evaluate(code, awaitMs) {
      var started = Date.now()
      var entries = []
      var release = tapConsole(function (level, args) {
        if (entries.length >= CONSOLE_MAX) return
        entries.push({ level: level, text: consoleText(args) })
      })
      function done(result) {
        release()
        if (entries.length > 0) result.console = entries
        return result
      }
      var value
      try {
        value = (0, eval)(code)
      } catch (error) {
        return Promise.resolve(done({ ok: false, error: describeError(error), ms: Date.now() - started }))
      }
      if (value && typeof value.then === 'function') {
        return new Promise(function (resolve) {
          var settled = false
          var timer = setTimeout(function () {
            if (settled) return
            settled = true
            resolve(done({
              ok: false,
              error: {
                __type: 'error',
                name: 'Timeout',
                message: 'the expression did not settle within ' + awaitMs + 'ms, the window the call\'s deadline leaves for it',
                stack: null,
              },
              ms: Date.now() - started,
            }))
          }, awaitMs)
          value.then(function (settledValue) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(done({ ok: true, value: cap(describe(settledValue, 0, [])), ms: Date.now() - started }))
          }, function (error) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(done({ ok: false, error: describeError(error), ms: Date.now() - started }))
          })
        })
      }
      return Promise.resolve(done({ ok: true, value: cap(describe(value, 0, [])), ms: Date.now() - started }))
    }

    /** Fields `desktop_inspect` can return; ordering is also the default. */
    var INSPECT_FIELDS = ['count', 'rect', 'text', 'attrs', 'styles', 'html']
    /** Computed properties returned when `styles` is requested without props. */
    var DEFAULT_STYLE_PROPS = ['display', 'position', 'width', 'height', 'color', 'background-color', 'font-size', 'z-index']
    /** Longest text or HTML one inspect entry carries. */
    var INSPECT_TEXT_MAX = 500
    var INSPECT_HTML_MAX = 2000
    /** Attributes one inspect entry carries. */
    var INSPECT_ATTR_MAX = 30

    /** One element as the structured inspect result describes it. */
    function inspectElement(element, fields, styleProps) {
      var entry = {
        tag: element.tagName.toLowerCase(),
        id: element.id || undefined,
        className: typeof element.className === 'string' ? element.className : undefined,
      }
      if (fields.indexOf('rect') !== -1) {
        var box = element.getBoundingClientRect()
        entry.rect = [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)]
        entry.visible = box.width > 0 || box.height > 0
      }
      if (fields.indexOf('text') !== -1) {
        var text = (element.textContent || '').replace(/\s+/g, ' ').trim()
        entry.text = text.length > INSPECT_TEXT_MAX ? text.slice(0, INSPECT_TEXT_MAX) + '…' : text
      }
      if (fields.indexOf('attrs') !== -1) {
        var attrs = {}
        var list = element.attributes || []
        for (var i = 0; i < list.length && i < INSPECT_ATTR_MAX; i++) {
          var value = String(list[i].value)
          attrs[list[i].name] = value.length > INSPECT_TEXT_MAX ? value.slice(0, INSPECT_TEXT_MAX) + '…' : value
        }
        entry.attrs = attrs
        if (list.length > INSPECT_ATTR_MAX) entry.attrsOmitted = list.length - INSPECT_ATTR_MAX
      }
      if (fields.indexOf('styles') !== -1) {
        var style = getComputedStyle(element)
        var wanted = styleProps.length > 0 ? styleProps : DEFAULT_STYLE_PROPS
        var styles = {}
        for (var j = 0; j < wanted.length; j++) {
          var prop = wanted[j]
          var computed = style.getPropertyValue(prop)
          if (computed === '' && typeof style[prop] === 'string') computed = style[prop]
          styles[prop] = computed
        }
        entry.styles = styles
      }
      if (fields.indexOf('html') !== -1) {
        var html = String(element.outerHTML || '')
        entry.html = html.length > INSPECT_HTML_MAX ? html.slice(0, INSPECT_HTML_MAX) + '…' : html
        if (html.length > INSPECT_HTML_MAX) entry.htmlOmitted = html.length - INSPECT_HTML_MAX
      }
      return entry
    }

    /** One selector's matches. A bad selector is an entry error, not a fatal one. */
    function inspectSelector(selector, fields, styleProps, limit) {
      var nodes
      try {
        nodes = document.querySelectorAll(selector)
      } catch (error) {
        return { selector: selector, matched: 0, entries: [], error: String((error && error.message) || error) }
      }
      var matched = nodes.length
      var take = Math.min(matched, limit)
      var entries = []
      for (var i = 0; i < take; i++) entries.push(inspectElement(nodes[i], fields, styleProps))
      var result = { selector: selector, matched: matched, entries: entries }
      if (matched > take) result.omitted = matched - take
      return result
    }

    /** Shrink an inspect result until its JSON fits the requested budget. */
    function fitInspect(result, budget) {
      var length = JSON.stringify(result).length
      if (length <= budget) return result
      var omitted = 0
      while (length > budget) {
        var removed = false
        for (var i = result.selectors.length - 1; i >= 0; i--) {
          if (result.selectors[i].entries.length > 0) {
            result.selectors[i].entries.pop()
            result.selectors[i].omitted = (result.selectors[i].omitted || 0) + 1
            omitted += 1
            removed = true
            break
          }
        }
        if (!removed) break
        length = JSON.stringify(result).length
      }
      if (omitted > 0) {
        result.coverage.omitted = (result.coverage.omitted || 0) + omitted
        result.coverage.complete = false
      }
      return result
    }

    /**
     * Inspect one batch of selectors without evaluating caller-supplied code.
     * Waits for the first match when asked, then describes each selector's
     * matches. Missing selectors are data (`matched: 0`), not errors.
     */
    function inspect(args, awaitMs) {
      var started = Date.now()
      var selectors = Array.isArray(args.selectors) ? args.selectors.filter(function (s) { return typeof s === 'string' && s !== '' }) : []
      var fields = Array.isArray(args.fields) && args.fields.length > 0 ? args.fields.filter(function (f) { return INSPECT_FIELDS.indexOf(f) !== -1 }) : ['count', 'rect', 'text', 'attrs']
      if (fields.length === 0) fields = ['count']
      var styleProps = Array.isArray(args.styleProps) ? args.styleProps.filter(function (p) { return typeof p === 'string' && p !== '' }) : []
      var limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.round(args.limit), 50) : 5
      var budget = typeof args.budget === 'number' && args.budget > 0 ? Math.min(Math.round(args.budget), 65536) : 20000
      var waitMs = typeof args.waitMs === 'number' && args.waitMs > 0 ? Math.round(args.waitMs) : 0
      var window = typeof awaitMs === 'number' && awaitMs > 0 ? Math.max(0, awaitMs - 100) : 0
      if (waitMs > 5000) waitMs = 5000
      if (waitMs > window) waitMs = window
      var deadline = Date.now() + waitMs
      var waitedMs = 0

      function anyMatch() {
        for (var i = 0; i < selectors.length; i++) {
          try {
            if (document.querySelector(selectors[i]) !== null) return true
          } catch (error) { /* invalid selectors are reported later */ }
        }
        return false
      }

      function build() {
        var results = []
        var matched = 0
        var omitted = 0
        var invalid = 0
        for (var i = 0; i < selectors.length; i++) {
          var one = inspectSelector(selectors[i], fields, styleProps, limit)
          if (one.error !== undefined) invalid += 1
          matched += one.matched
          omitted += one.omitted || 0
          results.push(one)
        }
        var value = {
          selectors: results,
          coverage: {
            selectorCount: selectors.length,
            matched: matched,
            complete: invalid === 0,
            omitted: omitted,
            waitedMs: waitedMs,
            invalid: invalid,
            pageHidden: document.visibilityState === 'hidden',
          },
        }
        return fitInspect(value, budget)
      }

      function waitForMatch() {
        if (anyMatch() || Date.now() >= deadline) {
          waitedMs = Math.min(waitMs, Date.now() - (deadline - waitMs))
          return Promise.resolve({ ok: true, ms: Date.now() - started, value: build() })
        }
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(waitForMatch())
          }, Math.min(50, Math.max(0, deadline - Date.now())))
        })
      }

      if (selectors.length === 0) {
        return Promise.resolve({
          ok: false,
          ms: 0,
          error: { __type: 'error', name: 'Arguments', message: 'desktop_inspect needs at least one selector', stack: null },
        })
      }
      return waitForMatch()
    }

    /** How long a `since` comparison stays valid, in ms. */
    var SINCE_WINDOW_MS = 60000
    /** Last observed fingerprint per caller source. */
    var sinceState = {}

    /**
     * One cheap snapshot of the page's user-visible state.
     *
     * This is deliberately not a DOM diff: a title, route, body data-attribute,
     * visibility or node-count change is enough to tell a caller "the page
     * moved", and reading it costs a handful of property reads per command.
     */
    function sinceFingerprint() {
      var attrs = {}
      var list = document.body ? document.body.attributes : []
      for (var i = 0; i < list.length; i++) {
        var attribute = list[i]
        if (attribute.name.indexOf('data-') === 0) attrs[attribute.name] = String(attribute.value).slice(0, 200)
      }
      return {
        title: String(document.title || ''),
        href: String(location.href),
        visibility: document.visibilityState || 'unknown',
        focused: document.hasFocus(),
        bodyAttrs: attrs,
        nodes: document.querySelectorAll('*').length,
      }
    }

    /** The difference between two fingerprints, or a `changed: false` marker. */
    function sinceDiff(before, after) {
      var page = {}
      var counts = { title: 0, href: 0, visibility: 0, focused: 0, bodyAttrs: 0, nodes: 0 }
      if (before.title !== after.title) {
        page.titleBefore = before.title
        page.titleAfter = after.title
        counts.title = 1
      }
      if (before.href !== after.href) {
        page.hrefBefore = before.href
        page.hrefAfter = after.href
        counts.href = 1
      }
      if (before.visibility !== after.visibility) {
        page.visibilityBefore = before.visibility
        page.visibilityAfter = after.visibility
        counts.visibility = 1
      }
      if (before.focused !== after.focused) {
        page.focusedBefore = before.focused
        page.focusedAfter = after.focused
        counts.focused = 1
      }
      var names = {}
      var key
      for (key in before.bodyAttrs) names[key] = true
      for (key in after.bodyAttrs) names[key] = true
      var attrs = []
      for (key in names) {
        if (before.bodyAttrs[key] !== after.bodyAttrs[key]) {
          attrs.push({
            name: key,
            before: before.bodyAttrs[key] === undefined ? null : before.bodyAttrs[key],
            after: after.bodyAttrs[key] === undefined ? null : after.bodyAttrs[key],
          })
        }
      }
      counts.bodyAttrs = attrs.length
      if (before.nodes !== after.nodes) counts.nodes = 1
      var changed = counts.title + counts.href + counts.visibility + counts.focused + counts.bodyAttrs + counts.nodes > 0
      var diff = { changed: changed, counts: counts }
      if (counts.title + counts.href + counts.visibility + counts.focused > 0) diff.page = page
      if (attrs.length > 0) diff.bodyAttrs = attrs
      if (counts.nodes > 0) diff.nodes = { before: before.nodes, after: after.nodes }
      return diff
    }

    /**
     * The `since` block for one caller: what changed since that caller's
     * previous page command. Only a comparison inside the window is reported;
     * a first call, or one after the window, is explicitly a baseline.
     */
    function sinceFor(source) {
      var key = typeof source === 'string' && source !== '' ? source : 'operator'
      var now = Date.now()
      var current = sinceFingerprint()
      var previous = sinceState[key]
      sinceState[key] = { at: now, fingerprint: current }
      if (previous === undefined) return { baseline: true, windowMs: 0 }
      var windowMs = now - previous.at
      if (windowMs > SINCE_WINDOW_MS) return { baseline: true, windowMs: windowMs, reason: 'window' }
      var diff = sinceDiff(previous.fingerprint, current)
      var result = { baseline: false, windowMs: windowMs, changed: diff.changed, counts: diff.counts }
      if (diff.page !== undefined) result.page = diff.page
      if (diff.bodyAttrs !== undefined) result.bodyAttrs = diff.bodyAttrs
      if (diff.nodes !== undefined) result.nodes = diff.nodes
      return result
    }

    /** Channels a recording can carry. */
    var RECORD_CHANNELS = ['dom', 'network', 'console']
    /** Entries one recording keeps before the oldest are dropped. */
    var RECORD_MAX = 5000
    /** Longest a recording runs before it stops itself, in ms. */
    var RECORD_MAX_MS = 120000
    /** Entries one read returns when the caller names no limit. */
    var RECORD_READ_DEFAULT = 200
    /** Entries one read returns at most. */
    var RECORD_READ_MAX = 1000
    /** Characters of one recorded attribute value, URL or frame preview. */
    var RECORD_TEXT_MAX = 200

    /** A short identity for one node: tag, id and first class. */
    function nodeName(node) {
      if (node === null || node === undefined) return '(none)'
      if (node.nodeType === 3) return '#text'
      if (node.nodeType !== 1) return '#' + String(node.nodeType)
      var name = String(node.tagName || '').toLowerCase()
      if (node.id) name += '#' + node.id
      var cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : ''
      return cls === '' || cls === undefined ? name : name + '.' + cls
    }

    /** One recorded text field, kept short. */
    function short(value) {
      var text = value === null || value === undefined ? '' : String(value)
      return text.length > RECORD_TEXT_MAX ? text.slice(0, RECORD_TEXT_MAX) + '…' : text
    }

    /**
     * The page-side recorder: one recording at a time, held in a ring buffer and
     * read by sequence number.
     *
     * Its channels are the ones a page can hook at the moment a recording
     * starts. A frame arriving on a socket whose listener predates the
     * recording is only visible where the page reads it, which is why the
     * message tap wraps MessageEvent's own data property instead of a listener.
     */
    function createRecorder() {
      var state = null

      function push(entry) {
        entry.seq = state.seq
        entry.t = Math.round((performance.now() - state.startedPerf) * 10) / 10
        state.seq += 1
        state.entries.push(entry)
        if (state.entries.length > RECORD_MAX) {
          state.entries.shift()
          state.dropped += 1
        }
        return entry.seq
      }

      function releaseTaps() {
        for (var i = 0; i < state.taps.length; i++) {
          try { state.taps[i]() } catch (error) { /* one tap that cannot restore must not keep the rest wrapped */ }
        }
        state.taps = []
      }

      function installDom() {
        var root = document.documentElement
        if (state.selector !== null) {
          var found = document.querySelector(state.selector)
          if (found === null) throw new Error('record: no element matches ' + state.selector)
          root = found
        }
        var observer = new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var record = records[i]
            if (record.type === 'attributes') {
              // An absent attribute is recorded as null, not as the empty
              // string: a switch that drops `data-on` and one that sets it to
              // "" are different events, and a timeline has to tell them apart.
              var now = record.target.getAttribute(record.attributeName)
              push({
                ch: 'dom',
                kind: 'attribute',
                target: nodeName(record.target),
                attribute: record.attributeName,
                from: record.oldValue === null ? null : short(record.oldValue),
                to: now === null ? null : short(now),
              })
              continue
            }
            push({
              ch: 'dom',
              kind: 'children',
              target: nodeName(record.target),
              added: record.addedNodes.length,
              removed: record.removedNodes.length,
              first: record.addedNodes.length > 0 ? nodeName(record.addedNodes[0]) : record.removedNodes.length > 0 ? nodeName(record.removedNodes[0]) : null,
            })
          }
        })
        observer.observe(root, { attributes: true, attributeOldValue: true, childList: true, subtree: true })
        state.taps.push(function () { observer.disconnect() })
      }

      function installFetch() {
        if (typeof window.fetch !== 'function') return
        var original = window.fetch
        var mine = state
        window.fetch = function (input, init) {
          var url = typeof input === 'string' ? input : (input && input.url) || ''
          var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
          var startedAt = performance.now()
          var seq = push({ ch: 'network', kind: 'fetch', phase: 'start', method: method, url: short(url) })
          var pending = original.apply(this, arguments)
          pending.then(function (response) {
            // A request that settles after another recording took over belongs
            // to the one that saw it start; its end would be a false entry.
            if (state !== mine) return
            push({ ch: 'network', kind: 'fetch', phase: 'end', url: short(url), status: response.status, ok: response.ok, ms: Math.round(performance.now() - startedAt), pair: seq })
          }, function (error) {
            if (state !== mine) return
            push({ ch: 'network', kind: 'fetch', phase: 'error', url: short(url), ms: Math.round(performance.now() - startedAt), error: short((error && error.message) || error), pair: seq })
          })
          return pending
        }
        state.taps.push(function () { window.fetch = original })
      }

      function installXhr() {
        if (typeof XMLHttpRequest !== 'function') return
        var proto = XMLHttpRequest.prototype
        var originalOpen = proto.open
        var originalSend = proto.send
        proto.open = function (method, url) {
          try {
            this.__dshBridgeRequest = { method: String(method).toUpperCase(), url: short(url), at: performance.now() }
          } catch (error) { /* a frozen request object still has to reach the wire */ }
          return originalOpen.apply(this, arguments)
        }
        proto.send = function () {
          var request = this.__dshBridgeRequest
          var xhr = this
          var mine = state
          if (request !== undefined) {
            var seq = push({ ch: 'network', kind: 'xhr', phase: 'start', method: request.method, url: request.url })
            xhr.addEventListener('loadend', function () {
              if (state !== mine) return
              push({
                ch: 'network',
                kind: 'xhr',
                phase: xhr.status === 0 ? 'error' : 'end',
                url: request.url,
                status: xhr.status,
                ms: Math.round(performance.now() - request.at),
                pair: seq,
              })
            })
          }
          return originalSend.apply(this, arguments)
        }
        state.taps.push(function () {
          proto.open = originalOpen
          proto.send = originalSend
        })
      }

      function installSocket() {
        if (typeof WebSocket !== 'function') return
        var originalSend = WebSocket.prototype.send
        WebSocket.prototype.send = function (data) {
          push({
            ch: 'network',
            kind: 'ws-send',
            size: typeof data === 'string' ? data.length : (data && data.byteLength) || 0,
            preview: typeof data === 'string' ? short(data) : null,
          })
          return originalSend.apply(this, arguments)
        }
        state.taps.push(function () { WebSocket.prototype.send = originalSend })
        var descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')
        if (descriptor === undefined || typeof descriptor.get !== 'function') return
        Object.defineProperty(MessageEvent.prototype, 'data', {
          configurable: true,
          get: function () {
            var value = descriptor.get.call(this)
            if (this.type === 'message') {
              push({
                ch: 'network',
                kind: 'ws-message',
                size: typeof value === 'string' ? value.length : (value && value.byteLength) || 0,
                preview: typeof value === 'string' ? short(value) : null,
              })
            }
            return value
          },
        })
        state.taps.push(function () { Object.defineProperty(MessageEvent.prototype, 'data', descriptor) })
      }

      function installTaps() {
        var channels = state.channels
        if (channels.indexOf('dom') !== -1) installDom()
        if (channels.indexOf('network') !== -1) {
          installFetch()
          installXhr()
          installSocket()
        }
        if (channels.indexOf('console') !== -1) {
          state.taps.push(tapConsole(function (level, args) {
            push({ ch: 'console', level: level, text: consoleText(args) })
          }))
        }
      }

      /** Wait briefly for a selector; a missing one degrades to the document. */
      function waitForSelector(selector, timeoutMs) {
        if (selector === null) return Promise.resolve(true)
        return new Promise(function (resolve) {
          var deadline = Date.now() + timeoutMs
          function check() {
            try {
              if (document.querySelector(selector) !== null) { resolve(true); return }
            } catch (error) { resolve(false); return }
            if (Date.now() >= deadline) { resolve(false); return }
            setTimeout(check, 50)
          }
          check()
        })
      }

      function start(args) {
        if (state !== null && state.stoppedAt === null) {
          return {
            ok: false,
            ms: 0,
            error: { __type: 'error', name: 'Busy', message: 'a recording is already running; read it with action "read" and stop it with action "stop"', stack: null },
          }
        }
        var wanted = Array.isArray(args.channels) ? args.channels : []
        var channels = wanted.length === 0 ? RECORD_CHANNELS.slice() : RECORD_CHANNELS.filter(function (name) { return wanted.indexOf(name) !== -1 })
        if (channels.length === 0) {
          return {
            ok: false,
            ms: 0,
            error: { __type: 'error', name: 'Arguments', message: 'record: channels must name at least one of ' + RECORD_CHANNELS.join(', '), stack: null },
          }
        }
        var maxMs = typeof args.maxMs === 'number' && args.maxMs > 0 ? Math.min(Math.round(args.maxMs), RECORD_MAX_MS) : RECORD_MAX_MS
        var requested = typeof args.selector === 'string' && args.selector !== '' ? args.selector : null
        var runId = typeof args.runId === 'string' && args.runId !== '' ? args.runId : undefined
        return waitForSelector(requested, 500).then(function (matched) {
          state = {
            startedPerf: performance.now(),
            startedAt: Date.now(),
            channels: channels,
            selector: matched ? requested : null,
            selectorRequested: requested,
            selectorMatched: requested === null ? true : matched,
            runId: runId,
            entries: [],
            seq: 1,
            dropped: 0,
            taps: [],
            timer: null,
            stoppedAt: null,
          }
          try {
            installTaps()
          } catch (error) {
            releaseTaps()
            state = null
            return { ok: false, ms: 0, error: describeError(error) }
          }
          state.timer = setTimeout(function () { stop() }, maxMs)
          var value = {
            running: true,
            startedAt: state.startedAt,
            channels: channels,
            selectorRequested: requested,
            selectorMatched: state.selectorMatched,
            maxMs: maxMs,
            maxEntries: RECORD_MAX,
          }
          if (state.selector !== null) value.selector = state.selector
          if (runId !== undefined) value.runId = runId
          return { ok: true, ms: 0, value: value }
        })
      }

      /** What one read returns when there is nothing to read from. */
      function emptyRead() {
        return { ok: true, ms: 0, value: { running: false, entries: [], nextSeq: null, firstSeq: null, dropped: 0, lost: 0, complete: true, startedAt: null, stoppedAt: null } }
      }

      function read(args) {
        if (state === null) return emptyRead()
        var after = typeof args.afterSeq === 'number' && args.afterSeq > 0 ? Math.round(args.afterSeq) : 0
        var limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.round(args.limit), RECORD_READ_MAX) : RECORD_READ_DEFAULT
        var firstSeq = state.entries.length > 0 ? state.entries[0].seq : null
        var waiting = []
        for (var i = 0; i < state.entries.length; i++) {
          if (state.entries[i].seq > after) waiting.push(state.entries[i])
        }
        var page = waiting.slice(0, limit)
        var last = page.length > 0 ? page[page.length - 1].seq : null
        // Entries the ring buffer dropped before this read's cursor: the caller
        // has to know its timeline has a hole rather than a pause.
        var lost = firstSeq !== null && after > 0 && after < firstSeq - 1 ? firstSeq - after - 1 : 0
        var complete = waiting.length <= limit
        return {
          ok: true,
          ms: 0,
          value: {
            running: state.stoppedAt === null,
            entries: page,
            nextSeq: last === null ? (after > 0 ? after : null) : last,
            firstSeq: firstSeq,
            dropped: state.dropped,
            lost: lost,
            complete: complete,
            startedAt: state.startedAt,
            stoppedAt: state.stoppedAt,
            runId: state.runId,
            channels: state.channels,
            selectorRequested: state.selectorRequested,
            selectorMatched: state.selectorMatched,
            coverage: {
              channels: state.channels,
              selectorMatched: state.selectorMatched,
              dropped: state.dropped,
              lost: lost,
              complete: complete,
            },
          },
        }
      }

      function stop() {
        if (state === null) return emptyRead()
        if (state.stoppedAt === null) {
          state.stoppedAt = Date.now()
          if (state.timer !== null) clearTimeout(state.timer)
          state.timer = null
          releaseTaps()
        }
        var firstSeq = state.entries.length > 0 ? state.entries[0].seq : null
        var lastSeq = state.entries.length > 0 ? state.entries[state.entries.length - 1].seq : null
        return {
          ok: true,
          ms: 0,
          value: {
            running: false,
            entryCount: state.entries.length,
            firstSeq: firstSeq,
            nextSeq: lastSeq,
            dropped: state.dropped,
            startedAt: state.startedAt,
            stoppedAt: state.stoppedAt,
            runId: state.runId,
            channels: state.channels,
            selectorRequested: state.selectorRequested,
            selectorMatched: state.selectorMatched,
            coverage: {
              channels: state.channels,
              selectorMatched: state.selectorMatched,
              dropped: state.dropped,
              complete: true,
            },
          },
        }
      }

      /** One recording action, in the answer envelope the host half expects. */
      function run(args) {
        var action = typeof args.action === 'string' ? args.action : ''
        if (action === 'start') return Promise.resolve(start(args))
        if (action === 'read') return Promise.resolve(read(args))
        if (action === 'stop') return Promise.resolve(stop())
        return Promise.resolve({
          ok: false,
          ms: 0,
          error: { __type: 'error', name: 'Arguments', message: 'record: action must be start, read or stop', stack: null },
        })
      }

      return { run: run }
    }

    /** The page's one recorder, kept across poll restarts. */
    var recorder = createRecorder()

    /** Start the poll loop; the returned function stops it. */
    function start() {
      var stopped = false
      var timer = null
      var warnedAbsent = false
      var failedPolls = 0

      function schedule(delay) {
        if (stopped) return
        timer = setTimeout(tick, delay)
      }

      /** Bounded exponential backoff: 1.5s, 3s, 6s ... capped at 30s. */
      function retryDelay() {
        var delay = Math.min(RETRY_MAX_MS, RETRY_MS * Math.pow(2, failedPolls))
        if (failedPolls < RETRY_ATTEMPTS) failedPolls += 1
        return delay
      }

      function received() {
        failedPolls = 0
      }

      /** A result for a command whose deadline passed before the page saw it. */
      function expiredResult() {
        return {
          ok: false,
          ms: 0,
          error: { __type: 'error', name: 'Expired', message: 'the command expired before the page could run it', stack: null },
        }
      }

      function report(command, result) {
        result.id = command.id
        result.page = pageInfo()
        return fetch(RESULT_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(result),
        })
      }

      function tick() {
        if (stopped) return
        fetch(NEXT_ROUTE + '?wait=' + POLL_WAIT_MS + '&client=' + encodeURIComponent(CLIENT_VERSION) + '&protocol=' + PROTOCOL_VERSION, { credentials: 'same-origin', cache: 'no-store' })
          .then(function (response) {
            if (response.status === 204) {
              received()
              schedule(0)
              return null
            }
            // A host that knows the client bundle but never applied the host
            // half answers 404: the plugin is installed without being listed in
            // the profile's bundles. Say so once and stop hammering.
            if (response.status === 404 || response.status === 405) {
              if (!warnedAbsent) {
                warnedAbsent = true
                console.info('dsh-desktop-bridge: ' + NEXT_ROUTE + ' is not served; list the plugin in the profile bundles and restart the host')
              }
              schedule(ABSENT_RETRY_MS)
              return null
            }
            if (!response.ok) {
              schedule(retryDelay())
              return null
            }
            warnedAbsent = false
            received()
            return response.json()
          })
          .then(function (command) {
            if (command === null || command === undefined) return
            var since = sinceFor(command.source)
            var task
            if (typeof command.expiresAt === 'number' && Date.now() > command.expiresAt) {
              // The caller has already given up. Running a mutating expression
              // now would be a late side effect nobody asked for.
              task = Promise.resolve(expiredResult())
            } else if (command.kind === 'record') {
              task = recorder.run(command.args || {})
            } else if (command.kind === 'inspect') {
              task = inspect(command.args || {}, command.awaitMs)
            } else {
              var awaitMs = typeof command.awaitMs === 'number' && command.awaitMs > 0 ? command.awaitMs : DEFAULT_AWAIT_MS
              task = evaluate(command.code, awaitMs)
            }
            return task.then(function (result) {
              result.since = since
              return report(command, result).then(function () { schedule(0) }, function () { schedule(retryDelay()) })
            })
          })
          .catch(function () { schedule(retryDelay()) })
      }

      schedule(0)
      return function stop() {
        stopped = true
        if (timer !== null) clearTimeout(timer)
      }
    }

    /** Client entry: start the loop and tie its life to the plugin fiber. */
    function apply(ctx) {
      var stop = start()
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () { return stop })
      }
    }

    exports.apply = apply
    return module.exports
  },
})
