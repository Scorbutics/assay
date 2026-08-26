/**
 * THE SEAM — one source, consumed by every runtime as a PACKAGE.
 *
 *   - Supabase Edge Functions (Deno) — `npm:@scorbutics/assay-seam` via the import map.
 *   - Next.js / node / bun — an ordinary dependency.
 *
 * It briefly lived in the consuming application's backend repository, with the
 * web app reaching across a repo boundary to re-export it and the Edge runtime
 * loading a generated copy. Both were workarounds for a constraint that did not
 * exist: `npm:` specifiers resolve in the Edge runtime, so a published package
 * serves both directly and neither copy nor codegen is needed.
 *
 * The only host requirement is `node:async_hooks`, which Deno supports.
 */
/**
 * The DB seam: makes an operation's effects on the database OBSERVABLE without
 * editing the operation.
 *
 * ## What this is for
 *
 * A backend operation — one edge function, one route handler — is the backend's
 * unit of structure, the way an island is the unit on the UI side. But unlike an
 * island it has no observable output: an island renders and you can look at it,
 * whereas an operation's real output is what it did to the database, which is
 * invisible from both the response body and the source.
 *
 * This wrapper makes that output legible. Every `from(...)` / `rpc(...)` that
 * passes through a wrapped client is recorded as a LEDGER ENTRY — table, verb,
 * how the rows were constrained, how many came back. The set of entries for one
 * request is that operation's effect on the world.
 *
 * The point is not to assert anything yet. It is that an agent (or a person)
 * changing `complete-mission` can read what `complete-mission` actually touches,
 * instead of tracing it through the service layer and hoping. Two things fall out
 * of a corpus of ledgers that nothing in this repo can currently answer:
 *
 *  - the READ SET and WRITE SET of each operation — its real blast radius;
 *  - which operations COUPLE, because one writes a table another reads. That
 *    coupling is invisible in a git diff and is the reason a "safe" three-line
 *    change to a shared service is not safe.
 *
 * ## Why it costs no edits
 *
 * `withAutoPagination` already proxies `from`/`rpc` for the row-cap net, and
 * every server-side client in the codebase is built in one of three places
 * (`_shared/auth/middleware.ts`, `lib/supabase/server.ts`, `lib/supabase/admin.ts`).
 * Wrapping there covers all 22 edge functions and the Next server paths without
 * touching a single handler.
 *
 * Compose it OUTSIDE auto-pagination, so the row count recorded is the aggregated
 * one the caller actually received rather than page 1:
 *
 * ```ts
 * withLedger(withAutoPagination(createClient(url, key)), { operation, serviceRole: true })
 * ```
 *
 * ## What it does NOT see
 *
 * Named here rather than left implicit, because a partial ledger that reads as a
 * complete one is worse than no ledger:
 *
 *  - **Anything not going through a wrapped client** — `pg` connections in the
 *    integration harness, psql, the SQL editor, migrations.
 *  - **Triggers, cascades and RLS-side effects.** A recorded `insert` on
 *    `weekly_tasks` may fire a trigger that writes three other tables; this seam
 *    sees the statement the client issued, not what Postgres did with it. Writes
 *    are therefore a LOWER BOUND on the true write set.
 *  - **Which rows changed.** Statement-level, not row-level: `table + verb` is
 *    enough for a read/write set and a coupling graph, and not enough for a
 *    before/after diff. Row-level needs logical decoding, deliberately deferred.
 *  - **`auth.*` calls** (`serviceClient.auth.getUser`) — not PostgREST queries.
 *  - **Operation attribution outside the edge functions.** The label is bound to
 *    the client instance, and edge functions get it free from the request path.
 *    Next.js callers must pass one explicitly; anything else is recorded as
 *    `unattributed`, and the report counts those out loud.
 */

// Through the package's OWN name, not a relative path: the './async-context' export carries a
// `browser` condition, and a condition is resolved from the SPECIFIER — which survives this package
// being reached through a symlink, where a path-based `browser` field mapping does not.
import { AsyncLocalStorage } from '@scorbutics/assay-seam/async-context'

/**
 * The seam is OPT-IN: it records only when `ASSAY_LEDGER` is on.
 *
 * Default-off rather than "off in production", because there is no reliable way
 * to detect production from inside an Edge Function — and a detector that gets
 * it wrong fails in the expensive direction. Local runs, CI and the sealed suite
 * set it explicitly; a deploy that forgets to is silent, which is the correct
 * way round.
 *
 * When off, `withLedger` returns the client untouched: no proxy, no overhead,
 * nothing written.
 */
