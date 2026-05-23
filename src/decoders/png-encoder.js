/**
 * Pure JavaScript 16-bit PNG Encoder with sBIT (Significant Bits) support.
 * Designed for 10-bit, 12-bit, and 16-bit HDR/SDR exports.
 * Uses browser-native CompressionStream('deflate') for robust Zlib compression.
 */

// Initialize CRC-32 table for PNG chunk checksums
const crcTable = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c;
}

// Compute CRC-32 checksum
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Compress raw data using browser-native CompressionStream (Zlib deflate format)
// Returns a Uint8Array containing the complete Zlib stream (header + compressed data + checksum)
async function compressDeflate(rawData) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // Write data and close in one go
  writer.write(rawData);
  writer.close();

  // Read all compressed chunks
  const reader = cs.readable.getReader();
  const chunks = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalSize += value.length;
  }

  // Concatenate into a single Uint8Array
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// Write a PNG chunk: [Length (4B)][Type (4B)][Data (NB)][CRC (4B)]
function writeChunk(typeStr, dataBytes) {
  const typeBytes = new TextEncoder().encode(typeStr);
  const dataLen = dataBytes ? dataBytes.length : 0;
  const chunkBytes = new Uint8Array(4 + 4 + dataLen + 4);
  const view = new DataView(chunkBytes.buffer);

  // Write Length (big-endian)
  view.setUint32(0, dataLen, false);

  // Write Type
  chunkBytes.set(typeBytes, 4);

  // Write Data
  if (dataBytes) {
    chunkBytes.set(dataBytes, 8);
  }

  // Write CRC (computed over Type + Data)
  const crcTarget = new Uint8Array(4 + dataLen);
  crcTarget.set(typeBytes, 0);
  if (dataBytes) {
    crcTarget.set(dataBytes, 4);
  }
  const crcVal = crc32(crcTarget);
  view.setUint32(8 + dataLen, crcVal, false);

  return chunkBytes;
}

// PQ Constants (SMPTE ST 2084)
const m1 = 0.1593017578125;
const m2 = 78.84375;
const c1 = 0.8359375;
const c2 = 18.8515625;
const c3 = 18.6875;

// PQ transfer function (Inverse EOTF: nits -> [0, 1] PQ)
function linearToPQ(val) {
  if (val <= 0.0) return 0.0;
  const l_n = val / 10000.0;
  const cp = Math.pow(l_n, m1);
  return Math.pow((c1 + c2 * cp) / (1.0 + c3 * cp), m2);
}

// HLG transfer function (OETF)
function linearToHLG(val) {
  if (val <= 0.0) return 0.0;
  if (val <= 1.0 / 12.0) {
    return Math.sqrt(3.0 * val);
  } else {
    return 0.17883277 * Math.log(12.0 * val - 0.28466892) + 0.55991073;
  }
}

