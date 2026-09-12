#!/usr/bin/env bun
/**
 * ONE PAGE SAYING WHAT A RUN ACTUALLY EXAMINED.
 *
 *   assay attest                       # writes .assay/attest.html
 *   assay attest --base origin/main    # include the declaration change
 *   assay attest --json                # the run record behind the page
 *
 * ## The problem this exists for
 *
 * Every other command here prints to a terminal, and increasingly nobody is at
 * that terminal — an agent is. What reaches the person is the agent's sentence
 * about the run: "I ran assay, all green." That sentence is unfalsifiable. It
 * cannot be distinguished from a run that examined nothing, a run of a smaller
 * set of checks, or no run at all.
 *
 * So this writes a FILE. The file is produced by assay from its own output, not
 * composed by whoever is reporting, and it can be opened without rerunning
 * anything. The agent's job shrinks to running one command and handing over the
 * result — and the result says what happened whether or not the agent describes
 * it accurately.
 *
 * ## Three rules that make it an attestation rather than a summary
 *
 * 1. THE STEP LIST IS FIXED, declared below and not selectable from the command
 *    line. A caller cannot run a smaller set and produce the same-looking page.
 *
 * 2. A STEP THAT DID NOT RUN IS RENDERED, with the same weight as one that did
 *    and the reason it could not. Omission is how a report lies without saying
 *    anything false.
 *
 * 3. THE VERDICT IS NEVER `PASS` WHEN A TIER DID NOT RUN. Tier 1 is static and
 *    says nothing about runtime; a green page with no database behind it is
 *    exactly the false comfort the whole project is built against, so that state
 *    has its own word — INCOMPLETE.
 *
 * Each step's raw stdout is carried verbatim. The page is assay's own words.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { discover } from '../lib/db.ts'
import { NOT_COVERED } from '../lib/corpus.ts'
import { commandPath, isEntrypoint, projectRoot } from '../lib/paths.ts'

export type StepState = 'held' | 'contradicted' | 'could-not-run' | 'not-run'

export interface StepRecord {
    /** Which renderer reads this step's findings. Not cosmetic: the page's job is to
     *  show WHAT WAS FOUND, and only the step itself knows the shape of that. */
    id: 'tier1' | 'unattributed' | 'nodes' | 'review' | 'tier2'
    name: string
    /** What a reader needs to know this step was worth running. */
    asks: string
    argv: string[]
    state: StepState
    exit: number | null
    ms: number
    stdout: string
    /** Why a `not-run` step did not run. Empty otherwise. */
    reason: string
    json: unknown
}

export interface RunRecord {
    repo: string
    commit: string
    branch: string
    dirty: boolean
    startedAt: string
    ms: number
    verdict: 'PASS' | 'FAIL' | 'INCOMPLETE' | 'INCONCLUSIVE'
    database: string | null
    steps: StepRecord[]
    coverage: Record<string, string>
}

