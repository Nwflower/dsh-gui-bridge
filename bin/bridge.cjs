#!/usr/bin/env node
/**
 * Command line for dsh-desktop-bridge.
 *
 * Submits one expression to the bridge's `exec` route and prints what the page
 * answered. Without `--port` it calls the newest live host half that recorded
 * its port under `$DSH_HOME/dsh-desktop-bridge/endpoints/` (the desktop binds a
 * fresh port on every start), and falls back to the harness web server's
 * default port.
 *
 * Usage:
 *   dsh-desktop-bridge "document.querySelectorAll('[class*=\"row\"]').length"
 *   dsh-desktop-bridge --stdin < snippet.js
 *   dsh-desktop-bridge --state
 *   dsh-desktop-bridge --boot probe.js     (run probe.js at the next boot, before any plugin)
 *   dsh-desktop-bridge --reload
 */
const { existsSync, readdirSync, readFileSync, rmSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const PREFIX = '/dsh-desktop-bridge'
/** The harness web server's default port, used when no host half recorded one. */
const DEFAULT_PORT = 19387
/** Storage key the boot loader reads; matches the host half. */
const BOOT_STORAGE_KEY = 'dsh-desktop-bridge:boot'
/** How long an armed boot script stays valid, in ms: an app restart takes a while. */
const DEFAULT_BOOT_TTL_MS = 120000
/** How long a reload is waited on before giving up, in ms. */
const RELOAD_WAIT_MS = 90000
/** Gap between two looks at a reloading page, in ms. */
const RELOAD_POLL_MS = 1000
/** How long a fresh page has to stay up before it counts as the one that stays, in ms. */
const RELOAD_SETTLE_MS = 3000
/** How far a page's own clock may drift from the caller's between two looks and still be the same page, in ms. */
const RELOAD_SAME_PAGE_SLACK_MS = 1500

function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    port: null,
    timeoutMs: 15000,
    stdin: false,
    raw: false,
    json: false,
    state: false,
    quiet: false,
    code: null,
    boot: null,
    bootTtlMs: DEFAULT_BOOT_TTL_MS,
    reload: true,
    reloadOnly: false,
    recordMs: null,
    recordRead: false,
    recordStop: false,
    recordExport: false,
    channels: null,
    selector: null,
  }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' || arg === '-p') options.port = Number(argv[++i])
    else if (arg === '--boot') options.boot = String(argv[++i])
    else if (arg === '--boot-ttl') options.bootTtlMs = Number(argv[++i])
    else if (arg === '--no-reload') options.reload = false
    else if (arg === '--reload') options.reloadOnly = true
    else if (arg === '--host') options.host = String(argv[++i])
    else if (arg === '--timeout' || arg === '-t') options.timeoutMs = Number(argv[++i])
    else if (arg === '--record') options.recordMs = Number(argv[++i])
    else if (arg === '--record-read') options.recordRead = true
    else if (arg === '--record-stop') options.recordStop = true
    else if (arg === '--record-export') options.recordExport = true
    else if (arg === '--channels') options.channels = String(argv[++i]).split(',').map((name) => name.trim()).filter((name) => name !== '')
    else if (arg === '--selector') options.selector = String(argv[++i])
    else if (arg === '--stdin') options.stdin = true
    else if (arg === '--raw') options.raw = true
    else if (arg === '--json') options.json = true
    else if (arg === '--state') options.state = true
    else if (arg === '--quiet' || arg === '-q') options.quiet = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else rest.push(arg)
  }
  if (rest.length > 0) options.code = rest.join(' ')
  return options
}

