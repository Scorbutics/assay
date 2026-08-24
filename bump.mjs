#!/usr/bin/env node
/**
 * Bump both packages in step.
 *
 * Four files carry the version and one of them also carries the dependency
 * range between the two packages. Doing that by hand broke two releases.
 *
 *   node bump.mjs 0.3.2
 */
import { readFileSync, writeFileSync } from 'node:fs'

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

console.log(`  done — commit, then: git tag v${version} && git push --tags`)
