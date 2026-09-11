#!/usr/bin/env bun
/**
 * The declaration change, rendered where review actually happens.
 *
 *   assay review --base origin/main                 # markdown, for a PR comment
 *   assay review --base origin/main --json          # the same findings, machine-readable
 *   assay review --base a.json --head b.json        # two files, no git
 *
 * ## Why this exists
 *
 * `.assay/operations.json` is the review surface — that is the claim the README
 * makes, and it was only half true. The file is reviewABLE; nothing rendered it
 * anywhere a reviewer looks. In practice it arrives as a JSON hunk in a diff of
 * forty files, sorted alphabetically rather than by consequence, with
 * `"rlsBypassed": true` sitting on the same visual footing as a reordered read.
 *
 * So this command answers one question — WHAT DID THIS CHANGE DECLARE? — and
 * orders the answer by how much it matters, so the first thing a reviewer reads
 * is the most consequential thing in the change.
 *
 * ## What it is NOT
 *
 * Not a gate. `check` is the gate, and it reconciles a declaration against an
 * observed corpus, which needs a database, a driven run and an environment. This
 * reads two versions of one JSON file. No database, no environment, no driving:
 * it runs in any checkout, in seconds, including one that cannot boot the app.
 *
 * That is the entire point. The gate proves the code matches its declaration.
 * This shows a human what the declaration now SAYS — which is the half no
 * automation can do, because "this operation may now write `audit_log`" is a
 * decision and not a fact.
 *
 * ## The direction that matters
 *
 * Adding to a declaration LOOSENS the gate: `check` denies by default, so a new
 * `writes` entry is permission granted, and it is granted by whoever edited the
 * file — increasingly an agent. Removing TIGHTENS it. The severities here follow
 * that asymmetry and deliberately mirror `check`'s own vocabulary: a widened
 * effect is an error, read drift is a warning, a tightening is a note.
 *
 * The prohibitions get the same treatment in reverse. `mustNotFilterOn`,
 * `mustNotCall` and `mustFollow` are the only fields a corpus can never
 * reconstruct — `declare --write` carries them through untouched by design — so
 * the ONLY way one disappears is that somebody deleted it. That deletion is
 * invisible in a JSON diff and is the single most consequential edit anyone can
 * make to this file. It is reported first.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { NOT_COVERED, type Severity } from '../lib/corpus.ts'
import { parseDeclarations, type Declaration, type DeclarationFile } from './declare.ts'
import { assayPath, isEntrypoint, projectRoot } from '../lib/paths.ts'

/** Stickiness: the workflow finds its own previous comment by this and edits it. */
export const MARKER = '<!-- assay-review -->'

export interface ReviewFinding {
    operation: string
    severity: Severity
    kind: string
    /** One line, already phrased for a reader. Markdown. */
    detail: string
}

const RANK: Record<Severity, number> = { error: 0, warn: 1, note: 2 }

const added = (before: string[] | undefined, after: string[] | undefined) =>
    (after ?? []).filter(x => !(before ?? []).includes(x))

const code = (xs: string[]) => xs.map(x => `\`${x}\``).join(', ')

/**
 * The host an outbound call reaches, from `METHOD host/path/{id}`.
 *
 * A new PATH on a service the operation already talks to is a feature; a new
 * HOST is data leaving for somewhere it has never been. Same field, different
 * questions, so they are not the same severity.
 */
export function hostOf(call: string): string {
    const space = call.indexOf(' ')
    const rest = space === -1 ? call : call.slice(space + 1)
    return rest.split('/')[0] ?? rest
}

/**
 * Compare two declaration files. Pure, so it is testable without a repository.
 *
 * List fields are aggregated to ONE finding per operation per field. One row per
 * added table reads as thorough and renders as a wall: an operation that gained
 * four reads is one fact about that operation, not four.
 */