function usage() {
  process.stdout.write([
    'usage: dsh-desktop-bridge <expression> [options]',
    '       dsh-desktop-bridge --state',
    '       dsh-desktop-bridge --record <ms> [--channels dom,network,console] [--selector <css>]',
    '       dsh-desktop-bridge --record-read | --record-stop | --record-export',
    '       dsh-desktop-bridge --boot <file> [--no-reload] [--boot-ttl <ms>]',
    '       dsh-desktop-bridge --reload',
    '',
    'options:',
    '  --port <n>       harness web server port (default: the newest live host half',
    '                   recorded under $DSH_HOME/dsh-desktop-bridge/endpoints, else 19387)',
    '  --record <ms>    record DOM changes, network frames and console output for',
    '                   <ms> milliseconds, then print every entry it kept',
    '  --record-read    print what the running recording holds so far, without stopping it',
    '  --record-stop    stop the running recording and print its summary',
    '  --record-export  write the whole recording to a JSON file and print its path',
    '  --channels <l>   with --record: comma-separated dom,network,console (default all)',
    '  --selector <s>   with --record: watch only the subtree under this CSS selector',
    '  --boot <file>    arm <file> to run at the next page boot, ahead of every plugin',
    '                   bundle, then reload the page and report how the script ran',
    '  --no-reload      with --boot: arm only; every reload or app start before the',
    '                   expiry runs it',
    '  --boot-ttl <ms>  how long an armed script stays valid (default 120000)',
    '  --reload         reload the page and wait until it polls again',
    '  --host <host>    loopback host to call (default 127.0.0.1)',
    '  --timeout <ms>   deadline for the expression (default 15000)',
    '  --stdin          read the expression from standard input',
    '  --raw            print a string value without JSON quoting',
    '  --json           print the whole bridge response',
    '  --quiet          print the value only',
    '  --state          report whether a browser half is listening',
    '',
  ].join('\n'))
}

function baseUrl(options) {
  return 'http://' + options.host + ':' + String(options.port ?? discoverPort())
}

/** Whether a process id names a live process. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * The port of the newest live host half that recorded one, or the default.
 * Files a dead process left are removed on the way.
 */
function discoverPort() {
  const directory = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-desktop-bridge', 'endpoints')
  if (!existsSync(directory)) return DEFAULT_PORT
  let best = null
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue
    const file = join(directory, name)
    let entry
    try {
      entry = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (typeof entry.pid !== 'number' || typeof entry.port !== 'number') continue
    if (!alive(entry.pid)) {
      rmSync(file, { force: true })
      continue
    }
    if (best === null || entry.at > best.at) best = entry
  }
  return best === null ? DEFAULT_PORT : best.port
}

/** Submit one expression; the bridge's response, or null when nothing answered. */
async function exec(options, code, timeoutMs) {
  try {
    return await call(baseUrl(options) + PREFIX + '/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: String(code), timeoutMs }),
    })
  } catch {
    return null
  }
}

/** One recording action; the bridge's response, or null when nothing answered. */
async function recordCall(options, args) {
  try {
    return await call(baseUrl(options) + PREFIX + '/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ timeoutMs: options.timeoutMs }, args)),
    })
  } catch {
    return null
  }
}

/** Report one recording answer's failure; 0 when it may be read. */
function recordFailure(answer) {
  if (answer === null) {
    process.stderr.write('bridge: nothing answered the recording call\n')
    return 1
  }
  if (answer.status !== 200 || answer.body === null || answer.body.ok !== true) {
    const error = answer.body === null || answer.body === undefined ? null : answer.body.error
    process.stderr.write('bridge: ' + (error === null || error === undefined
      ? 'request failed with status ' + String(answer.status)
      : String(error.name ?? 'Error') + ': ' + String(error.message ?? '')) + '\n')
    return 1
  }
  return 0
}

/** Read every entry the recording holds, following the cursor the page reports. */
async function readAllEntries(options) {
  const collected = []
  let afterSeq = 0
  for (let page = 0; page < 100; page++) {
    const answer = await recordCall(options, { action: 'read', afterSeq, limit: 1000 })
    if (recordFailure(answer) !== 0) return null
    const value = answer.body.value
    if (Array.isArray(value.entries)) collected.push(...value.entries)
    if (value.complete === true || typeof value.nextSeq !== 'number' || value.nextSeq === afterSeq) {
      return { value, entries: collected }
    }
    afterSeq = value.nextSeq
  }
  return { value: { running: null, dropped: null, lost: null, startedAt: null, stoppedAt: null }, entries: collected }
}

/**
 * The recording face: `--record <ms>` starts one, waits, reads it and stops it;
 * `--record-read` and `--record-stop` act on the running one.
 */
