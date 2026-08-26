/**
 * Where the project is — resolved by searching upward, never by counting `..`.
 *
 * Every command used to derive the project root as
 * `join(projectRoot(), '..')`. That is
 * wrong the moment a file moves, and it is wrong SILENTLY: the command reads a
 * config that is not there and reports nothing found, or writes state into a
 * directory nobody looks at. Moving these files one level deeper broke eight of
 * them at once, and one — the scratch state path — would have pointed the whole
 * toolchain at the wrong database while looking fine.
 *
 * Packaging does not fix that. Installed as a dependency the module sits in
 * `node_modules/assay/…`, where the distance to the project is different again
 * and not knowable at authoring time. So the root is found the way git finds a
 * repository: walk up from the working directory until the marker appears.
 */

import { fileURLToPath } from 'node:url'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** The directory whose presence identifies a project using assay. */
export const MARKER = '.assay'

let cached: string | null = null

/**
 * Nearest ancestor of `from` containing `.assay/`.
 *
 * Anchored on the WORKING DIRECTORY, not on this file: the project is where the
 * command was invoked, not where the code happens to live.
 */
export function projectRoot(from: string = process.cwd()): string {
    if (cached && from === process.cwd()) return cached
    let dir = resolve(from)
    for (;;) {
        if (existsSync(join(dir, MARKER))) {
            if (from === process.cwd()) cached = dir
            return dir
        }
        const parent = dirname(dir)
        // At the filesystem root the walk is over; say what was looked for
        // rather than falling back to a guess that would read as "nothing found".
        if (parent === dir) {
            throw new Error(
                `assay: no ${MARKER}/ directory found in ${resolve(from)} or any parent.\n` +
                `  assay resolves the project by searching upward for ${MARKER}/.\n` +
                `  Run it from inside a project that has one, or create it.`,
            )
        }
        dir = parent
    }
}

/** A path inside the project, from its root. */
export const fromRoot = (...parts: string[]): string => join(projectRoot(), ...parts)

/** A path inside `.assay/`, which is where every declaration and artifact lives. */
export const assayPath = (...parts: string[]): string => join(projectRoot(), MARKER, ...parts)

/**
 * Absolute path to a sibling command module.
 *
 * Commands spawn each other (tier1 and expect both shell out to `static`), and
 * they used to do it through `join(projectRoot(), 'assay/src/commands/x.ts')` —
 * a path into the CONSUMING repository, which was correct only while this tool
 * lived inside one. Once published, that path does not exist and the spawn fails
 * with "Module not found" in the middle of an otherwise working run.
 *
 * Resolved relative to THIS module instead, so it follows the package wherever
 * it is installed.
 */
export function commandPath(name: string): string {
    // `.href`, not the URL object: node's `fileURLToPath` is typed against node's
    // own URL, and under Deno's lib set the global URL is a different type whose
    // URLSearchParams lacks the iterator methods — so passing the object fails
    // type-checking with TS2345 and `deno publish` refuses the package. A string
    // is accepted by both and means the same thing.
    return fileURLToPath(new URL(`../commands/${name}.ts`, import.meta.url).href)
}

/**
 * Whether THIS module is the one the process was started with.
 *
 * Every command file is both a library (its helpers are imported by tests) and a
 * script, so each needs to know which it is being used as. `import.meta.main`
 * looks like the answer and is not reliable here: these files are also spawned
 * through `node_modules/@scorbutics/assay`, a symlink into the workspace, and a
 * runtime that resolves the entrypoint to its realpath while leaving
 * `import.meta.url` on the symlinked path reports `main: false` for a file it is
 * literally executing. That happened on CI and not locally, which is the worst
 * shape a guard can have.
 *
 * Comparing realpaths answers the question the guard is actually asking.
 */
export function isEntrypoint(moduleUrl: string): boolean {
    const entry = process.argv[1]
    if (!entry) return false
    try {
        return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry)
    } catch {
        return false
    }
}