export function review(before: DeclarationFile, after: DeclarationFile): ReviewFinding[] {
    const found: ReviewFinding[] = []
    const push = (operation: string, severity: Severity, kind: string, detail: string) =>
        found.push({ operation, severity, kind, detail })

    const operations = [...new Set([...Object.keys(before.operations), ...Object.keys(after.operations)])].sort()

    for (const op of operations) {
        const a: Declaration | undefined = before.operations[op]
        const b: Declaration | undefined = after.operations[op]

        if (!a && b) {
            const surface = [
                b.writes.length ? `writes ${code(b.writes)}` : '',
                b.rpc.length ? `rpc ${code(b.rpc)}` : '',
                (b.calls ?? []).length ? `calls ${code(b.calls ?? [])}` : '',
                `${b.reads.length} read(s)`,
            ].filter(Boolean).join(' · ')
            push(op, 'warn', 'new-operation', `**new operation** — ${surface}`)
            // Reported separately rather than folded into the line above: a new
            // operation is ordinary in a feature change and a new operation that
            // runs with policies inert is not, and the second must not inherit
            // the first's severity just because they arrived together.
            if (b.rlsBypassed) push(op, 'error', 'new-operation-rls', '**new operation runs with RLS inert** (service role)')
            continue
        }
        if (a && !b) {
            push(op, 'warn', 'operation-removed', 'no longer declared — deleted, or dropped from the file')
            continue
        }
        if (!a || !b) continue

        // ---- prohibitions: hand-written intent, and the only fields a corpus cannot rebuild
        for (const field of ['mustNotFilterOn', 'mustNotCall'] as const) {
            const gone = added(b[field], a[field])
            const gained = added(a[field], b[field])
            if (gone.length) push(op, 'error', 'prohibition-removed', `**prohibition deleted** — \`${field}\`: ${code(gone)}`)
            if (gained.length) push(op, 'note', 'prohibition-added', `prohibition added — \`${field}\`: ${code(gained)}`)
        }
        const followGone = added(Object.keys(b.mustFollow ?? {}), Object.keys(a.mustFollow ?? {}))
        const followNew = added(Object.keys(a.mustFollow ?? {}), Object.keys(b.mustFollow ?? {}))
        if (followGone.length) push(op, 'error', 'prohibition-removed', `**ordering rule deleted** — \`mustFollow\`: ${code(followGone)}`)
        if (followNew.length) push(op, 'note', 'prohibition-added', `ordering rule added — \`mustFollow\`: ${code(followNew)}`)
        if (a.keyingWhy && !b.keyingWhy) push(op, 'warn', 'rationale-removed', 'the `keyingWhy` rationale was removed')
        else if (a.keyingWhy && b.keyingWhy && a.keyingWhy !== b.keyingWhy) push(op, 'note', 'rationale-changed', 'the `keyingWhy` rationale changed')

        // ---- effect: what the operation may now do to the world
        if (!a.rlsBypassed && b.rlsBypassed) push(op, 'error', 'rls-newly-bypassed', '**now runs with RLS inert** (`rlsBypassed: false → true`)')
        if (a.rlsBypassed && !b.rlsBypassed) push(op, 'note', 'rls-no-longer-bypassed', 'no longer bypasses RLS')

        const newWrites = added(a.writes, b.writes)
        if (newWrites.length) push(op, 'error', 'write-added', `**may now write** ${code(newWrites)}`)
        const newRpc = added(a.rpc, b.rpc)
        if (newRpc.length) push(op, 'error', 'rpc-added', `**may now call** ${code(newRpc)} (a function may write)`)

        const newCalls = added(a.calls, b.calls)
        const knownHosts = new Set((a.calls ?? []).map(hostOf))
        const toNewHost = newCalls.filter(c => !knownHosts.has(hostOf(c)))
        const toKnownHost = newCalls.filter(c => knownHosts.has(hostOf(c)))
        if (toNewHost.length) push(op, 'error', 'call-new-host', `**reaches a new host** — ${code(toNewHost)}`)
        if (toKnownHost.length) push(op, 'warn', 'call-added', `new endpoint on a host it already calls — ${code(toKnownHost)}`)

        // ---- coupling and tightenings
        const newReads = added(a.reads, b.reads)
        if (newReads.length) push(op, 'warn', 'read-added', `may now read ${code(newReads)}`)
        for (const [field, label] of [['writes', 'write'], ['rpc', 'rpc'], ['reads', 'read'], ['calls', 'call']] as const) {
            const gone = added(b[field], a[field])
            if (gone.length) push(op, 'note', `${label}-removed`, `no longer declared to ${label}: ${code(gone)} — this TIGHTENS the gate`)
        }

        // ---- magnitude
        if (a.profile && b.profile && a.profile.statements !== b.profile.statements) {
            push(op, 'note', 'profile-statements', `statements ${a.profile.statements} → ${b.profile.statements}`)
        }
        if (a.profile && b.profile) {
            const moved = Object.keys(b.profile.rows)
                .filter(t => a.profile?.rows[t] && a.profile.rows[t] !== b.profile?.rows[t])
                .map(t => `${t} ${a.profile?.rows[t]} → ${b.profile?.rows[t]}`)
            if (moved.length) push(op, 'note', 'profile-rows', `rows: ${moved.join(', ')}`)
        }
    }

    return found.sort((x, y) => RANK[x.severity] - RANK[y.severity] || x.operation.localeCompare(y.operation))
}