async function record(options) {
  if (options.recordExport === true) {
    const exported = await recordCall(options, { action: 'export' })
    if (recordFailure(exported) !== 0) return 1
    process.stdout.write(JSON.stringify(exported.body.value, null, 2) + '\n')
    return 0
  }
  if (options.recordStop === true) {
    const stopped = await recordCall(options, { action: 'stop' })
    if (recordFailure(stopped) !== 0) return 1
    process.stdout.write(JSON.stringify(stopped.body.value, null, 2) + '\n')
    return 0
  }
  if (options.recordRead === true) {
    const read = await readAllEntries(options)
    if (read === null) return 1
    process.stdout.write(JSON.stringify({ running: read.value.running, dropped: read.value.dropped, lost: read.value.lost, entries: read.entries }, null, 2) + '\n')
    return 0
  }
  const started = await recordCall(options, {
    action: 'start',
    channels: options.channels,
    selector: options.selector,
    maxMs: options.recordMs,
  })
  if (recordFailure(started) !== 0) return 1
  await new Promise((resolve) => setTimeout(resolve, options.recordMs))
  const read = await readAllEntries(options)
  if (read === null) return 1
  const stopped = await recordCall(options, { action: 'stop' })
  const summary = stopped !== null && stopped.body !== null && stopped.body.value !== null ? stopped.body.value : {}
  process.stdout.write(JSON.stringify({
    startedAt: summary.startedAt ?? read.value.startedAt,
    stoppedAt: summary.stoppedAt ?? read.value.stoppedAt,
    dropped: summary.dropped ?? read.value.dropped,
    lost: read.value.lost,
    entries: read.entries,
  }, null, 2) + '\n')
  return 0
}

/**
 * Reload the page and wait until a page that started after the request polls
 * again. The desktop may bring the whole app back up on a reload, with a new
 * port, so the endpoint is looked up again on every try unless `--port` named one.
 * @returns the fresh page's `__DSH_BRIDGE_BOOT__` report (null when no boot
 *   script ran), or undefined when no fresh page answered in time.
 */
async function reloadAndWait(options, armCode) {
  const requestedAt = Date.now()
  const reload = '(() => { ' + armCode + ' setTimeout(() => location.reload(), 100); return true })()'
  const sent = await exec(options, reload, options.timeoutMs)
  if (sent === null || sent.status !== 200 || sent.body.ok !== true) {
    process.stderr.write('bridge: the page did not take the reload: ' + JSON.stringify(sent && sent.body) + '\n')
    return undefined
  }
  const probe = '({ boot: globalThis.__DSH_BRIDGE_BOOT__ ?? null, uptime: performance.now() })'
  // The first fresh page is not yet the answer: on the desktop a reload boots a
  // page in the app that is going down, then another once the app is back. A
  // page counts once it answers again RELOAD_SETTLE_MS later as the same page.
  let candidate = null
  while (Date.now() - requestedAt < RELOAD_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, RELOAD_POLL_MS))
    const answer = await exec(options, probe, 3000)
    if (answer === null || answer.status !== 200 || answer.body.ok !== true) {
      candidate = null
      continue
    }
    const now = Date.now()
    const { uptime, boot: report } = answer.body.value
    // A page that has been up longer than the wait is the one that took the
    // request and has not gone down yet.
    if (uptime > now - requestedAt) continue
    const samePage = candidate !== null && Math.abs((uptime - candidate.uptime) - (now - candidate.at)) < RELOAD_SAME_PAGE_SLACK_MS
    if (!samePage) {
      candidate = { uptime, at: now }
      continue
    }
    if (now - candidate.at >= RELOAD_SETTLE_MS) return report
  }
  return undefined
}

