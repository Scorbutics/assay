#!/usr/bin/env bun
/**
 * Write assay's host rules into this project's agent instruction files.
 *
 * Usage:
 *   assay rules            # write / update the block
 *   assay rules --check    # exit 1 if the block is missing or stale, write nothing
 *   assay rules --print    # the text, to stdout
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectRoot } from '../lib/paths.ts'
import { applyHostRules, hostRulesText, BEGIN, END, TARGETS } from '../lib/host-rules.ts'

const args = process.argv.slice(2)
const text = hostRulesText()

if (!text) {
    console.error('✗ This build of assay ships no host rules (src/host-rules.md is missing).')
    process.exit(2)
}

if (args.includes('--print')) {
    console.log(text)
    process.exit(0)
}

const root = projectRoot()

if (args.includes('--check')) {
    const block = `${BEGIN}\n${text}\n${END}`
    const present = TARGETS.filter(t => existsSync(resolve(root, t)))
    // No instruction file at all is a finding, not a pass: the rules reach the
    // agent through these files and through nothing else.
    if (!present.length) {
        console.error(`✗ No agent instruction file (${TARGETS.join(', ')}) — the rules reach nobody.`)
        console.error('    assay rules')
        process.exit(1)
    }
    const stale = present.filter(t => !readFileSync(resolve(root, t), 'utf8').includes(block))
    if (stale.length) {
        console.error(`✗ Host rules missing or stale in: ${stale.join(', ')}`)
        console.error('    assay rules')
        process.exit(1)
    }
    console.log(`✓ host-rules  up to date · ${present.length} instruction file(s)`)
    process.exit(0)
}

const { written, unchanged, adopted } = applyHostRules(root)
for (const t of adopted) console.log(`· ${t} carried an unclosed ${BEGIN} — replaced and closed`)
for (const t of written) console.log(`✓ ${t}`)
for (const t of unchanged) console.log(`= ${t} (already current)`)
if (!written.length && !unchanged.length) console.log('(nothing written)')