const BANDS: Array<{ severity: Severity; heading: string; blurb: string }> = [
    { severity: 'error', heading: '🔴 Needs a decision', blurb: 'These widen what an operation may do. Granting them is the reviewer\'s call, not the gate\'s.' },
    { severity: 'warn', heading: '🟡 Worth a look', blurb: 'New surface or wider coupling. Changes what is reachable, not what is written.' },
    { severity: 'note', heading: '· Noted', blurb: 'Tightenings and magnitude shifts. Nothing here grants anything.' },
]

export interface RenderContext {
    /** How the two sides were named on the command line. */
    base: string
    head: string
    path: string
    /** Operations present in the base — 0 means this is a first declaration. */
    baseCount: number
    headCount: number
}

export function renderMarkdown(findings: ReviewFinding[], ctx: RenderContext): string {
    const counted = (s: Severity) => findings.filter(f => f.severity === s).length
    const touched = new Set(findings.map(f => f.operation)).size
    const out: string[] = [MARKER, '### assay — what this change declares', '']

    if (!findings.length) {
        out.push(
            `No declared change across **${ctx.headCount} operation(s)**.`,
            '',
            'Every operation touches the same tables, calls the same functions and reaches the same',
            'hosts as on the base. That is not the same as "nothing changed" — a value computed',
            'differently declares identically.',
        )
    } else {
        const tally = [
            counted('error') ? `**${counted('error')} needing a decision**` : '',
            counted('warn') ? `${counted('warn')} worth a look` : '',
            counted('note') ? `${counted('note')} noted` : '',
        ].filter(Boolean).join(' · ')
        out.push(`**${touched} operation(s) changed** — ${tally}`, '')

        for (const band of BANDS) {
            const rows = findings.filter(f => f.severity === band.severity)
            if (!rows.length) continue
            const table = [
                '| operation | change |',
                '| --- | --- |',
                ...rows.map(f => `| \`${f.operation}\` | ${f.detail} |`),
            ]
            // The notes are collapsed: they are real and they are never the
            // reason to stop a merge, so they must not cost the top of the
            // comment on a phone.
            if (band.severity === 'note') {
                out.push(`<details><summary>${band.heading} (${rows.length})</summary>`, '', ...table, '', '</details>', '')
            } else {
                out.push(`#### ${band.heading}`, '', band.blurb, '', ...table, '')
            }
        }
    }

    out.push(
        '---',
        '',
        ctx.baseCount === 0
            ? `First declaration — \`${ctx.path}\` did not exist at \`${ctx.base}\`, so everything here is new by definition.`
            : `Comparing \`${ctx.path}\` between \`${ctx.base}\` and \`${ctx.head}\`.`,
        '',
        'This is a DECLARATION diff: table sets, functions, hosts and banded magnitudes. It never',
        'ran anything. assay does not cover:',
        '',
        ...NOT_COVERED.map(l => `- ${l}`),
    )
    return out.join('\n') + '\n'
}

