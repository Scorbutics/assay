#!/usr/bin/env bun
/**
 * Drives a BROWSER module and captures the ledger it produced.
 *
 * `assay drive` drives operations — things the backend serves. This drives the
 * other data path: a repository or service module that calls PostgREST directly
 * from the browser. Nothing has ever exercised those, so the policies that guard
 * them (RLS, column grants, `SECURITY DEFINER` functions) have never been tested
 * by anything in this toolchain.
 *
 *   assay drive-client lib/repositories/business-team.ts
 *   assay drive-client --all --out .assay/client-corpus.log
 *
 * Mechanically: mint a real member session, hand it to the host's OWN browser
 * client, import the module, call the declared exports, and collect what the
 * seam recorded. The corpus written is byte-compatible with what `assay check`
 * already consumes — same `@ledger <json>` lines, same fields — so no reader had
 * to learn a new format.
 *
 * ## The two personas, and why the second one is the point
 *
 * The module is driven TWICE whenever `.assay/clients.json` claims a visibility
 * that denies strangers:
 *
 *   1. as the MEMBER the probes are written for. Produces the read/write/rpc sets
 *      the gate ratchets against.
 *   2. as an UNRELATED member. Produces the evidence for the `caller-scoped`
 *      claim: every read must come back empty and every write must be refused.
 *
 * Run (2) is the only reason this command exists. Run (1) is a blast-radius
 * ratchet like every other declaration here; run (2) is the only thing anywhere
 * that can notice a policy which stopped filtering.
 *
 * `SELF` and `OTHER_MEMBER` in a probe's args SWAP between the two runs: the
 * stranger is the caller in run (2), so the id they act on is the member's. A
 * probe written once therefore reads as "act on my own row" in run (1) and "act
 * on someone else's row" in run (2), which is exactly the pair of questions.
 *
 * ## Two things that make this inert if they go wrong
 *
 *  - DRIVING AS THE WRONG PRINCIPAL. Under `service_role` every policy is off;
 *    as the anon role every read is empty for reasons that have nothing to do
 *    with ownership. Both make run (2) pass while proving nothing — the same
 *    failure `empty-state` shipped once. So the session's `sub` is compared
 *    against what the client reports, the two personas are compared against each
 *    other, and any statement recorded as service-role fails the run.
 *  - CAPTURING NOTHING. A module whose seam is off, or a second copy of the seam
 *    package that our sink redirect cannot see, produces an empty corpus — which
 *    every gate reads as clean. Zero statements is a hard failure here, and the
 *    default sink's stdout is scraped as a fallback for the two-copies case.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LEDGER_TAG, parse, type Entry } from '../lib/corpus.ts'
import { deniesStrangers, loadClients, strangerKey } from '../lib/clients.ts'
import { discover, loadConfig } from '../lib/db.ts'
import { requireScratch } from '../lib/guard.ts'
import { isEntrypoint, projectRoot } from '../lib/paths.ts'
import { mintSession, resolvePlaceholders, type Session } from './drive.ts'

const ROOT = projectRoot()

/**
 * One call into a client module.
 *
 * `.assay/client-probes.json`:
 *   { "lib/repositories/business-team.ts": [
 *       { "export": "getMyBusinessTeam", "args": [] },
 *       { "export": "addToBusinessTeam", "args": ["OTHER_MEMBER"] } ] }
 */
interface ClientProbe {
    name?: string
    /** The exported function to call. */
    export: string
    /** Arguments, with `SELF` / `OTHER_MEMBER` / declared placeholders resolved. */
    args?: unknown[]
}

interface ClientsConfig {
    clients?: {
        /**
         * The module exporting the host's browser client, and the name it is
         * exported under. Required: the driver has to authenticate THAT client —
         * the one the repositories import — and no amount of guessing gets there.
         */
        client?: { module: string; export?: string }
        /** Where the probes live. Default `.assay/client-probes.json`. */
        probes?: string
    }
}

/**
 * Resolve a module the way the HOST resolves it.
 *
 * A repository-relative path (`lib/repositories/x.ts`) is turned into a file URL
 * under the project root. Anything else — `@/lib/supabase/client` — is handed to
 * the runtime untouched, which under bun means the host's own tsconfig `paths`
 * decide. That is deliberate: the alternative is asking every host to refactor
 * its modules to take an injected client, and requiring a host to change shape
 * for the tool is what this repository otherwise refuses to do.
 */
