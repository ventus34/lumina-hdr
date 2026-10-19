import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { exportImageBlob } from '../src/services/export-image.js';
import { encodePNG } from '../src/decoders/png-encoder.js';
import { decodeRGBE } from '../src/decoders/rgbe.js';
import { convertPrimaries, pqToNits } from '../src/color/pipeline.js';

async function parsePng(blobOrBytes) {
  const bytes = blobOrBytes instanceof Uint8Array ? blobOrBytes : new Uint8Array(await blobOrBytes.arrayBuffer());
  const chunks = new Map();
  const textChunks = [];
  const idat = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    const name = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (name === 'IDAT') idat.push(data);
    else {
      chunks.set(name, data);
      if (name === 'tEXt') textChunks.push(new TextDecoder().decode(data));
    }
    offset += 12 + length;
    if (name === 'IEND') break;
  }
  const compressed = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of idat) { compressed.set(part, cursor); cursor += part.length; }
  return { chunks, textChunks, raw: inflateSync(compressed) };
}

function firstPixel16(raw) {
  assert.equal(raw[0], 0, 'expected filter type None');
  return [0, 1, 2, 3].map((channel) => (raw[1 + channel * 2] << 8) | raw[2 + channel * 2]);
}

test('high-bit PNG preserves zero alpha and declares sBIT and sRGB transfer', async () => {
  const bytes = await encodePNG(1, 1, new Float32Array([0.2158605, 0.2158605, 0.2158605, 0]), {
    bitDepth: 10,
    type: 'sdr',
    transfer: 'linear'
  });
  const { chunks, raw } = await parsePng(bytes);
  assert.deepEqual([...chunks.get('sBIT')], [10, 10, 10, 10]);
  assert.deepEqual([...chunks.get('cICP')], [1, 13, 0, 1]);
  const rgba = firstPixel16(raw);
  assert.ok(Math.abs(rgba[0] / 65535 - 128 / 255) < 0.0015);
  assert.equal(rgba[3], 0, 'transparent source pixels stay transparent by default');
});

test('absolute PQ PNG export keeps 40 nits stable across SDR white settings', async () => {
  const image = {
    width: 1,
    height: 1,
    data: new Float32Array([0.5, 0.5, 0.5, 1]),
    colorSpace: 'linear-rec709',
    luminanceUnit: 'scRGB-80-nit',
    sourceHDR: true,
    alpha: 'opaque'
  };
  for (const sdrWhite of [80, 200, 300]) {
    const blob = await exportImageBlob(image, { exposure: 0, autoExposureCorrect: false, sdrWhite, targetPeak: 1000 }, { format: 'png10pq' });
    const { chunks, raw } = await parsePng(blob);
    assert.deepEqual([...chunks.get('cICP')], [9, 16, 0, 1]);
    assert.deepEqual([...chunks.get('sBIT')], [10, 10, 10, 10]);
    const [red, green, blue] = firstPixel16(raw).slice(0, 3).map((value) => value / 65535);
    for (const encoded of [red, green, blue]) assert.ok(Math.abs(pqToNits(encoded) - 40) < 0.5);
  }
});

test('PQ BT.2020 export preserves a saturated Rec.2020 red after Rec.709 round-trip', async () => {
  const rec709Red = convertPrimaries([1, 0, 0], 'rec2020', 'rec709');
  const image = {
    width: 1,
    height: 1,
    data: new Float32Array([...rec709Red, 1]),
    luminanceUnit: 'scRGB-80-nit',
    sourceHDR: true
  };
  const blob = await exportImageBlob(image, { exposure: 0, sdrWhite: 200 }, { format: 'png16pq' });
  const { chunks, raw } = await parsePng(blob);
  assert.deepEqual([...chunks.get('cICP')], [9, 16, 0, 1]);
  const [r, g, b] = firstPixel16(raw).slice(0, 3).map((value) => pqToNits(value / 65535));
  assert.ok(Math.abs(r - 80) < 0.5);
  assert.ok(g < 0.1);
  assert.ok(b < 0.1);
});

test('relative PQ export applies auto exposure once to reach 80-nit reference', async () => {
  const image = {
    width: 1,
    height: 1,
    data: new Float32Array([0.5, 0.5, 0.5, 1]),
    colorSpace: 'linear-rec709',
    luminanceUnit: 'relative',
    sourceHDR: false,
    alpha: 'opaque'
  };
  const blob = await exportImageBlob(image, { exposure: 0, autoExposureCorrect: true, sdrWhite: 200 }, { format: 'png12pq' });
  const { raw } = await parsePng(blob);
  const encoded = firstPixel16(raw)[0] / 65535;
  assert.ok(Math.abs(pqToNits(encoded) - 40) < 0.3);
});