export function ledgerEnabled(): boolean {
    const g = globalThis as {
        Deno?: { env: { get(k: string): string | undefined } }
        process?: { env?: Record<string, string | undefined> }
    }
    const value = g.Deno?.env?.get?.('ASSAY_LEDGER') ?? g.process?.env?.ASSAY_LEDGER
    return value === 'on' || value === '1' || value === 'true'
}

/**
 * Strip values out of a database error before it is recorded.
 *
 * Postgres embeds row data in error text — a unique violation reads
 * `Key (email)=(someone@example.com) already exists.` — so recording `e.message`
 * verbatim writes personal data into whatever reads the ledger. Every other
 * field this seam emits is a NAME (table, column, path template); the error was
 * the one place values could get through.
 *
 * Best-effort by nature: the text comes from a third party and cannot be
 * allowlisted. Truncation is therefore part of the redaction, not a cosmetic.
 */
export function redactError(message: string): string {
    return message
        .split('\n')[0]                                   // DETAIL/HINT lines carry the values
        .replace(/=\s*\([^)]*\)/g, '=(?)')                 // Key (email)=(a@b.com)
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '{email}')
        .replace(/\b\d{6,}\b/g, '{n}')                    // long digit runs: ids, phone numbers
        .slice(0, 200)
}

/**
 * Capture mode for outbound calls: `off` (default) or `shape`.
 *
 * Shapes are emitted as tagged LOG LINES rather than written to disk, because
 * the seam runs inside the Edge runtime container and has no access to the
 * project. That is the same route the ledger already takes, and it means the
 * only thing crossing the boundary is field paths and types — never a value.
 *
 * There is deliberately no `fixture` mode here. Recording values is a
 * data-protection decision, and one that would have to survive a container log
 * pipeline; shapes answer "did the provider change their payload?" without it.
 */
function captureMode(): 'off' | 'shape' {
    const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } }
    return g.Deno?.env?.get?.('ASSAY_CAPTURE') === 'shape' ? 'shape' : 'off'
}

/** The tag a captured shape line carries, so logs can be scraped back out. */
export const SHAPE_TAG = '@assay-shape'

/**
 * Intercept policy per node, injected as JSON in ASSAY_NODES.
 *
 * The registry lives in `.assay/nodes.json` on the host, which the Edge runtime
 * container cannot read — so the host serialises the parts the seam needs into
 * an env var. Only nodes with an intercept policy are included; a registry of
 * declarations the seam never acts on has no business crossing the boundary.
 */
interface InterceptNode {
    id: string
    /** `METHOD host/normalised-path`, matched exactly against the call target. */
    target: string
    intercept: 'store' | 'replay'
    /**
     * replay: the body handed back instead of calling out. String values may
     * reference the request — see template.ts.
     */
    body?: unknown
    /**
     * When set, the node is active ONLY inside `withInterceptScope(tag, ...)`.
     *
     * This is what makes intercept usable in production. An unscoped node
     * substitutes every matching call in the process, which is correct for a
     * CI runtime and catastrophic for a live one; a scoped node substitutes
     * only the requests the application has deliberately marked — an admin
     * replaying a payment against fixtures, say — and leaves real traffic alone.
     */
    scope?: string
    status?: number
    /** store: where the request payload is persisted, in the APP's own table. */
    sink?: { table: string; column: string; extra?: Record<string, string> }
}

/**
 * The intercept scope of the work currently running, if any.
 *
 * Separate from CURRENT (the operation name) because they answer different
 * questions: CURRENT says which operation a statement belongs to, this says
 * whether this particular run is allowed to have its third-party calls
 * substituted. A production request has an operation and no scope.
 */
interface InterceptScope { tag: string; vars?: Record<string, string> }
const SCOPE = new AsyncLocalStorage<InterceptScope>()

/**
 * Run `fn` with an intercept scope active. Nodes declaring that scope
 * substitute their calls for the duration; every other node is unaffected.
 */
export function withInterceptScope<T>(
    tag: string,
    varsOrFn: Record<string, string> | (() => T),
    maybeFn?: () => T,
): T {
    const fn = (typeof varsOrFn === 'function' ? varsOrFn : maybeFn)!
    const vars = typeof varsOrFn === 'function' ? undefined : varsOrFn
    return SCOPE.run({ tag, vars }, fn)
}

/** The scope in force, for callers that need to report it. */
export function currentInterceptScope(): string | undefined {
    return SCOPE.getStore()?.tag
}

