#!/usr/bin/env bun
/**
 * Database access that belongs to NO OPERATION — found statically, on the whole
 * repository, in a second.
 *
 * ## The question this answers
 *
 * An operation is the unit assay declares, gates and drives. Everything in the
 * model assumes an effect HAS one. Code that reaches PostgREST from somewhere
 * that is not an Edge Function or a server route has none: no declaration, so
 * nothing to gate; no probe, so nothing drives it; and its statements land in
 * the corpus under `unattributed`, where they are counted and then ignored.
 *
 * That is not a hypothetical. In the project this was written for, EVERY write
 * to `members` was a browser statement, and two of them were broken by column
 * grants — profile completion for a month, the admin activate button for as
 * long as its migration had been deployed. Both were found by a person reading
 * code. Nothing in the harness could have said "these effects are outside the
 * model", because the harness only ever looked at things already inside it.
 *
 * ## Why static, and why by CLIENT
 *
 * Reachability from an operation's entry is the question, and answering it
 * properly needs a call graph across a framework's conventions — a page that
 * imports a service that imports a repository is not obviously "the browser".
 * The CLIENT is the same fact, already written down: a module that reaches the
 * database through the browser client cannot be running inside an operation,
 * whatever imports it. One import line decides it, deterministically, with no
 * database and no build.
 *
 * ## What it reports
 *
 *   WRITE  → error. This is the class that broke twice. A client write also
 *            carries privileges the server does not: column grants and RLS
 *            apply to it and to nothing else, so it is the one place where
 *            "permission denied" is a deploy-time fault nobody sees.
 *   READ   → warning. Less dangerous and far more common; the risk is shape
 *            drift, not privilege, and failing on every one would make this
 *            unrunnable on day one. Counted out loud so the number can only go
 *            down.
 *
 * ## Emitting declarations
 *
 * `--emit` writes what this scan found into `.assay/clients.json`, keyed by
 * module, in the same generated/hand-written split `operations.json` uses:
 * `reads`/`writes`/`rpc` come from here, `visibility` is written by a person.
 * That is what converts this warning list into a RATCHET — and, once a module
 * carries `visibility: caller-scoped`, into the only check anywhere that
 * exercises RLS. See `../lib/clients.ts`.
 *
 * Usage:
 *   assay unattributed            # human-readable
 *   assay unattributed --json
 *   assay unattributed --strict   # reads fail too
 *   assay unattributed --emit     # write .assay/clients.json
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { loadRpcMap } from '../lib/corpus.ts'
import { deniesStrangers, loadClients, mergeClients, stableClients } from '../lib/clients.ts'
import { loadConfig } from '../lib/db.ts'
import { isEntrypoint, projectRoot } from '../lib/paths.ts'

const ROOT = projectRoot()

/**
 * Matched on the RECEIVER, not on `.from(` alone.
 *
 * Importing the browser client is what makes a module a client, but it does not
 * make every statement in it one: a repository can read through the module
 * client and take an injected client for its writes — which is exactly the shape
 * this project moved to. Blind to the receiver, the check reported those writes
 * as unattributed forever and could not see the fix that had already happened. A
 * check that cannot notice an improvement will not be trusted to demand one.
 *
 * The limit, stated: an alias (`const db = supabase`) escapes this. Widening to
 * catch it would re-admit the false positive, and a name is what the codebase
 * actually uses.
 */
const accessOf = (binding: string) =>
    new RegExp(`\\b${binding}\\s*\\.\\s*(from|rpc)\\(\\s*['"]([a-z_][a-z0-9_]*)['"]`, 'g')
const fromOf = (binding: string) =>
    new RegExp(`\\b${binding}\\s*\\.\\s*from\\(\\s*['"]([a-z_][a-z0-9_]*)['"]\\s*\\)`, 'g')
