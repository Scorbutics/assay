#!/usr/bin/env bun
/**
 * Collect captured shapes out of a runtime log and file them against nodes.
 *
 * The seam emits `@assay-shape {…}` lines rather than writing files, because it
 * runs inside the Edge runtime container and cannot reach the project. This is
 * the host side of that: match each line to a declared outbound node, union the
 * shapes across observations, and write `.assay/shapes/<node>.json`.
 *
 * Nothing here carries a value — the seam derived paths and types before the
 * line ever left the container.
 *
 *   bun assay/src/cli.ts capture /tmp/fserve.log
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assayPath, isEntrypoint } from '../lib/paths.ts'
import { diffShape } from '@scorbutics/assay-seam/shape'
import { loadNodes, type SeamNode } from './nodes.ts'

const TAG = '@assay-shape'

interface Captured { target: string; status: number | null; request: string[]; response: string[] }

/** `METHOD host/path` against a node's declared match, with {id} already normalised. */
function matches(target: string, node: SeamNode): boolean {
    if (!node.match) return false
    const want = `${node.match.method} ${node.match.host}${node.match.path}`
    return target === want
}

function main() {
    const args = process.argv.slice(2)
    const file = args.find(a => !a.startsWith('--'))
    if (!file) { console.error('Usage: assay capture <runtime.log>'); process.exit(2) }

    const lines = readFileSync(file, 'utf8').split('\n')
        .filter(l => l.includes(TAG))
        .map(l => { try { return JSON.parse(l.slice(l.indexOf(TAG) + TAG.length)) as Captured } catch { return null } })
        .filter((x): x is Captured => x !== null)

    if (!lines.length) {
        // Absence is the thing to be loud about: a capture run that files nothing
        // looks identical to one that had nothing to file.
        console.error(`✗ No ${TAG} lines in ${file}.`)
        console.error('  The seam emits them only with ASSAY_CAPTURE=shape set on the runtime.')
        console.error('  Check that the operation actually reached a third party — a local')
        console.error('  short-circuit (WIX_FAKE_CONTACTS=true) means the call never happens.')
        process.exit(1)
    }

    const nodes = Object.entries(loadNodes())
    const filed: Record<string, { request: Set<string>; response: Set<string>; seen: number }> = {}
    const unmatched: string[] = []

    for (const cap of lines) {
        const hit = nodes.find(([, n]) => matches(cap.target, n))
        if (!hit) { if (!unmatched.includes(cap.target)) unmatched.push(cap.target); continue }
        const [id] = hit
        const acc = filed[id] ??= { request: new Set(), response: new Set(), seen: 0 }
        acc.seen++
        cap.request.forEach(p => acc.request.add(p))
        cap.response.forEach(p => acc.response.add(p))
    }

    const dir = assayPath('shapes')
    mkdirSync(dir, { recursive: true })
    for (const [id, acc] of Object.entries(filed)) {
        const out = join(dir, `${id}.json`)
        const previous = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { shape?: string[] }).shape ?? [] : null
        const shape = [...acc.response].sort()
        writeFileSync(out, JSON.stringify({
            node: id, derivedFrom: 'capture', observations: acc.seen,
            requestShape: [...acc.request].sort(),
            shape,
        }, null, 2) + '\n')
        console.log(`✓ ${id}: ${shape.length} response field(s) from ${acc.seen} observation(s)`)
        if (previous) {
            const d = diffShape(previous, shape)
            // A hand-written guess replaced by a recording: this diff is the point.
            for (const p of d.added) console.log(`    + ${p}`)
            for (const p of d.removed) console.log(`    - ${p}   ← was expected, not sent`)
            for (const t of d.retyped) console.log(`    ≠ ${t.path}: ${t.from} → ${t.to}`)
        }
    }
    if (unmatched.length) {
        console.log(`\n· ${unmatched.length} captured target(s) match no declared node:`)
        for (const t of unmatched) console.log(`    ${t}`)
        console.log('  Declare them in .assay/nodes.json, or they stay uncaptured.')
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