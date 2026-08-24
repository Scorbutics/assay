#!/usr/bin/env bun
/**
 * assay — determine what a backend operation ACTUALLY touches, and fail when it
 * differs from what was declared.
 *
 * An assay determines a sample's real composition rather than its claimed one.
 * That is the whole tool: a seam records what an operation did, a declaration
 * says what it may do, and the gate fails on the difference.
 *
 * Every command is also runnable directly (`bun assay/src/commands/check.ts`);
 * this dispatcher exists so the package has one entry point when it moves out of
 * this repo.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectRoot } from './lib/paths.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMMANDS = join(HERE, 'commands')

/** One line each, so `assay` with no argument is a usable index. */
const SUMMARY: Record<string, string> = {
    'drive':       'drive an operation and capture its ledger',
    'check':       'gate a corpus against the declarations (exits 1 on drift)',
    'declare':     'propose declarations from a corpus; the diff is the review surface',
    'diff':        'what a change did: baseline corpus vs after',
    'report':      'read/write sets, coupling basins, volume, cap-hits',
    'invariants':  'properties that hold for every input, ratcheted',
    'verify':      'tier 2: drive, gate, invariants (needs a database)',
    'tier1':       'tier 1: static checks, no database, runs on every build',
    'empty-state': 'every operation against a minimal database',
    'expect':      'coherence: expected vs observed vs static',
    'static':      'the static footprint of each operation',
    'nodes':       'seam-node registry and how much of it is hand-written',
    'backfill':    'derive shapes from a column that already exists',
    'capture':     'file captured shapes from a runtime log against nodes',
    'intercept':   'serialise intercept policy for the runtime (store/replay)',
    'rpc-map':     'resolve what Postgres functions write',
    'scratch':     'point the data plane at a throwaway clone',
    'mark':        'mark a database disposable',
    'sync-seam':   'regenerate the vendored seam for runtimes that cannot import assay',
}

const available = () => readdirSync(COMMANDS).filter(f => f.endsWith('.ts')).map(f => f.slice(0, -3)).sort()

const [command, ...rest] = process.argv.slice(2)

if (!command || command === '--help' || command === '-h') {
    console.log('assay — what a backend operation actually touches\n')
    for (const name of available()) {
        console.log(`  ${name.padEnd(13)} ${SUMMARY[name] ?? ''}`)
    }
    console.log('\nA clean run means nothing was found IN THE CATEGORIES ASSAY COVERS.')
    console.log('It does not check values, trigger writes, which rows changed, or concurrency.')
    process.exit(command ? 0 : 1)
}

// Resolve the project before dispatching, so a missing `.assay/` prints the
// explanation rather than a stack trace from whichever command happened to
// touch a path first.
try {
    projectRoot()
} catch (e) {
    console.error((e as Error).message)
    process.exit(2)
}

const file = join(COMMANDS, `${command}.ts`)
if (!existsSync(file)) {
    console.error(`assay: no such command "${command}".`)
    console.error(`  available: ${available().join(', ')}`)
    process.exit(2)
}

// Delegated rather than imported: each command owns its own argv parsing and
// exit code, and a dispatcher that swallowed either would hide a failure.
const result = spawnSync('bun', [file, ...rest], { stdio: 'inherit' })
process.exit(result.status ?? 1)
