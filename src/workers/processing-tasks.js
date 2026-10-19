import { decodeRGBE, encodeRGBE } from '../decoders/rgbe.js';
import { decodeEXR } from '../decoders/exr.js';
import { decodeJXR } from '../decoders/jxr.js';
import { encodePNG } from '../decoders/png-encoder.js';
import { encodeSdrChannel, getReferenceNits, processImagePixels } from '../color/pipeline.js';

function makeRecoverableError(message) {
  return Object.assign(new Error(message), { code: 'REQUIRES_MAIN_THREAD' });
}

async function processAndEncode(payload) {
  const { image, processing = {}, encode = {} } = payload;
  if (!image || !image.data) throw new TypeError('A canonical image is required.');
  const { width, height } = image;
  const effectiveProcessing = {
    ...processing,
    sourceHDR: image.sourceHDR ?? processing.sourceHDR,
    decodedHDR: image.decodedHDR ?? processing.decodedHDR ?? image.sourceHDR ?? processing.sourceHDR,
    luminanceUnit: image.luminanceUnit ?? processing.luminanceUnit
  };
  const processed = processImagePixels(image, effectiveProcessing, {
    mode: processing.mode || 'hdr',
    alphaMode: processing.alphaMode || 'preserve',
    backgroundColor: processing.backgroundColor,
    pixelMode: processing.pixelMode || 'processed'
  });

  if (encode.format === 'png') {
    const pngOptions = { ...(encode.options || {}) };
    const isSdr = pngOptions.type === 'sdr' || processing.mode === 'sdr';
    if (isSdr) {
      const gamma = processing.gamma ?? 2.2;
      for (let i = 0; i < processed.length; i += 4) {
        processed[i] = encodeSdrChannel(processed[i], gamma);
        processed[i + 1] = encodeSdrChannel(processed[i + 1], gamma);
        processed[i + 2] = encodeSdrChannel(processed[i + 2], gamma);
      }
      pngOptions.type = 'sdr';
    }
    return encodePNG(width, height, processed, pngOptions);
  }

  if (encode.format === 'hdr' || encode.format === 'rgbe') {
    const imageOptions = {
      ...effectiveProcessing
    };
    const scale = imageOptions.decodedHDR === true || imageOptions.luminanceUnit === 'scRGB-80-nit'
      ? 1
      : getReferenceNits(imageOptions) / 80;
    if (scale !== 1) {
      for (let i = 0; i < processed.length; i += 4) {
        processed[i] *= scale;
        processed[i + 1] *= scale;
        processed[i + 2] *= scale;
      }
    }
    return encodeRGBE(width, height, processed);
  }

  throw Object.assign(new Error(`Unsupported worker export format: ${encode.format}`), { code: 'UNKNOWN_TASK' });
}

function processSdrPixels(payload) {
  const { image, processing = {} } = payload;
  if (!image || !image.data) throw new TypeError('A canonical image is required.');
  const effectiveProcessing = {
    ...processing,
    sourceHDR: image.sourceHDR ?? processing.sourceHDR,
    decodedHDR: image.decodedHDR ?? processing.decodedHDR ?? image.sourceHDR ?? processing.sourceHDR,
    luminanceUnit: image.luminanceUnit ?? processing.luminanceUnit
  };
  const processed = processImagePixels(image, effectiveProcessing, {
    mode: 'sdr',
    alphaMode: processing.alphaMode || 'preserve',
    backgroundColor: processing.backgroundColor,
    pixelMode: processing.pixelMode || 'processed'
  });
  const gamma = processing.gamma ?? 2.2;
  const bytes = new Uint8ClampedArray(processed.length);
  for (let i = 0; i < processed.length; i += 4) {
    bytes[i] = Math.round(Math.min(1, Math.max(0, encodeSdrChannel(processed[i], gamma))) * 255);
    bytes[i + 1] = Math.round(Math.min(1, Math.max(0, encodeSdrChannel(processed[i + 1], gamma))) * 255);
    bytes[i + 2] = Math.round(Math.min(1, Math.max(0, encodeSdrChannel(processed[i + 2], gamma))) * 255);
    bytes[i + 3] = Math.round(Math.min(1, Math.max(0, processed[i + 3])) * 255);
  }
  return bytes;
}

export async function runProcessingTask(task, payload = {}) {
  switch (task) {
    case 'decode-image': {
      if (/\.avif$/i.test(payload.name || '') && typeof document === 'undefined' &&
          typeof ImageDecoder !== 'function' && typeof createImageBitmap !== 'function') {
        throw makeRecoverableError('AVIF native decoding requires a main-thread image decoder.');
      }
      const { decodeImageBuffer } = await import('../services/decode-image.js');
      try {
        return await decodeImageBuffer(payload.buffer, payload.name, { type: payload.type });
      } catch (error) {
        if (typeof document === 'undefined' && /document|Image|canvas|createImageBitmap/i.test(error?.message || '')) {
          throw makeRecoverableError('This image format requires a main-thread image decoder.');
        }
        throw error;
      }
    }
    case 'decode-rgbe':
      return decodeRGBE(payload.buffer);
    case 'decode-exr':
      return decodeEXR(payload.buffer);
    case 'decode-jxr':
      return decodeJXR(payload.buffer);
    case 'encode-png':
      return encodePNG(payload.width, payload.height, payload.data, payload.options || {});
    case 'encode-rgbe':
      return encodeRGBE(payload.width, payload.height, payload.data);
    case 'process-and-encode':
      return processAndEncode(payload);
    case 'process-sdr-pixels':
      return processSdrPixels(payload);
    default:
      throw Object.assign(new Error(`Unsupported processing task: ${task}`), { code: 'UNKNOWN_TASK' });
  }
}

export function getTransferables(result) {
  if (ArrayBuffer.isView(result)) return [result.buffer];
  if (result instanceof ArrayBuffer) return [result];
  if (!result || typeof result !== 'object') return [];
  const transfer = new Set();
  for (const value of Object.values(result)) {
    if (ArrayBuffer.isView(value)) transfer.add(value.buffer);
    else if (value instanceof ArrayBuffer) transfer.add(value);
  }
  return [...transfer];
}
