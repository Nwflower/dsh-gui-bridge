#!/usr/bin/env node
/**
 * End-to-end test for both halves of dsh-desktop-bridge.
 *
 * The host half is applied to a fake host: a real node:http server stands in
 * for the harness web server, and the plugin's own register/effect/inject
 * contract is honoured so the routes under test are the shipped ones. The
 * browser half is loaded by real headless Chrome from a page the same server
 * serves, which keeps the client's relative fetches same-origin.
 *
 * Usage: node test/bridge.test.cjs        (CHROME_PATH overrides the browser lookup)
 */
const { createServer } = require('node:http')
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = join(__dirname, '..')
const PREFIX = '/dsh-desktop-bridge'
/** The test's own DSH_HOME: the host half records its endpoint under it. */
const TEST_HOME = join(ROOT, '.debug', 'test-home')
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + name)
    return
  }
  failed += 1
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
}

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate !== undefined && candidate !== '' && existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The page the browser half runs in: the injection table's head rows, a module
 * loader shim, the bundle, and a two-module bundle whose second module keeps an
 * interval busy, which the frame probe has to attribute to it.
 */
const PAGE = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><title>bridge test</title></head>',
  '<body><p id="target">hello</p>',
  '<script>',
  'window.__ModuleLoader__ = { load: function (entry) {',
  '  var mod = entry.factory(function () { throw new Error("no client modules in this test") })',
  '  if (typeof mod.apply === "function") mod.apply({})',
  '} }',
  '</script>',
  '<script src="/client.js"></script>',
  '<script src="/subject.js"></script>',
  '</body></html>',
].join('\n')

/**
 * A combined bundle of two modules. The second sets its busy interval before it
 * ever calls require, the way a minified module does, so placing a module's
 * start at its first require would hand the interval to the first module.
 */
const SUBJECT = [
  'window.__ModuleLoader__.load({',
  '  id: "probe-neighbour",',
  '  factory: function () { return {} },',
  '})',
  'window.__ModuleLoader__.load({',
  '  id: "probe-subject",',
  '  factory: function (require) {',
  '    setInterval(function busy() { var until = performance.now() + 3; while (performance.now() < until) {} }, 40)',
  '    try { require("nothing") } catch (error) { /* the shim has no modules */ }',
  '    return {}',
  '  },',
  '})',
].join('\n')

/** The rendered page: each head row placed right after <head>, as the host does. */
function renderPage(rows) {
  const head = rows.filter((row) => row.placement === 'head').map((row) => '<script>' + row.text + '</script>').join('')
  return PAGE.replace('<head>', '<head>' + head)
}