const VERB_AHEAD = /\.\s*(insert|update|upsert|delete)\s*\(/

/**
 * Tables this binding WRITES: a `from(t)` whose chain reaches a write verb.
 *
 * The window ends at the next `.from(` — the chain cannot outlive the statement
 * that opened it. A single regex with a lazy gap does not respect that boundary:
 * `from('a').select()` … `from('b').insert()` matched as ONE chain from `a` to
 * `b`'s insert, which the guard against a straddling match then discarded — and
 * discarded the real write with it, because the match had already consumed past
 * it. The scan reported that file as read-only. An UNDERSTATED write set is the
 * one direction this file must not be wrong in: it is the list of the effects
 * nobody is watching.
 */
export function writtenBy(src: string, binding: string): string[] {
    const out: string[] = []
    for (const m of src.matchAll(fromOf(binding))) {
        const start = m.index + m[0].length
        const rest = src.slice(start, start + 400)
        const nextStatement = rest.search(/\.\s*from\s*\(/)
        const chain = nextStatement === -1 ? rest : rest.slice(0, nextStatement)
        if (VERB_AHEAD.test(chain)) out.push(m[1])
    }
    return out
}
/** `import { supabase } from "@/lib/supabase/client"` → `supabase`. */
function bindingsFor(src: string, module: string): string[] {
    const out: string[] = []
    const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${module.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')}['"]`, 'g')
    for (const m of src.matchAll(re)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop()?.trim()
            if (name) out.push(name)
        }
    }
    return out
}

interface Config {
    unattributed?: {
        /** Directories to walk. Anything outside them is not considered. */
        roots?: string[]
        /** Import specifiers that mean "this module talks to the database as a client". */
        clientModules?: string[]
        /** Files exempted, each with a reason — an unexplained exemption is a hole. */
        allow?: Record<string, string>
        /** Where the ratchet lives. Default `.assay/unattributed-baseline.json`. */
        baseline?: string
    }
}

const DEFAULTS = {
    roots: ['app', 'lib', 'components', 'hooks'],
    clientModules: ['@/lib/supabase/client'],
    allow: {} as Record<string, string>,
}

function sources(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (['node_modules', '.next', 'dist', '__snapshots__'].includes(entry.name)) continue
            sources(full, out)
        } else if (['.ts', '.tsx'].includes(extname(entry.name)) && statSync(full).isFile()) {
            out.push(full)
        }
    }
    return out
}

export interface Site {
    file: string
    /** Tables written from a client, and tables/functions merely read. */
    writes: string[]
    reads: string[]
    /** Postgres functions called from a client. Resolved through the rpc map. */
    rpcs: string[]
    /**
     * Tables written by those functions.
     *
     * NOT the same hazard as a direct write, and reporting them together
     * overstates the list by exactly the calls that are already correct. A raw
     * `.from(t).update()` from a browser is subject to column grants and RLS with
     * nothing in between — the class that broke twice here. An rpc is a
     * server-side function with its own contract, and this codebase's own
     * allowlist names rpcs as THE route for a privileged column
     * (apply_onboarding_tier, set_business_referral_enabled). So: reported,
     * never an error.
     */
    writesViaRpc: string[]
}

export function findUnattributed(config: Config = loadConfig() as Config): {
    sites: Site[]
    scanned: number
    allowed: string[]
} {
    const cfg = { ...DEFAULTS, ...(config.unattributed ?? {}) }
    // An `.rpc()` from a client is not a read just because no verb is chained
    // onto it: the write happens inside Postgres, which is the entire reason the
    // rpc map exists. `create_team` and `leave_team` reported as reads would
    // understate this list by exactly the calls most worth moving.
    const { map: rpcMap } = loadRpcMap('.assay/rpc-writes.json')
    const files = cfg.roots.flatMap(r => sources(join(ROOT, r)))
    const sites: Site[] = []
    const allowed: string[] = []

    for (const file of files) {
        const src = readFileSync(file, 'utf8')
        // The whole classification: does this module reach the database as a
        // CLIENT? A module that imports the server or admin factory is inside an
        // operation by construction, whatever else it does.
        const bindings = cfg.clientModules.flatMap(m => bindingsFor(src, m))
        if (!bindings.length) continue

        const writes = new Set<string>()
        const reads = new Set<string>()
        const rpcs = new Set<string>()
        const viaRpc = new Set<string>()
        const accesses = bindings.flatMap(b => [...src.matchAll(accessOf(b))])
        for (const b of bindings) for (const table of writtenBy(src, b)) writes.add(table)
        for (const m of accesses) {
            if (m[1] === 'rpc') {
                rpcs.add(m[2])
                // A function the map says writes makes this a write site, and the
                // tables it writes are named so the report says what is at stake.
                for (const t of rpcMap[m[2]] ?? []) viaRpc.add(t)
            } else if (!writes.has(m[2])) {
                reads.add(m[2])
            }
        }
        for (const t of writes) reads.delete(t)
        if (!writes.size && !reads.size && !rpcs.size) continue

        const rel = relative(ROOT, file)
        if (cfg.allow[rel]) { allowed.push(rel); continue }
        sites.push({
            file: rel,
            writes: [...writes].sort(),
            reads: [...reads].sort(),
            rpcs: [...rpcs].sort(),
            writesViaRpc: [...viaRpc].sort(),
        })
    }

    return { sites: sites.sort((a, b) => a.file.localeCompare(b.file)), scanned: files.length, allowed }
}

