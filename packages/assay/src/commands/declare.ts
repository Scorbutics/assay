#!/usr/bin/env bun
/**
 * Writes each operation's OBSERVED boundary into `.assay/operations.json`.
 *
 * ## Why generated, not written
 *
 * The declaration is the point of the harness — it is what turns "here is what
 * this operation touched once" into "here is what this operation is ALLOWED to
 * touch", which is what `ledger-check` enforces. But nobody can write those sets
 * by hand for a codebase they did not build, and a declaration written by hand
 * is wrong on day one and rots from there. So the corpus proposes and a human
 * (or an agent) reviews the DIFF — three lines of `+writes: audit_log` rather
 * than four hundred lines of handler.
 *
 * ## Merge, never replace
 *
 * Coverage is always partial: a corpus contains the operations that happened to
 * be exercised. Replacing the file would silently delete the declaration of
 * every operation missing from this run, and the next `ledger-check` would pass
 * because it no longer knows what to check. Operations absent from the corpus
 * are left exactly as they were.
 *
 * Usage:
 *   assay declare corpus.log                 # show the diff
 *   assay declare corpus.log --write         # apply it
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadRpcMap, readCorpus, summarise, type OperationSummary } from '../lib/corpus.ts'

export interface Declaration {
    reads: string[]
    writes: string[]
    rpc: string[]
    /** Outbound HTTP endpoints this operation reaches. */
    calls: string[]
    /** True when the operation runs with RLS policies inert (service role). */
    rlsBypassed: boolean
    /**
     * Banded magnitudes — how MUCH the operation does, not just which tables.
     * The table set is stable under refactor, which is what keeps the gate quiet
     * and is exactly what makes it blind to a change in behaviour. The profile is
     * the dimension that moves when an operation starts doing more work.
     */
    profile?: { statements: string; rows: Record<string, string> }
    /**
     * KEYING RULES — `table.column` pairs this operation must never constrain on.
     *
     * Hand-written intent, not observation. The rest of a declaration says what an
     * operation WAS SEEN doing; this says what it is FORBIDDEN to do, which no
     * amount of observation can tell you. Example: the payment pipeline resolves a
     * member by `stripe_customer_id` / `wix_contact_id` and must never fall back to
     * the login email, so that changing an email cannot orphan a payment — but
     * `qonto_clients.email` stays legal, because that table is keyed by email by
     * design while its migration completes.
     */
    mustNotFilterOn?: string[]
    /**
     * Postgres functions this operation must never call. The rpc counterpart of
     * `mustNotFilterOn`, and the form the rule usually takes in practice: in this
     * codebase "resolve a member by email" is not a column filter at all, it is
     * `get_auth_user_by_email`. A prohibition expressed only over columns would
     * have missed the very regression it was written for.
     */
    mustNotCall?: string[]
    /**
     * ORDERING rules: a call permitted only as a FALLBACK.
     *
     * `mustNotCall` is all-or-nothing, and that was too blunt for the case it was
     * written for. Resolving an EXISTING member by email is the regression that
     * 682b6ed/cdf0348 removed — a since-changed email orphans the payment. But
     * PROVISIONING a new member has no stable id yet, so email is the only key
     * available and forbidding it outright would be wrong.
     *
     * The distinction is visible in the ledger as ORDER: a fallback is preceded
     * by the stable-id attempt; a first resort is not.
     */
    mustFollow?: Record<string, {
        /** The statement that must appear shortly before. */
        after: { target: string; anyFilter?: string[] }
        /** How far back to look. Unbounded would let one early lookup excuse every later call. */
        within?: number
        why?: string
    }>
    /** Why the rule exists, so a future reader can tell intent from accident. */
    keyingWhy?: string
}

export interface DeclarationFile {
    version: 1
    operations: Record<string, Declaration>
}

const EMPTY: DeclarationFile = { version: 1, operations: {} }

