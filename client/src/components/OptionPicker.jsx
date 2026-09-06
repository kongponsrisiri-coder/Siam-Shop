import React, { useMemo, useState } from 'react';
import { defaultSelection, selectionValid, unitPrice } from '../options.js';

// Option chooser for a product with option_groups (SIAMSHOP-501).
//
//   <OptionGroups product value={ids} onChange={setIds} lang />   — inline form
//   <OptionPicker product onConfirm={(ids) => …} onClose lang />  — modal wrapper
//
// Big touch targets (till + phone). Required groups show "Required" until
// satisfied; the confirm button stays disabled until every group is valid.

function money(n) {
  return '£' + Number(n || 0).toFixed(2);
}
function delta(n) {
  const v = Number(n) || 0;
  if (v === 0) return '';
  return (v > 0 ? '+' : '−') + money(Math.abs(v));
}
function pick(item, field, lang) {
  return lang === 'th' && item[`${field}_th`] ? item[`${field}_th`] : item[field];
}

export function OptionGroups({ product, value, onChange, lang = 'en' }) {
  const th = lang === 'th';
  const set = new Set(value || []);

  function toggle(g, o) {
    const next = new Set(set);
    const max = Number(g.max_select || 1);
    const inGroup = (g.options || []).filter((x) => next.has(x.id));
    if (next.has(o.id)) {
      next.delete(o.id);
    } else if (max === 1) {
      // Single choice: swap.
      for (const x of inGroup) next.delete(x.id);
      next.add(o.id);
    } else if (inGroup.length < max) {
      next.add(o.id);
    } else {
      return; // at the cap — ignore the tap
    }
    onChange([...next]);
  }

  return (
    <div className="opt-groups">
      {(product.option_groups || []).map((g) => {
        const min = Number(g.min_select || 0);
        const max = Number(g.max_select || 1);
        const chosen = (g.options || []).filter((o) => set.has(o.id)).length;
        const ok = chosen >= min && chosen <= max;
        let hint;
        if (max === 1 && min === 1) hint = th ? 'เลือก 1 อย่าง' : 'Choose one';
        else if (min === max) hint = th ? `เลือก ${min} อย่าง` : `Choose ${min}`;
        else if (min > 0) hint = th ? `เลือก ${min}–${max} อย่าง` : `Choose ${min} to ${max}`;
        else hint = max === 1 ? (th ? 'ไม่บังคับ' : 'Optional') : (th ? `เลือกได้ถึง ${max} อย่าง` : `Up to ${max}, optional`);
        return (
          <div className="opt-group" key={g.id}>
            <div className="opt-group-head">
              <strong>{pick(g, 'name', lang)}</strong>
              <span className={`opt-hint ${min > 0 && !ok ? 'need' : ''}`}>
                {hint}{min > 0 && !ok ? ` · ${th ? 'จำเป็น' : 'Required'}` : ''}
              </span>
            </div>
            <div className="opt-choices">
              {(g.options || []).map((o) => {
                const on = set.has(o.id);
                const full = !on && max > 1 && chosen >= max;
                return (
                  <button
                    type="button"
                    key={o.id}
                    className={`opt-choice ${on ? 'on' : ''}`}
                    disabled={full}
                    onClick={() => toggle(g, o)}
                    aria-pressed={on}
                  >
                    <span>{pick(o, 'name', lang)}</span>
                    {delta(o.price_delta) && <span className="opt-delta">{delta(o.price_delta)}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function OptionPicker({ product, initial, onConfirm, onClose, lang = 'en', confirmLabel }) {
  const th = lang === 'th';
  const [ids, setIds] = useState(() => initial || defaultSelection(product));
  const valid = useMemo(() => selectionValid(product, ids), [product, ids]);
  const price = unitPrice(product, ids);
  const name = th && product.name_th ? product.name_th : product.name;

  return (
    <div className="till-modal opt-modal" onClick={onClose}>
      <div className="opt-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={name}>
        <div className="opt-sheet-head">
          <h3 style={{ margin: 0 }}>{name}</h3>
          <button type="button" className="till-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <OptionGroups product={product} value={ids} onChange={setIds} lang={lang} />
        <div className="opt-sheet-foot">
          <button type="button" className="btn secondary" onClick={onClose}>{th ? 'ยกเลิก' : 'Cancel'}</button>
          <button type="button" className="btn" disabled={!valid} onClick={() => onConfirm(ids)}>
            {(confirmLabel || (th ? 'ใส่ตะกร้า' : 'Add')) + ' · ' + money(price)}
          </button>
        </div>
      </div>
    </div>
  );
}
