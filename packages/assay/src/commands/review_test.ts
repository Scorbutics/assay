/**
 * The review renderer, pinned on the asymmetry it exists to express.
 *
 * A declaration edit is not symmetric: ADDING grants permission the gate will
 * then enforce as legitimate, REMOVING takes it away. Every test here is a case
 * where treating the two the same would put the wrong thing at the top of a
 * pull request comment — which, for a surface whose whole value is that it is
 * read on a phone in thirty seconds, is the same as not having it.
 */

import { expect, test } from 'bun:test'
import { MARKER, hostOf, renderMarkdown, review, type ReviewFinding } from './review.ts'
import type { Declaration, DeclarationFile } from './declare.ts'

const op = (d: Partial<Declaration> = {}): Declaration =>
    ({ reads: [], writes: [], rpc: [], calls: [], rlsBypassed: false, ...d })

const file = (operations: Record<string, Declaration>): DeclarationFile => ({ version: 1, operations })

const kinds = (f: ReviewFinding[]) => f.map(x => x.kind)
const of = (f: ReviewFinding[], kind: string) => f.find(x => x.kind === kind)

test('a deleted prohibition is an error — nothing else can notice it', () => {
    const before = file({ 'link-payment': op({ mustNotCall: ['get_auth_user_by_email'] }) })
    const after = file({ 'link-payment': op({}) })
    const found = review(before, after)
    expect(of(found, 'prohibition-removed')?.severity).toBe('error')
    expect(of(found, 'prohibition-removed')?.detail).toContain('get_auth_user_by_email')
})

test('a deleted ordering rule is an error too', () => {
    const before = file({ x: op({ mustFollow: { 'rpc:provision': { after: { target: 'members' } } } }) })
    const found = review(before, file({ x: op({}) }))
    expect(of(found, 'prohibition-removed')?.severity).toBe('error')
})

test('an ADDED prohibition is a note — tightening is not news', () => {
    const found = review(file({ x: op({}) }), file({ x: op({ mustNotCall: ['f'] }) }))
    expect(of(found, 'prohibition-added')?.severity).toBe('note')
})

test('a new write is an error and a dropped write is a note that says which way it cuts', () => {
    const grew = review(file({ x: op({ writes: ['a'] }) }), file({ x: op({ writes: ['a', 'audit_log'] }) }))
    expect(of(grew, 'write-added')?.severity).toBe('error')
    expect(of(grew, 'write-added')?.detail).toContain('audit_log')

    const shrank = review(file({ x: op({ writes: ['a', 'audit_log'] }) }), file({ x: op({ writes: ['a'] }) }))
    expect(of(shrank, 'write-removed')?.severity).toBe('note')
    expect(of(shrank, 'write-removed')?.detail).toContain('TIGHTENS')
})

test('RLS newly inert is an error; giving it up is a note', () => {
    expect(of(review(file({ x: op({}) }), file({ x: op({ rlsBypassed: true }) })), 'rls-newly-bypassed')?.severity).toBe('error')
    expect(of(review(file({ x: op({ rlsBypassed: true }) }), file({ x: op({}) })), 'rls-no-longer-bypassed')?.severity).toBe('note')
})

test('a new HOST outranks a new endpoint on a host already reached', () => {
    const before = file({ x: op({ calls: ['GET api.stripe.com/v1/customers'] }) })
    const after = file({ x: op({ calls: ['GET api.stripe.com/v1/customers', 'POST api.stripe.com/v1/refunds', 'POST hooks.slack.com/services/{id}'] }) })
    const found = review(before, after)
    expect(of(found, 'call-new-host')?.severity).toBe('error')
    expect(of(found, 'call-new-host')?.detail).toContain('hooks.slack.com')
    expect(of(found, 'call-added')?.severity).toBe('warn')
    expect(of(found, 'call-added')?.detail).toContain('refunds')
})

test('hostOf reads the host out of `METHOD host/path`', () => {
    expect(hostOf('GET api.stripe.com/v1/customers/{id}')).toBe('api.stripe.com')
    expect(hostOf('hooks.slack.com/services')).toBe('hooks.slack.com')
})

test('four new reads are ONE finding, not four rows', () => {
    const found = review(file({ x: op({ reads: ['a'] }) }), file({ x: op({ reads: ['a', 'b', 'c', 'd', 'e'] }) }))
    const reads = found.filter(f => f.kind === 'read-added')
    expect(reads).toHaveLength(1)
    expect(reads[0].severity).toBe('warn')
    expect(reads[0].detail).toContain('`b`, `c`, `d`, `e`')
})

test('a new operation is a warning, and a new operation with RLS inert is also an error', () => {
    const plain = review(file({}), file({ fresh: op({ writes: ['t'] }) }))
    expect(kinds(plain)).toEqual(['new-operation'])
    expect(plain[0].severity).toBe('warn')

    const inert = review(file({}), file({ fresh: op({ writes: ['t'], rlsBypassed: true }) }))
    expect(of(inert, 'new-operation-rls')?.severity).toBe('error')
})

test('findings are ordered by consequence, not by operation name', () => {
    const before = file({ aaa: op({ reads: ['x'] }), zzz: op({}) })
    const after = file({ aaa: op({ reads: ['x', 'y'] }), zzz: op({ rlsBypassed: true }) })
    expect(review(before, after)[0].kind).toBe('rls-newly-bypassed')
})

test('the marker leads the comment so the workflow can edit its own', () => {
    const md = renderMarkdown(review(file({ x: op({}) }), file({ x: op({ writes: ['t'] }) })), {
        base: 'origin/main', head: 'the working tree', path: '.assay/operations.json', baseCount: 1, headCount: 1,
    })
    expect(md.startsWith(MARKER)).toBe(true)
    expect(md).toContain('🔴 Needs a decision')
    expect(md).toContain('what a stranger')  // the NOT_COVERED footer, printed on every run
})

test('notes are collapsed and errors are not', () => {
    const md = renderMarkdown(review(file({ x: op({ writes: ['a', 'b'] }) }), file({ x: op({ writes: ['a'] }) })), {
        base: 'origin/main', head: 'the working tree', path: '.assay/operations.json', baseCount: 1, headCount: 1,
    })
    expect(md).toContain('<details><summary>· Noted (1)</summary>')
})

test('no change says so without claiming the behaviour is unchanged', () => {
    const md = renderMarkdown([], { base: 'origin/main', head: 'the working tree', path: '.assay/operations.json', baseCount: 2, headCount: 2 })
    expect(md).toContain('No declared change across **2 operation(s)**')
    expect(md).toContain('a value computed')
})

test('a first declaration says the base had no file, rather than reporting the project as new', () => {
    const md = renderMarkdown(review(file({}), file({ x: op({}) })), {
        base: 'origin/main', head: 'the working tree', path: '.assay/operations.json', baseCount: 0, headCount: 1,
    })
    expect(md).toContain('First declaration')
})