let interceptCache: InterceptNode[] | null = null

function interceptNodes(): InterceptNode[] {
    if (interceptCache) return interceptCache
    const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } }
    const raw = g.Deno?.env?.get?.('ASSAY_NODES')
    try { interceptCache = raw ? (JSON.parse(raw) as InterceptNode[]) : [] }
    catch { interceptCache = [] }
    return interceptCache
}

/**
 * Field paths and their types. No values, at any depth.
 *
 * Deliberately duplicated from assay/src/lib/shape.ts rather than imported: the
 * seam is the stack-specific half and cannot reach the package. The two must
 * agree on output; lib/tests/unit/shape-agreement.test.ts asserts it, and is the
 * only thing standing between a divergence and a silently different corpus.
 *
 * Exported ONLY so that test can reach it.
 */
/**
 * Shape derivation is the PACKAGE's — see ../lib/shape.ts. It used to be
 * reimplemented here, because this module lived in the backend repository and
 * could not import assay. That is no longer true: this file IS assay, and the
 * copy the Edge runtime loads is generated from it (`assay sync-seam`).
 *
 * The duplicate cost a test whose only job was to notice the two drifting.
 */
import { deriveShape as shapeOf } from './shape.ts'
import { factsOf, resolveBody } from './template.ts'
export { captureParams, factsOf, resolveBody, resolveToken } from './template.ts'
export type { RequestFacts, Resolved } from './template.ts'
export { shapeOf }

function emitShape(target: string, request: unknown, response: unknown, status: number | undefined): void {
    console.log(`${SHAPE_TAG} ${JSON.stringify({
        target,
        status: status ?? null,
        request: request === undefined ? [] : shapeOf(request),
        response: response === undefined ? [] : shapeOf(response),
    })}`)
}

/** Where an entry came from, and what it did. */
export interface LedgerEntry {
    /** Operation the client was built for, e.g. `complete-mission`. */
    operation: string
    /** Table, or the function name for an `rpc`. */
    target: string
    verb: 'read' | 'insert' | 'update' | 'upsert' | 'delete' | 'rpc' | 'count' | 'call'
    /** Columns the statement was constrained on (`eq`, `in`, …). Empty = unfiltered. */
    filters: string[]
    /**
     * Tables pulled in by an EMBEDDED select — `select('*, member_social_medias(*)')`.
     * PostgREST resolves these inside a single request to the parent table, so the
     * statement's `target` is the parent and the embedded tables are invisible
     * without this. They are always reads.
     */
    embeds: string[]
    /** Rows returned. `null` when the statement returned no body. */
    rows: number | null
    /** True when this client bypasses RLS (service role). */
    serviceRole: boolean
    /** PostgREST error message, when the statement failed. */
    error?: string
    /** HTTP status, for an outbound `call`. */
    status?: number
    /**
     * Set when the call was NOT made: `store` or `replay`.
     *
     * A separate field, not a suffix on `target`. Appending "[replayed]" made a
     * replayed corpus declare a DIFFERENT endpoint from the same call made live,
     * so the two could never be compared — and a declaration built under replay
     * would fail the moment it ran for real.
     */
    intercepted?: 'store' | 'replay'
    /** Set when the node that answered was scoped — see withInterceptScope. */
    interceptScope?: string
    /**
     * Fixture tokens the request could not satisfy. Present means the replayed
     * body has holes: the call was answered, but not with what was declared.
     */
    unresolvedTokens?: string[]
    /** Monotonic index within the process, so a ledger keeps its order. */
    seq: number
}

export interface LedgerOptions {
    /** The operation this client belongs to. One client per request. */
    operation?: string
    /** Whether this client bypasses RLS. */
    serviceRole?: boolean
    /**
     * Force the seam on or off, instead of probing the environment.
     *
     * `ledgerEnabled()` reads Deno.env / process.env, and neither exists in a
     * BROWSER: a bundler inlines only the variables it is told to expose, so the
     * probe can never see the host's flag and the seam would be permanently off
     * there. Rather than teach this package one bundler's naming convention, the
     * host passes the answer.
     */
    enabled?: boolean
    /**
     * Patch `globalThis.fetch` to record outbound calls. Default true.
     *
     * Worth turning off in a browser. There the seam's premise — that a fetch is
     * a call to a third party worth recording — does not hold: it would wrap
     * every request the page makes, including the framework's own navigation and
     * data fetches, and bury the statements you came to read.
     */
    outbound?: boolean
}

