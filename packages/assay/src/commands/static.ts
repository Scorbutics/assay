#!/usr/bin/env bun
/**
 * The STATIC footprint of each operation: every table its code can reach.
 *
 * The observed ledger is a lower bound on branches — it only knows what was
 * driven. `scoring-cycle` declared no `email_logs` write for hours purely because
 * the one probe passed `sendEmails: false`. Static analysis has the opposite bias:
 * it sees every branch, including unreachable ones, and cannot see anything built
 * at runtime.
 *
 * Neither is the truth. The INTERESTING thing is the disagreement:
 *
 *   in code, never observed  → a branch no probe reaches (a coverage hole), or
 *                              genuinely dead code
 *   observed, not in code    → reached through a helper this crawl did not follow,
 *                              or an rpc whose body writes it
 *
 * Usage: assay static [--json]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { projectRoot, isEntrypoint } from '../lib/paths.ts'

const ROOT = projectRoot()
const FUNCTIONS = join(ROOT, 'backend', 'supabase', 'functions')

const ACCESS = /\.(from|rpc)\(\s*['"]([a-z_][a-z0-9_]*)['"]/g
/**
 * A write verb chained onto a `.from('table')`.
 *
 * Needed because `mustNotWrite` is the strongest signal an expectation carries,
 * and checking it against OBSERVED writes only is useless for exactly the case it
 * exists for: `complete-mission` upserts `subscriptions` on the Connecter branch,
 * no probe reached that branch, so the check passed on a write that is right there
 * in the source. A verb-blind static crawl has the same hole.
 *
 * The chain may be broken across lines and separated by filters, so the window is
 * generous; over-reporting a write is the safe direction here.
 */
const WRITE_CHAIN = /\.from\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)([\s\S]{0,400}?)\.(insert|update|upsert|delete)\s*\(/g
const EMBED = /\.select\(\s*['"`]([^'"`]*)['"`]/g
const IMPORT = /from\s+['"](\.[^'"]+)['"]/g

/** Embedded resource names inside a select string — same blind spot the seam had. */
function embedsIn(select: string): string[] {
    const out: string[] = []
    for (const m of select.matchAll(/([a-z_][a-z0-9_]*)\s*(?:!\w+)?\s*\(/g)) out.push(m[1])
    return out.filter(n => !['select', 'count', 'sum', 'avg', 'min', 'max'].includes(n))
}

function resolveImport(fromFile: string, spec: string): string | null {
    const base = resolve(dirname(fromFile), spec)
    for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(c) && statSync(c).isFile()) return c
    }
    return null
}

export interface Footprint { tables: Set<string>; writes: Set<string> }

/** All tables reachable from an entry file, following relative imports. */
function crawl(entry: string, seen = new Set<string>()): Footprint {
    const out: Footprint = { tables: new Set(), writes: new Set() }
    if (seen.has(entry) || !existsSync(entry)) return out
    seen.add(entry)
    const src = readFileSync(entry, 'utf8')
    for (const m of src.matchAll(ACCESS)) out.tables.add(m[2])
    for (const m of src.matchAll(EMBED)) for (const t of embedsIn(m[1])) out.tables.add(t)
    for (const m of src.matchAll(WRITE_CHAIN)) {
        // Guard against the window swallowing a later, unrelated statement.
        if (!m[2].includes('.from(')) out.writes.add(m[1])
    }
    for (const m of src.matchAll(IMPORT)) {
        const next = resolveImport(entry, m[1])
        if (!next) continue
        const sub = crawl(next, seen)
        for (const t of sub.tables) out.tables.add(t)
        for (const t of sub.writes) out.writes.add(t)
    }
    return out
}

function main() {
    const operations = readdirSync(FUNCTIONS, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
        .filter(d => existsSync(join(FUNCTIONS, d.name, 'index.ts')))
        .map(d => d.name)
        .sort()

    const result: Record<string, { tables: string[]; writes: string[] }> = {}
    for (const op of operations) {
        const f = crawl(join(FUNCTIONS, op, 'index.ts'))
        result[op] = { tables: [...f.tables].sort(), writes: [...f.writes].sort() }
    }

    if (process.argv.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return }
    for (const [op, f] of Object.entries(result)) {
        console.log(`${op}\n    reaches: ${f.tables.join(', ') || '(none)'}`)
        if (f.writes.length) console.log(`    writes:  ${f.writes.join(', ')}`)
    }
}

// WITHOUT THIS GUARD, IMPORTING THIS MODULE RUNS THE COMMAND. A unit test importing one
// exported helper opened a database connection, ran the command's SQL and called
// process.exit() — against whatever `discover()` found, which on a developer
// machine is their own working database. It was invisible locally because that
// database is on 127.0.0.1 and an IP needs no DNS; on CI, where discovery finds
// nothing, `new Client('')` falls back to pg's default host — the literal string
// "base" — and the resolver failure surfaced as an unattributed rejection that
// named an innocent test file.
if (isEntrypoint(import.meta.url)) main()