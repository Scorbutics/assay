#!/usr/bin/env bun
/**
 * Marks a database as disposable, so assay's mutating commands will run against it.
 *
 * Deliberately a separate command with no default target: requiring the URL to be
 * typed out is the point. A flag on the driving command would be habitually passed;
 * a one-off marking act is a decision someone makes once, per database.
 */
import { Client } from 'pg'
import { MARKER_TABLE } from '../lib/guard.ts'

async function main() {
    const args = process.argv.slice(2)
    const i = args.indexOf('--db')
    const dbUrl = i === -1 ? process.env.TEST_DB_URL : args[i + 1]
    if (!dbUrl) {
        console.error('Usage: ledger-mark.ts --db <postgres-url>   (no default — type it out on purpose)')
        process.exit(2)
    }
    const unmark = args.includes('--unmark')
    const client = new Client(dbUrl)
    await client.connect()
    const db = (await client.query('select current_database() as d')).rows[0].d
    if (unmark) {
        await client.query(`drop table if exists public.${MARKER_TABLE}`)
        console.log(`"${db}" is no longer marked disposable.`)
    } else {
        await client.query(`create table if not exists public.${MARKER_TABLE} (
            marked_at timestamptz not null default now(),
            marked_by text not null
        )`)
        await client.query(`insert into public.${MARKER_TABLE} (marked_by) values ($1)`,
            [process.env.USER ?? 'unknown'])
        console.log(`"${db}" marked disposable. assay may now drive mutating operations against it.`)
        console.log('Undo with --unmark.')
    }
    await client.end()
}
main()
