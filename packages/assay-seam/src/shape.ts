/**
 * Shape derivation and allowlist redaction.
 *
 * Two operations that look similar and are not:
 *
 *   deriveShape(value)      → field paths and their TYPES. No values at all.
 *   redact(value, keep)     → values for allowlisted paths, type markers elsewhere.
 *
 * `deriveShape` is what a production recorder should emit: it answers "did the
 * provider change their payload?" — which is what actually breaks an
 * integration — while being incapable of carrying personal data. A provider
 * ADDING a field is additive and should not fire; removing one, or changing
 * `string` to `object`, is the breakage worth catching.
 *
 * `redact` exists for the cases where a fixture must carry real values to drive
 * anything (a member id the pipeline looks up). It is an ALLOWLIST, never a
 * denylist: you cannot enumerate what is sensitive in a payload the provider
 * controls, so anything unlisted is replaced rather than inspected.
 */

const MAX_DEPTH = 8

function typeOf(v: unknown): string {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    return typeof v
}

/**
 * Field paths with their types, sorted and deduplicated.
 *
 * Arrays collapse to a single `path[]` entry derived from their elements —
 * otherwise a 200-item list produces 200 paths and two recordings of the same
 * endpoint never compare equal.
 */
export function deriveShape(value: unknown, prefix = '', depth = 0, out: Set<string> = new Set<string>()): string[] {
    if (depth > MAX_DEPTH) {
        out.add(`${prefix}:<max-depth>`)
        return [...out].sort()
    }
    if (Array.isArray(value)) {
        out.add(`${prefix}[]:array`)
        // Union of element shapes: a heterogeneous array is itself a fact worth
        // seeing, and taking only the first element would hide it.
        for (const item of value.slice(0, 20)) {
            if (item !== null && typeof item === 'object') deriveShape(item, `${prefix}[]`, depth + 1, out)
            else out.add(`${prefix}[]:${typeOf(item)}`)
        }
        return [...out].sort()
    }
    if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const path = prefix ? `${prefix}.${k}` : k
            out.add(`${path}:${typeOf(v)}`)
            if (v !== null && typeof v === 'object') deriveShape(v, path, depth + 1, out)
        }
        return [...out].sort()
    }
    if (prefix) out.add(`${prefix}:${typeOf(value)}`)
    return [...out].sort()
}

/** Paths present in `after` but not `before`, and vice versa, with type changes. */
export function diffShape(before: string[], after: string[]): {
    added: string[]; removed: string[]; retyped: Array<{ path: string; from: string; to: string }>
} {
    const split = (s: string) => { const i = s.lastIndexOf(':'); return [s.slice(0, i), s.slice(i + 1)] as const }
    const b = new Map(before.map(split))
    const a = new Map(after.map(split))
    const retyped: Array<{ path: string; from: string; to: string }> = []
    for (const [path, type] of a) {
        const was = b.get(path)
        if (was !== undefined && was !== type) retyped.push({ path, from: was, to: type })
    }
    return {
        // A provider adding a field is additive; it is reported, not failed on.
        added: [...a.keys()].filter(p => !b.has(p)).sort(),
        removed: [...b.keys()].filter(p => !a.has(p)).sort(),
        retyped: retyped.sort((x, y) => x.path.localeCompare(y.path)),
    }
}

/**
 * Keep allowlisted paths verbatim; replace everything else with its type.
 *
 * `keep` entries are paths as `deriveShape` emits them, minus the type suffix.
 * A prefix match keeps a whole subtree (`data.object.metadata` keeps its keys).
 */
export function redact(value: unknown, keep: string[], prefix = '', depth = 0): unknown {
    const kept = (path: string) => keep.some(k => path === k || path.startsWith(`${k}.`) || path.startsWith(`${k}[]`))
    if (depth > MAX_DEPTH) return '<max-depth>'
    if (Array.isArray(value)) return value.map(v => redact(v, keep, `${prefix}[]`, depth + 1))
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const path = prefix ? `${prefix}.${k}` : k
            out[k] = kept(path) ? v : redact(v, keep, path, depth + 1)
        }
        return out
    }
    return prefix && kept(prefix) ? value : `<${typeOf(value)}>`
}