/** Every entry passes through here. Replace it to collect in-process. */
export type LedgerSink = (entry: LedgerEntry) => void

/** The tag a default-sink line carries, so logs can be scraped back out. */
export const LEDGER_TAG = '@ledger'

let sink: LedgerSink = (entry) => {
    // One line, one JSON object: greppable out of `supabase functions logs`,
    // vitest output, or a piped dev server, with no file access required.
    console.log(`${LEDGER_TAG} ${JSON.stringify(entry)}`)
}

let seq = 0

/** Redirect the ledger. Returns the previous sink, so callers can restore it. */
export function setLedgerSink(next: LedgerSink): LedgerSink {
    const previous = sink
    sink = next
    return previous
}

/** Collect every entry emitted while `fn` runs. For tests and one-off probes. */
export async function collectLedger<T>(fn: () => Promise<T> | T): Promise<{ result: T; entries: LedgerEntry[] }> {
    const entries: LedgerEntry[] = []
    const previous = setLedgerSink((e) => entries.push(e))
    try {
        return { result: await fn(), entries }
    } finally {
        setLedgerSink(previous)
    }
}

// ---------------------------------------------------------------------------
// Outbound HTTP seam
// ---------------------------------------------------------------------------

/**
 * The operation owning the current async context.
 *
 * The DB seam gets attribution free: its client is built per request, so binding
 * the operation to the instance is enough. A patched `globalThis.fetch` is
 * process-wide and has no such handle, so the operation has to travel with the
 * async context. A module-level variable would interleave between concurrent
 * requests and mis-attribute silently — the failure mode this whole tool exists
 * to avoid.
 */
const CURRENT = new AsyncLocalStorage<string>()

/** Run `fn` with every outbound call inside it attributed to `operation`. */
export function runAsOperation<T>(operation: string, fn: () => T): T {
    return CURRENT.run(operation, fn)
}

/**
 * Path with volatile segments replaced by `{id}`.
 *
 * `/v1/customers/cus_123` must not become its own operation target. Raw paths
 * would grow a declaration one entry per customer — the same explosion raw URIs
 * caused in the JDBC seam before route templates were used there.
 */
export function normalizePath(pathname: string): string {
    return pathname
        .split('/')
        .map(seg => {
            if (!seg) return seg
            // CONTAINS a uuid, not just IS one. Prefixed ids are everywhere —
            // `test-contact-<uuid>` leaked straight through an anchored rule and
            // produced one declaration entry per contact.
            if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(seg)) return '{id}'
            if (/^\d+$/.test(seg)) return '{id}'
            // cus_… sub_… evt_… — a short lowercase prefix and an opaque token.
            //
            // The tail must carry a DIGIT OR AN UPPERCASE LETTER. Without that
            // clause the rule also matched ordinary snake_case path segments:
            // Qonto's `/v2/client_invoices` normalised to `/v2/{id}`, so the
            // declared node for it could never match, the replay never fired,
            // and the call left the process and came back 401 — while the
            // ledger showed a target no one had written down. A provider id is
            // an encoded token and effectively always carries one or the other;
            // an English path word carries neither.
            if (/^[a-z]{2,6}_(?=[A-Za-z0-9]*[0-9A-Z])[A-Za-z0-9]{6,}$/.test(seg)) return '{id}'
            if (/^[0-9a-f]{16,}$/i.test(seg)) return '{id}'
            if (seg.includes('@')) return '{email}'
            // Opaque high-entropy segment: long, mixed-case AND containing a digit.
            //
            // All three conditions are needed. Dropping the digit requirement
            // collapses legitimate camelCase path segments — `listSubscriptions`
            // and `paymentIntents` both become `{id}`, so two different endpoints
            // read as the same target and the field stops carrying any signal.
            // Encoded blobs (base64, provider tokens) almost always contain digits;
            // English-ish path words almost never do.
            //
            // This is a heuristic and will stay one. The sound fix is a per-host
            // template map — declare the paths you expect and treat the rest as
            // unknown — rather than guessing at id shapes forever.
            if (seg.length >= 16 && /[A-Z]/.test(seg) && /[a-z]/.test(seg) && /\d/.test(seg)) return '{id}'
            return seg
        })
        .join('/')
}

let outboundInstalled = false
/** The unpatched fetch, so the sink cannot recurse through the patch. */
let originalFetch: typeof globalThis.fetch = globalThis.fetch

