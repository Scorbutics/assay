/**
 * Request-aware replay bodies.
 *
 * A replay fixture used to be one static body, which is fine for a call whose
 * answer does not depend on the question and wrong for everything else. The
 * case that forced this: a hand-rolled fake it was meant to replace encoded the
 * buyer's email INTO the contact id and decoded it back, so every simulated
 * purchase resolved to a different member. One static body collapses them all
 * onto one identity — a regression disguised as a cleanup.
 *
 * So a fixture may reference the request. The vocabulary is deliberately small:
 * this resolves values OUT of a request, it does not compute. Anything that
 * needs real logic belongs in the application, not in a JSON fixture.
 *
 *   {id} {email}      the placeholders normalizePath produced, in order —
 *                     {id} is the first, {id2} the second, and so on
 *   {path.N}          the Nth path segment, zero-based
 *   {query.name}      a query parameter
 *   {body.a.b}        a field of the request body, dotted
 *   {scope.name}      a value the application passed to withInterceptScope
 *
 * A token may end in `|base64`, which decodes the resolved value. That one
 * transform exists because an opaque-looking identifier is the normal way to
 * smuggle a value through a provider's id field, and it is an encoding rather
 * than application logic. There is no second transform, and adding one should
 * be argued for rather than assumed.
 */

export interface RequestFacts {
    /** Real path segments, empty ones dropped. */
    path: string[]
    /** Placeholder name -> captured value, e.g. `id` -> `contact-1234`. */
    params: Record<string, string>
    query: Record<string, string>
    body: unknown
    /**
     * Values supplied by the application when it entered the intercept scope.
     *
     * The outbound request is not always where the interesting value lives. An
     * admin replaying a payment against fixtures knows the identity to use
     * before any call is made, and the provider's URL carries no trace of it —
     * so the scope carries it instead of the fixture guessing.
     */
    scope?: Record<string, string>
}

/**
 * Zip the real path against its normalised form: wherever normalisation
 * produced a placeholder, the real segment is what it stood for.
 *
 * Repeats are numbered from two (`id`, `id2`, `id3`) rather than from one, so
 * the common single-placeholder case keeps the name a fixture author expects.
 */
export function captureParams(pathname: string, normalized: string): Record<string, string> {
    const real = pathname.split('/')
    const norm = normalized.split('/')
    const params: Record<string, string> = {}
    const seen: Record<string, number> = {}
    for (let i = 0; i < norm.length && i < real.length; i++) {
        const m = /^\{(\w+)\}$/.exec(norm[i])
        if (!m) continue
        const name = m[1]
        seen[name] = (seen[name] ?? 0) + 1
        params[seen[name] === 1 ? name : `${name}${seen[name]}`] = real[i]
    }
    return params
}

export function factsOf(
    url: URL,
    normalized: string,
    body: unknown,
    scope?: Record<string, string>,
): RequestFacts {
    const query: Record<string, string> = {}
    url.searchParams.forEach((v, k) => { query[k] = v })
    return {
        path: url.pathname.split('/').filter(Boolean),
        params: captureParams(url.pathname, normalized),
        query,
        body,
        ...(scope ? { scope } : {}),
    }
}

function dig(value: unknown, parts: string[]): unknown {
    let cur = value
    for (const p of parts) {
        if (cur === null || typeof cur !== 'object') return undefined
        cur = (cur as Record<string, unknown>)[p]
    }
    return cur
}

function decodeBase64(input: string): string | undefined {
    try {
        // atob is available in Deno, node >= 16 and every browser. Padding is
        // optional in practice and its absence is common in url-safe ids.
        const padded = input + '='.repeat((4 - (input.length % 4)) % 4)
        return atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
    } catch { return undefined }
}

/** Resolve one token, without its braces. Returns undefined if it cannot. */
export function resolveToken(token: string, facts: RequestFacts): string | undefined {
    const [expr, ...transforms] = token.split('|')
    let value: unknown

    if (expr.startsWith('path.')) value = facts.path[Number(expr.slice(5))]
    else if (expr.startsWith('query.')) value = facts.query[expr.slice(6)]
    else if (expr.startsWith('body.')) value = dig(facts.body, expr.slice(5).split('.'))
    else if (expr.startsWith('scope.')) value = facts.scope?.[expr.slice(6)]
    else value = facts.params[expr]

    if (value === undefined || value === null) return undefined
    let out = typeof value === 'string' ? value : JSON.stringify(value)

    for (const t of transforms) {
        if (t !== 'base64') return undefined      // unknown transform: unresolved, not silently ignored
        const decoded = decodeBase64(out)
        if (decoded === undefined) return undefined
        out = decoded
    }
    return out
}

const TOKEN = /\{([\w.|]+)\}/g

export interface Resolved {
    body: unknown
    /** Tokens that resolved to nothing. Reported, never silently left in place. */
    unresolved: string[]
}

/**
 * Substitute tokens throughout a fixture body.
 *
 * An unresolved token is NOT left in the output as literal `{id}` — that would
 * ship a string nobody wrote into the application as if it were provider data.
 * It becomes an empty string and is reported, so the caller can say so.
 */
export function resolveBody(body: unknown, facts: RequestFacts): Resolved {
    const unresolved: string[] = []

    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') {
            return v.replace(TOKEN, (_whole, token: string) => {
                const r = resolveToken(token, facts)
                if (r === undefined) { unresolved.push(token); return '' }
                return r
            })
        }
        if (Array.isArray(v)) return v.map(walk)
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {}
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val)
            return out
        }
        return v
    }

    return { body: walk(body), unresolved }
}