// Helper to apply upmixing, exposure correction, color grading, and contrast on CPU
function preprocessPixel(r, g, b, options) {
  const smartUpmix = options.smartUpmix || false;
  const sdrBoost = options.sdrBoost !== undefined ? options.sdrBoost : 1.0;
  const exposure = options.exposure !== undefined ? options.exposure : 0.0;
  const temp = options.temp !== undefined ? options.temp : 0.0;
  const tint = options.tint !== undefined ? options.tint : 0.0;
  const shadows = options.shadows !== undefined ? options.shadows : 0.0;
  const highlights = options.highlights !== undefined ? options.highlights : 0.0;
  const saturation = options.saturation !== undefined ? options.saturation : 1.0;
  const contrast = options.contrast !== undefined ? options.contrast : 1.0;

  // 1. Smart upmix or linear boost
  if (smartUpmix) {
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (L > 0.0) {
      const th = 0.75;
      let L_new = L;
      if (L > th) {
        const t = (L - th) / (1.0 - th);
        L_new = th + (L - th) * (1.0 + (sdrBoost - 1.0) * t);
      }
      const scale = L_new / L;
      r *= scale;
      g *= scale;
      b *= scale;
    }
  } else if (sdrBoost !== 1.0) {
    r *= sdrBoost;
    g *= sdrBoost;
    b *= sdrBoost;
  }

  // 2. Exposure Offset (stops)
  if (exposure !== 0.0) {
    const expFactor = Math.pow(2.0, exposure);
    r *= expFactor;
    g *= expFactor;
    b *= expFactor;
  }

  // 3. Color Grading (Temp, Tint, Shadows, Highlights, Saturation)
  if (temp !== 0.0 || tint !== 0.0) {
    r += temp * 0.12 - tint * 0.06;
    g += tint * 0.12;
    b += -temp * 0.12 - tint * 0.06;
    r = Math.max(r, 0.0);
    g = Math.max(g, 0.0);
    b = Math.max(b, 0.0);
  }

  if (shadows !== 0.0 || highlights !== 0.0) {
    const L_grad = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const shadowMask = Math.pow(1.0 - Math.min(1.0, Math.max(0.0, L_grad)), 2.0);
    const highlightMask = Math.pow(Math.min(1.0, Math.max(0.0, L_grad)), 2.0);
    r += r * shadows * shadowMask;
    g += g * shadows * shadowMask;
    b += b * shadows * shadowMask;
    r += r * highlights * highlightMask;
    g += g * highlights * highlightMask;
    b += b * highlights * highlightMask;
    r = Math.max(r, 0.0);
    g = Math.max(g, 0.0);
    b = Math.max(b, 0.0);
  }

  if (saturation !== 1.0) {
    const L_sat = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = L_sat + (r - L_sat) * saturation;
    g = L_sat + (g - L_sat) * saturation;
    b = L_sat + (b - L_sat) * saturation;
    r = Math.max(r, 0.0);
    g = Math.max(g, 0.0);
    b = Math.max(b, 0.0);
  }

  // 4. Contrast
  if (contrast !== 1.0) {
    r = Math.pow(Math.max(0.0, r), contrast);
    g = Math.pow(Math.max(0.0, g), contrast);
    b = Math.pow(Math.max(0.0, b), contrast);
  }

  return [r, g, b];
}