/**
 * Patch `globalThis.fetch` so every outbound call is recorded.
 *
 * Patched globally rather than wrapping each service client, for the same reason
 * the DB seam wraps the client rather than each call site: it covers services
 * nobody has written yet. Supabase's own host is skipped — those requests ARE the
 * DB seam, and recording them twice would double every read.
 */
/**
 * True when an intercept policy is loaded, regardless of the ledger flag.
 *
 * The two switches are deliberately separate. Recording every statement in a
 * live process is a cost and a disclosure decision; SUBSTITUTING a third-party
 * call for an admin-triggered replay is a behaviour the application asked for.
 * Requiring the first to get the second would mean turning full recording on in
 * production to use a feature that has nothing to do with recording.
 */
export function interceptEnabled(): boolean {
    return interceptNodes().length > 0
}

export function installOutboundSeam(ignoreHost?: string): void {
    if (outboundInstalled || (!ledgerEnabled() && !interceptEnabled())) return
    outboundInstalled = true
    const ignore = new Set<string>()
    for (const raw of [ignoreHost, (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get('SUPABASE_URL')]) {
        if (!raw) continue
        try { ignore.add(new URL(raw).host) } catch { /* not a URL */ }
    }
    const original = globalThis.fetch
    originalFetch = original
    globalThis.fetch = async function ledgeredFetch(input: RequestInfo | URL, init?: RequestInit) {
        let url: URL | null = null
        try { url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) } catch { /* opaque */ }
        if (!url || ignore.has(url.host)) return original(input as RequestInfo, init)

        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        const target = `${method} ${url.host}${normalizePath(url.pathname)}`

        // INTERCEPT — decided before the call is made, so neither branch reaches
        // the third party. Recorded in the ledger with the policy that fired, so
        // a corpus can never be mistaken for one produced against a live provider.
        // A SCOPED node is inert outside its scope: that is what allows this to
        // be armed in a live process without touching real traffic.
        const scope = SCOPE.getStore()
        // Most specific wins: a node scoped to the run in progress beats an
        // unscoped one for the same target. Without this the answer would
        // depend on the order nodes happen to appear in the policy, and an
        // admin's scoped replay would silently get the CI fixture instead.
        const candidates = interceptNodes().filter(
            n => n.target === target && (!n.scope || n.scope === scope?.tag))
        const node = candidates.find(n => n.scope) ?? candidates[0]
        if (node) {
            let body: unknown
            if (init?.body && typeof init.body === 'string') {
                try { body = JSON.parse(init.body) } catch { body = init.body }
            }
            if (node.intercept === 'store') {
                await storePayload(node, body, url, ignore)
                emitCall(target, node.status ?? 200, undefined, 'store', node.scope)
                return new Response(JSON.stringify(node.body ?? { id: `assay-stored`, assay: true }), {
                    status: node.status ?? 200, headers: { 'Content-Type': 'application/json' },
                })
            }
            // The fixture may reference the request, so a call whose answer
            // depends on the question does not collapse onto one reply.
            const { body: replayBody, unresolved } = resolveBody(
                node.body ?? {},
                factsOf(url, normalizePath(url.pathname), body, scope?.vars),
            )
            // An unresolved token means the fixture asked for something the
            // request did not carry. Silently returning a body with holes in it
            // is how a fixture starts lying, so it is recorded on the entry.
            emitCall(target, node.status ?? 200, undefined, 'replay', node.scope, unresolved)
            return new Response(JSON.stringify(replayBody), {
                status: node.status ?? 200, headers: { 'Content-Type': 'application/json' },
            })
        }
        const mode = captureMode()
        try {
            const res = await original(input as RequestInfo, init)
            // Intercepted calls are ALWAYS recorded (below, at the point of
            // substitution) — a substitution nobody can see is indistinguishable
            // from the provider having answered. An ordinary pass-through is
            // recorded only when the ledger itself is on.
            if (ledgerEnabled()) emitCall(target, res.status, res.ok ? undefined : `HTTP ${res.status}`)
            if (mode === 'shape' && ledgerEnabled()) {
                // The body can only be read once, so hand the caller a clone and
                // derive from ours. Failing to capture must never break the call.
                try {
                    const copy = res.clone()
                    const text = await copy.text()
                    const parsed = text ? JSON.parse(text) : undefined
                    let reqBody: unknown
                    if (init?.body && typeof init.body === 'string') {
                        try { reqBody = JSON.parse(init.body) } catch { reqBody = undefined }
                    }
                    emitShape(target, reqBody, parsed, res.status)
                } catch { /* non-JSON or unreadable: no shape, and no failure */ }
            }
            return res
        } catch (e) {
            if (ledgerEnabled()) emitCall(target, undefined, (e as Error).message)
            throw e
        }
    }
}

