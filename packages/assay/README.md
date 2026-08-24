# assay

> Determine what a backend operation actually touches, and fail when it differs
> from what was declared. An assay determines a sample's real composition rather
> than its claimed one.

An operation (one Edge Function, one API route) is the backend's unit of structure,
the way an island is the unit on the UI side. Unlike an island it has no observable
output: its real effect is what it did to the database, which is invisible from both
the response body and the source.

The ledger makes that effect legible, then makes it **binding**.

```
discover  →  declare  →  verify
```

## Install cost

Three wrapper call sites, no handler edits:

| Site | Covers |
|---|---|
| `backend/.../_shared/auth/middleware.ts` | all 20 Edge Functions |
| `lib/supabase/server.ts` | Next server callers (RLS enforced) |
| `lib/supabase/admin.ts` | admin/aggregate paths (RLS bypassed) |

Attribution is free: an Edge Function is named by its request path, and a Next
caller by a dev-only stack probe that ranks `app/**/route.ts` above the helper
frame that happened to build the client. Pass an explicit label to override.

## The loop

```bash
export ASSAY_ADMIN_EMAIL=... ASSAY_ADMIN_PASSWORD=...   # a LOCAL account
bun run assay:rpc-map                            # resolve what Postgres functions write
bun run assay:drive <operation> --out /tmp/c.log # drive it, capture its ledger  (~0.5s)
bun run assay:check   /tmp/c.log                 # the gate — exits 1 on drift
bun run assay:declare /tmp/c.log --write         # accept an intended widening
bun run assay:report  /tmp/c.log                 # read/write sets, basins, hotspots, volume
```

`assay:drive` mints its own JWT rather than reading a cached one. An expired token
returns 401, and a 401 is a legitimate refusal to every check here — so a stale
token would quietly turn the whole sweep green.

## Coverage is BRANCH coverage, not operation coverage

An operation may carry a LIST of probes in `.assay/probes.json`, one per branch.
This is the single most important thing to get right, and getting it wrong is
silent: `scoring-cycle` was only ever driven with `sendEmails: false`, so its
`email_logs` write was never observed and never declared — while
`daily-scoring-trigger`, whose code is identical, declared it correctly because it
happened to be driven with the default. Widening that one probe took the corpus
from 15 statements to 119 for that operation.

Some branches need FIXTURE STATE rather than a different payload — `process-payment`
only reaches its notify phase with a payment already in the right state, so its
`members` / `member_referrals` reads remain unobserved. Known limit, not a bug.

`.assay/operations.json` is the **review surface**. A change to what an operation
touches shows up as three lines (`+ writes: audit_log`) instead of four hundred
lines of handler.

## Why the RPC map is mandatory

This codebase pushes mutations into Postgres functions. Without
`.assay/rpc-writes.json`, `complete-mission` reports as a **reader** — it calls
`mark_weekly_task_target_complete` and the client-side seam never sees the write.
A silently empty write set is worse than none, because it is believed. Both
`declare` and `check` refuse to run without the map.

## Severity model

| Level | What | Blocks |
|---|---|---|
| ERROR | undeclared write / rpc / operation, RLS newly bypassed, unfiltered `UPDATE`/`DELETE` | yes |
| WARN | undeclared read — widens coupling, changes nothing | `--strict` |
| NOTE | declared but not exercised | never |

The last row is deliberate. A corpus only contains what was driven, so absence is
almost always missing coverage rather than dead declaration. A gate that punishes
partial runs stops being run.

## Seam 2: outbound HTTP

`globalThis.fetch` is patched once, wherever the DB seam is installed. Every call
to an external service is recorded as `verb: "call"` with a normalized target:

```
▸ backfill-referrals
    calls   GET www.wixapis.com/referral_friends/v1/referred-friends/contact/{id}
```

Patched globally rather than per service client, so it covers services nobody has
written yet. Supabase's own host is skipped — those requests ARE the DB seam.

**Attribution uses AsyncLocalStorage.** The DB seam gets it free (its client is per
request); a process-wide `fetch` has no such handle, and a module-level variable
would interleave between concurrent requests and mis-attribute silently.

**Targets are path TEMPLATES.** `/v1/customers/{id}`, never the raw path — otherwise
the declaration grows one entry per entity. UUIDs, numeric ids and `cus_…`-style
provider ids are collapsed by shape.

A catch-all also collapses opaque segments that are long, mixed-case AND contain a
digit. It exists for id formats nobody enumerated, not for an observed production
defect — the case that prompted it (`contact/fake-bWVtZW50by5nZXN0aW9u…`) is a
LOCAL-DEV construct behind `WIX_FAKE_CONTACTS`, and real Wix contact ids are UUIDs
the shape rules already handled.

All three conditions matter. Requiring only length and mixed case collapsed
`listSubscriptions` and `paymentIntents` to `{id}`, so two different endpoints read
as one target. This is a heuristic and will stay one — the sound fix is a per-host
template map, declaring the paths you expect and treating the rest as unknown.

**A failed call still counts.** A rejected SQL statement touched nothing, so it is
excluded from read/write sets. An outbound request that returns 403 LEFT THE
PROCESS — the third party saw it. Excluding it would let an operation reach a new
service and pass the gate as long as that service said no.

An undeclared call is an **error**, not a warning: the operation now depends on a
service it did not before.

### What this seam does NOT cover

`fetch` only. Email in this project goes out over **SMTP via nodemailer** when
`RESEND_API_KEY` is unset — a socket, not a `fetch` — so `send-warning-email`
reporting `remindersSent: 32` still produces zero outbound entries. The `email_logs`
writes are visible; the sends are not.

