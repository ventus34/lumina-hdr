const MAX_PIXELS = 33_554_432;
const RADIANCE_DEFAULT_CHROMATICITIES = {
  redX: 0.640, redY: 0.330,
  greenX: 0.290, greenY: 0.600,
  blueX: 0.150, blueY: 0.060,
  whiteX: 1 / 3, whiteY: 1 / 3,
};

function assertDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid Radiance dimensions: ${width}×${height}`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS) {
    throw new Error(`Radiance image exceeds the ${MAX_PIXELS.toLocaleString()} pixel decode limit.`);
  }
  return pixels;
}

function multiply3(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  }
  return out;
}

function inverse3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const cofactors = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
  const determinant = a * cofactors[0] + b * cofactors[3] + c * cofactors[6];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('Radiance primary colors do not define a valid matrix.');
  return cofactors.map((value) => value / determinant);
}

function multiplyVector(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

function rgbToXyz(chroma) {
  if ([chroma.redY, chroma.greenY, chroma.blueY, chroma.whiteY].some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Radiance PRIMARIES contains invalid chromaticities.');
  }
  const p = [
    chroma.redX / chroma.redY, chroma.greenX / chroma.greenY, chroma.blueX / chroma.blueY,
    1, 1, 1,
    (1 - chroma.redX - chroma.redY) / chroma.redY,
    (1 - chroma.greenX - chroma.greenY) / chroma.greenY,
    (1 - chroma.blueX - chroma.blueY) / chroma.blueY,
  ];
  const white = [chroma.whiteX / chroma.whiteY, 1, (1 - chroma.whiteX - chroma.whiteY) / chroma.whiteY];
  const scale = multiplyVector(inverse3(p), white);
  return [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2], p[3] * scale[0], p[4] * scale[1], p[5] * scale[2], p[6] * scale[0], p[7] * scale[1], p[8] * scale[2]];
}

function colorMatrixToRec709(chroma) {
  const source = rgbToXyz(chroma);
  const sourceWhite = multiplyVector(source, [1, 1, 1]);
  const bradford = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  const sourceLms = multiplyVector(bradford, sourceWhite);
  const d65 = [0.9504559271, 1, 1.0890577508];
  const d65Lms = multiplyVector(bradford, d65);
  const scale = [d65Lms[0] / sourceLms[0], d65Lms[1] / sourceLms[1], d65Lms[2] / sourceLms[2]];
  const adaptation = multiply3(inverse3(bradford), multiply3([scale[0], 0, 0, 0, scale[1], 0, 0, 0, scale[2]], bradford));
  const rec709ToXyz = [0.4123907993, 0.3575843394, 0.1804807884, 0.2126390059, 0.7151686788, 0.0721923154, 0.0193308187, 0.1191947798, 0.9505321522];
  return multiply3(inverse3(rec709ToXyz), multiply3(adaptation, source));
}

function readLine(bytes, state, label) {
  const start = state.offset;
  while (state.offset < bytes.length && bytes[state.offset] !== 10) {
    if (state.offset - start >= 8192) throw new Error(`Radiance ${label} line is too long.`);
    state.offset++;
  }
  if (state.offset >= bytes.length) throw new Error(`Truncated Radiance ${label}.`);
  let end = state.offset++;
  if (end > start && bytes[end - 1] === 13) end--;
  return new TextDecoder('ascii').decode(bytes.subarray(start, end));
}

function readResolution(bytes, state) {
  const line = readLine(bytes, state, 'resolution');
  const match = /^\s*([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)\s*$/.exec(line);
  if (!match || match[2] === match[5]) throw new Error(`Invalid Radiance resolution line: "${line}"`);
  const first = { sign: match[1], axis: match[2], count: Number(match[3]) };
  const second = { sign: match[4], axis: match[5], count: Number(match[6]) };
  const width = first.axis === 'X' ? first.count : second.count;
  const height = first.axis === 'Y' ? first.count : second.count;
  assertDimensions(width, height);
  return { line, first, second, width, height };
}

function mapCoordinate(axis, sign, index, size) {
  if (axis === 'X') return sign === '+' ? index : size - 1 - index;
  return sign === '-' ? index : size - 1 - index;
}

function rgbeToRgb(r, g, b, e) {
  if (e === 0) return [0, 0, 0];
  const scale = 2 ** (e - 136);
  return [r * scale, g * scale, b * scale];
}

/**
 * Decode strict Radiance RGBE into linear Rec.709 Float32 RGBA.
 * XYZE is explicitly rejected because the channel transform is not implemented.
 */
export function decodeRGBE(buffer, { signal } = {}) {
  if (signal?.aborted) {
    if (signal.reason?.name === 'AbortError') throw signal.reason;
    const error = new Error('The decode was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const state = { offset: 0 };
  const magic = readLine(bytes, state, 'magic');
  if (magic !== '#?RADIANCE' && magic !== '#?RGBE') throw new Error('Invalid Radiance HDR magic header.');

  const headerValues = { exposure: 1, colorCorrection: [1, 1, 1], primaries: { ...RADIANCE_DEFAULT_CHROMATICITIES } };
  let format = null;
  while (true) {
    const line = readLine(bytes, state, 'header');
    if (!line.trim()) break;
    if (line.startsWith('FORMAT=')) format = line.slice(7).trim();
    else if (line.startsWith('EXPOSURE=')) {
      const value = Number(line.slice(9).trim());
      if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid Radiance EXPOSURE value.');
      headerValues.exposure *= value;
    } else if (line.startsWith('COLORCORR=')) {
      const values = line.slice(10).trim().split(/\s+/).map(Number);
      if (values.length !== 3 || !values.every((value) => Number.isFinite(value) && value >= 0)) throw new Error('Invalid Radiance COLORCORR value.');
      headerValues.colorCorrection = headerValues.colorCorrection.map((value, index) => value * values[index]);
    } else if (line.startsWith('PRIMARIES=')) {
      const values = line.slice(10).trim().split(/\s+/).map(Number);
      if (values.length !== 8 || !values.every(Number.isFinite)) throw new Error('Invalid Radiance PRIMARIES value.');
      headerValues.primaries = {
        redX: values[0], redY: values[1], greenX: values[2], greenY: values[3],
        blueX: values[4], blueY: values[5], whiteX: values[6], whiteY: values[7],
      };
    }
  }
  if (format !== '32-bit_rle_rgbe') {
    if (format === '32-bit_rle_xyze') throw new Error('Radiance XYZE files are not supported; their channels cannot be interpreted as RGB.');
    throw new Error(`Unsupported or missing Radiance FORMAT (${format || 'none'}).`);
  }

  const resolution = readResolution(bytes, state);
  const { width, height, first, second } = resolution;
  const pixels = assertDimensions(width, height);
  const output = new Float32Array(pixels * 4);
  const scanline = new Uint8Array(second.count * 4);
  const maxScanline = second.count;
  const hasModernRle = maxScanline >= 8 && maxScanline <= 32767 && bytes.length - state.offset >= 4 &&
    bytes[state.offset] === 2 && bytes[state.offset + 1] === 2 && (bytes[state.offset + 2] & 0x80) === 0;
  let cursor = state.offset;

  const sourceToRec709 = colorMatrixToRec709(headerValues.primaries);
  const writePixel = (outer, inner, rByte, gByte, bByte, exponent) => {
    const rgb = rgbeToRgb(rByte, gByte, bByte, exponent).map((value, channel) => value * headerValues.exposure * headerValues.colorCorrection[channel]);
    const converted = multiplyVector(sourceToRec709, rgb);
    if (!converted.every(Number.isFinite)) throw new Error('Radiance pixel produced a non-finite color value.');
    const majorValue = mapCoordinate(first.axis, first.sign, outer, first.count);
    const minorValue = mapCoordinate(second.axis, second.sign, inner, second.count);
    const x = first.axis === 'X' ? majorValue : minorValue;
    const y = first.axis === 'Y' ? majorValue : minorValue;
    const target = (y * width + x) * 4;
    output[target] = converted[0];
    output[target + 1] = converted[1];
    output[target + 2] = converted[2];
    output[target + 3] = 1;
  };

  if (hasModernRle) {
    const channel = new Uint8Array(maxScanline);
    for (let outer = 0; outer < first.count; outer++) {
      if (signal?.aborted) {
        if (signal.reason?.name === 'AbortError') throw signal.reason;
        const error = new Error('The decode was aborted.');
        error.name = 'AbortError';
        throw error;
      }
      if (cursor + 4 > bytes.length) throw new Error(`Truncated Radiance scanline ${outer} header.`);
      if (bytes[cursor++] !== 2 || bytes[cursor++] !== 2) throw new Error(`Invalid Radiance RLE scanline marker at line ${outer}.`);
      const encodedWidth = (bytes[cursor++] << 8) | bytes[cursor++];
      if (encodedWidth !== maxScanline) throw new Error(`Radiance RLE scanline length ${encodedWidth} does not match ${maxScanline}.`);

      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < maxScanline) {
          if (cursor >= bytes.length) throw new Error(`Truncated Radiance RLE data at line ${outer}, channel ${c}.`);
          const code = bytes[cursor++];
          if (code === 0) throw new Error(`Zero-length Radiance RLE packet at line ${outer}, channel ${c}.`);
          if (code > 128) {
            const count = code - 128;
            if (x + count > maxScanline) throw new Error(`Radiance RLE run exceeds scanline ${outer}.`);
            if (cursor >= bytes.length) throw new Error(`Truncated Radiance RLE run value at line ${outer}, channel ${c}.`);
            channel.fill(bytes[cursor++], x, x + count);
            x += count;
          } else {
            const count = code;
            if (x + count > maxScanline) throw new Error(`Radiance RLE literal exceeds scanline ${outer}.`);
            if (cursor + count > bytes.length) throw new Error(`Truncated Radiance RLE literal at line ${outer}, channel ${c}.`);
            channel.set(bytes.subarray(cursor, cursor + count), x);
            cursor += count;
            x += count;
          }
        }
        for (let x = 0; x < maxScanline; x++) scanline[x * 4 + c] = channel[x];
      }
      for (let inner = 0; inner < maxScanline; inner++) {
        const source = inner * 4;
        writePixel(outer, inner, scanline[source], scanline[source + 1], scanline[source + 2], scanline[source + 3]);
      }
    }
  } else {
    let pixel = 0;
    let shift = 0;
    let previous = null;
    while (pixel < pixels) {
      if (cursor + 4 > bytes.length) throw new Error(`Truncated Radiance pixel data at pixel ${pixel}.`);
      const r = bytes[cursor++];
      const g = bytes[cursor++];
      const b = bytes[cursor++];
      const e = bytes[cursor++];
      if (r === 1 && g === 1 && b === 1) {
        if (!previous) throw new Error('Radiance old-style RLE run appears before any pixel.');
        if (e === 0) {
          shift += 8;
          if (shift > 24) throw new Error('Radiance old-style RLE run length overflows.');
          continue;
        }
        const count = e * (2 ** shift);
        if (!Number.isSafeInteger(count) || count <= 0 || pixel + count > pixels) throw new Error('Radiance old-style RLE run exceeds the image.');
        for (let j = 0; j < count; j++, pixel++) {
          const outer = Math.floor(pixel / maxScanline);
          const inner = pixel % maxScanline;
          writePixel(outer, inner, previous[0], previous[1], previous[2], previous[3]);
        }
        shift = 0;
      } else {
        previous = [r, g, b, e];
        const outer = Math.floor(pixel / maxScanline);
        const inner = pixel % maxScanline;
        writePixel(outer, inner, r, g, b, e);
        pixel++;
        shift = 0;
      }
    }
  }

  return {
    width,
    height,
    data: output,
    colorSpace: 'linear-rec709',
    sourceHDR: true,
    decodedHDR: true,
    isHDR: true,
    alpha: 'opaque',
    luminanceUnit: 'relative',
    warnings: [],
  };
}

function floatToRgbe(r, g, b) {
  const maxVal = Math.max(r, g, b);
  if (maxVal < 1e-32) return [0, 0, 0, 0];
  let exp = Math.ceil(Math.log2(maxVal));
  let scale = Math.pow(2.0, exp - 8);
  let re = Math.round(r / scale);
  let ge = Math.round(g / scale);
  let be = Math.round(b / scale);
  if (re > 255 || ge > 255 || be > 255) {
    exp++;
    scale = Math.pow(2.0, exp - 8);
    re = Math.round(r / scale);
    ge = Math.round(g / scale);
    be = Math.round(b / scale);
  }
  return [
    Math.min(255, Math.max(0, re)),
    Math.min(255, Math.max(0, ge)),
    Math.min(255, Math.max(0, be)),
    exp + 128,
  ];
}

/** Encode float RGBA as uncompressed Radiance RGBE. */
export function encodeRGBE(width, height, rgbaData) {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nPRIMARIES=0.64 0.33 0.30 0.60 0.15 0.06 0.3127 0.329\n\n-Y ${height} +X ${width}\n`;
  const headerBytes = new TextEncoder().encode(header);
  const pixelBytes = new Uint8Array(width * height * 4);
  let offset = 0;
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, exponent] = floatToRgbe(rgbaData[i * 4], rgbaData[i * 4 + 1], rgbaData[i * 4 + 2]);
    pixelBytes[offset++] = r;
    pixelBytes[offset++] = g;
    pixelBytes[offset++] = b;
    pixelBytes[offset++] = exponent;
  }
  const result = new Uint8Array(headerBytes.length + pixelBytes.length);
  result.set(headerBytes, 0);
  result.set(pixelBytes, headerBytes.length);
  return result;
}