// Build raw scanlines with PNG filter method 0 (None)
// Applies transformations, quantization to bit depth, and left-shifts values to align to 16 bits
function buildPngRawData(width, height, floatData, bitDepth, options) {
  const bytesPerPixel = 8; // 4 channels * 2 bytes = 8 bytes for 16-bit RGBA
  const rowSize = 1 + width * bytesPerPixel;
  const rawData = new Uint8Array(height * rowSize);

  let rawIdx = 0;
  const maxVal = (1 << bitDepth) - 1;
  const shift = 16 - bitDepth;

  const type = options.type || 'hdr';
  const transfer = options.transfer || 'linear';
  const toneMapperFunc = options.toneMapperFunc;

  // Extract parameters
  const sdrWhite = options.sdrWhite !== undefined ? options.sdrWhite : 200.0;
  const maxLuminance = options.maxLuminance || 1.0;

  // Calculate linear scale factors
  const safeMaxLuminance = maxLuminance > 0 ? maxLuminance : 1.0;
  const linearScaleFactor = maxVal / safeMaxLuminance;

  // If HLG, scan first to find peak component value
  let hlgNorm = 12.0;
  if (type === 'hdr' && transfer === 'hlg') {
    let maxComponent = 1.0;
    const numPixels = width * height;
    for (let i = 0; i < numPixels; i++) {
      const idx = i * 4;
      const [rp, gp, bp] = preprocessPixel(
        floatData[idx],
        floatData[idx + 1],
        floatData[idx + 2],
        options
      );
      const r_2020 = 0.6274040 * rp + 0.3292820 * gp + 0.0433136 * bp;
      const g_2020 = 0.0690970 * rp + 0.9195400 * gp + 0.0113612 * bp;
      const b_2020 = 0.0163916 * rp + 0.0880132 * gp + 0.8955950 * bp;
      if (r_2020 > maxComponent) maxComponent = r_2020;
      if (g_2020 > maxComponent) maxComponent = g_2020;
      if (b_2020 > maxComponent) maxComponent = b_2020;
    }
    hlgNorm = Math.max(12.0, maxComponent);
  }

  for (let y = 0; y < height; y++) {
    rawData[rawIdx++] = 0; // Filter Type = 0 (None)

    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;

      let r = floatData[srcIdx];
      let g = floatData[srcIdx + 1];
      let b = floatData[srcIdx + 2];
      let a = floatData[srcIdx + 3];

      // Guard against NaN / undefined / missing alpha
      if (isNaN(a) || a === undefined) a = 1.0;

      let ri, gi, bi, ai;

      if (type === 'sdr') {
        // SDR: apply tone mapper function to clamp output to 0.0-1.0
        if (toneMapperFunc) {
          const mapped = toneMapperFunc(r, g, b);
          r = mapped[0];
          g = mapped[1];
          b = mapped[2];
        } else {
          r = Math.min(1.0, Math.max(0.0, r));
          g = Math.min(1.0, Math.max(0.0, g));
          b = Math.min(1.0, Math.max(0.0, b));
        }
        a = Math.min(1.0, Math.max(0.0, a));

        ri = Math.min(maxVal, Math.max(0, Math.round(r * maxVal)));
        gi = Math.min(maxVal, Math.max(0, Math.round(g * maxVal)));
        bi = Math.min(maxVal, Math.max(0, Math.round(b * maxVal)));
        ai = Math.min(maxVal, Math.max(0, Math.round(a * maxVal)));
      } else {
        // HDR
        if (transfer === 'pq') {
          const [rp, gp, bp] = preprocessPixel(r, g, b, options);
          const r_nit = rp * sdrWhite;
          const g_nit = gp * sdrWhite;
          const b_nit = bp * sdrWhite;
          // Rec.2020 Primaries
          const r_2020 = 0.6274040 * r_nit + 0.3292820 * g_nit + 0.0433136 * b_nit;
          const g_2020 = 0.0690970 * r_nit + 0.9195400 * g_nit + 0.0113612 * b_nit;
          const b_2020 = 0.0163916 * r_nit + 0.0880132 * g_nit + 0.8955950 * b_nit;
          // PQ transfer function
          const r_pq = linearToPQ(r_2020);
          const g_pq = linearToPQ(g_2020);
          const b_pq = linearToPQ(b_2020);
          // Quantize
          ri = Math.min(maxVal, Math.max(0, Math.round(r_pq * maxVal)));
          gi = Math.min(maxVal, Math.max(0, Math.round(g_pq * maxVal)));
          bi = Math.min(maxVal, Math.max(0, Math.round(b_pq * maxVal)));
        } else if (transfer === 'hlg') {
          const [rp, gp, bp] = preprocessPixel(r, g, b, options);
          // Rec.2020 Primaries
          const r_2020 = 0.6274040 * rp + 0.3292820 * gp + 0.0433136 * bp;
          const g_2020 = 0.0690970 * rp + 0.9195400 * gp + 0.0113612 * bp;
          const b_2020 = 0.0163916 * rp + 0.0880132 * gp + 0.8955950 * bp;
          // Normalize to HLG signal range
          const r_norm = r_2020 / hlgNorm;
          const g_norm = g_2020 / hlgNorm;
          const b_norm = b_2020 / hlgNorm;
          // HLG OETF
          const r_hlg = linearToHLG(r_norm);
          const g_hlg = linearToHLG(g_norm);
          const b_hlg = linearToHLG(b_norm);
          // Quantize
          ri = Math.min(maxVal, Math.max(0, Math.round(r_hlg * maxVal)));
          gi = Math.min(maxVal, Math.max(0, Math.round(g_hlg * maxVal)));
          bi = Math.min(maxVal, Math.max(0, Math.round(b_hlg * maxVal)));
        } else {
          // Linear Rec.709
          const [rp, gp, bp] = preprocessPixel(r, g, b, options);
          ri = Math.min(maxVal, Math.max(0, Math.round(rp * linearScaleFactor)));
          gi = Math.min(maxVal, Math.max(0, Math.round(gp * linearScaleFactor)));
          bi = Math.min(maxVal, Math.max(0, Math.round(bp * linearScaleFactor)));
        }
        a = Math.min(1.0, Math.max(0.0, a));
        ai = Math.min(maxVal, Math.max(0, Math.round(a * maxVal)));
      }

      // Scale quantized value to the full 16-bit container range [0, 65535]
      const r16 = Math.round(ri * 65535 / maxVal);
      const g16 = Math.round(gi * 65535 / maxVal);
      const b16 = Math.round(bi * 65535 / maxVal);
      const a16 = Math.round(ai * 65535 / maxVal);

      // Write big-endian bytes (MSB first)
      rawData[rawIdx++] = (r16 >> 8) & 0xFF;
      rawData[rawIdx++] = r16 & 0xFF;
      rawData[rawIdx++] = (g16 >> 8) & 0xFF;
      rawData[rawIdx++] = g16 & 0xFF;
      rawData[rawIdx++] = (b16 >> 8) & 0xFF;
      rawData[rawIdx++] = b16 & 0xFF;
      rawData[rawIdx++] = (a16 >> 8) & 0xFF;
      rawData[rawIdx++] = a16 & 0xFF;
    }
  }

  return rawData;
}

