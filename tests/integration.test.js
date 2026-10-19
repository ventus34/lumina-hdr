import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { decodeImage } from '../src/services/decode-image.js';
import { exportImageBlob } from '../src/services/export-image.js';
import { encodeRGBE } from '../src/decoders/rgbe.js';

const neutral = {
  exposure: 0, gamma: 2.2, contrast: 1, sdrBoost: 1,
  smartUpmix: false, saturation: 1, shadows: 0, highlights: 0,
  temp: 0, tint: 0, toneMapper: 0, sdrWhite: 200,
  targetPeak: 1000, autoExposureCorrect: false,
};

function pngRow(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    chunks.push({ type: Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('ascii'),
      data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  assert.equal(raw[0], 0, 'one-row high precision fixture uses PNG filter None');
  const values = [];
  for (let offset = 1; offset < raw.length; offset += 2) values.push(raw.readUInt16BE(offset) / 65535);
  return { values, chunks };
}

function pqToNits(value) {
  const m1 = 2610 / 16384, m2 = 2523 / 32;
  const c1 = 3424 / 4096, c2 = 2413 / 128, c3 = 2392 / 128;
  const p = value ** (1 / m2);
  return 10000 * (Math.max(p - c1, 0) / (c2 - c3 * p)) ** (1 / m1);
}

test('file decode → processed RGBE export → file decode applies exposure once', async () => {
  const bytes = encodeRGBE(2, 1, new Float32Array([0.25, 0.5, 1, 1, 2, 4, 8, 1]));
  const source = await decodeImage(new File([bytes], 'source.hdr'));
  const blob = await exportImageBlob(source, { ...neutral, exposure: 1 }, { format: 'hdr' });
  const result = await decodeImage(new File([blob], 'processed.hdr'));
  assert.equal(result.width, 2);
  assert.equal(result.height, 1);
  [0.5, 1, 2, 1, 4, 8, 16, 1].forEach((expected, i) => {
    assert.ok(Math.abs(result.data[i] - expected) <= Math.max(0.01, expected / 128),
      `channel ${i}: observed ${result.data[i]}, expected ${expected}`);
  });
});

test('absolute scRGB → PQ PNG keeps source nits independent of target SDR white', async () => {
  const image = { width: 1, height: 1, data: new Float32Array([0.5, 0.5, 0.5, 1]),
    colorSpace: 'linear-rec709', luminanceUnit: 'scRGB-80-nit',
    sourceHDR: true, decodedHDR: true, alpha: 'opaque' };
  const nits = [];
  for (const sdrWhite of [80, 200, 300]) {
    const blob = await exportImageBlob(image, { ...neutral, sdrWhite }, { format: 'png16pq' });
    const png = pngRow(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual([...png.chunks.find(c => c.type === 'cICP').data], [9, 16, 0, 1]);
    const observed = pqToNits(png.values[0]);
    nits.push(observed);
    assert.ok(Math.abs(observed - 40) < 0.03, `white=${sdrWhite}, expected 40 nits, observed=${observed}`);
  }
  assert.ok(Math.max(...nits) - Math.min(...nits) < 0.001);
});

test('HDR import → neutral SDR PNG16 uses sRGB while preserving explicit alpha', async () => {
  const bytes = encodeRGBE(1, 1, new Float32Array([0.25, 0.5, 1, 1]));
  const source = await decodeImage(new File([bytes], 'source.hdr'));
  source.data[3] = 0;
  source.alpha = 'straight';
  const blob = await exportImageBlob(source, neutral, { format: 'png16sdr', alphaMode: 'preserve' });
  const png = pngRow(new Uint8Array(await blob.arrayBuffer()));
  const expected = [0.25, 0.5, 1].map(v => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  expected.forEach((value, i) => assert.ok(Math.abs(png.values[i] - value) < 2 / 65535));
  assert.equal(png.values[3], 0);
});

test('aborted public decode rejects before reading a file', async () => {
  const controller = new AbortController();
  controller.abort();
  let read = false;
  const file = { name: 'source.hdr', size: 50, arrayBuffer() { read = true; throw new Error('must not read'); } };
  await assert.rejects(decodeImage(file, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(read, false);
});

test('HDR provenance with an SDR fallback uses the same processing as ordinary SDR pixels', async () => {
  const base = { width: 1, height: 1, data: new Float32Array([0.1, 0.2, 0.3, 1]),
    colorSpace: 'linear-rec709', luminanceUnit: 'relative', decodedHDR: false, alpha: 'opaque' };
  const settings = { ...neutral, sdrBoost: 2 };
  for (const format of ['png16sdr', 'png16pq', 'hdr']) {
    const plain = await exportImageBlob({ ...base, sourceHDR: false }, settings, { format });
    const fallback = await exportImageBlob({ ...base, sourceHDR: true }, settings, { format });
    assert.deepEqual(new Uint8Array(await fallback.arrayBuffer()), new Uint8Array(await plain.arrayBuffer()),
      `${format}: source provenance must not change the interpretation of decoded SDR pixels`);
  }
});

test('canvas-ready bytes are reused without applying 8-bit quantization twice', async () => {
  const originals = Object.fromEntries(['OffscreenCanvas', 'ImageData'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let captured;
  globalThis.ImageData = class {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
  };
  globalThis.OffscreenCanvas = class {
    getContext() {
      return { putImageData(image) { captured = [...image.data]; } };
    }
    convertToBlob() { return Promise.resolve(new Blob(['fixture'], { type: 'image/png' })); }
  };
  try {
    const v = ((128 / 255 + 0.055) / 1.055) ** 2.4;
    await exportImageBlob({ width: 1, height: 1, data: new Float32Array([v, v, v, 0.5]), decodedHDR: false },
      neutral, { format: 'png', alphaMode: 'preserve' });
    assert.deepEqual(captured, [128, 128, 128, 128]);
  } finally {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