export function loadDeclarations(path: string): DeclarationFile {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as DeclarationFile
        return { version: 1, operations: parsed.operations ?? {} }
    } catch {
        return structuredClone(EMPTY)
    }
}

export function declarationOf(s: OperationSummary): Declaration {
    return { reads: s.reads, writes: s.writes, rpc: s.rpcs, calls: s.calls, rlsBypassed: s.serviceRole, profile: s.profile }
}

/** The fields this command DERIVES from a corpus. Everything else was written by a human. */
const DERIVED = ['reads', 'writes', 'rpc', 'calls', 'rlsBypassed', 'profile'] as const

/**
 * Sorted operation order and stable field order, so the file diffs line-by-line
 * rather than wholesale.
 *
 * Two rules, both about the same thing — this file is a REVIEW SURFACE, and a
 * rewrite that touches lines nobody changed costs exactly what the surface is
 * worth:
 *
 *  1. Everything that is NOT derived is carried through untouched, by EXCLUSION
 *     rather than by an allowlist. The allowlist this replaces named four
 *     hand-written fields and missed `why:` — so one `declare --write` deleted
 *     the rationale from every operation in the file, including operations the
 *     corpus never mentioned, since this function rewrites all of them. That
 *     text is the only part of a declaration a corpus can never reconstruct. By
 *     exclusion, a field nobody has thought of yet survives by default, which is
 *     the correct direction for a rule about someone else's writing.
 *
 *  2. Fields keep the ORDER THEY ARRIVED IN, with anything new appended.
 *     Imposing a canonical order instead reformats every entry the first time it
 *     runs — 140 changed lines to express five changed facts.
 */
function stable(file: DeclarationFile): string {
    const operations: Record<string, Declaration> = {}
    for (const key of Object.keys(file.operations).sort()) {
        const d = file.operations[key] as Declaration & Record<string, unknown>
        const value = (k: string): unknown => {
            switch (k) {
                case 'reads': case 'writes': case 'rpc': return [...(d[k] as string[])].sort()
                case 'calls': return [...(d.calls ?? [])].sort()
                // Two hand-written fields are SETS, and a set that keeps
                // insertion order churns the diff on every rewrite.
                case 'mustNotFilterOn': case 'mustNotCall':
                    return Array.isArray(d[k]) ? [...(d[k] as string[])].sort() : d[k]
                default: return d[k]
            }
        }
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(d)) if (d[k] !== undefined) out[k] = value(k)
        // A derived field the entry did not carry yet — a first `calls`, say.
        for (const k of DERIVED) if (!(k in out) && d[k as keyof Declaration] !== undefined) out[k] = value(k)
        if (!('calls' in out)) out.calls = []
        operations[key] = out as unknown as Declaration
    }
    return JSON.stringify({ version: 1, operations }, null, 2) + '\n'
}

function diffLines(before: Declaration | undefined, after: Declaration): string[] {
    if (!before) return [`  NEW  reads=${after.reads.length} writes=${after.writes.length} rpc=${after.rpc.length} calls=${after.calls.length}`]
    const out: string[] = []
    for (const field of ['reads', 'writes', 'rpc', 'calls'] as const) {
        const added = after[field].filter(t => !before[field].includes(t))
        const gone = before[field].filter(t => !after[field].includes(t))
        // A table missing from THIS corpus is not proof it is gone — the run may
        // simply not have taken that branch. Shown, never auto-removed.
        for (const t of added) out.push(`  + ${field}: ${t}`)
        for (const t of gone) out.push(`  ~ ${field}: ${t}  (not seen in this corpus — kept)`)
    }
    if (after.rlsBypassed !== before.rlsBypassed) out.push(`  ! rlsBypassed: ${before.rlsBypassed} → ${after.rlsBypassed}`)
    if (!before.profile && after.profile) {
        // First time this declaration gains a profile. Without this the diff is
        // empty and nothing is written, so the profile silently never lands.
        const rows = Object.entries(after.profile.rows).map(([t, b]) => `${t} ${b}`).join(', ')
        out.push(`  + profile: ${after.profile.statements} statements${rows ? `; ${rows}` : ''}`)
    }
    if (before.profile && after.profile) {
        if (before.profile.statements !== after.profile.statements) {
            out.push(`  ≠ statements: ${before.profile.statements} → ${after.profile.statements}`)
        }
        for (const t of Object.keys(after.profile.rows)) {
            const was = before.profile.rows[t]
            if (was && was !== after.profile.rows[t]) out.push(`  ≠ rows/${t}: ${was} → ${after.profile.rows[t]}`)
        }
    }
    return out
}

