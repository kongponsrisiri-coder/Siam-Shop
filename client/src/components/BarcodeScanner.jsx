import React, { useEffect, useRef, useState } from 'react';

// Camera barcode scanner. Uses the native BarcodeDetector API where available
// (Android Chrome, desktop Chrome) and always offers a manual-entry fallback so
// the scanner works on every device (incl. iOS Safari, which lacks the API).
// Calls onScan(code) when a barcode is read or typed.
export default function BarcodeScanner({ onScan }) {
  const videoRef = useRef(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');
  const lastRef = useRef({ code: '', at: 0 });
  const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window;

  useEffect(() => {
    if (!cameraOn) return;
    let stream;
    let raf;
    let stopped = false;
    let detector;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (stopped) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (supported) {
          detector = new window.BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'],
          });
          tick();
        }
      } catch (e) {
        setError('Camera unavailable — type the barcode below.');
      }
    }

    async function tick() {
      if (stopped || !detector || !videoRef.current) return;
      try {
        const codes = await detector.detect(videoRef.current);
        if (codes && codes[0]) {
          const value = codes[0].rawValue;
          const now = Date.now();
          // Debounce: ignore the same code re-detected within 2s.
          if (value && !(value === lastRef.current.code && now - lastRef.current.at < 2000)) {
            lastRef.current = { code: value, at: now };
            onScan(value);
          }
        }
      } catch {
        /* frame not ready */
      }
      raf = requestAnimationFrame(tick);
    }

    start();
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [cameraOn, supported, onScan]);

  function submitManual(e) {
    e.preventDefault();
    const code = manual.trim();
    if (code) {
      onScan(code);
      setManual('');
    }
  }

  return (
    <div className="scanner-cam">
      {cameraOn ? (
        <div className="scanner-video-wrap">
          <video ref={videoRef} className="scanner-video" playsInline muted />
          <div className="scanner-reticle" />
          <button className="btn secondary scanner-stop" onClick={() => setCameraOn(false)}>Stop camera</button>
          {!supported && (
            <div className="scanner-hint">This browser can't auto-detect — type the code below.</div>
          )}
        </div>
      ) : (
        <button className="btn scanner-open" onClick={() => { setError(''); setCameraOn(true); }}>
          📷 Scan with camera
        </button>
      )}
      {error && <div className="err" style={{ marginTop: 6 }}>{error}</div>}

      <form onSubmit={submitManual} className="row" style={{ marginTop: 10, gap: 8 }}>
        <input
          inputMode="numeric"
          placeholder="…or type a barcode"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button className="btn secondary" type="submit">Enter</button>
      </form>
    </div>
  );
}
