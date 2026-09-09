/**
 * The client gate, over synthetic corpora.
 *
 * `checkClients` is pure over its entries precisely so this can exist: the
 * visibility check's whole value is that it fails on a real RLS hole, and
 * reproducing one needs a live stack with a policy dropped. That reproduction is
 * still owed and is written up in `docs/plan-client-probes.md` ("Test the
 * hatch"); these tests pin the DECISION the gate makes once the evidence is in
 * front of it, so the two failures cannot be confused — a check that never fired
 * and a check that fired and was ignored look identical in a green run.
 */

import { expect, test } from 'bun:test'
import { checkClients, mergeClients, stableClients, strangerKey, type ClientsFile } from './clients.ts'
import type { Entry } from './corpus.ts'

const MODULE = 'lib/repositories/business-team.ts'

const entry = (over: Partial<Entry> & { operation: string; target: string; verb: string }): Entry => ({
    filters: [], embeds: [], rows: null, serviceRole: false, seq: 0, ...over,
})

const declared = (over: Partial<ClientsFile['clients'][string]> = {}): ClientsFile => ({
    version: 1,
    clients: {
        [MODULE]: {
            reads: ['business_team_members', 'members'],
            writes: ['notifications'],
            rpc: ['get_my_business_team'],
            visibility: 'caller-scoped',
            ...over,
        },
    },
})

const kinds = (findings: Array<{ kind: string }>) => findings.map(f => f.kind)

test('a stranger reading rows from a caller-scoped module is an error', () => {
    // THE HOLE. A policy that stopped filtering looks exactly like this: the
    // stranger's read succeeds and comes back with somebody else's rows.
    const { findings } = checkClients([
        entry({ operation: MODULE, target: 'business_team_members', verb: 'read', rows: 4 }),
        entry({ operation: strangerKey(MODULE), target: 'business_team_members', verb: 'read', rows: 3, seq: 1 }),
    ], declared(), {})
    const leak = findings.find(f => f.kind === 'visibility-leak')
    expect(leak?.severity).toBe('error')
    expect(leak?.detail).toContain('3 row(s)')
    expect(leak?.detail).toContain('business_team_members')
})

test('a stranger whose reads all come back empty passes', () => {
    const { findings } = checkClients([
        entry({ operation: MODULE, target: 'business_team_members', verb: 'read', rows: 4 }),
        entry({ operation: MODULE, target: 'members', verb: 'read', rows: 1, seq: 1 }),
        entry({ operation: strangerKey(MODULE), target: 'business_team_members', verb: 'read', rows: 0, seq: 2 }),
        entry({ operation: strangerKey(MODULE), target: 'members', verb: 'read', rows: 0, seq: 3 }),
    ], declared(), {})
    expect(findings.filter(f => f.severity === 'error')).toEqual([])
})

test('a stranger write that succeeds is an error; one the database refused is not', () => {
    const refused = checkClients([
        entry({ operation: MODULE, target: 'notifications', verb: 'insert' }),
        entry({
            operation: strangerKey(MODULE), target: 'notifications', verb: 'insert', seq: 1,
            error: 'new row violates row-level security policy for table "notifications"',
        }),
    ], declared(), {})
    expect(refused.findings.filter(f => f.severity === 'error')).toEqual([])

    const accepted = checkClients([
        entry({ operation: MODULE, target: 'notifications', verb: 'insert' }),
        entry({ operation: strangerKey(MODULE), target: 'notifications', verb: 'insert', rows: 1, seq: 1 }),
    ], declared(), {})
    expect(kinds(accepted.findings)).toContain('visibility-write-allowed')
})

test("a stranger's writing rpc that succeeds is an error; a reading one is not judged", () => {
    const map = { transfer_team: ['business_team_members'], get_my_business_team: [] }
    const writing = checkClients([
        entry({ operation: strangerKey(MODULE), target: 'transfer_team', verb: 'rpc', rows: 1 }),
    ], declared({ rpc: ['transfer_team'] }), map)
    expect(kinds(writing.findings)).toContain('visibility-write-allowed')

    // A function that returns a scalar tells us nothing without reading the
    // VALUE, and this tool does not read values. Silence is the honest answer.
    const reading = checkClients([
        entry({ operation: strangerKey(MODULE), target: 'get_my_business_team', verb: 'rpc', rows: 1 }),
    ], declared(), map)
    expect(kinds(reading.findings)).not.toContain('visibility-leak')
})

