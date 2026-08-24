#!/usr/bin/env bun
/**
 * Points the local Supabase stack's DATA plane at a scratch database, so assay can
 * drive real operations without writing to the database you actually use.
 *
 *   assay scratch on      # clone + repoint PostgREST at the clone
 *   assay scratch off     # repoint at the real database
 *   assay scratch status
 *
 * ## Why PostgREST and not an env var
 *
 * The obvious approach — proxy `SUPABASE_URL` at a scratch endpoint — does not
 * work: the Supabase CLI injects `SUPABASE_URL=http://kong:8000` into the Edge
 * runtime and that beats `--env-file`. Worse, it fails SILENTLY: functions keep
 * reading the real database while the ledger fills up and looks correct. The tell
 * was the proxy's own request counter sitting at zero.
 *
 * PostgREST's connection string is the real seam. GoTrue talks to Postgres
 * directly and never goes through PostgREST, so repointing it isolates DATA while
 * leaving AUTH on the real database — which is what you want, since the clone
 * carries the same ids and a real JWT still resolves to a real member.
 *
 * ## What this does NOT isolate
 *
 * Storage, realtime and pg_cron still address the real database. Only the
 * PostgREST data plane moves — enough for assay, not a substitute for a second
 * stack if you need the whole thing.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { dirname as _dirname, join as _join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { projectRoot } from '../lib/paths.ts'

const PROJECT = process.env.ASSAY_PROJECT ?? 'peps_ta_boite_backend'
const DB_CONTAINER = `supabase_db_${PROJECT}`
const REST_CONTAINER = `supabase_rest_${PROJECT}`
const NETWORK = `supabase_network_${PROJECT}`
const SCRATCH = process.env.ASSAY_SCRATCH_DB ?? 'assay_scratch'
const REAL = 'postgres'

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const psql = (db: string, sql: string) =>
    sh('docker', ['exec', '-e', 'PGPASSWORD=postgres', DB_CONTAINER, 'psql', '-U', 'supabase_admin', '-d', db, '-tAc', sql])

function currentDb(): string {
    const env = sh('docker', ['inspect', REST_CONTAINER, '--format', '{{range .Config.Env}}{{println .}}{{end}}'])
    const uri = env.split('\n').find(l => l.startsWith('PGRST_DB_URI='))
    return uri?.split('/').pop() ?? '(unknown)'
}

function repoint(db: string) {
    const env = sh('docker', ['inspect', REST_CONTAINER, '--format', '{{range .Config.Env}}{{println .}}{{end}}'])
    const image = sh('docker', ['inspect', REST_CONTAINER, '--format', '{{.Config.Image}}'])
    // An env file, never shell-expanded `-e` flags: one value here contains
    // characters that mangle the command line, and the failure removes the
    // container before the replacement starts.
    const lines = env.split('\n').filter(l => /^[A-Z_]+=/.test(l) && !l.startsWith('PGRST_DB_URI='))
    lines.push(`PGRST_DB_URI=postgresql://authenticator:postgres@${DB_CONTAINER}:5432/${db}`)
    writeFileSync('/tmp/assay-rest.env', lines.join('\n') + '\n')
    sh('docker', ['rm', '-f', REST_CONTAINER])
    sh('docker', ['run', '-d', '--name', REST_CONTAINER, '--network', NETWORK, '--restart', 'unless-stopped',
        '--env-file', '/tmp/assay-rest.env', image])
}

// Written so every OTHER assay tool (the guard, invariants, drive) talks to the
// same database the data plane is pointed at. Without it they addressed the
// working database while writes landed in the clone.
const STATE = _join(projectRoot(), '.assay', 'active-db.json')

const cmd = process.argv[2]
if (cmd === 'status') {
    const db = currentDb()
    console.log(`PostgREST is serving: ${db}${db === SCRATCH ? '  (SCRATCH — safe to drive)' : '  (REAL — assay will refuse)'}`)
} else if (cmd === 'on') {
    console.log(`Cloning ${REAL} → ${SCRATCH} …`)
    psql(REAL, `select 1`)
    execFileSync('docker', ['exec', '-e', 'PGPASSWORD=postgres', DB_CONTAINER, 'psql', '-U', 'supabase_admin', '-d', REAL,
        '-c', `DROP DATABASE IF EXISTS ${SCRATCH}`], { encoding: 'utf8' })
    execFileSync('docker', ['exec', '-e', 'PGPASSWORD=postgres', DB_CONTAINER, 'psql', '-U', 'supabase_admin', '-d', REAL,
        '-c', `CREATE DATABASE ${SCRATCH}`], { encoding: 'utf8' })
    execFileSync('docker', ['exec', '-e', 'PGPASSWORD=postgres', DB_CONTAINER, 'bash', '-c',
        `pg_dump -U supabase_admin -d ${REAL} | psql -U supabase_admin -d ${SCRATCH} -v ON_ERROR_STOP=0`],
        { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] })
    console.log(`  members=${psql(SCRATCH, 'select count(*) from public.members')} auth.users=${psql(SCRATCH, 'select count(*) from auth.users')}`)
    repoint(SCRATCH)
    writeFileSync(STATE, JSON.stringify({ database: SCRATCH }, null, 2) + '\n')
    console.log(`PostgREST → ${SCRATCH}. Mark it, then drive:`)
    console.log(`  assay mark --db postgresql://postgres:postgres@127.0.0.1:54322/${SCRATCH}`)
    console.log(`Restore with: assay scratch off`)
} else if (cmd === 'off') {
    repoint(REAL)
    if (existsSync(STATE)) unlinkSync(STATE)
    console.log(`PostgREST → ${REAL}. Your working database is live again.`)
} else {
    console.error('Usage: ledger-scratch.ts on|off|status')
    process.exit(2)
}
