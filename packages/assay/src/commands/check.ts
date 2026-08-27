#!/usr/bin/env bun
/**
 * The gate: reconciles an observed corpus against `.assay/operations.json` and
 * FAILS when an operation did something it was not declared to do.
 *
 * ## Why this is a hard failure and not a warning
 *
 * The declaration is only worth anything if it cannot drift. A warning is a
 * declaration that rots on a schedule: the write set stays green while the code
 * grows past it, and the report keeps reading as "all clear" — which is worse
 * than having no write set, because it is believed. So an undeclared WRITE exits
 * non-zero. Accepting a new one is a deliberate act (`ledger-declare --write`)
 * that shows up as a reviewable three-line diff.
 *
 * ## The severity model
 *
 * ERROR — the effect gate. Deny-by-default on anything that changes the world:
 *   - a write to an undeclared table
 *   - a call to an undeclared Postgres function (it may write)
 *   - RLS newly bypassed — a security-relevant change in blast radius
 *   - an UPDATE/DELETE with nothing constraining which rows it hits
 *   - an operation with no declaration at all
 *
 * WARN — read drift. A new read widens coupling but changes nothing, so it does
 *   not block by default. `--strict` promotes it.
 *
 * NOTE — declared but not observed. NEVER an error: a corpus only contains what
 *   was exercised, so absence is almost always missing coverage rather than dead
 *   declaration. Treating it as failure would make the gate punish partial runs,
 *   and the first thing anyone would do is stop running it.
 *
 * Usage:
 *   assay check corpus.log
 *   assay check corpus.log --strict --json
 */

import { loadRpcMap, printNotCovered, readCorpus, summarise } from '../lib/corpus.ts'
import { loadDeclarations, type Declaration } from './declare.ts'

type Severity = 'error' | 'warn' | 'note'

interface Finding {
    severity: Severity
    operation: string
    kind: string
    detail: string
    /** What to do about it. An agent acts on this; a person reads it. */
    remedy: string
}

const ACCEPT = 'assay declare <corpus> --write'

import { isEntrypoint } from '../lib/paths.ts'

