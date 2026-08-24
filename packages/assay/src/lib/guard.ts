/**
 * Refuses to mutate a database nobody marked disposable.
 *
 * ## What this is and is not
 *
 * This is NOT containment. assay is a tool, and a tool cannot constrain its caller:
 * an agent with a shell can curl the endpoint, run psql, or reset the stack without
 * ever invoking assay. Real containment is a harness-level hook (which the harness
 * executes, not the model) or an environment that simply does not have the real
 * database in it.
 *
 * What this IS: a guard on the SANCTIONED path, so the common accident — an agent
 * driving mutating operations against the developer's working database because
 * that is what 127.0.0.1:54322 happens to be — cannot happen quietly. Every
 * mutating assay command checks for a marker table and refuses without it.
 *
 * Marking is deliberate and per-database, so it cannot be inherited by accident:
 *
 *   assay mark --db <url>     # "this database is disposable"
 *
 * The marker records WHO marked it and WHEN, so a stale mark on a database that
 * has since become precious is at least visible rather than silent.
 */

import { Client } from 'pg'

export const MARKER_TABLE = '_assay_scratch'

export interface GuardResult { ok: boolean; database: string; markedAt?: string; markedBy?: string }

export async function checkScratch(dbUrl: string): Promise<GuardResult> {
    const client = new Client(dbUrl)
    await client.connect()
    try {
        const db = (await client.query('select current_database() as d')).rows[0].d as string
        const { rows } = await client.query(
            `select marked_at::text as at, marked_by as by from public.${MARKER_TABLE} limit 1`,
        ).catch(() => ({ rows: [] as Array<{ at: string; by: string }> }))
        if (!rows.length) return { ok: false, database: db }
        return { ok: true, database: db, markedAt: rows[0].at, markedBy: rows[0].by }
    } finally { await client.end() }
}

/** Exits the process with instructions when the target is not a scratch database. */
export async function requireScratch(dbUrl: string, what: string): Promise<void> {
    let result: GuardResult
    try {
        result = await checkScratch(dbUrl)
    } catch (e) {
        console.error(`✗ Cannot reach the database to check whether it is disposable: ${(e as Error).message}`)
        process.exit(2)
    }
    if (result.ok) return
    console.error(`✗ Refusing to ${what}: "${result.database}" is not marked disposable.`)
    console.error('')
    console.error('  assay drives REAL operations, which write real rows. Against a working')
    console.error('  database that is data loss, not a test run.')
    console.error('')
    console.error('  If this database exists to be thrown away:')
    console.error(`    assay mark --db <url>`)
    console.error('')
    console.error('  If it does not, point assay at a scratch stack instead (see assay/README.md).')
    process.exit(2)
}
