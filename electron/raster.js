// Generic ESC/POS raster helper (SIAMSHOP-DEVICE-001 D4). Any RGBA/BGRA pixel
// buffer → 1-bit MSB-first bitmap → `GS v 0` command. Used for the receipt
// logo today; SIAMSHOP-ELECTRON-002 (Thai on receipts) renders text lines to
// pixels and pushes them through the same function. Pure node — no Electron,
// no image library — so it runs in the test rig. The MAIN process decodes
// images with Electron's nativeImage and hands the raw bitmap here.
const GS = 0x1d;
const MAX_WIDTH_DOTS = 576; // 80 mm paper at 203 dpi; the logo uses 384

// bitmap = { width, height, data: Buffer|Uint8Array, channels = 4, order = 'rgba'|'bgra', threshold = 140 }
// Returns { widthBytes, height, bytes } — width padded to a multiple of 8 (white).
// invert = true for logos that are light-on-dark by design (prints the light parts).
function packBitmap({ width, height, data, channels = 4, order = 'rgba', threshold = 140, invert = false }) {
  if (!width || !height || !data) throw new Error('raster: empty bitmap');
  if (width > MAX_WIDTH_DOTS) throw new Error(`raster: width ${width} exceeds ${MAX_WIDTH_DOTS} dots`);
  const widthBytes = Math.ceil(width / 8);
  const bytes = Buffer.alloc(widthBytes * height); // 0 = white
  const rIdx = order === 'bgra' ? 2 : 0, gIdx = 1, bIdx = order === 'bgra' ? 0 : 2, aIdx = 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      const a = channels > 3 ? data[o + aIdx] : 255;
      if (a < 128) continue; // transparent → paper (white), inverted or not
      const lum = data[o + rIdx] * 0.3 + data[o + gIdx] * 0.59 + data[o + bIdx] * 0.11;
      const dark = lum < threshold;
      if (invert ? !dark : dark) bytes[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { widthBytes, height, bytes };
}

// GS v 0 m=0 xL xH yL yH d1..dk — one command for the whole image (chunking
// produced partial prints on POS80 boards; restaurant lesson).
function gsv0({ widthBytes, height, bytes }) {
  if (bytes.length !== widthBytes * height) throw new Error('raster: size mismatch');
  return Buffer.concat([
    Buffer.from([GS, 0x76, 0x30, 0x00, widthBytes & 0xff, (widthBytes >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff]),
    bytes,
  ]);
}

const bitmapToEscPos = (bitmap) => gsv0(packBitmap(bitmap));

// Share of printed (black) dots — > 0.5 means a dark block on thermal paper.
function darkRatio({ widthBytes, height, bytes }, width) {
  let n = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (bytes[y * widthBytes + (x >> 3)] & (0x80 >> (x & 7))) n++;
  return width && height ? n / (width * height) : 0;
}

// Cheap content hash for caching rasterised logos per data URL.
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + s.length;
}

module.exports = { packBitmap, gsv0, bitmapToEscPos, darkRatio, hashString, MAX_WIDTH_DOTS };