function resolveModule(spec: string): string {
    if (spec.startsWith('.') || isAbsolute(spec) || existsSync(join(ROOT, spec))) {
        return pathToFileURL(isAbsolute(spec) ? spec : join(ROOT, spec)).href
    }
    return spec
}

/** Anything with the two methods this driver needs off a supabase-js client. */
interface AuthedClient {
    auth: {
        setSession(t: { access_token: string; refresh_token: string }): Promise<{ error: unknown }>
        getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }>
    }
}

/**
 * Collect everything the seam emits while `fn` runs.
 *
 * TWO paths, because there may be two copies of the seam package in the process:
 * ours, and whichever one the host's client module resolved. `setLedgerSink`
 * only redirects OURS. The other keeps its default sink, which writes
 * `@ledger <json>` to stdout — so stdout is scraped as well. Exactly one of the
 * two fires per statement, so the union is the whole ledger and not a double
 * count.
 *
 * The seam is imported lazily and through the package name so that this file
 * still loads when the host's copy is the only one installed.
 */
async function collect(fn: () => Promise<void>): Promise<Entry[]> {
    const seam = await import('@scorbutics/assay-seam') as {
        setLedgerSink: (next: (e: Entry) => void) => (e: Entry) => void
    }
    const sunk: Entry[] = []
    const scraped: Entry[] = []
    const previous = seam.setLedgerSink(e => { sunk.push(e) })
    const realLog = console.log
    console.log = (...parts: unknown[]) => {
        const line = parts.map(p => (typeof p === 'string' ? p : String(p))).join(' ')
        if (line.includes(LEDGER_TAG)) { scraped.push(...parse(line)); return }
        realLog(...parts)
    }
    try {
        await fn()
    } finally {
        console.log = realLog
        seam.setLedgerSink(previous)
    }
    return [...sunk, ...scraped]
}

/**
 * Point the host's client at a persona, and PROVE it landed.
 *
 * The proof is not ceremony. A `setSession` that silently failed leaves the
 * client on the anon role, where RLS returns nothing to everyone — and "returns
 * nothing" is precisely what the stranger run is looking for. The check would
 * pass, permanently, on a database with no policies at all.
 */
async function driveAs(client: AuthedClient, session: Session): Promise<void> {
    const { error } = await client.auth.setSession({
        access_token: session.accessToken, refresh_token: session.refreshToken,
    })
    if (error) throw new Error(`could not set the session for ${session.email}: ${String(error)}`)
    const who = await client.auth.getUser()
    const id = who.data?.user?.id
    if (!id) {
        throw new Error(
            `the client reports no authenticated user after signing in as ${session.email}. ` +
            'Every statement would run as the anon role, and RLS answers anon with nothing — ' +
            'so a caller-scoped check would pass without exercising a single policy.')
    }
    if (id !== session.userId) {
        throw new Error(`signed in as ${session.email} (${session.userId}) but the client reports ${id}`)
    }
}

/** Call one probe, letting a refusal through as data rather than as a crash. */
async function callProbe(
    module: string, probe: ClientProbe, args: unknown[],
): Promise<{ ok: boolean; detail: string }> {
    const mod = await import(resolveModule(module)) as Record<string, unknown>
    const fn = mod[probe.export]
    if (typeof fn !== 'function') {
        const exported = Object.keys(mod).filter(k => typeof mod[k] === 'function').join(', ')
        throw new Error(`${module} has no exported function "${probe.export}". Exports: ${exported || '(none)'}`)
    }
    try {
        await (fn as (...a: unknown[]) => unknown)(...args)
        return { ok: true, detail: '' }
    } catch (e) {
        // A THROW IS NOT A FAILURE OF THE RUN. A repository that refuses, or that
        // unwraps a PostgREST error into an exception, is behaving correctly —
        // and in the stranger run it is the expected outcome. What the gate reads
        // is the STATEMENTS, which the seam recorded before the throw.
        return { ok: false, detail: (e as Error).message }
    }
}

