/**
 * Which `public` functions a migration history leaves behind — derived from the
 * SQL files alone, no database.
 *
 * ## Why this exists
 *
 * `assay rpc-map` reads `pg_proc`, so it needs a database, so the map it writes is
 * committed — and a committed copy goes stale the moment a migration adds a
 * function and nobody regenerates it. The only thing that noticed was a nightly
 * job regenerating it against a live stack: a day late, on the default branch.
 *
 * But `rpc-map` keys EVERY `public` function (`prokind = 'f'`), read-only ones as
 * `[]`. So its key SET is a pure function of the migrations: replay CREATE /
 * DROP / ALTER … RENAME in apply order and compare. That half needs no database
 * and can run on every commit (`assay rpc-map --check`).
 *
 * ## Honest limits
 *
 * This is a regex over SQL text, not a parser. It:
 *  - cannot see a changed BODY — same name, same key, different writes. Only a
 *    regeneration from `pg_proc` sees that;
 *  - tracks functions by NAME, as the map does. Dropping one overload by
 *    signature drops the name here, which then reports the map's key as extra —
 *    a loud false positive, never a silent pass;
 *  - misses functions created by `EXECUTE`-built SQL, and counts a
 *    `CREATE FUNCTION` written inside a string literal;
 *  - knows nothing of extensions that install functions into `public`.
 * It is right when it agrees with `pg_proc`, and the nightly regeneration is what
 * says whether it does.
 */

export interface Migration { file: string; sql: string }

/** One identifier: `"Quoted"` keeps its case, a bare one folds to lower case — as Postgres does. */
const ID = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`
/** `[schema.]name`, captured as (schema, name). */
const QNAME = String.raw`(?:(${ID})\s*\.\s*)?(${ID})`

const CREATE = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+${QNAME}\s*\(`, 'gi')
/** `DROP FUNCTION [IF EXISTS] a(int), b, c(text) [CASCADE|RESTRICT];` — the list is captured whole. */
const DROP = /\bdrop\s+function\s+(?:if\s+exists\s+)?([^;]+?)\s*(?:\b(?:cascade|restrict)\b\s*)?;/gi
const DROP_ITEM = new RegExp(String.raw`${QNAME}\s*(?:\([^)]*\))?\s*(?:,|$)`, 'gi')
const RENAME = new RegExp(String.raw`\balter\s+function\s+${QNAME}\s*(?:\([^)]*\))?\s*rename\s+to\s+(${ID})`, 'gi')
const SET_SCHEMA = new RegExp(String.raw`\balter\s+function\s+${QNAME}\s*(?:\([^)]*\))?\s*set\s+schema\s+(${ID})`, 'gi')

const ident = (raw: string): string => raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase()
/** Unqualified counts as `public`: that is where `search_path` puts it in a migration. */
const isPublic = (schema: string | undefined): boolean => schema === undefined || ident(schema) === 'public'

const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '')

type Event = { at: number; apply: (alive: Set<string>) => void }

/** The `public` function names alive after applying `migrations` in lexical file order. */
export function functionsFromMigrations(migrations: Migration[]): Set<string> {
    const alive = new Set<string>()
    for (const { sql: raw } of [...migrations].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)) {
        const sql = stripComments(raw)
        const events: Event[] = []
        for (const m of sql.matchAll(CREATE)) {
            if (!isPublic(m[1])) continue
            const name = ident(m[2])
            events.push({ at: m.index!, apply: a => { a.add(name) } })
        }
        for (const m of sql.matchAll(DROP)) {
            for (const item of m[1].trim().matchAll(DROP_ITEM)) {
                if (!isPublic(item[1])) continue
                const name = ident(item[2])
                events.push({ at: m.index!, apply: a => { a.delete(name) } })
            }
        }
        for (const m of sql.matchAll(RENAME)) {
            if (!isPublic(m[1])) continue
            const from = ident(m[2]), to = ident(m[3])
            events.push({ at: m.index!, apply: a => { a.delete(from); a.add(to) } })
        }
        for (const m of sql.matchAll(SET_SCHEMA)) {
            if (!isPublic(m[1]) || ident(m[3]) === 'public') continue
            const name = ident(m[2])
            events.push({ at: m.index!, apply: a => { a.delete(name) } })
        }
        for (const e of events.sort((x, y) => x.at - y.at)) e.apply(alive)
    }
    return alive
}

export interface MapDrift {
    /** Created by a migration, absent from the map. */
    missing: string[]
    /** In the map, but no migration leaves it behind. */
    extra: string[]
}

export function compareToMap(fromMigrations: Set<string>, mapKeys: Iterable<string>): MapDrift {
    const mapped = new Set(mapKeys)
    return {
        missing: [...fromMigrations].filter(n => !mapped.has(n)).sort(),
        extra: [...mapped].filter(n => !fromMigrations.has(n)).sort(),
    }
}
