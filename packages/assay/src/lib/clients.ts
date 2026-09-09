/**
 * Client modules: the browser-side data path, brought under the gate.
 *
 * ## The gap this closes
 *
 * An assay OPERATION is a request the backend serves. A statement issued by the
 * BROWSER — a repository or service module calling PostgREST or an `rpc` through
 * the browser client — is not one, so it has no declaration, no probe, and no
 * way into a corpus. `assay check` therefore says nothing about it. On the
 * project this was written for that is ~40 modules naming 89 Postgres functions:
 * the dominant data path, guarded by RLS and exercised by nothing.
 *
 * A client module is declared the same way an operation is, and for the same
 * reason: the derived half (`reads`/`writes`/`rpc`) comes from
 * `assay unattributed`, which already finds exactly these modules statically,
 * and the hand-written half says what no observation can.
 *
 * ## `visibility` is the point of the whole feature
 *
 * The other three fields are a blast-radius ratchet, and they are worth having.
 * They are not why this exists. `visibility: "caller-scoped"` is a claim about
 * RLS — *driven as an unrelated member, every read returns nothing and every
 * write is refused* — and nothing in this repository, or in a host's UI tests,
 * checks it today. A policy that stops filtering, a `SECURITY DEFINER` function
 * that stops checking `auth.uid()`, a table whose grants widen: all silent.
 *
 * So the gate treats a module carrying `caller-scoped` and NO stranger run as an
 * ERROR rather than as coverage it happens to lack. A visibility check that has
 * never been driven is a claim, not a check.
 */

import { readFileSync } from 'node:fs'
import { summarise, WRITE_VERBS, type Entry, type Finding, type RpcMap } from './corpus.ts'

/**
 * What the module is allowed to expose, to whom.
 *
 *   caller-scoped  a stranger sees nothing and writes nothing. The claim RLS is
 *                  supposed to make good on, and the one this drives.
 *   admin-only     same assertion from a non-admin's side: a plain member gets
 *                  nothing. Distinct from caller-scoped in INTENT — the rows are
 *                  not the caller's, they are nobody's but an admin's — and the
 *                  observable obligation is identical, so it is driven the same.
 *   public         deliberately readable by anyone. Asserts NOTHING, and is
 *                  written down precisely so the absence of a check is a decision
 *                  someone made rather than a field nobody filled in.
 */
export type Visibility = 'caller-scoped' | 'admin-only' | 'public'

/** Visibilities that oblige a stranger run. `public` is the only one that does not. */
export const deniesStrangers = (v: Visibility | undefined): boolean =>
    v === 'caller-scoped' || v === 'admin-only'

export interface ClientDeclaration {
    /** Tables read directly. Derived by `assay unattributed --emit`. */
    reads: string[]
    /** Tables written directly from the browser. Derived. */
    writes: string[]
    /** Postgres functions called from the browser. Derived. */
    rpc: string[]
    /** HAND-WRITTEN. The claim no other tool can make — see the module comment. */
    visibility?: Visibility
    /** Why this visibility, so a later reader can tell intent from a default. */
    why?: string
}

export interface ClientsFile {
    version: 1
    clients: Record<string, ClientDeclaration>
}

/**
 * How a stranger-driven run is labelled in the corpus.
 *
 * A suffix on the operation name, NOT a new field on the ledger entry. The
 * corpus format is what `check`, `report`, `declare` and `diff` all consume, and
 * the plan this implements is explicit that a client corpus must be
 * byte-compatible with what they already read. `summarise` groups by operation
 * string, so `lib/repositories/x.ts#stranger` summarises independently and maps
 * back to its module by stripping the suffix — no format change, no reader to
 * update.
 */
export const STRANGER = '#stranger'

export const strangerKey = (module: string): string => `${module}${STRANGER}`
export const isStranger = (operation: string): boolean => operation.endsWith(STRANGER)
export const moduleOf = (operation: string): string =>
    isStranger(operation) ? operation.slice(0, -STRANGER.length) : operation

const EMPTY: ClientsFile = { version: 1, clients: {} }

export function loadClients(path: string): ClientsFile {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as ClientsFile
        return { version: 1, clients: parsed.clients ?? {} }
    } catch {
        return structuredClone(EMPTY)
    }
}

/** The fields `unattributed --emit` derives. Everything else was written by a human. */
const DERIVED = ['reads', 'writes', 'rpc'] as const

/**
 * Merge a fresh static scan into the existing declarations.
 *
 * Derived sets are REPLACED, not unioned — and that is the opposite of what
 * `declare` does to an operation, deliberately. A corpus is evidence of what an
 * operation CAN do, so unioning is the only honest merge there. This scan is
 * STATIC AND TOTAL over the repository: if a module no longer reads a table, the
 * repository no longer contains that read, and carrying it forward would widen
 * the allowance for a statement nobody can write any more.
 *
 * Hand-written fields are carried through by EXCLUSION rather than by an
 * allowlist, for the reason `declare.stable` records: an allowlist silently
 * deletes the one field nobody thought to name.
 */