const git = (args: string[], root: string) => {
    try {
        return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch { return '' }
}

function runStep(id: StepRecord['id'], name: string, asks: string, argv: string[], root: string, parseJson: boolean): StepRecord {
    const t0 = Date.now()
    let stdout = '', exit = 0
    try {
        stdout = execFileSync('bun', argv, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string; status?: number }
        stdout = (err.stdout ?? '') + (err.stderr ?? '')
        exit = typeof err.status === 'number' ? err.status : 1
    }
    let json: unknown = null
    if (parseJson) { try { json = JSON.parse(stdout) } catch { json = null } }
    // The three-outcome discipline, read from the exit code rather than from the
    // text: 1 is a contradiction to repair, 2 is an environment that gave out and
    // must NOT be repaired.
    const state: StepState = exit === 0 ? 'held' : exit === 2 ? 'could-not-run' : 'contradicted'
    // What a person would TYPE, not the resolved module path: these commands are
    // spawned from wherever the package is installed, and printing
    // `/home/.../packages/assay/src/commands/tier1.ts --json` buries the one word
    // that tells a reader what ran.
    const label = ['assay', (argv[0].split('/').pop() ?? '').replace(/\.ts$/, ''), ...argv.slice(1)]
    return { id, name, asks, argv: label, state, exit, ms: Date.now() - t0, stdout, reason: '', json }
}

const skipped = (id: StepRecord['id'], name: string, asks: string, reason: string): StepRecord =>
    ({ id, name, asks, argv: [], state: 'not-run', exit: null, ms: 0, stdout: '', reason, json: null })

/**
 * The verdict, in the order that matters: a contradiction outranks an environment
 * failure, which outranks not having looked, which outranks everything being fine.
 *
 * Exported because the last clause is the rule this whole command exists for, and a
 * rule with no test is a comment.
 */
export function verdictOf(steps: StepRecord[]): RunRecord['verdict'] {
    if (steps.some(s => s.state === 'contradicted')) return 'FAIL'
    if (steps.some(s => s.state === 'could-not-run')) return 'INCONCLUSIVE'
    if (steps.some(s => s.state === 'not-run' && s.name.startsWith('tier'))) return 'INCOMPLETE'
    return 'PASS'
}

export function collect(root: string, base: string | null): RunRecord {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const steps: StepRecord[] = []

    // THE FIXED LIST. Adding a step here is a reviewable change to this file;
    // choosing a subset at the command line is not possible, which is the point.
    steps.push(runStep('tier1', 'tier 1 — static', 'Does every operation on disk carry a declaration, and does the static footprint match it?',
        [commandPath('tier1'), '--json'], root, true))
    steps.push(runStep('unattributed', 'unattributed effects', 'Does any database access belong to no operation at all?',
        [commandPath('unattributed'), '--json'], root, true))
    steps.push(runStep('nodes', 'seam nodes', 'How much of the recorded seam is captured from a real run, and how much is still hand-written?',
        [commandPath('nodes'), '--json'], root, true))
    if (base) {
        steps.push(runStep('review', 'declaration change', `What does this change declare, against ${base}?`,
            [commandPath('review'), '--base', base, '--json'], root, true))
    } else {
        steps.push(skipped('review', 'declaration change', 'What does this change declare?',
            'no --base given, so there was nothing to compare against'))
    }

    // TIER 2 — the only steps that observe anything actually happening.
    const db = (() => { try { return discover() } catch { return { url: null, via: 'no .assay/config.json' } } })()
    if (db.url) {
        steps.push(runStep('tier2', 'tier 2 — drive, gate, invariants', 'Driven against a real database: what did each operation touch, and do the invariants hold on the state it left?',
            [commandPath('verify')], root, false))
    } else {
        steps.push(skipped('tier2', 'tier 2 — drive, gate, invariants',
            'Driven against a real database: what did each operation touch, and do the invariants hold?',
            `no database reachable (${db.via}). Nothing below tier 1 was observed.`))
    }

    const tier1 = steps[0].json as { onDisk?: number; declared?: number; unprobed?: string[]; neverObserved?: string[] } | null
    const coverage: Record<string, string> = {}
    if (tier1) {
        // NOT `X of Y`. On-disk counts EDGE FUNCTIONS (the only thing
        // `declaredOperations()` scans); declarations also cover Next routes, so 59
        // declared against 24 on disk is not a shortfall and must not read as one.
        coverage['edge functions on disk'] = String(tier1.onDisk ?? '—')
        coverage['declarations'] = String(tier1.declared ?? '—')
        coverage['no probe'] = `${tier1.unprobed?.length ?? '—'} nothing can drive`
        coverage['never observed'] = `${tier1.neverObserved?.length ?? '—'} no run has confirmed`
    }
    const t2 = steps.find(s => s.name.startsWith('tier 2'))
    const m = t2?.stdout.match(/corpus:\s*(\d+)\s*statement/)
    coverage['statements captured'] = m ? m[1] : t2?.state === 'not-run' ? 'none — tier 2 did not run' : '—'

    const verdict = verdictOf(steps)

    return {
        repo: git(['rev-parse', '--show-toplevel'], root).split('/').pop() || 'unknown',
        commit: git(['rev-parse', '--short', 'HEAD'], root) || 'unknown',
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], root) || 'unknown',
        dirty: git(['status', '--porcelain'], root).length > 0,
        startedAt, ms: Date.now() - t0, verdict,
        database: db.url ? db.url.replace(/:\/\/[^@]*@/, '://***@') : null,
        steps, coverage,
    }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const STATE_LABEL: Record<StepState, string> = {
    held: 'held', contradicted: 'contradicted', 'could-not-run': 'could not run', 'not-run': 'did not run',
}

