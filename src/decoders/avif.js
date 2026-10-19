import { convertPrimaries, decodeHlgRgb, decodeTransfer, DEFAULT_HLG_PEAK_NITS } from '../color/pipeline.js';

const MAX_PIXELS = 33_554_432; // 512 MiB for the canonical Float32 RGBA output.
const DECODE_TIMEOUT_MS = 60_000;
const PQ_SCALE_PROBE_BASE64 = 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAdAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAABAAAAAQAAAABBwaXhpAAAAAAMKCgoAAAAMYXYxQ4EATAAAAAATY29scm5jbHgACQAQAAmAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAlbWRhdAoNAAAAAq//iV8qEiATCDIMEACtAgccMMEAAJiA';
let pqScaleProbePromise;
let avifWasmDecoderPromise;

const PRIMARIES = {
  1: 'BT.709',
  9: 'BT.2020',
  12: 'Display P3',
};
const TRANSFERS = {
  1: 'BT.709',
  8: 'linear',
  13: 'sRGB',
  16: 'PQ',
  18: 'HLG',
};

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The decode was aborted.', 'AbortError');
  const error = new Error('The decode was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason?.name === 'AbortError' ? signal.reason : abortError();
}

function validateDimensions(width, height, maxBytes = 512 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16) throw new Error('Invalid AVIF decoded image memory limit.');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid AVIF dimensions: ${width}×${height}`);
  }
  const pixels = width * height;
  const maxPixels = Math.min(MAX_PIXELS, Math.floor(maxBytes / 16));
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    throw new Error(`AVIF exceeds the ${maxPixels.toLocaleString()} pixel decode limit.`);
  }
  return pixels;
}

function readFourCC(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error('Truncated AVIF box type.');
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function parseBoxHeader(bytes, offset, end) {
  if (end - offset < 8) throw new Error('Truncated AVIF box header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(offset, false);
  const type = readFourCC(bytes, offset + 4);
  let headerSize = 8;
  if (size === 1) {
    if (end - offset < 16) throw new Error('Truncated extended AVIF box header.');
    const extendedSize = view.getBigUint64(offset + 8, false);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('AVIF box size exceeds the safe integer limit.');
    size = Number(extendedSize);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) throw new Error(`Invalid AVIF ${type} box size.`);
  return { type, payloadStart: offset + headerSize, end: offset + size, next: offset + size };
}

function listBoxes(bytes, start, end) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    const box = parseBoxHeader(bytes, offset, end);
    boxes.push(box);
    offset = box.next;
  }
  return boxes;
}

function readBoxes(bytes, start, end, visit, depth = 0) {
  if (depth > 16) throw new Error('AVIF box nesting is too deep.');
  let offset = start;
  while (offset < end) {
    const box = parseBoxHeader(bytes, offset, end);
    const { type, payloadStart } = box;
    const boxEnd = box.end;
    visit(type, payloadStart, boxEnd);

    let childStart = null;
    if (type === 'meta') childStart = payloadStart + 4; // FullBox fields.
    else if (['iprp', 'ipco', 'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'mvex', 'moof', 'traf', 'sinf', 'schi', 'meco', 'mere'].includes(type)) childStart = payloadStart;
    else if (type === 'iref') childStart = payloadStart + 4; // FullBox fields before child references.

    if (childStart !== null) {
      if (childStart > boxEnd) throw new Error(`Invalid AVIF ${type} container.`);
      readBoxes(bytes, childStart, boxEnd, visit, depth + 1);
    }
    offset = boxEnd;
  }
}

/** Read AVIF item color metadata without trusting box lengths or allocating pixel memory. */
export function parseAvifColorInfo(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 16) throw new Error('AVIF file is too short to contain an ISO BMFF header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let brands = [];
  const colrBoxes = [];

  readBoxes(bytes, 0, bytes.length, (type, start, end) => {
    if (type === 'ftyp') {
      if (end - start < 8 || (end - start - 8) % 4 !== 0) throw new Error('Invalid AVIF file type box.');
      brands.push(readFourCC(bytes, start));
      for (let p = start + 8; p < end; p += 4) brands.push(readFourCC(bytes, p));
    } else if (type === 'colr') {
      if (end - start >= 4) colrBoxes.push({ type: readFourCC(bytes, start), start: start + 4, end });
    }
  });

  if (!brands.some((brand) => brand === 'avif' || brand === 'avis')) {
    throw new Error('The ISO BMFF file does not declare an AVIF compatible brand.');
  }

  const topBoxes = listBoxes(bytes, 0, bytes.length);
  const meta = topBoxes.find((box) => box.type === 'meta');
  let primaryColrBoxes = [];
  let primaryDimensions = null;
  let colorAssociationKnown = false;
  const warningsForAssociation = [];
  if (meta && meta.end - meta.payloadStart >= 4) {
    const metaChildren = listBoxes(bytes, meta.payloadStart + 4, meta.end);
    const pitm = metaChildren.find((box) => box.type === 'pitm');
    const iprp = metaChildren.find((box) => box.type === 'iprp');
    let primaryItemId = null;
    if (pitm && pitm.end - pitm.payloadStart >= 6) {
      const version = bytes[pitm.payloadStart];
      if (version > 1) throw new Error(`Unsupported AVIF pitm version ${version}.`);
      primaryItemId = version === 0
        ? view.getUint16(pitm.payloadStart + 4, false)
        : version === 1 ? view.getUint32(pitm.payloadStart + 4, false) : null;
    } else if (pitm) {
      throw new Error('Truncated AVIF primary item box.');
    }
    if (iprp && primaryItemId !== null) {
      const iprpChildren = listBoxes(bytes, iprp.payloadStart, iprp.end);
      const ipco = iprpChildren.find((box) => box.type === 'ipco');
      const ipma = iprpChildren.find((box) => box.type === 'ipma');
      if (ipco && ipma) {
        const properties = listBoxes(bytes, ipco.payloadStart, ipco.end);
        const associations = new Map();
        const version = bytes[ipma.payloadStart];
        if (version > 1) throw new Error(`Unsupported AVIF ipma version ${version}.`);
        const flags = (bytes[ipma.payloadStart + 1] << 16) | (bytes[ipma.payloadStart + 2] << 8) | bytes[ipma.payloadStart + 3];
        const large = Boolean(flags & 1);
        let p = ipma.payloadStart + 4;
        if (p + 4 > ipma.end) throw new Error('Truncated AVIF ipma property associations.');
        const entryCount = view.getUint32(p, false);
        p += 4;
        for (let entry = 0; entry < entryCount; entry++) {
          const idBytes = version < 1 ? 2 : 4;
          if (p + idBytes + 1 > ipma.end) throw new Error('Truncated AVIF ipma item entry.');
          const itemId = idBytes === 2 ? view.getUint16(p, false) : view.getUint32(p, false);
          p += idBytes;
          const count = bytes[p++];
          const indices = [];
          for (let j = 0; j < count; j++) {
            const associationBytes = large ? 2 : 1;
            if (p + associationBytes > ipma.end) throw new Error('Truncated AVIF ipma property index.');
            const raw = large ? view.getUint16(p, false) : bytes[p];
            p += associationBytes;
            const index = large ? (raw & 0x7fff) : (raw & 0x7f);
            if (index > properties.length) throw new Error('AVIF ipma references a missing image property.');
            indices.push(index);
          }
          associations.set(itemId, indices);
        }
        if (p !== ipma.end) throw new Error('AVIF ipma box contains trailing bytes.');
        const indices = associations.get(primaryItemId) || [];
        colorAssociationKnown = associations.has(primaryItemId);
        const primaryProperties = indices.map((index) => properties[index - 1]).filter(Boolean);
        primaryColrBoxes = primaryProperties.filter((property) => property.type === 'colr').map((property) => ({
          type: readFourCC(bytes, property.payloadStart),
          start: property.payloadStart + 4,
          end: property.end,
        }));
        const ispeProperties = primaryProperties.filter((property) => property.type === 'ispe');
        if (ispeProperties.length > 1) warningsForAssociation.push('AVIF primary item has multiple spatial-extent properties; the first was used.');
        if (ispeProperties.length) {
          const ispe = ispeProperties[0];
          if (ispe.end - ispe.payloadStart !== 12) throw new Error('Invalid AVIF primary-item ispe property.');
          primaryDimensions = {
            width: view.getUint32(ispe.payloadStart + 4, false),
            height: view.getUint32(ispe.payloadStart + 8, false),
          };
          if (!primaryDimensions.width || !primaryDimensions.height) throw new Error('AVIF primary item has invalid dimensions.');
        }
      }
    }
  }

  const candidates = colorAssociationKnown ? primaryColrBoxes : colrBoxes;
  const nclxBoxes = candidates.filter((box) => box.type === 'nclx');
  const nclx = nclxBoxes[0];
  if (!colorAssociationKnown && colrBoxes.length) warningsForAssociation.push('AVIF has color properties but no verified primary-item association; metadata may belong to an auxiliary image.');
  if (nclxBoxes.length > 1) warningsForAssociation.push('The primary AVIF item has multiple nclx properties; the first associated property was used.');
  if (!nclx) {
    return {
      primaries: null,
      transfer: null,
      matrix: null,
      fullRange: null,
      primariesName: 'unspecified',
      transferName: 'unspecified',
      ...primaryDimensions,
      sourceHDR: false,
      sourceHDRKnown: false,
      warnings: [...warningsForAssociation, candidates.length
        ? 'AVIF color metadata uses an ICC or unsupported profile; browser color management will be used.'
        : 'AVIF has no verified primary-item nclx transfer metadata; its HDR status is unknown.'],
    };
  }

  if (nclx.end - nclx.start < 7) throw new Error('Truncated AVIF nclx color metadata.');
  const primaries = view.getUint16(nclx.start, false);
  const transfer = view.getUint16(nclx.start + 2, false);
  const matrix = view.getUint16(nclx.start + 4, false);
  const rangeByte = bytes[nclx.start + 6];
  const warnings = [...warningsForAssociation];
  if (rangeByte & 0x7f) warnings.push('AVIF nclx reserved range bits are nonzero.');
  if (!PRIMARIES[primaries]) warnings.push(`AVIF uses unrecognized color primaries (${primaries}); browser color management will be used.`);
  if (!TRANSFERS[transfer]) warnings.push(`AVIF uses an unrecognized transfer function (${transfer}); its color interpretation may be approximate.`);
  if (![0, 1, 9, 10].includes(matrix)) warnings.push(`AVIF uses an unrecognized YUV matrix (${matrix}); browser color management will be used.`);
  if (!colorAssociationKnown && [16, 18].includes(transfer)) {
    warnings.push('AVIF transfer metadata indicates HDR, but it is not associated with the primary item; source HDR status is unknown.');
  }

  return {
    primaries,
    transfer,
    matrix,
    fullRange: Boolean(rangeByte & 0x80),
    primariesName: PRIMARIES[primaries] || `CICP ${primaries}`,
    transferName: TRANSFERS[transfer] || `CICP ${transfer}`,
    ...primaryDimensions,
    sourceHDR: colorAssociationKnown && (transfer === 16 || transfer === 18),
    sourceHDRKnown: colorAssociationKnown,
    warnings,
  };
}

function srgbToLinear(value) {
  return decodeTransfer(value / 255, 'srgb');
}

function pqToScRgb80(encoded) {
  const m1 = 2610 / 16384;
  const m2 = 2523 / 32;
  const c1 = 3424 / 4096;
  const c2 = 2413 / 128;
  const c3 = 2392 / 128;
  const p = encoded ** (1 / m2);
  const normalized = (Math.max(p - c1, 0) / (c2 - c3 * p)) ** (1 / m1);
  return normalized * 10_000 / 80;
}

function makePqScaleProbeBytes() {
  if (typeof atob !== 'function') return null;
  const binary = atob(PQ_SCALE_PROBE_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Validate the browser's actual PQ-to-linear scale before claiming scRGB-80-nit output. */
async function hasVerifiedPqScale(signal, holdWorkOnAbort = false) {
  if (!pqScaleProbePromise) {
    pqScaleProbePromise = (async () => {
      const bytes = makePqScaleProbeBytes();
      if (!bytes) return false;
      const metadata = parseAvifColorInfo(bytes);
      if (!metadata.sourceHDRKnown || metadata.transfer !== 16 || metadata.primaries !== 9) return false;
      const decoded = await tryDecodePqFloat16(bytes, metadata);
      if (!decoded) return false;
      const expected = pqToScRgb80(512 / 1023);
      const tolerance = Math.max(expected * 0.02, 0.002);
      return [0, 1, 2].every((channel) => Math.abs(decoded.data[channel] - expected) <= tolerance);
    })().catch(() => false);
  }
  return withTimeout(pqScaleProbePromise, signal, { holdWorkOnAbort });
}

/** Convert jSquash's untonemapped 16-bit AV1 RGB samples to canonical linear RGB. */
export function decodeAVIFHighBitImage(image, metadata, { signal, maxBytes = 512 * 1024 * 1024 } = {}) {
  throwIfAborted(signal);
  if (!image || !(image.data instanceof Uint16Array)) throw new Error('AVIF high-bit decoder did not return Uint16 pixel data.');
  if (!metadata?.sourceHDRKnown || ![16, 18].includes(metadata.transfer)) {
    throw new Error('AVIF high-bit decode requires primary-associated PQ or HLG metadata.');
  }
  const primaryName = { 1: 'rec709', 9: 'rec2020', 12: 'displayP3' }[metadata.primaries];
  if (!primaryName) throw new Error(`AVIF primaries ${metadata.primaries} are not supported by the HDR decoder.`);
  if (metadata.transfer === 18 && metadata.primaries !== 9) {
    throw new Error('AVIF HLG decoding currently requires BT.2020 primaries for its display OOTF.');
  }
  if (![0, 1, 9, 10].includes(metadata.matrix)) throw new Error(`AVIF YUV matrix ${metadata.matrix} is not supported by the HDR decoder.`);
  const pixels = validateDimensions(image.width, image.height, maxBytes);
  if (image.data.length !== pixels * 4) throw new Error('AVIF high-bit decoder returned an inconsistent RGBA buffer.');
  const data = new Float32Array(pixels * 4);
  const transferName = metadata.transfer === 16 ? 'pq' : 'hlg';
  const warnings = metadata.transfer === 18
    ? [...metadata.warnings, `HLG uses the BT.2100 display OOTF with a fixed ${DEFAULT_HLG_PEAK_NITS} cd/m² peak and gamma 1.2.`]
    : [...metadata.warnings];
  for (let i = 0; i < pixels; i++) {
    if ((i & 0x3fff) === 0) throwIfAborted(signal);
    const offset = i * 4;
    const encoded = [image.data[offset] / 65535, image.data[offset + 1] / 65535, image.data[offset + 2] / 65535];
    const linear = metadata.transfer === 18
      ? decodeHlgRgb(encoded, { peakNits: DEFAULT_HLG_PEAK_NITS, gamma: 1.2, referenceWhiteNits: 80 })
      : encoded.map((channel) => decodeTransfer(channel, transferName));
    const rec709 = convertPrimaries(linear, primaryName, 'rec709');
    const alpha = image.data[offset + 3] / 65535;
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || !rec709.every((channel) => Number.isFinite(channel) && Math.abs(channel) <= 3.402823466e38)) {
      throw new Error(`AVIF pixel ${i} contains an invalid high-bit channel.`);
    }
    data[offset] = rec709[0];
    data[offset + 1] = rec709[1];
    data[offset + 2] = rec709[2];
    data[offset + 3] = alpha;
  }
  return {
    width: image.width,
    height: image.height,
    data,
    colorSpace: 'linear-rec709',
    sourceHDR: true,
    sourceHDRKnown: true,
    decodedHDR: true,
    isHDR: true,
    alpha: 'straight',
    luminanceUnit: 'scRGB-80-nit',
    warnings,
  };
}

async function getAVIFWasmDecoder() {
  if (!avifWasmDecoderPromise) {
    avifWasmDecoderPromise = import('@jsquash/avif/decode.js').then(async (decoderModule) => {
      // The package's generated Emscripten module resolves its adjacent WASM
      // through `new URL(..., import.meta.url)`, which Vite inlines as one asset.
      await decoderModule.init();
      return decoderModule.default;
    }).catch((error) => {
      avifWasmDecoderPromise = null;
      throw error;
    });
  }
  return avifWasmDecoderPromise;
}

async function decodeAVIFWithWasm(bytes, metadata, signal, maxBytes, holdWorkOnAbort) {
  throwIfAborted(signal);
  const decode = await withTimeout(getAVIFWasmDecoder(), signal, { holdWorkOnAbort });
  const exactBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const image = await withTimeout(decode(exactBuffer, { bitDepth: 16 }), signal, { holdWorkOnAbort });
  throwIfAborted(signal);
  return decodeAVIFHighBitImage(image, metadata, { signal, maxBytes });
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('No Canvas implementation is available for AVIF decoding.');
}

function isAbort(error) {
  return error?.name === 'AbortError';
}

async function withTimeout(promise, signal, { holdWorkOnAbort = false } = {}) {
  throwIfAborted(signal);
  let timeoutId;
  let removeAbortListener = () => {};
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('AVIF decoding timed out after 60 seconds.')), DECODE_TIMEOUT_MS);
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

async function tryDecodePqFloat16(bytes, metadata, signal, maxBytes = 512 * 1024 * 1024, holdWorkOnAbort = false) {
  if (typeof ImageDecoder !== 'function' || metadata.transfer !== 16) return null;
  let decoder;
  let frame;
  try {
    if (typeof ImageDecoder.isTypeSupported === 'function' &&
        !await withTimeout(ImageDecoder.isTypeSupported('image/avif'), signal, { holdWorkOnAbort })) return null;
    decoder = new ImageDecoder({ data: bytes, type: 'image/avif', preferAnimation: false });
    await withTimeout(decoder.tracks.ready, signal, { holdWorkOnAbort });
    const result = await withTimeout(decoder.decode({ frameIndex: 0 }), signal, { holdWorkOnAbort });
    frame = result.image;
    if (!frame) throw new Error('AVIF decoder returned no image frame.');
    const colorSpace = frame.colorSpace;
    if (colorSpace?.transfer !== 'pq' || !colorSpace.primaries) return null;
    if (metadata.primaries === 9 && colorSpace.primaries !== 'bt2020') return null;
    if (metadata.primaries === 12 && !['smpte432', 'bt709', 'bt2020'].includes(colorSpace.primaries)) return null;

    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    const pixels = validateDimensions(width, height, maxBytes);
    throwIfAborted(signal);
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d', {
      colorSpace: 'srgb-linear',
      colorType: 'float16',
      willReadFrequently: true,
    });
    const attributes = context?.getContextAttributes?.();
    if (!context || attributes?.colorSpace !== 'srgb-linear' || attributes?.colorType !== 'float16') return null;

    context.drawImage(frame, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height, {
      colorSpace: 'srgb-linear',
      pixelFormat: 'rgba-float16',
    });
    if (imageData.pixelFormat !== 'rgba-float16' || imageData.colorSpace !== 'srgb-linear' || imageData.data.length !== pixels * 4) return null;

    const data = new Float32Array(pixels * 4);
    for (let i = 0; i < data.length; i += 4) {
      if ((i & 0x3ffff) === 0) throwIfAborted(signal);
      const r = imageData.data[i];
      const g = imageData.data[i + 1];
      const b = imageData.data[i + 2];
      const a = imageData.data[i + 3];
      if (![r, g, b, a].every(Number.isFinite)) throw new Error('AVIF linear Float16 readback contains a non-finite channel.');
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
    return {
      width,
      height,
      data,
      colorSpace: 'linear-rec709',
      sourceHDR: true,
      decodedHDR: true,
      isHDR: true,
      sourceHDRKnown: metadata.sourceHDRKnown,
      alpha: 'straight',
      luminanceUnit: 'scRGB-80-nit',
      warnings: [],
    };
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  } finally {
    frame?.close?.();
    decoder?.close?.();
  }
}

async function decodeWithBrowserCanvas(blob, signal, maxBytes, holdWorkOnAbort) {
  throwIfAborted(signal);
  if (typeof createImageBitmap === 'function') {
    const bitmap = await withResourceTimeout(createImageBitmap(blob), signal, (value) => value?.close?.(), { holdWorkOnAbort });
    try {
      const width = bitmap.width;
      const height = bitmap.height;
      const pixels = validateDimensions(width, height, maxBytes);
      throwIfAborted(signal);
      const canvas = makeCanvas(width, height);
      const context = canvas.getContext('2d', { colorSpace: 'srgb', colorType: 'unorm8', willReadFrequently: true });
      if (!context) throw new Error('Failed to create an sRGB canvas context for AVIF.');
      context.drawImage(bitmap, 0, 0);
      const imageData = context.getImageData(0, 0, width, height, { colorSpace: 'srgb', pixelFormat: 'rgba-unorm8' });
      if (imageData.data.length !== pixels * 4) throw new Error('AVIF canvas returned an inconsistent pixel buffer.');
      const data = new Float32Array(pixels * 4);
      for (let i = 0; i < data.length; i += 4) {
        if ((i & 0x3ffff) === 0) throwIfAborted(signal);
        data[i] = srgbToLinear(imageData.data[i]);
        data[i + 1] = srgbToLinear(imageData.data[i + 1]);
        data[i + 2] = srgbToLinear(imageData.data[i + 2]);
        data[i + 3] = imageData.data[i + 3] / 255;
      }
      return { width, height, data };
    } finally {
      bitmap.close?.();
    }
  }

  if (typeof Image !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('This browser has no supported AVIF image decoder.');
  }
  const url = URL.createObjectURL(blob);
  let image;
  try {
    image = await withTimeout(new Promise((resolve, reject) => {
      const img = new Image();
      image = img;
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode AVIF image.'));
      img.src = url;
    }), signal, { holdWorkOnAbort });
    throwIfAborted(signal);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const pixels = validateDimensions(width, height, maxBytes);
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb', colorType: 'unorm8', willReadFrequently: true });
    if (!context) throw new Error('Failed to create an sRGB canvas context for AVIF.');
    context.drawImage(image, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height, { colorSpace: 'srgb', pixelFormat: 'rgba-unorm8' });
    if (imageData.data.length !== pixels * 4) throw new Error('AVIF canvas returned an inconsistent pixel buffer.');
    const data = new Float32Array(pixels * 4);
    for (let i = 0; i < data.length; i += 4) {
      if ((i & 0x3ffff) === 0) throwIfAborted(signal);
      data[i] = srgbToLinear(imageData.data[i]);
      data[i + 1] = srgbToLinear(imageData.data[i + 1]);
      data[i + 2] = srgbToLinear(imageData.data[i + 2]);
      data[i + 3] = imageData.data[i + 3] / 255;
    }
    return { width, height, data };
  } finally {
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.src = '';
    }
    URL.revokeObjectURL(url);
  }
}

/**
 * Decode AVIF into linear-light Rec.709 RGBA. PQ/HLG high-bit samples are decoded
 * through a browser-verified WebCodecs path or libavif WASM; SDR fallback is explicit.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {Blob|File} [fileOrBlob]
 * @param {{signal?: AbortSignal}} [options]
 */
export async function decodeAVIF(buffer, fileOrBlob, { signal, maxBytes = 512 * 1024 * 1024, holdWorkOnAbort = false } = {}) {
  throwIfAborted(signal);
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const metadata = parseAvifColorInfo(bytes);
  if (!metadata.width || !metadata.height) throw new Error('AVIF primary item has no verifiable ispe dimensions; refusing an unbounded decode.');
  validateDimensions(metadata.width, metadata.height, maxBytes);
  const blob = fileOrBlob || new Blob([bytes], { type: 'image/avif' });

  if (metadata.transfer === 16 && metadata.sourceHDRKnown && await hasVerifiedPqScale(signal, holdWorkOnAbort)) {
    const hdr = await tryDecodePqFloat16(bytes, metadata, signal, maxBytes, holdWorkOnAbort);
    if (hdr) return { ...hdr, warnings: [...metadata.warnings] };
  }

  if (metadata.sourceHDRKnown && [16, 18].includes(metadata.transfer)) {
    try {
      const hdr = await decodeAVIFWithWasm(bytes, metadata, signal, maxBytes, holdWorkOnAbort);
      return { ...hdr, warnings: [...hdr.warnings] };
    } catch (error) {
      if (isAbort(error)) throw error;
      // Preserve the native browser fallback below, but report the loss clearly.
    }
  }

  const fallback = await decodeWithBrowserCanvas(blob, signal, maxBytes, holdWorkOnAbort);
  const warnings = [...metadata.warnings];
  let decodedHDR = false;
  if (metadata.sourceHDR) {
    const reason = metadata.transfer === 18
      ? 'The HLG AVIF could not be decoded through the supported high-bit path; it was decoded through the browser SDR path and HDR detail was lost.'
      : 'Neither a numerically verified native Float16 path nor the high-bit AVIF decoder was available; it was decoded as SDR and HDR detail was lost.';
    warnings.push(reason);
  } else if (!metadata.sourceHDRKnown && [16, 18].includes(metadata.transfer)) {
    warnings.push('AVIF HDR transfer metadata could not be associated with the primary item; HDR status is unknown and pixels were decoded through the SDR browser path.');
  } else if (metadata.transfer !== null && ![1, 8, 13].includes(metadata.transfer)) {
    warnings.push(`AVIF transfer ${metadata.transfer} is not supported by the linear SDR fallback.`);
  }

  return {
    ...fallback,
    colorSpace: 'linear-rec709',
    sourceHDR: metadata.sourceHDR,
    sourceHDRKnown: metadata.sourceHDRKnown,
    decodedHDR,
    isHDR: decodedHDR,
    alpha: 'straight',
    luminanceUnit: 'relative',
    warnings,
  };
}
