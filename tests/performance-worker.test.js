import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRGBE } from '../src/decoders/rgbe.js';
import { runProcessingTask, getTransferables } from '../src/workers/processing-tasks.js';

test('combined RGBE task grades and encodes pixels in the worker task module', async () => {
  const payload = {
    image: {
      width: 1,
      height: 1,
      data: new Float32Array([0.25, 0.5, 1, 1]),
      colorSpace: 'linear-rec709',
      luminanceUnit: 'relative-sdr',
      sourceHDR: false
    },
    processing: {
      mode: 'hdr',
      sdrWhite: 80,
      sdrBoost: 1,
      exposure: 0,
      saturation: 1,
      contrast: 1,
      temp: 0,
      tint: 0,
      shadows: 0,
      highlights: 0,
      alphaMode: 'preserve'
    },
    encode: { format: 'hdr' }
  };
  const baseBytes = await runProcessingTask('process-and-encode', payload);
  const scaledBytes = await runProcessingTask('process-and-encode', {
    ...payload,
    processing: { ...payload.processing, sdrWhite: 160 }
  });
  const base = decodeRGBE(baseBytes.buffer.slice(baseBytes.byteOffset, baseBytes.byteOffset + baseBytes.byteLength));
  const decoded = decodeRGBE(scaledBytes.buffer.slice(scaledBytes.byteOffset, scaledBytes.byteOffset + scaledBytes.byteLength));
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.ok(Math.abs(decoded.data[0] / base.data[0] - 2) < 0.03);
  assert.ok(Math.abs(decoded.data[1] / base.data[1] - 2) < 0.03);
  assert.ok(Math.abs(decoded.data[2] / base.data[2] - 2) < 0.03);
  assert.equal(decoded.data[3], 1);
  assert.deepEqual(getTransferables(scaledBytes), [scaledBytes.buffer]);
});

test('Radiance HDR values stay relative across SDR white settings', async () => {
  const payload = {
    image: {
      width: 1,
      height: 1,
      data: new Float32Array([0.25, 0.5, 1, 1]),
      colorSpace: 'linear-rec709',
      luminanceUnit: 'relative',
      sourceHDR: true
    },
    processing: { mode: 'hdr', exposure: 1, sdrWhite: 80, alphaMode: 'preserve' },
    encode: { format: 'hdr' }
  };
  const at80 = await runProcessingTask('process-and-encode', payload);
  const at200 = await runProcessingTask('process-and-encode', {
    ...payload,
    processing: { ...payload.processing, sdrWhite: 200 }
  });
  const a = decodeRGBE(at80.buffer.slice(at80.byteOffset, at80.byteOffset + at80.byteLength));
  const b = decodeRGBE(at200.buffer.slice(at200.byteOffset, at200.byteOffset + at200.byteLength));
  for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(a.data[channel] - b.data[channel]) < 0.01);
});

test('decodedHDR=false overrides HDR provenance for grading and RGBE scale', async () => {
  const payload = {
    image: {
      width: 1,
      height: 1,
      data: new Float32Array([0.25, 0.5, 1, 1]),
      colorSpace: 'linear-rec709',
      luminanceUnit: 'relative',
      sourceHDR: true,
      decodedHDR: false
    },
    processing: {
      mode: 'hdr',
      exposure: 0,
      sdrBoost: 2,
      sdrWhite: 160,
      alphaMode: 'preserve'
    },
    encode: { format: 'hdr' }
  };
  const bytes = await runProcessingTask('process-and-encode', payload);
  const decoded = decodeRGBE(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(Math.abs(decoded.data[0] - 1) < 0.02);
  assert.ok(Math.abs(decoded.data[1] - 2) < 0.02);
  assert.ok(Math.abs(decoded.data[2] - 4) < 0.03);
});

test('combined SDR PNG task returns a transferable PNG buffer', async () => {
  const bytes = await runProcessingTask('process-and-encode', {
    image: {
      width: 1,
      height: 1,
      data: new Float32Array([0.5, 0.25, 0.125, 0.5]),
      colorSpace: 'linear-rec709',
      luminanceUnit: 'relative-sdr',
      sourceHDR: false
    },
    processing: {
      mode: 'sdr',
      toneMapper: 'linear',
      targetPeak: 1000,
      gamma: 2.2,
      alphaMode: 'preserve'
    },
    encode: { format: 'png', options: { type: 'sdr', bitDepth: 10 } }
  });
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.byteLength > 40);
});

test('SDR grading returns canvas-ready bytes from the worker', async () => {
  const bytes = await runProcessingTask('process-sdr-pixels', {
    image: { width: 1, height: 1, data: new Float32Array([0.5, 0.25, 0.125, 0.5]), sourceHDR: false },
    processing: { toneMapper: 'linear', gamma: 2.2, alphaMode: 'preserve' }
  });
  assert.ok(bytes instanceof Uint8ClampedArray);
  assert.deepEqual([...bytes], [188, 137, 99, 128]);
  assert.deepEqual(getTransferables(bytes), [bytes.buffer]);
});

test('native AVIF worker decode requests main-thread fallback explicitly', async () => {
  await assert.rejects(
    runProcessingTask('decode-image', { name: 'sample.avif', buffer: new ArrayBuffer(8) }),
    { code: 'REQUIRES_MAIN_THREAD' }
  );
});
