// The browser substitute must behave like AsyncLocalStorage for the three methods the ledger uses,
// and must be honest about the one case where it cannot.
import { AsyncLocalStorage as Shim } from '../src/async-context.browser.ts';
import { AsyncLocalStorage as Real } from 'node:async_hooks';

let pass = 0, fail = 0;
const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` -> ${d}` : ''}`); };

// Run the SAME script against both, so the shim is compared to the thing it replaces rather than to
// my idea of it.
const behaviour = (ALS) => {
  const out = [];
  const als = new ALS();
  out.push(['empty before anything', als.getStore()]);
  als.run('a', () => {
    out.push(['inside run', als.getStore()]);
    als.run('b', () => out.push(['nested', als.getStore()]));
    out.push(['after nesting, restored', als.getStore()]);
  });
  out.push(['after run', als.getStore()]);
  const other = new ALS();
  als.run('x', () => out.push(['instances are independent', other.getStore()]));
  const third = new ALS();
  third.enterWith('entered');
  out.push(['enterWith persists', third.getStore()]);
  out.push(['run returns its value', als.run('v', () => 42)]);
  let threw = null;
  try { als.run('t', () => { throw new Error('boom'); }); } catch (e) { threw = e.message; }
  out.push(['a throw propagates', threw]);
  out.push(['...and still restores', als.getStore()]);
  return out;
};

console.log('\nassay-seam — the browser async context\n');
const real = behaviour(Real);
const shim = behaviour(Shim);
for (let i = 0; i < real.length; i++) {
  const [name, r] = real[i], [, s] = shim[i];
  t(`${name}`, JSON.stringify(r) === JSON.stringify(s), `node=${JSON.stringify(r)} shim=${JSON.stringify(s)}`);
}

// THE LIMIT, asserted rather than described. Two overlapping async scopes are the one thing a single
// variable cannot do, and the comment in the shim promises exactly this difference.
const overlap = async (ALS) => {
  const als = new ALS();
  let seen;
  const first = als.run('first', async () => { await new Promise((r) => setTimeout(r, 10)); seen = als.getStore(); });
  als.run('second', () => {});
  await first;
  return seen;
};
console.log('');
t('node keeps overlapping scopes apart', (await overlap(Real)) === 'first');
t('the shim does not, and says so', (await overlap(Shim)) === undefined, `shim saw ${JSON.stringify(await overlap(Shim))}`);

console.log(`\n${fail === 0 ? 'PASS' : `FAIL — ${fail} assertion(s)`}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