test('a caller-scoped claim nobody drove fails, rather than passing as coverage', () => {
    const { findings } = checkClients(
        [entry({ operation: MODULE, target: 'members', verb: 'read', rows: 1 })],
        declared(), {},
    )
    const unexercised = findings.find(f => f.kind === 'visibility-not-exercised')
    expect(unexercised?.severity).toBe('error')
})

test('service role anywhere in a client corpus fails: RLS was inert', () => {
    const { findings } = checkClients([
        entry({ operation: strangerKey(MODULE), target: 'members', verb: 'read', rows: 0, serviceRole: true }),
    ], declared(), {})
    expect(kinds(findings)).toContain('client-drove-as-service-role')
})

test('undeclared writes and rpcs are errors, an undeclared read is a warning', () => {
    const { findings } = checkClients([
        entry({ operation: MODULE, target: 'audit_log', verb: 'insert' }),
        entry({ operation: MODULE, target: 'team_invitations', verb: 'read', rows: 2, seq: 1 }),
        entry({ operation: MODULE, target: 'leave_business_team', verb: 'rpc', seq: 2 }),
    ], declared({ visibility: 'public' }), {})
    const by = Object.fromEntries(findings.map(f => [f.kind, f.severity]))
    expect(by['undeclared-write']).toBe('error')
    expect(by['undeclared-rpc']).toBe('error')
    expect(by['undeclared-read']).toBe('warn')
})

test('--strict promotes an undeclared read, and a missing visibility claim', () => {
    const file: ClientsFile = { version: 1, clients: { [MODULE]: { reads: [], writes: [], rpc: [] } } }
    const { findings } = checkClients(
        [entry({ operation: MODULE, target: 'members', verb: 'read', rows: 1 })],
        file, {}, { strict: true },
    )
    const by = Object.fromEntries(findings.map(f => [f.kind, f.severity]))
    expect(by['undeclared-read']).toBe('error')
    expect(by['visibility-undeclared']).toBe('error')
})

test('a module with no declaration at all is an error, as for an operation', () => {
    const { findings } = checkClients(
        [entry({ operation: 'lib/repositories/other.ts', target: 'members', verb: 'insert' })],
        declared(), {},
    )
    expect(kinds(findings)).toContain('undeclared-client-module')
})

test('a declared module absent from the corpus is reported as unexercised, not clean', () => {
    const file = declared({ visibility: 'public' })
    const { findings, unexercised } = checkClients(
        [entry({ operation: 'x', target: 'members', verb: 'read', rows: 0 })],
        { version: 1, clients: { ...file.clients, 'x': { reads: ['members'], writes: [], rpc: [], visibility: 'public' } } },
        {},
    )
    expect(unexercised).toEqual([MODULE])
    expect(findings.filter(f => f.severity === 'error')).toEqual([])
})

test('emit replaces derived sets and keeps the hand-written claim', () => {
    const current: ClientsFile = {
        version: 1,
        clients: {
            [MODULE]: {
                reads: ['members', 'gone_table'], writes: [], rpc: [],
                visibility: 'caller-scoped', why: 'a team is its members\' business',
            },
            'lib/repositories/retired.ts': { reads: ['members'], writes: [], rpc: [], visibility: 'public' },
        },
    }
    const { next, added, removed, changed } = mergeClients(current, [
        { file: MODULE, reads: ['members'], writes: ['notifications'], rpcs: [] },
        { file: 'lib/repositories/new.ts', reads: ['members'], writes: [], rpcs: [] },
    ])
    // A read the repository no longer contains is DROPPED — the scan is static
    // and total, unlike a corpus, so keeping it would widen the allowance for a
    // statement nobody can write any more.
    expect(next.clients[MODULE].reads).toEqual(['members'])
    expect(next.clients[MODULE].writes).toEqual(['notifications'])
    expect(next.clients[MODULE].visibility).toBe('caller-scoped')
    expect(next.clients[MODULE].why).toBe('a team is its members\' business')
    expect(added).toEqual(['lib/repositories/new.ts'])
    expect(changed).toEqual([MODULE])
    expect(removed).toEqual(['lib/repositories/retired.ts'])
})

test('the emitted file is stable: sorted keys, sorted sets, derived fields present', () => {
    const { next } = mergeClients({ version: 1, clients: {} }, [
        { file: 'b.ts', reads: ['z', 'a'], writes: [], rpcs: [] },
        { file: 'a.ts', reads: [], writes: [], rpcs: [] },
    ])
    const text = stableClients(next)
    expect(text.indexOf('"a.ts"')).toBeLessThan(text.indexOf('"b.ts"'))
    expect(JSON.parse(text).clients['b.ts']).toEqual({ reads: ['a', 'z'], writes: [], rpc: [] })
    expect(stableClients(next)).toBe(text)
})