export function mergeClients(
    current: ClientsFile,
    sites: Array<{ file: string; reads: string[]; writes: string[]; rpcs: string[] }>,
): { next: ClientsFile; added: string[]; removed: string[]; changed: string[] } {
    const next: ClientsFile = { version: 1, clients: {} }
    const added: string[] = []
    const changed: string[] = []

    for (const site of [...sites].sort((a, b) => a.file.localeCompare(b.file))) {
        const before = current.clients[site.file]
        const derived = {
            reads: [...site.reads].sort(),
            writes: [...site.writes].sort(),
            rpc: [...site.rpcs].sort(),
        }
        if (!before) added.push(site.file)
        else if (DERIVED.some(f => JSON.stringify(before[f] ?? []) !== JSON.stringify(derived[f]))) {
            changed.push(site.file)
        }
        next.clients[site.file] = { ...(before ?? {}), ...derived }
    }

    // A module that no longer touches the database at all. Dropped — but NAMED,
    // because dropping it also drops a hand-written `visibility`, and a claim
    // disappearing from a file is exactly the kind of quiet loss this tool exists
    // to make loud.
    const removed = Object.keys(current.clients).filter(k => !(k in next.clients)).sort()
    return { next, added, removed, changed }
}

/** Stable field order and sorted keys, so the file diffs line-by-line. */
export function stableClients(file: ClientsFile): string {
    const clients: Record<string, ClientDeclaration> = {}
    for (const key of Object.keys(file.clients).sort()) {
        const d = file.clients[key] as ClientDeclaration & Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(d)) {
            if (d[k] === undefined) continue
            out[k] = DERIVED.includes(k as typeof DERIVED[number])
                ? [...(d[k] as string[])].sort()
                : d[k]
        }
        for (const k of DERIVED) if (!(k in out)) out[k] = []
        clients[key] = out as unknown as ClientDeclaration
    }
    return JSON.stringify({ version: 1, clients }, null, 2) + '\n'
}

const ACCEPT = 'assay unattributed --emit'

/**
 * The gate over a client corpus.
 *
 * Mirrors the operation gate on the three derived sets, and adds the one check
 * that only exists here: `visibility`.
 *
 * Pure over `entries` so it can be tested without a database — which is the only
 * way the visibility check itself gets tested at all, since reproducing an RLS
 * hole needs a live stack.
 */
