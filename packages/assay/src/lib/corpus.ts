/**
 * Shared corpus model for the ledger tools.
 *
 * `ledger-report`, `ledger-declare` and `ledger-check` all have to agree on what
 * an operation's read set, write set and coupling ARE. Three copies of that
 * definition would drift, and the failure would be silent in the worst way: the
 * check would pass against a write set the report never showed. One definition,
 * imported by all three.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectRoot } from './paths.ts'

export const LEDGER_TAG = '@ledger'
export const WRITE_VERBS: Set<string> = new Set(['insert', 'update', 'upsert', 'delete'])

/** PostgREST's `db-max-rows`. A read returning EXACTLY this was capped. */
export const POSTGREST_CAP = 1000

/**
 * What assay does NOT look at. Printed by every tool, from here, so the tools
 * cannot drift into three different accounts of their own blind spots.
 *
 * A clean run means "nothing found in the categories assay covers". It is not
 * evidence of correctness: a value computed differently, a rule applied to the
 * wrong rows, a semantic regression that keeps the same tables and the same
 * magnitudes — all of these pass everything here.
 */
export const NOT_COVERED = [
    'values — a field computed differently writes the same table with the same verb',
    'trigger and cascade writes — write sets are a LOWER BOUND',
    'which rows changed — statement-level, not a row diff',
    'concurrency — a single run says nothing about interleaving',
    'anything bypassing a wrapped client — psql, migrations, direct pg',
    'logic no invariant describes — invariants are total over inputs, not over properties',
]

export function printNotCovered(): void {
    console.log('\nassay found nothing in the categories it covers. It does NOT cover:')
    for (const line of NOT_COVERED) console.log(`    · ${line}`)
    console.log('  A clean run is not evidence of correctness.')
}

/**
 * Bands a count onto the 1-2-5 preferred-number series (1, 2, 5, 10, 20, 50, …).
 *
 * Profiles are compared as BANDS so ±3 rows never churns a declaration, while a
 * real shift does. Decade banding (10x) was the first attempt and is too coarse
 * to be useful: 18 and 41 statements both land in "~10", which is exactly the
 * resolution needed to notice that an operation started doing 2x the work. The
 * 1-2-5 series gives ~2.5x steps — coarse enough to be stable, fine enough to
 * see a change worth looking at.
 *
 * It still will not see 1000 -> 1559. That class of change is caught by the
 * cap-hit check instead, not by the profile.
 */
export function band(n: number): string {
    if (n <= 0) return '0'
    const decade = Math.pow(10, Math.floor(Math.log10(n)))
    const lead = n / decade
    const step = lead >= 5 ? 5 : lead >= 2 ? 2 : 1
    const value = step * decade
    return value >= 1000 ? `~${value / 1000}k` : `~${value}`
}


export interface Entry {
    operation: string
    target: string
    verb: string
    filters: string[]
    /** Tables pulled in by an embedded select. Absent in corpora recorded before this existed. */
    embeds?: string[]
    rows: number | null
    serviceRole: boolean
    error?: string
    seq: number
}

export interface OperationSummary {
    operation: string
    reads: string[]
    writes: string[]
    rpcs: string[]
    statements: number
    serviceRole: boolean
    /** Writes issued with nothing constraining which rows they hit. */
    unfilteredWrites: Array<{ target: string; verb: string }>
    errors: string[]
    /** Tables written INSIDE a called Postgres function, not by a client statement. */
    writesViaRpc: string[]
    /** Outbound HTTP endpoints, as `METHOD host/path/{id}`. Not tables. */
    calls: string[]
    /** Banded magnitudes — how MUCH, not just which. See `band`. */
    profile: { statements: string; rows: Record<string, string> }
    /**
     * Reads that came back at exactly the PostgREST cap with no continuation page.
     * The signature of a silently truncated read: the caller believes it read
     * everything and got page 1. SUSPECTED, not proven — a table holding exactly
     * 1000 rows looks identical.
     */
    capHits: Array<{ target: string; seq: number }>
}

export function parse(text: string): Entry[] {
    const entries: Entry[] = []
    for (const line of text.split('\n')) {
        const at = line.indexOf(LEDGER_TAG)
        if (at === -1) continue
        try {
            const entry = JSON.parse(line.slice(at + LEDGER_TAG.length).trim())
            if (entry && typeof entry.operation === 'string' && typeof entry.target === 'string') {
                entries.push(entry as Entry)
            }
        } catch {
            // A truncated or interleaved log line. Counted, not guessed at.
            malformed++
        }
    }
    return entries
}
let malformed = 0

/**
 * Every edge function on disk — the denominator for coverage.
 *
 * A directory is only an operation if it has an `index.ts`; `types/` and
 * `.vscode/` sit in the same folder and would otherwise inflate the denominator,
 * making coverage look worse than it is. A wrong denominator discredits the one
 * number in this report whose job is to be believed.
 */
