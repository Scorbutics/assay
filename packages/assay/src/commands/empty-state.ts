#!/usr/bin/env bun
/**
 * The empty-state obligation.
 *
 * motu's rule is that an island must render correctly from its DEFAULT PROPS
 * ALONE — no channels, no fixtures. That single obligation covers every island
 * with nothing authored per island, and an island that cannot meet it has a wrong
 * boundary rather than a missing test.
 *
 * This is its backend translation: every operation must survive a MINIMAL
 * database — freshly migrated and seeded, with no accumulated rows — without
 * crashing and without writing outside its declaration.
 *
 * It is TOTAL over operations. It needs no recorded scenario, no golden value and
 * no baseline, which is what separates it from a test suite: it holds for code
 * nobody has written yet. What it typically finds is code that assumes rows exist
 * — an unguarded `[0]`, a division by a count, a `.single()` that throws on empty
 * — which in production is the day-one bug for every new tenant.
 *
 * ## What counts as failure
 *
 *  - a 5xx. A 4xx is CORRECT here: asked for a row that does not exist, the
 *    operation should refuse, not crash. That distinction is the whole check.
 *  - a write to a table the operation does not declare.
 *  - an unfiltered UPDATE/DELETE — most dangerous precisely when the table is
 *    nearly empty and the blast radius looks small.
 *
 * Usage:
 *   assay empty-state --log /tmp/fserve.log --next-log /tmp/next.log
 */

import { Buffer } from 'node:buffer'
import { Client } from 'pg'
import { discover, loadConfig } from '../lib/db.ts'
import { mintToken } from './drive.ts'
import { requireScratch } from '../lib/guard.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRpcMap, parse, printNotCovered, summarise } from '../lib/corpus.ts'
import { loadDeclarations } from './declare.ts'

const FUNCTIONS = 'http://127.0.0.1:54321/functions/v1'
const NEXT = 'http://localhost:3000'

interface NextProbe {
    name?: string
    method?: string
    path: string
    auth: string
    body?: unknown
    /**
     * What "a minimal database" means for THIS operation.
     *
     * `asNewMember` drives the probe as an account that has JUST SIGNED UP: a
     * real auth user with no row in the given table. For a route whose job is to
     * create that row, that is the minimal state — and a seeded database never
     * has such an account, so the branch stays undrivable without this.
     *
     * `metadata` is what makes it a REAL path rather than a synthetic one. In
     * the project this was built for, `handle_new_user` returns early without
     * creating a member row whenever first_name / last_name / company are absent
     * from the metadata — which is exactly what an INVITE carries, since it
     * carries only the tier. So every invited member arrives at profile
     * completion with no row. That is not a fallback anybody has to contrive; it
     * is the whole invite flow, and it is what the outage actually broke.
     *
     * The first attempt deleted the DRIVING account's row instead, and the
     * database refused: an established member is referenced from half a dozen
     * tables (member_feature_grants.granted_by among them). That is the right
     * refusal — the state being asked for was not "a new member" but "an old
     * member with their history detached", which no user is ever in.
     */
    emptyState?: { asNewMember?: { table: string; metadata?: Record<string, unknown> } }
}

interface Result {
    operation: string
    status: number | string
    failures: string[]
    writes: string[]
}

/**
 * An auth user that exists and has no row in `table` — a member mid-signup.
 *
 * Created rather than borrowed, because the state cannot be reached by removing
 * anything: an established member is referenced from several tables and the
 * database rightly refuses to detach them. A brand-new user's row has no
 * dependents, so deleting the one the signup trigger creates is clean.
 *
 * The email is DETERMINISTIC and cleaned up first, so a sweep interrupted
 * halfway does not poison the next one with a leftover account.
 */
