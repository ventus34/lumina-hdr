#!/usr/bin/env node

// Reproducible codec microbenchmark over real repository JXR fixtures.
// This reports Node codec timings only; it does not infer browser worker or
// HDR-display performance from a server-side run.
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodeJXR } from '../src/decoders/jxr.js';
import { encodeRGBE } from '../src/decoders/rgbe.js';

const defaultFixtures = [
  'docs/examples/Forza_Horizon_6_native_hdr_scene2.jxr'
];
const fixturePaths = (process.argv.length > 2 ? process.argv.slice(2) : defaultFixtures).map((path) => resolve(path));
for (const path of fixturePaths) {
  const encoded = await readFile(path);
  const start = performance.now();
  const decoded = await decodeJXR(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
  const decodeMs = performance.now() - start;
  const encodeStart = performance.now();
  const rgbe = encodeRGBE(decoded.width, decoded.height, decoded.data);
  const encodeMs = performance.now() - encodeStart;
  const megapixels = (decoded.width * decoded.height) / 1_000_000;

  console.log(JSON.stringify({
    fixture: basename(path),
    encodedBytes: encoded.byteLength,
    width: decoded.width,
    height: decoded.height,
    megapixels: Number(megapixels.toFixed(2)),
    decodedBytes: decoded.data.byteLength,
    decodeMs: Number(decodeMs.toFixed(1)),
    encodeRGBEMs: Number(encodeMs.toFixed(1)),
    decodeMegapixelsPerSecond: Number((megapixels / (decodeMs / 1000)).toFixed(2)),
    encodeMegapixelsPerSecond: Number((megapixels / (encodeMs / 1000)).toFixed(2)),
    rgbeBytes: rgbe.byteLength
  }));
}

console.log('Node-only timings; run in a target browser with its own benchmark harness for worker and display behavior.');
