#!/usr/bin/env bun
/**
 * Drives an operation and captures the ledger it produced.
 *
 * This is the INNER LOOP helper. Without it the workflow reads well and cannot be
 * run: getting a corpus meant hand-rolling curl with a minted JWT, which is not
 * something a dev loop — or an agent — should be asked to do per edit.
 *
 *   assay drive complete-mission        # one operation, all its branches
 *   assay drive --all                   # every probe
 *   assay drive complete-mission --out /tmp/corpus.log
 *
 * The corpus is captured by slicing the Edge runtime log from the byte offset
 * taken immediately before each request, so lines are attributed to the probe
 * that caused them rather than to whatever else the runtime was doing.
 *
 * An operation may declare a LIST of probes, one per branch. That matters more
 * than it looks: driving `scoring-cycle` only with `sendEmails: false` is what
 * left its `email_logs` write undeclared. Coverage of BRANCHES, not of
 * operations, is what makes a declaration honest.
 */

import { Buffer } from 'node:buffer'
import { discover, loadConfig } from '../lib/db.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Client } from 'pg'
import { requireScratch } from '../lib/guard.ts'

const FUNCTIONS = 'http://127.0.0.1:54321/functions/v1'
const AUTH = 'http://127.0.0.1:54321/auth/v1'
/**
 * The Next server, for operations that are ROUTES rather than Edge Functions.
 *
 * Declaring a Next route and never driving it means its declaration is never
 * checked: `check` reports it as declared-but-not-observed, which is a NOTE and
 * never fails. Half this project's declared operations were in that state.
 */
const NEXT = process.env.ASSAY_NEXT_URL ?? 'http://127.0.0.1:3000'

/**
 * Mints a fresh JWT rather than reading one off disk.
 *
 * A cached token expires after an hour, and an expired one comes back as 401 —
 * which the empty-state check counts as a PASS (a 4xx is the correct answer to a
 * missing row). So a stale token quietly turns the whole sweep green. Minting per
 * run removes that failure mode entirely.
 *
 * Local stack only: the captcha secret is Cloudflare's always-pass test key, so
 * any token string satisfies it.
 */
export async function mintToken(email: string, password: string, anon: string): Promise<string> {
    const res = await fetch(`${AUTH}/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, gotrue_meta_security: { captcha_token: 'XXXX.DUMMY.TOKEN.XXXX' } }),
    })
    const json = await res.json() as { access_token?: string; msg?: string; error_description?: string }
    if (!json.access_token) {
        throw new Error(`login failed for ${email}: ${json.msg ?? json.error_description ?? JSON.stringify(json).slice(0, 120)}`)
    }
    return json.access_token
}

/**
 * A Next route probe. Unlike an Edge Function — whose name IS its path — a route
 * has both a declaration key (`app/api/x/route.ts`, what the ledger attributes
 * to) and a URL, so the probe carries the URL and the method explicitly.
 */
interface NextProbe {
    name?: string
    /** Default POST; GET routes carry no body. */
    method?: string
    /** URL path, e.g. `/api/member/profile`. */
    path: string
    auth: string
    body?: unknown
    setup?: Array<{ operation: string; auth: string; body?: unknown; repeat?: number }>
}

interface Probe {
    name?: string
    auth: string
    body: unknown
    /**
     * Operations to drive FIRST, so this probe reaches a branch that needs state
     * rather than a different payload.
     *
     * process-payment is the case that forced this: its pipeline is a resumable
     * state machine that advances ONE phase per invocation, so a single call only
     * ran phase-provision and the enrich phase — where member creation and every
     * Wix call live — was unreachable. `wix-webhook-simulate` creates the payment
     * row; five passes of process-payment walk it to fetching_buyer_data.
     */
    setup?: Array<{ operation: string; auth: string; body?: unknown; repeat?: number }>
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Resolves placeholders in a probe body against the live database.
 *
 * Hardcoding row ids into probes.json makes every probe stale the moment anyone
 * runs `supabase db reset` — and a probe that 404s looks like a passing 4xx, so
 * the rot is silent. Placeholders are looked up instead:
 *   SELF   the authenticated caller's own id. Built in, because "who is
 *          driving" is assay's notion rather than any project's.
 *   others declared in `placeholders` in .assay/config.json, each one a query
 *          that finds a real row. THIS FILE USED TO CONTAIN THREE OF THEM — a
 *          `members` lookup and two `weekly_tasks` ones — which is one project's
 *          schema living inside a tool meant to serve any project.
 *
 * A REAL_* name a probe uses and the config does not declare is an ERROR, not a
 * silent pass-through: unresolved, it reaches the route as that literal string,
 * which is a malformed uuid, which is a 400 — and a 4xx is how every sweep here
 * spells "handled correctly".
 */
async function resolvePlaceholders(body: string, selfId: string, dbUrl: string): Promise<string> {
    let out = body.replace(/"SELF"/g, JSON.stringify(selfId))
    const declared = loadConfig().placeholders ?? {}
    // Only DECLARED names are substituted: a capitalised string that is not
    // declared is far more likely an enum value the route expects ("BOOST_MAX")
    // than a placeholder. The check for the opposite mistake is right below.
    const used = [...new Set([...out.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map(m => m[1]))]
        .filter(name => name in declared)
    const unresolved = [...new Set([...out.matchAll(/"(REAL_[A-Z0-9_]+)"/g)].map(m => m[1]))]
        .filter(name => !(name in declared))
    if (unresolved.length) {
        throw new Error(
            `assay drive: probe uses ${unresolved.join(', ')}, which .assay/config.json does not ` +
            `declare under \`placeholders\`. Unresolved, it reaches the route as a literal string ` +
            `and is answered 400 — which every check here reads as a pass.`)
    }
    if (!used.length) return out
    const client = new Client(dbUrl)
    await client.connect()
    try {
        for (const name of used) {
            const { rows } = await client.query(declared[name], [selfId])
            const value = rows[0] ? Object.values(rows[0])[0] : null
            out = out.replace(new RegExp(`"${name}"`, 'g'), JSON.stringify(value ?? ABSENT_ROW))
        }
    } finally { await client.end() }
    return out
}