export function declaredOperations(): string[] {
    const root = join(projectRoot(), 'backend', 'supabase', 'functions')
    try {
        return readdirSync(root, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
            .filter(d => existsSync(join(root, d.name, 'index.ts')))
            .map(d => d.name)
            .sort()
    } catch {
        return []
    }
}

/** `{ fnName: [tables it writes] }`, from assay/src/commands/rpc-map.ts. */
export type RpcMap = Record<string, string[]>

export function summarise(entries: Entry[], rpcMap: RpcMap): OperationSummary[] {
    const byOperation = new Map<string, Entry[]>()
    for (const e of entries) {
        byOperation.set(e.operation, [...(byOperation.get(e.operation) ?? []), e])
    }

    return [...byOperation.entries()]
        .map(([operation, list]): OperationSummary => {
            const reads = new Set<string>()
            const writes = new Set<string>()
            const rpcs = new Set<string>()
            const calls = new Set<string>()
            const writesViaRpc = new Set<string>()
            const unfilteredWrites: OperationSummary['unfilteredWrites'] = []
            const errors = new Set<string>()

            for (const e of list) {
                // Calls are counted BEFORE the error guard. A rejected SQL statement
                // touched nothing, so excluding it from the sets is right. An
                // outbound request that came back 403 still LEFT THE PROCESS — the
                // third party saw it. Excluding it would let an operation reach a
                // new service and pass the gate as long as the service said no.
                if (e.verb === 'call') {
                    calls.add(e.target)
                    if (e.error) errors.add(`call ${e.target}: ${e.error}`)
                    continue
                }
                if (e.error) {
                    // A statement that ERRORED did not touch anything — PostgREST
                    // rejected it. Counting it would report a write that never
                    // happened (a foreign-key rejection reads as "wrote the table"),
                    // and would then be baked into the declaration by ledger-declare.
                    // The error is still reported below; only the SETS exclude it.
                    errors.add(`${e.verb} ${e.target}: ${e.error}`)
                    continue
                }
                if (e.verb === 'rpc') {
                    rpcs.add(e.target)
                    // The seam sees the CALL; the write happens inside Postgres.
                    // Without this the operation reports no writes at all, which
                    // is the opposite of the truth for anything that mutates
                    // through a function.
                    for (const t of rpcMap[e.target] ?? []) {
                        writes.add(t)
                        writesViaRpc.add(t)
                    }
                }
                else if (WRITE_VERBS.has(e.verb)) {
                    writes.add(e.target)
                    // An insert has nothing to constrain; update/delete do.
                    if (e.filters.length === 0 && e.verb !== 'insert' && e.verb !== 'upsert') {
                        unfilteredWrites.push({ target: e.target, verb: e.verb })
                    }
                } else reads.add(e.target)
                // An embedded select resolves inside ONE request to the parent, so
                // these tables never appear as a `target`. They are always reads —
                // including the `.select()` payload of a write.
                for (const t of e.embeds ?? []) reads.add(t)
            }

            // Rows per table, summed across the operation's statements.
            const rowsByTable: Record<string, number> = {}
            for (const e of list) {
                if (e.error || typeof e.rows !== 'number') continue
                rowsByTable[e.target] = (rowsByTable[e.target] ?? 0) + e.rows
            }
            const bandedRows: Record<string, string> = {}
            for (const t of Object.keys(rowsByTable).sort()) bandedRows[t] = band(rowsByTable[t])

            // A capped read is fine when a further read of the SAME target follows
            // and comes back short — that is page 2 of an explicit paging loop.
            const capHits: OperationSummary['capHits'] = []
            for (let i = 0; i < list.length; i++) {
                const e = list[i]
                if (e.error || e.verb !== 'read' || e.rows !== POSTGREST_CAP) continue
                const continued = list.slice(i + 1).some(n => n.target === e.target && !n.error && typeof n.rows === 'number' && n.rows < POSTGREST_CAP)
                if (!continued) capHits.push({ target: e.target, seq: e.seq })
            }

            return {
                operation,
                reads: [...reads].sort(),
                writes: [...writes].sort(),
                rpcs: [...rpcs].sort(),
                statements: list.length,
                serviceRole: list.some(e => e.serviceRole),
                unfilteredWrites,
                errors: [...errors],
                writesViaRpc: [...writesViaRpc].sort(),
                calls: [...calls].sort(),
                profile: { statements: band(list.length), rows: bandedRows },
                capHits,
            }
        })
        .sort((a, b) => a.operation.localeCompare(b.operation))
}

/** A → B when A writes a table B reads. Self-edges dropped. */
export function basins(summaries: OperationSummary[]): Array<{ from: string; to: string; via: string[] }> {
    const edges: Array<{ from: string; to: string; via: string[] }> = []
    for (const a of summaries) {
        for (const b of summaries) {
            if (a.operation === b.operation) continue
            const via = a.writes.filter(t => b.reads.includes(t))
            if (via.length) edges.push({ from: a.operation, to: b.operation, via })
        }
    }
    return edges
}

/** How concentrated the graph is — the hairball check. */
export function fanOut(summaries: OperationSummary[]): Array<{ table: string; readers: number; writers: number }> {
    const readers = new Map<string, Set<string>>()
    const writers = new Map<string, Set<string>>()
    for (const s of summaries) {
        for (const t of s.reads) readers.set(t, (readers.get(t) ?? new Set()).add(s.operation))
        for (const t of s.writes) writers.set(t, (writers.get(t) ?? new Set()).add(s.operation))
    }
    const tables = new Set([...readers.keys(), ...writers.keys()])
    return [...tables]
        .map(table => ({
            table,
            readers: readers.get(table)?.size ?? 0,
            writers: writers.get(table)?.size ?? 0,
        }))
        .sort((a, b) => b.readers + b.writers - (a.readers + a.writers))
}

/** Lines that carried the tag but did not parse. Counted, never guessed at. */
export const malformedCount = (): number => malformed

/** Load the rpc write map produced by assay/src/commands/rpc-map.ts. */
export function loadRpcMap(path: string): { map: RpcMap; loaded: boolean } {
    try {
        return { map: (JSON.parse(readFileSync(path, 'utf8')).writes ?? {}) as RpcMap, loaded: true }
    } catch {
        return { map: {}, loaded: false }
    }
}

/** Read a corpus from a file path, or stdin when no path is given. */
export function readCorpus(file?: string): Entry[] {
    return parse(readFileSync(file ?? 0, 'utf8'))
}

