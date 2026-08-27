/**
 * The outbound seam must not record the application's OWN database as a third
 * party.
 *
 * `installOutboundSeam` skips the Supabase host — those requests ARE the DB
 * seam, and recording them again counts every statement twice. That lookup read
 * `Deno.env` only, so outside an Edge Function the seam did not know its own
 * host: a Next route with the ledger on recorded `GET {supabase}/rest/v1/members`
 * and `GET {supabase}/auth/v1/user` as outbound calls, and since `check` treats
 * an undeclared call as an ERROR, the route failed the gate for reaching the
 * service it exists to reach.
 *
 * It surfaced the first time Next routes were driven in CI and not once locally,
 * which is the signature of an env-shaped fault: whether the patch is installed
 * before or after the first client is constructed differs between runs.
 */
import { assertEquals } from 'jsr:@std/assert'
import { collectLedger, installOutboundSeam } from './ledger.ts'

/**
 * A fresh module instance per case. `installOutboundSeam` is guarded by a
 * module-level `outboundInstalled` flag — deliberately, since patching
 * `globalThis.fetch` twice would nest wrappers — so a second call in the same
 * process is a no-op and every case after the first would test nothing.
 */
async function seamWith(env: Record<string, string>) {
    const previous = { ...(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env }
    for (const [k, v] of Object.entries(env)) process.env[k] = v
    const fresh = await import(`./ledger.ts?case=${encodeURIComponent(JSON.stringify(env))}`)
    return { fresh, restore: () => { process.env = previous as NodeJS.ProcessEnv } }
}

/**
 * NOT TESTED HERE: that the lookup reads `process.env` at all.
 *
 * Deno mirrors process.env into Deno.env, so a case setting SUPABASE_URL passes
 * under this runner whether the seam reads one or the other — it passed with the
 * fix reverted, which is a test reporting success for a reason unrelated to what
 * it claims. The runtime half is only observable where there is no Deno.env, so
 * it lives in the consumer's node suite (lib/tests/unit/ledger-outbound.test.ts).
 *
 * What IS decidable here is the KEY: nothing mirrors NEXT_PUBLIC_SUPABASE_URL
 * into SUPABASE_URL, so the case below fails against the old lookup.
 */
Deno.test('accepts NEXT_PUBLIC_SUPABASE_URL, which is what a Next server carries', async () => {
    const { fresh, restore } = await seamWith({
        ASSAY_LEDGER: 'on',
        NEXT_PUBLIC_SUPABASE_URL: 'https://next.example.supabase.co',
    })
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
    try {
        fresh.installOutboundSeam()
        const { entries } = await fresh.collectLedger(async () => {
            await fetch('https://next.example.supabase.co/auth/v1/user')
        })
        assertEquals(entries.filter((e: { verb: string }) => e.verb === 'call').length, 0)
    } finally {
        globalThis.fetch = original
        restore()
    }
})

// Referenced so the import is not dead when a case is commented out during
// debugging — the shape of mistake that makes a test file pass by testing less.
void collectLedger
void installOutboundSeam