/**
 * Persist an intercepted payload into a table the APPLICATION owns.
 *
 * assay fills the row; it does not own the schema, the migration or whatever UI
 * reads it. Remove assay and the table is still there — just empty — and
 * anything reading it still renders. That is what keeps assay deletable.
 *
 * Writes go to PostgREST on the Supabase host, which the outbound seam ignores,
 * so this cannot recurse back through the patch.
 */
async function storePayload(
    node: InterceptNode, body: unknown, url: URL, ignore: Set<string>,
): Promise<void> {
    const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } }
    const base = g.Deno?.env?.get?.('SUPABASE_URL')
    const key = g.Deno?.env?.get?.('SUPABASE_SERVICE_ROLE_KEY')
    if (!node.sink || !base || !key) return
    try {
        const row: Record<string, unknown> = { [node.sink.column]: body, ...(node.sink.extra ?? {}) }
        const res = await originalFetch(`${base}/rest/v1/${node.sink.table}`, {
            method: 'POST',
            headers: {
                apikey: key, Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json', Prefer: 'return=minimal',
            },
            body: JSON.stringify(row),
        })
        // The response was DISCARDED here, so a rejected insert was
        // indistinguishable from a successful one: `email.send` filed nothing
        // for an entire run because email_previews.html is NOT NULL and the
        // node's `extra` did not supply it, PostgREST answered 400, and the
        // ledger still showed `intercepted: "store"` on every call. A store that
        // silently drops is a store that reads as working — which this function's
        // own catch block already said, while only catching a thrown error.
        if (!res.ok) {
            const detail = await res.text().catch(() => '')
            console.error(
                `[assay] sink REJECTED for ${node.id} → ${node.sink.table}: HTTP ${res.status} ` +
                `${redactError(detail)}. The call was still substituted, so nothing reached the ` +
                `provider — but nothing was persisted either.`,
            )
        }
    } catch (e) {
        // A sink failure must not take down the operation it intercepted; say so
        // loudly instead, because a store that silently drops is a store that
        // reads as working.
        console.error(`[assay] failed to store ${node.id} into ${node.sink.table}:`, (e as Error).message)
    }
}

function emitCall(
    target: string,
    status: number | undefined,
    error?: string,
    intercepted?: 'store' | 'replay',
    scope?: string,
    unresolved?: string[],
): void {
    sink({
        operation: CURRENT.getStore() ?? 'unattributed',
        target,
        verb: 'call',
        filters: [],
        embeds: [],
        rows: null,
        serviceRole: false,
        ...(status !== undefined ? { status } : {}),
        ...(error ? { error: redactError(error) } : {}),
        ...(intercepted ? { intercepted } : {}),
        ...(scope ? { interceptScope: scope } : {}),
        ...(unresolved && unresolved.length ? { unresolvedTokens: unresolved } : {}),
        seq: seq++,
    })
}

/** Any method on the client or a query builder. */
type AnyMethod = (...args: unknown[]) => unknown

/**
 * The PostgREST builder internals this seam reads.
 *
 * `headers` is a `Headers` INSTANCE in postgrest-js ≥ 1.19, not the plain record
 * it used to be — so `headers['Prefer']` silently yields `undefined` and every
 * header-based distinction collapses without erroring. Read it through
 * `headerOf`, never by index.
 */
interface BuilderInternals {
    method?: string
    url?: URL
    headers?: Headers | Record<string, string>
    then: (onfulfilled?: any, onrejected?: any) => any
}

/** Read a header whether the builder carries a `Headers` or a plain record. */
function headerOf(headers: BuilderInternals['headers'], name: string): string {
    if (!headers) return ''
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? ''
    const record = headers as Record<string, string>
    return record[name] ?? record[name.toLowerCase()] ?? ''
}

const isBuilder = (v: unknown): v is BuilderInternals =>
    !!v && typeof v === 'object' && typeof (v as any).then === 'function' && (v as any).url instanceof URL

/** Query params that describe the projection rather than a constraint. */
const NON_FILTER_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'])

