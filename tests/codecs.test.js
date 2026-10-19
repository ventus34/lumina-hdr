import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeRGBE, encodeRGBE } from '../src/decoders/rgbe.js';
import { decodeAVIFHighBitImage, parseAvifColorInfo } from '../src/decoders/avif.js';
import { decodeJXRImage } from '../src/decoders/jxr.js';
import { decodeEXR } from '../src/decoders/exr.js';
import { decodeImageBuffer } from '../src/services/decode-image.js';

const REC709 = 'PRIMARIES=0.64 0.33 0.30 0.60 0.15 0.06 0.3127 0.329';

function radianceHeader(resolution, extra = '') {
  return Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n${REC709}\n${extra}\n${resolution}\n`, 'ascii');
}

function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function makeAvif({ association = true, transfer = 16 } = {}) {
  const ftyp = box('ftyp', Buffer.from('avif\0\0\0\0avif', 'ascii'));
  const pitm = box('pitm', Buffer.from([0, 0, 0, 0, 0, 1]));
  const nclx = Buffer.from([0, 9, 0, transfer, 0, 9, 0x80]);
  const colr = box('colr', Buffer.concat([Buffer.from('nclx'), nclx]));
  const ipco = box('ipco', colr);
  const ipmaEntry = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1]);
  const ipma = association ? box('ipma', ipmaEntry) : null;
  const iprp = box('iprp', Buffer.concat([ipco, ...(ipma ? [ipma] : [])]));
  const meta = box('meta', Buffer.concat([Buffer.from([0, 0, 0, 0]), pitm, iprp]));
  return Buffer.concat([ftyp, meta]);
}

function attr(name, type, payload) {
  const nameBytes = Buffer.from(`${name}\0`, 'ascii');
  const typeBytes = Buffer.from(`${type}\0`, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([nameBytes, typeBytes, size, payload]);
}

function makeExr(channels, sampleValues, { chromaticities = null } = {}) {
  const channelItems = [];
  for (const { name } of channels) {
    const n = Buffer.from(`${name}\0`, 'ascii');
    const info = Buffer.alloc(16);
    info.writeInt32LE(2, 0); // FLOAT pixel type
    info[4] = 0;
    info.writeInt32LE(1, 8);
    info.writeInt32LE(1, 12);
    channelItems.push(n, info);
  }
  channelItems.push(Buffer.from([0]));
  const channelList = Buffer.concat(channelItems);
  const attrs = [
    attr('channels', 'chlist', channelList),
    attr('compression', 'compression', Buffer.from([0])),
    attr('dataWindow', 'box2i', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    attr('displayWindow', 'box2i', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    attr('lineOrder', 'lineOrder', Buffer.from([0])),
    attr('pixelAspectRatio', 'float', Buffer.from([0, 0, 128, 63])),
    attr('screenWindowCenter', 'v2f', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])),
    attr('screenWindowWidth', 'float', Buffer.from([0, 0, 128, 63])),
  ];
  if (chromaticities) {
    const values = [chromaticities.redX, chromaticities.redY, chromaticities.greenX, chromaticities.greenY,
      chromaticities.blueX, chromaticities.blueY, chromaticities.whiteX, chromaticities.whiteY];
    const data = Buffer.alloc(32);
    values.forEach((value, i) => data.writeFloatLE(value, i * 4));
    attrs.push(attr('chromaticities', 'chromaticities', data));
  }
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(0x01312f76, 0);
  prefix.writeUInt32LE(2, 4);
  const header = Buffer.concat([prefix, ...attrs, Buffer.from([0])]);
  const chunkOffset = header.length + 8;
  const offsetTable = Buffer.alloc(8);
  offsetTable.writeBigUInt64LE(BigInt(chunkOffset));
  const chunk = Buffer.alloc(8 + sampleValues.length * 4);
  chunk.writeInt32LE(0, 0);
  chunk.writeUInt32LE(sampleValues.length * 4, 4);
  sampleValues.forEach((value, i) => chunk.writeFloatLE(value, 8 + i * 4));
  return Buffer.concat([header, offsetTable, chunk]);
}

test('AVIF nclx parser reads the primary item CICP metadata', () => {
  const info = parseAvifColorInfo(makeAvif());
  assert.equal(info.primaries, 9);
  assert.equal(info.transfer, 16);
  assert.equal(info.matrix, 9);
  assert.equal(info.fullRange, true);
  assert.equal(info.sourceHDR, true);
  assert.equal(info.sourceHDRKnown, true);
  assert.deepEqual(info.warnings, []);
});

test('AVIF metadata ambiguity is reported and malformed boxes are rejected', () => {
  const ambiguous = parseAvifColorInfo(makeAvif({ association: false }));
  assert.equal(ambiguous.sourceHDR, false);
  assert.equal(ambiguous.sourceHDRKnown, false);
  assert.ok(ambiguous.warnings.some((warning) => warning.includes('primary-item association')));
  assert.ok(ambiguous.warnings.some((warning) => warning.includes('source HDR status is unknown')));

  const malformed = makeAvif();
  malformed.writeUInt32BE(0xfffffff0, 0);
  assert.throws(() => parseAvifColorInfo(malformed), /box size/);
});

test('AVIF parser recognizes a real PQ BT.2020 test file', () => {
  const bytes = readFileSync(new URL('./fixtures/pq-gray-512.avif', import.meta.url));
  const info = parseAvifColorInfo(bytes);
  assert.equal(info.primaries, 9);
  assert.equal(info.transfer, 16);
  assert.equal(info.matrix, 9);
  assert.equal(info.width, 64);
  assert.equal(info.height, 64);
  assert.equal(info.sourceHDRKnown, true);
});

test('jSquash AVIF preserves 10-bit PQ code values and converts them to scRGB-80-nit', async () => {
  const decodeModule = await import('@jsquash/avif/decode.js');
  const wasm = await WebAssembly.compile(readFileSync('node_modules/@jsquash/avif/codec/dec/avif_dec.wasm'));
  await decodeModule.init(wasm);
  const decode = decodeModule.default;

  for (const [fixture, code] of [['pq-gray-512.avif', 512], ['pq-gray-768.avif', 768]]) {
    const bytes = readFileSync(`tests/fixtures/${fixture}`);
    const rawBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const image = await decode(rawBuffer, { bitDepth: 16 });
    assert.ok(image.data instanceof Uint16Array);
    const info = parseAvifColorInfo(bytes);
    const decoded = decodeAVIFHighBitImage(image, info);
    const encoded = code / 1023;
    const p = encoded ** (1 / (2523 / 32));
    const expected = 10_000 * (Math.max(p - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * p)) ** (1 / (2610 / 16384)) / 80;
    assert.ok(Math.abs(decoded.data[0] - expected) < expected * 0.02);
    assert.equal(decoded.data[3], 1);
    assert.equal(decoded.decodedHDR, true);
    assert.equal(decoded.luminanceUnit, 'scRGB-80-nit');
  }
});

test('AVIF HLG uses the BT.2100 display OOTF in BT.2020 and declares its fixed peak', () => {
  const metadata = { sourceHDRKnown: true, transfer: 18, primaries: 9, matrix: 9, warnings: [] };
  const image = { width: 1, height: 1, data: new Uint16Array([65535, 65535, 65535, 65535]) };
  const decoded = decodeAVIFHighBitImage(image, metadata);
  assert.ok(decoded.data.slice(0, 3).every((value) => Math.abs(value - 12.5) < 0.01));
  assert.equal(decoded.luminanceUnit, 'scRGB-80-nit');
  assert.equal(decoded.decodedHDR, true);
  assert.ok(decoded.warnings.some((warning) => warning.includes('gamma 1.2')));

  assert.throws(() => decodeAVIFHighBitImage(image, { ...metadata, primaries: 12 }), /requires BT\.2020/);
});

test('RGBE handles orientation and strict raw/old-style RLE decoding', () => {
  const orientation = radianceHeader('+Y 2 -X 2');
  const raw = Buffer.from([
    128, 0, 0, 129, 0, 128, 0, 129,
    0, 0, 128, 129, 128, 128, 128, 129,
  ]);
  const image = decodeRGBE(Buffer.concat([orientation, raw]));
  assert.equal(image.colorSpace, 'linear-rec709');
  assert.equal(image.alpha, 'opaque');
  assert.deepEqual([...image.data].filter((_, i) => i % 4 === 3), [1, 1, 1, 1]);
  assert.ok(image.data[0] > 0.9 && image.data[1] > 0.9 && image.data[2] > 0.9); // top-left: white
  assert.ok(image.data[4] < 0.01 && image.data[5] < 0.01 && image.data[6] > 0.9); // top-right: blue

  const oldRle = radianceHeader('-Y 1 +X 2');
  const repeated = decodeRGBE(Buffer.concat([oldRle, Buffer.from([64, 0, 0, 129, 1, 1, 1, 1])]));
  assert.ok(Math.abs(repeated.data[0] - repeated.data[4]) < 1e-6);
  assert.throws(() => decodeRGBE(Buffer.concat([oldRle, Buffer.from([64, 0, 0, 129, 1, 1, 1])])), /Truncated/);
});

test('RGBE new RLE rejects missing run values, truncated literals, XYZE and invalid dimensions', () => {
  const prefix = radianceHeader('-Y 1 +X 8');
  const marker = Buffer.from([2, 2, 0, 8]);
  const channels = Buffer.from([136, 128, 136, 0, 136, 0, 136, 129]);
  const valid = decodeRGBE(Buffer.concat([prefix, marker, channels]));
  assert.equal(valid.width, 8);
  assert.ok(valid.data[0] > 0.9);

  assert.throws(() => decodeRGBE(Buffer.concat([prefix, marker, Buffer.from([136, 128, 136, 0, 136, 0, 136])])), /run value/);
  assert.throws(() => decodeRGBE(Buffer.concat([prefix, marker, Buffer.from([8, 1])])), /literal/);
  const xyzeHeader = radianceHeader('-Y 1 +X 1').toString('ascii').replace('32-bit_rle_rgbe', '32-bit_rle_xyze');
  assert.throws(() => decodeRGBE(Buffer.concat([Buffer.from(xyzeHeader), Buffer.from([1, 1, 1, 1])])), /XYZE/);
  assert.throws(() => decodeRGBE(radianceHeader('-Y 0 +X 1')), /dimensions/);
});

test('RGBE encoder declares Rec.709 and round-trips linear samples', () => {
  const image = decodeRGBE(encodeRGBE(1, 1, new Float32Array([1, 0, 0, 1])));
  assert.ok(Math.abs(image.data[0] - 1) < 0.01);
  assert.ok(Math.abs(image.data[1]) < 0.01);
  assert.ok(Math.abs(image.data[2]) < 0.01);
});

test('EXR validates channel layouts and converts supported grayscale/RGB payloads', () => {
  const gray = decodeEXR(makeExr([{ name: 'Y', value: 0 }], [0.25]));
  assert.deepEqual([...gray.data], [0.25, 0.25, 0.25, 1]);
  assert.equal(gray.alpha, 'opaque');
  assert.equal(gray.luminanceUnit, 'relative');

  const rgb = decodeEXR(makeExr([{ name: 'B' }, { name: 'G' }, { name: 'R' }], [0.5, 0.25, 1]));
  assert.deepEqual([...rgb.data], [1, 0.25, 0.5, 1]);
  assert.throws(() => decodeEXR(new Uint8Array([0, 1, 2, 3])), /too short|magic/);
  assert.throws(() => decodeEXR(makeExr([{ name: 'Y' }], [Number.NaN])), /NaN or Infinity/);
});

test('JXR grayscale maps one channel safely; unknown layouts and non-finite samples fail', () => {
  const gray = decodeJXRImage({
    width: 1,
    height: 1,
    pixelInfo: { channels: 1, colorFormat: 'Y', bitDepth: '8', bitsPerPixel: 8, hasAlpha: false, bgr: false },
    bytes: new Uint8Array([128]),
  });
  assert.ok(Math.abs(gray.data[0] - 0.2158605) < 0.00001);
  assert.deepEqual([...gray.data.slice(0, 3)], [gray.data[0], gray.data[0], gray.data[0]]);
  assert.equal(gray.data[3], 1);
  assert.equal(gray.sourceHDR, false);
  assert.match(gray.sourceColorAssumption, /sRGB transfer and Rec\.709 primaries/);

  assert.throws(() => decodeJXRImage({
    width: 1, height: 1,
    pixelInfo: { channels: 1, colorFormat: 'XYZ', bitDepth: '8', bitsPerPixel: 8, hasAlpha: false },
    bytes: new Uint8Array([1]),
  }), /format/);
  const floatBytes = new Uint8Array(12);
  new DataView(floatBytes.buffer).setFloat32(0, Number.NaN, true);
  assert.throws(() => decodeJXRImage({
    width: 1, height: 1,
    pixelInfo: { channels: 3, colorFormat: 'RGB', bitDepth: '32Float', bitsPerPixel: 96, hasAlpha: false },
    bytes: floatBytes,
  }), /NaN or Infinity/);
});

test('decodeImageBuffer reports worker-computed Rec.709 max luminance', async () => {
  const bytes = Buffer.concat([
    radianceHeader('-Y 1 +X 1'),
    Buffer.from([128, 128, 128, 129]),
  ]);
  const decoded = await decodeImageBuffer(bytes, 'luminance.hdr');
  assert.equal(decoded.colorSpace, 'linear-rec709');
  assert.ok(Math.abs(decoded.maxLuminance - 1) < 0.01);
});

test('JXR backend with unwritten alpha ignores heap contents and explicitly reports opaque output', () => {
  const values = [NaN, Infinity, -3, 8, 0];
  const floats = new Float32Array(values.flatMap(alpha => [0.25, 0.5, 4, alpha]));
  const image = {
    width: values.length, height: 1,
    pixelInfo: { channels: 4, colorFormat: 'RGB', bitDepth: '32Float', bitsPerPixel: 128, hasAlpha: true },
    bytes: new Uint8Array(floats.buffer)
  };
  const decoded = decodeJXRImage(image, { alphaDecoded: false });
  for (let i = 0; i < values.length; i++) {
    assert.deepEqual([...decoded.data.slice(i * 4, i * 4 + 4)], [0.25, 0.5, 4, 1]);
  }
  assert.equal(decoded.alpha, 'opaque');
  assert.equal(decoded.sourceAlphaDecoded, false);
  assert.ok(decoded.warnings.some(warning => /does not decode the alpha channel/.test(warning)));
  assert.throws(() => decodeJXRImage(image), /NaN or Infinity/);
  floats[0] = NaN;
  assert.throws(() => decodeJXRImage(image, { alphaDecoded: false }), /NaN or Infinity/);
});

test('JXR decoded alpha stays validated and a genuine zero-alpha pixel is preserved', () => {
  const floats = new Float32Array([0.25, 0.5, 4, 0]);
  const image = {
    width: 1, height: 1,
    pixelInfo: { channels: 4, colorFormat: 'RGB', bitDepth: '32Float', bitsPerPixel: 128, hasAlpha: true },
    bytes: new Uint8Array(floats.buffer)
  };
  assert.equal(decodeJXRImage(image).data[3], 0);
  floats[3] = 2;
  assert.throws(() => decodeJXRImage(image), /alpha outside/);
  image.pixelInfo.premultipliedAlpha = true;
  assert.throws(() => decodeJXRImage(image, { alphaDecoded: false }), /requires alpha decoding/);
});

test('aborted native bitmap fallback closes a bitmap that resolves after cancellation', async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  let resolveBitmap;
  let startedResolve;
  let closed = 0;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  globalThis.createImageBitmap = () => {
    startedResolve();
    return new Promise((resolve) => { resolveBitmap = resolve; });
  };
  const controller = new AbortController();
  try {
    const promise = decodeImageBuffer(new Uint8Array([1, 2, 3]), 'sample.png', {
      signal: controller.signal,
      type: 'image/png',
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    });
    await started;
    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    resolveBitmap({ width: 1, height: 1, close() { closed++; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(closed, 1);
  } finally {
    if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});

test('holdWorkOnAbort waits for native bitmap cleanup before settling its fallback', async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  let resolveBitmap;
  let startedResolve;
  let closed = 0;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  globalThis.createImageBitmap = () => {
    startedResolve();
    return new Promise((resolve) => { resolveBitmap = resolve; });
  };
  const controller = new AbortController();
  try {
    const promise = decodeImageBuffer(new Uint8Array([1, 2, 3]), 'sample.png', {
      signal: controller.signal,
      type: 'image/png',
      holdWorkOnAbort: true,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    });
    await started;
    controller.abort();
    let settled = false;
    promise.finally(() => { settled = true; }).catch(() => {});
    await Promise.resolve();
    assert.equal(settled, false);
    resolveBitmap({ width: 1, height: 1, close() { closed++; } });
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(closed, 1);
  } finally {
    if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});
