import { encodeSdrChannel, getReferenceNits, processImagePixels } from '../color/pipeline.js';
import { encodePNG } from '../decoders/png-encoder.js';
import { encodeRGBE } from '../decoders/rgbe.js';
import { processingClient, copyTypedArrayForTransfer } from './processing-client.js';

const MAX_MAIN_THREAD_FALLBACK_BYTES = 8 * 1024 * 1024;
const CANVAS_ENCODE_TIMEOUT_MS = 120_000;

function assertFallbackSize(image, signal) {
  abortIfNeeded(signal);
  const byteLength = image.data.byteLength ?? image.data.length * Float32Array.BYTES_PER_ELEMENT;
  if (byteLength > MAX_MAIN_THREAD_FALLBACK_BYTES) {
    throw new Error('Background image workers are unavailable. To avoid freezing the viewer, main-thread export is limited to 8 MiB of source pixels; try a smaller image or a browser with Web Worker support.');
  }
}

function formatDetails(format) {
  if (format === 'png' || format === 'webp' || format === 'jpeg') return { kind: format, type: 'sdr' };
  if (format === 'hdr') return { kind: 'rgbe', type: 'hdr' };
  const match = /^png(10|12|16)(sdr|pq|hlg|hdr)$/.exec(format || '');
  if (!match) throw new TypeError(`Unsupported image export format: ${format}`);
  const bitDepth = Number(match[1]);
  const mode = match[2];
  return {
    kind: 'png-high-bit',
    type: mode === 'sdr' ? 'sdr' : 'hdr',
    transfer: mode === 'sdr' ? 'srgb' : mode === 'hdr' ? 'linear' : mode,
    bitDepth
  };
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error('The export was cancelled.');
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  throw error;
}

function abortError(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error('The export was cancelled.');
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

function waitForCanvasBlob(blobPromise, signal) {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timeoutId = setTimeout(() => {
      const error = new Error('Browser image encoding did not finish within 120 seconds.');
      error.name = 'TimeoutError';
      finish(reject, error);
    }, CANVAS_ENCODE_TIMEOUT_MS);
    Promise.resolve(blobPromise).then(
      (blob) => signal?.aborted ? onAbort() : finish(resolve, blob),
      (error) => finish(reject, error)
    );
  });
}

function normalizeAlphaMode(alphaMode, format) {
  if (alphaMode === undefined || alphaMode === null || alphaMode === 'auto') {
    return format === 'jpeg' || format === 'hdr' ? 'flatten' : 'preserve';
  }
  if (!['preserve', 'flatten', 'opaque'].includes(alphaMode)) {
    throw new TypeError(`Unknown alpha mode: ${alphaMode}`);
  }
  if (format === 'jpeg' && alphaMode === 'preserve') return 'flatten';
  if (format === 'hdr' && alphaMode === 'preserve') return 'flatten';
  return alphaMode;
}

function linearScale(image, pixels, options) {
  const referenceNits = getReferenceNits({ ...options, ...image });
  const decodedHDR = image?.decodedHDR ?? options.decodedHDR ?? image?.sourceHDR ?? options.sourceHDR;
  const alreadyHdrRelative = decodedHDR === true || image?.luminanceUnit === 'scRGB-80-nit';
  const scale = alreadyHdrRelative ? 1 : referenceNits / 80;
  if (scale === 1) return pixels;
  const scaled = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    scaled[i] = pixels[i] * scale;
    scaled[i + 1] = pixels[i + 1] * scale;
    scaled[i + 2] = pixels[i + 2] * scale;
    scaled[i + 3] = pixels[i + 3];
  }
  return scaled;
}

function processPixels(image, options, { mode, alphaMode, backgroundColor, pixelMode }) {
  const processingOptions = {
    ...options,
    sourceHDR: image.sourceHDR ?? options.sourceHDR,
    decodedHDR: image.decodedHDR ?? options.decodedHDR,
    luminanceUnit: image.luminanceUnit ?? options.luminanceUnit
  };
  const pixels = processImagePixels(image, processingOptions, { mode, alphaMode, backgroundColor, pixelMode });
  if (mode === 'sdr') {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = encodeSdrChannel(pixels[i], processingOptions.gamma ?? 2.2);
      pixels[i + 1] = encodeSdrChannel(pixels[i + 1], processingOptions.gamma ?? 2.2);
      pixels[i + 2] = encodeSdrChannel(pixels[i + 2], processingOptions.gamma ?? 2.2);
    }
  }
  return pixels;
}