async function asNewMember(
    dbUrl: string, table: string, anon: string, metadata: Record<string, unknown> = {},
): Promise<{ token: string; id: string; cleanup: () => Promise<void> }> {
    const email = 'assay-empty-state@example.invalid'
    const password = 'Assay.EmptyState.1'
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    let id: string
    try {
        await client.query('delete from auth.users where email = $1', [email])
        const { rows } = await client.query(
            // The token columns are set to '' rather than left NULL, and that is
            // not cosmetic: GoTrue's schema query fails on NULLs there and the
            // login comes back "Database error querying schema", which reads as
            // a broken database rather than a malformed row. The seeded accounts
            // carry '' too — that is what made the difference visible.
            `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                                     email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                                     created_at, updated_at, is_sso_user,
                                     confirmation_token, recovery_token,
                                     email_change, email_change_token_new)
             values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
                     'authenticated', $1, crypt($2, gen_salt('bf')), now(),
                     '{"provider":"email","providers":["email"]}', $3::jsonb, now(), now(), false,
                     '', '', '', '')
             returning id`,
            [email, password, JSON.stringify(metadata)],
        )
        id = rows[0].id as string
        // The signup trigger creates the row this probe must find MISSING. It is
        // seconds old and referenced by nothing, so removing it is safe — which
        // is exactly what is not true of an established member.
        await client.query(`delete from public."${table}" where id = $1`, [id])
    } finally { await client.end() }

    const token = await mintToken(email, password, anon)
    return {
        token, id,
        cleanup: async () => {
            const c = new Client({ connectionString: dbUrl })
            await c.connect()
            try { await c.query('delete from auth.users where email = $1', [email]) }
            finally { await c.end() }
        },
    }
}

/** A well-formed id no row has. The empty-state case for anything keyed by one. */
const ABSENT_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Probe placeholders, resolved for a MINIMAL database.
 *
 * `drive` resolves them against the data; here there is none by
 * definition, so they become a valid id that is not there — which IS the state
 * under test. Left unresolved they went out as the literal string, and two routes
 * answered 500 to `invalid input syntax for type uuid`: a finding about malformed
 * input, dressed as a finding about an empty database.
 */
