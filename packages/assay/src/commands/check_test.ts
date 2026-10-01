/**
 * The gate's ordering rule (`mustFollow`), driven end to end on a real corpus.
 *
 * Pinned on the case that made `after` a list: process-payment's Wix renewal
 * path resolves the buyer's Wix CONTACT first and only falls back to the
 * member's email when that finds nobody. Listing the contact query as an
 * alternative must let exactly that sequence through — and nothing else.
 */

import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHECK = join(import.meta.dir, 'check.ts')
const CONTACT_QUERY = 'POST www.wixapis.com/contacts/v4/contacts/query'
const STABLE_ID = { target: 'members', anyFilter: ['wix_contact_id', 'stripe_customer_id'] }

const stmt = (seq: number, target: string, verb: string, filters: string[] = []) =>
    `@ledger ${JSON.stringify({ operation: 'pay', target, verb, filters, embeds: [], rows: 1, serviceRole: true, seq })}`

function gate(after: unknown, corpus: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'assay-check-'))
    writeFileSync(join(dir, 'operations.json'), JSON.stringify({
        version: 1,
        operations: {
            pay: {
                reads: ['members'], writes: [], rpc: ['get_auth_user_by_email'], calls: [CONTACT_QUERY], rlsBypassed: true,
                mustFollow: { get_auth_user_by_email: { after, within: 10 } },
            },
        },
    }))
    writeFileSync(join(dir, 'rpc-writes.json'), JSON.stringify({ writes: {}, functions: 0 }))
    writeFileSync(join(dir, 'corpus.log'), corpus.join('\n') + '\n')
    const run = spawnSync('bun', [CHECK, join(dir, 'corpus.log'),
        '--declarations', join(dir, 'operations.json'), '--rpc-map', join(dir, 'rpc-writes.json'), '--json'], { encoding: 'utf8' })
    const out = JSON.parse(run.stdout) as { findings: { kind: string; detail: string }[] }
    return out.findings.filter(f => f.kind === 'not-a-fallback')
}

// The renewal's Tier 3, as the nightly recorded it: contact query → email lookup.
const TIER_3 = [
    stmt(1, CONTACT_QUERY, 'call'),
    stmt(2, 'get_auth_user_by_email', 'rpc'),
    stmt(3, 'members', 'read', ['id']),
]

test('a single `after` still rejects an email lookup with no stable-id attempt before it', () => {
    const found = gate(STABLE_ID, TIER_3)
    expect(found).toHaveLength(1)
    expect(found[0].detail).toContain('members lookup on wix_contact_id/stripe_customer_id')
})

test('a listed alternative lets the contact-first path through', () => {
    expect(gate([STABLE_ID, { target: CONTACT_QUERY }], TIER_3)).toHaveLength(0)
})

test('the original alternative still counts when a list is given', () => {
    const viaMember = [stmt(1, 'members', 'read', ['wix_contact_id']), stmt(2, 'get_auth_user_by_email', 'rpc')]
    expect(gate([STABLE_ID, { target: CONTACT_QUERY }], viaMember)).toHaveLength(0)
})

test('alternatives do not excuse a first resort, and the finding names every one of them', () => {
    const firstResort = [stmt(1, 'get_auth_user_by_email', 'rpc'), stmt(2, 'members', 'read', ['id'])]
    const found = gate([STABLE_ID, { target: CONTACT_QUERY }], firstResort)
    expect(found).toHaveLength(1)
    expect(found[0].detail).toContain(`or ${CONTACT_QUERY}`)
})
