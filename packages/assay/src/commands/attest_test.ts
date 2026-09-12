/**
 * The attestation, pinned on the two things that make it one.
 *
 * A run record is only worth reading if it cannot quietly become a pass, and only
 * worth reading TWICE if a hundred findings of one class arrive as one fact rather
 * than a hundred lines. Everything below is one of those two.
 */

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `attest` reaches `lib/db.ts`, which resolves the project at IMPORT time, so a
// fixture project has to exist and be the working directory before the module is
// loaded. Same shape as unattributed_test.ts, for the same reason.
const fixture = mkdtempSync(join(tmpdir(), 'assay-attest-'))
mkdirSync(join(fixture, '.assay'), { recursive: true })
writeFileSync(join(fixture, '.assay', 'config.json'), JSON.stringify({ database: {} }))
const cwd = process.cwd()
process.chdir(fixture)
const { findingOf, renderHtml, verdictOf } = await import('./attest.ts')
type RunRecord = Awaited<ReturnType<typeof import('./attest.ts')>> extends never ? never : import('./attest.ts').RunRecord
type StepRecord = import('./attest.ts').StepRecord
process.chdir(cwd)

afterAll(() => rmSync(fixture, { recursive: true, force: true }))

const step = (p: Partial<StepRecord>): StepRecord => ({
    id: 'tier1', name: 'tier 1 — static', asks: '', argv: ['assay', 'tier1'],
    state: 'held', exit: 0, ms: 1, stdout: '', reason: '', json: null, ...p,
})

// ── the rule the command exists for ──────────────────────────────────────────

test('a tier that did not run is never a pass', () => {
    expect(verdictOf([
        step({ state: 'held' }),
        step({ id: 'tier2', name: 'tier 2 — drive, gate, invariants', state: 'not-run' }),
    ])).toBe('INCOMPLETE')
})

test('a contradiction outranks everything else', () => {
    expect(verdictOf([
        step({ state: 'contradicted' }),
        step({ id: 'tier2', name: 'tier 2 — drive, gate, invariants', state: 'not-run' }),
        step({ id: 'nodes', name: 'seam nodes', state: 'could-not-run' }),
    ])).toBe('FAIL')
})

test('an environment that gave out outranks not having looked', () => {
    expect(verdictOf([
        step({ id: 'nodes', name: 'seam nodes', state: 'could-not-run' }),
        step({ id: 'tier2', name: 'tier 2 — drive, gate, invariants', state: 'not-run' }),
    ])).toBe('INCONCLUSIVE')
})

test('PASS needs every step to have run and held', () => {
    expect(verdictOf([step({ state: 'held' }), step({ id: 'tier2', name: 'tier 2 — x', state: 'held' })])).toBe('PASS')
})

test('a non-tier step that did not run does not make the run incomplete', () => {
    // `--base` is optional; not comparing declarations is not a gap in what ran.
    expect(verdictOf([
        step({ state: 'held' }),
        step({ id: 'review', name: 'declaration change', state: 'not-run' }),
        step({ id: 'tier2', name: 'tier 2 — x', state: 'held' }),
    ])).toBe('PASS')
})

// ── folding: many findings of one class are ONE fact ──────────────────────────

const writeIssue = (operation: string, subject: string) => ({
    severity: 'warn', kind: 'undeclared-static-write', operation, subject,
    detail: `code can write "${subject}", which is not declared`,
    remedy: 'Static analysis over-reports through shared imports — confirm before accepting.',
})

test('twenty-four findings of one class fold to one row per operation, with the remedy stated once', () => {
    const issues = [
        ...['a', 'b', 'c'].map(t => writeIssue('scoring-cycle', t)),
        ...['d', 'e'].map(t => writeIssue('stripe-webhook', t)),
    ]
    const f = findingOf(step({ json: { issues, declared: 59, onDisk: 24, neverObserved: [] } }))!
    expect(f.headline).toContain('5 warning(s)')
    // one BODY row each, not five (the header row is a <tr> too)
    const bodyRows = f.body.split('<tbody>')[1].match(/<tr>/g)?.length
    expect(bodyRows).toBe(2)
    expect(f.body.match(/Static analysis over-reports/g)?.length).toBe(1)
    // the operation with more findings leads
    expect(f.body.indexOf('scoring-cycle')).toBeLessThan(f.body.indexOf('stripe-webhook'))
})

test('tier 1 with nothing to report says so rather than rendering an empty table', () => {
    const f = findingOf(step({ json: { issues: [], declared: 59, onDisk: 24, neverObserved: [] } }))!
    expect(f.headline).toBe('59 declarations, nothing contradicted.')
    expect(f.body).toBe('')
})

test('a failed static crawl is said, not swallowed', () => {
    const f = findingOf(step({ json: { issues: [], declared: 1, onDisk: 1, neverObserved: [], staticCrawlFailed: 'ENOENT x' } }))!
    expect(f.body).toContain('ENOENT x')
    expect(f.body).toContain('proves less than a clean one')
})

// ── unattributed: a browser WRITE is not a browser read ──────────────────────

test('browser modules that write sort first and are marked', () => {
    const sites = [
        { file: 'reads-only.ts', reads: ['members'], writes: [], rpcs: [], writesViaRpc: [] },
        { file: 'writes.ts', reads: [], writes: ['payments'], rpcs: [], writesViaRpc: [] },
    ]
    const f = findingOf(step({ id: 'unattributed', name: 'unattributed effects', json: { sites, scanned: 696, allowed: [] } }))!
    expect(f.headline).toContain('1 of them WRITE')
    expect(f.body.indexOf('writes.ts')).toBeLessThan(f.body.indexOf('reads-only.ts'))
    expect(f.body).toContain('class="bad"')
})