function resolveForEmptyState(body: string, subject: string): string {
    let out = body.replace(/"SELF"/g, JSON.stringify(subject))
    // The NAMES come from the project's config — this file knowing that a
    // placeholder is called REAL_TASK or OTHER_MEMBER is one project's schema
    // inside a tool meant to serve any of them. What is generic is the rule:
    // whatever `drive` would have looked up, here resolves to absent.
    for (const name of Object.keys(loadConfig().placeholders ?? {})) {
        out = out.replace(new RegExp(`"${name}"`, 'g'), JSON.stringify(ABSENT_ID))
    }
    return out
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const sizeOf = (p: string) => { try { return readFileSync(p, 'utf8').length } catch { return 0 } }
const sliceFrom = (p: string, at: number) => { try { return readFileSync(p, 'utf8').slice(at) } catch { return '' } }

import { isEntrypoint, projectRoot } from '../lib/paths.ts'

const ROOT = projectRoot()

async function main() {
    const args = process.argv.slice(2)
    const at = (f: string, d: string) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1] }
    const asJson = args.includes('--json')
    const fnLog = at('--log', '/tmp/fserve.log')
    const nextLog = at('--next-log', '/tmp/next.log')
    const dbUrl = at('--db', '') || discover().url || ''
    await requireScratch(dbUrl, 'run the empty-state sweep')

    const probes = JSON.parse(readFileSync(at('--probes', '.assay/probes.json'), 'utf8'))
    const declarations = loadDeclarations(at('--declarations', '.assay/operations.json'))
    const { map: rpcMap, loaded } = loadRpcMap(at('--rpc-map', '.assay/rpc-writes.json'))
    if (!loaded) { console.error('✗ No RPC write map — rpc writes would be invisible.'); process.exit(2) }

    const anon = process.env.ASSAY_ANON_KEY ?? readFileSync('/tmp/anon.key', 'utf8').trim()
    // MINTED, not read from a file. This used to read /tmp/admin.jwt, which
    // nothing in the project ever wrote — so the sweep died on ENOENT before its
    // first request, and had done since it was written. Same reason `drive`
    // mints: a cached token expires into a 401, and a 401 is a PASS here, so a
    // stale one would turn the whole sweep green.
    const email = process.env.ASSAY_ADMIN_EMAIL
    const password = process.env.ASSAY_ADMIN_PASSWORD
    if (!email || !password) {
        console.error('✗ Set ASSAY_ADMIN_EMAIL and ASSAY_ADMIN_PASSWORD (a LOCAL account).')
        process.exit(2)
    }
    const adminJwt = await mintToken(email, password, anon)
    const tokens: Record<string, string> = {
        admin: adminJwt,
        service: process.env.ASSAY_SERVICE_KEY ?? readFileSync('/tmp/sr.key', 'utf8').trim(),
    }
    // The seeded members are not loginable, so a member-scoped probe runs as the
    // admin — who is also a member. Recorded here rather than left implicit,
    // because it means these probes do not exercise the non-admin branch.
    tokens.user = tokens.admin
    const selfId = JSON.parse(Buffer.from(tokens.admin.split('.')[1], 'base64url').toString()).sub as string

    const results: Result[] = []

    const check = (operation: string, status: number | string, logText: string): Result => {
        const summary = summarise(parse(logText), rpcMap).find(s => s.operation === operation)
        const declared = declarations.operations[operation]
        const failures: string[] = []
        if (typeof status === 'number' && status >= 500) failures.push(`${status} — crashed on a minimal database`)
        if (typeof status === 'string') failures.push(status)
        for (const t of summary?.writes ?? []) {
            if (!declared) failures.push(`writes "${t}" but has no declaration`)
            else if (!declared.writes.includes(t)) failures.push(`writes "${t}", which is not declared`)
        }
        for (const u of summary?.unfilteredWrites ?? []) failures.push(`unfiltered ${u.verb.toUpperCase()} on "${u.target}"`)
        return { operation, status, failures, writes: summary?.writes ?? [] }
    }

    // An operation may carry several probes, one per branch. The empty-state
    // obligation is about the MINIMAL-DATABASE case, so it drives the first only;
    // ledger-drive runs them all.
    for (const [fn, spec] of Object.entries(probes.edge as Record<string, any>)) {
        const probe = (Array.isArray(spec) ? spec[0] : spec) as { auth: string; body: unknown }
        const body = JSON.parse(resolveForEmptyState(JSON.stringify(probe.body), selfId))
        const before = sizeOf(fnLog)
        let status: number | string
        try {
            const res = await fetch(`${FUNCTIONS}/${fn}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${tokens[probe.auth]}`, apikey: anon, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120_000),
            })
            status = res.status
        } catch (e) { status = `request failed: ${(e as Error).message}` }
        await sleep(400)   // the runtime flushes its log asynchronously
        results.push(check(fn, status, sliceFrom(fnLog, before)))
    }

    // Next routes. This loop existed and had never run: it treated each entry as
    // ONE probe rather than the list `drive` reads, and issued a bodyless GET —
    // so every POST-only route would have answered 405, which is a 4xx, which is
    // a PASS. It would have reported success for never having called anything.
    //
    // Ordered so that `withoutOwnRow` probes go LAST. They delete a row and let
    // the operation recreate it, and the row they delete is the driving account's
    // own — which carries the admin role every other probe authenticates with.
    const nextEntries = Object.entries(probes.next ?? {} as Record<string, NextProbe | NextProbe[]>)
        .map(([operation, spec]) => [operation, (Array.isArray(spec) ? spec[0] : spec) as NextProbe] as const)
        .sort((a, b) => Number(!!a[1].emptyState) - Number(!!b[1].emptyState))

    for (const [operation, probe] of nextEntries) {
        // THE MINIMAL DATABASE FOR THIS OPERATION. "No accumulated rows" is not
        // one state — it is per-operation, and for a route whose job is to create
        // the caller's row it means that row is ABSENT. A seeded database always
        // has it, which is exactly why the branch that broke profile completion
        // for a month could not be driven: the route took UPDATE every time.
        let restore: (() => Promise<void>) | null = null
        let asUser = tokens[probe.auth]
        let subject = selfId
        if (probe.emptyState?.asNewMember) {
            const fresh = await asNewMember(
                dbUrl, probe.emptyState.asNewMember.table, anon,
                probe.emptyState.asNewMember.metadata)
            asUser = fresh.token
            subject = fresh.id
            restore = fresh.cleanup
            // Printed, because "which account did this actually run as" is the
            // question a silent harness bug hides. This one computed the new
            // member's token and then sent the driving account's — the variable
            // was assigned and never read — so the route took its UPDATE branch
            // and the sweep reported a pass for the branch it exists to reach.
            console.log(`      as a new member: ${fresh.id}`)
        }
        const before = sizeOf(nextLog)
        let status: number | string
        try {
            const body = probe.body === undefined
                ? undefined
                : JSON.parse(resolveForEmptyState(JSON.stringify(probe.body), subject))
            const res = await fetch(`${NEXT}${probe.path}`, {
                method: (probe.method ?? 'POST').toUpperCase(),
                headers: { Authorization: `Bearer ${asUser}`, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(120_000),
            })
            status = res.status
        } catch (e) { status = `request failed: ${(e as Error).message}` }
        await sleep(300)
        results.push(check(operation, status, sliceFrom(nextLog, before)))
        // Cleaned up even on failure: the sweep is single-shot, but a leftover
        // account would poison the NEXT run, whose whole premise is a database
        // in a known minimal state.
        if (restore) await restore()
    }

    // THE RATCHET, for the same reason the invariant baseline and the
    // unattributed list have one: this sweep is TOTAL over operations, so on any
    // codebase that did not grow up with it the first run is a wall rather than a
    // gate — and a check that is red on day one is ignored by day two. Known
    // failures are recorded and tolerated; a NEW one fails. The debt is named and
    // can only shrink.
    //
    // Keyed by operation AND failure text, so an operation that starts failing
    // for a DIFFERENT reason is a new finding rather than a covered one.
    const baselinePath = at('--baseline', '.assay/empty-state-baseline.json')
    let baseline = new Set<string>()
    try {
        baseline = new Set((JSON.parse(readFileSync(join(ROOT, baselinePath), 'utf8')) as
            { known?: string[] }).known ?? [])
    } catch { /* absent: everything is new, which is the correct first answer */ }
    const keyOf = (r: Result, failure: string) => `${r.operation} :: ${failure}`

    const failed = results.filter(r => r.failures.length)
    const keys = failed.flatMap(r => r.failures.map(f => keyOf(r, f)))
    const fresh = keys.filter(k => !baseline.has(k))
    const fixed = [...baseline].filter(k => !keys.includes(k))

    if (args.includes('--accept')) {
        writeFileSync(join(ROOT, baselinePath), JSON.stringify({
            _comment:
                'Operations that do not yet survive a minimal database. A NEW failure fails the ' +
                'sweep; these are tolerated. Each line is one operation and one reason — an ' +
                'operation failing for a different reason is a new finding, not a covered one.',
            known: keys.sort(),
        }, null, 2) + '\n')
        console.log(`Baselined ${keys.length} empty-state failure(s) → ${baselinePath}`)
        process.exit(0)
    }
    const declaredOps = Object.keys(declarations.operations)
    const probed = new Set(results.map(r => r.operation))
    const unprobed = declaredOps.filter(o => !probed.has(o))

    if (asJson) {
        console.log(JSON.stringify({ results, unprobed, failed: failed.length, fresh, fixed }, null, 2))
        process.exit(fresh.length ? 1 : 0)
    }

    for (const r of results) {
        const mark = r.failures.length ? '✗' : '·'
        console.log(`${mark} ${String(r.status).padEnd(5)} ${r.operation}${r.writes.length ? `   writes: ${r.writes.join(', ')}` : ''}`)
        for (const f of r.failures) console.log(`      ${f}`)
    }
    console.log(`\n${results.length - failed.length}/${results.length} operations survive a minimal database.`)
    if (fixed.length) {
        console.log(`\n✓ ${fixed.length} baselined failure(s) are gone — remove them with --accept:`)
        for (const k of fixed) console.log(`    ${k}`)
    }
    if (fresh.length) {
        console.log(`\n✗ ${fresh.length} NEW failure(s), not in ${baselinePath}:`)
        for (const k of fresh) console.log(`    ${k}`)
    } else if (failed.length) {
        console.log(`\n${failed.length} operation(s) failing, all baselined. The list can only shrink.`)
    }
    if (!fresh.length && !failed.length) printNotCovered()
    // The remainder. An unprobed operation is unproven, not passing.
    if (unprobed.length) console.log(`· ${unprobed.length} declared operation(s) have no probe — unproven: ${unprobed.join(', ')}`)
    process.exit(fresh.length ? 1 : 0)
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