/**
 * The rules a HOST's coding agent has to follow for assay's guarantees to mean
 * anything, shipped from one source and written into the host's instruction files.
 *
 * They used to live only in the consuming repository's CLAUDE.md, hand-typed,
 * opened with `<!-- assay:rules -->` and never closed — so nothing could rewrite
 * the block and the text drifted from the tool the moment either changed. The
 * concrete cost: the block still said "a gate that finds nothing means nothing
 * was found IN THE CATEGORIES WEIR COVERS" long after the tool stopped being
 * called Weir, and it described client-side data access as "a few lines by
 * construction" while that path had grown to 40 modules and 89 Postgres
 * functions. Neither is a typo; both are a copy that nobody could update.
 *
 * Written between PAIRED markers and rewritten in place, so re-running updates
 * the block instead of appending a second copy, and whatever the project wrote
 * around it survives.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/**
 * Inside the package, not at the repo root.
 *
 * motu keeps its copy in `.github/`, which works only because its consumers
 * vendor a git checkout — `files: ["src"]` would not ship it, so a project that
 * installed the published package would get a command that silently found no
 * rules. Shipping it as a source file removes that difference between the two
 * ways of consuming assay.
 */
const SOURCE = fileURLToPath(new URL('../host-rules.md', import.meta.url).href)

export const BEGIN = '<!-- assay:rules -->'
export const END = '<!-- /assay:rules -->'

/** The instruction files a coding agent reads, in the order assay writes them. */
export const TARGETS = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md']

/** The shipped rules text, or null when this build carries none. */
export function hostRulesText(): string | null {
    return existsSync(SOURCE) ? readFileSync(SOURCE, 'utf8').trim() : null
}

export interface Applied {
    /** Instruction files rewritten, relative to `dir`. */
    written: string[]
    /** Instruction files that already carried exactly this text. */
    unchanged: string[]
    /**
     * Files carrying an UNCLOSED `<!-- assay:rules -->` — the hand-written shape
     * this command replaces. Reported rather than repaired silently, because the
     * repair rewrites text a human wrote and they should be told which.
     */
    adopted: string[]
}

/**
 * Write the rules into every instruction file the repo already has (and CLAUDE.md
 * if it has none). Idempotent.
 */
export function applyHostRules(dir: string): Applied {
    const text = hostRulesText()
    if (!text) return { written: [], unchanged: [], adopted: [] }
    const block = `${BEGIN}\n${text}\n${END}`
    const existing = TARGETS.filter(t => existsSync(resolve(dir, t)))
    const out: Applied = { written: [], unchanged: [], adopted: [] }

    for (const target of existing.length ? existing : ['CLAUDE.md']) {
        const path = resolve(dir, target)
        const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
        let next: string

        if (before.includes(BEGIN) && before.includes(END)) {
            next = before.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), () => block)
        } else if (before.includes(BEGIN)) {
            // An unclosed marker: the block runs to whatever comes next. Take it to
            // the following top-level marker or heading rather than to end-of-file,
            // which would swallow every rule the project wrote after it.
            const start = before.indexOf(BEGIN)
            const rest = before.slice(start + BEGIN.length)
            const stop = rest.search(/\n<!--|\n## /)
            next = before.slice(0, start) + block + (stop === -1 ? '\n' : rest.slice(stop))
            out.adopted.push(target)
        } else {
            next = `${before.trimEnd()}${before.trim() ? '\n\n' : ''}${block}\n`
        }

        if (next === before) { out.unchanged.push(target); continue }
        writeFileSync(path, next)
        out.written.push(target)
    }
    return out
}
