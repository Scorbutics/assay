#!/usr/bin/env node
/**
 * Bump both packages and regenerate the lockfile.
 *
 * Doing this by hand broke the release twice: a version bump rewrites the
 * import specifiers in packages/assay/deno.json, which invalidates deno.lock,
 * and the check job then fails on a tree the publish job had just accepted.
 * Two steps that must happen together is exactly what a script is for.
 *
 *   node bump.mjs 0.3.2
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node bump.mjs <major.minor.patch>')
  process.exit(2)
}

const files = [
  'packages/assay-seam/jsr.json',
  'packages/assay-seam/package.json',
  'packages/assay/deno.json',
  'packages/assay/package.json',
]
for (const f of files) {
  const j = JSON.parse(readFileSync(f, 'utf8'))
  j.version = version
  for (const k of Object.keys(j.imports ?? {})) {
    if (k.includes('assay-seam')) j.imports[k] = j.imports[k].replace(/@\^[\d.]+/, `@^${version}`)
  }
  writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
  console.log(`  ${f} -> ${version}`)
}

execFileSync('deno', ['install', '--frozen=false'], { stdio: 'inherit' })
console.log(`  deno.lock regenerated — commit both, then: git tag v${version} && git push --tags`)
