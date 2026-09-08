// A statement is attributed to the operation that ISSUED it, not to whatever the
// stack looked like when the client was constructed.
//
// The case this exists for is the browser client, which is a module-level
// singleton: one `withLedger` call, thousands of statements, from every page and
// repository in the app. Binding the label at wrap time gave all of them the same
// answer — and the corpus still looked well-formed, which is why nobody saw it.
//
// A server client is built per request, so both models agree there; those cases
// are asserted too, so the fix cannot be "the browser works now and the server
// regressed quietly".
import { withLedger, collectLedger, runAsOperation } from '../src/ledger.ts';

let pass = 0, fail = 0;
const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` -> ${d}` : ''}`); };

/** The shape the seam actually reads off a postgrest-js builder: a thenable with a URL. */
const builder = (table) => {
  const b = {
    method: 'GET',
    url: new URL(`http://db.test/rest/v1/${table}?select=id`),
    headers: {},
    select() { return b; },
    eq() { b.url.searchParams.set('member_id', 'eq.x'); return b; },
    then(onfulfilled) { return Promise.resolve({ data: [{ id: 1 }], error: null }).then(onfulfilled); },
  };
  return b;
};
const fakeClient = () => ({ from: (table) => builder(table), rpc: (fn) => builder(fn) });

const opsFor = (entries) => entries.map(e => `${e.operation}:${e.target}`);

const run = async () => {
  // ONE client, wrapped once — the browser singleton.
  const client = withLedger(fakeClient(), { enabled: true });

  const { entries } = await collectLedger(async () => {
    await runAsOperation('lib/repositories/teams.ts#listTeams', () => client.from('teams').select('id'));
    await runAsOperation('lib/repositories/directory.ts#search', () => client.rpc('search_directory'));
  });

  t('one client, two callers, two operations',
    JSON.stringify(opsFor(entries)) === JSON.stringify([
      'lib/repositories/teams.ts#listTeams:teams',
      'lib/repositories/directory.ts#search:search_directory',
    ]),
    JSON.stringify(opsFor(entries)));

  // The label is captured when the BUILDER is created, not when it settles: by the
  // time the promise resolves the caller has returned and its scope is gone.
  const { entries: late } = await collectLedger(async () => {
    const pending = runAsOperation('scope-a', () => client.from('members').select('id'));
    await runAsOperation('scope-b', () => client.from('groups').select('id'));
    await pending;
  });
  t('a scope that closed before the promise settled still owns its statement',
    JSON.stringify(opsFor(late).sort()) === JSON.stringify(['scope-a:members', 'scope-b:groups']),
    JSON.stringify(opsFor(late)));

  // A chained filter must not lose the label the chain started with.
  const { entries: chained } = await collectLedger(() =>
    runAsOperation('chained', () => client.from('members').select('id').eq('member_id', 'x')));
  t('the label survives the builder chain',
    chained.length === 1 && chained[0].operation === 'chained' && chained[0].filters.includes('member_id'),
    JSON.stringify(chained.map(e => [e.operation, e.filters])));

  // An explicit label still wins over an ambient scope — the server precedence.
  const labelled = withLedger(fakeClient(), { enabled: true, operation: 'explicit' });
  const { entries: server } = await collectLedger(() =>
    runAsOperation('ambient', () => labelled.from('payments').select('id')));
  t('an explicit operation still wins over the ambient scope',
    server.length === 1 && server[0].operation === 'explicit',
    JSON.stringify(opsFor(server)));

  console.log(`\n${fail ? 'FAIL' : 'ok'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run();