test('nothing unattributed reports the size of the search, not silence', () => {
    const f = findingOf(step({ id: 'unattributed', name: 'x', json: { sites: [], scanned: 696, allowed: [] } }))!
    expect(f.headline).toContain('696')
})

// ── nodes and review ─────────────────────────────────────────────────────────

test('seam nodes lead with what was never captured from a real run', () => {
    const f = findingOf(step({ id: 'nodes', name: 'seam nodes',
        json: { rows: [{ id: 'a' }, { id: 'b' }], handwritten: ['a'], uncaptured: ['b'] } }))!
    expect(f.headline).toBe('2 seam node(s) · 1 still hand-written · 1 never captured from a real run.')
    expect(f.body.indexOf('Never captured')).toBeLessThan(f.body.indexOf('Hand-written'))
})

test('no declaration change says how many operations that covers', () => {
    const f = findingOf(step({ id: 'review', name: 'declaration change', json: { findings: [], headCount: 59 } }))!
    expect(f.headline).toBe('No declared change across 59 operation(s).')
})

// ── the page ─────────────────────────────────────────────────────────────────

const record = (steps: StepRecord[]): RunRecord => ({
    repo: 'r', commit: 'abc1234', branch: 'main', dirty: false, startedAt: '2026-01-01T00:00:00Z',
    ms: 10, verdict: verdictOf(steps), database: null, steps, coverage: { 'declarations': '59' },
})

test('a step that did not run appears on the page — omission is how a report lies', () => {
    const html = renderHtml(record([
        step({ state: 'held' }),
        step({ id: 'tier2', name: 'tier 2 — drive, gate, invariants', state: 'not-run',
               reason: 'no database reachable (nothing configured)' }),
    ]))
    expect(html).toContain('tier 2 — drive, gate, invariants')
    expect(html).toContain('did not run')
    expect(html).toContain('no database reachable')
    expect(html).toContain('INCOMPLETE')
})

test('the page names what a clean run still does not cover', () => {
    const html = renderHtml(record([step({ state: 'held' }), step({ id: 'tier2', name: 'tier 2 — x', state: 'held' })]))
    expect(html).toContain('what a clean run does not cover')
    expect(html).toContain('trigger and cascade writes')
})

test('output is escaped — a table name is not markup', () => {
    const html = renderHtml(record([step({ state: 'contradicted', stdout: '<script>alert(1)</script>' })]))
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
})

// ── tier 2 over a corpus that was already driven ─────────────────────────────

test('a corpus that could not be gated leaves the run incomplete, not passing', () => {
    // The shape the CI wiring produces when the driving step wrote nothing.
    expect(verdictOf([
        step({ state: 'held' }),
        step({ id: 'gate', name: 'tier 2 — gate the driven corpus', state: 'not-run',
               reason: 'the corpus at /tmp/x.log is empty — nothing was observed' }),
        step({ id: 'invariants', name: 'tier 2 — invariants', state: 'not-run', reason: 'same' }),
    ])).toBe('INCOMPLETE')
})

test('a gate with nothing undeclared still says what the corpus never exercised', () => {
    const f = findingOf(step({ id: 'gate', name: 'tier 2 — gate the driven corpus',
        json: { findings: [], unexercised: ['sync-subscription'], errors: 0, warnings: 0 } }))!
    expect(f.headline).toContain('Nothing undeclared')
    expect(f.body).toContain('sync-subscription')
    expect(f.body).toContain('missing coverage rather than dead declaration')
})

test('the gate puts errors above warnings, whatever order they arrived in', () => {
    const mk = (severity: string, kind: string, operation: string) =>
        ({ severity, kind, operation, detail: `${severity} thing`, remedy: `fix ${kind}` })
    const f = findingOf(step({ id: 'gate', name: 'tier 2 — gate the driven corpus', json: {
        findings: [mk('warn', 'undeclared-read', 'a'), mk('error', 'undeclared-write', 'b')],
    } }))!
    expect(f.headline).toContain('1 error(s), 1 warning(s)')
    expect(f.body.indexOf('undeclared write')).toBeLessThan(f.body.indexOf('undeclared read'))
})

test('invariants that never ran are named, because not run is not held', () => {
    const f = findingOf(step({ id: 'invariants', name: 'tier 2 — invariants', json: {
        results: [{ name: 'a', newKeys: [], knownKeys: [] }, { name: 'b', newKeys: ['row-1'], knownKeys: [] }],
        skipped: ['no-overlapping-scheduled-sessions'],
    } }))!
    expect(f.headline).toBe('1 held · 1 violated · 0 could not be evaluated · 1 not run.')
    expect(f.body).toContain('no-overlapping-scheduled-sessions')
    expect(f.body).toContain('Not evidence that they hold')
    expect(f.body).toContain('row-1')
})

test('an invariant that threw is separated from one that was violated', () => {
    const f = findingOf(step({ id: 'invariants', name: 'tier 2 — invariants', json: {
        results: [{ name: 'broken', newKeys: [], knownKeys: [], error: 'relation "x" does not exist' }],
        skipped: [],
    } }))!
    expect(f.headline).toContain('1 could not be evaluated')
    expect(f.body).toContain('relation')
})
