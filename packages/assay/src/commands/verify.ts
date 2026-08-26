#!/usr/bin/env bun
/**
 * TIER 2 — everything that needs a live database.
 *
 * Drives every probe, gates the resulting corpus against the declarations, and
 * checks the invariants. Seconds to minutes, so it is a punctual gate rather
 * than a dev-loop step — the inner loop is `assay:drive <op>` plus
 * `assay:check --require <op>`, which is sub-second.
 *
 * It NEVER skips. If no database is reachable it fails with instructions. The
 * harness this replaces exported a `dbReachable` flag, every suite did
 * `skipIf(!dbReachable)`, and with no local stack 10 tests silently vanished
 * while the run still reported green.
 *
 * It also refuses to run against a database nobody marked disposable — driving
 * real operations writes real rows, and `ledger-drive` enforces that guard.
 *
 * Usage: assay verify [--corpus /tmp/assay.log]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireDatabase } from '../lib/db.ts'
import { commandPath, projectRoot, isEntrypoint } from '../lib/paths.ts'

const ROOT = projectRoot()

function step(name: string, args: string[], allowFailure = false): { ok: boolean; out: string } {
    process.stdout.write(`\n── ${name}\n`)
    try {
        const out = execFileSync('bun', args, { cwd: ROOT, encoding: 'utf8' })
        process.stdout.write(out)
        return { ok: true, out }
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string }
        process.stdout.write(err.stdout ?? '')
        process.stderr.write(err.stderr ?? '')
        if (!allowFailure) return { ok: false, out: err.stdout ?? '' }
        return { ok: true, out: err.stdout ?? '' }
    }
}

async function main() {
    const args = process.argv.slice(2)
    const at = (f: string, d: string) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1] }
    const corpus = at('--corpus', '/tmp/assay-verify.log')

    // Fails with instructions rather than skipping. This is the whole point.
    const db = requireDatabase()
    console.log(`assay tier 2 — database: ${db.url.replace(/:\/\/[^@]*@/, '://***@')}`)

    // The rpc map must be current: without it every write done inside a Postgres
    // function is invisible, and the gate would pass by not looking.
    // commandPath, never join(ROOT, …): these modules follow the PACKAGE, and
    // the project they run against no longer contains a copy of them. Spawning
    // `<root>/assay/src/commands/…` broke the moment assay was vendored under
    // `vendor/assay/packages/` — every step failed with "Module not found",
    // which `step()` reports as a step failure rather than as a missing tool.
    const mapOut = execFileSync('bun', [commandPath('rpc-map')], { cwd: ROOT, encoding: 'utf8' })
    writeFileSync(join(ROOT, '.assay/rpc-writes.json'), mapOut)
    console.log('  rpc write map rebuilt')

    const results: Array<{ name: string; ok: boolean }> = []

    const drive = step('drive every probe', [commandPath('drive'), '--all', '--out', corpus])
    results.push({ name: 'drive', ok: drive.ok })
    if (!drive.ok) {
        console.error('\nassay: driving failed — the gate below would be meaningless, so stopping.')
        process.exit(1)
    }

    // Belt and braces: even if drive somehow exits 0, refuse to report a pass on
    // a corpus with nothing in it. Every step below would trivially "succeed".
    const captured = readFileSync(corpus, 'utf8').split('\n').filter(Boolean).length
    if (captured === 0) {
        console.error('\nassay: the corpus is empty — nothing was observed, so nothing was verified.')
        process.exit(1)
    }
    console.log(`  corpus: ${captured} statement(s)`)

    results.push({ name: 'gate', ok: step('gate the corpus', [commandPath('check'), corpus]).ok })
    results.push({ name: 'invariants', ok: step('invariants', [commandPath('invariants'), '--corpus', corpus]).ok })

    const failed = results.filter(r => !r.ok)
    console.log(`\n${'─'.repeat(60)}`)
    for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`)
    console.log(failed.length
        ? `\nassay tier 2: ${failed.length} step(s) failed.`
        : `\nassay tier 2: all steps passed — for the categories assay covers.`)
    process.exit(failed.length ? 1 : 0)
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