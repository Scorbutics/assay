/**
 * The async context, in a browser: one variable.
 *
 * WHY THE NODE ONE CANNOT SHIP HERE. `node:async_hooks` is a Node builtin, imported at module top
 * level by the ledger, so any bundler without a polyfill for it fails outright rather than degrading
 * — a Vite build of a preview page died on exactly this: "AsyncLocalStorage is not exported by
 * __vite-browser-external". Next happens to polyfill it, which hides the coupling and ships the
 * polyfill to every visitor.
 *
 * WHY ONE VARIABLE IS ENOUGH, AND WHERE IT IS NOT. `AsyncLocalStorage` earns its cost on a server:
 * a patched `globalThis.fetch` is process-wide, several requests are in flight at once, and a plain
 * variable would interleave between them and mis-attribute silently. A browser page has one user and
 * one context, so that failure has no way to happen.
 *
 * The honest limit: this is NOT equivalent. Two overlapping `run()` calls in the same context — two
 * awaited operations in flight together — see each other's value, where the real thing would not.
 * That is a real difference and a browser can reach it; what makes the substitution safe is that
 * attribution scopes are opened by server code, so in a browser `getStore()` answers `undefined` and
 * the ledger falls back to its stack-derived label. If a caller ever opens a scope on the client,
 * this stops being a shim and becomes a bug — which is why it says so here rather than in a
 * changelog.
 */
export class AsyncLocalStorage<T> {
  #store: T | undefined

  run<R>(store: T, fn: () => R): R {
    const previous = this.#store
    this.#store = store
    try {
      return fn()
    } finally {
      // Restored rather than cleared: nesting is the case a bare reset gets wrong, and it costs a line.
      this.#store = previous
    }
  }

  getStore(): T | undefined {
    return this.#store
  }

  enterWith(store: T): void {
    this.#store = store
  }
}
