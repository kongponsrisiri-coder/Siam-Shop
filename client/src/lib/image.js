// Client-side image downscale + compress before upload, so product photos
// taken on a phone (often 3–8 MB) become small JPEGs (~100–250 KB) the server
// stores in-DB. Honours EXIF orientation so portrait phone shots aren't sideways.
export async function compressImage(file, { maxDim = 1000, quality = 0.82 } = {}) {
  if (!file || !file.type?.startsWith('image/')) {
    throw new Error('Please choose an image file.');
  }

  // Decode with EXIF orientation applied where supported.
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await loadViaImg(file);
  }

  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  return canvas.toDataURL('image/jpeg', quality);
}

// Fallback decoder for browsers without createImageBitmap orientation support.
function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
}