## Invariants — the other half

`assay:check` catches STRUCTURAL drift (a table written that was not declared).
It cannot catch LOGICAL drift: a score computed differently writes the same table
with the same verb.

The obvious answer — record input → output, diff it after — is scenario-based and
churns (every intentional change rewrites a baseline until `--update` becomes
reflexive). An invariant is the other half: it holds for **every** input, needs no
recorded scenario, and survives intentional change without a rewrite. On a backend,
where the input space includes the entire database and cannot be enumerated, this is
the closest thing to completeness available.

```bash
bun run assay:invariants                          # all of them
bun run assay:invariants --corpus corpus.log      # only what the run could have broken
bun run assay:invariants --accept                 # baseline existing debt
```

Invariants live in `.assay/invariants.sql`. Each returns the VIOLATING rows — zero
rows means it holds — and its first column is the violation key.

**The ratchet.** A legacy database has pre-existing violations, and an invariant
that is red on day one is ignored by day two. Known keys are recorded in
`.assay/invariant-baseline.json`, reported, and tolerated; NEW keys fail. The
invariant works immediately and the debt can only shrink.

**The ledger link.** With `--corpus`, only invariants whose `tables:` intersect the
run's observed write set are executed — the ledger already knows which invariants an
operation could possibly have broken. Skipped ones are named, never silently passed.

A SQL error in an invariant is a **failure**, not a skip: one that errors quietly is
indistinguishable from one that holds.

## The empty-state obligation

motu's rule is that an island must render from its DEFAULT PROPS ALONE. One
obligation, every island, nothing authored per island — and an island that cannot
meet it has a wrong boundary rather than a missing test.

This is the backend translation: every operation must survive a MINIMAL database
— freshly migrated and seeded, no accumulated rows — without crashing and without
writing outside its declaration.

```bash
supabase db reset                                     # the obligation needs a fresh DB
bun run assay:empty-state --log /tmp/fserve.log
```

Failure is a **5xx**, an undeclared write, or an unfiltered `UPDATE`/`DELETE`. A
**4xx is a pass**: asked for a row that does not exist, an operation should refuse,
not crash. That distinction is the entire check.

`.assay/probes.json` says how each operation is driven. An operation with no probe
is reported as unproven, never as passing.

**It is single-shot.** The run mutates the state it is testing, so a second pass on
the same database measures something else. Valid only as one pass on a fresh reset —
which is the concrete argument for a per-scenario throwaway database.

**It reaches branches recorded traffic never does.** On a populated database
`daily-scoring-trigger` returns "all tasks already generated" and writes nothing; on
an empty one it takes the generation branch and writes four tables. That is not
drift — it is a declaration that was incomplete because the corpus was.

## Magnitude — because a table set is a bad impact signal

The table set is stable under refactor. That is what keeps the gate quiet, and it
is exactly what makes it blind to behaviour.

The clearest case in this repo: commit `eee5455` ("select all max rows was capped
to 1000") rewrote how every read in the app is issued — 974 insertions, 12 files —
and changed the declaration by **one line**. An agent reading that diff learns
nothing about a change that altered the correctness of every large read.

So each declaration also carries a **profile**: banded statement and row counts.

```json
"profile": { "statements": "~10", "rows": { "subscriptions": "~1k", "members": "~50" } }
```

Bands use the 1-2-5 series (1, 2, 5, 10, 20, 50, …). Decade banding was the first
attempt and is too coarse — 18 and 41 statements both land in "~10", which is the
resolution needed to notice an operation doing twice the work. Exact counts would
make this a golden master, with the baseline-rewriting habit that follows.

Drift is a **WARNING**, never an error: an operation legitimately doing more work as
data grows must not block a merge.

```
! daily-scoring-trigger
    issues ~50 statements, declared ~2
    reads ~200 rows from "members", declared ~20
```

**The cap-hit check.** A read returning exactly the PostgREST cap (1000) with no
continuation page is the signature of a silently truncated read — the caller
believes it read the table and got page 1. That is the exact bug `eee5455` fixed,
and the ledger can detect it for free. A capped read FOLLOWED by a short page is
correct paging and is not flagged (the real `1000 / 559` on `subscriptions`).

It is SUSPECTED, not proven: a table holding exactly 1000 rows looks identical.

## What assay does not cover

**An empty result never means "everything is good".** It means *nothing was found in
the categories assay covers*. Every tool prints its own blind spots on a clean run,
from one shared list, so they cannot drift into three different accounts:

- **values** — a field computed differently writes the same table with the same verb
- **trigger and cascade writes** — write sets are a LOWER BOUND
- **which rows changed** — statement-level, not a row diff
- **concurrency** — a single run says nothing about interleaving
- **anything bypassing a wrapped client** — psql, migrations, direct pg
- **logic no invariant describes** — invariants are total over inputs, never over
  properties. They hold only for what someone wrote down.

Large logical and semantic drifts can pass every check here. assay narrows where a
bug can hide; it does not prove there isn't one.

## What it cannot see

Named here because a partial ledger that reads as a complete one is the failure
mode this whole thing exists to prevent:

- **Trigger and cascade writes.** Write sets are a LOWER BOUND.
- **Which rows changed.** Statement-level: tables and verbs, not a row diff.
- **Anything bypassing a wrapped client** — `pg`, psql, migrations.
- **Dynamic SQL** inside a Postgres function (`EXECUTE format(...)`); `assay:rpc-map`
  counts those bodies and reports them.
- **Concurrency.** A single-run ledger says nothing about interleaving.
- **Logical drift not covered by an invariant.** Invariants are total over inputs but
  only over the properties someone wrote down. They are a floor, not a proof.
