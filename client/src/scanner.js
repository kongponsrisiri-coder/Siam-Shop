// Keyboard-wedge barcode scanner capture (SIAMSHOP-DEVICE-001 D2).
// A USB scanner types the code very fast and ends with a suffix key (Enter on
// most, Tab on some, nothing on a few). This turns a keydown stream into scan
// events wherever the focus is, so a scan never lands in the wrong box.
// Pure logic (no DOM) so it is unit-testable: feed it { key, now, target }.
//
//   const cap = createScanCapture({ suffix: 'enter', onScan: (code, meta) => … });
//   window.addEventListener('keydown', (e) => cap.handleKey({ key: e.key, now: performance.now(), target: e.target, preventDefault: () => e.preventDefault() }));
//
// Rules: keys count as one burst while the gap between them is under maxGapMs.
// With suffix 'enter'/'tab', a burst of >= minLength characters ending in the
// suffix is a scan (the suffix keypress is swallowed). With suffix 'none', a
// burst is a scan once it goes quiet for settleMs. Slow human typing never
// reaches minLength within the gap, so it is left alone.
export const SUFFIX_KEYS = { enter: 'Enter', tab: 'Tab', none: null };

export function createScanCapture({ suffix = 'enter', minLength = 6, maxGapMs = 60, settleMs = 120, onScan, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let buf = '';
  let last = 0;
  let target = null;
  let timer = null;
  const suffixKey = SUFFIX_KEYS[suffix] === undefined ? 'Enter' : SUFFIX_KEYS[suffix];

  function reset() { buf = ''; target = null; if (timer) { clearTimer(timer); timer = null; } }
  function fire(meta) {
    const code = buf;
    reset();
    if (code.length >= minLength) onScan(code, meta);
  }

  return {
    get buffer() { return buf; },
    handleKey(e) {
      const now = e.now != null ? e.now : Date.now();
      const gap = now - last;
      last = now;
      if (e.key === suffixKey && suffixKey) {
        if (buf.length >= minLength && gap <= maxGapMs * 2) {
          if (e.preventDefault) e.preventDefault();
          fire({ target, suffix: e.key });
        } else reset();
        return;
      }
      // Printable single characters only (digits, letters, - . / +); modifiers end a burst.
      if (typeof e.key !== 'string' || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) { reset(); return; }
      if (gap > maxGapMs) { buf = ''; target = e.target || null; } // a new burst starts
      if (!target) target = e.target || null;
      buf += e.key;
      if (!suffixKey) {
        if (timer) clearTimer(timer);
        timer = setTimer(() => { timer = null; fire({ target, suffix: null }); }, settleMs);
      }
    },
    reset,
  };
}

// If a scan was typed into some input that was not meant for it, strip the
// code from that input's value (the keystrokes already landed there).
export function stripScanFromInput(el, code) {
  if (!el || typeof el.value !== 'string' || !el.value.endsWith(code)) return false;
  const next = el.value.slice(0, -code.length);
  // React listens to the native 'input' event via its value tracker — set via the prototype setter.
  const proto = Object.getPrototypeOf(el);
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, next); else el.value = next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

export const isTextTarget = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
