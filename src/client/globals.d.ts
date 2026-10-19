/**
 * Build-time constants the bundler substitutes.
 *
 * `tsdown.config.ts` defines `__CLIENT_VERSION__` from package.json, so the
 * browser half reports the version it was actually built from instead of a
 * string someone has to remember to bump beside it.
 */
declare const __CLIENT_VERSION__: string
