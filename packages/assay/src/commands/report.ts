#!/usr/bin/env bun
/**
 * Turns a corpus of ledger lines into the two artifacts the DB seam exists to
 * produce (see backend/supabase/functions/_shared/ledger.ts):
 *
 *   1. The READ SET and WRITE SET of each operation — its real blast radius.
 *   2. The BASIN GRAPH — which operations couple, because one writes a table
 *      another reads. That edge is invisible in a git diff and is the reason a
 *      three-line change to a shared service is not safe.
 *
 * Usage:
 *   bun assay/src/commands/report.ts < ledger.log
 *   supabase functions logs | bun assay/src/commands/report.ts
 *   bun assay/src/commands/report.ts --json < ledger.log
 *
 * COVERAGE IS PART OF THE OUTPUT, not a footnote. An operation with no ledger
 * lines is not an operation with no effects — it is one nobody has exercised,
 * and a report that quietly omits it reads as "all clear". Every section that
 * can be incomplete says how incomplete it is.
 */

import {
    basins, declaredOperations, fanOut, loadRpcMap, malformedCount, printNotCovered, readCorpus, summarise,
} from '../lib/corpus.ts'

function main() {
    const args = process.argv.slice(2)
    const asJson = args.includes('--json')
    const rpcMapAt = args.indexOf('--rpc-map')
    const rpcMapPath = rpcMapAt === -1 ? '.assay/rpc-writes.json' : args[rpcMapAt + 1]
    // Absent map: rpc writes stay invisible. Said out loud below, never assumed away.
    const { map: rpcMap, loaded: rpcMapLoaded } = loadRpcMap(rpcMapPath)
    const file = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--rpc-map')[0]

    const entries = readCorpus(file)
    const summaries = summarise(entries, rpcMap)
    const observed = new Set(summaries.map(s => s.operation))
    const declared = declaredOperations()
    const unexercised = declared.filter(o => !observed.has(o))
    const unattributed = summaries.find(s => s.operation === 'unattributed')
    const edges = basins(summaries)
    const hotspots = fanOut(summaries)

    if (asJson) {
        console.log(JSON.stringify({
            operations: summaries, edges, hotspots,
            coverage: { declared: declared.length, observed: observed.size, unexercised, rpcMapLoaded },
            malformedLines: malformedCount(),
        }, null, 2))
        return
    }

    if (!entries.length) {
        console.log('No ledger lines found. Exercise the app with the seam installed, then pipe its output here.')
        process.exit(1)
    }

    console.log(`\n═══ LEDGER — ${entries.length} statements, ${summaries.length} operations ═══\n`)

    for (const s of summaries) {
        const rls = s.serviceRole ? '  [RLS BYPASSED]' : ''
        console.log(`▸ ${s.operation}${rls}   ${s.statements} statements`)
        if (s.reads.length) console.log(`    reads   ${s.reads.join(', ')}`)
        if (s.writes.length) {
            const annotated = s.writes.map(t => (s.writesViaRpc.includes(t) ? `${t} (via rpc)` : t))
            console.log(`    writes  ${annotated.join(', ')}`)
        }
        if (s.rpcs.length) console.log(`    rpc     ${s.rpcs.join(', ')}`)
        for (const c of s.calls) console.log(`    calls   ${c}`)
        const rows = Object.entries(s.profile.rows)
        if (rows.length) console.log(`    volume  ${s.profile.statements} statements; ${rows.map(([t, b]) => `${t} ${b}`).join(', ')}`)
        for (const h of s.capHits) console.log(`    ⚠ "${h.target}" returned exactly the 1000-row cap with NO continuation — suspected silent truncation`)
        for (const u of s.unfilteredWrites) console.log(`    ⚠ UNFILTERED ${u.verb.toUpperCase()} on ${u.target}`)
        for (const e of s.errors) console.log(`    ✗ ${e}`)
        console.log()
    }

    console.log('═══ BASINS — A writes what B reads ═══\n')
    if (!edges.length) console.log('  (no coupling observed — likely too few operations exercised)\n')
    for (const e of edges) console.log(`  ${e.from}  →  ${e.to}      via ${e.via.join(', ')}`)

    console.log('\n═══ HOTSPOTS — the hairball check ═══\n')
    for (const h of hotspots.slice(0, 12)) {
        console.log(`  ${String(h.readers).padStart(3)} readers  ${String(h.writers).padStart(3)} writers   ${h.table}`)
    }

    // The remainder. A parts list reads as a partition unless the gap is named.
    console.log('\n═══ WHAT THIS REPORT DOES NOT COVER ═══\n')
    console.log(`  Edge functions never exercised: ${unexercised.length}/${declared.length}`)
    if (unexercised.length) console.log(`    ${unexercised.join(', ')}`)
    if (unattributed) {
        console.log(`  Unattributed statements: ${unattributed.statements} (Next.js callers that passed no operation label)`)
    }
    if (malformedCount()) console.log(`  Malformed log lines skipped: ${malformedCount()}`)
    if (!rpcMapLoaded) {
        console.log(`  ⚠ No RPC write map at ${rpcMapPath} — every write done inside a Postgres`)
        console.log('    function is MISSING from the write sets above. Build it with:')
        console.log('      bun assay/src/commands/rpc-map.ts > .assay/rpc-writes.json')
    }
    printNotCovered()
}

main()
