/**
 * The write-chain scan, pinned on the case that broke it.
 *
 * `unattributed` reported a file as READ-ONLY while it held a client insert:
 * the chain regex ran past the end of one statement into the next, matched
 * `from('a') … from('b').insert()` as a single chain, and then correctly
 * discarded it as straddling — taking the real write with it. An understated
 * write set is the one direction this scan must not be wrong in.
 *
 * The module resolves the project at IMPORT time, so a fixture project has to
 * exist and be the working directory before it is imported. Hence the dynamic
 * import below rather than a static one.
 */

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = mkdtempSync(join(tmpdir(), 'assay-unattributed-'))
mkdirSync(join(fixture, '.assay'), { recursive: true })
writeFileSync(join(fixture, '.assay', 'config.json'), JSON.stringify({ database: {} }))
const cwd = process.cwd()
process.chdir(fixture)
const { writtenBy } = await import('./unattributed.ts')
process.chdir(cwd)

afterAll(() => rmSync(fixture, { recursive: true, force: true }))

test('a write in the SECOND statement is found, not swallowed by the first', () => {
    const src = `
        export const list = () => supabase.from('business_team_members').select('*')
        export const notify = (id) => supabase.from('notifications').insert({ id })
    `
    expect(writtenBy(src, 'supabase')).toEqual(['notifications'])
})

test('a chain broken across lines still counts', () => {
    const src = `
        await supabase
            .from('members')
            .update({ first_name: name })
            .eq('id', id)
    `
    expect(writtenBy(src, 'supabase')).toEqual(['members'])
})

test('a read-only chain is not a write', () => {
    expect(writtenBy(`supabase.from('members').select('*').eq('id', id)`, 'supabase')).toEqual([])
})

test('a write through an INJECTED client is not attributed to the module client', () => {
    // The shape this project moved to: read through the module singleton, write
    // through a client passed in. Blind to the receiver, the scan reported those
    // writes forever and could not see the fix that had already happened.
    const src = `
        const rows = await supabase.from('members').select('*')
        await db.from('members').update({ tier })
    `
    expect(writtenBy(src, 'supabase')).toEqual([])
    expect(writtenBy(src, 'db')).toEqual(['members'])
})

test('every writing statement is reported, not just the first', () => {
    const src = `
        supabase.from('a').insert({})
        supabase.from('b').select('*')
        supabase.from('c').delete().eq('id', 1)
    `
    expect(writtenBy(src, 'supabase')).toEqual(['a', 'c'])
})
