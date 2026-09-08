Backend work goes through assay (the effect ledger — see assay/README.md):
 - `.assay/operations.json` declares what every backend operation (an Edge Function name,
   or a Next route path) is allowed to touch: the tables it reads and writes, the Postgres
   functions it calls, whether it runs with RLS bypassed, and banded magnitudes. READ THE
   ENTRY before editing an operation — it is the blast radius, and the tables it writes tell
   you which OTHER operations are affected. That is a file read, not a search.
 - A mutation inside a Postgres function counts as a write by the calling operation, even
   though the client only issues an `rpc`. An operation with `rlsBypassed: true` has every
   policy inert on that path — do not assume a policy guards a query there.
 - CHANGING an operation: capture the baseline BEFORE editing, then diff. Seconds, not a sweep:
     bun run assay:drive <op> --out /tmp/before.log     # BEFORE the edit — you cannot get it after
     ...edit...
     bun run assay:drive <op> --out /tmp/after.log
     bun run assay:diff /tmp/before.log /tmp/after.log  # what this change did
     bun run assay:check /tmp/after.log --require <op>  # the gate
   `--require` is not optional: without it an operation you never drove is simply absent
   from the corpus, and absence exits 0. An undeclared write fails; accept an intended
   widening with `bun run assay:declare /tmp/after.log --write` — that diff is the review surface.
 - If no probe reaches the branch you changed, ADD ONE to `.assay/probes.json` (a list per
   operation, one per branch) before you finish. If the branch needs DB state, drive the
   operation that writes the table it reads — the declarations tell you which one that is —
   rather than hand-crafting rows.
 - A NEW endpoint declares its boundary FIRST, then gets implemented. Generating the
   declaration afterwards records whatever the code happened to do, including the bug, and
   the gate then locks it in.
 - A gate that finds nothing means nothing was found IN THE CATEGORIES ASSAY COVERS. It does
   not check values, trigger writes, which rows changed, or concurrency. It is not evidence
   of correctness.
 - Routing: what an operation WRITES and who reads it downstream -> `.assay/operations.json`.
   Where a symbol is, or how code works -> grep and read it.

## What is an operation, and what the gate therefore cannot see

An operation is a request the BACKEND serves: an Edge Function, or a Next route handler,
server component or server action. A statement issued by the BROWSER — a repository or
service module calling PostgREST or an `rpc` through the browser client — is not one. It
has no entry in `.assay/operations.json`, no probe, and no way into a corpus that
`assay drive` produces.

So: A CLEAN `assay:check` SAYS NOTHING ABOUT CLIENT-SIDE DATA ACCESS. Do not cite one as
evidence that a change to a repository module is safe, and do not conclude from an absent
declaration that a table is unwritten — check whether a browser module writes it.

This is not a corner. Measured on this project: ~40 repository and service modules issue
statements directly from the browser, naming 89 distinct Postgres functions. It is the
dominant data path, not an adapter. An earlier version of these rules called it "a few
lines by construction"; that was wrong, and the wrongness is the point — the hole was
described as small because nobody had counted it.

What guards that path instead is RLS. A server operation with `rlsBypassed: true` has every
policy inert; a browser statement is defined ENTIRELY by the policies it runs under. So for
client-side access the review surface is the POLICY, not a declaration — read the migration
that creates it, and say which role you reasoned about.

The seam does record these statements when `NEXT_PUBLIC_ASSAY_LEDGER=on`, as `@ledger` lines
in the browser console, attributed per statement. That is a diagnostic you can read; it is
not a gate, because nothing drives it and nothing declares what it may do. Read it as such.
