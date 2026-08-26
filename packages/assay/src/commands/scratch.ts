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
const AUTH_CONTAINER = `supabase_auth_${PROJECT}`
const NETWORK = `supabase_network_${PROJECT}`
const SCRATCH = process.env.ASSAY_SCRATCH_DB ?? 'assay_scratch'
const REAL = 'postgres'

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const psql = (db: string, sql: string) =>
    sh('docker', ['exec', '-e', 'PGPASSWORD=postgres', DB_CONTAINER, 'psql', '-U', 'supabase_admin', '-d', db, '-tAc', sql])

function authDb(): string {
    const env = sh('docker', ['inspect', AUTH_CONTAINER, '--format', '{{range .Config.Env}}{{println .}}{{end}}'])
    return env.split('\n').find(l => l.startsWith('GOTRUE_DB_DATABASE_URL='))?.split('/').pop() ?? '(unknown)'
}

function currentDb(): string {
    const env = sh('docker', ['inspect', REST_CONTAINER, '--format', '{{range .Config.Env}}{{println .}}{{end}}'])
    const uri = env.split('\n').find(l => l.startsWith('PGRST_DB_URI='))
    return uri?.split('/').pop() ?? '(unknown)'
}

/**
 * Recreate `container` with one environment variable replaced.
 *
 * An env file, never shell-expanded `-e` flags: one value here contains
 * characters that mangle the command line, and the failure removes the
 * container before the replacement starts. The image's own command is carried
 * over — `docker run` would otherwise fall back to the image default, which is
 * not what the CLI started these with.
 */
function recreate(container: string, variable: string, value: string, extra: string[] = []) {
    const env = sh('docker', ['inspect', container, '--format', '{{range .Config.Env}}{{println .}}{{end}}'])
    const image = sh('docker', ['inspect', container, '--format', '{{.Config.Image}}'])
    const cmd = JSON.parse(sh('docker', ['inspect', container, '--format', '{{json .Config.Cmd}}']) || 'null') as string[] | null
    const lines = env.split('\n').filter(l => /^[A-Z_]+=/.test(l) && !l.startsWith(`${variable}=`))
    lines.push(`${variable}=${value}`)
    const envFile = `/tmp/assay-${container}.env`
    writeFileSync(envFile, lines.join('\n') + '\n')
    sh('docker', ['rm', '-f', container])
    sh('docker', ['run', '-d', '--name', container, '--network', NETWORK, '--restart', 'unless-stopped',
        '--env-file', envFile, ...extra, image, ...(cmd ?? [])])
}

/**
 * Move BOTH planes to `db` — PostgREST for data, GoTrue for auth.
 *
 * Auth used to be left on the working database deliberately, on the grounds that
 * the clone carries the same ids so a real JWT still resolves. That holds for
 * READING. It does not hold for anything that CREATES a user: GoTrue wrote the
 * new auth.users row into the working database while the member insert went to
 * the clone, and `members_id_fkey` rejected it — so the whole payment pipeline
 * was undrivable under scratch, failing at its first phase with a foreign key
 * error that looks like an application bug and is not one. It also meant driving
 * left real auth.users rows in the database scratch mode exists to protect.
 *
 * The healthcheck is re-declared rather than inherited: `docker run` does not
 * carry over one the CLI attached at runtime, and losing it makes the container
 * read as unhealthy to anything that waits on it.
 */
function repoint(db: string) {
    recreate(REST_CONTAINER, 'PGRST_DB_URI',
        `postgresql://authenticator:postgres@${DB_CONTAINER}:5432/${db}`)
    recreate(AUTH_CONTAINER, 'GOTRUE_DB_DATABASE_URL',
        `postgresql://supabase_auth_admin:postgres@${DB_CONTAINER}:5432/${db}`,
        ['--health-cmd', 'wget --no-verbose --tries=1 --spider http://127.0.0.1:9999/health',
         '--health-interval', '10s', '--health-timeout', '2s', '--health-retries', '3'])
}

// Written so every OTHER assay tool (the guard, invariants, drive) talks to the
// same database the data plane is pointed at. Without it they addressed the
// working database while writes landed in the clone.
const STATE = _join(projectRoot(), '.assay', 'active-db.json')

const cmd = process.argv[2]
if (cmd === 'status') {
    const db = currentDb()
    const auth = authDb()
    console.log(`PostgREST is serving: ${db}${db === SCRATCH ? '  (SCRATCH — safe to drive)' : '  (REAL — assay will refuse)'}`)
    console.log(`GoTrue is serving:    ${auth}`)
    // Split planes are worse than either plane being wrong, and the symptom is a
    // foreign key error on members rather than anything naming the split.
    if (db !== auth) console.log(`  ⚠ DATA and AUTH are on DIFFERENT databases — anything that creates a user will fail on a foreign key.`)
} else if (cmd === 'on') {
    console.log(`Cloning ${REAL} → ${SCRATCH} …`)
    psql(REAL, `select 1`)
    // Re-running `on` is the normal case — a fresh clone per driving session is
    // the point — and it used to fail on the DROP, because the planes this
    // command itself pointed at the clone were still holding sessions open.
    // Move them home first, then evict anything else still attached: a DROP that
    // fails leaves the previous clone in place, and the run that follows drives
    // against yesterday's data while reporting a successful setup.
    if (currentDb() === SCRATCH || authDb() === SCRATCH) repoint(REAL)
    psql(REAL, `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${SCRATCH}'`)
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
    console.log(`PostgREST and GoTrue → ${SCRATCH}. Mark it, then drive:`)
    console.log(`  assay mark --db postgresql://postgres:postgres@127.0.0.1:54322/${SCRATCH}`)
    console.log(`Restore with: assay scratch off`)
} else if (cmd === 'off') {
    repoint(REAL)
    if (existsSync(STATE)) unlinkSync(STATE)
    console.log(`PostgREST and GoTrue → ${REAL}. Your working database is live again.`)
} else {
    console.error('Usage: ledger-scratch.ts on|off|status')
    process.exit(2)
}
