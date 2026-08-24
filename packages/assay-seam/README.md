# assay-seam

The runtime half of [assay](https://github.com/Scorbutics/assay). Records what a
backend operation touches — shapes, never values — and emits one `@ledger` line
per statement.

Loads in Deno (Supabase Edge Functions, via `npm:assay-seam`) and in node/bun.
Off unless `ASSAY_LEDGER` is set, so it costs nothing in production until asked.

```ts
import { withLedger } from 'assay-seam'

const db = withLedger(createClient(url, serviceKey), {
  operation: 'process-payment',
  serviceRole: true,
})
```

Everything it records is derived from the call: the table, the verb, the filtered
columns, embedded selects, row counts, and whether RLS was bypassed. Error
messages are redacted before they are logged — Postgres puts the offending values
in `DETAIL`, so only the first line survives, with emails and long digit runs
masked.
