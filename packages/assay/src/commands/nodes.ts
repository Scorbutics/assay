#!/usr/bin/env bun
/**
 * The seam-node registry: what assay can capture or answer, and how much of it
 * actually exists.
 *
 * The number this exists to print is how many nodes are still HAND-WRITTEN. A
 * hand-written cassette that is never replaced by a real recording is a fiction
 * the suite treats as evidence — the "third copy nobody diffs" — and the only
 * defence is making the ratio visible on every run.
 *
 * Usage: assay nodes [--json]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectRoot } from '../lib/paths.ts'

const ROOT = projectRoot()
const SHAPES = join(ROOT, '.assay/shapes')
/** Column names that usually hold rendered output rather than structured data. */
const TEXTY = /^(html|body|content|text|markdown|rendered)$/i

export interface SeamNode {
    kind: 'inbound' | 'outbound' | 'terminal'
    why: string
    source?: { table: string; column: string; where?: string }
    match?: { method: string; host: string; path: string }
    record: 'none' | 'shape' | 'fixture'
    keep?: string[]
    provenance: 'handwritten' | 'recorded'
    /**
     * Whether the call is performed at all — orthogonal to `record`, which only
     * says what to keep from a call that WAS performed.
     *
     *   none    perform normally
     *   store   do not perform; persist the request into a table the app owns
     *   replay  do not perform; return `fixture` instead
     *
     * These are the two behaviours peps had hand-rolled: MAILER_DRIVER=preview is
     * `store`, WIX_FAKE_CONTACTS is `replay` with an invented fixture.
     */
    intercept?: 'none' | 'store' | 'replay'
    /** Node is inert outside `withInterceptScope(scope, ...)`. */
    scope?: string
    /** replay: the response handed back. Values, so provenance matters. */
    fixture?: { status?: number; body: unknown }
    /** store: the app-owned table assay fills. assay must not own the schema. */
    sink?: { table: string; column: string; extra?: Record<string, string> }
}

export function loadNodes(path = '.assay/nodes.json'): Record<string, SeamNode> {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8')).nodes as Record<string, SeamNode>
}

/**
 * A node counts as captured only when its shape has FIELDS in it.
 *
 * Existence of the file is not enough: backfilling a node whose source table is
 * empty writes `shape: []`, which then reads as captured in every count. An
 * empty artifact that reads as evidence is the failure this whole tool is about.
 */
export function captured(id: string): boolean {
    const path = join(SHAPES, `${id}.json`)
    if (!existsSync(path)) return false
    try {
        return (JSON.parse(readFileSync(path, 'utf8')) as { shape?: string[] }).shape?.length ? true : false
    } catch { return false }
}

function validate(id: string, node: SeamNode): string[] {
    const problems: string[] = []
    if (node.record === 'fixture' && !node.keep?.length) {
        // Enabling fixture capture without naming the allowlist is how a payload
        // you do not control ends up recorded in full.
        problems.push('record=fixture with no `keep` allowlist')
    }
    if (node.kind === 'outbound' && !node.match) problems.push('outbound node with no `match` — replay cannot address it')
    if (node.kind !== 'outbound' && !node.source) problems.push(`${node.kind} node with no \`source\` — nothing says where its data lives`)
    if (node.source && node.match && !node.intercept) {
        problems.push('has both `source` and `match`; a node is one or the other unless it intercepts')
    }
    if (node.intercept === 'replay' && !node.fixture) {
        problems.push('intercept=replay with no `fixture` — nothing to hand back')
    }
    if (node.intercept === 'store' && !node.sink) {
        problems.push('intercept=store with no `sink` — nowhere to persist')
    }
    if (node.intercept && node.intercept !== 'none' && node.record === 'fixture') {
        // Capturing a replayed response records your own fixture back over itself,
        // and each round trip would look like fresh evidence.
        problems.push('intercept and record=fixture together: the capture would record its own fixture')
    }
    if (node.source && node.record === 'shape' && TEXTY.test(node.source.column)) {
        // `email_previews.html` is a RENDERED body: shape derivation over text
        // yields nothing, so the node reads as captured while holding no fields.
        // Source the structured input instead.
        problems.push(`source column "${node.source.column}" looks like rendered text — a shape derived from it will be empty; source the structured input`)
    }
    return problems
}

function main() {
    const nodes = loadNodes()
    const asJson = process.argv.includes('--json')
    const rows = Object.entries(nodes).map(([id, n]) => ({
        id, kind: n.kind, record: n.record, provenance: n.provenance, intercept: n.intercept,
        captured: captured(id), problems: validate(id, n),
    }))

    const broken = rows.filter(r => r.problems.length)
    const handwritten = rows.filter(r => r.provenance === 'handwritten')
    const uncaptured = rows.filter(r => r.record !== 'none' && !r.captured)

    if (asJson) {
        console.log(JSON.stringify({ rows, handwritten: handwritten.map(r => r.id), uncaptured: uncaptured.map(r => r.id) }, null, 2))
        process.exit(broken.length ? 1 : 0)
    }

    for (const kind of ['inbound', 'outbound', 'terminal'] as const) {
        const of = rows.filter(r => r.kind === kind)
        if (!of.length) continue
        console.log(`\n${kind}`)
        for (const r of of) {
            const mark = r.record === 'none' ? '·' : r.captured ? '✓' : '○'
            const icept = r.intercept && r.intercept !== 'none' ? `  intercept=${r.intercept}` : ''
            console.log(`  ${mark} ${r.id.padEnd(34)} record=${r.record.padEnd(7)} ${r.provenance}${icept}`)
            for (const p of r.problems) console.log(`      ✗ ${p}`)
        }
    }

    console.log(`\n${rows.length} node(s): ${rows.filter(r => r.captured).length} captured, ${uncaptured.length} declared but empty.`)
    if (handwritten.length) {
        console.log(`  ⚠ ${handwritten.length} still HAND-WRITTEN — invented data, not evidence:`)
        console.log(`      ${handwritten.map(r => r.id).join(', ')}`)
        console.log(`  Each is replaced the first time real traffic hits it. Diff the recording`)
        console.log(`  against the guess when it lands — that is a free check on your model.`)
    }
    if (broken.length) console.log(`\n${broken.length} node(s) are misdeclared.`)
    process.exit(broken.length ? 1 : 0)
}

// `import.meta.main` is a Deno/Bun extension the TypeScript DOM lib does not
// declare, and this package is type-checked by both. The cast keeps the guard
// without pulling in a runtime-specific type reference.
if ((import.meta as { main?: boolean }).main) main()
