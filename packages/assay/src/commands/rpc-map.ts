#!/usr/bin/env bun
/**
 * Resolves what each Postgres function WRITES, so the ledger can attribute an
 * `rpc` statement to the tables it actually touches.
 *
 * ## Why this exists
 *
 * The DB seam (backend/supabase/functions/_shared/ledger.ts) is statement-level:
 * it sees the statement the client issued. When that statement is `rpc(...)`, the
 * write happens inside Postgres and the seam is blind to it.
 *
 * That is not a rounding error in this codebase — it is the dominant case.
 * `complete-mission` and `dismiss-mission` push their entire mutation into
 * `mark_weekly_task_target_complete` / `dismiss_weekly_task_target`, so a
 * client-side ledger reports them as having NO writes. A write set that is
 * silently empty is worse than no write set: it reads as "this operation is a
 * read", which is the opposite of the truth.
 *
 * So the write set is recovered from the function bodies. Resolution is
 * TRANSITIVE — a function that writes nothing directly but calls another that
 * does (e.g. `run_teams_sweep`) still resolves to the inner tables.
 *
 * Usage:
 *   assay rpc-map > .assay/rpc-writes.json
 *   assay report --rpc-map .assay/rpc-writes.json < ledger.log
 *
 * ## Honest limits
 *
 * This parses `pg_proc.prosrc` with a regex. It therefore:
 *  - MISSES writes built as dynamic SQL (`EXECUTE format(...)`) — reported below
 *    so the gap is counted rather than assumed away;
 *  - MISSES writes performed by TRIGGERS the statement fires;
 *  - may include a table named in a comment or a string literal.
 * It is a better lower bound than "nothing", not a sound analysis.
 */

import { discover } from '../lib/db.ts'
import { Client } from 'pg'

// `\b`, not Postgres's `\m` — this is a JavaScript regex. With `\m` the pattern
// silently matches the literal text "minsert into", so every write set comes back
// empty — which is indistinguishable from "this function writes nothing".
const WRITE_RE = /(?<!\bdo\s)\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi

/** Captures that are SQL syntax, not tables. `ON CONFLICT DO UPDATE SET x` would
 *  otherwise be read as a write to a table called `set`. */
const NOT_A_TABLE = new Set(['set', 'only', 'from', 'where', 'select', 'values'])
const DYNAMIC_RE = /\bexecute\b/i

interface Fn { name: string; body: string }

async function main() {
    // One place decides which database the toolchain talks to: .assay/config.json,
    // plus the active-db override that ledger-scratch writes.
    const url = discover().url ?? ''
    const client = new Client(url)
    await client.connect()
    const { rows } = await client.query<Fn>(
        `select p.proname as name, p.prosrc as body
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f'`,
    )
    // Only names that are ACTUALLY tables. The regex happily matches a CTE
    // (`insert into _pw_work`), a temp table, or a stray word after UPDATE — and a
    // declaration then claims writes to a table that does not exist, which is worse
    // than missing one because it looks like knowledge.
    const { rows: tableRows } = await client.query<{ name: string }>(
        `select table_name as name from information_schema.tables where table_schema = 'public'`,
    )
    const realTables = new Set(tableRows.map(r => r.name.toLowerCase()))
    await client.end()

    const bodies = new Map(rows.map(r => [r.name, r.body ?? '']))
    const names = [...bodies.keys()]

    /** Tables written directly in this body. */
    const directWrites = (body: string): string[] =>
        [...new Set([...body.matchAll(WRITE_RE)].map(m => m[1].toLowerCase()))]
            .filter(t => !NOT_A_TABLE.has(t) && realTables.has(t))
            .sort()

    /** Other public functions this body calls. */
    const callees = (self: string, body: string): string[] =>
        names.filter(n => n !== self && new RegExp(`\\b${n}\\s*\\(`, 'i').test(body))

    // Transitive closure, cycle-safe.
    const resolved = new Map<string, string[]>()
    const resolve = (name: string, seen = new Set<string>()): string[] => {
        if (resolved.has(name)) return resolved.get(name)!
        if (seen.has(name)) return []
        seen.add(name)
        const body = bodies.get(name) ?? ''
        const out = new Set(directWrites(body))
        for (const callee of callees(name, body)) for (const t of resolve(callee, seen)) out.add(t)
        const list = [...out].sort()
        if (seen.size === 1) resolved.set(name, list)
        return list
    }

    const map: Record<string, string[]> = {}
    const dynamic: string[] = []
    for (const name of names) {
        map[name] = resolve(name)
        if (DYNAMIC_RE.test(bodies.get(name) ?? '')) dynamic.push(name)
    }

    console.log(JSON.stringify({
        writes: map,
        // Named, not swallowed: these bodies build SQL at runtime, so their entry
        // above is a lower bound even by this script's own standard.
        dynamicSql: dynamic.sort(),
        functions: names.length,
    }, null, 2))
}

// `import.meta.main` is a Deno/Bun extension the TypeScript DOM lib does not
// declare, and this package is type-checked by both. The cast keeps the guard
// without pulling in a runtime-specific type reference.
//
// WITHOUT IT, IMPORTING THIS MODULE RUNS THE COMMAND. A unit test importing one
// exported helper opened a database connection, ran the command's SQL and called
// process.exit() — against whatever `discover()` found, which on a developer
// machine is their own working database. It was invisible locally because that
// database is on 127.0.0.1 and an IP needs no DNS; on CI, where discovery finds
// nothing, `new Client('')` falls back to pg's default host — the literal string
// "base" — and the resolver failure surfaced as an unattributed rejection that
// named an innocent test file.
if ((import.meta as { main?: boolean }).main) main()