/** Arm one boot script, reload unless told not to, and report how it ran. */
async function boot(options) {
  if (!existsSync(options.boot)) {
    process.stderr.write('bridge: no such file ' + options.boot + '\n')
    return 2
  }
  const code = readFileSync(options.boot, 'utf8')
  const arm = 'localStorage.setItem(' + JSON.stringify(BOOT_STORAGE_KEY) + ', JSON.stringify({ code: ' +
    JSON.stringify(code) + ', until: Date.now() + ' + String(options.bootTtlMs) + ' }));'
  if (options.reload === false) {
    const armed = await exec(options, '(() => { ' + arm + ' return true })()', options.timeoutMs)
    if (armed === null || armed.status !== 200 || armed.body.ok !== true) {
      process.stderr.write('bridge: the page did not take the boot script: ' + JSON.stringify(armed && armed.body) + '\n')
      return 1
    }
    process.stdout.write('armed for ' + String(options.bootTtlMs) + ' ms; every reload or app start inside that time runs it\n')
    return 0
  }
  const report = await reloadAndWait(options, arm)
  if (report === undefined) {
    process.stderr.write('bridge: no fresh page answered within ' + String(RELOAD_WAIT_MS) + ' ms\n')
    return 1
  }
  if (report === null) {
    process.stderr.write('bridge: the page came back without running the boot script; a host half started before this version carries no boot loader — restart the app once\n')
    return 1
  }
  // The loader leaves the script in place so a page booted after an app
  // restart still runs it; the page that answered here is the one that stays.
  await exec(options, 'localStorage.removeItem(' + JSON.stringify(BOOT_STORAGE_KEY) + ')', options.timeoutMs)
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  return report.error === null ? 0 : 1
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function call(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    usage()
    return 0
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    process.stderr.write('bridge: --port must be an integer from 1 through 65535\n')
    return 2
  }
  if (!Number.isInteger(options.bootTtlMs) || options.bootTtlMs < 1000) {
    process.stderr.write('bridge: --boot-ttl must be an integer of at least 1000\n')
    return 2
  }

  if (options.boot !== null) return boot(options)
  if (options.recordMs !== null || options.recordRead === true || options.recordStop === true || options.recordExport === true) {
    if (options.recordMs !== null && (!Number.isInteger(options.recordMs) || options.recordMs < 1 || options.recordMs > 600000)) {
      process.stderr.write('bridge: --record must be an integer from 1 through 600000\n')
      return 2
    }
    return record(options)
  }
  if (options.reloadOnly === true) {
    const report = await reloadAndWait(options, '')
    if (report === undefined) {
      process.stderr.write('bridge: no fresh page answered within ' + String(RELOAD_WAIT_MS) + ' ms\n')
      return 1
    }
    process.stdout.write('reloaded\n')
    return 0
  }

  if (options.state === true) {
    const { status, body } = await call(baseUrl(options) + PREFIX + '/state', { method: 'GET' })
    process.stdout.write(JSON.stringify(body, null, 2) + '\n')
    return status === 200 ? 0 : 1
  }

  const code = options.stdin === true ? await readStdin() : options.code
  if (code === null || String(code).trim() === '') {
    usage()
    return 2
  }

  const { status, body } = await call(baseUrl(options) + PREFIX + '/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(code), timeoutMs: options.timeoutMs }),
  })

  if (status !== 200) {
    const error = body === null || body === undefined ? null : body.error
    process.stderr.write('bridge: ' + (error === null || error === undefined
      ? 'request failed with status ' + String(status)
      : String(error.name ?? 'Error') + ': ' + String(error.message ?? '')) + '\n')
    process.stderr.write(JSON.stringify(body, null, 2) + '\n')
    return 1
  }

  if (options.json === true) {
    process.stdout.write(JSON.stringify(body, null, 2) + '\n')
    return body.ok === false ? 1 : 0
  }

  if (body.ok === false) {
    const error = body.error ?? {}
    process.stderr.write('bridge: ' + String(error.name ?? 'Error') + ': ' + String(error.message ?? '') + '\n')
    if (typeof error.stack === 'string') process.stderr.write(error.stack + '\n')
    return 1
  }

  const value = body.value
  if (options.raw === true && typeof value === 'string') {
    process.stdout.write(value + '\n')
    return 0
  }
  if (options.quiet === true) {
    process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n')
    return 0
  }
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  return 0
}

main().then((code) => { process.exitCode = code }, (error) => {
  process.stderr.write('bridge: ' + String((error && error.message) || error) + '\n')
  process.exitCode = 1
})