function main() {
    const args = process.argv.slice(2)
    const strict = args.includes('--strict')
    const asJson = args.includes('--json')
    const at = (flag: string, fallback: string) => {
        const i = args.indexOf(flag)
        return i === -1 ? fallback : args[i + 1]
    }
    const declPath = at('--declarations', '.assay/operations.json')
    const rpcMapPath = at('--rpc-map', '.assay/rpc-writes.json')
    const file = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))[0]
    // Operations this run MUST have exercised. Without it, changing an operation and
    // never driving it exits 0: the operation is simply absent from the corpus, and
    // absence is indistinguishable from clean. The prose says "unchecked, not clean";
    // the EXIT CODE is what an agent and CI read, so it has to say so too.
    const required = args.reduce<string[]>((acc, a, i) => (a === '--require' ? [...acc, args[i + 1]] : acc), [])

    const { map: rpcMap, loaded } = loadRpcMap(rpcMapPath)
    if (!loaded) {
        console.error(`✗ No RPC write map at ${rpcMapPath} — every write done inside a Postgres`)
        console.error('  function would be invisible, so this check would pass by not looking.')
        console.error('    assay rpc-map > .assay/rpc-writes.json')
        process.exit(2)
    }

    const declarations = loadDeclarations(declPath)
    if (!Object.keys(declarations.operations).length) {
        console.error(`✗ No declarations at ${declPath}. Generate them first:`)
        console.error(`    ${ACCEPT}`)
        process.exit(2)
    }

    const entries = readCorpus(file)
    const summaries = summarise(entries, rpcMap)
    // Keying rules need the raw statements: a summary keeps the union of filters,
    // which loses WHICH table each filter belonged to.
    const entriesByOperation = new Map<string, typeof entries>()
    for (const e of entries) entriesByOperation.set(e.operation, [...(entriesByOperation.get(e.operation) ?? []), e])
    const findings: Finding[] = []

    for (const s of summaries) {
        if (s.operation === 'unattributed') {
            findings.push({
                severity: 'warn', operation: s.operation, kind: 'unattributed',
                detail: `${s.statements} statement(s) could not be attributed to an operation`,
                remedy: 'Pass an operation label to createSupabaseServerClient/createAdminClient at that call site.',
            })
            continue
        }

        // A statement the database REFUSED on privilege or policy grounds.
        //
        // Not the same as any other errored statement, and this is the one case
        // where the distinction is the whole point. A constraint violation is
        // data — a driven probe legitimately hits one, and failing on it would
        // punish coverage. A privilege refusal is STRUCTURAL: the operation is
        // not allowed to do what it was written to do, and no amount of data
        // makes it work. `permission denied for table members` broke profile
        // completion for a month and the admin activate button for longer.
        //
        // Until this existed, a corpus containing that exact line passed the
        // gate with `0 error(s)` — verified by reintroducing the bug. Everything
        // else about the run was green: the route answered, the statement was
        // recorded, the declaration matched, and `report` printed the refusal
        // where nothing was reading.
        //
        // Errored statements are excluded from the read/write SETS (a rejected
        // statement touched nothing), so this reads e.errors, which keeps them.
        for (const error of s.errors) {
            if (!/permission denied|violates row-level security|must be owner of/i.test(error)) continue
            findings.push({
                severity: 'error', operation: s.operation, kind: 'statement-denied',
                detail: `the database refused a statement: ${error}`,
                remedy:
                    'A privilege or policy refusal is a deploy-time fault, not a data one. Check the ' +
                    'column grants for the columns this statement NAMES — Postgres checks the grant ' +
                    'against the column list, not the values, so a defaulted column still needs it.',
            })
        }

        const declared: Declaration | undefined = declarations.operations[s.operation]
        if (!declared) {
            findings.push({
                severity: 'error', operation: s.operation, kind: 'undeclared-operation',
                detail: `no declaration; observed writes=[${s.writes.join(', ')}] reads=[${s.reads.join(', ')}]`,
                remedy: `Review what it touches, then accept with: ${ACCEPT}`,
            })
            continue
        }

        for (const table of s.writes.filter(t => !declared.writes.includes(t))) {
            findings.push({
                severity: 'error', operation: s.operation, kind: 'undeclared-write',
                detail: `writes "${table}"${s.writesViaRpc.includes(table) ? ' (via rpc)' : ''}, which is not declared`,
                remedy: `If intended, accept with: ${ACCEPT}`,
            })
        }
        for (const fn of s.rpcs.filter(f => !declared.rpc.includes(f))) {
            findings.push({
                severity: 'error', operation: s.operation, kind: 'undeclared-rpc',
                detail: `calls "${fn}", which is not declared (a function may write)`,
                remedy: `Check what it writes with assay/src/commands/rpc-map.ts, then: ${ACCEPT}`,
            })
        }
        if (s.serviceRole && !declared.rlsBypassed) {
            findings.push({
                severity: 'error', operation: s.operation, kind: 'rls-newly-bypassed',
                detail: 'ran with RLS bypassed (service role) but is declared as policy-enforced',
                remedy: 'This widens blast radius. Confirm it needs service role before accepting.',
            })
        }
        for (const u of s.unfilteredWrites) {
            findings.push({
                severity: 'error', operation: s.operation, kind: 'unfiltered-write',
                detail: `${u.verb.toUpperCase()} on "${u.target}" with nothing constraining which rows it hits`,
                remedy: 'Add a filter, or confirm the whole-table effect is intended.',
            })
        }
        // KEYING VIOLATION — the operation constrained a column it is forbidden to
        // key on. This is the one check whose rule cannot be derived from a corpus:
        // observation can say what an operation keyed on, never what it must not.
        for (const rule of declared.mustNotFilterOn ?? []) {
            const [table, column] = rule.split('.')
            // NOTE the missing `!e.error`, which every other check has. Read/write
            // SETS must exclude failed statements — nothing was touched. A
            // PROHIBITION is the opposite: the code TRIED to key on a forbidden
            // column, and that the database happened to reject it is luck, not
            // compliance. The first version of this check skipped errored rows and
            // silently passed a real violation.
            const hit = s.statements > 0 && (entriesByOperation.get(s.operation) ?? [])
                .some(e => e.target === table && e.filters.includes(column))
            if (!hit) continue
            findings.push({
                severity: 'error', operation: s.operation, kind: 'forbidden-keying',
                detail: `keys "${table}" on "${column}", which this operation must not do`
                    + (declared.keyingWhy ? ` — ${declared.keyingWhy}` : ''),
                remedy: 'Resolve by a stable identifier instead. If the rule is wrong, change it deliberately in .assay/operations.json.',
            })
        }

        for (const fn of declared.mustNotCall ?? []) {
            const called = (entriesByOperation.get(s.operation) ?? [])
                .some(e => e.verb === 'rpc' && e.target === fn)
            if (!called) continue
            findings.push({
                severity: 'error', operation: s.operation, kind: 'forbidden-call',
                detail: `calls "${fn}", which this operation must not do`
                    + (declared.keyingWhy ? ` — ${declared.keyingWhy}` : ''),
                remedy: 'Resolve by a stable identifier instead.',
            })
        }

        // ORDERING — a call permitted only as a fallback. Checked over the
        // operation's statements in `seq` order: a fallback is preceded by the
        // stable-id attempt, a first resort is not. That distinction is the whole
        // reason this exists instead of a blanket prohibition.
        for (const [call, rule] of Object.entries(declared.mustFollow ?? {})) {
            const ordered = [...(entriesByOperation.get(s.operation) ?? [])].sort((a, b) => a.seq - b.seq)
            const window = rule.within ?? 10
            for (let i = 0; i < ordered.length; i++) {
                const e = ordered[i]
                if (e.target !== call || e.error) continue
                const preceded = ordered.slice(Math.max(0, i - window), i).some(p =>
                    p.target === rule.after.target && !p.error &&
                    (!rule.after.anyFilter?.length || rule.after.anyFilter.some(f => p.filters.includes(f))))
                if (preceded) continue
                findings.push({
                    severity: 'error', operation: s.operation, kind: 'not-a-fallback',
                    detail: `calls "${call}" without a preceding ${rule.after.target}`
                        + (rule.after.anyFilter ? ` lookup on ${rule.after.anyFilter.join('/')}` : '')
                        + ` — permitted only as a fallback` + (rule.why ? ` — ${rule.why}` : ''),
                    remedy: 'Try the stable identifier first, then fall back.',
                })
                break
            }
        }

        // A read that came back at exactly the cap with no continuation page. This
        // is the signature of the silent truncation PostgREST does at db-max-rows:
        // the caller believes it read the table and got page 1.
        for (const hit of s.capHits) {
            findings.push({
                severity: strict ? 'error' : 'warn', operation: s.operation, kind: 'suspected-truncated-read',
                detail: `read "${hit.target}" returned exactly ${1000} rows with no continuation page`,
                remedy: 'Use selectAllRows/streamAllPages, or confirm the table holds exactly that many rows.',
            })
        }
        // Magnitude drift. A WARNING, never an error: an operation legitimately
        // doing more work as data grows must not block a merge. But it is the
        // dimension a table-set diff cannot show, so it has to be visible.
        if (declared.profile && s.profile) {
            if (declared.profile.statements !== s.profile.statements) {
                findings.push({
                    severity: 'warn', operation: s.operation, kind: 'statement-count-drift',
                    detail: `issues ${s.profile.statements} statements, declared ${declared.profile.statements}`,
                    remedy: `Expected if the data grew or a loop changed. Accept with: ${ACCEPT}`,
                })
            }
            for (const [t, b] of Object.entries(s.profile.rows)) {
                const was = declared.profile.rows[t]
                if (was && was !== b) {
                    findings.push({
                        severity: 'warn', operation: s.operation, kind: 'row-count-drift',
                        detail: `reads ${b} rows from "${t}", declared ${was}`,
                        remedy: `Accept with: ${ACCEPT}`,
                    })
                }
            }
        }
        // A new external endpoint is a real change in blast radius — the operation
        // now depends on a service it did not before — so this is an ERROR, not the
        // warning an added table read gets.
        for (const endpoint of s.calls.filter(c => !(declared.calls ?? []).includes(c))) {
            findings.push({
                severity: 'error', operation: s.operation, kind: 'undeclared-call',
                detail: `calls "${endpoint}", which is not declared`,
                remedy: `If intended, accept with: ${ACCEPT}`,
            })
        }
        for (const table of s.reads.filter(t => !declared.reads.includes(t))) {
            findings.push({
                severity: strict ? 'error' : 'warn', operation: s.operation, kind: 'undeclared-read',
                detail: `reads "${table}", which is not declared`,
                remedy: `Widens coupling but changes nothing. Accept with: ${ACCEPT}`,
            })
        }
    }

    for (const op of required) {
        if (summaries.some(s => s.operation === op && s.statements > 0)) continue
        findings.push({
            severity: 'error', operation: op, kind: 'not-exercised',
            detail: 'was required but issued no statements in this corpus',
            remedy: `Drive it before gating: bun run assay:drive ${op} --out /tmp/c.log — or add a probe that reaches the branch you changed.`,
        })
    }

    // Coverage, as a NOTE. Never fails the gate.
    const observed = new Set(summaries.map(s => s.operation))
    const unexercised = Object.keys(declarations.operations).filter(o => !observed.has(o))

    const errors = findings.filter(f => f.severity === 'error')
    const warns = findings.filter(f => f.severity === 'warn')

    if (asJson) {
        console.log(JSON.stringify({ findings, unexercised, errors: errors.length, warnings: warns.length }, null, 2))
        process.exit(errors.length ? 1 : 0)
    }

    const icon: Record<Severity, string> = { error: '✗', warn: '!', note: '·' }
    for (const f of [...errors, ...warns]) {
        console.log(`${icon[f.severity]} ${f.operation}`)
        console.log(`    ${f.detail}`)
        console.log(`    → ${f.remedy}`)
    }

    console.log(`\n${errors.length} error(s), ${warns.length} warning(s) across ${summaries.length} observed operation(s).`)
    if (!errors.length && !warns.length) printNotCovered()
    if (unexercised.length) {
        // The remainder, said out loud: these were NOT checked.
        console.log(`· ${unexercised.length} declared operation(s) not exercised by this corpus — unchecked, not clean:`)
        console.log(`    ${unexercised.join(', ')}`)
    }
    process.exit(errors.length ? 1 : 0)
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