/**
 * One side of the comparison, from a file path or a git ref.
 *
 * The two failure modes here are NOT the same and conflating them is how this
 * command would come to lie. A ref that does not resolve means the comparison
 * could not be made — exit 2, repair nothing. A ref that resolves but does not
 * carry the file means the file is new, which is a legitimate first run.
 */
function sideOf(spec: string, declPath: string, repoRoot: string): { text: string; absent: boolean } {
    if (existsSync(spec)) return { text: readFileSync(spec, 'utf8'), absent: false }

    const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    try {
        git(['rev-parse', '--verify', '--quiet', `${spec}^{commit}`])
    } catch {
        throw new Error(
            `assay review: "${spec}" is neither a file on disk nor a git ref this checkout can resolve.\n` +
            `  In CI, fetch the base branch first — a shallow clone has no other branches:\n` +
            `    git fetch --no-tags --depth=1 origin <base-branch>:refs/remotes/origin/<base-branch>`,
        )
    }
    try {
        return { text: git(['show', `${spec}:${declPath}`]), absent: false }
    } catch {
        // Resolvable ref, no such file in it: the declaration is new.
        return { text: JSON.stringify({ version: 1, operations: {} }), absent: true }
    }
}

function main() {
    const args = process.argv.slice(2)
    const at = (flag: string, fallback: string) => {
        const i = args.indexOf(flag)
        return i === -1 ? fallback : args[i + 1]
    }
    const asJson = args.includes('--json')
    const base = at('--base', 'origin/main')
    const declFile = at('--path', assayPath('operations.json'))
    const head = at('--head', declFile)
    const failOn = at('--fail-on', 'never')
    if (!['error', 'warn', 'never'].includes(failOn)) {
        console.error(`assay review: --fail-on takes error, warn or never (got "${failOn}")`)
        process.exit(2)
    }

    // `git show` addresses from the REPOSITORY root, and `.assay/` sits at the
    // project root, which is not the same directory in a monorepo. Deriving one
    // from the other by hand is the bug this whole codebase resolves paths to avoid.
    let repoRoot = projectRoot()
    try {
        repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch {
        // Not a git checkout. Only the two-files form can work, and `sideOf`
        // will say so clearly if a ref was passed.
    }
    const repoRelative = relative(repoRoot, resolve(declFile)) || declFile

    let before: DeclarationFile
    let after: DeclarationFile
    let baseAbsent = false
    try {
        const b = sideOf(base, repoRelative, repoRoot)
        baseAbsent = b.absent
        before = parseDeclarations(b.text)
        after = parseDeclarations(sideOf(head, repoRelative, repoRoot).text)
    } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
        return
    }

    const baseCount = Object.keys(before.operations).length
    const headCount = Object.keys(after.operations).length

    // A COMPARISON OF TWO EMPTY FILES IS NOT A CLEAN REVIEW. Rendering "no
    // declared change" here would put a green comment on a pull request that
    // assay never looked at, which is the failure mode this project has already
    // been bitten by once: an emptiness reported as a pass.
    if (!baseCount && !headCount) {
        console.error(`assay review: no operations on either side — ${declFile} is empty or missing at both "${base}" and "${head}".`)
        console.error('  Nothing was examined, so nothing is shown. Declare first:')
        console.error('    assay declare <corpus> --write')
        process.exit(2)
    }

    const findings = review(before, after)
    const ctx: RenderContext = { base, head: head === declFile ? 'the working tree' : head, path: repoRelative, baseCount: baseAbsent ? 0 : baseCount, headCount }

    if (asJson) console.log(JSON.stringify({ findings, base, head, path: repoRelative, baseCount, headCount }, null, 2))
    else console.log(renderMarkdown(findings, ctx))

    const worst = findings.reduce<Severity | null>((w, f) => (w === null || RANK[f.severity] < RANK[w] ? f.severity : w), null)
    if (failOn === 'error' && worst === 'error') process.exit(1)
    if (failOn === 'warn' && (worst === 'error' || worst === 'warn')) process.exit(1)
}

// WITHOUT THIS GUARD, IMPORTING THIS MODULE RUNS THE COMMAND — see isEntrypoint.
if (isEntrypoint(import.meta.url)) main()
