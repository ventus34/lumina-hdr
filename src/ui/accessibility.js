const byId = (id) => document.getElementById(id);

function announce(message) {
  const status = byId('a11y-viewer-status');
  if (status) status.textContent = message;
}

/** Synchronize alpha choices with a format that may not contain transparency. */
export function createAlphaModeSynchronizer(formatSelect, alphaSelect, note) {
  const preserveOption = alphaSelect.querySelector('option[value="preserve"]');
  let savedMode = alphaSelect.value;
  let supportsAlpha = true;

  return () => {
    const nextSupportsAlpha = !['jpeg', 'hdr'].includes(formatSelect.value);
    if (supportsAlpha && !nextSupportsAlpha) savedMode = alphaSelect.value;
    if (!supportsAlpha && nextSupportsAlpha) alphaSelect.value = savedMode;
    supportsAlpha = nextSupportsAlpha;
    if (preserveOption) preserveOption.disabled = !supportsAlpha;
    if (!supportsAlpha && alphaSelect.value === 'preserve') alphaSelect.value = 'flatten';

    note.hidden = supportsAlpha;
    if (supportsAlpha) alphaSelect.removeAttribute('aria-describedby');
    else alphaSelect.setAttribute('aria-describedby', note.id);
    note.textContent = alphaSelect.value === 'opaque'
      ? 'This format has no transparency. Pixel colors are kept and transparency is ignored.'
      : 'This format has no transparency. Transparent pixels are flattened on white.';
  };
}

/** Disable the original-pixels choice except for Radiance HDR output. */
export function createPixelModeSynchronizer(formatSelect, pixelModeSelect, group) {
  const originalOption = pixelModeSelect.querySelector('option[value="original"]');
  return () => {
    const radianceSelected = formatSelect.value === 'hdr';
    group.hidden = !radianceSelected;
    if (originalOption) originalOption.disabled = !radianceSelected;
    if (!radianceSelected) pixelModeSelect.value = 'processed';
  };
}

/**
 * Adds keyboard semantics and visible controls for interactions that otherwise
 * require pointer input. The main application handles `lumina:accessibility`
 * events on #canvas-container and may publish renderer state with
 * `lumina:viewport-state` on the same element.
 */