async function encodeLocally(image, options, details, exportOptions) {
  const { alphaMode, backgroundColor, pixelMode, signal } = exportOptions;
  assertFallbackSize(image, signal);
  const mode = details.type === 'sdr' ? 'sdr' : 'hdr';
  let pixels = processPixels(image, options, { mode, alphaMode, backgroundColor, pixelMode });
  abortIfNeeded(signal);

  if (details.kind === 'rgbe') {
    pixels = linearScale(image, pixels, options);
    return encodeRGBE(image.width, image.height, pixels);
  }

  return encodePNG(image.width, image.height, pixels, {
    bitDepth: details.bitDepth,
    type: details.type,
    transfer: details.transfer === 'srgb' ? 'linear' : details.transfer,
    processed: true,
    alphaMode,
    referenceNits: getReferenceNits({ ...options, ...image }),
    linearScaleNits: options.linearScaleNits || options.targetPeak || 1000,
    targetPeak: options.targetPeak,
    hlgPeakNits: options.hlgPeakNits || 1000,
    backgroundColor
  });
}

function getCanvas(width, height) {
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  } else {
    throw new Error('8-bit PNG, JPEG and WebP export requires a browser canvas.');
  }
  return canvas;
}

async function encodeCanvas(image, pixels, format, quality, signal, alreadyBytes = false) {
  abortIfNeeded(signal);
  const canvas = getCanvas(image.width, image.height);
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Could not create a 2D canvas for image export.');
  const canReuseBytes = alreadyBytes && pixels instanceof Uint8ClampedArray && typeof ImageData !== 'undefined';
  const imageData = canReuseBytes
    ? new ImageData(pixels, image.width, image.height)
    : typeof ImageData !== 'undefined'
      ? new ImageData(new Uint8ClampedArray(image.width * image.height * 4), image.width, image.height)
      : context.createImageData(image.width, image.height);
  if (alreadyBytes) {
    if (!canReuseBytes) imageData.data.set(pixels);
  } else {
    for (let i = 0; i < pixels.length; i += 4) {
      imageData.data[i] = Math.round(Math.min(1, Math.max(0, pixels[i])) * 255);
      imageData.data[i + 1] = Math.round(Math.min(1, Math.max(0, pixels[i + 1])) * 255);
      imageData.data[i + 2] = Math.round(Math.min(1, Math.max(0, pixels[i + 2])) * 255);
      imageData.data[i + 3] = Math.round(Math.min(1, Math.max(0, pixels[i + 3])) * 255);
    }
  }
  context.putImageData(imageData, 0, 0);
  abortIfNeeded(signal);

  const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  let blob;
  if (typeof canvas.convertToBlob === 'function') {
    const blobPromise = canvas.convertToBlob({ type: mime, quality: format === 'jpeg' || format === 'webp' ? quality : undefined });
    blob = await waitForCanvasBlob(blobPromise, signal);
  } else {
    const blobPromise = new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) reject(new Error('The browser could not create the exported image.'));
        else resolve(blob);
      }, mime, format === 'jpeg' || format === 'webp' ? quality : undefined);
    } catch (error) {
      reject(error);
    }
    });
    blob = await waitForCanvasBlob(blobPromise, signal);
  }
  abortIfNeeded(signal);
  if (!blob) throw new Error('The browser could not create the exported image.');
  if (blob.type && blob.type !== mime) throw new Error(`This browser does not support ${format.toUpperCase()} encoding.`);
  return blob;
}

function processSdrBytesLocally(image, options, normalized) {
  assertFallbackSize(image, normalized.signal);
  const pixels = processPixels(image, options, {
    mode: 'sdr',
    alphaMode: normalized.alphaMode,
    backgroundColor: normalized.backgroundColor,
    pixelMode: normalized.pixelMode
  });
  const bytes = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    bytes[i] = Math.round(Math.min(1, Math.max(0, pixels[i])) * 255);
    bytes[i + 1] = Math.round(Math.min(1, Math.max(0, pixels[i + 1])) * 255);
    bytes[i + 2] = Math.round(Math.min(1, Math.max(0, pixels[i + 2])) * 255);
    bytes[i + 3] = Math.round(Math.min(1, Math.max(0, pixels[i + 3])) * 255);
  }
  return bytes;
}

/**
 * Export a canonical linear Rec.709 float RGBA image to a Blob.
 *
 * @param {{width:number,height:number,data:Float32Array,colorSpace?:string,luminanceUnit?:string,sourceHDR?:boolean,decodedHDR?:boolean,alpha?:string}} image
 * @param {object} options Render and color-grading options.
 * @param {{format?:string,quality?:number,alphaMode?:'preserve'|'flatten'|'opaque',backgroundColor?:string|number[],pixelMode?:'processed'|'original',signal?:AbortSignal}} exportOptions
 */