async function main() {
    const args = process.argv.slice(2)
    const at = (f: string, d: string) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1] }
    const all = args.includes('--all')
    const outPath = at('--out', '.assay/client-corpus.log')
    const clientsPath = at('--clients', '.assay/clients.json')
    const target = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))[0]
    const dbUrl = at('--db', '') || discover().url || ''

    if (!target && !all) {
        console.error('Usage: assay drive-client <module> | --all')
        process.exit(2)
    }

    const config = loadConfig() as ClientsConfig
    const clientSpec = config.clients?.client
    if (!clientSpec?.module) {
        console.error('✗ .assay/config.json declares no `clients.client`.')
        console.error('  The driver has to authenticate the SAME browser client the modules import;')
        console.error('  it cannot find it by guessing. Add:')
        console.error('    "clients": { "client": { "module": "lib/supabase/client.ts", "export": "supabase" } }')
        process.exit(2)
    }
    const probesPath = config.clients?.probes ?? '.assay/client-probes.json'
    if (!existsSync(join(ROOT, probesPath))) {
        console.error(`✗ No client probes at ${probesPath}. Declare what to call:`)
        console.error('    { "lib/repositories/x.ts": [ { "export": "getMine", "args": [] } ] }')
        process.exit(2)
    }
    const probes = JSON.parse(readFileSync(join(ROOT, probesPath), 'utf8')) as Record<string, ClientProbe | ClientProbe[]>
    const clients = loadClients(join(ROOT, clientsPath))

    const selected = Object.keys(probes).filter(m => all || m === target)
    if (!selected.length) {
        console.error(`No client probe for "${target}". Known: ${Object.keys(probes).join(', ') || '(none)'}`)
        process.exit(2)
    }

    // The seam is off unless the environment says otherwise, and a host's browser
    // client reads its own flag. Both are set here so that a driven module records
    // — and so a host that hardcoded `enabled: false` fails loudly below with an
    // empty corpus rather than quietly with a green one.
    process.env.ASSAY_LEDGER = 'on'
    process.env.NEXT_PUBLIC_ASSAY_LEDGER = 'on'

    const anon = process.env.ASSAY_ANON_KEY ?? readFileSync('/tmp/anon.key', 'utf8').trim()
    const memberEmail = process.env.ASSAY_MEMBER_EMAIL ?? process.env.ASSAY_ADMIN_EMAIL
    const memberPassword = process.env.ASSAY_MEMBER_PASSWORD ?? process.env.ASSAY_ADMIN_PASSWORD
    if (!memberEmail || !memberPassword) {
        console.error('✗ Set ASSAY_MEMBER_EMAIL and ASSAY_MEMBER_PASSWORD (a LOCAL account) so a')
        console.error('  fresh session can be minted. A cached token expires into a 401, and a 401')
        console.error('  reads as a legitimate refusal — a stale token turns the sweep green.')
        process.exit(2)
    }

    // Which of the selected modules make a claim that only a second persona can
    // check. Decided BEFORE anything is driven, so the missing-credentials failure
    // arrives before the writes rather than after them.
    const needStranger = selected.filter(m => deniesStrangers(clients.clients[m]?.visibility))
    const strangerEmail = process.env.ASSAY_STRANGER_EMAIL
    const strangerPassword = process.env.ASSAY_STRANGER_PASSWORD
    if (needStranger.length && !(strangerEmail && strangerPassword)) {
        console.error(`✗ ${needStranger.length} selected module(s) declare a visibility that denies strangers:`)
        for (const m of needStranger) console.error(`    ${m}  (${clients.clients[m].visibility})`)
        console.error('')
        console.error('  Checking that claim means driving them as an UNRELATED member, so set')
        console.error('  ASSAY_STRANGER_EMAIL and ASSAY_STRANGER_PASSWORD (a second LOCAL account')
        console.error('  that owns none of this data).')
        console.error('')
        console.error('  This is not skippable. A caller-scoped claim nobody drove is the thing this')
        console.error('  command exists to stop: it reads as a checked guarantee and is only a sentence.')
        process.exit(2)
    }

    // The disposability guard comes AFTER the configuration checks and before
    // anything is minted or driven: a missing probe file or a missing second
    // persona is a config error, and answering it with "cannot reach the
    // database" sends the reader to look at the wrong thing entirely.
    // These probes call real repository functions, which issue real writes.
    await requireScratch(dbUrl, 'drive client modules')

    const member = await mintSession(memberEmail, memberPassword, anon)
    const stranger = needStranger.length
        ? await mintSession(strangerEmail!, strangerPassword!, anon)
        : null
    if (stranger && stranger.userId === member.userId) {
        console.error('✗ The stranger credentials resolve to the SAME account as the member.')
        console.error(`    both are ${member.userId}`)
        console.error('  Driven that way, "the stranger saw nothing" would only mean the member saw')
        console.error('  nothing either. Use a second account.')
        process.exit(2)
    }

    let clientModule: Record<string, unknown>
    try {
        clientModule = await import(resolveModule(clientSpec.module)) as Record<string, unknown>
    } catch (e) {
        console.error(`✗ Could not import ${clientSpec.module}: ${(e as Error).message}`)
        console.error('  This module is the host\'s browser client, so it reads the host\'s env.')
        console.error('  Run the command with that env loaded, e.g.  bun --env-file=.env.local ...')
        process.exit(2)
    }
    const client = clientModule[clientSpec.export ?? 'supabase'] as AuthedClient | undefined
    if (!client?.auth) {
        console.error(`✗ ${clientSpec.module} exports no supabase client named "${clientSpec.export ?? 'supabase'}".`)
        process.exit(2)
    }

    /** One persona's pass over one module. */
    const run = async (module: string, session: Session, otherId: string, key: string): Promise<Entry[]> => {
        const list = Array.isArray(probes[module]) ? probes[module] as ClientProbe[] : [probes[module] as ClientProbe]
        const entries = await collect(async () => {
            await driveAs(client, session)
            for (const probe of list) {
                // SELF is whoever is driving; OTHER_MEMBER is the other persona.
                // Swapped between the runs, which is what turns one probe into
                // both "act on my own" and "act on someone else's".
                const raw = JSON.stringify(probe.args ?? [])
                    .replace(/"OTHER_MEMBER"/g, JSON.stringify(otherId))
                const resolved = JSON.parse(await resolvePlaceholders(raw, session.userId, dbUrl)) as unknown[]
                const result = await callProbe(module, probe, resolved)
                const label = probe.name ? ` [${probe.name}]` : ''
                console.log(`    ${result.ok ? '·' : '✗'} ${probe.export}${label}${result.ok ? '' : `  threw: ${result.detail}`}`)
            }
        })
        // Attribution is ASSIGNED, not read. The seam labels a browser statement
        // from the call stack, which under this driver names whatever frame
        // happened to be on top — usually the driver itself. The module is the
        // unit being declared and gated, so the module is what the corpus says.
        return entries.map((e, i) => ({ ...e, operation: key, seq: i }))
    }

    let corpus = ''
    const append = (entries: Entry[]) => {
        for (const e of entries) corpus += `${LEDGER_TAG} ${JSON.stringify(e)}\n`
        return entries.length
    }

    for (const module of selected) {
        console.log(`\n▸ ${module}`)
        const own = append(await run(module, member, stranger?.userId ?? member.userId, module))
        console.log(`  as member    ${own} statement(s)`)
        if (!deniesStrangers(clients.clients[module]?.visibility)) {
            const claim = clients.clients[module]?.visibility
            console.log(`  as stranger  skipped — visibility is ${claim ?? 'not declared'}, which asserts nothing`)
            continue
        }
        const other = append(await run(module, stranger!, member.userId, strangerKey(module)))
        console.log(`  as stranger  ${other} statement(s)  → every read must be empty, every write refused`)
        if (!other) {
            // Nothing issued means nothing asserted, and `check` would then have
            // no evidence either way. Said here, where it is still fixable.
            console.log('    ! the stranger run issued NOTHING, so the visibility claim is unexercised.')
            console.log('      A probe that returns early for a caller with no data proves nothing —')
            console.log('      it has to reach the statement for RLS to be the thing that refuses it.')
        }
    }

    writeFileSync(join(ROOT, outPath), corpus)
    const total = corpus.split('\n').filter(Boolean).length
    console.log(`\n${total} statement(s) → ${outPath}`)
    if (!total) {
        console.error('✗ No statements captured from any module.')
        console.error('  The probes ran, so the modules imported — but the seam recorded nothing.')
        console.error('  Check that the host\'s browser client is wrapped in withLedger, and that it')
        console.error('  is not built with `enabled: false` hardcoded.')
        process.exit(1)
    }
    console.log(`Gate it with:  assay check --client-corpus ${outPath}`)
}

// WITHOUT THIS GUARD, IMPORTING THIS MODULE RUNS THE COMMAND — see isEntrypoint.
if (isEntrypoint(import.meta.url)) main()
