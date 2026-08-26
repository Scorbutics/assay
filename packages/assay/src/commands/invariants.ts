#!/usr/bin/env bun
/**
 * Invariants: properties that hold for EVERY input, checked against the database.
 *
 * ## Why this exists alongside the ledger gate
 *
 * `ledger-check` catches STRUCTURAL drift — an operation writing a table it did
 * not declare. It cannot catch LOGICAL drift: a score computed differently writes
 * the same table with the same verb and looks identical.
 *
 * The obvious answer is to record input → output and diff it after. That works,
 * but it is scenario-based (it only covers what you drove) and it churns (every
 * intentional change rewrites baselines until people update them reflexively).
 *
 * An invariant is the other half. "The sum of completions never exceeds the
 * targets that exist" holds for every input there will ever be, needs no recorded
 * scenario, and survives intentional change without a rewrite. It is the closest
 * thing to completeness available on a backend, where the input space includes
 * the entire database and cannot be enumerated.
 *
 * ## The ratchet
 *
 * A legacy database has pre-existing violations. An invariant that is red on day
 * one gets ignored by day two, and a big-bang cleanup is not a realistic price of
 * adoption. So violations are keyed (the query's first column) and baselined:
 * known keys are reported and tolerated, NEW keys fail. The invariant starts
 * working immediately and the debt can only shrink.
 *
 * ## The ledger link
 *
 * With `--corpus`, only invariants whose `tables:` intersect the corpus's observed
 * WRITE set are run — the ledger already knows which invariants an operation could
 * possibly have broken. Everything else is skipped and SAID to be skipped.
 *
 * Usage:
 *   assay invariants                        # all invariants
 *   assay invariants --corpus corpus.log    # only what the run could break
 *   assay invariants --accept               # baseline current violations
 */

import { discover } from '../lib/db.ts'
import { Client } from 'pg'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadRpcMap, printNotCovered, readCorpus, summarise } from '../lib/corpus.ts'

interface Invariant { name: string; tables: string[]; sql: string }
type Baseline = Record<string, string[]>

/** Parse the `-- invariant:` / `-- tables:` block format. */
export function parseInvariants(text: string): Invariant[] {
    const out: Invariant[] = []
    for (const block of text.split(/^--\s*invariant:\s*/m).slice(1)) {
        const lines = block.split('\n')
        const name = lines[0].trim()
        const tables = (lines.find(l => /^--\s*tables:/.test(l))?.replace(/^--\s*tables:/, '') ?? '')
            .split(',').map(t => t.trim()).filter(Boolean)
        const sql = lines.slice(1).filter(l => !/^\s*--/.test(l)).join('\n').trim().replace(/;\s*$/, '')
        if (name && sql) out.push({ name, tables, sql })
    }
    return out
}

/**
 * Split observed violations into NEW and already-known.
 *
 * Pure and exported so it can be tested without a database — the previous test
 * asserted against two UUIDs that happened to exist in the local data, and broke
 * the moment the database was reset. A ratchet test must not depend on which rows
 * are lying around.
 */
export function ratchet(keys: string[], known: string[]): { newKeys: string[]; knownKeys: string[] } {
    return { newKeys: keys.filter(k => !known.includes(k)), knownKeys: keys.filter(k => known.includes(k)) }
}

const loadBaseline = (path: string): Baseline => {
    try { return JSON.parse(readFileSync(path, 'utf8')) as Baseline } catch { return {} }
}

