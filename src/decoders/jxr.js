import jpegxr from 'jpegxr';

// Cached promise for the codec initialization
let codecPromise = null;

function getCodec() {
  if (!codecPromise) {
    // jpegxr() is a factory function returning a Promise that resolves to the codec object.
    // Emscripten builds can sometimes have different default exports. We handle both.
    const factory = typeof jpegxr === 'function' ? jpegxr : (jpegxr.default || window.jpegxr);
    if (typeof factory !== 'function') {
      return Promise.reject(new Error('jpegxr library is not loaded correctly.'));
    }
    codecPromise = factory();
  }
  return codecPromise;
}

/**
 * Decodes a JXR (.jxr) image file buffer.
 * Automatically handles BGR-to-RGB conversion, different bit depths, and formats.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<{width: number, height: number, data: Float32Array}>}
 */
export async function decodeJXR(buffer) {
  const codec = await getCodec();
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  
  // Decode the image bytes
  const image = codec.decode(bytes);
  const { width, height, pixelInfo } = image;
  const decodedBytes = image.bytes; // Uint8Array containing raw decoded buffer

  const numPixels = width * height;
  const floatData = new Float32Array(numPixels * 4); // Target: RGBA Float32Array

  const channels = pixelInfo.channels;
  const hasAlpha = pixelInfo.hasAlpha;
  const bitDepth = pixelInfo.bitDepth;
  const isBGR = pixelInfo.bgr;

  // Let's decode based on bit depth
  if (bitDepth === '32Float') {
    // 32-bit floating point per channel
    const srcFloats = new Float32Array(
      decodedBytes.buffer,
      decodedBytes.byteOffset,
      decodedBytes.byteLength / 4
    );

    for (let i = 0; i < numPixels; i++) {
      const srcIdx = i * channels;
      const dstIdx = i * 4;

      let rVal = srcFloats[srcIdx];
      let gVal = srcFloats[srcIdx + 1];
      let bVal = srcFloats[srcIdx + 2];
      let aVal = hasAlpha && channels > 3 ? srcFloats[srcIdx + 3] : 1.0;

      // Handle BGR swapping
      if (isBGR) {
        const tmp = rVal;
        rVal = bVal;
        bVal = tmp;
      }

      floatData[dstIdx] = rVal;
      floatData[dstIdx + 1] = gVal;
      floatData[dstIdx + 2] = bVal;
      floatData[dstIdx + 3] = aVal;
    }
  } else if (bitDepth === '16' || bitDepth === '16Float') {
    // 16-bit integers or 16-bit half-floats
    // jxrlib might output 16-bit integers for unsigned 16-bit images.
    // If it's a half float, we parse it using half-float bits,
    // otherwise we divide by 65535.
    const isHalfFloat = bitDepth === '16Float';
    const srcUint16 = new Uint16Array(
      decodedBytes.buffer,
      decodedBytes.byteOffset,
      decodedBytes.byteLength / 2
    );

    // Half float conversion helper
    const decodeHalf = (h) => {
      const s = (h & 0x8000) >> 15;
      const e = (h & 0x7c00) >> 10;
      const f = h & 0x03ff;
      if (e === 0) {
        return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
      } else if (e === 31) {
        return f === 0 ? (s ? -Infinity : Infinity) : NaN;
      }
      return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    };

    for (let i = 0; i < numPixels; i++) {
      const srcIdx = i * channels;
      const dstIdx = i * 4;

      let rVal = isHalfFloat ? decodeHalf(srcUint16[srcIdx]) : srcUint16[srcIdx] / 65535.0;
      let gVal = isHalfFloat ? decodeHalf(srcUint16[srcIdx + 1]) : srcUint16[srcIdx + 1] / 65535.0;
      let bVal = isHalfFloat ? decodeHalf(srcUint16[srcIdx + 2]) : srcUint16[srcIdx + 2] / 65535.0;
      let aVal = 1.0;

      if (hasAlpha && channels > 3) {
        aVal = isHalfFloat ? decodeHalf(srcUint16[srcIdx + 3]) : srcUint16[srcIdx + 3] / 65535.0;
      }

      if (isBGR) {
        const tmp = rVal;
        rVal = bVal;
        bVal = tmp;
      }

      floatData[dstIdx] = rVal;
      floatData[dstIdx + 1] = gVal;
      floatData[dstIdx + 2] = bVal;
      floatData[dstIdx + 3] = aVal;
    }
  } else {
    // Assume 8-bit integer per channel (SDR)
    for (let i = 0; i < numPixels; i++) {
      const srcIdx = i * channels;
      const dstIdx = i * 4;

      let rVal = decodedBytes[srcIdx] / 255.0;
      let gVal = decodedBytes[srcIdx + 1] / 255.0;
      let bVal = decodedBytes[srcIdx + 2] / 255.0;
      let aVal = hasAlpha && channels > 3 ? decodedBytes[srcIdx + 3] / 255.0 : 1.0;

      if (isBGR) {
        const tmp = rVal;
        rVal = bVal;
        bVal = tmp;
      }

      floatData[dstIdx] = rVal;
      floatData[dstIdx + 1] = gVal;
      floatData[dstIdx + 2] = bVal;
      floatData[dstIdx + 3] = aVal;
    }
  }

  return {
    width,
    height,
    data: floatData
  };
}
