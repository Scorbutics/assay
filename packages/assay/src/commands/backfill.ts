#!/usr/bin/env bun
/**
 * Derive shapes for a node from data that ALREADY exists in the database.
 *
 * This is the cheapest capture there is: no recorder to deploy, no new copy of
 * anyone's personal data, no waiting for traffic. peps persists provider events
 * in `payments.payload` for operational reasons, so the fixtures for every
 * inbound node are sitting in a column that is already backed up and already
 * covered by whatever deletion policy applies to the row.
 *
 * Only SHAPES are written out — field paths and types. Nothing derived here can
 * carry a value, so the output is safe to commit and to diff in a review.
 *
 *   assay backfill                    # every node with a source
 *   assay backfill wix.order.inbound
 *   assay backfill --json
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { discover } from '../lib/db.ts'
import { deriveShape, diffShape } from '@scorbutics/assay-seam/shape'
import { loadNodes, type SeamNode } from './nodes.ts'
import { projectRoot } from '../lib/paths.ts'

const ROOT = projectRoot()
const SHAPES = join(ROOT, '.assay/shapes')
const SAMPLE = 200

async function backfill(id: string, node: SeamNode, client: Client) {
    if (!node.source) return { id, skipped: 'no source (an outbound node is recorded live, not backfilled)' }
    const { table, column, where } = node.source
    const sql = `select "${column}" as v from public."${table}"` +
        (where ? ` where ${where}` : '') +
        ` where_placeholder limit ${SAMPLE}`
    const query = sql.replace(' where_placeholder', '')
    const { rows } = await client.query<{ v: unknown }>(query)

    // Union across rows: one payment does not show the optional fields another
    // carries, and a shape built from a single row reads as "the provider does
    // not send that" when it simply was not present that time.
    const union = new Set<string>()
    let sampled = 0
    for (const r of rows) {
        if (r.v === null || r.v === undefined) continue
        sampled++
        for (const p of deriveShape(r.v)) union.add(p)
    }
    const shape = [...union].sort()

    const out = join(SHAPES, `${id}.json`)
    const previous = existsSync(out)
        ? (JSON.parse(readFileSync(out, 'utf8')) as { shape: string[] }).shape
        : null
    const drift = previous ? diffShape(previous, shape) : null

    mkdirSync(SHAPES, { recursive: true })
    writeFileSync(out, JSON.stringify({
        node: id, source: node.source, sampled, derivedFrom: 'backfill',
        // No values, ever — see lib/ledger-shape.ts.
        shape,
    }, null, 2) + '\n')

    return { id, sampled, fields: shape.length, drift }
}

async function main() {
    const args = process.argv.slice(2)
    const asJson = args.includes('--json')
    const only = args.find(a => !a.startsWith('--'))
    const nodes = loadNodes()

    const url = discover().url
    if (!url) {
        console.error('assay: no database reachable — backfill reads from live tables.')
        process.exit(2)
    }
    const client = new Client({ connectionString: url })
    await client.connect()

    const results = []
    try {
        for (const [id, node] of Object.entries(nodes)) {
            if (only && id !== only) continue
            if (!node.source) continue
            // record=none means the node is declared but deliberately not
            // captured; backfilling it anyway writes an empty shape file that
            // then reads as "captured" in the coverage report.
            if (node.record === 'none') continue
            results.push(await backfill(id, node, client))
        }
    } finally { await client.end() }

    if (asJson) { console.log(JSON.stringify(results, null, 2)); return }

    for (const r of results as Array<Record<string, any>>) {
        if (r.skipped) { console.log(`· ${r.id}: ${r.skipped}`); continue }
        // Say so loudly: a zero-field shape means the source had no usable rows,
        // not that the provider sends nothing.
        const mark = r.fields === 0 ? '○' : '✓'
        console.log(`${mark} ${r.id}: ${r.fields} field(s) from ${r.sampled} row(s)` +
            (r.fields === 0 ? '  ← nothing derived; source empty or not structured' : ''))
        if (r.drift && (r.drift.added.length || r.drift.removed.length || r.drift.retyped.length)) {
            // A provider adding a field is additive; removing or retyping one is
            // the breakage this artifact exists to catch.
            for (const p of r.drift.added) console.log(`    + ${p}`)
            for (const p of r.drift.removed) console.log(`    - ${p}   ← disappeared`)
            for (const t of r.drift.retyped) console.log(`    ≠ ${t.path}: ${t.from} → ${t.to}   ← retyped`)
        }
    }
    if (!results.length) console.log('No node declares a `source`. Outbound nodes are recorded live, not backfilled.')
}

main()