function filtersOf(url: URL): string[] {
    const columns = new Set<string>()
    // `forEach` rather than `.keys()`: this package is type-checked under three
    // different lib sets (Deno for JSR, the Edge runtime, and each consumer's
    // tsconfig), and the iterator methods on URLSearchParams need DOM.Iterable,
    // which JSR's check does not include. forEach is in the base DOM lib.
    const keys: string[] = []
    url.searchParams.forEach((_value, key) => keys.push(key))
    for (const key of keys) {
        if (NON_FILTER_PARAMS.has(key)) continue
        // PostgREST logical operators (`or=(a.eq.1,b.eq.2)`) constrain columns we
        // do not parse out; record the operator so the entry is not read as
        // unfiltered, which is the one thing that would be actively misleading.
        columns.add(key)
    }
    return [...columns].sort()
}

/**
 * Embedded resource names in a PostgREST `select`.
 *
 * `select=*,member_social_medias(*),primary_sector:directory_sectors(label,scoring_group)`
 * is ONE request to the parent table. Without parsing this, an operation's read
 * set silently omits every embedded table — which is how `member_social_medias`
 * came to be read at seven call sites in this repo and declared by no operation.
 *
 * Handles the three forms PostgREST accepts on an embed: a bare name, an alias
 * (`alias:table(...)`) and a join hint (`table!inner(...)`), plus nesting.
 */
export function embedsOf(select: string | null): string[] {
    if (!select) return []
    const found: string[] = []
    const walk = (text: string): void => {
        let depth = 0
        let head = ''
        for (let i = 0; i < text.length; i++) {
            const ch = text[i]
            if (ch === '(') {
                if (depth === 0) {
                    // `head` is the embed's name; find its matching close paren.
                    let j = i, d = 0
                    for (; j < text.length; j++) {
                        if (text[j] === '(') d++
                        else if (text[j] === ')' && --d === 0) break
                    }
                    const name = head.split(':').pop()!.split('!')[0].trim()
                    if (/^[a-z_][a-z0-9_]*$/.test(name)) found.push(name)
                    walk(text.slice(i + 1, j))
                    i = j
                    head = ''
                    continue
                }
                depth++
            } else if (ch === ')') depth--
            else if (ch === ',' && depth === 0) head = ''
            else head += ch
        }
    }
    walk(select)
    return [...new Set(found)].sort()
}

function verbOf(b: BuilderInternals, isRpc: boolean): LedgerEntry['verb'] {
    const method = (b.method ?? 'GET').toUpperCase()
    if (isRpc) return 'rpc'
    if (method === 'HEAD') return 'count'
    if (method === 'GET') return 'read'
    if (method === 'PATCH') return 'update'
    if (method === 'DELETE') return 'delete'
    if (method === 'POST') {
        // `upsert` is a POST that differs from `insert` only by this header.
        return headerOf(b.headers, 'Prefer').includes('resolution=') ? 'upsert' : 'insert'
    }
    return 'read'
}

function rowsOf(result: unknown): number | null {
    if (!result || typeof result !== 'object') return null
    const data = (result as { data?: unknown }).data
    if (Array.isArray(data)) return data.length
    if (data === null || data === undefined) return null
    return 1
}

/**
 * Wrap a Supabase client so every statement it issues lands in the ledger.
 * Returns a proxy — the original client is untouched, and behaviour is unchanged.
 */
