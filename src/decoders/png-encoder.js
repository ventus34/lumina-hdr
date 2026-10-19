import { applyGrade, convertPrimaries, encodeHlgRgb, encodeSdrChannel, getReferenceNits, encodeTransfer, srgbToLinear, DEFAULT_HLG_PEAK_NITS, DEFAULT_HLG_SYSTEM_GAMMA } from '../color/pipeline.js';

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
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(rawData);
      controller.close();
    }
  });

  const compressedStream = readable.pipeThrough(cs);
  const reader = compressedStream.getReader();
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

// Backward-compatible helper. Grading lives in pipeline.js so CPU exports and
// the renderer use the same linear-light operations.
function preprocessPixel(r, g, b, options) {
  if (options.processed) return [r, g, b];
  return applyGrade([r, g, b], options);
}

// Build raw scanlines with PNG filter method 0 (None)
// Applies transformations, quantization to bit depth, and left-shifts values to align to 16 bits
function buildPngRawData(width, height, floatData, bitDepth, options) {
  const bytesPerPixel = 8; // 4 channels * 2 bytes = 8 bytes for 16-bit RGBA
  const rowSize = 1 + width * bytesPerPixel;
  const rawData = new Uint8Array(height * rowSize);

  let rawIdx = 0;
  const maxVal = (1 << bitDepth) - 1;

  const type = options.type || 'hdr';
  const transfer = options.transfer || 'linear';
  const toneMapperFunc = options.toneMapperFunc;

  // Extract parameters
  const referenceNits = options.referenceNits || getReferenceNits(options);
  const linearScaleNits = Math.max(1, options.linearScaleNits || options.targetPeak || 1000);
  const background = Array.isArray(options.backgroundColor)
    ? options.backgroundColor
    : typeof options.backgroundColor === 'string' && /^#[\da-f]{6}$/i.test(options.backgroundColor)
      ? [1, 3, 5].map((i) => srgbToLinear(parseInt(options.backgroundColor.slice(i, i + 2), 16) / 255))
      : [1, 1, 1];

  for (let y = 0; y < height; y++) {
    rawData[rawIdx++] = 0; // Filter Type = 0 (None)

    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;

      let r = floatData[srcIdx];
      let g = floatData[srcIdx + 1];
      let b = floatData[srcIdx + 2];
      let a = floatData[srcIdx + 3];

      // Missing alpha is opaque; valid zero alpha is preserved unless requested otherwise.
      if (!Number.isFinite(a) || options.alphaMode === 'opaque' || options.forceOpaque) a = 1.0;
      a = Math.min(1, Math.max(0, a));

      if (options.alphaMode === 'flatten') {
        r = r * a + background[0] * (1 - a);
        g = g * a + background[1] * (1 - a);
        b = b * a + background[2] * (1 - a);
        a = 1;
      } else if (options.alphaMode && options.alphaMode !== 'preserve' && options.alphaMode !== 'opaque') {
        throw new TypeError(`Unknown alpha mode: ${options.alphaMode}`);
      }

      let ri, gi, bi, ai;

      if (type === 'sdr') {
        // SDR: apply tone mapper function to clamp output to 0.0-1.0
        if (options.processed) {
          // Caller already applied grading, tone mapping and the output transfer.
        } else if (toneMapperFunc) {
          const mapped = toneMapperFunc(r, g, b);
          r = mapped[0];
          g = mapped[1];
          b = mapped[2];
        } else {
          r = encodeSdrChannel(Math.min(1, Math.max(0, r)), options.gamma ?? 2.2);
          g = encodeSdrChannel(Math.min(1, Math.max(0, g)), options.gamma ?? 2.2);
          b = encodeSdrChannel(Math.min(1, Math.max(0, b)), options.gamma ?? 2.2);
        }
        a = Math.min(1.0, Math.max(0.0, a));

        ri = Math.min(maxVal, Math.max(0, Math.round(r * maxVal)));
        gi = Math.min(maxVal, Math.max(0, Math.round(g * maxVal)));
        bi = Math.min(maxVal, Math.max(0, Math.round(b * maxVal)));
        ai = Math.min(maxVal, Math.max(0, Math.round(a * maxVal)));
      } else {
        // HDR
        if (transfer === 'pq') {
          const processed = preprocessPixel(r, g, b, options);
          const [rp, gp, bp] = convertPrimaries(processed, 'rec709', 'rec2020');
          const r_pq = encodeTransfer(rp, 'pq', { referenceWhiteNits: referenceNits });
          const g_pq = encodeTransfer(gp, 'pq', { referenceWhiteNits: referenceNits });
          const b_pq = encodeTransfer(bp, 'pq', { referenceWhiteNits: referenceNits });
          // Quantize
          ri = Math.min(maxVal, Math.max(0, Math.round(r_pq * maxVal)));
          gi = Math.min(maxVal, Math.max(0, Math.round(g_pq * maxVal)));
          bi = Math.min(maxVal, Math.max(0, Math.round(b_pq * maxVal)));
        } else if (transfer === 'hlg') {
          const processed = preprocessPixel(r, g, b, options);
          const [rp, gp, bp] = convertPrimaries(processed, 'rec709', 'rec2020');
          const [r_hlg, g_hlg, b_hlg] = encodeHlgRgb([rp, gp, bp], {
            referenceWhiteNits: referenceNits,
            peakNits: options.hlgPeakNits || DEFAULT_HLG_PEAK_NITS,
            gamma: options.hlgGamma || DEFAULT_HLG_SYSTEM_GAMMA
          });
          // Quantize
          ri = Math.min(maxVal, Math.max(0, Math.round(r_hlg * maxVal)));
          gi = Math.min(maxVal, Math.max(0, Math.round(g_hlg * maxVal)));
          bi = Math.min(maxVal, Math.max(0, Math.round(b_hlg * maxVal)));
        } else {
          // Linear Rec.709 stored with a fixed, recoverable luminance scale.
          const [rp, gp, bp] = preprocessPixel(r, g, b, options);
          ri = Math.min(maxVal, Math.max(0, Math.round(rp * referenceNits / linearScaleNits * maxVal)));
          gi = Math.min(maxVal, Math.max(0, Math.round(gp * referenceNits / linearScaleNits * maxVal)));
          bi = Math.min(maxVal, Math.max(0, Math.round(bp * referenceNits / linearScaleNits * maxVal)));
        }
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
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError('PNG width and height must be positive integers.');
  }
  if (!floatData || floatData.length !== width * height * 4) {
    throw new TypeError('PNG image data must contain exactly width × height × 4 RGBA values.');
  }
  options = options || {};
  const bitDepth = options.bitDepth || 16;
  if (![10, 12, 16].includes(bitDepth)) throw new RangeError('PNG bit depth must be 10, 12 or 16.');
  const type = options.type || 'hdr';
  const transfer = options.transfer || 'linear';
  if (!['sdr', 'hdr'].includes(type)) throw new TypeError(`Unsupported PNG type: ${type}`);
  if (!['linear', 'pq', 'hlg'].includes(transfer)) throw new TypeError(`Unsupported PNG transfer: ${transfer}`);

  // 1. Build uncompressed scanline data
  const rawData = buildPngRawData(width, height, floatData, bitDepth, {
    ...options
  });

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

  // cICP uses BT.709 primaries for SDR/linear RGB and BT.2020 for PQ/HLG.
  let cicpData;
  if (type === 'sdr') cicpData = new Uint8Array([1, 13, 0, 1]); // BT.709 / sRGB
  else if (transfer === 'pq') cicpData = new Uint8Array([9, 16, 0, 1]);
  else if (transfer === 'hlg') cicpData = new Uint8Array([9, 18, 0, 1]);
  else cicpData = new Uint8Array([1, 8, 0, 1]); // linear Rec.709
  const cicpChunk = writeChunk('cICP', cicpData);
  const sbitChunk = writeChunk('sBIT', new Uint8Array([bitDepth, bitDepth, bitDepth, bitDepth]));
  const metadataChunks = [];
  if (type === 'hdr' && transfer === 'linear') {
    const scale = String(Math.max(1, options.linearScaleNits || options.targetPeak || 1000));
    metadataChunks.push(writeChunk('tEXt', new TextEncoder().encode(`LuminaLinearScaleNits\0${scale}`)));
  }
  if (type === 'hdr' && transfer === 'hlg') {
    const peakNits = String(options.hlgPeakNits || DEFAULT_HLG_PEAK_NITS);
    const gamma = String(options.hlgGamma || DEFAULT_HLG_SYSTEM_GAMMA);
    metadataChunks.push(writeChunk('tEXt', new TextEncoder().encode(`LuminaHlgPeakNits\0${peakNits}`)));
    metadataChunks.push(writeChunk('tEXt', new TextEncoder().encode(`LuminaHlgSystemGamma\0${gamma}`)));
  }
  if (options.alphaMode) {
    metadataChunks.push(writeChunk('tEXt', new TextEncoder().encode(`LuminaAlphaMode\0${options.alphaMode}`)));
  }

  // 5. Assemble IDAT chunk
  const idatChunk = writeChunk('IDAT', idatPayload);

  // 6. Assemble IEND chunk
  const iendChunk = writeChunk('IEND', null);

  // 7. Write everything to single output buffer
  const pngHeader = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const chunks = [pngHeader, ihdrChunk, sbitChunk, cicpChunk, ...metadataChunks, idatChunk, iendChunk];

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
