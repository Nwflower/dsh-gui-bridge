/**
 * Report for probes/frame-attribution.js, for `dsh-desktop-bridge --stdin < probes/frame-report.js`.
 *
 * Covers the stretch since the probe was installed or last `mark()`ed: frame
 * intervals, the long frames split into the work before rendering, the frame
 * callbacks and style and layout, and the wrapped callbacks' time per module
 * and per registration site. `wrapped` covers every frame of the stretch and
 * `longFrames` only the long ones, so the two are read side by side: long-frame
 * time far above `wrapped` is the host's own scheduling, the stream socket and
 * callbacks registered before the probe.
 */
(() => {
  const probe = globalThis.__bridgeFrames
  if (probe === undefined) return { error: 'the frame attribution probe is not installed' }

  const sitesByUrl = new Map()
  for (const [id, site] of probe.modules) {
    let list = sitesByUrl.get(site.url)
    if (list === undefined) {
      list = []
      sitesByUrl.set(site.url, list)
    }
    list.push({ id, line: site.line, column: site.column })
  }
  for (const list of sitesByUrl.values()) list.sort((a, b) => a.line - b.line || a.column - b.column)

  /** A short name for a script that is not a combined bundle, or that no module claims. */
  function shortUrl(url) {
    const combo = url.split('??')[1]
    const path = (combo === undefined ? url.replace(/^[a-z-]+:\/\/[^/]+/, '') : combo).split('&')[0].split('?')[0]
    return path.includes(',') ? 'combined bundle' : path
  }
  function moduleOf(site) {
    if (site === null) return '(no site)'
    const list = sitesByUrl.get(site.url)
    if (list !== undefined) {
      let owner = null
      for (const entry of list) {
        if (entry.line < site.line || (entry.line === site.line && entry.column <= site.column)) owner = entry
        else break
      }
      if (owner !== null) return owner.id
    }
    return shortUrl(site.url)
  }

  const round = (value) => Math.round(value * 10) / 10
  const frames = probe.frames.slice().sort((a, b) => a - b)
  const at = (q) => round(frames[Math.min(frames.length - 1, Math.floor(frames.length * q))] ?? 0)

  let tasks = 0
  let callbacks = 0
  let styleLayout = 0
  let blocking = 0
  for (const e of probe.loaf) {
    const end = e.start + e.duration
    const render = e.renderStart > 0 ? e.renderStart : end
    const layout = e.styleAndLayoutStart > 0 ? e.styleAndLayoutStart : end
    tasks += render - e.start
    callbacks += layout - render
    styleLayout += end - layout
    blocking += e.blocking
  }

  const byModule = new Map()
  const sites = []
  let wrapped = 0
  for (const entry of probe.cost.values()) {
    const owner = moduleOf(entry.site)
    wrapped += entry.ms
    const total = byModule.get(owner) ?? { ms: 0, n: 0 }
    total.ms += entry.ms
    total.n += entry.n
    byModule.set(owner, total)
    const where = entry.site === null ? '' : shortUrl(entry.site.url) + ':' + entry.site.line + ':' + entry.site.column
    sites.push([entry.kind, owner, where, entry.n, round(entry.ms), round(entry.max)])
  }
  sites.sort((a, b) => b[4] - a[4])

  return {
    seconds: round((performance.now() - probe.since) / 1000),
    nodes: document.getElementsByTagName('*').length,
    modulesMapped: probe.modules.size,
    frames: { n: frames.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: round(frames[frames.length - 1] ?? 0), over50: frames.filter((f) => f > 50).length, over100: frames.filter((f) => f > 100).length },
    longFrames: { n: probe.loaf.length, ms: round(probe.loaf.reduce((sum, e) => sum + e.duration, 0)), blocking: round(blocking), tasks: round(tasks), callbacks: round(callbacks), styleLayout: round(styleLayout) },
    wrapped: round(wrapped),
    byModule: [...byModule].map(([owner, total]) => [owner, round(total.ms), total.n]).sort((a, b) => b[1] - a[1]).slice(0, 25),
    sites: sites.slice(0, 30),
  }
})()
