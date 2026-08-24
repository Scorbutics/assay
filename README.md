# assay

**What a backend operation actually touches, and a gate that fails when it differs
from what was declared.**

Two packages, because they have different audiences and very different weight:

| package | runs where | weight |
|---|---|---|
| [`@scorbutics/assay-seam`](packages/assay-seam) | in your application, in production | two files, one host requirement (`node:async_hooks`) |
| [`@scorbutics/assay`](packages/assay) | on a developer machine and in CI | node-only; needs `pg` |

`assay-seam` records, as a log line per statement, which table an operation read
or wrote, which columns it filtered on, whether it ran with RLS bypassed, and the
SHAPE of any outbound payload — never the values. `assay` reads those lines and
compares them to `.assay/operations.json`, the declaration, which is the review
surface.

The seam is deliberately separate: it is the only part that ships to production,
so it carries no tooling dependencies and can be audited on its own.

## Why a package rather than a file in your repo

The seam has to load in two runtimes at once — Supabase Edge Functions (Deno) and
a Next.js server — which in a typical project live in two different repositories.
Vendoring a copy into each is the obvious move and the wrong one: the copies
drift, and the drift is silent because both still compile.

Both sides can depend on one published version instead.

The packages live on [JSR](https://jsr.io) rather than npm. JSR is Deno-native,
which is what the Edge half of a Supabase project actually is, and it serves node
consumers through an npm-compatible registry — so one publish covers both. It
also authenticates with GitHub, including OIDC from Actions, so releases need no
registry credentials at all (see `.github/workflows/publish.yml`).

```jsonc
// supabase/functions/deno.json
{ "imports": { "@scorbutics/assay-seam": "jsr:@scorbutics/assay-seam@^0.1.0" } }
```

```ini
# .npmrc
@jsr:registry=https://npm.jsr.io
```

```jsonc
// package.json
{ "dependencies": { "@scorbutics/assay-seam": "npm:@jsr/scorbutics__assay-seam@^0.1.0" } }
```

## Releasing

`git tag v0.1.0 && git push --tags`. Both packages must exist on jsr.io under the
`@scorbutics` scope and be linked to this repository first; that is the only
manual step, and it is done once in a browser.

## What a clean run means

Nothing was found **in the categories assay covers**. It does not check values,
trigger writes, which rows changed, or concurrency. That distinction is printed
on every run on purpose.
