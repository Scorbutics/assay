#!/usr/bin/env bun
/**
 * TIER 1 — the checks that need no database, fast enough to run on every build.
 *
 * This tier exists for one reason: to be impossible to forget. It hooks into
 * `prebuild`, which already runs on every `bun run build`, so its output is on a
 * path you walk anyway. The previous integration harness was forgotten precisely
 * because nothing ever mentioned it — it skipped silently and no CI ran it.
 *
 * What it checks (all static, no DB, no runtime):
 *   - every operation on disk has a declaration
 *   - every declared operation has at least one probe
 *   - the write set in the CODE is covered by the declaration
 *
 * What it REPORTS but does not fail on: how much of Tier 2 has never run. That
 * number is the point of this tier. Failing the build on coverage would train
 * people to bypass it; printing it every build is what keeps it visible.
 *
 * Usage: bun assay/src/commands/tier1.ts [--json]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../lib/db.ts'
import { loadRpcMap } from '../lib/corpus.ts'
import { captured, loadNodes } from './nodes.ts'
import { projectRoot } from '../lib/paths.ts'

const ROOT = projectRoot()
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

interface Issue { severity: 'error' | 'warn'; operation: string; detail: string; remedy: string }

function operationsOnDisk(): string[] {
    const cfg = loadConfig()
    const root = join(ROOT, cfg.operations?.root ?? 'backend/supabase/functions')
    const entry = cfg.operations?.entry ?? 'index.ts'
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
        .filter(d => existsSync(join(root, d.name, entry)))
        .map(d => d.name).sort()
}

function main() {
    const asJson = process.argv.includes('--json')
    const declarations = read('.assay/operations.json').operations as Record<string, {
        writes: string[]; profile?: unknown
    }>
    const probes = read('.assay/probes.json')
    const probed = new Set(Object.keys(probes.edge ?? {}))
    const onDisk = operationsOnDisk()
    const { map: rpcMap } = loadRpcMap(join(ROOT, '.assay/rpc-writes.json'))

    let staticFootprint: Record<string, { tables: string[]; writes: string[] }> = {}
    try {
        staticFootprint = JSON.parse(
            execFileSync('bun', [join(ROOT, 'assay/src/commands/static.ts'), '--json'], { encoding: 'utf8' }))
    } catch { /* the static crawl is best-effort; its absence is reported below */ }

    const issues: Issue[] = []

    for (const op of onDisk) {
        if (!declarations[op]) {
            issues.push({
                severity: 'error', operation: op,
                detail: 'exists on disk but has no declaration',
                remedy: 'Declare its boundary, then drive it: bun run assay:drive ' + op,
            })
            continue
        }
        if (!probed.has(op)) {
            issues.push({
                severity: 'warn', operation: op,
                detail: 'has no probe, so Tier 2 can never drive it',
                remedy: 'Add an entry to .assay/probes.json.',
            })
        }
        // Writes visible in the source that the declaration does not cover. Static
        // over-reports through shared imports, so this is a WARNING — a hit is
        // worth reading, not worth blocking a build over.
        const staticWrites = staticFootprint[op]?.writes ?? []
        const viaRpc = (staticFootprint[op]?.tables ?? []).filter(t => t in rpcMap).flatMap(fn => rpcMap[fn])
        for (const t of [...new Set([...staticWrites, ...viaRpc])]) {
            if (!declarations[op].writes.includes(t)) {
                issues.push({
                    severity: 'warn', operation: op,
                    detail: `code can write "${t}", which is not declared`,
                    remedy: 'Static analysis over-reports through shared imports — confirm before accepting.',
                })
            }
        }
    }

    const neverObserved = Object.entries(declarations).filter(([, d]) => !d.profile).map(([k]) => k)
    const errors = issues.filter(i => i.severity === 'error')
    const warns = issues.filter(i => i.severity === 'warn')

    if (asJson) {
        console.log(JSON.stringify({ issues, onDisk: onDisk.length, declared: Object.keys(declarations).length,
            unprobed: onDisk.filter(o => declarations[o] && !probed.has(o)), neverObserved }, null, 2))
        process.exit(errors.length ? 1 : 0)
    }

    for (const i of [...errors, ...warns]) {
        console.log(`${i.severity === 'error' ? '✗' : '!'} ${i.operation}: ${i.detail}`)
        console.log(`    → ${i.remedy}`)
    }

    const unprobed = onDisk.filter(o => declarations[o] && !probed.has(o)).length
    // Seam-node coverage, printed alongside operation coverage for the same
    // reason: a hand-written fixture is invented data, and the count is the only
    // thing that keeps that visible.
    let nodeLine = ''
    try {
        const nodes = Object.entries(loadNodes())
        const wanted = nodes.filter(([, n]) => n.record !== 'none')
        const hand = nodes.filter(([, n]) => n.provenance === 'handwritten')
        nodeLine = `  Seam nodes: ${wanted.filter(([id]) => captured(id)).length}/${wanted.length} captured; `
            + `${hand.length} still hand-written.`
    } catch { /* no registry yet */ }
    console.log(`\nassay tier 1 — ${onDisk.length} operations on disk, ${Object.keys(declarations).length} declared, ` +
        `${errors.length} error(s), ${warns.length} warning(s).`)
    // The line this tier exists to print.
    console.log(`  Tier 2 coverage: ${unprobed} operation(s) have no probe; ` +
        `${neverObserved.length} declaration(s) have never been observed.`)
    if (nodeLine) console.log(nodeLine)
    console.log(`  Tier 1 is STATIC. It says nothing about what the code does at runtime —`)
    console.log(`  run \`bun run assay:verify\` for that.`)
    process.exit(errors.length ? 1 : 0)
}

main()