/**
 * Encodes Float32 RGBA data into a 16-bit container PNG file buffer.
 * Supports writing a custom cICP chunk for Rec.2100 PQ/HLG and Rec.709 Linear color metadata.
 * Uses browser-native CompressionStream for proper Zlib DEFLATE compression.
 * @param {number} width 
 * @param {number} height 
 * @param {Float32Array} floatData 
 * @param {{
 *   bitDepth: 10|12|16,
 *   type: 'sdr'|'hdr',
 *   transfer: 'linear'|'pq'|'hlg',
 *   exposure?: number,
 *   contrast?: number,
 *   sdrBoost?: number,
 *   sdrWhite?: number,
 *   maxLuminance: number,
 *   toneMapperFunc?: (val: number) => number
 * }} options 
 * @returns {Promise<Uint8Array>}
 */
export async function encodePNG(width, height, floatData, options) {
  const bitDepth = options.bitDepth || 16;
  const type = options.type || 'hdr';
  const transfer = options.transfer || 'linear';

  // 1. Build uncompressed scanline data
  const rawData = buildPngRawData(width, height, floatData, bitDepth, options);

  // 2. Compress scanline data using browser-native DEFLATE (Zlib format)
  const idatPayload = await compressDeflate(rawData);

  // 3. Assemble IHDR chunk
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);  // Width
  ihdrView.setUint32(4, height, false); // Height
  ihdrData[8] = 16; // Physical depth is always 16 bits per sample in the container
  ihdrData[9] = 6;  // Color type = 6 (RGBA)
  ihdrData[10] = 0; // Compression method = 0
  ihdrData[11] = 0; // Filter method = 0
  ihdrData[12] = 0; // Interlace method = 0
  const ihdrChunk = writeChunk('IHDR', ihdrData);

  // 4. Assemble cICP chunk if HDR
  let cicpChunk = null;
  if (type === 'hdr') {
    let cicpData;
    if (transfer === 'pq') {
      // Primaries = 9 (BT.2020), Transfer = 16 (PQ), Matrix = 0 (RGB), Range = 1 (Full)
      cicpData = new Uint8Array([9, 16, 0, 1]);
    } else if (transfer === 'hlg') {
      // Primaries = 9 (BT.2020), Transfer = 18 (HLG), Matrix = 0 (RGB), Range = 1 (Full)
      cicpData = new Uint8Array([9, 18, 0, 1]);
    } else {
      // Primaries = 1 (BT.709), Transfer = 8 (Linear), Matrix = 0 (RGB), Range = 1 (Full)
      cicpData = new Uint8Array([1, 8, 0, 1]);
    }
    cicpChunk = writeChunk('cICP', cicpData);
  }

  // 5. Assemble IDAT chunk
  const idatChunk = writeChunk('IDAT', idatPayload);

  // 6. Assemble IEND chunk
  const iendChunk = writeChunk('IEND', null);

  // 7. Write everything to single output buffer
  const pngHeader = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const chunks = [pngHeader, ihdrChunk];
  if (cicpChunk) {
    chunks.push(cicpChunk);
  }
  chunks.push(idatChunk, iendChunk);

  let totalSize = 0;
  for (const c of chunks) {
    totalSize += c.length;
  }

  const pngBytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const c of chunks) {
    pngBytes.set(c, offset);
    offset += c.length;
  }

  return pngBytes;
}
