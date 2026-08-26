/**
 * The async context the ledger attributes through — Node's, where there is one.
 *
 * Split out behind a `#async-context` import so a browser build can substitute a version that does
 * not reach for `node:async_hooks`. See `async-context.browser.ts` for why that is safe there and
 * why this is necessary here.
 */
export { AsyncLocalStorage } from 'node:async_hooks'