export function checkClients(
    entries: Entry[],
    file: ClientsFile,
    rpcMap: RpcMap,
    options: { strict?: boolean } = {},
): { findings: Finding[]; unexercised: string[] } {
    const strict = options.strict ?? false
    const findings: Finding[] = []
    const summaries = summarise(entries, rpcMap)
    const byOperation = new Map<string, Entry[]>()
    for (const e of entries) byOperation.set(e.operation, [...(byOperation.get(e.operation) ?? []), e])

    for (const s of summaries) {
        const module = moduleOf(s.operation)
        const declared = file.clients[module]
        if (!declared) {
            findings.push({
                severity: 'error', operation: s.operation, kind: 'undeclared-client-module',
                detail: `no declaration; observed writes=[${s.writes.join(', ')}] reads=[${s.reads.join(', ')}]`,
                remedy: `Regenerate the derived sets with: ${ACCEPT}`,
            })
            continue
        }

        // RLS INERT. The failure this feature is most likely to ship with, and it
        // has already happened once in this repository ("drove as the wrong
        // account, so its whole point was inert"). Under service role every policy
        // is off, so a green visibility check would prove precisely nothing —
        // worse than no check, because it is believed.
        if (s.serviceRole) {
            findings.push({
                severity: 'error', operation: s.operation, kind: 'client-drove-as-service-role',
                detail: 'these statements ran with RLS bypassed (service role)',
                remedy: 'Drive client probes under a MEMBER JWT. Service role makes every policy inert, '
                    + 'so nothing observed under it says anything about what a member can reach.',
            })
        }

        // A privilege or policy refusal in the module's OWN run — the caller could
        // not do what the code was written to do. Structurally identical to the
        // operation check, and this is the path where it bites hardest: column
        // grants and RLS apply to a browser statement and to nothing else.
        for (const error of s.errors) {
            if (isStranger(s.operation)) continue   // a refusal is the POINT there
            if (!/permission denied|violates row-level security|must be owner of/i.test(error)) continue
            findings.push({
                severity: 'error', operation: s.operation, kind: 'statement-denied',
                detail: `the database refused a statement: ${error}`,
                remedy: 'A privilege or policy refusal is a deploy-time fault, not a data one. Check the '
                    + 'policy and the column grants for the columns this statement names.',
            })
        }

        if (isStranger(s.operation)) {
            // ---- the stranger run: what an UNRELATED member could reach -------
            if (!deniesStrangers(declared.visibility)) continue
            for (const e of byOperation.get(s.operation) ?? []) {
                if (e.verb === 'call') continue
                // A refused statement is the expected outcome, not a finding.
                if (e.error) continue
                if (WRITE_VERBS.has(e.verb)) {
                    findings.push({
                        severity: 'error', operation: module, kind: 'visibility-write-allowed',
                        detail: `declared ${declared.visibility}, but a stranger's ${e.verb.toUpperCase()} `
                            + `on "${e.target}" was ACCEPTED`,
                        remedy: 'An unrelated member wrote a table this module claims is not theirs. '
                            + 'Fix the RLS policy, or change the visibility claim deliberately.',
                    })
                } else if (e.verb === 'rpc') {
                    // Only a WRITING function is judged here. Whether a returned
                    // scalar leaked anything is a question about VALUES, and this
                    // tool does not read values — see NOT_COVERED. Saying nothing
                    // is the honest answer; guessing would make the whole gate
                    // untrustworthy in the direction that matters.
                    const writes = rpcMap[e.target] ?? []
                    if (!writes.length) continue
                    findings.push({
                        severity: 'error', operation: module, kind: 'visibility-write-allowed',
                        detail: `declared ${declared.visibility}, but a stranger's rpc "${e.target}" `
                            + `(writes ${writes.join(', ')}) succeeded`,
                        remedy: 'A SECURITY DEFINER function that does not check auth.uid() is the usual '
                            + 'cause. Fix the function, or change the visibility claim deliberately.',
                    })
                } else if (typeof e.rows === 'number' && e.rows > 0) {
                    findings.push({
                        severity: 'error', operation: module, kind: 'visibility-leak',
                        detail: `declared ${declared.visibility}, but a stranger read ${e.rows} row(s) `
                            + `from "${e.target}"`,
                        remedy: 'RLS returned rows to a member who is not the owner. Read the policy on '
                            + 'that table; a policy that stopped filtering looks exactly like this.',
                    })
                }
            }
            continue
        }

        // ---- the module's own run ------------------------------------------
        for (const table of s.writes.filter(t => !declared.writes.includes(t))) {
            findings.push({
                severity: 'error', operation: module, kind: 'undeclared-write',
                detail: `writes "${table}"${s.writesViaRpc.includes(table) ? ' (via rpc)' : ''}, which is not declared`,
                remedy: `If intended, regenerate with: ${ACCEPT}`,
            })
        }
        for (const fn of s.rpcs.filter(f => !declared.rpc.includes(f))) {
            findings.push({
                severity: 'error', operation: module, kind: 'undeclared-rpc',
                detail: `calls "${fn}", which is not declared (a function may write)`,
                remedy: `Check what it writes with \`assay rpc-map\`, then: ${ACCEPT}`,
            })
        }
        for (const table of s.reads.filter(t => !declared.reads.includes(t))) {
            findings.push({
                severity: strict ? 'error' : 'warn', operation: module, kind: 'undeclared-read',
                detail: `reads "${table}", which is not declared`,
                remedy: `Widens coupling but changes nothing. Accept with: ${ACCEPT}`,
            })
        }
    }

    const observed = new Set(summaries.map(s => s.operation))
    for (const [module, declared] of Object.entries(file.clients)) {
        if (!deniesStrangers(declared.visibility)) {
            if (declared.visibility) continue
            // Generated and never claimed. A warning, not an error: the emit step
            // is meant to be adoptable on a repo with forty of these on day one,
            // and a gate that is red on day one is ignored by day two. The number
            // is what matters — it can only go down.
            if (observed.has(module)) {
                findings.push({
                    severity: strict ? 'error' : 'warn', operation: module, kind: 'visibility-undeclared',
                    detail: 'no `visibility` claim, so nothing about what a stranger can reach is checked',
                    remedy: 'Add "visibility": "caller-scoped" | "admin-only" | "public" to '
                        + '.assay/clients.json. Only a hand-written claim can be checked.',
                })
            }
            continue
        }
        // The claim is made and nothing drove it. NOT a note, unlike an
        // unexercised operation: an undriven `caller-scoped` reads as a checked
        // guarantee in a file whose whole purpose is to carry checked guarantees.
        if (!observed.has(strangerKey(module))) {
            findings.push({
                severity: 'error', operation: module, kind: 'visibility-not-exercised',
                detail: `declared ${declared.visibility}, and no stranger run exercised it — `
                    + 'the claim is unchecked',
                remedy: `Drive it as a second persona: assay drive-client ${module}`,
            })
        }
    }

    const unexercised = Object.keys(file.clients).filter(m => !observed.has(m)).sort()
    return { findings, unexercised }
}