const VERDICT_BLURB: Record<RunRecord['verdict'], string> = {
    PASS: 'Every step in the fixed list ran, and each held — for the categories assay covers.',
    FAIL: 'Something contradicted a declaration. The step below says which.',
    INCONCLUSIVE: 'A step could not run. Nothing here is evidence either way — retry, do not repair.',
    INCOMPLETE: 'Nothing contradicted anything, and a tier never ran. This is not a pass.',
}

/* ── FINDINGS, FOLDED ────────────────────────────────────────────────────────
 *
 * The first version of this page carried each step's raw stdout and nothing
 * else, on the theory that verbatim output is what makes it an attestation. It
 * is, and it also made a log viewer: tier 1 printed twenty-four findings of ONE
 * class, four lines each, with the same remedy repeated twenty-four times, and a
 * reader could not tell what they were meant to look at.
 *
 * Verbatim output is the FALLBACK. What a reader sees first is the finding,
 * folded by its class and rendered as a table, because twenty-four instances of
 * one class is one fact about the project and printing it twenty-four times is
 * how the fact gets lost. Each renderer below reads the JSON its command already
 * emits — nothing here is parsed back out of prose.
 */

const table = (headers: string[], rows: string[][]) =>
    `<div class="scroll"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="k"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`

const tags = (xs: string[]) => xs.map(x => `<code class="tag">${esc(x)}</code>`).join(' ')

const byOperation = (issues: Array<{ operation: string; subject?: string }>) => {
    const m = new Map<string, string[]>()
    for (const i of issues) m.set(i.operation, [...(m.get(i.operation) ?? []), i.subject ?? ''].filter(Boolean))
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}

interface Finding { headline: string; body: string }

function tier1Finding(j: Record<string, unknown>): Finding {
    const issues = (j.issues ?? []) as Array<{ severity: string; kind: string; operation: string; subject?: string; remedy: string }>
    const errors = issues.filter(i => i.severity === 'error')
    const byKind = new Map<string, typeof issues>()
    for (const i of issues) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i])
    const never = (j.neverObserved ?? []) as string[]

    const headline = issues.length === 0
        ? `${j.declared} declarations, nothing contradicted.`
        : `${errors.length} error(s), ${issues.length - errors.length} warning(s) across ${byKind.size} class(es).`

    let body = ''
    const writes = byKind.get('undeclared-static-write')
    if (writes?.length) {
        body += `<h4>Code can write tables the declaration does not cover <span class="n">${writes.length}</span></h4>
          <p class="why">${esc(writes[0].remedy)}</p>` +
          table(['operation', 'tables the declaration is missing'],
                byOperation(writes).map(([op, subs]) => [`<code>${esc(op)}</code>`, tags(subs)]))
    }
    const noProbe = byKind.get('no-probe')
    if (noProbe?.length) {
        body += `<h4>No probe, so tier 2 can never drive it <span class="n">${noProbe.length}</span></h4>
          <p class="why">${esc(noProbe[0].remedy)}</p><p>${tags(noProbe.map(i => i.operation))}</p>`
    }
    const undeclared = byKind.get('undeclared-operation')
    if (undeclared?.length) {
        body += `<h4>On disk with no declaration at all <span class="n">${undeclared.length}</span></h4>
          <p>${tags(undeclared.map(i => i.operation))}</p>`
    }
    if (never.length) {
        body += `<h4>Declared, never observed by any run <span class="n">${never.length}</span></h4>
          <p class="why">A declaration no corpus has confirmed. Not a failure — a claim nothing has tested.</p>
          <p>${tags(never)}</p>`
    }
    if (j.staticCrawlFailed) {
        body += `<p class="reason">The static crawl did not run: <code>${esc(String(j.staticCrawlFailed))}</code> — the footprint comparison was skipped, so this step proves less than a clean one.</p>`
    }
    return { headline, body }
}

function unattributedFinding(j: Record<string, unknown>): Finding {
    const sites = (j.sites ?? []) as Array<{ file: string; reads: string[]; writes: string[]; rpcs: string[]; writesViaRpc: string[] }>
    const writers = sites.filter(s => s.writes.length || s.writesViaRpc.length)
    const headline = sites.length === 0
        ? `Nothing: every statement in ${j.scanned} scanned file(s) belongs to an operation.`
        : `${sites.length} module(s) the BROWSER runs issue statements no operation owns — ${writers.length} of them WRITE. ${j.scanned} file(s) scanned.`
    // Writers first: a browser read widens coupling, a browser write changes the
    // world from outside every gate assay has.
    const ordered = [...writers, ...sites.filter(s => !writers.includes(s))]
    const body = sites.length
        ? `<p class="why">A statement issued from the browser has no operation, so it has no declaration, no probe and no way into a corpus. A clean tier 2 says nothing about these.</p>` +
          table(['module', 'writes', 'reads', 'rpc'], ordered.map(s => [
              `<code>${esc(s.file)}</code>`,
              s.writes.length || s.writesViaRpc.length ? `<span class="bad">${tags([...s.writes, ...s.writesViaRpc])}</span>` : '<span class="muted">—</span>',
              s.reads.length ? tags(s.reads) : '<span class="muted">—</span>',
              s.rpcs.length ? tags(s.rpcs) : '<span class="muted">—</span>',
          ]))
        : ''
    return { headline, body }
}

