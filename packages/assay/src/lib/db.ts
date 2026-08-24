/**
 * Generic database harness: discovery, isolation, and a hard failure when the
 * database is absent.
 *
 * ## Why this replaces a hand-written `_db.ts`
 *
 * The version this supersedes hardcoded one project's CLI invocation, working
 * directory and env keys, so it could not be reused — and, more importantly, it
 * exported `dbReachable` for tests to `skipIf` on. That is the forgetting
 * mechanism: with no local stack the suite skipped 10 integration tests and
 * still reported green, so nobody noticed they had stopped running. Absence read
 * as success.
 *
 * `requireDatabase()` THROWS instead. A harness that quietly does nothing is
 * worse than no harness, because it also removes the signal that you have none.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { projectRoot } from './paths.ts'

const ROOT = projectRoot()

interface Config {
    database: {
        discover?: { command: string; cwd?: string; keys: Record<string, string> }
        envOverride?: string
        isolation?: 'rollback' | 'scratch-clone'
    }
    operations?: { root: string; entry: string }
}

export interface Discovered {
    url: string | null
    restUrl: string | null
    serviceRole: string | null
    /** How it was found, so a failure message can say what was tried. */
    via: string
}

export function loadConfig(path = '.assay/config.json'): Config {
    const full = join(ROOT, path)
    if (!existsSync(full)) {
        throw new Error(`assay: no ${path}. It describes how to reach the database; see assay/README.md.`)
    }
    return JSON.parse(readFileSync(full, 'utf8')) as Config
}

/**
 * The database the data plane is currently pointed at, if it has been moved.
 *
 * `ledger-scratch on` repoints PostgREST at a clone, so driven writes land there
 * — but discovery still reported the WORKING database, so the guard checked the
 * wrong one and the invariants would have queried a database no operation had
 * touched. Two notions of "the database" is one too many.
 */
function activeOverride(): string | null {
    try {
        return (JSON.parse(readFileSync(join(ROOT, '.assay/active-db.json'), 'utf8')) as { database?: string })
            .database ?? null
    } catch { return null }
}

/** Find the database, without deciding whether its absence is acceptable. */
export function discover(config = loadConfig()): Discovered {
    const { discover: d, envOverride } = config.database
    const override = envOverride ? process.env[envOverride] : undefined
    if (override) return { url: override, restUrl: null, serviceRole: null, via: `$${envOverride}` }
    if (!d) return { url: null, restUrl: null, serviceRole: null, via: 'no discovery configured' }
    try {
        const out = execSync(d.command, {
            cwd: d.cwd ? join(ROOT, d.cwd) : ROOT,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString()
        const read = (key: string) => out.match(new RegExp(`^${key}="(.*?)"$`, 'm'))?.[1] ?? null
        const active = activeOverride()
        const base = read(d.keys.url)
        return {
            // Swap only the database name; host, port and credentials are the same
            // instance either way.
            url: base && active ? base.replace(/\/[^/?]+(\?|$)/, `/${active}$1`) : base,
            restUrl: d.keys.restUrl ? read(d.keys.restUrl) : null,
            serviceRole: d.keys.serviceRole ? read(d.keys.serviceRole) : null,
            via: activeOverride() ? `\`${d.command}\` + active override (${activeOverride()})` : `\`${d.command}\``,
        }
    } catch {
        return { url: null, restUrl: null, serviceRole: null, via: `\`${d.command}\` (failed)` }
    }
}

/**
 * The database, or a thrown error naming what was tried.
 *
 * Deliberately not `dbReachable: boolean`. Handing callers a flag invites
 * `skipIf`, and a skipped check is indistinguishable from a passing one in every
 * summary anyone reads.
 */
export function requireDatabase(config = loadConfig()): Discovered & { url: string } {
    const found = discover(config)
    if (found.url) return found as Discovered & { url: string }
    throw new Error(
        `assay: no database reachable (tried ${found.via}).\n` +
        `  Start the local stack, or set $${config.database.envOverride ?? 'TEST_DB_URL'}.\n` +
        `  This is a FAILURE, not a skip: a harness that silently does nothing also\n` +
        `  removes the signal that you have none.`,
    )
}

/**
 * The slice of a `pg` Client this package actually uses.
 *
 * Deliberately STRUCTURAL rather than `pg.Client`. A library that names a
 * foreign type in its public signature forces every consumer onto the same
 * `@types/pg`, and two versions produce two nominally distinct `Client` types
 * whose only visible difference is a compile error in the consumer's tests.
 * That happened the first time this package was consumed from outside its own
 * repository — 8.20 against 8.23.
 */
export interface Queryable {
    // Defaults to `any` exactly as pg's own `query` does. A stricter default
    // would be honest but would force a cast at every call site in a consumer's
    // tests, which is where this type is used most.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query<R = any>(
        text: string,
        values?: unknown[],
    ): Promise<{ rows: R[]; rowCount: number | null }>
}

/**
 * Run `fn` inside a transaction that is ALWAYS rolled back.
 *
 * Real Postgres, so triggers, constraints and RLS all behave — which is exactly
 * what an in-memory mock cannot give you — with zero residue even on failure.
 */
export async function withRollback<T>(fn: (client: Queryable) => Promise<T>, url?: string): Promise<T> {
    const connectionString = url ?? requireDatabase().url
    const client = new Client({ connectionString })
    await client.connect()
    try {
        await client.query('BEGIN')
        return await fn(client)
    } finally {
        await client.query('ROLLBACK').catch(() => {})
        await client.end().catch(() => {})
    }
}
