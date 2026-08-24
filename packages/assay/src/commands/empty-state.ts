#!/usr/bin/env bun
/**
 * The empty-state obligation.
 *
 * motu's rule is that an island must render correctly from its DEFAULT PROPS
 * ALONE — no channels, no fixtures. That single obligation covers every island
 * with nothing authored per island, and an island that cannot meet it has a wrong
 * boundary rather than a missing test.
 *
 * This is its backend translation: every operation must survive a MINIMAL
 * database — freshly migrated and seeded, with no accumulated rows — without
 * crashing and without writing outside its declaration.
 *
 * It is TOTAL over operations. It needs no recorded scenario, no golden value and
 * no baseline, which is what separates it from a test suite: it holds for code
 * nobody has written yet. What it typically finds is code that assumes rows exist
 * — an unguarded `[0]`, a division by a count, a `.single()` that throws on empty
 * — which in production is the day-one bug for every new tenant.
 *
 * ## What counts as failure
 *
 *  - a 5xx. A 4xx is CORRECT here: asked for a row that does not exist, the
 *    operation should refuse, not crash. That distinction is the whole check.
 *  - a write to a table the operation does not declare.
 *  - an unfiltered UPDATE/DELETE — most dangerous precisely when the table is
 *    nearly empty and the blast radius looks small.
 *
 * Usage:
 *   bun assay/src/commands/empty-state.ts --log /tmp/fserve.log --next-log /tmp/next.log
 */

import { discover } from '../lib/db.ts'
import { requireScratch } from '../lib/guard.ts'
import { readFileSync } from 'node:fs'
import { loadRpcMap, parse, printNotCovered, summarise } from '../lib/corpus.ts'
import { loadDeclarations } from './declare.ts'

const FUNCTIONS = 'http://127.0.0.1:54321/functions/v1'
const NEXT = 'http://localhost:3000'

interface Result {
    operation: string
    status: number | string
    failures: string[]
    writes: string[]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const sizeOf = (p: string) => { try { return readFileSync(p, 'utf8').length } catch { return 0 } }
const sliceFrom = (p: string, at: number) => { try { return readFileSync(p, 'utf8').slice(at) } catch { return '' } }

async function main() {
    const args = process.argv.slice(2)
    const at = (f: string, d: string) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1] }
    const asJson = args.includes('--json')
    const fnLog = at('--log', '/tmp/fserve.log')
    const nextLog = at('--next-log', '/tmp/next.log')
    await requireScratch(at('--db', '') || discover().url || '',
        'run the empty-state sweep')

    const probes = JSON.parse(readFileSync(at('--probes', '.assay/probes.json'), 'utf8'))
    const declarations = loadDeclarations(at('--declarations', '.assay/operations.json'))
    const { map: rpcMap, loaded } = loadRpcMap(at('--rpc-map', '.assay/rpc-writes.json'))
    if (!loaded) { console.error('✗ No RPC write map — rpc writes would be invisible.'); process.exit(2) }

    const anon = readFileSync('/tmp/anon.key', 'utf8').trim()
    const tokens: Record<string, string> = {
        admin: readFileSync('/tmp/admin.jwt', 'utf8').trim(),
        service: readFileSync('/tmp/sr.key', 'utf8').trim(),
    }
    // The seeded members are not loginable, so a member-scoped probe runs as the
    // admin — who is also a member. Recorded here rather than left implicit,
    // because it means these probes do not exercise the non-admin branch.
    tokens.user = tokens.admin
    const selfId = JSON.parse(Buffer.from(tokens.admin.split('.')[1], 'base64url').toString()).sub as string

    const results: Result[] = []

    const check = (operation: string, status: number | string, logText: string): Result => {
        const summary = summarise(parse(logText), rpcMap).find(s => s.operation === operation)
        const declared = declarations.operations[operation]
        const failures: string[] = []
        if (typeof status === 'number' && status >= 500) failures.push(`${status} — crashed on a minimal database`)
        if (typeof status === 'string') failures.push(status)
        for (const t of summary?.writes ?? []) {
            if (!declared) failures.push(`writes "${t}" but has no declaration`)
            else if (!declared.writes.includes(t)) failures.push(`writes "${t}", which is not declared`)
        }
        for (const u of summary?.unfilteredWrites ?? []) failures.push(`unfiltered ${u.verb.toUpperCase()} on "${u.target}"`)
        return { operation, status, failures, writes: summary?.writes ?? [] }
    }

    // An operation may carry several probes, one per branch. The empty-state
    // obligation is about the MINIMAL-DATABASE case, so it drives the first only;
    // ledger-drive runs them all.
    for (const [fn, spec] of Object.entries(probes.edge as Record<string, any>)) {
        const probe = (Array.isArray(spec) ? spec[0] : spec) as { auth: string; body: unknown }
        const body = JSON.parse(JSON.stringify(probe.body).replace(/"SELF"/g, JSON.stringify(selfId)))
        const before = sizeOf(fnLog)
        let status: number | string
        try {
            const res = await fetch(`${FUNCTIONS}/${fn}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${tokens[probe.auth]}`, apikey: anon, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120_000),
            })
            status = res.status
        } catch (e) { status = `request failed: ${(e as Error).message}` }
        await sleep(400)   // the runtime flushes its log asynchronously
        results.push(check(fn, status, sliceFrom(fnLog, before)))
    }

    for (const [operation, probe] of Object.entries(probes.next as Record<string, { auth: string; path: string }>)) {
        const before = sizeOf(nextLog)
        let status: number | string
        try {
            const res = await fetch(`${NEXT}${probe.path}`, {
                headers: { Authorization: `Bearer ${tokens[probe.auth]}` },
                signal: AbortSignal.timeout(120_000),
            })
            status = res.status
        } catch (e) { status = `request failed: ${(e as Error).message}` }
        await sleep(300)
        results.push(check(operation, status, sliceFrom(nextLog, before)))
    }

    const failed = results.filter(r => r.failures.length)
    const declaredOps = Object.keys(declarations.operations)
    const probed = new Set(results.map(r => r.operation))
    const unprobed = declaredOps.filter(o => !probed.has(o))

    if (asJson) {
        console.log(JSON.stringify({ results, unprobed, failed: failed.length }, null, 2))
        process.exit(failed.length ? 1 : 0)
    }

    for (const r of results) {
        const mark = r.failures.length ? '✗' : '·'
        console.log(`${mark} ${String(r.status).padEnd(5)} ${r.operation}${r.writes.length ? `   writes: ${r.writes.join(', ')}` : ''}`)
        for (const f of r.failures) console.log(`      ${f}`)
    }
    console.log(`\n${results.length - failed.length}/${results.length} operations survive a minimal database.`)
    if (!failed.length) printNotCovered()
    // The remainder. An unprobed operation is unproven, not passing.
    if (unprobed.length) console.log(`· ${unprobed.length} declared operation(s) have no probe — unproven: ${unprobed.join(', ')}`)
    process.exit(failed.length ? 1 : 0)
}

main()