function nodesFinding(j: Record<string, unknown>): Finding {
    const rows = (j.rows ?? []) as Array<{ id: string }>
    const hand = (j.handwritten ?? []) as string[]
    const unc = (j.uncaptured ?? []) as string[]
    const headline = `${rows.length} seam node(s) · ${hand.length} still hand-written · ${unc.length} never captured from a real run.`
    let body = ''
    if (unc.length) {
        body += `<h4>Never captured from a real run <span class="n">${unc.length}</span></h4>
          <p class="why">Its shape came from somebody's idea of the payload, not from the third party. If it is wrong, everything downstream is confidently wrong.</p>
          <p>${tags(unc)}</p>`
    }
    if (hand.length) {
        body += `<h4>Hand-written <span class="n">${hand.length}</span></h4>
          <p class="why">Invented data. The count is the only thing that keeps that visible.</p>
          <p>${tags(hand)}</p>`
    }
    return { headline, body }
}

function reviewFinding(j: Record<string, unknown>): Finding {
    const f = (j.findings ?? []) as Array<{ operation: string; severity: string; detail: string }>
    if (!f.length) return { headline: `No declared change across ${j.headCount} operation(s).`, body: '' }
    const rank: Record<string, number> = { error: 0, warn: 1, note: 2 }
    const sorted = [...f].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
    const n = (s: string) => f.filter(x => x.severity === s).length
    return {
        headline: `${new Set(f.map(x => x.operation)).size} operation(s) changed — ${n('error')} needing a decision, ${n('warn')} worth a look, ${n('note')} noted.`,
        body: table(['operation', 'change'], sorted.map(x => [
            `<code>${esc(x.operation)}</code>`,
            `<span class="sev" data-s="${esc(x.severity)}">${esc(x.detail.replace(/\*\*/g, '').replace(/`/g, ''))}</span>`,
        ])),
    }
}

export function findingOf(s: StepRecord): Finding | null {
    if (!s.json || typeof s.json !== 'object') return null
    const j = s.json as Record<string, unknown>
    try {
        if (s.id === 'tier1') return tier1Finding(j)
        if (s.id === 'unattributed') return unattributedFinding(j)
        if (s.id === 'nodes') return nodesFinding(j)
        if (s.id === 'review') return reviewFinding(j)
    } catch { return null }
    return null
}

export function renderHtml(r: RunRecord): string {
    const step = (s: StepRecord) => {
        const f = findingOf(s)
        return `
      <section class="step" data-state="${s.state}">
        <header>
          <h3>${esc(s.name)}</h3>
          <span class="chip" data-state="${s.state}">${STATE_LABEL[s.state]}</span>
        </header>
        <p class="asks">${esc(s.asks)}</p>
        ${f ? `<p class="headline">${esc(f.headline)}</p>` : ''}
        ${s.reason ? `<p class="reason">${esc(s.reason)}</p>` : ''}
        ${f?.body ?? ''}
        ${s.argv.length ? `<p class="cmd"><code>${esc(s.argv.join(' '))}</code><span class="ms">${s.ms} ms · exit ${s.exit}</span></p>` : ''}
        ${s.stdout.trim() ? `<details><summary>${f ? 'the same thing, as assay printed it' : "assay's output"} (${s.stdout.split('\n').length} lines)</summary><pre>${esc(s.stdout.trim())}</pre></details>` : ''}
      </section>`
    }

    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>assay · ${esc(r.repo)} · ${esc(r.commit)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --ground:#f4f6f4; --surface:#fbfcfb; --edge:#dfe4e0; --ink:#18211d; --ink-soft:#5c6862; --ink-faint:#8a958f;
  --accent:#8a5d12; --accent-soft:#f0e6d4;
  --held:#2f6b46; --contradicted:#a33527; --unrun:#5b6b7a;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:"IBM Plex Sans",system-ui,-apple-system,Segoe UI,sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#111614; --surface:#171e1b; --edge:#2a3430; --ink:#e6ebe7; --ink-soft:#9daaa3; --ink-faint:#6d7a74;
  --accent:#d9a441; --accent-soft:#2c2418;
  --held:#6fbf8e; --contradicted:#e8867a; --unrun:#8ea2b4;
}}
:root[data-theme="dark"]{
  --ground:#111614; --surface:#171e1b; --edge:#2a3430; --ink:#e6ebe7; --ink-soft:#9daaa3; --ink-faint:#6d7a74;
  --accent:#d9a441; --accent-soft:#2c2418;
  --held:#6fbf8e; --contradicted:#e8867a; --unrun:#8ea2b4;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.5;
  padding-inline:20px;padding-block:32px 64px}
.wrap{max-width:60rem;margin:0 auto;display:flex;flex-direction:column;gap:28px}
.eyebrow{font-family:var(--mono);font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint);margin:0}
h1{font-size:clamp(1.6rem,4vw,2.1rem);margin:.2em 0 0;text-wrap:balance;font-weight:600;letter-spacing:-.015em}
.verdict{display:flex;flex-direction:column;gap:6px;border-left:4px solid var(--v);padding:2px 0 2px 18px}
.verdict[data-v="PASS"]{--v:var(--held)} .verdict[data-v="FAIL"]{--v:var(--contradicted)}
.verdict[data-v="INCOMPLETE"],.verdict[data-v="INCONCLUSIVE"]{--v:var(--unrun)}
.verdict p{margin:0;color:var(--ink-soft);max-width:60ch}
.meta{display:flex;flex-wrap:wrap;gap:6px 20px;font-family:var(--mono);font-size:.78rem;color:var(--ink-soft);margin:0;padding:0;list-style:none}
.meta b{font-weight:500;color:var(--ink-faint)}
.cov{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:1px;background:var(--edge);border:1px solid var(--edge);border-radius:3px;overflow:hidden}
.cov div{background:var(--surface);padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.cov div:last-child{grid-column:1/-1}
.cov dt{font-family:var(--mono);font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}
.cov dd{margin:0;font-family:var(--mono);font-size:.95rem;font-variant-numeric:tabular-nums}
h2{font-size:.78rem;font-family:var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 -10px;font-weight:500}
.step{background:var(--surface);border:1px solid var(--edge);border-radius:3px;padding:16px 18px;display:flex;flex-direction:column;gap:8px}
.step[data-state="contradicted"]{border-left:3px solid var(--contradicted)}
.step[data-state="not-run"],.step[data-state="could-not-run"]{border-left:3px solid var(--unrun)}
.step[data-state="held"]{border-left:3px solid var(--held)}
.step header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.step h3{margin:0;font-size:1rem;font-weight:600}
.chip{font-family:var(--mono);font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;padding:3px 9px;border-radius:2px;white-space:nowrap}
.chip[data-state="held"]{color:var(--held);background:color-mix(in srgb,var(--held) 12%,transparent)}
.chip[data-state="contradicted"]{color:var(--contradicted);background:color-mix(in srgb,var(--contradicted) 14%,transparent)}
.chip[data-state="not-run"],.chip[data-state="could-not-run"]{color:var(--unrun);background:color-mix(in srgb,var(--unrun) 14%,transparent)}
.asks{margin:0;color:var(--ink-soft);max-width:65ch}
.headline{margin:2px 0 0;font-size:1.02rem;font-weight:500;max-width:62ch;text-wrap:pretty}
.step h4{margin:14px 0 0;font-size:.82rem;font-family:var(--mono);font-weight:500;letter-spacing:.04em;
  color:var(--ink);display:flex;align-items:center;gap:8px}
.step h4 .n{font-size:.72rem;padding:1px 7px;border-radius:2px;background:var(--accent-soft);color:var(--accent)}
.why{margin:6px 0 0;color:var(--ink-soft);font-size:.88rem;max-width:64ch}
.scroll{overflow-x:auto;margin-top:8px;border:1px solid var(--edge);border-radius:2px}
table{border-collapse:collapse;width:100%;font-size:.82rem;table-layout:fixed}
td:first-child,th:first-child{width:40%}
th{text-align:left;font-family:var(--mono);font-weight:500;font-size:.68rem;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink-faint);padding:8px 11px;border-bottom:1px solid var(--edge);white-space:nowrap;background:var(--ground)}
td{padding:8px 11px;border-bottom:1px solid var(--edge);vertical-align:top}
tr:last-child td{border-bottom:0}
td{overflow-wrap:anywhere}
td code{font-family:var(--mono);font-size:.78rem}
.tag{font-family:var(--mono);font-size:.72rem;background:var(--ground);border:1px solid var(--edge);
  border-radius:2px;padding:1px 6px;display:inline-block;margin:1px 0}
.bad .tag{border-color:color-mix(in srgb,var(--contradicted) 45%,transparent);color:var(--contradicted)}
.muted{color:var(--ink-faint)}
.sev[data-s="error"]{color:var(--contradicted)}
.sev[data-s="note"]{color:var(--ink-soft)}
.reason{margin:0;color:var(--ink);background:var(--accent-soft);border-radius:2px;padding:8px 11px;font-size:.9rem}
.cmd{margin:0;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;font-size:.8rem}
.cmd code{font-family:var(--mono);color:var(--ink-soft);overflow-wrap:anywhere}
.ms{font-family:var(--mono);color:var(--ink-faint);white-space:nowrap}
details{border-top:1px solid var(--edge);padding-top:8px}
summary{cursor:pointer;font-family:var(--mono);font-size:.78rem;color:var(--accent)}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
pre{font-family:var(--mono);font-size:.76rem;line-height:1.55;background:var(--ground);border:1px solid var(--edge);border-radius:2px;
  padding:12px;overflow-x:auto;margin:10px 0 0;color:var(--ink-soft)}
.notcov{border:1px dashed var(--edge);border-radius:3px;padding:16px 18px}
.notcov ul{margin:10px 0 0;padding-left:18px;color:var(--ink-soft);display:flex;flex-direction:column;gap:5px;font-size:.9rem}
footer{color:var(--ink-faint);font-size:.78rem;font-family:var(--mono);border-top:1px solid var(--edge);padding-top:16px;
  display:flex;flex-direction:column;gap:4px}
</style></head><body><div class="wrap">

<header>
  <p class="eyebrow">assay run record</p>
  <h1>${esc(r.repo)} · ${esc(r.commit)}${r.dirty ? ' <span style="color:var(--accent)">+ uncommitted changes</span>' : ''}</h1>
</header>

<div class="verdict" data-v="${r.verdict}">
  <p class="eyebrow" style="color:var(--v)">${r.verdict}</p>
  <p>${VERDICT_BLURB[r.verdict]}</p>
</div>

<ul class="meta">
  <li><b>branch</b> ${esc(r.branch)}</li>
  <li><b>started</b> ${esc(r.startedAt)}</li>
  <li><b>took</b> ${(r.ms / 1000).toFixed(1)}s</li>
  <li><b>database</b> ${r.database ? esc(r.database) : 'none reachable'}</li>
</ul>

<h2>How much it looked at</h2>
<dl class="cov">${Object.entries(r.coverage).map(([k, v]) =>
    `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>

<h2>Steps</h2>
${r.steps.map(step).join('')}

<div class="notcov">
  <p class="eyebrow">what a clean run does not cover</p>
  <ul>${NOT_COVERED.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
</div>

<footer>
  <span>Generated by <code>assay attest</code> from its own output. Nothing on this page was written by hand.</span>
  <span>Reproduce: <code>assay attest</code> at ${esc(r.commit)}</span>
</footer>
</div></body></html>
`
}

function main() {
    const args = process.argv.slice(2)
    const at = (f: string, d: string | null) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1] }
    const root = projectRoot()
    const out = at('--out', join(root, '.assay/attest.html')) as string
    const base = at('--base', null)

    const record = collect(root, base)

    if (args.includes('--json')) {
        console.log(JSON.stringify(record, null, 2))
    } else {
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, renderHtml(record))
        console.log(`${record.verdict} — ${out}`)
        for (const s of record.steps) console.log(`  ${STATE_LABEL[s.state].padEnd(13)} ${s.name}`)
    }
    process.exit(record.verdict === 'FAIL' ? 1 : record.verdict === 'INCONCLUSIVE' ? 2 : 0)
}

// WITHOUT THIS GUARD, IMPORTING THIS MODULE RUNS THE COMMAND — see isEntrypoint.
if (isEntrypoint(import.meta.url)) main()
