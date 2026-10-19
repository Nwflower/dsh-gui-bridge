// Build for both halves of the bridge.
//
//   lib/index.js      ESM, the host process imports it through `exports["."]`
//                     and calls `apply(ctx)`. `@deepseek-ai/*` is provided by
//                     the host, so it stays an import; everything else inlines.
//   lib/index.d.ts    the host half's type surface.
//   lib/client.js     CJS, wrapped in the loader factory the page's module
//                     loader expects (`window.__ModuleLoader__.load`).
//
// The browser half used to carry that wrapper by hand; it is generated here
// instead, so the source is an ordinary module and the wrapper cannot drift
// from what the loader expects.
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

/**
 * The plugin's runtime identity. Deliberately NOT `pkg.name`: the published
 * package is `dsh-gui-bridge` (the old name was taken on npm), while the
 * plugin id, the route prefix, the log prefix and the client module's loader
 * id all stay `dsh-desktop-bridge` so existing endpoints, boot scripts and
 * muscle memory keep working. See README.md, "命名".
 */
const PLUGIN_ID = 'dsh-desktop-bridge'

// A production dependency is on disk in a real install and stays an import;
// everything else inlines. Stated explicitly so moving a dependency between
// npm sections never silently re-bundles the host half.
const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])
const escapeSpecifier = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const productionPatterns = [...productionDeps].map((name) => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
const isProductionDependency = (specifier: string): boolean =>
  productionPatterns.some((pattern) => pattern.test(specifier))

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    // The host half's answer envelopes and the tool surface are what the CLI
    // and any other consumer compiles against; ship them next to the JS.
    dts: true,
    clean: true,
    deps: {
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  },
  {
    name: `${pkg.name}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // Stated explicitly: the default here follows the running Node, and this
    // bundle is only ever parsed by the GUI page.
    target: 'es2022',
    // dts would wrap the banner and footer into a .d.cts and break parsing.
    dts: false,
    clean: false,
    // The bundle reports its own version on every poll, so a page that is still
    // running an older bundle after an update shows up in desktop_status. The
    // number comes from package.json here rather than being typed into the
    // source, which is the drift this used to have.
    define: {
      __CLIENT_VERSION__: JSON.stringify(pkg.version),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    deps: {
      // The browser half imports nothing: the page provides everything it
      // touches (DOM, fetch, setTimeout). Anything it did import would have to
      // come from the loader's frozen module table, which it does not need.
      neverBundle: () => false,
      alwaysBundle: () => true,
    },
    outputOptions: {
      entryFileNames: 'client.js',
      // The closure-factory handoff every `dsh.client` package's ./client export
      // must use. `id` is the plugin id, not the package name (see PLUGIN_ID).
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
