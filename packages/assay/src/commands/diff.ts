#!/usr/bin/env bun
/**
 * The EFFECT DIFF: what a change did to an operation's behaviour.
 *
 *   assay drive <op> --out /tmp/before.log   # BEFORE editing
 *   ...make the change...
 *   assay drive <op> --out /tmp/after.log
 *   assay diff /tmp/before.log /tmp/after.log
 *
 * ## Why this and not just the gate
 *
 * `ledger-check` compares against the stored declaration, which answers "has this
 * drifted from what we declared?" — and inherits every gap in that declaration. A
 * before/after diff answers a different and often better question: "what did THIS
 * change do?" It needs no declaration, cannot be fooled by a stale one, and is the
 * only view that shows a change with no table-set consequence at all — the class
 * of change a declaration is structurally blind to.
 *
 * ## The ordering trap
 *
 * The baseline must be captured BEFORE the edit. An agent that edits first has
 * destroyed it, and reconstructing it by stashing is not safe when anything else
 * is touching the tree. Drive first; it costs about half a second.
 *
 * A new operation has no baseline by definition — there is nothing to diff against,
 * so its declaration-by-intent is the only reference and `ledger-check` is the tool.
 */

import { loadRpcMap, readCorpus, summarise, type OperationSummary } from '../lib/corpus.ts'

const setDiff = (a: string[], b: string[]) => ({
    added: b.filter(x => !a.includes(x)),
    removed: a.filter(x => !b.includes(x)),
})

import { isEntrypoint } from '../lib/paths.ts'

function main() {
    const args = process.argv.slice(2)
    const at = (f: string, d: string) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1] }
    const asJson = args.includes('--json')
    const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
    const [beforePath, afterPath, only] = positional
    if (!beforePath || !afterPath) {
        console.error('Usage: ledger-diff.ts <before.log> <after.log> [operation]')
        process.exit(2)
    }

    const { map } = loadRpcMap(at('--rpc-map', '.assay/rpc-writes.json'))
    const index = (path: string) => new Map(summarise(readCorpus(path), map).map(s => [s.operation, s]))
    const before = index(beforePath)
    const after = index(afterPath)

    const operations = [...new Set([...before.keys(), ...after.keys()])]
        .filter(op => !only || op === only)
        .sort()

    const changes: Array<{ operation: string; lines: string[]; significant: boolean }> = []
    for (const op of operations) {
        const a = before.get(op)
        const b = after.get(op)
        const lines: string[] = []
        let significant = false

        if (!a) { lines.push('  NEW — no baseline for this operation'); significant = true }
        else if (!b) { lines.push('  GONE — issued no statements after the change'); significant = true }
        else {
            for (const [field, key] of [['reads', 'reads'], ['writes', 'writes'], ['rpc', 'rpcs']] as const) {
                const { added, removed } = setDiff(a[key] as string[], b[key] as string[])
                // A new write or rpc changes what the operation DOES to the world.
                if (added.length && field !== 'reads') significant = true
                for (const t of added) lines.push(`  + ${field}: ${t}`)
                for (const t of removed) lines.push(`  - ${field}: ${t}`)
            }
            if (a.profile.statements !== b.profile.statements) {
                lines.push(`  ≠ statements: ${a.profile.statements} → ${b.profile.statements}`)
            }
            for (const t of new Set([...Object.keys(a.profile.rows), ...Object.keys(b.profile.rows)])) {
                const x = a.profile.rows[t] ?? '0', y = b.profile.rows[t] ?? '0'
                if (x !== y) lines.push(`  ≠ rows/${t}: ${x} → ${y}`)
            }
            if (a.serviceRole !== b.serviceRole) { lines.push(`  ! rlsBypassed: ${a.serviceRole} → ${b.serviceRole}`); significant = true }
            const caps = setDiff(a.capHits.map(h => h.target), b.capHits.map(h => h.target))
            for (const t of caps.added) { lines.push(`  ! "${t}" now returns exactly the 1000-row cap with no continuation`); significant = true }
            for (const t of caps.removed) lines.push(`  ✓ "${t}" no longer hits the cap uncontinued`)
        }
        if (lines.length) changes.push({ operation: op, lines, significant })
    }

    if (asJson) {
        console.log(JSON.stringify({ changes, operations: operations.length }, null, 2))
        return
    }

    if (!changes.length) {
        console.log(`No effect change across ${operations.length} operation(s).`)
        console.log('  The operation touches the same tables, in the same magnitudes. That does NOT')
        console.log('  mean the behaviour is unchanged — a value computed differently looks identical here.')
        return
    }
    for (const c of changes) {
        console.log(`${c.significant ? '!' : '·'} ${c.operation}`)
        for (const l of c.lines) console.log(l)
    }
    const sig = changes.filter(c => c.significant).length
    console.log(`\n${changes.length} operation(s) changed effect; ${sig} significantly (new write, rpc, RLS or cap-hit).`)
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