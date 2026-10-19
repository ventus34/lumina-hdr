import jpegxr from 'jpegxr';

const MAX_PIXELS = 33_554_432;
let codecPromise = null;

function getCodec() {
  if (!codecPromise) {
    const factory = typeof jpegxr === 'function' ? jpegxr : jpegxr?.default;
    if (typeof factory !== 'function') return Promise.reject(new Error('jpegxr library is not loaded correctly.'));
    codecPromise = Promise.resolve().then(() => factory()).catch((error) => {
      codecPromise = null;
      throw error;
    });
  }
  return codecPromise;
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The decode was aborted.', 'AbortError');
  const error = new Error('The decode was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason?.name === 'AbortError' ? signal.reason : abortError();
}

function srgbEotf(value, maxValue) {
  const x = value / maxValue;
  if (x <= 0.04045) return x / 12.92;
  return Math.pow((x + 0.055) / 1.055, 2.4);
}

function decodeHalf(value) {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function assertDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid JPEG XR dimensions: ${width}×${height}`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS) {
    throw new Error(`JPEG XR exceeds the ${MAX_PIXELS.toLocaleString()} pixel decode limit.`);
  }
  return pixels;
}

function isGrayFormat(colorFormat) {
  return ['Y', 'GRAY', 'GREY', 'L', 'LUMA', 'LUMINANCE'].includes(String(colorFormat || '').toUpperCase());
}

/** Decode JPEG XR to linear-light Rec.709 Float32 RGBA. */
export async function decodeJXR(buffer, { signal } = {}) {
  throwIfAborted(signal);
  const codec = await getCodec();
  throwIfAborted(signal);
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 16) throw new Error('JPEG XR file is too short.');
  const image = codec.decode(bytes);
  return decodeJXRImage(image, { signal });
}

/** Convert a jpegxr library result after validating its declared layout. */
export function decodeJXRImage(image, { signal } = {}) {
  throwIfAborted(signal);
  if (!image || !image.pixelInfo || !(image.bytes instanceof Uint8Array)) throw new Error('JPEG XR decoder returned an invalid image.');

  const { width, height, pixelInfo } = image;
  const pixels = assertDimensions(width, height);
  const { channels, hasAlpha, bitDepth, bgr } = pixelInfo;
  const colorFormat = String(pixelInfo.colorFormat || '').toUpperCase();
  const premultiplied = Boolean(pixelInfo.premultipliedAlpha ?? pixelInfo.premultipledAlpha);
  const gray = isGrayFormat(colorFormat);
  if (![1, 2, 3, 4].includes(channels)) throw new Error(`JPEG XR channel count ${channels} is unsupported.`);
  if (channels <= 2 && !gray) throw new Error(`JPEG XR single/dual-channel format ${colorFormat || '(unknown)'} is unsupported.`);
  if (channels >= 3 && !['RGB', 'BGR'].includes(colorFormat)) throw new Error(`JPEG XR color format ${colorFormat || '(unknown)'} is unsupported.`);
  if ((channels === 2 || channels === 4) !== Boolean(hasAlpha)) throw new Error('JPEG XR channel count conflicts with its alpha metadata.');

  const depthInfo = {
    '8': { bytes: 1, max: 255, float: false },
    '16': { bytes: 2, max: 65535, float: false },
    '16Float': { bytes: 2, max: null, float: true },
    '32Float': { bytes: 4, max: null, float: true },
  }[bitDepth];
  if (!depthInfo) throw new Error(`JPEG XR bit depth ${bitDepth} is unsupported.`);
  const expectedLength = pixels * channels * depthInfo.bytes;
  if (!Number.isSafeInteger(expectedLength) || image.bytes.byteLength !== expectedLength) {
    throw new Error(`JPEG XR decoder returned ${image.bytes.byteLength} bytes; expected ${expectedLength}.`);
  }
  if (Number.isFinite(pixelInfo.bitsPerPixel) && pixelInfo.bitsPerPixel !== channels * depthInfo.bytes * 8) {
    throw new Error('JPEG XR bitsPerPixel conflicts with its channel and sample format.');
  }

  const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  const output = new Float32Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    if ((i & 0x3ffff) === 0) throwIfAborted(signal);
    const source = i * channels;
    const target = i * 4;
    let r;
    let g;
    let b;
    let alpha = hasAlpha ? 0 : 1;
    const read = (component) => {
      const offset = (source + component) * depthInfo.bytes;
      if (bitDepth === '32Float') return view.getFloat32(offset, true);
      if (bitDepth === '16Float') return decodeHalf(view.getUint16(offset, true));
      if (bitDepth === '16') return view.getUint16(offset, true);
      return image.bytes[source + component];
    };

    if (gray) {
      let grayValue = read(0);
      if (hasAlpha) alpha = depthInfo.float ? read(1) : read(1) / depthInfo.max;
      if (premultiplied && alpha > 0) grayValue /= alpha;
      r = g = b = depthInfo.float ? grayValue : srgbEotf(grayValue, depthInfo.max);
    } else {
      let first = read(0);
      let second = read(1);
      let third = read(2);
      if (hasAlpha) alpha = depthInfo.float ? read(3) : read(3) / depthInfo.max;
      if (premultiplied && alpha > 0) {
        first /= alpha;
        second /= alpha;
        third /= alpha;
      }
      if (bgr || colorFormat === 'BGR') [first, third] = [third, first];
      r = depthInfo.float ? first : srgbEotf(first, depthInfo.max);
      g = depthInfo.float ? second : srgbEotf(second, depthInfo.max);
      b = depthInfo.float ? third : srgbEotf(third, depthInfo.max);
    }

    if (![r, g, b, alpha].every(Number.isFinite)) throw new Error(`JPEG XR pixel ${i} contains NaN or Infinity.`);
    if (alpha < 0 || alpha > 1) throw new Error(`JPEG XR pixel ${i} has alpha outside [0, 1].`);
    if (premultiplied && alpha === 0) r = g = b = 0;
    output[target] = r;
    output[target + 1] = g;
    output[target + 2] = b;
    output[target + 3] = alpha;
  }

  const sourceHDR = depthInfo.float;
  const sourceColorAssumption = depthInfo.float
    ? 'The JPEG XR decoder does not expose embedded profile metadata; floating-point samples are assumed to be linear Rec.709 with relative luminance.'
    : 'The JPEG XR decoder does not expose embedded profile metadata; integer samples are assumed to use sRGB transfer and Rec.709 primaries.';
  return {
    width,
    height,
    data: output,
    colorSpace: 'linear-rec709',
    sourceHDR,
    decodedHDR: sourceHDR,
    isHDR: sourceHDR,
    alpha: hasAlpha ? 'straight' : 'opaque',
    luminanceUnit: 'relative',
    sourceColorAssumption,
    warnings: [sourceColorAssumption],
  };
}
