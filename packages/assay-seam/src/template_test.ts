/// <reference lib="deno.ns" />
import { assertEquals } from 'jsr:@std/assert@^1'
import { captureParams, factsOf, resolveBody, resolveToken } from './template.ts'
import { normalizePath } from './ledger.ts'

const facts = (href: string, body?: unknown) => {
    const url = new URL(href)
    return factsOf(url, normalizePath(url.pathname), body)
}

Deno.test('captures what normalisation replaced', () => {
    const p = '/contacts/v4/contacts/6f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'
    assertEquals(captureParams(p, normalizePath(p)), { id: '6f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' })
})

Deno.test('captures nothing when the segment was never normalised', () => {
    // Not every path segment becomes a placeholder — normalizePath is a
    // heuristic, and a fixture referencing {id} for a plain segment must come
    // back unresolved rather than silently binding to the wrong thing.
    const p = '/contacts/v4/contacts/plain'
    assertEquals(captureParams(p, normalizePath(p)), {})
})

Deno.test('numbers repeats from two, so the single case keeps the plain name', () => {
    const p = '/a/00000000-0000-0000-0000-000000000001/b/00000000-0000-0000-0000-000000000002'
    assertEquals(captureParams(p, normalizePath(p)), {
        id: '00000000-0000-0000-0000-000000000001',
        id2: '00000000-0000-0000-0000-000000000002',
    })
})

Deno.test('resolves each source', () => {
    const f = facts('https://h/x/9999999999?plan=gold', { buyer: { email: 'a@b.c' } })
    assertEquals(resolveToken('id', f), '9999999999')
    assertEquals(resolveToken('path.0', f), 'x')
    assertEquals(resolveToken('query.plan', f), 'gold')
    assertEquals(resolveToken('body.buyer.email', f), 'a@b.c')
})

Deno.test('base64 decodes — the case this exists for', () => {
    // The fake it replaces smuggled the email through the provider's id field.
    const id = btoa('buyer@example.invalid').replace(/=+$/, '')
    const f = facts(`https://h/contacts/v4/contacts/assayfake${id}`)
    assertEquals(resolveToken('id', f), `assayfake${id}`)
    // A prefixed id needs the prefix gone before decoding; that is the app's
    // job when it chooses the scheme, so a bare encoded segment is the case.
    const g = facts(`https://h/contacts/v4/contacts/${id}`)
    assertEquals(resolveToken('id|base64', g), 'buyer@example.invalid')
})

Deno.test('substitutes inside and across a whole body', () => {
    const f = facts('https://h/contacts/v4/contacts/1234567890123456')
    const { body, unresolved } = resolveBody(
        { contact: { id: '{id}', tag: 'wix-{id}', items: [{ email: '{id}' }] } }, f)
    assertEquals(unresolved, [])
    assertEquals(body, {
        contact: { id: '1234567890123456', tag: 'wix-1234567890123456', items: [{ email: '1234567890123456' }] },
    })
})

Deno.test('an unresolved token is reported, not shipped as literal braces', () => {
    const f = facts('https://h/a/b')
    const { body, unresolved } = resolveBody({ v: '{query.missing}', w: 'x{nope}y' }, f)
    assertEquals(unresolved, ['query.missing', 'nope'])
    // The alternative — leaving "{query.missing}" in place — hands the
    // application a string nobody wrote, indistinguishable from provider data.
    assertEquals(body, { v: '', w: 'xy' })
})

Deno.test('an unknown transform does not silently pass the value through', () => {
    const f = facts('https://h/x/1234567890123456')
    assertEquals(resolveToken('id|rot13', f), undefined)
})

Deno.test('non-strings are left alone', () => {
    const f = facts('https://h/x/1234567890123456')
    assertEquals(resolveBody({ n: 42, b: true, z: null }, f).body, { n: 42, b: true, z: null })
})
