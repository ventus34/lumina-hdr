const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 60_000;

/** Validate image dimensions and account for decoded pixel buffer memory. */
export function assertImageBufferBudget(width, height, {
  channels = 4,
  bytesPerChannel = 4,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions: ${width}×${height}`);
  }
  if (!Number.isSafeInteger(channels) || channels <= 0 || !Number.isSafeInteger(bytesPerChannel) || bytesPerChannel <= 0) {
    throw new Error('Invalid decoded image pixel layout.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid decoded image memory limit.');
  const pixels = width * height;
  const byteLength = pixels * channels * bytesPerChannel;
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(byteLength) || byteLength > maxBytes) {
    throw new Error(`Decoded image would exceed the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB pixel buffer limit.`);
  }
  return { pixels, byteLength };
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

function isBlob(value) {
  return typeof Blob === 'function' && value instanceof Blob;
}

function normalizeExtension(filename, type) {
  const extension = String(filename || '').split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase();
  if (extension && extension !== filename?.toLowerCase()) return extension;
  const mimeMap = {
    'image/avif': 'avif',
    'image/exr': 'exr',
    'image/vnd.radiance': 'hdr',
    'image/x-hdr': 'hdr',
    'image/jxr': 'jxr',
    'image/vnd.ms-photo': 'jxr',
  };
  return mimeMap[String(type || '').toLowerCase()] || extension || '';
}

function canonicalize(result, warnings = [], signal, maxBytes = DEFAULT_MAX_BYTES) {
  if (!result || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || !(result.data instanceof Float32Array)) {
    throw new Error('Image decoder returned an invalid canonical image.');
  }
  const { pixels, byteLength } = assertImageBufferBudget(result.width, result.height, { maxBytes });
  if (result.data.length * Float32Array.BYTES_PER_ELEMENT !== byteLength) throw new Error('Image decoder returned an inconsistent RGBA buffer length.');
  if (result.colorSpace && result.colorSpace !== 'linear-rec709') throw new Error(`Decoder returned unsupported color space ${result.colorSpace}.`);
  if (result.luminanceUnit && !['relative', 'scRGB-80-nit'].includes(result.luminanceUnit)) throw new Error(`Decoder returned unsupported luminance unit ${result.luminanceUnit}.`);
  if (result.alpha && !['straight', 'opaque'].includes(result.alpha)) throw new Error(`Decoder returned unsupported alpha semantics ${result.alpha}.`);
  if (result.data.length !== pixels * 4) throw new Error('Image decoder returned the wrong number of RGBA samples.');
  let maxLuminance = result.maxLuminance;
  if (!Number.isFinite(maxLuminance) || maxLuminance < 0) {
    maxLuminance = 0;
    for (let i = 0; i < result.data.length; i += 4) {
      if ((i & 0x3ffff) === 0) throwIfAborted(signal);
      const luminance = 0.2126 * result.data[i] + 0.7152 * result.data[i + 1] + 0.0722 * result.data[i + 2];
      if (Number.isFinite(luminance) && luminance > maxLuminance) maxLuminance = luminance;
    }
    if (maxLuminance === 0) maxLuminance = 1;
  }
  return {
    ...result,
    colorSpace: 'linear-rec709',
    sourceHDR: Boolean(result.sourceHDR ?? result.isHDR),
    decodedHDR: Boolean(result.decodedHDR ?? result.isHDR),
    warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), ...warnings],
    alpha: result.alpha || 'opaque',
    luminanceUnit: result.luminanceUnit || 'relative',
    maxLuminance,
  };
}

function inferFilename(file, filename) {
  return filename || file?.name || file?.filename || '';
}

function getWorkerFallbackError(error) {
  const wrapped = new Error(error?.message || 'This decoder requires a main-thread browser image API.');
  wrapped.name = error?.name || 'Error';
  wrapped.code = 'REQUIRES_MAIN_THREAD';
  return wrapped;
}

async function decodeStandardImage(blob, signal, maxBytes = DEFAULT_MAX_BYTES, holdWorkOnAbort = false) {
  throwIfAborted(signal);
  let bitmap;
  let image;
  let objectUrl;
  try {
    let source;
    if (typeof createImageBitmap === 'function') {
      bitmap = await withResourceTimeout(createImageBitmap(blob), signal, (value) => value?.close?.(), { holdWorkOnAbort });
      source = bitmap;
    } else if (typeof Image === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      objectUrl = URL.createObjectURL(blob);
      image = await withTimeout(new Promise((resolve, reject) => {
        const img = new Image();
        image = img;
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('The browser could not decode this image.'));
        img.src = objectUrl;
      }), signal, { holdWorkOnAbort });
      source = image;
    } else {
      throw getWorkerFallbackError(new Error('This browser has no supported image decoder for this file.'));
    }

    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    const { pixels } = assertImageBufferBudget(width, height, { maxBytes });
    throwIfAborted(signal);
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(width, height)
      : (() => {
          if (typeof document === 'undefined') throw getWorkerFallbackError(new Error('Canvas decoding requires the main browser thread.'));
          const element = document.createElement('canvas');
          element.width = width;
          element.height = height;
          return element;
        })();
    const context = canvas.getContext('2d', { colorSpace: 'srgb', colorType: 'unorm8', willReadFrequently: true });
    if (!context) throw new Error('Could not create an sRGB Canvas context.');
    context.drawImage(source, 0, 0, width, height);
    const pixelsData = context.getImageData(0, 0, width, height, { colorSpace: 'srgb', pixelFormat: 'rgba-unorm8' }).data;
    if (pixelsData.length !== pixels * 4) throw new Error('Canvas returned an inconsistent image buffer.');
    const data = new Float32Array(pixels * 4);
    for (let i = 0; i < data.length; i += 4) {
      if ((i & 0x3ffff) === 0) throwIfAborted(signal);
      const toLinear = (component) => {
        const x = pixelsData[i + component] / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      data[i] = toLinear(0);
      data[i + 1] = toLinear(1);
      data[i + 2] = toLinear(2);
      data[i + 3] = pixelsData[i + 3] / 255;
    }
    return {
      width,
      height,
      data,
      colorSpace: 'linear-rec709',
      sourceHDR: false,
      decodedHDR: false,
      isHDR: false,
      alpha: 'straight',
      luminanceUnit: 'relative',
      warnings: [],
    };
  } finally {
    bitmap?.close?.();
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.src = '';
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function withTimeout(promise, signal, { holdWorkOnAbort = false } = {}) {
  throwIfAborted(signal);
  let timeoutId;
  let removeAbortListener = () => {};
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Image decoding timed out after 60 seconds.')), DECODE_TIMEOUT_MS);
    if (signal && !holdWorkOnAbort) {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
    removeAbortListener();
  }
}

async function withResourceTimeout(promise, signal, dispose, { holdWorkOnAbort = false } = {}) {
  let abandoned = false;
  let resource = null;
  let disposed = false;
  const disposeOnce = (value) => {
    if (disposed) return;
    disposed = true;
    dispose(value);
  };
  const observed = Promise.resolve(promise).then((value) => {
    resource = value;
    if (abandoned || signal?.aborted) {
      disposeOnce(value);
      throw abortError();
    }
    return value;
  });
  try {
    return await withTimeout(observed, signal, { holdWorkOnAbort });
  } catch (error) {
    abandoned = true;
    if (resource) disposeOnce(resource);
    throw error;
  }
}

/** Decode a File/Blob on the current thread. This same entry point is imported by the worker. */
export async function decodeImage(file, { signal, maxBytes = DEFAULT_MAX_BYTES, holdWorkOnAbort = false } = {}) {
  throwIfAborted(signal);
  if (!isBlob(file) && typeof file?.arrayBuffer !== 'function') throw new TypeError('decodeImage expects a File or Blob.');
  assertImageBufferBudget(1, 1, { maxBytes });
  if (Number(file.size) > MAX_INPUT_BYTES) throw new Error('Image file exceeds the 512 MiB input limit.');
  const filename = inferFilename(file);
  const buffer = await withTimeout(file.arrayBuffer(), signal, { holdWorkOnAbort });
  throwIfAborted(signal);
  return decodeImageBuffer(buffer, filename, { signal, type: file.type, blob: file, maxBytes, holdWorkOnAbort });
}

/** Decode an ArrayBuffer in the current context; used by worker tasks and adapter tests. */
export async function decodeImageBuffer(buffer, filename = '', { signal, type = '', blob = null, maxBytes = DEFAULT_MAX_BYTES, holdWorkOnAbort = false } = {}) {
  throwIfAborted(signal);
  assertImageBufferBudget(1, 1, { maxBytes });
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error('Image file exceeds the 512 MiB input limit.');
  const extension = normalizeExtension(filename, type);
  let result;
  try {
    if (extension === 'avif' || extension === 'avifs') {
      const { decodeAVIF } = await import('../decoders/avif.js');
      result = await decodeAVIF(bytes, blob || new Blob([bytes], { type: 'image/avif' }), { signal, maxBytes, holdWorkOnAbort });
    } else if (extension === 'exr') {
      const { decodeEXR } = await import('../decoders/exr.js');
      result = decodeEXR(bytes, { signal });
    } else if (['jxr', 'wdp', 'hdp'].includes(extension)) {
      const { decodeJXR } = await import('../decoders/jxr.js');
      result = await decodeJXR(bytes, { signal });
    } else if (['hdr', 'rgbe'].includes(extension)) {
      const { decodeRGBE } = await import('../decoders/rgbe.js');
      result = decodeRGBE(bytes, { signal });
    } else if (String(type).startsWith('image/') || /.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(filename)) {
      result = await decodeStandardImage(blob || new Blob([bytes], { type: type || 'application/octet-stream' }), signal, maxBytes, holdWorkOnAbort);
    } else {
      throw new Error(`Unsupported image format${extension ? `: .${extension}` : ''}.`);
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const nativeImageFormat = extension === 'avif' || extension === 'avifs' ||
      (!['exr', 'hdr', 'rgbe', 'jxr', 'wdp', 'hdp'].includes(extension) &&
        (String(type).startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(filename)));
    if (typeof document === 'undefined' && nativeImageFormat && error?.code !== 'REQUIRES_MAIN_THREAD') {
      throw getWorkerFallbackError(error);
    }
    throw error;
  }
  throwIfAborted(signal);
  return canonicalize(result, [], signal, maxBytes);
}
