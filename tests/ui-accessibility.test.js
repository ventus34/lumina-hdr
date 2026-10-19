import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createAlphaModeSynchronizer,
  createPixelModeSynchronizer,
} from '../src/ui/accessibility.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/main.css', import.meta.url), 'utf8');

function fakeAlphaSelect(value = 'preserve') {
  const preserveOption = { disabled: false };
  const attributes = new Map();
  return {
    value,
    preserveOption,
    attributes,
    querySelector(selector) {
      return selector === 'option[value="preserve"]' ? preserveOption : null;
    },
    setAttribute(name, attributeValue) { attributes.set(name, attributeValue); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

function fakePixelModeSelect(value = 'processed') {
  const originalOption = { disabled: false };
  return {
    value,
    originalOption,
    querySelector(selector) {
      return selector === 'option[value="original"]' ? originalOption : null;
    },
  };
}

test('JPEG and RGBE replace Preserve with Flatten and explain the limitation accessibly', () => {
  for (const formatName of ['jpeg', 'hdr']) {
    const format = { value: formatName };
    const alpha = fakeAlphaSelect();
    const note = { id: `alpha-note-${formatName}`, hidden: true, textContent: '' };
    const sync = createAlphaModeSynchronizer(format, alpha, note);

    sync();

    assert.equal(alpha.preserveOption.disabled, true);
    assert.equal(alpha.value, 'flatten');
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /flattened on white/);
    assert.equal(alpha.attributes.get('aria-describedby'), note.id);

    format.value = 'png';
    sync();
    assert.equal(alpha.preserveOption.disabled, false);
    assert.equal(alpha.value, 'preserve', 'restore the saved alpha choice on a supporting format');
    assert.equal(note.hidden, true);
    assert.equal(alpha.attributes.has('aria-describedby'), false, 'do not expose the hidden format note as a stale description');
  }
});

test('opaque alpha preference remains selected and gets a distinct format note', () => {
  const format = { value: 'jpeg' };
  const alpha = fakeAlphaSelect('opaque');
  const note = { id: 'alpha-note', hidden: true, textContent: '' };
  const sync = createAlphaModeSynchronizer(format, alpha, note);

  sync();
  assert.equal(alpha.value, 'opaque');
  assert.match(note.textContent, /Pixel colors are kept/);

  format.value = 'webp';
  sync();
  assert.equal(alpha.value, 'opaque', 'restore the prior opaque preference when alpha is supported again');
});

test('original pixel values are available only for Radiance HDR', () => {
  const format = { value: 'hdr' };
  const pixelMode = fakePixelModeSelect('original');
  const group = { hidden: true };
  const sync = createPixelModeSynchronizer(format, pixelMode, group);

  sync();
  assert.equal(group.hidden, false);
  assert.equal(pixelMode.originalOption.disabled, false);
  assert.equal(pixelMode.value, 'original');

  format.value = 'jpeg';
  sync();
  assert.equal(group.hidden, true);
  assert.equal(pixelMode.originalOption.disabled, true);
  assert.equal(pixelMode.value, 'processed', 'never leave a hidden original-pixel choice active');
});

test('viewer interactions, tabs, and accordions have keyboard and screen-reader hooks', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const idSet = new Set(ids);
  assert.equal(idSet.size, ids.length, 'static document IDs must be unique');
  for (const attribute of ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby']) {
    for (const reference of html.matchAll(new RegExp(`\\b${attribute}="([^"]+)"`, 'g'))) {
      for (const id of reference[1].split(/\s+/)) assert.ok(idSet.has(id), `${attribute} references missing #${id}`);
    }
  }
  assert.match(html, /role="tablist"/);
  assert.match(html, /id="btn-tab-viewer"[^>]*role="tab"[^>]*aria-selected="true"/);
  assert.match(html, /id="view-viewer"[^>]*role="tabpanel"[^>]*aria-hidden="false"/);
  assert.match(html, /id="hdr-status-header"[^>]*aria-expanded="false"[^>]*aria-controls="hdr-status-content"/);
  assert.match(html, /id="hdr-instructions-toggle"[^>]*aria-controls="hdr-instructions-content"/);
  assert.match(html, /<details id="viewer-accessible-controls"[\s\S]*?<summary>Viewer controls<\/summary>/);
  for (const id of ['a11y-zoom-in', 'a11y-zoom-out', 'a11y-pan-up', 'a11y-pan-down', 'a11y-pan-left', 'a11y-pan-right', 'a11y-split-position']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="toast"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('export labels describe PNG precision containers and Radiance RGBE accurately', () => {
  const tenBitOptions = html.match(/<option value="png10[^"]*">([^<]*)<\/option>/g) || [];
  const twelveBitOptions = html.match(/<option value="png12[^"]*">([^<]*)<\/option>/g) || [];
  assert.equal(tenBitOptions.length, 8);
  assert.equal(twelveBitOptions.length, 8);
  assert.ok(tenBitOptions.every((option) => option.includes('16-bit container')));
  assert.ok(twelveBitOptions.every((option) => option.includes('16-bit container')));
  assert.equal((html.match(/Radiance HDR \(RGBE, HDR\)/g) || []).length, 2);
  assert.doesNotMatch(html, /Radiance HDR[^<]*32-bit Float/);
  for (const id of ['select-export-alpha-mode', 'batch-select-export-alpha-mode', 'select-export-pixel-mode', 'batch-select-export-pixel-mode']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('portable styling avoids a font service and supports small screens and reduced motion', () => {
  assert.doesNotMatch(css, /@import\s+url\(['"]?https?:\/\//i);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /100dvh/);
});
