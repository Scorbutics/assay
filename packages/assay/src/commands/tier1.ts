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
 * Usage: assay tier1 [--json]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../lib/db.ts'
import { loadRpcMap } from '../lib/corpus.ts'
import { captured, loadNodes } from './nodes.ts'
import { commandPath, projectRoot, isEntrypoint } from '../lib/paths.ts'

const ROOT = projectRoot()
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

interface Issue {
    severity: 'error' | 'warn'
    operation: string
    /** The CLASS of finding. Readers group by it — 26 findings of one kind is one
     *  fact about the project, and printing it 26 times is how a report becomes a log. */
    kind: 'undeclared-operation' | 'no-probe' | 'undeclared-static-write'
    /** What the finding is ABOUT (a table, usually), so a reader can fold by
     *  operation without parsing it back out of the prose. */
    subject?: string
    detail: string
    remedy: string
}

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

    // NOTHING ON DISK IS NOT A CLEAN RUN. Every loop below iterates `onDisk`, so an
    // empty list makes each of them vacuous and the tier reports `0 error(s)` over a
    // project it never read. It happened: `backend/` is a git SUBMODULE, a plain
    // `git clone` without `--recursive` leaves it empty, `declaredOperations()`
    // swallows the ENOENT and returns [] — and tier 1 printed
    // "0 operations on disk, 59 declared, 0 error(s)" and exited 0.
    //
    // Exit 2, not 1: the declarations are not contradicted, the checkout is
    // incomplete. That is an environment fault to retry, never a finding to repair.
    if (onDisk.length === 0 && Object.keys(declarations).length > 0) {
        console.error(`✗ ${Object.keys(declarations).length} operation(s) are declared and NONE was found on disk.`)
        console.error('  Every check in tier 1 iterates the operations on disk, so this run examined')
        console.error('  nothing — which is not the same as finding nothing.')
        console.error('  Usually an unchecked-out submodule: git submodule update --init --recursive')
        process.exit(2)
    }

    let staticFootprint: Record<string, { tables: string[]; writes: string[] }> = {}
    let staticCrawlFailed = ''
    try {
        staticFootprint = JSON.parse(
            execFileSync('bun', [commandPath('static'), '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (e) {
        // SAID, not swallowed. The comment here used to claim the absence was
        // "reported below", and it was not: with no static footprint the loop that
        // would have reported it has nothing to compare, so the crawl could crash
        // outright and the tier still printed a clean summary.
        staticCrawlFailed = String((e as { message?: string }).message ?? e).split('\n')[0]
    }

    const issues: Issue[] = []

    for (const op of onDisk) {
        if (!declarations[op]) {
            issues.push({
                severity: 'error', operation: op, kind: 'undeclared-operation',
                detail: 'exists on disk but has no declaration',
                remedy: 'Declare its boundary, then drive it: bun run assay:drive ' + op,
            })
            continue
        }
        if (!probed.has(op)) {
            issues.push({
                severity: 'warn', operation: op, kind: 'no-probe',
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
                    severity: 'warn', operation: op, kind: 'undeclared-static-write', subject: t,
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
            unprobed: onDisk.filter(o => declarations[o] && !probed.has(o)), neverObserved, staticCrawlFailed }, null, 2))
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
    if (staticCrawlFailed) {
        console.log(`  ! the static crawl did not run (${staticCrawlFailed}) — the footprint`)
        console.log('    comparison below it was skipped, so this run proves less than a clean one.')
    }
    // The line this tier exists to print.
    console.log(`  Tier 2 coverage: ${unprobed} operation(s) have no probe; ` +
        `${neverObserved.length} declaration(s) have never been observed.`)
    if (nodeLine) console.log(nodeLine)
    console.log(`  Tier 1 is STATIC. It says nothing about what the code does at runtime —`)
    console.log(`  run \`bun run assay:verify\` for that.`)
    process.exit(errors.length ? 1 : 0)
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