/**
 * THE RATCHET, and the reason this check is adoptable at all.
 *
 * Run on the codebase it was written for, it finds thirteen files writing to the
 * database from a browser. Failing on all thirteen makes the check red on the
 * day it lands, and a check that is red on day one is ignored by day two — the
 * same argument the invariant baseline makes, for the same reason. Known sites
 * are recorded and tolerated; a NEW one fails. The debt is visible, it can only
 * shrink, and the check works immediately.
 *
 * Keyed by FILE AND TABLE, not by file: moving one write out of a file that has
 * three must not silently license a fourth.
 */
const keyOf = (file: string, table: string) => `${file}::${table}`

function loadBaseline(path: string): Set<string> {
    try {
        return new Set((JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as { known?: string[] }).known ?? [])
    } catch { return new Set() }
}

function main() {
    const args = process.argv.slice(2)
    const config = loadConfig() as Config
    const baselinePath = config.unattributed?.baseline ?? '.assay/unattributed-baseline.json'
    const { sites, scanned, allowed } = findUnattributed(config)
    const writing = sites.filter(s => s.writes.length)
    const reading = sites.filter(s => !s.writes.length)

    const baseline = loadBaseline(baselinePath)
    const keys = writing.flatMap(s => s.writes.map(t => keyOf(s.file, t)))
    const fresh = keys.filter(k => !baseline.has(k))
    const gone = [...baseline].filter(k => !keys.includes(k))

    if (args.includes('--accept')) {
        writeFileSync(join(ROOT, baselinePath), JSON.stringify({
            _comment:
                'Client-side writes that existed when this check was adopted. A NEW one fails; ' +
                'these are tolerated. Remove entries as the writes move behind operations — the ' +
                'list can only shrink, and `assay unattributed` reports when one is gone.',
            known: keys.sort(),
        }, null, 2) + '\n')
        console.log(`Baselined ${keys.length} client write(s) → ${baselinePath}`)
        process.exit(0)
    }

    // --emit runs BEFORE the reporting below and exits, because it is a
    // generation step rather than a gate: its review surface is the git diff of
    // the file it writes, exactly as with `--accept`.
    if (args.includes('--emit')) {
        const i = args.indexOf('--emit')
        const path = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '.assay/clients.json'
        const full = join(ROOT, path)
        const current = loadClients(full)
        const { next, added, removed, changed } = mergeClients(current, sites)
        writeFileSync(full, stableClients(next))

        const claimed = Object.values(next.clients).filter(c => c.visibility).length
        const driven = Object.values(next.clients).filter(c => deniesStrangers(c.visibility)).length
        console.log(`Wrote ${path}: ${Object.keys(next.clients).length} client module(s).`)
        if (added.length) console.log(`  + ${added.length} new: ${added.join(', ')}`)
        if (changed.length) console.log(`  ≠ ${changed.length} changed: ${changed.join(', ')}`)
        for (const gone of removed) {
            // Named individually: dropping the entry also drops its hand-written
            // `visibility`, and a claim vanishing from the file is the one loss
            // here that nothing downstream can notice.
            console.log(`  - removed ${gone} (no longer reaches the database from a client)`)
            if (current.clients[gone]?.visibility) {
                console.log(`      it carried visibility: ${current.clients[gone].visibility} — that claim is now gone`)
            }
        }
        console.log(`\n${claimed}/${Object.keys(next.clients).length} module(s) carry a \`visibility\` claim; ${driven} of those are checkable.`)
        if (claimed < Object.keys(next.clients).length) {
            console.log('A module with no `visibility` is DECLARED BUT NOT CHECKED against RLS:')
            console.log('  reads/writes/rpc ratchet, and nothing exercises what a stranger can reach.')
            console.log('  Add "visibility": "caller-scoped" | "admin-only" | "public" — only a')
            console.log('  hand-written claim can be checked. Then: assay drive-client <module>')
        }
        process.exit(0)
    }

    if (args.includes('--json')) {
        console.log(JSON.stringify({ sites, scanned, allowed }, null, 2))
        process.exit(writing.length ? 1 : 0)
    }

    // Said first, and always: a scan that examined nothing must not read as a
    // pass. This is the failure mode the check itself is about.
    console.log(`\nScanned ${scanned} file(s) for database access outside any operation.\n`)
    if (scanned === 0) {
        console.error('✗ No files scanned. Check `unattributed.roots` in .assay/config.json —')
        console.error('  nothing was examined, so nothing is proved.')
        process.exit(2)
    }

    for (const s of writing) {
        console.log(`✗ ${s.file}`)
        console.log(`    writes  ${s.writes.join(', ')}   ← from a client, so no operation declares it`)
        if (s.rpcs.length) console.log(`    rpc     ${s.rpcs.join(', ')}${s.writesViaRpc.length ? `  (writes ${s.writesViaRpc.join(', ')})` : ''}`)
        if (s.reads.length) console.log(`    reads   ${s.reads.join(', ')}`)
    }
    for (const s of reading) {
        console.log(`! ${s.file}`)
        if (s.rpcs.length) console.log(`    rpc     ${s.rpcs.join(', ')}${s.writesViaRpc.length ? `  (writes ${s.writesViaRpc.join(', ')})` : ''}`)
        if (s.reads.length) console.log(`    reads   ${s.reads.join(', ')}`)
    }

    if (!sites.length) console.log('  No client-side database access found.')
    console.log(`\n${writing.length} writing, ${reading.length} reading, ${allowed.length} allowed.`)

    if (writing.length) {
        console.log('\nA CLIENT WRITE IS THE DANGEROUS ONE. Column grants and RLS apply to it and')
        console.log('to nothing else, so a privilege error there is a deploy-time fault that no')
        console.log('unit test can see and no declaration covers. Move it behind a route, which')
        console.log('makes it an operation: declarable, gateable, drivable.')
    }
    if (reading.length) {
        console.log('\nA client READ is not gated either — its shape is pinned by nothing. That is')
        console.log('a smaller problem than a write and a much longer list, so it is a warning.')
        console.log('The number is what matters: it can only go down.')
    }
    if (gone.length) {
        console.log(`\n✓ ${gone.length} baselined write(s) no longer exist — remove them with --accept:`)
        for (const k of gone) console.log(`    ${k}`)
    }
    if (fresh.length) {
        console.log(`\n✗ ${fresh.length} NEW client write(s), not in ${baselinePath}:`)
        for (const k of fresh) console.log(`    ${k}`)
        console.log('  Move it behind a route, or accept the debt with: assay unattributed --accept')
    } else if (writing.length) {
        console.log(`\n${writing.length} file(s) writing, all baselined. The list can only shrink.`)
    }

    // Reads fail only under --strict, so the check is adoptable on a codebase
    // that has hundreds. A gate that is red on day one is ignored by day two.
    process.exit(fresh.length || (args.includes('--strict') && reading.length) ? 1 : 0)
}

if (isEntrypoint(import.meta.url)) main()