async function main() {
    const args = process.argv.slice(2)
    const at = (flag: string, fallback: string) => {
        const i = args.indexOf(flag)
        return i === -1 ? fallback : args[i + 1]
    }
    const asJson = args.includes('--json')
    const accept = args.includes('--accept')
    const invPath = at('--invariants', '.assay/invariants.sql')
    const basePath = at('--baseline', '.assay/invariant-baseline.json')
    const corpusPath = args.includes('--corpus') ? at('--corpus', '') : undefined
    const dbUrl = at('--db', '') || discover().url || ''

    if (!existsSync(invPath)) {
        console.error(`✗ No invariants at ${invPath}`)
        process.exit(2)
    }
    const all = parseInvariants(readFileSync(invPath, 'utf8'))
    const baseline = loadBaseline(basePath)

    // Scope to what the run could have broken, when a corpus is given.
    let selected = all
    let skipped: string[] = []
    let writeSet: string[] = []
    if (corpusPath) {
        const { map } = loadRpcMap(at('--rpc-map', '.assay/rpc-writes.json'))
        writeSet = [...new Set(summarise(readCorpus(corpusPath), map).flatMap(s => s.writes))]
        selected = all.filter(i => i.tables.some(t => writeSet.includes(t)))
        skipped = all.filter(i => !selected.includes(i)).map(i => i.name)
    }

    const client = new Client(dbUrl)
    await client.connect()

    const results: Array<{ name: string; newKeys: string[]; knownKeys: string[]; error?: string }> = []
    for (const inv of selected) {
        try {
            const { rows } = await client.query(inv.sql)
            const keys = rows.map(r => String(Object.values(r)[0])).sort()
            results.push({ name: inv.name, ...ratchet(keys, baseline[inv.name] ?? []) })
        } catch (e) {
            // A broken invariant is a FAILURE, not a skip. An invariant that
            // errors silently is indistinguishable from one that holds.
            results.push({ name: inv.name, newKeys: [], knownKeys: [], error: (e as Error).message.split('\n')[0] })
        }
    }
    await client.end()

    const broken = results.filter(r => r.error)
    const violated = results.filter(r => r.newKeys.length)
    const tolerated = results.filter(r => !r.error && !r.newKeys.length && r.knownKeys.length)

    if (accept) {
        const next: Baseline = { ...baseline }
        for (const r of results) {
            if (r.error) continue
            const keys = [...r.knownKeys, ...r.newKeys].sort()
            if (keys.length) next[r.name] = keys
            else delete next[r.name]
        }
        writeFileSync(basePath, JSON.stringify(next, null, 2) + '\n')
        console.log(`Baselined ${Object.keys(next).length} invariant(s) with violations into ${basePath}.`)
        console.log('Review the diff — every key here is debt you have chosen to carry.')
        return
    }

    if (asJson) {
        console.log(JSON.stringify({ results, skipped, writeSet, errors: broken.length, violations: violated.length }, null, 2))
        process.exit(broken.length || violated.length ? 1 : 0)
    }

    if (!results.length) {
        // "0 held, 0 violated" reads as success in every summary. It means the
        // corpus write set matched no invariant's tables — usually because the
        // corpus was empty, i.e. nothing was checked at all.
        console.error('✗ No invariants ran.')
        console.error(corpusPath
            ? `  The corpus's write set [${writeSet.join(', ') || 'empty'}] matched none of the ${all.length} invariants.`
            : `  ${all.length} invariant(s) are declared but none executed.`)
        process.exit(1)
    }
    for (const r of broken) console.log(`✗ ${r.name}\n    invariant failed to RUN: ${r.error}`)
    for (const r of violated) {
        console.log(`✗ ${r.name}`)
        console.log(`    ${r.newKeys.length} NEW violation(s): ${r.newKeys.slice(0, 5).join(', ')}${r.newKeys.length > 5 ? ' …' : ''}`)
        console.log(`    → Fix them, or accept as debt: assay invariants --accept`)
    }
    for (const r of tolerated) console.log(`· ${r.name}: ${r.knownKeys.length} known violation(s), baselined`)

    const held = results.length - broken.length - violated.length - tolerated.length
    console.log(`\n${held} held, ${violated.length} violated, ${tolerated.length} baselined, ${broken.length} broken (${results.length} run).`)
    if (!broken.length && !violated.length) {
        // An invariant is total over INPUTS, never over PROPERTIES. Holding says
        // nothing about the logic nobody wrote an invariant for.
        console.log('  Invariants hold only for the properties someone wrote down.')
        printNotCovered()
    }
    if (corpusPath) {
        console.log(`· Scoped to the corpus write set [${writeSet.join(', ')}].`)
        // The remainder: these were NOT checked.
        if (skipped.length) console.log(`· ${skipped.length} invariant(s) NOT run (no table in the write set): ${skipped.join(', ')}`)
    }
    process.exit(broken.length || violated.length ? 1 : 0)
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
