import parseExr from 'parse-exr';

const MAX_PIXELS = 33_554_432;
const EXR_MAGIC = 0x01312f76;

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The decode was aborted.', 'AbortError');
  const error = new Error('The decode was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason?.name === 'AbortError' ? signal.reason : abortError();
}

function assertDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid EXR data-window dimensions: ${width}×${height}`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS) {
    throw new Error(`EXR exceeds the ${MAX_PIXELS.toLocaleString()} pixel decode limit.`);
  }
  return pixels;
}

function readCString(bytes, offset, end, label) {
  const start = offset;
  while (offset < end && bytes[offset] !== 0) offset++;
  if (offset >= end) throw new Error(`Truncated EXR ${label}.`);
  return { value: new TextDecoder().decode(bytes.subarray(start, offset)), next: offset + 1 };
}

function parseChannels(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = [];
  let offset = start;
  let terminated = false;
  while (offset < end) {
    if (bytes[offset] === 0) {
      offset++;
      terminated = true;
      break;
    }
    const name = readCString(bytes, offset, end, 'channel name');
    offset = name.next;
    if (offset + 16 > end) throw new Error('Truncated EXR channel list entry.');
    const pixelType = view.getInt32(offset, true);
    const xSampling = view.getInt32(offset + 8, true);
    const ySampling = view.getInt32(offset + 12, true);
    if (![0, 1, 2].includes(pixelType)) throw new Error(`Unsupported EXR pixel type ${pixelType} for channel ${name.value}.`);
    if (xSampling !== 1 || ySampling !== 1) throw new Error(`Subsampled EXR channel ${name.value} is not supported.`);
    channels.push({ name: name.value, pixelType });
    offset += 16;
  }
  if (!terminated || offset !== end) throw new Error('Invalid EXR channel list terminator.');
  const names = new Set();
  for (const channel of channels) {
    if (names.has(channel.name)) throw new Error(`Duplicate EXR channel ${channel.name}.`);
    names.add(channel.name);
  }
  return channels;
}

function preflightExr(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 16) throw new Error('EXR file is too short.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== EXR_MAGIC) throw new Error('Invalid OpenEXR magic number.');

  const header = {};
  const attributes = new Set();
  let offset = 8;
  while (offset < bytes.length) {
    if (bytes[offset] === 0) {
      offset++;
      break;
    }
    const name = readCString(bytes, offset, bytes.length, 'attribute name');
    offset = name.next;
    const type = readCString(bytes, offset, bytes.length, 'attribute type');
    offset = type.next;
    if (offset + 4 > bytes.length) throw new Error('Truncated EXR attribute size.');
    const size = view.getUint32(offset, true);
    offset += 4;
    if (offset + size > bytes.length) throw new Error(`EXR attribute ${name.value} exceeds the file length.`);
    if (attributes.has(name.value)) throw new Error(`Duplicate EXR attribute ${name.value}.`);
    attributes.add(name.value);

    if (name.value === 'dataWindow') {
      if (type.value !== 'box2i' || size !== 16) throw new Error('EXR dataWindow must be a 16-byte box2i.');
      header.dataWindow = {
        xMin: view.getInt32(offset, true),
        yMin: view.getInt32(offset + 4, true),
        xMax: view.getInt32(offset + 8, true),
        yMax: view.getInt32(offset + 12, true),
      };
    } else if (name.value === 'channels') {
      if (type.value !== 'chlist') throw new Error('EXR channels attribute must use chlist type.');
      header.channels = parseChannels(bytes, offset, offset + size);
    } else if (name.value === 'chromaticities') {
      if (type.value !== 'chromaticities' || size !== 32) throw new Error('EXR chromaticities attribute must contain eight floats.');
      header.chromaticities = {
        redX: view.getFloat32(offset, true), redY: view.getFloat32(offset + 4, true),
        greenX: view.getFloat32(offset + 8, true), greenY: view.getFloat32(offset + 12, true),
        blueX: view.getFloat32(offset + 16, true), blueY: view.getFloat32(offset + 20, true),
        whiteX: view.getFloat32(offset + 24, true), whiteY: view.getFloat32(offset + 28, true),
      };
    }
    offset += size;
  }
  if (offset > bytes.length || offset === bytes.length) throw new Error('EXR header has no image data.');
  if (!header.dataWindow) throw new Error('EXR header is missing dataWindow.');
  if (!header.channels?.length) throw new Error('EXR header is missing channels.');

  const width = header.dataWindow.xMax - header.dataWindow.xMin + 1;
  const height = header.dataWindow.yMax - header.dataWindow.yMin + 1;
  const pixels = assertDimensions(width, height);
  const names = new Set(header.channels.map((channel) => channel.name));
  const hasRgb = ['R', 'G', 'B'].every((name) => names.has(name));
  const hasGray = names.has('Y');
  if (hasRgb === hasGray) throw new Error('EXR must contain either R/G/B channels or a single Y channel.');
  if (hasGray && names.has('A')) throw new Error('Grayscale EXR with alpha is not supported by the installed decoder.');
  const primaryChannels = hasRgb ? ['R', 'G', 'B', ...(names.has('A') ? ['A'] : [])] : ['Y'];
  const types = new Set(header.channels.filter((channel) => primaryChannels.includes(channel.name)).map((channel) => channel.pixelType));
  if (types.size !== 1 || [...types][0] === 0) throw new Error('EXR color channels must use a consistent half or full float representation.');
  return { bytes, width, height, pixels, header, hasRgb, hasAlpha: hasRgb && names.has('A') };
}

function multiply3(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
    }
  }
  return out;
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const determinant = a * A + b * D + c * G;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('EXR chromaticities do not define a usable color space.');
  const inv = 1 / determinant;
  return [A * inv, B * inv, C * inv, D * inv, E * inv, F * inv, G * inv, H * inv, I * inv];
}

function rgbToXyz(chroma) {
  const xy = [chroma.redX, chroma.redY, chroma.greenX, chroma.greenY, chroma.blueX, chroma.blueY, chroma.whiteX, chroma.whiteY];
  if (!xy.every(Number.isFinite)) throw new Error('EXR chromaticities contain non-finite values.');
  for (let i = 0; i < xy.length; i += 2) {
    if (xy[i] < 0 || xy[i + 1] <= 0 || xy[i] > 1 || xy[i + 1] > 1 || xy[i] + xy[i + 1] > 1.0001) {
      throw new Error('EXR chromaticities contain a coordinate outside the visible chromaticity diagram.');
    }
  }
  const p = [
    chroma.redX / chroma.redY, chroma.greenX / chroma.greenY, chroma.blueX / chroma.blueY,
    1, 1, 1,
    (1 - chroma.redX - chroma.redY) / chroma.redY,
    (1 - chroma.greenX - chroma.greenY) / chroma.greenY,
    (1 - chroma.blueX - chroma.blueY) / chroma.blueY,
  ];
  if ([chroma.redY, chroma.greenY, chroma.blueY, chroma.whiteY].some((v) => v <= 0)) throw new Error('EXR chromaticities contain an invalid y coordinate.');
  const white = [chroma.whiteX / chroma.whiteY, 1, (1 - chroma.whiteX - chroma.whiteY) / chroma.whiteY];
  const scale = multiplyVector(invert3(p), white);
  const m = [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2], p[3] * scale[0], p[4] * scale[1], p[5] * scale[2], p[6] * scale[0], p[7] * scale[1], p[8] * scale[2]];
  if (!m.every(Number.isFinite)) throw new Error('EXR chromaticities produce an invalid color matrix.');
  return m;
}

function multiplyVector(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

function makeRec709Matrix(chroma) {
  const source = rgbToXyz(chroma);
  const d65Source = multiplyVector(source, [1, 1, 1]);
  // Bradford chromatic adaptation from the file white to D65.
  const bradford = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  const invBradford = invert3(bradford);
  const sourceLms = multiplyVector(bradford, d65Source);
  const d65 = [0.9504559271, 1, 1.0890577508];
  const d65Lms = multiplyVector(bradford, d65);
  const adapt = multiply3(invBradford, multiply3([
    d65Lms[0] / sourceLms[0], 0, 0,
    0, d65Lms[1] / sourceLms[1], 0,
    0, 0, d65Lms[2] / sourceLms[2],
  ], bradford));
  const rec709ToXyz = [0.4123907993, 0.3575843394, 0.1804807884, 0.2126390059, 0.7151686788, 0.0721923154, 0.0193308187, 0.1191947798, 0.9505321522];
  return multiply3(invert3(rec709ToXyz), multiply3(adapt, source));
}

const REC709_CHROMATICITIES = {
  redX: 0.64, redY: 0.33,
  greenX: 0.30, greenY: 0.60,
  blueX: 0.15, blueY: 0.06,
  whiteX: 0.3127, whiteY: 0.329,
};

function hasStandardRec709Chromaticities(chroma) {
  if (!chroma) return true;
  return Object.keys(REC709_CHROMATICITIES).every((key) => Math.abs(chroma[key] - REC709_CHROMATICITIES[key]) < 0.0001);
}

/** Decode OpenEXR into linear Rec.709 Float32 RGBA. */
export function decodeEXR(buffer, { signal } = {}) {
  throwIfAborted(signal);
  const preflight = preflightExr(buffer);
  let parsed;
  try {
    parsed = parseExr(preflight.bytes.buffer.slice(preflight.bytes.byteOffset, preflight.bytes.byteOffset + preflight.bytes.byteLength), 1015);
  } catch (error) {
    throw new Error(`OpenEXR decode failed: ${error?.message || error}`, { cause: error });
  }
  throwIfAborted(signal);
  if (parsed.width !== preflight.width || parsed.height !== preflight.height) throw new Error('EXR parser dimensions do not match dataWindow.');

  if (preflight.hasRgb) {
    if (parsed.format !== 1023 || !(parsed.data instanceof Float32Array) || parsed.data.length !== preflight.pixels * 4) {
      throw new Error('EXR decoder returned an inconsistent RGBA channel buffer.');
    }
    const chroma = preflight.header.chromaticities;
    const matrix = chroma && !hasStandardRec709Chromaticities(chroma) ? makeRec709Matrix(chroma) : null;
    const rgba = parsed.data;
    for (let i = 0; i < preflight.pixels; i++) {
      if ((i & 0x3ffff) === 0) throwIfAborted(signal);
      const src = i * 4;
      const r = parsed.data[src];
      const g = parsed.data[src + 1];
      const b = parsed.data[src + 2];
      const alpha = preflight.hasAlpha ? parsed.data[src + 3] : 1;
      if (![r, g, b, alpha].every(Number.isFinite)) throw new Error(`EXR pixel ${i} contains NaN or Infinity.`);
      if (alpha < 0 || alpha > 1) throw new Error(`EXR pixel ${i} has alpha outside [0, 1].`);
      if (matrix) {
        const converted = multiplyVector(matrix, [r, g, b]);
        if (!converted.every((channel) => Number.isFinite(channel) && Math.abs(channel) <= 3.402823466e38)) {
          throw new Error(`EXR pixel ${i} overflows Float32 during color conversion.`);
        }
        rgba[src] = converted[0];
        rgba[src + 1] = converted[1];
        rgba[src + 2] = converted[2];
      } else {
        rgba[src] = r;
        rgba[src + 1] = g;
        rgba[src + 2] = b;
      }
      if (!preflight.hasAlpha) rgba[src + 3] = 1;
    }
    return {
      width: preflight.width,
      height: preflight.height,
      data: rgba,
      colorSpace: 'linear-rec709',
      sourceHDR: true,
      decodedHDR: true,
      isHDR: true,
      alpha: preflight.hasAlpha ? 'straight' : 'opaque',
      luminanceUnit: 'relative',
      warnings: !chroma
        ? ['EXR has no chromaticities attribute; assuming linear Rec.709 primaries.']
        : matrix ? ['EXR chromaticities were converted to linear Rec.709.'] : [],
    };
  }

  if (parsed.format !== 1028 || !(parsed.data instanceof Float32Array) || parsed.data.length !== preflight.pixels) {
    throw new Error('EXR decoder did not return the expected grayscale channel buffer.');
  }
  const rgba = new Float32Array(preflight.pixels * 4);
  for (let i = 0; i < preflight.pixels; i++) {
    if ((i & 0x3ffff) === 0) throwIfAborted(signal);
    const value = parsed.data[i];
    if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) throw new Error(`EXR pixel ${i} contains NaN or Infinity or a value outside Float32.`);
    const offset = i * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 1;
  }
  return {
    width: preflight.width,
    height: preflight.height,
    data: rgba,
    colorSpace: 'linear-rec709',
    sourceHDR: true,
    decodedHDR: true,
    isHDR: true,
    alpha: 'opaque',
    luminanceUnit: 'relative',
    warnings: !preflight.header.chromaticities ? ['EXR has no chromaticities attribute; assuming linear Rec.709 primaries.'] : [],
  };
}
