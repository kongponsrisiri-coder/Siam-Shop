import React from 'react';
import { quickTenders, pressKey } from '../cash.js';

// Cash tender pad for the till (SIAMSHOP-TILL-CASHPAD).
//
// The till runs on a touchscreen with no keyboard in reach, so the cashier
// needs to enter what the customer handed over without typing (Korakot,
// 7 Sep). Two ways in: the quick-tender row for the note that was actually
// handed over, which is how most cash sales go, and the digits for anything
// else.
//
// Entry is plain decimal — what you press is what shows — because the field
// above it already reads as pounds and pence. No pence accumulation, so
// pressing 4 and 0 means £40, never £0.40.
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];

export default function CashPad({ total, value, onChange, money }) {
  const due = Number(total) || 0;
  const given = value === '' ? null : Number(value);
  const short = given != null && given < due;

  return (
    <div className="cashpad">
      <div className="cashpad-quick">
        {quickTenders(due).map((v) => (
          <button type="button" key={v} className="btn secondary" onClick={() => onChange(v.toFixed(2))}>
            {v === +due.toFixed(2) ? `Exact ${money(v)}` : money(v)}
          </button>
        ))}
      </div>
      <div className="cashpad-keys">
        {KEYS.map((k) => (
          <button type="button" key={k} className="cashpad-key" onClick={() => onChange(pressKey(value, k))}>{k}</button>
        ))}
      </div>
      <button type="button" className="cashpad-clear" onClick={() => onChange('')} disabled={value === ''}>Clear</button>
      {given != null && (
        short
          ? <div className="cashpad-short">{money(due - given)} still to pay</div>
          : <div className="till-change">Change: <strong>{money(given - due)}</strong></div>
      )}
    </div>
  );
}
