// 1-bit print preview of the receipt logo (SIAMSHOP-DEVICE-001 D4, Krit's
// review): the SAME rules as electron/raster.js packBitmap — fit inside
// 384×200 dots, alpha < 128 = paper, luminance < 140 = ink (or the reverse
// when inverted) — drawn on a canvas so the owner sees exactly what the
// thermal printer will produce, plus the share of black so a dark-background
// logo gets a warning before it becomes a black block on paper.
export const PRINT_WIDTH = 384;
export const PRINT_MAX_HEIGHT = 200;
export const THRESHOLD = 140;

export function renderPrintPreview(dataUrl, { invert = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!dataUrl) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(PRINT_WIDTH / img.width, PRINT_MAX_HEIGHT / img.height, 1);
      const w = Math.max(8, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h);
      const d = px.data;
      let black = 0;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        let ink = false;
        if (a >= 128) {
          const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
          const dark = lum < THRESHOLD;
          ink = invert ? !dark : dark;
        }
        if (ink) black++;
        const v = ink ? 0 : 255;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
      ctx.putImageData(px, 0, 0);
      resolve({ dataUrl: c.toDataURL('image/png'), darkRatio: black / (w * h), width: w, height: h });
    };
    img.onerror = () => reject(new Error('Could not read the logo image'));
    img.src = dataUrl;
  });
}
