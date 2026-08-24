#!/usr/bin/env bun
/**
 * Serialise intercept policy for the runtime.
 *
 * The registry lives in `.assay/nodes.json`, which the Edge runtime container
 * cannot read — so the policy crosses the boundary as an env var. Only nodes
 * that actually intercept are included: a declaration the seam never acts on has
 * no business being shipped into the runtime.
 *
 *   bun assay/src/cli.ts intercept                 # human-readable summary
 *   bun assay/src/cli.ts intercept --env >> .env   # ASSAY_NODES=... for the runtime
 */

import { loadNodes } from './nodes.ts'

const nodes = Object.entries(loadNodes())
    .filter(([, n]) => n.intercept && n.intercept !== 'none')
    .map(([id, n]) => ({
        id,
        target: n.match ? `${n.match.method} ${n.match.host}${n.match.path}` : '',
        intercept: n.intercept,
        ...(n.fixture ? { body: n.fixture.body, status: n.fixture.status } : {}),
        ...(n.sink ? { sink: n.sink } : {}),
    }))

if (process.argv.includes('--env')) {
    // One line, so it can be appended to an env file directly.
    console.log(`ASSAY_NODES=${JSON.stringify(nodes)}`)
} else {
    if (!nodes.length) {
        console.log('No node declares an intercept policy. Nothing would be substituted.')
    }
    for (const n of nodes) {
        console.log(`  ${(n.intercept ?? 'none').padEnd(6)} ${n.id}`)
        console.log(`         ${n.target || '(no match — it will never fire)'}`)
        if (n.sink) console.log(`         → ${n.sink.table}.${n.sink.column}`)
    }
    console.log(`\n${nodes.length} node(s) would be intercepted. The call is NOT made for any of them.`)
    console.log('Ship with --env; never set ASSAY_NODES in production.')
}
