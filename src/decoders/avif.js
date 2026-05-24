/**
 * SMPTE ST 2084 EOTF (Perceptual Quantizer to absolute luminance in nits).
 * Maps [0, 1] PQ value to [0, 10000] nits.
 */
function pqEotf(x) {
  if (x <= 0.0) return 0.0;
  if (x >= 1.0) return 10000.0;

  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;

  const x_pow = Math.pow(x, 1.0 / m2);
  const num = Math.max(x_pow - c1, 0.0);
  const den = c2 - c3 * x_pow;

  return 10000.0 * Math.pow(num / den, 1.0 / m1);
}

/**
 * Decodes an AVIF image file buffer, preserving HDR data if present.
 * Uses native HTMLImageElement decoding onto a rec2100-pq canvas to avoid WebCodecs YUV-to-RGB composition bugs.
 * @param {ArrayBuffer} buffer
 * @param {File|Blob} [fileOrBlob] Optional file reference for decoding
 * @returns {Promise<{width: number, height: number, data: Float32Array, isHDR: boolean}>}
 */
export async function decodeAVIF(buffer, fileOrBlob) {
  const blob = fileOrBlob || new Blob([buffer], { type: 'image/avif' });

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    
    img.onload = () => {
      URL.revokeObjectURL(url);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      // Try to get HDR context first
      let ctx = null;
      let usedHdr = false;
      try {
        ctx = canvas.getContext('2d', {
          colorSpace: 'rec2100-pq',
          pixelFormat: 'float16'
        });
        if (ctx && ctx.getContextAttributes().colorSpace === 'rec2100-pq') {
          usedHdr = true;
        }
      } catch (e) {
        console.warn("Failed to get PQ context, falling back to SDR", e);
      }

      if (!usedHdr) {
        ctx = canvas.getContext('2d');
      }

      if (!ctx) {
        reject(new Error('Failed to get 2D canvas context'));
        return;
      }

      // Draw image onto the canvas at full size (no scaling)
      ctx.drawImage(img, 0, 0, width, height);

      const numPixels = width * height;
      const floatData = new Float32Array(numPixels * 4);

      if (usedHdr) {
        // Read the float PQ values from the canvas
        const imgData = ctx.getImageData(0, 0, width, height, {
          colorSpace: 'rec2100-pq',
          pixelFormat: 'rgba-float16'
        });

        // Scan to check if it's actually an HDR image.
        // If the peak PQ value in the image exceeds 0.585 (~203 nits), it's HDR.
        let isHdrImage = false;
        for (let i = 0; i < numPixels * 4; i += 4) {
          if (imgData.data[i] > 0.585 || imgData.data[i + 1] > 0.585 || imgData.data[i + 2] > 0.585) {
            isHdrImage = true;
            break;
          }
        }

        if (isHdrImage) {
          // Convert PQ values to linear and scale so 1.0 = 80 nits
          for (let i = 0; i < numPixels * 4; i += 4) {
            floatData[i]     = pqEotf(imgData.data[i]) / 80.0;
            floatData[i + 1] = pqEotf(imgData.data[i + 1]) / 80.0;
            floatData[i + 2] = pqEotf(imgData.data[i + 2]) / 80.0;
            floatData[i + 3] = imgData.data[i + 3]; // keep alpha as-is
          }
          resolve({
            width,
            height,
            data: floatData,
            isHDR: true
          });
        } else {
          // SDR image drawn onto a PQ canvas. Re-read standard sRGB values.
          const sdrData = ctx.getImageData(0, 0, width, height);
          for (let i = 0; i < numPixels * 4; i++) {
            floatData[i] = sdrData.data[i] / 255.0;
          }
          resolve({
            width,
            height,
            data: floatData,
            isHDR: false
          });
        }
      } else {
        // Standard SDR fallback path
        const imgData = ctx.getImageData(0, 0, width, height);
        for (let i = 0; i < numPixels * 4; i++) {
          floatData[i] = imgData.data[i] / 255.0;
        }
        resolve({
          width,
          height,
          data: floatData,
          isHDR: false
        });
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load and decode AVIF image'));
    };

    img.src = url;
  });
}