export function withLedger<T extends object>(client: T, options: LedgerOptions = {}): T {
    const { serviceRole = false } = options
    // Precedence: an explicit label, then the operation owning the current async
    // context, then the call site. The middle one matters for clients built deep
    // inside shared code (the mailer's preview driver) — the stack probe is a
    // Node-only heuristic and returns nothing useful under Deno, so without this
    // those statements would land under `unattributed`.
    const operation = options.operation ?? CURRENT.getStore() ?? operationFromStack()

    // Arm the outbound seam wherever the DB seam is installed, so the two cover
    // the same operations without a second set of call sites to keep in sync.
    // Before the ledger check, because an intercept policy arms it on its own:
    // a production deployment may substitute a scoped call without recording
    // every statement it issues.
    if (options.outbound !== false) installOutboundSeam()

    // Off by default: return the client untouched, so a deployment that has not
    // opted in pays nothing and writes nothing.
    if (!(options.enabled ?? ledgerEnabled())) return client
    // `enterWith`, not `run`: withLedger is called mid-handler and cannot wrap the
    // remaining work in a callback. The middleware uses runAsOperation, which is
    // stronger; this covers the functions that build their own client.
    if (options.operation && !CURRENT.getStore()) CURRENT.enterWith(options.operation)

    const record = (b: BuilderInternals, target: string, isRpc: boolean, result: unknown): void => {
        const error = (result as { error?: { message?: string } } | null)?.error
        sink({
            operation,
            target,
            verb: verbOf(b, isRpc),
            filters: b.url ? filtersOf(b.url) : [],
            embeds: b.url ? embedsOf(b.url.searchParams.get('select')) : [],
            rows: rowsOf(result),
            serviceRole,
            ...(error?.message ? { error: redactError(error.message) } : {}),
            seq: seq++,
        })
    }

    /** Proxy a builder so the chain stays intercepted and `then` records. */
    const wrapBuilder = <B extends object>(builder: B, target: string, isRpc: boolean): B =>
        new Proxy(builder, {
            get(node, prop, receiver) {
                if (prop === 'then' && isBuilder(node)) {
                    return (onfulfilled?: any, onrejected?: any) =>
                        // Delegate to whatever `then` is already there — under
                        // auto-pagination that is the page walk, so the row count
                        // recorded is the aggregate the caller receives.
                        Promise.resolve(node.then.call(node, (r: any) => r)).then(
                            (result: unknown) => {
                                record(node, target, isRpc, result)
                                return onfulfilled ? onfulfilled(result) : result
                            },
                            onrejected,
                        )
                }
                const value = Reflect.get(node, prop, receiver)
                if (typeof value !== 'function') return value
                return (...args: unknown[]) => {
                    const result = (value as AnyMethod).apply(node, args)
                    // Filter/transform methods return the builder itself — keep the
                    // wrapper on so the chain stays intercepted to the end.
                    return result === node || isBuilder(result) ? wrapBuilder(result as object, target, isRpc) : result
                }
            },
        })

    return new Proxy(client, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver)
            if ((prop === 'from' || prop === 'rpc') && typeof value === 'function') {
                const isRpc = prop === 'rpc'
                return (...args: unknown[]) =>
                    wrapBuilder((value as AnyMethod).apply(target, args) as object, String(args[0]), isRpc)
            }
            return typeof value === 'function' ? value.bind(target) : value
        },
    }) as T
}

/**
 * Best-effort operation name for a Next.js caller, read off the call stack.
 *
 * An Edge Function gets its name free from the request path. A Next server
 * component, server action or route handler has no ambient name, and labelling
 * every call site by hand is the "big bunch of edits" this seam exists to avoid.
 * So when no label is passed, the first stack frame inside `app/` or `lib/`
 * stands in for one — `app/(app)/dashboard/page.tsx` is a perfectly good
 * operation identity, and it costs nothing at the call site.
 *
 * DEV ONLY. Building a stack trace per client construction is not free, and the
 * label is a diagnostic rather than something the app depends on, so in
 * production this returns `unattributed` without touching `Error.stack`.
 */
export function operationFromStack(): string {
    // `process` is a Node global that does not exist in Deno, where this module is
    // also compiled. Reaching it through globalThis keeps the guard working on both
    // runtimes; naming it directly is a type error under Deno and would be a
    // ReferenceError at runtime for any Deno caller that omitted an explicit
    // operation.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    if (proc?.env?.NODE_ENV === 'production') return 'unattributed'
    const stack = new Error().stack
    if (!stack) return 'unattributed'

    const FRAME = /((?:app|lib|components|hooks)\/[\w.\-[\]()@]+(?:\/[\w.\-[\]()@]+)*\.tsx?)/
    const candidates: string[] = []
    for (const line of stack.split('\n').slice(2)) {
        if (line.includes('node_modules') || line.includes('/ledger.ts')) continue
        const match = line.match(FRAME)
        if (match && !candidates.includes(match[1])) candidates.push(match[1])
    }

    // RANK, do not take the first. The nearest frame is whatever helper happened
    // to construct the client — in this codebase that is `lib/services/admin-auth.ts`
    // for most admin routes, which would attribute nine different operations to
    // one shared auth helper and collapse the basin graph onto it. The frame that
    // names the OPERATION is the route or page further up the stack.
    const entry = candidates.find(f => /^app\/.*\/(route|page)\.tsx?$/.test(f))
    if (entry) return entry
    const anyApp = candidates.find(f => f.startsWith('app/'))
    if (anyApp) return anyApp
    return candidates.find(f => !f.includes('/supabase/')) ?? 'unattributed'
}


/**
 * The operation name for an edge-function request: the last path segment of
 * `/functions/v1/<name>`. Free attribution — the router already knows.
 */
export function operationFromRequest(req: { url: string }): string {
    try {
        const segments = new URL(req.url).pathname.split('/').filter(Boolean)
        return segments[segments.length - 1] ?? 'unattributed'
    } catch {
        return 'unattributed'
    }
}