/**
 * A syntactically valid uuid no row has, so a lookup that found nothing gives a
 * 404 rather than a malformed-input 400 or a crash.
 */
const ABSENT_ROW = '00000000-0000-0000-0000-000000000000'

const sizeOf = (p: string) => { try { return readFileSync(p, 'utf8').length } catch { return 0 } }

import { isEntrypoint } from '../lib/paths.ts'

async function main() {
    const args = process.argv.slice(2)
    const at = (f: string, d: string) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1] }
    const all = args.includes('--all')
    const logPath = at('--log', '/tmp/fserve.log')
    // The Next server writes its ledger to its own stdout, so the corpus for a
    // route is sliced from a different file than an Edge Function's.
    const nextLogPath = at('--next-log', '/tmp/next.log')
    const outPath = at('--out', '.assay/corpus.log')
    const target = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))[0]
    const dbUrl = at('--db', '') || discover().url || ''

    if (!target && !all) {
        console.error('Usage: ledger-drive.ts <operation> | --all')
        process.exit(2)
    }

    // Every probe below issues real writes. Refuse unless this database exists to be lost.
    await requireScratch(dbUrl, 'drive operations')

    const probes = JSON.parse(readFileSync(at('--probes', '.assay/probes.json'), 'utf8'))
    const anon = process.env.ASSAY_ANON_KEY ?? readFileSync('/tmp/anon.key', 'utf8').trim()
    const email = process.env.ASSAY_ADMIN_EMAIL
    const password = process.env.ASSAY_ADMIN_PASSWORD
    if (!email || !password) {
        console.error('✗ Set ASSAY_ADMIN_EMAIL and ASSAY_ADMIN_PASSWORD (a LOCAL account) so a fresh')
        console.error('  token can be minted. A cached token expires into a 401, which every check')
        console.error('  here reads as a legitimate refusal — a stale token turns the sweep green.')
        process.exit(2)
    }
    const admin = await mintToken(email, password, anon)
    const tokens: Record<string, string> = {
        admin,
        user: admin,
        service: process.env.ASSAY_SERVICE_KEY ?? readFileSync('/tmp/sr.key', 'utf8').trim(),
    }
    const selfId = JSON.parse(Buffer.from(admin.split('.')[1], 'base64url').toString()).sub as string

    const entries = Object.entries(probes.edge as Record<string, Probe | Probe[]>)
        .filter(([op]) => all || op === target)
    if (!entries.length) {
        const known = [...Object.keys(probes.edge ?? {}), ...Object.keys(probes.next ?? {})]
        if (!known.includes(target)) {
            console.error(`No probe for "${target}". Known: ${known.join(', ')}`)
            process.exit(2)
        }
    }

    let corpus = ''
    for (const [op, spec] of entries) {
        for (const probe of (Array.isArray(spec) ? spec : [spec])) {
            // Setup runs before the offset is taken: its statements belong to the
            // setup operations, not to the probe under test, and folding them in
            // would attribute another operation's writes to this one.
            for (const step of probe.setup ?? []) {
                const stepBody = JSON.parse(await resolvePlaceholders(JSON.stringify(step.body ?? {}), selfId, dbUrl))
                for (let i = 0; i < (step.repeat ?? 1); i++) {
                    try {
                        await fetch(`${FUNCTIONS}/${step.operation}`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${tokens[step.auth]}`, apikey: anon, 'Content-Type': 'application/json' },
                            body: JSON.stringify(stepBody),
                            signal: AbortSignal.timeout(180_000),
                        })
                    } catch { /* a setup step that fails is reported by the probe reaching less */ }
                }
                console.log(`    setup: ${step.operation}${step.repeat ? ` x${step.repeat}` : ''}`)
            }
            const body = JSON.parse(await resolvePlaceholders(JSON.stringify(probe.body), selfId, dbUrl))
            const before = sizeOf(logPath)
            let status: number | string
            try {
                const res = await fetch(`${FUNCTIONS}/${op}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${tokens[probe.auth]}`, apikey: anon, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(180_000),
                })
                status = res.status
            } catch (e) { status = `failed: ${(e as Error).message}` }
            await sleep(400)   // the runtime flushes its log asynchronously
            const slice = readFileSync(logPath, 'utf8').slice(before)
            const lines = slice.split('\n').filter(l => l.includes('@ledger'))
            corpus += lines.join('\n') + (lines.length ? '\n' : '')
            console.log(`  ${String(status).padEnd(5)} ${op}${probe.name ? ` [${probe.name}]` : ''}  → ${lines.length} statement(s)`)
        }
    }

    // ---- Next routes -------------------------------------------------------
    //
    // Same slice-the-log technique, a different server. Attribution is the catch:
    // a route that does not pass an explicit operation label relies on
    // `operationFromStack()`, which returns 'unattributed' under
    // NODE_ENV=production — so a corpus driven against `next build && next start`
    // gates nothing, however many statements it contains. Drive `next dev`.
    const nextProbes = Object.entries((probes.next ?? {}) as Record<string, NextProbe | NextProbe[]>)
        .filter(([op]) => all || op === target)
    if (nextProbes.length && !existsSync(nextLogPath)) {
        console.error(`✗ ${nextProbes.length} Next probe(s) declared and no log at ${nextLogPath}.`)
        console.error('  Start the app with the seam on and its output captured, then pass --next-log:')
        console.error('    ASSAY_LEDGER=on bun run dev > /tmp/next.log 2>&1 &')
        process.exit(2)
    }
    for (const [op, spec] of nextProbes) {
        for (const probe of (Array.isArray(spec) ? spec : [spec])) {
            for (const step of probe.setup ?? []) {
                const stepBody = JSON.parse(await resolvePlaceholders(JSON.stringify(step.body ?? {}), selfId, dbUrl))
                for (let i = 0; i < (step.repeat ?? 1); i++) {
                    try {
                        await fetch(`${FUNCTIONS}/${step.operation}`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${tokens[step.auth]}`, apikey: anon, 'Content-Type': 'application/json' },
                            body: JSON.stringify(stepBody),
                            signal: AbortSignal.timeout(180_000),
                        })
                    } catch { /* reported by the probe reaching less */ }
                }
                console.log(`    setup: ${step.operation}${step.repeat ? ` x${step.repeat}` : ''}`)
            }
            const method = (probe.method ?? 'POST').toUpperCase()
            const body = probe.body === undefined
                ? undefined
                : JSON.parse(await resolvePlaceholders(JSON.stringify(probe.body), selfId, dbUrl))
            const before = sizeOf(nextLogPath)
            let status: number | string
            try {
                const res = await fetch(`${NEXT}${probe.path}`, {
                    method,
                    headers: { Authorization: `Bearer ${tokens[probe.auth]}`, 'Content-Type': 'application/json' },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    signal: AbortSignal.timeout(180_000),
                })
                status = res.status
            } catch (e) { status = `failed: ${(e as Error).message}` }
            // `next dev` compiles a route on its first request, and the compile
            // output lands in the same stream; give it room before slicing.
            await sleep(1200)
            const lines = readFileSync(nextLogPath, 'utf8').slice(before)
                .split('\n').filter(l => l.includes('@ledger'))
            corpus += lines.join('\n') + (lines.length ? '\n' : '')
            console.log(`  ${String(status).padEnd(5)} ${method} ${probe.path}${probe.name ? ` [${probe.name}]` : ''}  → ${lines.length} statement(s)`)
        }
    }

    writeFileSync(outPath, corpus)
    const total = corpus.split('\n').filter(Boolean).length
    console.log(`\n${total} statement(s) → ${outPath}`)
    if (!total) {
        // Exiting 0 here is how a whole verification run reports "all passed"
        // while having observed nothing. An empty corpus is never a result.
        console.error('✗ No statements captured from any probe.')
        console.error(`  The requests were sent, so the runtime is up — but nothing was read from ${logPath}.`)
        console.error('  Point --log at the log the runtime is ACTUALLY writing to, or restart it:')
        console.error('    (cd backend && supabase functions serve --env-file .env.local > ' + logPath + ' 2>&1 &)')
        process.exit(1)
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