export function initAccessibility() {
  if (document.body.dataset.accessibilityInitialized === 'true') return;
  document.body.dataset.accessibilityInitialized = 'true';

  const tabs = [...document.querySelectorAll('.header-nav [role="tab"]')];
  const panels = tabs
    .map((tab) => byId(tab.getAttribute('aria-controls')))
    .filter(Boolean);

  const syncTabs = (selectedTab) => {
    tabs.forEach((tab) => {
      const selected = tab === selectedTab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      const selected = panel.id === selectedTab?.getAttribute('aria-controls');
      panel.setAttribute('aria-hidden', String(!selected));
    });
  };

  const activeTab = tabs.find((tab) => tab.classList.contains('active')) || tabs[0];
  if (activeTab) syncTabs(activeTab);

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => syncTabs(tab));
    tab.addEventListener('keydown', (event) => {
      let nextIndex;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;

      event.preventDefault();
      const nextTab = tabs[nextIndex];
      nextTab.focus();
      nextTab.click();
    });
  });

  const accordionPairs = [
    ['hdr-status-header', 'hdr-status-content'],
    ['hdr-instructions-toggle', 'hdr-instructions-content'],
    ['operator-info-header', 'operator-info-content'],
  ];

  accordionPairs.forEach(([triggerId, panelId]) => {
    const trigger = byId(triggerId);
    const panel = byId(panelId);
    if (!trigger || !panel) return;

    const syncAccordion = () => {
      const expanded = panel.style.display !== 'none';
      trigger.setAttribute('aria-expanded', String(expanded));
      panel.setAttribute('aria-hidden', String(!expanded));
    };

    trigger.setAttribute('aria-controls', panelId);
    syncAccordion();
    trigger.addEventListener('click', syncAccordion);
    new MutationObserver(syncAccordion).observe(panel, {
      attributes: true,
      attributeFilter: ['style'],
    });
  });

  const canvasContainer = byId('canvas-container');
  const canvas = byId('hdr-canvas');
  const previewModeSelect = byId('select-preview-mode');
  const splitControl = byId('viewer-split-control');
  const splitSlider = byId('a11y-split-position');
  const splitLabel = byId('a11y-split-label');
  const splitValue = byId('a11y-split-value');

  const dispatchAccessibilityAction = (detail, message) => {
    if (canvasContainer) {
      canvasContainer.dispatchEvent(new CustomEvent('lumina:accessibility', {
        bubbles: true,
        detail,
      }));
    }
    if (message) announce(message);
  };

  const setSplitControlState = (mode, value) => {
    if (!splitControl || !splitSlider) return;
    const horizontalSplit = mode === 'split-h';
    const isSplitMode = horizontalSplit || mode === 'split';
    splitControl.hidden = !isSplitMode;
    splitSlider.disabled = !isSplitMode;
    const label = horizontalSplit ? 'Top/bottom comparison position' : 'Left/right comparison position';
    splitLabel.textContent = label;
    splitSlider.setAttribute('aria-label', label);
    if (isSplitMode && Number.isFinite(value)) {
      const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
      splitSlider.value = String(percent);
      splitValue.value = `${percent}%`;
      splitValue.textContent = `${percent}%`;
    }
  };

  const syncSplitMode = () => setSplitControlState(previewModeSelect?.value || 'split');
  syncSplitMode();
  previewModeSelect?.addEventListener('change', syncSplitMode);

  splitSlider?.addEventListener('input', () => {
    const mode = previewModeSelect?.value || 'split';
    const axis = mode === 'split-h' ? 'y' : 'x';
    const value = Number(splitSlider.value) / 100;
    splitValue.value = `${splitSlider.value}%`;
    splitValue.textContent = `${splitSlider.value}%`;
    dispatchAccessibilityAction(
      { action: 'split', axis, value },
      `Comparison position ${splitSlider.value} percent`,
    );
  });

  canvasContainer?.addEventListener('lumina:viewport-state', (event) => {
    const state = event.detail || {};
    if (state.previewMode) {
      const splitValue = state.previewMode === 'split-h' ? state.splitY : state.splitX;
      setSplitControlState(state.previewMode, splitValue);
    }
    else if (Number.isFinite(state.splitX)) setSplitControlState(previewModeSelect?.value || 'split', state.splitX);
  });

  byId('a11y-zoom-in')?.addEventListener('click', () => {
    dispatchAccessibilityAction({ action: 'zoom', direction: 1 }, 'Zoom in');
  });
  byId('a11y-zoom-out')?.addEventListener('click', () => {
    dispatchAccessibilityAction({ action: 'zoom', direction: -1 }, 'Zoom out');
  });
  byId('a11y-reset-view')?.addEventListener('click', () => {
    dispatchAccessibilityAction({ action: 'reset' }, 'View reset');
  });

  const panActions = [
    ['a11y-pan-up', 0, -1],
    ['a11y-pan-down', 0, 1],
    ['a11y-pan-left', -1, 0],
    ['a11y-pan-right', 1, 0],
  ];
  panActions.forEach(([id, dx, dy]) => {
    byId(id)?.addEventListener('click', () => {
      dispatchAccessibilityAction({ action: 'pan', dx, dy }, `Move image ${id.replace('a11y-pan-', '')}`);
    });
  });

  canvas?.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      dispatchAccessibilityAction({ action: 'zoom', direction: 1 }, 'Zoom in');
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      dispatchAccessibilityAction({ action: 'zoom', direction: -1 }, 'Zoom out');
    } else if (event.key === 'Home' || event.key === '0') {
      event.preventDefault();
      dispatchAccessibilityAction({ action: 'reset' }, 'View reset');
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const direction = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      }[event.key];
      dispatchAccessibilityAction(
        { action: 'pan', dx: direction[0], dy: direction[1] },
        `Move image ${event.key.slice(5).toLowerCase()}`,
      );
    }
  });

  [
    ['select-export-format', 'select-export-pixel-mode', 'export-pixel-mode-group'],
    ['batch-select-export-format', 'batch-select-export-pixel-mode', 'batch-export-pixel-mode-group'],
  ].forEach(([formatId, pixelModeId, groupId]) => {
    const format = byId(formatId);
    const pixelMode = byId(pixelModeId);
    const group = byId(groupId);
    if (!format || !pixelMode || !group) return;
    const update = createPixelModeSynchronizer(format, pixelMode, group);
    update();
    format.addEventListener('change', update);
  });

  // RGBE and JPEG cannot store alpha. Keep the selected policy truthful and
  // restore the user's transparency preference when returning to PNG/WebP.
  [
    ['select-export-format', 'select-export-alpha-mode'],
    ['batch-select-export-format', 'batch-select-export-alpha-mode'],
  ].forEach(([formatId, alphaId]) => {
    const format = byId(formatId);
    const alpha = byId(alphaId);
    if (!format || !alpha) return;
    const note = document.createElement('p');
    note.id = `${alphaId}-note`;
    note.className = 'format-alpha-note';
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    note.setAttribute('aria-atomic', 'true');
    note.hidden = true;
    alpha.after(note);
    const update = createAlphaModeSynchronizer(format, alpha, note);
    format.addEventListener('change', update);
    alpha.addEventListener('change', update);
    update();
  });

  document.querySelectorAll('.gallery-count').forEach((count) => {
    count.setAttribute('role', 'status');
    count.setAttribute('aria-live', 'polite');
    count.setAttribute('aria-atomic', 'true');
  });

  const batchTableBody = byId('batch-table-body');
  if (batchTableBody) {
    const labelBatchRemoveButtons = () => {
      batchTableBody.querySelectorAll('.btn-remove-row').forEach((button) => {
        const filename = button.closest('tr')?.querySelector('td:nth-child(2)')?.textContent?.trim();
        button.setAttribute('aria-label', filename ? `Remove ${filename}` : 'Remove file');
      });
    };
    labelBatchRemoveButtons();
    new MutationObserver(labelBatchRemoveButtons).observe(batchTableBody, {
      childList: true,
      subtree: true,
    });
  }

  const batchProgress = byId('batch-percentage');
  if (batchProgress) {
    const syncBatchProgress = () => {
      const percentage = Number.parseFloat(batchProgress.textContent) || 0;
      const value = Math.max(0, Math.min(100, percentage));
      batchProgress.setAttribute('aria-valuenow', String(value));
      batchProgress.setAttribute('aria-valuetext', `${value}% complete`);
    };
    syncBatchProgress();
    new MutationObserver(syncBatchProgress).observe(batchProgress, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  const loadingOverlay = byId('loading-overlay');
  if (loadingOverlay) {
    const syncLoadingState = () => {
      loadingOverlay.setAttribute('aria-hidden', String(!loadingOverlay.classList.contains('active')));
    };
    syncLoadingState();
    new MutationObserver(syncLoadingState).observe(loadingOverlay, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  const addButtonKeyboardSupport = (element) => {
    if (element.dataset.keyboardClickBound) return;
    element.dataset.keyboardClickBound = 'true';
    element.addEventListener('keydown', (event) => {
      if (event.target !== element || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      element.click();
    });
  };

  document.querySelectorAll('[role="button"]').forEach((element) => {
    if (element.tagName !== 'BUTTON') addButtonKeyboardSupport(element);
  });

  const galleryTrack = byId('gallery-track');
  const syncGalleryThumbnails = () => {
    if (!galleryTrack) return;
    const thumbnails = [...galleryTrack.querySelectorAll('.gallery-thumb-item')];
    thumbnails.forEach((thumbnail, index) => {
      const name = thumbnail.querySelector('.gallery-thumb-name')?.textContent?.trim() || `image ${index + 1}`;
      thumbnail.setAttribute('role', 'button');
      thumbnail.setAttribute('aria-label', `Open image ${name}`);
      thumbnail.setAttribute('aria-pressed', String(thumbnail.classList.contains('active')));
      thumbnail.tabIndex = thumbnail.classList.contains('active') || index === 0 ? 0 : -1;
      addButtonKeyboardSupport(thumbnail);
      if (thumbnail.dataset.keyboardNavigationBound) return;
      thumbnail.dataset.keyboardNavigationBound = 'true';
      thumbnail.addEventListener('keydown', (event) => {
        let nextIndex;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = index + 1;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = index - 1;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = thumbnails.length - 1;
        else return;

        event.preventDefault();
        const next = thumbnails[Math.max(0, Math.min(thumbnails.length - 1, nextIndex))];
        next?.focus();
        next?.click();
      });
    });
  };

  if (galleryTrack) {
    syncGalleryThumbnails();
    new MutationObserver(syncGalleryThumbnails).observe(galleryTrack, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  const hideDecorativeIcons = (root) => {
    if (root.matches?.('svg') && !root.hasAttribute('aria-label') && !root.querySelector('title')) {
      root.setAttribute('aria-hidden', 'true');
      root.setAttribute('focusable', 'false');
    }
    root.querySelectorAll?.('svg').forEach((icon) => {
      if (!icon.hasAttribute('aria-label') && !icon.querySelector('title')) {
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('focusable', 'false');
      }
    });
  };
  hideDecorativeIcons(document);
  new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) hideDecorativeIcons(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });
}
