import parseExr from 'parse-exr';

/**
 * Decodes an OpenEXR (.exr) file buffer.
 * Ensures the output is a 4-channel RGBA Float32Array.
 * @param {ArrayBuffer} buffer 
 * @returns {{width: number, height: number, data: Float32Array}}
 */
export function decodeEXR(buffer) {
  // Use FloatType (1015) to decode EXR into a 32-bit Float32Array.
  // parse-exr defaults to HalfFloatType (1016) which returns a Uint16Array of half-floats.
  const FloatType = 1015;
  const parsed = parseExr(buffer, FloatType);

  const { width, height, format, data } = parsed;

  const numPixels = width * height;
  let rgbaData;

  if (format === 1023) {
    // Already RGBAFormat (4 channels)
    // Sometimes it might return a Float32Array that is not exactly 4 channels if there's a bug,
    // but standard parse-exr returns width * height * 4 floats for RGBA format.
    if (data.length === numPixels * 4) {
      rgbaData = data instanceof Float32Array ? data : new Float32Array(data);
    } else {
      // Safety padding/cropping
      rgbaData = new Float32Array(numPixels * 4);
      const copyLen = Math.min(data.length, rgbaData.length);
      rgbaData.set(data.subarray(0, copyLen));
    }
  } else if (format === 1028) {
    // RedFormat (1 channel)
    // Convert grayscale to RGBA
    rgbaData = new Float32Array(numPixels * 4);
    for (let i = 0; i < numPixels; i++) {
      const val = data[i];
      const idx = i * 4;
      rgbaData[idx] = val;     // R
      rgbaData[idx + 1] = val; // G
      rgbaData[idx + 2] = val; // B
      rgbaData[idx + 3] = 1.0; // A
    }
  } else {
    // Unknown or other formats (e.g. RGB if parse-exr returns it)
    // We try to guess based on data length
    const channels = data.length / numPixels;
    rgbaData = new Float32Array(numPixels * 4);
    if (channels === 3) {
      for (let i = 0; i < numPixels; i++) {
        const srcIdx = i * 3;
        const dstIdx = i * 4;
        rgbaData[dstIdx] = data[srcIdx];
        rgbaData[dstIdx + 1] = data[srcIdx + 1];
        rgbaData[dstIdx + 2] = data[srcIdx + 2];
        rgbaData[dstIdx + 3] = 1.0;
      }
    } else {
      // Just copy whatever we can
      for (let i = 0; i < numPixels; i++) {
        const dstIdx = i * 4;
        rgbaData[dstIdx] = 1.0;
        rgbaData[dstIdx + 1] = 1.0;
        rgbaData[dstIdx + 2] = 1.0;
        rgbaData[dstIdx + 3] = 1.0;
      }
      const copyLen = Math.min(data.length, rgbaData.length);
      for (let i = 0; i < copyLen; i++) {
        rgbaData[i] = data[i];
      }
    }
  }

  return {
    width,
    height,
    data: rgbaData
  };
}
