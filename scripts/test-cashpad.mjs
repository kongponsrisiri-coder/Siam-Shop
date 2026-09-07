// Cash tender pad arithmetic (client/src/cash.js). No server, no DOM.
//   node scripts/test-cashpad.mjs
import { quickTenders, pressKey } from '../client/src/cash.js';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

console.log('— quick tenders: exact first, then notes a customer would hand over');
eq('£33.05 → exact, 35, 40, 50', quickTenders(33.05), [33.05, 35, 40, 50]);
eq('£10.00 → exact, 20, 50 (no duplicate tens)', quickTenders(10), [10, 20, 50]);
eq('£4.20 → exact, 5, 10, 20', quickTenders(4.2), [4.2, 5, 10, 20]);
eq('£62.00 → exact, 65, 70, 80 (nothing under the total)', quickTenders(62), [62, 65, 70, 80]);
check('never offers less than the total', [0.5, 7.77, 19.99, 51, 123.45].every((t) => quickTenders(t).every((v) => v >= +t.toFixed(2))));
eq('£0 basket does not crash', quickTenders(0), [0, 50]);
eq('rubbish input is treated as nothing', quickTenders('abc'), [0, 50]);

console.log('— key presses build a plain decimal amount');
eq('4 then 0 is forty pounds, not forty pence', ['4', '0'].reduce(pressKey, ''), '40');
eq('leading zero is replaced', pressKey('0', '5'), '5');
eq('a bare point starts at zero', pressKey('', '.'), '0.');
eq('only one point', pressKey('12.5', '.'), '12.5');
eq('two decimals allowed', ['1', '2', '.', '5', '0'].reduce(pressKey, ''), '12.50');
eq('a third decimal is refused', ['1', '.', '2', '3', '4'].reduce(pressKey, ''), '1.23');
eq('backspace removes one', pressKey('40', '⌫'), '4');
eq('backspace on empty stays empty', pressKey('', '⌫'), '');
eq('typing a full note', ['2', '0'].reduce(pressKey, ''), '20');
eq('20.00 then backspace twice', ['⌫', '⌫'].reduce(pressKey, '20.00'), '20.');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