test('linear PNG uses a fixed recoverable scale instead of per-image normalization', async () => {
  const image = { width: 1, height: 1, data: new Float32Array([1, 1, 1, 1]), luminanceUnit: 'relative', sourceHDR: false };
  const blob = await exportImageBlob(image, { exposure: 0, sdrWhite: 200, targetPeak: 1000 }, { format: 'png16hdr' });
  const { textChunks, raw } = await parsePng(blob);
  assert.ok(textChunks.includes(`LuminaLinearScaleNits\u00001000`));
  assert.ok(Math.abs(firstPixel16(raw)[0] / 65535 - 0.2) < 1 / 65535);
});

test('Radiance export can apply grading or preserve the original pixels explicitly', async () => {
  const image = { width: 1, height: 1, data: new Float32Array([0.5, 0.25, 0.125, 1]), luminanceUnit: 'relative', sourceHDR: false };
  const options = { exposure: 1, autoExposureCorrect: false, sdrWhite: 80 };
  const processedBlob = await exportImageBlob(image, options, { format: 'hdr' });
  const originalBlob = await exportImageBlob(image, options, { format: 'hdr', pixelMode: 'original' });
  const processed = decodeRGBE(await processedBlob.arrayBuffer());
  const original = decodeRGBE(await originalBlob.arrayBuffer());
  assert.ok(Math.abs(processed.data[0] - 1) < 0.01);
  assert.ok(Math.abs(original.data[0] - 0.5) < 0.01);
  assert.equal(image.data[0], 0.5, 'worker export must not detach the preview buffer');
});

test('RGBE scale uses decoded HDR status when source HDR falls back to relative SDR', async () => {
  const source = {
    width: 1,
    height: 1,
    data: new Float32Array([0.5, 0.5, 0.5, 1]),
    sourceHDR: true,
    luminanceUnit: 'relative'
  };
  const fallback = decodeRGBE(await (await exportImageBlob({ ...source, decodedHDR: false }, { sdrWhite: 200, autoExposureCorrect: false }, { format: 'hdr' })).arrayBuffer());
  const decoded = decodeRGBE(await (await exportImageBlob({ ...source, decodedHDR: true }, { sdrWhite: 200, autoExposureCorrect: false }, { format: 'hdr' })).arrayBuffer());
  assert.ok(Math.abs(fallback.data[0] - 1.25) < 0.02);
  assert.ok(Math.abs(decoded.data[0] - 0.5) < 0.01);
});

test('large no-worker exports fail before synchronous main-thread processing', async () => {
  if (typeof Worker !== 'undefined') return;
  const width = 524289;
  const image = { width, height: 1, data: new Float32Array(width * 4), luminanceUnit: 'relative' };
  await assert.rejects(
    exportImageBlob(image, {}, { format: 'hdr' }),
    /main-thread export is limited to 8 MiB.*Web Worker support/
  );
});

test('CSP worker startup failure rejects large export before allocating a transfer copy', async () => {
  if (typeof Worker !== 'undefined') return;
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let copyAllocations = 0;
  class TrackedFloat32Array extends Float32Array {
    constructor(lengthOrValues) {
      super(lengthOrValues);
      if (typeof lengthOrValues === 'number') copyAllocations++;
    }
  }
  const width = 524289;
  const data = new TrackedFloat32Array(width * 4);
  copyAllocations = 0;
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: class BlockedWorker { constructor() { throw new Error('Blocked by Content Security Policy'); } }
  });
  try {
    await assert.rejects(
      exportImageBlob({ width, height: 1, data, luminanceUnit: 'relative' }, {}, { format: 'hdr' }),
      /main-thread export is limited to 8 MiB/
    );
    assert.equal(copyAllocations, 0, 'worker startup failure must be detected before cloning pixel data');
  } finally {
    if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
    else delete globalThis.Worker;
  }
});

test('cancelling during canvas encoding rejects instead of returning a Blob', async () => {
  const originalCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  const originalImageData = Object.getOwnPropertyDescriptor(globalThis, 'ImageData');
  class FakeImageData {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
  }
  class FakeOffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        createImageData: (width, height) => new FakeImageData(new Uint8ClampedArray(width * height * 4), width, height),
        putImageData() {}
      };
    }
    convertToBlob() { return new Promise((resolve) => setTimeout(() => resolve(new Blob(['encoded'], { type: 'image/png' })), 100)); }
  }
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, writable: true, value: FakeOffscreenCanvas });
  Object.defineProperty(globalThis, 'ImageData', { configurable: true, writable: true, value: FakeImageData });
  const controller = new AbortController();
  try {
    const pending = exportImageBlob(
      { width: 1, height: 1, data: new Float32Array([0.2, 0.3, 0.4, 1]), luminanceUnit: 'relative' },
      {},
      { format: 'png', signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    if (originalCanvas) Object.defineProperty(globalThis, 'OffscreenCanvas', originalCanvas);
    else delete globalThis.OffscreenCanvas;
    if (originalImageData) Object.defineProperty(globalThis, 'ImageData', originalImageData);
    else delete globalThis.ImageData;
  }
});