import { isEntrypoint } from '../lib/paths.ts'

function main() {
    const args = process.argv.slice(2)
    const write = args.includes('--write')
    const at = (flag: string, fallback: string) => {
        const i = args.indexOf(flag)
        return i === -1 ? fallback : args[i + 1]
    }
    const outPath = at('--out', '.assay/operations.json')
    const rpcMapPath = at('--rpc-map', '.assay/rpc-writes.json')
    const file = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))[0]

    const { map: rpcMap, loaded } = loadRpcMap(rpcMapPath)
    if (!loaded) {
        console.error(`✗ No RPC write map at ${rpcMapPath}.`)
        console.error('  Declaring without it would record every rpc-mutating operation as a READER,')
        console.error('  and ledger-check would then enforce that lie. Build it first:')
        console.error('    assay rpc-map > .assay/rpc-writes.json')
        process.exit(2)
    }

    const summaries = summarise(readCorpus(file), rpcMap)
        .filter(s => s.operation !== 'unattributed')
    const current = loadDeclarations(outPath)
    const next = structuredClone(current)

    let changed = 0
    const report: string[] = []
    for (const s of summaries) {
        const before = current.operations[s.operation]
        const after = declarationOf(s)
        // Union with what was already declared: this corpus is evidence of what
        // CAN happen, not an exhaustive account of what can.
        const merged: Declaration = before
            ? {
                // DECLARED INTENT is carried forward untouched — every field of
                // it, by spreading what was there rather than by naming the
                // fields worth keeping. A corpus cannot express a prohibition or
                // a rationale, so anything this command did not derive is not
                // this command's to drop.
                ...before,
                reads: [...new Set([...before.reads, ...after.reads])].sort(),
                writes: [...new Set([...before.writes, ...after.writes])].sort(),
                rpc: [...new Set([...before.rpc, ...after.rpc])].sort(),
                calls: [...new Set([...(before.calls ?? []), ...after.calls])].sort(),
                rlsBypassed: before.rlsBypassed || after.rlsBypassed,
                // Magnitudes are REPLACED, not unioned: the point is what the
                // operation does now, and a union of magnitudes means nothing.
                profile: after.profile ?? before.profile,
            }
            : after
        const lines = diffLines(before, merged)
        if (lines.length) {
            changed++
            report.push(`▸ ${s.operation}`, ...lines)
        }
        next.operations[s.operation] = merged
    }

    const untouched = Object.keys(current.operations).filter(k => !summaries.some(s => s.operation === k))

    if (!changed) {
        console.log(`No change. ${summaries.length} operations in this corpus already match ${outPath}.`)
        return
    }

    console.log(report.join('\n'))
    console.log(`\n${changed} operation(s) changed, ${untouched.length} left untouched (absent from this corpus).`)

    if (!write) {
        console.log(`\nDry run. Re-run with --write to apply.`)
        return
    }
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, stable(next))
    console.log(`\nWrote ${outPath}. Review the diff before committing — it is the review surface.`)
}

// WITHOUT THIS GUARD, IMPORTING THIS MODULE RUNS THE COMMAND — see isEntrypoint.
if (isEntrypoint(import.meta.url)) main()