async function main() {
  rmSync(TEST_HOME, { recursive: true, force: true })
  process.env.DSH_HOME = TEST_HOME
  const listeners = new Map()
  const routes = new Map()
  const tools = new Map()
  const disposers = []
  const scope = {
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    webServer: {
      port: undefined,
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
  }
  const ctx = {
    config: {},
    logger: { info() {}, warn: (...args) => console.log('  warn', ...args) },
    get: () => undefined,
    inject: (names, callback) => callback(scope),
  }

  const plugin = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  plugin.apply(ctx)

  // The framework's own validator, so a schema or an envelope the fake host
  // would have accepted cannot pass this test unnoticed.
  const sdk = await import(pathToFileURL(join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href)
  const validateEnvelope = (name, definition, value) => {
    const violations = sdk.validateJsonSchemaValue(definition.output.schema, value, 'value')
    check('the ' + name + ' answer passes the real output schema', violations.length === 0, JSON.stringify(violations).slice(0, 400))
  }

  console.log('tool')
  const definition = tools.get('desktop_eval')
  check('the tool registers', definition !== undefined)
  for (const [toolName, toolDefinition] of tools) {
    let accepted = true
    try {
      sdk.assertSupportedJsonSchema(toolDefinition.output.schema)
    } catch (error) {
      accepted = false
      check('the ' + toolName + ' output schema is accepted by the registry', false, String(error?.message ?? error))
    }
    if (accepted) check('the ' + toolName + ' output schema is accepted by the registry', true)
  }
  check('the tool description fits the reminder budget', definition !== undefined && definition.description.length <= 1200, definition === undefined ? 'no tool' : String(definition.description.length))
  check('the tool declares its four parameters',
    definition !== undefined && ['code', 'timeoutMs', 'spill', 'offset'].every((name) => definition.parameters?.properties?.[name] !== undefined),
    definition === undefined ? 'no tool' : JSON.stringify(Object.keys(definition.parameters?.properties ?? {})))
  const refusal = async (args) => {
    try {
      await definition.execute(args, { signal: undefined })
      return null
    } catch (error) {
      return String(error?.message ?? error)
    }
  }
  const missingArgs = await refusal({})
  check('the tool refuses a call that names neither an expression nor a spill', missingArgs !== null && missingArgs.includes('needs `code`'), String(missingArgs))
  const unknownArgs = await refusal({ cod: '1 + 1' })
  check('the tool refuses an argument it does not declare', unknownArgs !== null && unknownArgs.includes('unknown argument "cod"'), String(unknownArgs))

  const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  // The client module system keys boot graph rows by the package name, so a
  // bundle registering anything else loads without registering its row: the
  // page reports "import failed", the loader retries the row's own URL, and the
  // second execution throws a duplicate-registration error.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const registeredId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientSource)?.[1]
  check('the client bundle registers the package name as its row id', registeredId === manifest.name,
    'registered ' + String(registeredId) + ', package name ' + String(manifest.name))
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const handler = routes.get(url.pathname)
    if (handler !== undefined) {
      handler(req, res)
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const rows = []
      listeners.get('webserver/index-inject')?.(rows)
      const body = Buffer.from(renderPage(rows))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.byteLength) })
      res.end(body)
      return
    }
    if (url.pathname === '/subject.js') {
      const body = Buffer.from(SUBJECT)
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': String(body.byteLength) })
      res.end(body)
      return
    }
    if (url.pathname === '/client.js') {
      const body = Buffer.from(clientSource)
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': String(body.byteLength) })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  scope.webServer.port = port
  const base = 'http://127.0.0.1:' + String(port) + PREFIX

  const call = async (path, init) => {
    const response = await fetch(base + path, init)
    const text = await response.text()
    let body = null
    try { body = text === '' ? null : JSON.parse(text) } catch { body = { raw: text } }
    return { status: response.status, body }
  }
  const exec = (code, timeoutMs) => call('/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, timeoutMs }),
  })

  const browser = findBrowser()
  let child = null
  try {
    console.log('boot page')
    const rows = []
    listeners.get('webserver/index-inject')?.(rows)
    check('the host half adds one head script row to the boot page', rows.length === 1 && rows[0].kind === 'script' && rows[0].placement === 'head', JSON.stringify(rows.map((row) => [row.kind, row.placement])))
    check('the row is the boot loader', rows.length === 1 && rows[0].text.includes('dsh-desktop-bridge:boot'))
    const endpoints = existsSync(join(TEST_HOME, 'dsh-desktop-bridge', 'endpoints')) ? readdirSync(join(TEST_HOME, 'dsh-desktop-bridge', 'endpoints')) : []
    const endpoint = endpoints.length === 1 ? JSON.parse(readFileSync(join(TEST_HOME, 'dsh-desktop-bridge', 'endpoints', endpoints[0]), 'utf8')) : null
    check('the host half records its port once the boot page is collected', endpoint !== null && endpoint.port === port && endpoint.pid === process.pid, JSON.stringify(endpoint))

    console.log('\nhost half')
    const before = await call('/state')
    check('state reports no browser half before one connects', before.body.agent.lastPollMsAgo === null, JSON.stringify(before.body))
    check('state counts no waiters before one connects', before.body.agent.waiters === 0, JSON.stringify(before.body))

    const notPost = await call('/exec')
    check('exec refuses a GET with 405', notPost.status === 405, String(notPost.status))

    const empty = await exec('   ')
    check('exec refuses an empty expression with 400', empty.status === 400, String(empty.status))

    const badJson = await call('/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
    check('exec refuses a body that is not JSON with 400', badJson.status === 400, String(badJson.status))

    const unknownResult = await call('/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope', ok: true, value: 1 }),
    })
    check('result refuses an unknown id with 404', unknownResult.status === 404, String(unknownResult.status))

    const noAgentAt = Date.now()
    const noAgent = await exec('1 + 1', 20000)
    check('exec refuses a call with no browser half with 503', noAgent.status === 503 && noAgent.body.unavailable === true, JSON.stringify(noAgent))
    check('the refusal names the state instead of waiting out the deadline',
      Date.now() - noAgentAt < 2000 && noAgent.body.agentSeenMsAgo === undefined && noAgent.body.error.message.includes('no browser half'),
      JSON.stringify([Date.now() - noAgentAt, noAgent.body.error]))
    check('a refusal omits fields it has no value for',
      !('ms' in noAgent.body) && !('page' in noAgent.body) && !('console' in noAgent.body) && !('value' in noAgent.body),
      JSON.stringify(noAgent.body))
    validateEnvelope('unavailable', definition, noAgent.body)

    if (browser === null) {
      console.log('\nbrowser half — skipped: no Chrome/Edge found (set CHROME_PATH)')
    } else {
      const profileDir = join(ROOT, '.debug', 'chrome-profile')
      mkdirSync(profileDir, { recursive: true })
      child = spawn(browser, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + profileDir,
        'http://127.0.0.1:' + String(port) + '/',
      ], { stdio: 'ignore' })

      let agentSeen = false
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        const state = await call('/state')
        if (typeof state.body.agent.lastPollMsAgo === 'number') {
          agentSeen = true
          break
        }
      }
      console.log('\nbrowser half')
      check('a browser half polls the bridge', agentSeen)

      const arithmetic = await exec('1 + 1')
      check('arithmetic evaluates', arithmetic.body.ok === true && arithmetic.body.value === 2, JSON.stringify(arithmetic.body))

      const title = await exec('document.title')
      check('the page is reachable', title.body.value === 'bridge test', JSON.stringify(title.body.value))

      const count = await exec("document.querySelectorAll('p').length")
      check('selectors run against the live DOM', count.body.value === 1, JSON.stringify(count.body.value))

      const element = await exec("document.querySelector('#target')")
      check('a DOM node is described, not dropped', element.body.value && element.body.value.__type === 'element' && element.body.value.tag === 'p', JSON.stringify(element.body.value))
      check('the described node carries a real box', element.body.value && element.body.value.rect.width > 0, JSON.stringify(element.body.value && element.body.value.rect))

      const cycle = await exec('(function () { var a = {}; a.self = a; return a })()')
      check('a cycle is marked, not fatal', cycle.body.ok === true && cycle.body.value.self && cycle.body.value.self.__type === 'circular', JSON.stringify(cycle.body.value))

      const missing = await exec("document.querySelector('#absent')")
      check('a missing node answers null', missing.body.ok === true && missing.body.value === null, JSON.stringify(missing.body.value))

      const threw = await exec("throw new Error('boom')")
      check('a thrown error comes back as a failure', threw.status === 200 && threw.body.ok === false && threw.body.error.message === 'boom', JSON.stringify(threw.body))

      const promised = await exec('Promise.resolve(41 + 1)')
      check('a returned promise is awaited', promised.body.ok === true && promised.body.value === 42, JSON.stringify(promised.body))

      const named = await exec('1')
      check('an answer names the page it came from',
        named.body.page !== null && typeof named.body.page.href === 'string' && named.body.page.href.startsWith('http://127.0.0.1:') && typeof named.body.page.visibility === 'string' && typeof named.body.page.focused === 'boolean' && named.body.page.uptime > 0,
        JSON.stringify(named.body.page))

      const logged = await exec("console.warn('careful'); 7")
      check('console output the expression produces comes back',
        logged.body.value === 7 && Array.isArray(logged.body.console) && logged.body.console.length === 1 && logged.body.console[0].level === 'warn' && logged.body.console[0].text === 'careful',
        JSON.stringify(logged.body.console))

      const stack = await exec("(function outer() { throw new Error('deep') })()")
      const stackText = definition.output.render({}, stack.body)[0].text
      check('a thrown error keeps where it was thrown', stackText.includes('deep') && /\n\s*at /.test(stackText), JSON.stringify(stackText))

      const insideWindow = await exec("new Promise(function (r) { setTimeout(function () { r('late') }, 800) })", 3000)
      check('a promise inside the page\'s window is awaited', insideWindow.body.ok === true && insideWindow.body.value === 'late', JSON.stringify(insideWindow.body))

      const pastWindow = await exec("new Promise(function (r) { setTimeout(function () { r('never') }, 5000) })", 3000)
      check('the page gives up on a promise before the call deadline, and names the window',
        pastWindow.status === 200 && pastWindow.body.ok === false && pastWindow.body.error.name === 'Timeout' && pastWindow.body.error.message.includes('within 1500ms'),
        JSON.stringify(pastWindow.body))

      const lost = await exec("setTimeout(function () { location.reload() }, 50); new Promise(function () {})", 4000)
      check('an answer the page never sends hits the deadline with 504', lost.status === 504 && lost.body.timedOut === true, JSON.stringify(lost))
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const back = await call('/state')
        if (typeof back.body.agent.lastPollMsAgo === 'number' && back.body.agent.lastPollMsAgo < 3000) break
      }

      const after = await call('/state')
      check('state counts the served commands', after.body.served >= 8, JSON.stringify(after.body))

      console.log('\ntool')
      const viaTool = await definition.execute({ code: '1 + 1' }, { signal: undefined })
      check('the tool reaches the same queue as the routes', viaTool.ok === true && viaTool.value === 2, JSON.stringify(viaTool))
      validateEnvelope('success', definition, viaTool)

      const toolError = await definition.execute({ code: "throw new Error('from tool')" }, { signal: undefined })
      check('the tool reports an expression failure', toolError.ok === false && toolError.error.message === 'from tool', JSON.stringify(toolError))
      validateEnvelope('expression failure', definition, toolError)

      const sessionA = { id: 'since-a' }
      const sessionB = { id: 'since-b' }
      const firstA = await definition.execute({ code: '1 + 1' }, { agent: { session: sessionA }, signal: undefined })
      check('a first call from a source carries a baseline since',
        firstA.since !== undefined && firstA.since.baseline === true && firstA.since.changed === undefined,
        JSON.stringify(firstA.since))
      const firstB = await definition.execute({ code: '1 + 1' }, { agent: { session: sessionB }, signal: undefined })
      check('a different source starts from its own baseline',
        firstB.since !== undefined && firstB.since.baseline === true,
        JSON.stringify(firstB.since))
      await exec("document.title = 'bridge test 2'; document.body.setAttribute('data-since-probe', '1')")
      const secondA = await definition.execute({ code: '1 + 1' }, { agent: { session: sessionA }, signal: undefined })
      check('a later call from the same source carries the page change',
        secondA.since !== undefined && secondA.since.baseline === false && secondA.since.changed === true
        && secondA.since.page !== undefined && secondA.since.page.titleAfter === 'bridge test 2'
        && Array.isArray(secondA.since.bodyAttrs)
        && secondA.since.bodyAttrs.some((attr) => attr.name === 'data-since-probe' && attr.after === '1'),
        JSON.stringify(secondA.since))
      validateEnvelope('since', definition, secondA)
      const thirdA = await definition.execute({ code: '1 + 1' }, { agent: { session: sessionA }, signal: undefined })
      check('a call with no page change says so instead of inventing a diff',
        thirdA.since !== undefined && thirdA.since.baseline === false && thirdA.since.changed === false,
        JSON.stringify(thirdA.since))

      const httpFirst = await call('/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '1 + 1', source: 'http-since', timeoutMs: 5000 }),
      })
      const httpSecond = await call('/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '1 + 1', source: 'http-since', timeoutMs: 5000 }),
      })
      check('an HTTP caller gets a baseline and then a comparison',
        httpFirst.body.since !== undefined && httpFirst.body.since.baseline === true
        && httpSecond.body.since !== undefined && httpSecond.body.since.baseline === false,
        JSON.stringify([httpFirst.body.since, httpSecond.body.since]))
      await exec("document.body.setAttribute('data-http-since', 'yes')")
      const httpThird = await call('/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '1 + 1', source: 'http-since', timeoutMs: 5000 }),
      })
      check('an HTTP source sees a change made between its calls',
        httpThird.body.since !== undefined && httpThird.body.since.changed === true
        && httpThird.body.since.bodyAttrs.some((attr) => attr.name === 'data-http-since' && attr.after === 'yes'),
        JSON.stringify(httpThird.body.since))
      validateEnvelope('http since', definition, httpThird.body)

      const rendered = definition.output.render({ code: '1 + 1' }, viaTool)
      check('the tool renders model-facing text', Array.isArray(rendered) && rendered[0].type === 'text' && rendered[0].text.startsWith('2'), JSON.stringify(rendered))
      check('the render names the page that answered', rendered[0].text.includes('page: http://127.0.0.1:'), JSON.stringify(rendered[0].text))

      const big = await definition.execute({ code: "'x'.repeat(30000)" }, { signal: undefined })
      check('an answer too large to render is spilled to a file',
        big.spill !== undefined && big.spill.total > 20000 && big.spill.nextOffset === 20000 && existsSync(big.spill.path),
        JSON.stringify(big.spill))
      const bigText = definition.output.render({}, big)[0].text
      check('the render names the spill and how to continue',
        bigText.includes('truncated at 20000 of') && bigText.includes('spill: "' + big.spill.id + '"'),
        bigText.slice(0, 200))
      const rest = await definition.execute({ spill: big.spill.id, offset: big.spill.nextOffset }, { signal: undefined })
      check('a spilled answer can be continued',
        rest.continued === true && rest.value.length === big.spill.total - 20000 && rest.spill.nextOffset === undefined && rest.ms === undefined,
        JSON.stringify([rest.value.length, big.spill.total, rest.spill.nextOffset]))
      validateEnvelope('spill continuation', definition, rest)
      const unknownSpill = await definition.execute({ spill: 'nope' }, { signal: undefined }).then(() => null, (error) => String(error?.message))
      check('a spill id that is not one is refused', unknownSpill !== null && unknownSpill.includes('must be the id'), String(unknownSpill))

      const toolState = await call('/state')
      check('state reports the tool as registered', toolState.body.tool === true, JSON.stringify(toolState.body))

      console.log('\nstatus, inspect and wait')
      const statusTool = tools.get('desktop_status')
      check('the status tool registers', statusTool !== undefined)
      const liveStatus = await statusTool.execute({}, { signal: undefined })
      check('status reports a live browser half',
        liveStatus.agent.state === 'live' && typeof liveStatus.agent.lastPollMsAgo === 'number' && liveStatus.agent.waiters >= 0,
        JSON.stringify(liveStatus.agent))
      // The browser half reports the version the build injected from
      // package.json (tsdown `define`), so comparing against the manifest here
      // is what catches a broken injection — the number used to be typed into
      // the source by hand and could drift from the package without a signal.
      const manifestVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
      check('status reports both versions',
        typeof liveStatus.versions.host === 'string' && liveStatus.versions.host === manifestVersion &&
          liveStatus.versions.client === manifestVersion && liveStatus.versions.clientProtocol === 1,
        JSON.stringify(liveStatus.versions) + ' manifest ' + manifestVersion)
      check('status renders model-facing text',
        statusTool.output.render({}, liveStatus)[0].text.includes('agent: live') && statusTool.output.render({}, liveStatus)[0].text.includes('versions:'),
        statusTool.output.render({}, liveStatus)[0].text.slice(0, 240))
      validateEnvelope('status', statusTool, liveStatus)

      const inspectTool = tools.get('desktop_inspect')
      check('the inspect tool registers', inspectTool !== undefined)
      const inspected = await inspectTool.execute({ selectors: ['#target', '#absent'], fields: ['count', 'rect', 'text', 'attrs'], limit: 5 }, { signal: undefined })
      check('inspect describes a match without evaluating code',
        inspected.ok === true && inspected.value.selectors[0].matched === 1 && inspected.value.selectors[0].entries[0].tag === 'p',
        JSON.stringify(inspected.value).slice(0, 300))
      validateEnvelope('inspect', inspectTool, inspected)
      check('a selector that matches nothing answers matched:0, not an error',
        inspected.value.selectors[1].matched === 0 && inspected.value.selectors[1].error === undefined && inspected.value.coverage.invalid === 0,
        JSON.stringify(inspected.value.selectors[1]))
      const invalidInspect = await inspectTool.execute({ selectors: ['#'], fields: ['count'] }, { signal: undefined })
      check('an invalid selector is reported for that selector only',
        invalidInspect.ok === true && typeof invalidInspect.value.selectors[0].error === 'string' && invalidInspect.value.coverage.invalid === 1,
        JSON.stringify(invalidInspect.value).slice(0, 300))
      const waitedInspect = await inspectTool.execute({ selectors: ['#never-there'], waitMs: 600, fields: ['count'] }, { signal: undefined })
      check('inspect waits for a selector that never appears and reports the wait',
        waitedInspect.ok === true && waitedInspect.value.selectors[0].matched === 0 && waitedInspect.value.coverage.waitedMs > 0,
        JSON.stringify(waitedInspect.value.coverage))

      const waitTool = tools.get('desktop_wait')
      check('the wait tool registers', waitTool !== undefined)
      const notReady = await waitTool.execute({ commandId: '00000000-0000-4000-8000-000000000000', waitMs: 200 }, { signal: undefined })
      check('desktop_wait reports NotReady instead of inventing a result',
        notReady.ok === false && notReady.waiting === true && notReady.error.name === 'NotReady',
        JSON.stringify(notReady))
      validateEnvelope('wait not ready', waitTool, notReady)

      await exec("(() => { const d = document.createElement('div'); d.id = 'huge'; d.innerHTML = '<span>x</span>'.repeat(200); document.body.appendChild(d); return 'added' })()")
      const cramped = await inspectTool.execute({ selectors: ['#huge'], fields: ['html'], limit: 1, budget: 1024 }, { signal: undefined })
      check('inspect trims to its budget and reports the answer as incomplete',
        cramped.ok === true && cramped.value.coverage.complete === false && cramped.value.coverage.omitted > 0,
        JSON.stringify(cramped.value.coverage))
      validateEnvelope('inspect budget', inspectTool, cramped)
      await exec("document.getElementById('huge').remove()")
      const blocker = call('/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: "(() => { const end = Date.now() + 1400; while (Date.now() < end) {} ; window.__lateRan = (window.__lateRan || 0) + 1; return 'late-done' })()", timeoutMs: 400 }),
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      const queued = await call('/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'window.__queuedRan = true; "queued"', timeoutMs: 300 }),
      })
      check('a command queued behind a busy page times out without a null ms',
        queued.status === 504 && queued.body.timedOut === true && !('ms' in queued.body),
        JSON.stringify(queued.body))
      const blocked = await blocker
      check('the blocking expression itself times out',
        blocked.status === 504 && blocked.body.timedOut === true && typeof blocked.body.id === 'string',
        JSON.stringify(blocked.body))
      const timeoutText = definition.output.render({}, blocked.body)[0].text
      check('a timeout render names desktop_wait and the command id',
        timeoutText.includes('desktop_wait') && timeoutText.includes(blocked.body.id),
        timeoutText.slice(0, 240))
      const waited = await waitTool.execute({ commandId: blocked.body.id, waitMs: 5000 }, { signal: undefined })
      check('desktop_wait retrieves the late result of a timed-out command',
        waited.ok === true && waited.value === 'late-done' && waited.late === true,
        JSON.stringify(waited))
      validateEnvelope('late result', waitTool, waited)
      validateEnvelope('timeout', definition, blocked.body)
      validateEnvelope('queued timeout', definition, queued.body)
      const ranLate = await exec('window.__lateRan')
      check('the timed-out expression ran exactly once',
        ranLate.body.value === 1,
        JSON.stringify(ranLate.body.value))
      const ranQueued = await exec('window.__queuedRan === true')
      check('a queued command that timed out is never run after the page recovers',
        ranQueued.body.value === false,
        JSON.stringify(ranQueued.body.value))

      console.log('\ncommand line')
      const cli = (args, discover) => new Promise((resolve) => {
        const target = discover === true ? [] : ['--port', String(port)]
        const proc = spawn(process.execPath, [join(ROOT, 'bin', 'bridge.cjs'), ...args, ...target], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        proc.stdout.on('data', (chunk) => { out += chunk })
        proc.stderr.on('data', (chunk) => { err += chunk })
        proc.on('close', (code) => resolve({ code, out, err }))
      })

      const cliValue = await cli(['1 + 1'])
      check('the command line prints a value', cliValue.code === 0 && cliValue.out.trim() === '2', JSON.stringify(cliValue))

      const cliError = await cli(["throw new Error('boom')"])
      check('the command line reports a failure with exit code 1', cliError.code === 1 && cliError.err.includes('boom'), JSON.stringify(cliError))

      const cliState = await cli(['--state'])
      check('the command line reports the bridge state', cliState.code === 0 && cliState.out.includes('lastPollMsAgo'), JSON.stringify(cliState))

      const discovered = await cli(['1 + 2'], true)
      check('without --port the command line finds the recorded endpoint', discovered.code === 0 && discovered.out.trim() === '3', JSON.stringify(discovered))

      console.log('\nrecorder')
      const recorder = tools.get('desktop_record')
      check('the recorder tool registers', recorder !== undefined)
      const badAction = await recorder.execute({ action: 'watch' }, { signal: undefined }).then(() => null, (error) => String(error?.message))
      check('the recorder refuses an action it does not carry', badAction !== null && badAction.includes('must be one of'), String(badAction))
      const owner = { name: 'owner' }
      const stranger = { name: 'stranger' }
      const started = await recorder.execute({ action: 'start', channels: ['dom', 'console', 'network'], selector: '#target' }, { agent: { session: owner }, signal: undefined })
      check('a recording starts', started.ok === true && started.value.running === true && started.value.channels.length === 3, JSON.stringify(started.value))
      validateEnvelope('record start', recorder, started)
      const busy = await recorder.execute({ action: 'start' }, { agent: { session: owner }, signal: undefined })
      check('a second recording is refused while one runs', busy.ok === false && busy.error.name === 'Busy', JSON.stringify(busy.error))

      await exec("(() => { document.querySelector('#target').setAttribute('data-probe', 'x'); console.info('during'); return fetch('/state').then(function () { return 1 }) })()")

      const read = await recorder.execute({ action: 'read', afterSeq: 0, limit: 1000 }, { agent: { session: owner }, signal: undefined })
      const entries = read.value.entries
      check('the recording holds a DOM attribute change',
        entries.some((entry) => entry.ch === 'dom' && entry.kind === 'attribute' && entry.attribute === 'data-probe' && entry.to === 'x'),
        JSON.stringify(entries.filter((entry) => entry.ch === 'dom')))
      check('the recording holds console output the page produced',
        entries.some((entry) => entry.ch === 'console' && entry.text === 'during'),
        JSON.stringify(entries.filter((entry) => entry.ch === 'console')))
      check('the recording holds both ends of the fetch it caused',
        entries.some((entry) => entry.ch === 'network' && entry.kind === 'fetch' && entry.phase === 'start' && entry.url.includes('/state'))
        && entries.some((entry) => entry.ch === 'network' && entry.kind === 'fetch' && entry.phase === 'end' && entry.status === 200),
        JSON.stringify(entries.filter((entry) => entry.ch === 'network')))
      check('every entry carries a sequence number and a time',
        entries.length > 0 && entries.every((entry) => typeof entry.seq === 'number' && typeof entry.t === 'number'),
        JSON.stringify(entries.slice(0, 3)))

      const lastSeq = entries[entries.length - 1].seq
      const continued = await recorder.execute({ action: 'read', afterSeq: lastSeq }, { agent: { session: owner }, signal: undefined })
      check('a read continues above the sequence number it was given',
        continued.value.entries.every((entry) => entry.seq > lastSeq) && continued.value.nextSeq >= lastSeq,
        JSON.stringify(continued.value))

      const partial = await recorder.execute({ action: 'read', afterSeq: 0, limit: 2 }, { agent: { session: owner }, signal: undefined })
      const partialText = recorder.output.render({ action: 'read' }, partial)[0].text
      check('a bounded read says what it holds and how to continue',
        partial.value.complete === false && partialText.includes('record: 2 entries') && partialText.includes('more entries are waiting; read again with afterSeq='),
        JSON.stringify(partialText.slice(0, 240)))

      await exec("document.querySelector('#target').removeAttribute('data-probe')")
      const afterRemoval = await recorder.execute({ action: 'read', afterSeq: 0, limit: 1000 }, { agent: { session: owner }, signal: undefined })
      const removal = afterRemoval.value.entries.filter((entry) => entry.ch === 'dom' && entry.attribute === 'data-probe').pop()
      check('an attribute that was removed reads as absent, not as empty',
        removal !== undefined && removal.from === 'x' && removal.to === null,
        JSON.stringify(removal))
      const strangerRead = await recorder.execute({ action: 'read' }, { agent: { session: stranger }, signal: undefined })
      check('another session cannot read the recording',
        strangerRead.ok === false && strangerRead.error.message.includes('started by another session'),
        JSON.stringify(strangerRead.error))
      const strangerStop = await recorder.execute({ action: 'stop' }, { agent: { session: stranger }, signal: undefined })
      check('another session cannot stop the recording', strangerStop.ok === false, JSON.stringify(strangerStop.error))

      const stopped = await recorder.execute({ action: 'stop' }, { agent: { session: owner }, signal: undefined })
      check('the owner stops the recording', stopped.ok === true && stopped.value.running === false && stopped.value.entryCount > 0, JSON.stringify(stopped.value))
      const afterStop = await recorder.execute({ action: 'read', afterSeq: 0, limit: 5 }, { agent: { session: owner }, signal: undefined })
      check('the entries stay readable after the stop', afterStop.value.running === false && afterStop.value.entries.length === 5, JSON.stringify([afterStop.value.running, afterStop.value.entries.length]))
      const stillRefused = await recorder.execute({ action: 'read' }, { agent: { session: stranger }, signal: undefined })
      check('a stopped recording still belongs to the session that started it', stillRefused.ok === false, JSON.stringify(stillRefused.error))

      const fallback = await recorder.execute({ action: 'start', channels: ['console'], selector: '#never-there-either' }, { agent: { session: owner }, signal: undefined })
      check('a missing record selector degrades to the document and says so',
        fallback.ok === true && fallback.value.selectorMatched === false && fallback.value.selectorRequested === '#never-there-either' && fallback.value.selector === undefined,
        JSON.stringify(fallback.value))
      check('a recording carries a run id and a coverage block',
        typeof fallback.value.runId === 'string' && Array.isArray(fallback.value.channels) && fallback.value.channels.includes('console'),
        JSON.stringify(fallback.value))
      const fallbackRead = await recorder.execute({ action: 'read', afterSeq: 0, limit: 1 }, { agent: { session: owner }, signal: undefined })
      check('a read names the run and its coverage',
        fallbackRead.value.runId === fallback.value.runId && fallbackRead.value.coverage !== undefined && fallbackRead.value.coverage.selectorMatched === false,
        JSON.stringify(fallbackRead.value.coverage))
      validateEnvelope('record fallback start', recorder, fallback)
      validateEnvelope('record read', recorder, fallbackRead)
      const exported = await recorder.execute({ action: 'export' }, { agent: { session: owner }, signal: undefined })
      check("a recording exports to a file without resending the caller's action",
        exported.ok === true && typeof exported.value.path === 'string' && exported.value.entries >= 0 && existsSync(exported.value.path),
        JSON.stringify(exported.value))
      validateEnvelope('record export', recorder, exported)
      const strangerExport = await recorder.execute({ action: 'export' }, { agent: { session: stranger }, signal: undefined })
      check('another session cannot export the recording', strangerExport.ok === false, JSON.stringify(strangerExport.error))
      await recorder.execute({ action: 'stop' }, { agent: { session: owner }, signal: undefined })

      const cliRecord = await cli(['--record', '1500'])
      const recorded = cliRecord.code === 0 ? JSON.parse(cliRecord.out) : null
      check('the command line records and prints entries',
        recorded !== null && Array.isArray(recorded.entries) && recorded.entries.length > 0 && typeof recorded.startedAt === 'number',
        cliRecord.out.slice(0, 200) + cliRecord.err.slice(0, 200))
      const cliStopped = await cli(['--record-stop'])
      check('the command line stops a recording that is not running', cliStopped.code === 0 && JSON.parse(cliStopped.out).running === false, cliStopped.out.slice(0, 200))
      const cliExported = await cli(['--record-export'])
      const cliExportValue = cliExported.code === 0 ? JSON.parse(cliExported.out) : null
      check('the command line exports the recording to a file',
        cliExportValue !== null && typeof cliExportValue.path === 'string' && cliExportValue.path.includes('recordings') && existsSync(cliExportValue.path),
        cliExported.out.slice(0, 200) + cliExported.err.slice(0, 200))

      console.log('\nreload and boot scripts')
      const reloaded = await cli(['--reload'])
      check('--reload waits for a fresh page', reloaded.code === 0 && reloaded.out.trim() === 'reloaded', JSON.stringify(reloaded))

      const bootFile = join(ROOT, '.debug', 'boot-marker.js')
      writeFileSync(bootFile, 'globalThis.__bootRan = { loaderBefore: globalThis.__ModuleLoader__ !== undefined }')
      const booted = await cli(['--boot', bootFile])
      check('--boot reports that the armed script ran', booted.code === 0 && JSON.parse(booted.out).error === null, JSON.stringify(booted))
      const ranFirst = await exec('globalThis.__bootRan')
      check('the boot script ran before the page\'s own scripts', ranFirst.body.value !== null && ranFirst.body.value.loaderBefore === false, JSON.stringify(ranFirst.body.value))
      const once = await cli(['--reload'])
      const afterOnce = await exec('globalThis.__bootRan === undefined')
      check('a script whose page reported back does not run again', once.code === 0 && afterOnce.body.value === true, JSON.stringify(afterOnce.body))

      // The desktop boots a page in the app going down and another in the app
      // coming back; an armed script has to reach both.
      const armed = await cli(['--boot', bootFile, '--no-reload'])
      await cli(['--reload'])
      const firstBoot = await exec('globalThis.__bootRan !== undefined')
      await cli(['--reload'])
      const secondBoot = await exec('globalThis.__bootRan !== undefined')
      check('an armed script runs on every boot inside its expiry', armed.code === 0 && firstBoot.body.value === true && secondBoot.body.value === true, JSON.stringify([firstBoot.body, secondBoot.body]))
      await exec("localStorage.removeItem('dsh-desktop-bridge:boot')")

      const expired = await cli(['--boot', bootFile, '--no-reload', '--boot-ttl', '1000'])
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await cli(['--reload'])
      const afterExpiry = await exec('globalThis.__bootRan === undefined')
      check('an armed script past its expiry does not run', expired.code === 0 && afterExpiry.body.value === true, JSON.stringify(afterExpiry.body))

      console.log('\nframe attribution probe')
      const probed = await cli(['--boot', join(ROOT, 'probes', 'frame-attribution.js')])
      check('the frame probe installs at boot', probed.code === 0 && JSON.parse(probed.out).error === null, JSON.stringify(probed))
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const report = await exec(readFileSync(join(ROOT, 'probes', 'frame-report.js'), 'utf8'))
      const value = report.body.value ?? {}
      const subject = (value.byModule ?? []).find((row) => row[0] === 'probe-subject')
      check('the probe maps each module through its load call', value.modulesMapped >= 2, JSON.stringify(value.modulesMapped))
      check('the probe attributes an interval to the module that set it', subject !== undefined && subject[1] > 10, JSON.stringify(value.byModule))
      check('the probe keeps frame intervals', value.frames !== undefined && value.frames.n > 10, JSON.stringify(value.frames))
      const listener = await exec("(() => { let n = 0; const f = () => { n++ }; document.body.addEventListener('click', f); document.body.click(); document.body.removeEventListener('click', f); document.body.click(); return n })()")
      check('a wrapped listener still comes off with removeEventListener', listener.body.value === 1, JSON.stringify(listener.body))
    }
  } finally {
    if (child !== null) child.kill()
    for (const dispose of disposers) {
      try { dispose() } catch { /* the route may already be gone */ }
    }
    await new Promise((resolve) => server.close(resolve))
  }

  console.log('\n' + String(passed) + ' ok, ' + String(failed) + ' failed')
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