export async function exportImageBlob(image, options = {}, exportOptions = {}) {
  const format = exportOptions.format || options.format || 'png';
  const details = formatDetails(format);
  const quality = Math.min(1, Math.max(0, exportOptions.quality ?? 0.9));
  const normalized = {
    alphaMode: normalizeAlphaMode(exportOptions.alphaMode ?? options.alphaMode, format),
    backgroundColor: exportOptions.backgroundColor ?? options.backgroundColor ?? '#ffffff',
    pixelMode: exportOptions.pixelMode ?? options.pixelMode ?? 'processed',
    signal: exportOptions.signal ?? options.signal
  };
  if (!['processed', 'original'].includes(normalized.pixelMode)) throw new TypeError(`Unknown pixel mode: ${normalized.pixelMode}`);
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1) {
    throw new TypeError('Image width and height must be positive integers.');
  }
  if (!image.data || image.data.length !== image.width * image.height * 4) {
    throw new TypeError('Image data must contain exactly width × height × 4 RGBA values.');
  }
  abortIfNeeded(normalized.signal);

  // Avoid cloning a large frame when this environment cannot create workers;
  // the synchronous CPU fallback is intentionally restricted to small images.
  if (typeof Worker === 'undefined') assertFallbackSize(image, normalized.signal);

  if (details.kind === 'png-high-bit' || details.kind === 'rgbe') {
    // Use a worker when available. A fresh transferable copy preserves the
    // image buffer used by the live renderer. The local fallback is used when
    // workers are unavailable (for example in Node-based tests).
    if (processingClient?.runPrepared) {
      const bytes = await processingClient.runPrepared('process-and-encode', image.data.byteLength, () => {
        const data = copyTypedArrayForTransfer(image.data);
        return {
          payload: {
            image: { ...image, data },
            processing: {
              ...options,
              sourceHDR: image.sourceHDR ?? options.sourceHDR,
              decodedHDR: image.decodedHDR ?? options.decodedHDR,
              luminanceUnit: image.luminanceUnit ?? options.luminanceUnit,
              mode: details.type === 'sdr' ? 'sdr' : 'hdr',
              alphaMode: normalized.alphaMode,
              backgroundColor: normalized.backgroundColor,
              pixelMode: normalized.pixelMode
            },
            encode: {
              format: details.kind === 'rgbe' ? 'hdr' : 'png',
              options: {
                bitDepth: details.bitDepth,
                type: details.type,
                transfer: details.transfer === 'srgb' ? 'linear' : details.transfer,
                processed: true,
                alphaMode: normalized.alphaMode,
                referenceNits: getReferenceNits({ ...options, ...image }),
                linearScaleNits: options.linearScaleNits || options.targetPeak || 1000,
                targetPeak: options.targetPeak,
                hlgPeakNits: options.hlgPeakNits || 1000
              }
            }
          },
          transfer: [data.buffer]
        };
      }, {
        signal: normalized.signal,
        fallback: ({ signal } = {}) => {
          const fallbackSignal = signal ?? normalized.signal;
          assertFallbackSize(image, fallbackSignal);
          return encodeLocally(image, options, details, { ...normalized, signal: fallbackSignal });
        }
      });
      abortIfNeeded(normalized.signal);
      return new Blob([bytes], { type: details.kind === 'rgbe' ? 'image/vnd.radiance' : 'image/png' });
    }
    const bytes = await encodeLocally(image, options, details, normalized);
    return new Blob([bytes], { type: details.kind === 'rgbe' ? 'image/vnd.radiance' : 'image/png' });
  }

  const bytes = await processingClient.runPrepared('process-sdr-pixels', image.data.byteLength, () => {
    const data = copyTypedArrayForTransfer(image.data);
    return {
      payload: {
        image: { ...image, data },
        processing: {
          ...options,
          sourceHDR: image.sourceHDR ?? options.sourceHDR,
          decodedHDR: image.decodedHDR ?? options.decodedHDR,
          luminanceUnit: image.luminanceUnit ?? options.luminanceUnit,
          alphaMode: normalized.alphaMode,
          backgroundColor: normalized.backgroundColor,
          pixelMode: normalized.pixelMode
        }
      },
      transfer: [data.buffer]
    };
  }, {
    signal: normalized.signal,
    fallback: ({ signal } = {}) => {
      const fallbackSignal = signal ?? normalized.signal;
      assertFallbackSize(image, fallbackSignal);
      return processSdrBytesLocally(image, options, { ...normalized, signal: fallbackSignal });
    }
  });
  const blob = await encodeCanvas(image, bytes, details.kind, quality, normalized.signal, true);
  return blob;
}
