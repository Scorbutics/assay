#!/usr/bin/env bun
/**
 * Three-way coherence check: EXPECTED vs OBSERVED vs STATIC.
 *
 * This is the declare-first path made checkable. `.assay/expected.json` says what
 * an operation SHOULD touch, reasoning from the product. assay's declaration says
 * what it was seen doing. The static crawl says what its code can reach.
 *
 * Each disagreement means something different, and the point is to keep them apart
 * rather than collapse them into one "diff":
 *
 *   in STATIC, not EXPECTED   the operation reaches further than its purpose
 *                             implies — a boundary question, or my expectation
 *                             was naive
 *   in EXPECTED, not STATIC   the code cannot do what the product implies it does
 *   in STATIC, not OBSERVED   a branch no probe reaches — a coverage hole
 *   mustNotWrite hit          the strongest signal: the operation writes something
 *                             its purpose says it has no business writing
 *
 * Static over-reports (it sees every branch, and follows helpers that may be used
 * conditionally); observed under-reports. Neither is truth. Read the disagreement.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { loadRpcMap } from '../lib/corpus.ts'
import { commandPath, projectRoot } from '../lib/paths.ts'

const ROOT = projectRoot()

interface Expectation {
    clean?: boolean
    why: string
    reads: string[]
    writes: string[]
    mustNotWrite: string[]
}

const load = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))
const minus = (a: string[], b: string[]) => a.filter(x => !b.includes(x))

function main() {
    const expected = load('.assay/expected.json').operations as Record<string, Expectation>
    const declared = load('.assay/operations.json').operations as Record<string, { reads: string[]; writes: string[]; rpc: string[] }>
    const staticFootprint = JSON.parse(
        execFileSync('bun', [commandPath('static'), '--json'], { encoding: 'utf8' }),
    ) as Record<string, { tables: string[]; writes: string[] }>
    const { map: rpcMap } = loadRpcMap(join(ROOT, '.assay/rpc-writes.json'))

    let violations = 0
    for (const [op, want] of Object.entries(expected)) {
        const obs = declared[op]
        const stat = staticFootprint[op]?.tables ?? []
        const staticWrites = staticFootprint[op]?.writes ?? []
        // A name in the static crawl that is a Postgres function, not a table.
        const staticTables = stat.filter(t => !(t in rpcMap))
        const staticRpcWrites = stat.filter(t => t in rpcMap).flatMap(fn => rpcMap[fn])
        const reachable = [...new Set([...staticTables, ...staticRpcWrites])].sort()

        const wantAll = [...new Set([...want.reads, ...want.writes])].sort()
        const beyond = minus(reachable, wantAll)
        const unreachable = minus(wantAll, reachable)
        const unobserved = obs ? minus(reachable, [...obs.reads, ...obs.writes]) : reachable
        // mustNotWrite is checked against what the code can WRITE: direct writes are
        // not distinguishable statically, so this uses rpc-resolved writes plus any
        // observed write. Conservative on purpose — a hit here is worth a look.
        // Checked against every write the code CAN do, not just those observed. The
        // observed-only version passed complete-mission's `subscriptions` upsert,
        // which is four lines of plain source, because no probe reached that branch.
        const canWrite = [...new Set([...(obs?.writes ?? []), ...staticWrites, ...staticRpcWrites])]
        const forbidden = want.mustNotWrite.filter(t => canWrite.includes(t))

        console.log(`\n▸ ${op}${want.clean ? '   [uncontaminated expectation]' : ''}`)
        console.log(`    expected: ${want.why}`)
        if (forbidden.length) {
            violations++
            console.log(`    ✗ WRITES WHAT IT MUST NOT: ${forbidden.join(', ')}`)
        }
        if (beyond.length) console.log(`    ? reaches beyond expectation: ${beyond.join(', ')}`)
        if (unreachable.length) console.log(`    ? expected but NOT reachable in code: ${unreachable.join(', ')}`)
        if (obs && unobserved.length) console.log(`    · in code, never observed: ${unobserved.join(', ')}`)
        if (!obs) console.log(`    · no observation at all — never driven`)
        const undeclaredWrite = staticWrites.filter(t => obs && !obs.writes.includes(t))
        if (undeclaredWrite.length) console.log(`    ! writes in code but NOT declared: ${undeclaredWrite.join(', ')}`)
        if (!forbidden.length && !beyond.length && !unreachable.length && !undeclaredWrite.length) console.log(`    ✓ coherent`)
    }
    console.log(`\n${violations} operation(s) write something their purpose forbids.`)
}

main()
