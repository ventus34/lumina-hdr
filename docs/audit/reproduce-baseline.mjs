// Focused audit checks for f984d56263d0cb169ac014eaa0dc172120a4ea3d.
// Run: node docs/audit/reproduce.mjs
// FAIL means an observed behavior violates the stated contract. Browser and
// codec doubles isolate adapters; they do not verify browser HDR support.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { decodeRGBE, encodeRGBE } from '../../src/decoders/rgbe.js';
import { encodePNG } from '../../src/decoders/png-encoder.js';

const main = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8');
const avif = await readFile(new URL('../../src/decoders/avif.js', import.meta.url), 'utf8');
const jxr = await readFile(new URL('../../src/decoders/jxr.js', import.meta.url), 'utf8');
const results = [];
async function check(name, run) {
  try {
    const detail = await run();
    results.push({ name, status: 'PASS', detail });
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: error.message });
  }
}

function imageEnvironment(context) {
  const errors = [];
  class FakeImage {
    width = 1;
    height = 1;
    naturalWidth = 1;
    naturalHeight = 1;
    set src(_) {
      queueMicrotask(() => {
        try { this.onload(); } catch (error) { errors.push(error.message); }
      });
    }
  }
  return {
    errors, Image: FakeImage,
    URL: { createObjectURL: () => 'blob:audit', revokeObjectURL() {} },
    document: { createElement: () => ({ getContext: () => context }) },
    Blob, Float32Array, console,
  };
}

function inspectPNG(bytes) {
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  return { chunks, rgba: [1, 3, 5, 7].map(offset => raw.readUInt16BE(offset)) };
}

await check('Control: valid RGBE round trip', () => {
  const decoded = decodeRGBE(encodeRGBE(1, 1, new Float32Array([1, 0.5, 2, 1])));
  assert.deepEqual([...decoded.data], [1, 0.5, 2, 1]);
  return [...decoded.data];
});

await check('SDR adapter must return linear RGB', async () => {
  const env = imageEnvironment({ drawImage() {}, getImageData: () => ({ data: [128, 128, 128, 255] }) });
  const start = main.indexOf('function decodeStandardImage(');
  const end = main.indexOf('// Update UI Sidebar Metadata Details', start);
  const decode = vm.runInNewContext(`${main.slice(start, end)}; decodeStandardImage`, env);
  const decoded = await decode({});
  const expected = ((128 / 255 + 0.055) / 1.055) ** 2.4;
  assert.ok(Math.abs(decoded.data[0] - expected) < 1e-6,
    `sRGB 128: observed ${decoded.data[0]}, expected linear ${expected}; clamp preview becomes ${Math.round(decoded.data[0] ** (1 / 2.2) * 255)}/255`);
});

await check('AVIF adapter must convert BT.2020 primaries to working Rec.709', async () => {
  const env = imageEnvironment({ drawImage() {}, getContextAttributes: () => ({ colorSpace: 'rec2100-pq' }),
    getImageData: () => ({ data: [0.75, 0, 0, 1] }) });
  const decode = vm.runInNewContext(`${avif.replace('export async function', 'async function')}; decodeAVIF`, env);
  const decoded = await decode(new ArrayBuffer(0), new Blob());
  const pq = vm.runInNewContext(`${avif.slice(0, avif.indexOf('/**\n * Decodes'))}; pqEotf`);
  const linearRed = pq(0.75) / 80;
  const expectedRed709 = 1.660491 * linearRed;
  assert.ok(Math.abs(decoded.data[0] - expectedRed709) < 1e-3,
    `observed RGB ${[...decoded.data].slice(0, 3)}; expected approximately [${expectedRed709}, ${-0.12455 * linearRed}, ${-0.018151 * linearRed}] in linear Rec.709`);
});

await check('AVIF canvas error must reject, not leave a pending Promise', async () => {
  const env = imageEnvironment({ drawImage() {}, getContextAttributes: () => ({ colorSpace: 'rec2100-pq' }),
    getImageData() { throw new Error('audit: unsupported HDR readback'); } });
  const decode = vm.runInNewContext(`${avif.replace('export async function', 'async function')}; decodeAVIF`, env);
  const outcome = await Promise.race([
    decode(new ArrayBuffer(0), new Blob()).then(() => 'resolved', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('pending'), 40)),
  ]);
  assert.equal(outcome, 'rejected', `outcome=${outcome}; escaped callback errors=${env.errors.join(', ')}`);
});

await check('RGBE decoder must reject missing uncompressed pixels', () => {
  const bytes = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n');
  assert.throws(() => decodeRGBE(bytes), /truncat|invalid|missing/i,
    'A header with no pixel payload was accepted as an image');
});

await check('RGBE decoder must reject missing final RLE run value', () => {
  const header = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n');
  const bytes = new Uint8Array([...header, 2, 2, 0, 8, 136, 128, 136, 128, 136, 128, 136]);
  assert.throws(() => decodeRGBE(bytes), /truncat|invalid|missing/i,
    'The final exponent run has no value, but the decoder accepted it');
});

await check('PNG encoder must preserve an intentionally transparent image', async () => {
  const png = inspectPNG(await encodePNG(1, 1, new Float32Array([0.25, 0.5, 0.75, 0]),
    { bitDepth: 16, type: 'sdr' }));
  assert.equal(png.rgba[3], 0, `alpha observed=${png.rgba[3]}, expected=0`);
});

await check('JXR adapter must expand supported grayscale or explicitly reject it', async () => {
  const code = jxr.replace("import jpegxr from 'jpegxr';", '').replace('export async function', 'async function');
  const decode = vm.runInNewContext(`${code}; decodeJXR`, {
    jpegxr: async () => ({ decode: () => ({ width: 1, height: 1,
      pixelInfo: { channels: 1, hasAlpha: false, bitDepth: '8', bgr: false }, bytes: new Uint8Array([128]) }) }),
    Uint8Array, Uint16Array, Float32Array,
  });
  let decoded;
  try { decoded = await decode(new Uint8Array([0])); }
  catch { return 'Explicit rejection is acceptable until grayscale support is implemented'; }
  assert.ok([...decoded.data].every(Number.isFinite), `observed RGBA=${[...decoded.data]}`);
});

await check('Control: PQ PNG carries cICP and a 16-bit container', async () => {
  const png = inspectPNG(await encodePNG(1, 1, new Float32Array([1, 1, 1, 1]),
    { bitDepth: 10, type: 'hdr', transfer: 'pq', sdrWhite: 200 }));
  assert.deepEqual([...png.chunks.find(c => c.type === 'cICP').data], [9, 16, 0, 1]);
  assert.equal(png.chunks.find(c => c.type === 'IHDR').data[8], 16);
  return { chunks: png.chunks.map(c => c.type), rgba16: png.rgba };
});

console.log(JSON.stringify({ baseline: 'f984d56263d0cb169ac014eaa0dc172120a4ea3d',
  passed: results.filter(r => r.status === 'PASS').length,
  failed: results.filter(r => r.status === 'FAIL').length, results }, null, 2));
process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
