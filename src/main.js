import JSZip from 'jszip';
import './main.css';
import { WebGLRenderer } from './renderer.js';
import { decodeRGBE, encodeRGBE } from './decoders/rgbe.js';
import { decodeEXR } from './decoders/exr.js';
import { decodeJXR } from './decoders/jxr.js';
import { generateSyntheticHDR } from './synthetic.js';
import { encodePNG } from './decoders/png-encoder.js';
import { decodeAVIF } from './decoders/avif.js';

const OPERATOR_DETAILS = {
  0: { // Linear
    name: 'Linear / Clamp',
    desc: 'Direct mapping without color compression. Raw floating-point values above 1.0 (80 nits) are simply clipped to white. Provides a baseline to visualize uncompressed HDR data.',
    char: 'No highlight compression, direct clipping',
    usage: 'Scientific analysis, baseline calibration'
  },
  1: { // Reinhard
    name: 'Reinhard',
    desc: 'A classic, mathematically soft compression that scales color values based on the maximum luminance. It gently compresses highlight intensities to avoid harsh clipping, but can result in slightly desaturated colors in very bright areas.',
    char: 'Soft highlight compression, mild desaturation',
    usage: 'Red Dead Redemption 2'
  },
  2: { // ACES Filmic
    name: 'ACES Filmic',
    desc: 'The Academy Color Encoding System standard. It applies a high-contrast cinematic S-curve that preserves rich, vibrant colors and provides a natural, smooth roll-off in bright highlights. It is the industry standard for modern films and AAA games.',
    char: 'High contrast, cinematic S-curve, natural roll-off',
    usage: 'Cyberpunk 2077, Spider-Man'
  },
  3: { // Hable
    name: 'Hable',
    desc: 'Developed by John Hable for Uncharted 2. It offers precise control over dark shadows (toe) and bright highlights (shoulder). This creates a gritty, highly realistic, and punchy cinematic look.',
    char: 'Excellent shadow and highlight control, gritty tone',
    usage: 'Uncharted 2'
  },
  4: { // Lottes Filmic
    name: 'Lottes Filmic',
    desc: 'Developed by Timothy Lottes (AMD). A highly customizable film-simulation curve designed to replicate the response of analog film cameras, delivering sharp contrast, rich mids, and excellent high-luminance roll-off.',
    char: 'Analog film simulation, sharp contrast',
    usage: 'Doom Eternal, Gears of War 5'
  },
  5: { // Uchimura
    name: 'Uchimura',
    desc: 'Developed by Hajime Uchimura for Gran Turismo Sport. A reference-grade tone mapper designed to maintain exceptional detail in both extreme dark and extreme bright areas of high-contrast scenes without desaturating colors.',
    char: 'High color accuracy, reference-grade gradients',
    usage: 'Gran Turismo 7'
  }
};

// Application State
let renderer = null;
let currentImage = {
  name: '',
  width: 0,
  height: 0,
  data: null, // Float32Array (RGBA)
  isHDR: false,
  maxLuminance: 1.0 // Store the raw Rec. 709 max luminance of the image
};
let cachedHdrToneMapper = null;

// Histogram Options and Cache State
const histogramState = {
  expanded: false,
  channel: 'all', // 'all', 'lum', 'r', 'g', 'b'
  scale: 'log',   // 'log', 'linear'
  hoverX: null,
  hoverY: null
};
let cachedHistogram = null;

const renderOptions = {
  exposure: 0.0,
  gamma: 2.2,
  contrast: 1.0,
  sdrBoost: 1.0,
  toneMapper: 2, // Default: ACES
  activeSplitX: 0.5,   // Default: Middle split
  activeSplitY: 0.5,   // Default: Middle split
  sdrWhite: 200.0,      // Default SDR Reference White: 200 nits
  targetPeak: 1000.0,   // Default Target Peak: 1000 nits
  autoExposureCorrect: true,
  previewMode: 'split',
  nativeHdr: false,
  blendOpacity: 50.0,   // Default: 50%
  heatmap: false,
  clippingWarning: false,
  smartUpmix: true,
  saturation: 1.0,
  highlights: 0.0,
  shadows: 0.0,
  temp: 0.0,
  tint: 0.0
};



// Interactive controls state
let isDraggingDivider = false;
let isPanning = false;
let startPanX = 0;
let startPanY = 0;
let startMouseX = 0;
let startMouseY = 0;

// Batch files queue
let batchFiles = [];
let isBatchProcessing = false;

// DOM Elements
const el = {
  tabViewer: document.getElementById('tab-viewer'),
  tabBatch: document.getElementById('tab-batch'),
  viewViewer: document.getElementById('view-viewer'),
  viewBatch: document.getElementById('view-batch'),
  btnSynthetic: document.getElementById('btn-synthetic'),
  selectSyntheticPattern: document.getElementById('select-synthetic-pattern'),
  
  // File inputs
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),

  // Example Scenes
  selectExampleScene: document.getElementById('select-example-scene'),
  exampleDetails: document.getElementById('example-details'),
  exampleGameTitle: document.getElementById('example-game-title'),
  exampleGameDesc: document.getElementById('example-game-desc'),
  exampleGameTags: document.getElementById('example-game-tags'),
  
  // Metadata
  metaEmpty: document.getElementById('metadata-empty'),
  metaDetails: document.getElementById('metadata-details'),
  metaName: document.getElementById('meta-name'),
  metaFormat: document.getElementById('meta-format'),
  metaResolution: document.getElementById('meta-resolution'),
  metaDepth: document.getElementById('meta-depth'),
  metaChannels: document.getElementById('meta-channels'),
  metaPeakNits: document.getElementById('meta-peak-nits'),
  
  // Sliders & Controls
  selectOperator: document.getElementById('select-operator'),
  operatorInfoCard: document.getElementById('operator-info-card'),
  operatorInfoChevron: document.getElementById('operator-info-chevron'),
  operatorInfoContent: document.getElementById('operator-info-content'),
  operatorInfoName: document.getElementById('operator-info-name'),
  operatorInfoDesc: document.getElementById('operator-info-desc'),
  operatorInfoChar: document.getElementById('operator-info-char'),
  operatorInfoUsage: document.getElementById('operator-info-usage'),
  sliderExposure: document.getElementById('slider-exposure'),
  valExposure: document.getElementById('val-exposure'),
  sliderGamma: document.getElementById('slider-gamma'),
  valGamma: document.getElementById('val-gamma'),
  sliderContrast: document.getElementById('slider-contrast'),
  valContrast: document.getElementById('val-contrast'),
  sliderSdrBoost: document.getElementById('slider-sdr-boost'),
  valSdrBoost: document.getElementById('val-sdr-boost'),
  checkboxSmartUpmix: document.getElementById('checkbox-smart-upmix'),
  groupSmartUpmix: document.getElementById('group-smart-upmix'),
  groupSdrBoost: document.getElementById('group-sdr-boost'),

  // HDR Calibration controls
  selectSdrWhite: document.getElementById('select-sdr-white'),
  groupCustomSdrWhite: document.getElementById('group-custom-sdr-white'),
  sliderSdrWhite: document.getElementById('slider-sdr-white'),
  valSdrWhite: document.getElementById('val-sdr-white'),
  selectTargetPeak: document.getElementById('select-target-peak'),
  groupCustomTargetPeak: document.getElementById('group-custom-target-peak'),
  sliderTargetPeak: document.getElementById('slider-target-peak'),
  valTargetPeak: document.getElementById('val-target-peak'),
  checkboxAutoExposure: document.getElementById('checkbox-auto-exposure'),
  
  // Display Mode
  selectPreviewMode: document.getElementById('select-preview-mode'),
  groupBlendOpacity: document.getElementById('group-blend-opacity'),
  sliderBlendOpacity: document.getElementById('slider-blend-opacity'),
  valBlendOpacity: document.getElementById('val-blend-opacity'),
  checkboxNativeHdr: document.getElementById('checkbox-native-hdr'),
  nativeHdrHelp: document.getElementById('native-hdr-help'),
  hdrApiStatus: document.getElementById('hdr-api-status'),
  hdrDisplayStatus: document.getElementById('hdr-display-status'),
  hdrActiveModeStatus: document.getElementById('hdr-active-mode-status'),
  hdrInstructionsToggle: document.getElementById('hdr-instructions-toggle'),
  hdrInstructionsContent: document.getElementById('hdr-instructions-content'),
  hdrStatusHeader: document.getElementById('hdr-status-header'),
  hdrStatusContent: document.getElementById('hdr-status-content'),
  hdrStatusChevron: document.getElementById('hdr-status-chevron'),
  
  // Visualizations
  checkboxHeatmap: document.getElementById('checkbox-heatmap'),
  checkboxClipping: document.getElementById('checkbox-clipping'),

  // Color Grading
  sliderSaturation: document.getElementById('slider-saturation'),
  valSaturation: document.getElementById('val-saturation'),
  sliderHighlights: document.getElementById('slider-highlights'),
  valHighlights: document.getElementById('val-highlights'),
  sliderShadows: document.getElementById('slider-shadows'),
  valShadows: document.getElementById('val-shadows'),
  sliderColorTemp: document.getElementById('slider-color-temp'),
  valColorTemp: document.getElementById('val-color-temp'),
  sliderColorTint: document.getElementById('slider-color-tint'),
  valColorTint: document.getElementById('val-color-tint'),
  
  // Export
  selectExportFormat: document.getElementById('select-export-format'),
  jpegQualityGroup: document.getElementById('jpeg-quality-group'),
  sliderJpegQuality: document.getElementById('slider-jpeg-quality'),
  valJpegQuality: document.getElementById('val-jpeg-quality'),
  btnExport: document.getElementById('btn-export'),
  btnReset: document.getElementById('btn-reset'),
  
  // Viewport overlays
  canvasContainer: document.getElementById('canvas-container'),
  canvas: document.getElementById('hdr-canvas'),
  splitInstructions: document.querySelector('.split-instructions'),
  viewportLabelLeft: document.getElementById('viewport-label-left'),
  viewportLabelRight: document.getElementById('viewport-label-right'),
  pixelHud: document.getElementById('pixel-hud'),
  hudSwatch: document.getElementById('hud-swatch'),
  hudPos: document.getElementById('hud-pos'),
  hudNits: document.getElementById('hud-nits'),
  hudRawRgb: document.getElementById('hud-raw-rgb'),
  hudSdrRgb: document.getElementById('hud-sdr-rgb'),
  histogramOverlay: document.getElementById('histogram-overlay'),
  btnHistogramExpand: document.getElementById('btn-histogram-expand'),
  histogramControls: document.getElementById('histogram-controls'),
  histogramTooltip: document.getElementById('histogram-tooltip'),
  histogramTitle: document.getElementById('histogram-title'),
  histogramCanvas: document.getElementById('histogram-canvas'),
  loadingOverlay: document.getElementById('loading-overlay'),
  loadingText: document.getElementById('loading-text'),
  toast: document.getElementById('toast'),
  
  // Batch Panel elements
  batchDropzone: document.getElementById('batch-dropzone'),
  batchFileInput: document.getElementById('batch-file-input'),
  batchEmptyState: document.getElementById('batch-empty-state'),
  batchFilesList: document.getElementById('batch-files-list'),
  batchSelectOperator: document.getElementById('batch-select-operator'),
  batchSelectFormat: document.getElementById('batch-select-format'),
  batchProgress: document.getElementById('batch-progress'),
  batchProgressLabel: document.getElementById('batch-progress-label'),
  batchProgressPercent: document.getElementById('batch-progress-percent'),
  batchProgressBar: document.getElementById('batch-progress-bar'),
  btnBatchClear: document.getElementById('btn-batch-clear'),
  btnBatchStart: document.getElementById('btn-batch-start')
};

// HDR Calibration helpers
function updateToneMapWhite() {
  renderOptions.toneMapWhite = renderOptions.targetPeak / renderOptions.sdrWhite;
}

function calculateMaxLuminance(data) {
  if (!data) return 1.0;
  let maxLum = 0.0;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (isNaN(lum) || !isFinite(lum)) continue;
    if (lum > maxLum) {
      maxLum = lum;
    }
  }
  return maxLum > 0.0 ? maxLum : 1.0;
}

function updateMetadataDisplay() {
  if (!currentImage.data) return;
  const peakNits = currentImage.maxLuminance * renderOptions.sdrWhite;
  const absNits = currentImage.maxLuminance * 80.0;
  
  el.metaPeakNits.innerHTML = `
    <strong>${peakNits.toFixed(0)} nits</strong> (at SDR white = ${renderOptions.sdrWhite} nits)<br/>
    <span style="font-size: 11px; opacity: 0.7; display: block; margin-top: 2px;">
      Absolute in file: ${absNits.toFixed(0)} nits (scRGB 1.0 = 80 nits)
    </span>
  `;
}

function updateOperatorInfoCard(toneMapperId) {
  const details = OPERATOR_DETAILS[toneMapperId];
  if (!details) return;
  
  el.operatorInfoName.textContent = details.name;
  el.operatorInfoDesc.textContent = details.desc;
  el.operatorInfoChar.textContent = details.char;
  el.operatorInfoUsage.textContent = details.usage;
}

// Example scenes dynamic loading variables and functions
let exampleScenes = [];
const EXAMPLES_BASE_PATH = import.meta.env.DEV ? 'docs/examples/' : 'examples/';

async function loadExampleScenesList() {
  try {
    const res = await fetch(`${EXAMPLES_BASE_PATH}examples.json`);
    if (!res.ok) throw new Error('Failed to fetch examples list');
    exampleScenes = await res.json();
    populateExamplesDropdown();
  } catch (err) {
    console.error('Error loading example scenes:', err);
    if (el.selectExampleScene) {
      el.selectExampleScene.innerHTML = '<option value="" disabled selected>Error loading examples</option>';
    }
  }
}

function populateExamplesDropdown() {
  if (!el.selectExampleScene) return;
  
  el.selectExampleScene.innerHTML = '<option value="" disabled selected>Select an example game scene...</option>';
  
  exampleScenes.forEach((scene, index) => {
    const opt = document.createElement('option');
    opt.value = index;
    opt.textContent = `${scene.game} - ${scene.name.split(' - ').pop()}`;
    el.selectExampleScene.appendChild(opt);
  });
}

function loadExampleScene(index) {
  const scene = exampleScenes[index];
  if (!scene) return;

  if (el.exampleGameTitle) el.exampleGameTitle.textContent = scene.game;
  if (el.exampleGameDesc) {
    el.exampleGameDesc.textContent = `Source: ${scene.source} | ${scene.filename.split('_').pop().replace(/\.[^/.]+$/, "")}`;
  }
  
  if (el.exampleGameTags) {
    el.exampleGameTags.innerHTML = '';
    scene.tags.forEach(tag => {
      const pill = document.createElement('span');
      pill.className = `example-tag tag-${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      pill.textContent = tag;
      el.exampleGameTags.appendChild(pill);
    });
  }

  if (el.exampleDetails) el.exampleDetails.style.display = 'flex';

  const fileUrl = `${EXAMPLES_BASE_PATH}${scene.filename}`;
  showLoading(`Fetching and decoding example scene: ${scene.name}...`);

  setTimeout(async () => {
    try {
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`HTTP error fetching example image: ${res.status}`);
      
      const arrayBuffer = await res.arrayBuffer();
      const ext = scene.filename.split('.').pop().toLowerCase();
      let decoded = null;
      let formatName = '';
      let depthName = '32-bit Float';
      let isHDR = true;

      const blob = new Blob([arrayBuffer], { type: ext === 'avif' ? 'image/avif' : 'image/jxr' });

      if (ext === 'jxr' || ext === 'wdp') {
        decoded = await decodeJXR(arrayBuffer);
        formatName = 'JPEG XR (.jxr)';
        depthName = 'Half/Full Float (HDR)';
      } else if (ext === 'exr') {
        decoded = decodeEXR(arrayBuffer);
        formatName = 'OpenEXR (.exr)';
      } else if (ext === 'hdr') {
        decoded = decodeRGBE(arrayBuffer);
        formatName = 'Radiance HDR (.hdr)';
      } else if (ext === 'avif') {
        decoded = await decodeAVIF(arrayBuffer, blob);
        formatName = decoded.isHDR ? 'AVIF (HDR)' : 'AVIF (SDR)';
        depthName = decoded.isHDR ? '10-bit PQ/HLG (HDR)' : '8-bit Integer (SDR)';
        isHDR = decoded.isHDR;
      } else {
        decoded = await decodeStandardImage(blob);
        formatName = 'SDR Image (Standard)';
        depthName = '8-bit Integer (SDR)';
        isHDR = false;
      }

      currentImage = {
        name: scene.filename,
        width: decoded.width,
        height: decoded.height,
        data: decoded.data,
        isHDR: isHDR,
        maxLuminance: calculateMaxLuminance(decoded.data)
      };

      renderer.setImage(currentImage.width, currentImage.height, currentImage.data);
      updateMetadata(currentImage.name, formatName, currentImage.width, currentImage.height, depthName, 4);
      updateMetadataDisplay();

      toggleSdrExclusiveControls(isHDR);
      if (isHDR) {
        renderOptions.sdrBoost = 1.0;
      } else {
        showToast('SDR file loaded. You can use the "SDR Boost" slider to artificially expand dynamic range.');
      }

      requestRender();
      showToast(`Loaded example scene: ${scene.name}`);
    } catch (err) {
      showToast(`Error loading example: ${err.message}`, 'error');
      console.error(err);
    } finally {
      hideLoading();
    }
  }, 50);
}

// Initialize Application
function init() {
  // Set up WebGL2 Renderer
  try {
    renderer = new WebGLRenderer(el.canvas);
  } catch (err) {
    showToast(err.message, 'error');
    console.error(err);
    return;
  }

  setupEventListeners();
  updateToneMapWhite();
  updateOperatorInfoCard(renderOptions.toneMapper);
  
  // Load synthetic HDR by default on startup
  loadSyntheticImage();
  initHdrCapabilityDetection();
  loadExampleScenesList();
  hideLoading();
}

function initHdrCapabilityDetection() {
  // 1. Detect WebGL color space support (API)
  const isApiSupported = renderer && renderer.gl && ('drawingBufferColorSpace' in renderer.gl);
  if (isApiSupported) {
    el.hdrApiStatus.textContent = 'Supported';
    el.hdrApiStatus.className = 'status-badge status-supported';
  } else {
    el.hdrApiStatus.textContent = 'Unsupported';
    el.hdrApiStatus.className = 'status-badge status-unsupported';
  }

  // 2. Detect Display HDR Capability (OS & Hardware)
  const hdrMedia = window.matchMedia('(dynamic-range: high)');
  const updateDisplayStatus = (matches) => {
    if (matches) {
      el.hdrDisplayStatus.textContent = 'HDR Active';
      el.hdrDisplayStatus.className = 'status-badge status-hdr';
    } else {
      el.hdrDisplayStatus.textContent = 'SDR Only';
      el.hdrDisplayStatus.className = 'status-badge status-sdr';
    }
  };

  updateDisplayStatus(hdrMedia.matches);
  
  // Dynamic changes listener
  try {
    hdrMedia.addEventListener('change', (e) => updateDisplayStatus(e.matches));
  } catch (err) {
    // Fallback for older browsers
    hdrMedia.addListener((e) => updateDisplayStatus(e.matches));
  }

  // 3. Setup Instructions Toggle Accordion
  el.hdrInstructionsToggle.addEventListener('click', () => {
    const isCollapsed = el.hdrInstructionsContent.style.display === 'none';
    if (isCollapsed) {
      el.hdrInstructionsContent.style.display = 'block';
      el.hdrInstructionsToggle.classList.add('open');
    } else {
      el.hdrInstructionsContent.style.display = 'none';
      el.hdrInstructionsToggle.classList.remove('open');
    }
  });

  // 4. Setup Main Card Toggle Accordion
  el.hdrStatusHeader.addEventListener('click', () => {
    const isCollapsed = el.hdrStatusContent.style.display === 'none';
    if (isCollapsed) {
      el.hdrStatusContent.style.display = 'flex';
      el.hdrStatusChevron.style.transform = 'rotate(180deg)';
    } else {
      el.hdrStatusContent.style.display = 'none';
      el.hdrStatusChevron.style.transform = 'rotate(0deg)';
    }
  });

  // 5. Setup Operator Info Card Toggle Accordion
  el.operatorInfoCard.querySelector('.operator-info-header').addEventListener('click', () => {
    const isCollapsed = el.operatorInfoContent.style.display === 'none';
    if (isCollapsed) {
      el.operatorInfoContent.style.display = 'flex';
      el.operatorInfoChevron.style.transform = 'rotate(180deg)';
    } else {
      el.operatorInfoContent.style.display = 'none';
      el.operatorInfoChevron.style.transform = 'rotate(0deg)';
    }
  });

  // Update initial active mode label
  updateActiveModeLabel(renderOptions.nativeHdr);
}

function updateActiveModeLabel(isNativeHdr) {
  if (isNativeHdr) {
    el.hdrActiveModeStatus.textContent = 'Native HDR';
    el.hdrActiveModeStatus.className = 'status-badge status-hdr';
  } else {
    el.hdrActiveModeStatus.textContent = 'SDR Mode';
    el.hdrActiveModeStatus.className = 'status-badge status-sdr';
  }
}

// Event Listeners Configuration
function setupEventListeners() {
  // Tabs
  el.tabViewer.addEventListener('click', () => switchTab('viewer'));
  el.tabBatch.addEventListener('click', () => switchTab('batch'));

  // Synthetic Button
  el.btnSynthetic.addEventListener('click', loadSyntheticImage);

  // File Upload (Single Viewer)
  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => handleSingleFile(e.target.files[0]));
  
  setupDragAndDrop(el.dropzone, (file) => handleSingleFile(file));

  // Controls (Sliders & Selector)
  el.selectOperator.addEventListener('change', (e) => {
    renderOptions.toneMapper = parseInt(e.target.value, 10);
    updateOperatorInfoCard(renderOptions.toneMapper);
    requestRender();
  });

  el.sliderExposure.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.exposure = val;
    el.valExposure.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
    requestRender();
  });

  el.sliderGamma.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.gamma = val;
    el.valGamma.textContent = val.toFixed(2);
    requestRender();
  });

  el.sliderContrast.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.contrast = val;
    el.valContrast.textContent = val.toFixed(2);
    requestRender();
  });

  el.sliderSdrBoost.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.sdrBoost = val;
    el.valSdrBoost.textContent = `${val.toFixed(2)}x`;
    requestRender();
  });

  // HDR Calibration Events
  el.selectSdrWhite.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'custom') {
      el.groupCustomSdrWhite.style.display = 'block';
      renderOptions.sdrWhite = parseFloat(el.sliderSdrWhite.value);
    } else {
      el.groupCustomSdrWhite.style.display = 'none';
      renderOptions.sdrWhite = parseFloat(val);
      el.sliderSdrWhite.value = val;
      el.valSdrWhite.textContent = `${val} nit`;
    }
    updateToneMapWhite();
    updateMetadataDisplay();
    requestRender();
  });

  el.sliderSdrWhite.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.sdrWhite = val;
    el.valSdrWhite.textContent = `${val} nit`;
    updateToneMapWhite();
    updateMetadataDisplay();
    requestRender();
  });

  el.selectTargetPeak.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'custom') {
      el.groupCustomTargetPeak.style.display = 'block';
      renderOptions.targetPeak = parseFloat(el.sliderTargetPeak.value);
    } else {
      el.groupCustomTargetPeak.style.display = 'none';
      renderOptions.targetPeak = parseFloat(val);
      el.sliderTargetPeak.value = val;
      el.valTargetPeak.textContent = `${val} nit`;
    }
    updateToneMapWhite();
    requestRender();
  });

  el.sliderTargetPeak.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.targetPeak = val;
    el.valTargetPeak.textContent = `${val} nit`;
    updateToneMapWhite();
    requestRender();
  });

  el.checkboxAutoExposure.addEventListener('change', (e) => {
    renderOptions.autoExposureCorrect = e.target.checked;
    requestRender();
  });

  el.selectPreviewMode.addEventListener('change', (e) => {
    renderOptions.previewMode = e.target.value;
    if (renderOptions.previewMode === 'split' || renderOptions.previewMode === 'split-h') {
      el.canvas.style.cursor = 'grab';
    } else {
      el.canvas.style.cursor = 'default';
    }
    if (renderOptions.previewMode === 'blend') {
      el.groupBlendOpacity.style.display = 'block';
    } else {
      el.groupBlendOpacity.style.display = 'none';
    }
    requestRender();
  });

  // Smart SDR-to-HDR Upmix Checkbox
  el.checkboxSmartUpmix.addEventListener('change', (e) => {
    renderOptions.smartUpmix = e.target.checked;
    requestRender();
  });

  // Visualization Checkboxes
  el.checkboxHeatmap.addEventListener('change', (e) => {
    renderOptions.heatmap = e.target.checked;
    if (renderOptions.heatmap) {
      el.checkboxClipping.checked = false;
      renderOptions.clippingWarning = false;
    }
    requestRender();
  });

  el.checkboxClipping.addEventListener('change', (e) => {
    renderOptions.clippingWarning = e.target.checked;
    if (renderOptions.clippingWarning) {
      el.checkboxHeatmap.checked = false;
      renderOptions.heatmap = false;
    }
    requestRender();
  });

  // Blend Opacity Slider
  el.sliderBlendOpacity.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    renderOptions.blendOpacity = val;
    el.valBlendOpacity.textContent = `${val}%`;
    requestRender();
  });

  // Color Grading Sliders
  el.sliderSaturation.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.saturation = val;
    el.valSaturation.textContent = val.toFixed(2);
    requestRender();
  });

  el.sliderHighlights.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.highlights = val;
    el.valHighlights.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
    requestRender();
  });

  el.sliderShadows.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.shadows = val;
    el.valShadows.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
    requestRender();
  });

  el.sliderColorTemp.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.temp = val;
    el.valColorTemp.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
    requestRender();
  });

  el.sliderColorTint.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    renderOptions.tint = val;
    el.valColorTint.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
    requestRender();
  });

  el.checkboxNativeHdr.addEventListener('change', (e) => {
    renderOptions.nativeHdr = e.target.checked;
    
    if ('drawingBufferColorSpace' in renderer.gl) {
      renderer.gl.drawingBufferColorSpace = renderOptions.nativeHdr ? 'rec2100-pq' : 'srgb';
      if (renderOptions.nativeHdr) {
        el.nativeHdrHelp.style.display = 'block';
        showToast('Enabled native HDR monitor mode (BT.2100 PQ)', 'success');
        
        // Auto-expand status card when checked to show the native status info
        el.hdrStatusContent.style.display = 'flex';
        el.hdrStatusChevron.style.transform = 'rotate(180deg)';
      } else {
        el.nativeHdrHelp.style.display = 'none';
        showToast('Restored standard SDR mode', 'info');
      }
    } else {
      if (renderOptions.nativeHdr) {
        showToast('Your browser does not support drawingBufferColorSpace (BT.2100 PQ).', 'warning');
        e.target.checked = false;
        renderOptions.nativeHdr = false;
      }
      el.nativeHdrHelp.style.display = 'none';
    }
    updateActiveModeLabel(renderOptions.nativeHdr);
    requestRender();
  });

  el.selectExportFormat.addEventListener('change', (e) => {
    const format = e.target.value;
    if (format === 'jpeg') {
      el.jpegQualityGroup.style.display = 'block';
    } else {
      el.jpegQualityGroup.style.display = 'none';
    }
  });

  el.sliderJpegQuality.addEventListener('input', (e) => {
    el.valJpegQuality.textContent = `${e.target.value}%`;
  });

  el.btnExport.addEventListener('click', exportImage);
  el.btnReset.addEventListener('click', () => {
    renderer.resetView();
    requestRender();
    showToast('Camera view reset');
  });

  // Canvas Viewport Events (Pan, Zoom, Split-screen Slider Drag)
  el.canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  el.canvas.addEventListener('wheel', onWheel, { passive: false });

  // Prevent canvas context menu
  el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Handle Resize
  window.addEventListener('resize', () => requestRender());

  // Histogram Expand, Control pills, Event Isolation & Cursor tracking
  el.btnHistogramExpand.addEventListener('click', () => {
    histogramState.expanded = !histogramState.expanded;
    if (histogramState.expanded) {
      el.histogramOverlay.classList.add('expanded');
      el.histogramControls.style.display = 'flex';
      el.histogramTitle.textContent = 'Image Histogram Analysis';
      el.btnHistogramExpand.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/>
        </svg>
      `;
    } else {
      el.histogramOverlay.classList.remove('expanded');
      el.histogramControls.style.display = 'none';
      el.histogramTitle.textContent = 'Luminance Histogram';
      el.histogramTooltip.style.display = 'none';
      histogramState.hoverX = null;
      histogramState.hoverY = null;
      el.btnHistogramExpand.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
        </svg>
      `;
    }
    requestRender();
  });

  el.histogramOverlay.querySelectorAll('[data-channel]').forEach(pill => {
    pill.addEventListener('click', () => {
      el.histogramOverlay.querySelectorAll('[data-channel]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      histogramState.channel = pill.getAttribute('data-channel');
      drawHistogram();
    });
  });

  el.histogramOverlay.querySelectorAll('[data-scale]').forEach(pill => {
    pill.addEventListener('click', () => {
      el.histogramOverlay.querySelectorAll('[data-scale]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      histogramState.scale = pill.getAttribute('data-scale');
      drawHistogram();
    });
  });

  // Stop canvas panning and zooming interactions when clicking/scrolling the histogram overlay
  const stopPropEvents = ['mousedown', 'mousemove', 'mouseup', 'wheel', 'click', 'dblclick'];
  stopPropEvents.forEach(evtName => {
    el.histogramOverlay.addEventListener(evtName, (e) => {
      e.stopPropagation();
    });
  });

  el.histogramCanvas.addEventListener('mousemove', (e) => {
    const rect = el.histogramCanvas.getBoundingClientRect();
    histogramState.hoverX = e.clientX - rect.left;
    histogramState.hoverY = e.clientY - rect.top;
    drawHistogram();
    updateHistogramTooltip();
  });

  el.histogramCanvas.addEventListener('mouseleave', () => {
    histogramState.hoverX = null;
    histogramState.hoverY = null;
    el.histogramTooltip.style.display = 'none';
    drawHistogram();
  });

  el.histogramCanvas.addEventListener('mouseenter', () => {
    if (currentImage.data) {
      el.histogramTooltip.style.display = 'flex';
    }
  });

  // Batch Dropzone
  el.batchDropzone.addEventListener('click', () => el.batchFileInput.click());
  el.batchFileInput.addEventListener('change', (e) => addBatchFiles(e.target.files));
  setupDragAndDrop(el.batchDropzone, (file) => addBatchFiles([file]));

  el.btnBatchClear.addEventListener('click', clearBatch);
  el.btnBatchStart.addEventListener('click', runBatchConversion);

  // Example Scene selector
  if (el.selectExampleScene) {
    el.selectExampleScene.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value, 10);
      loadExampleScene(idx);
    });
  }
}

// Drag & Drop helper
function setupDragAndDrop(target, callback) {
  target.addEventListener('dragover', (e) => {
    e.preventDefault();
    target.classList.add('dragover');
  });

  target.addEventListener('dragleave', () => {
    target.classList.remove('dragover');
  });

  target.addEventListener('drop', (e) => {
    e.preventDefault();
    target.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      callback(e.dataTransfer.files[0]);
    }
  });
}

// Tab Switching
function switchTab(tab) {
  if (tab === 'viewer') {
    el.tabViewer.classList.add('active');
    el.tabBatch.classList.remove('active');
    el.viewViewer.classList.add('active');
    el.viewBatch.classList.remove('active');
    requestRender();
  } else {
    el.tabViewer.classList.remove('active');
    el.tabBatch.classList.add('active');
    el.viewViewer.classList.remove('active');
    el.viewBatch.classList.add('active');
  }
}

// Show/Hide Loading
function showLoading(text) {
  el.loadingText.textContent = text || 'Processing...';
  el.loadingOverlay.classList.add('active');
}

function hideLoading() {
  el.loadingOverlay.classList.remove('active');
}

// Show Toast Notification
let toastTimeout = null;
function showToast(message, type = 'success') {
  clearTimeout(toastTimeout);
  el.toast.textContent = message;
  el.toast.className = `toast show ${type}`;
  toastTimeout = setTimeout(() => {
    el.toast.classList.remove('show');
  }, 3000);
}

// Update dynamic floating viewport labels (SDR/HDR status indicators overlaying the canvas)
function updateViewportLabels() {
  if (!el.viewportLabelLeft || !el.viewportLabelRight) return;

  const mode = renderOptions.previewMode;
  const details = OPERATOR_DETAILS[renderOptions.toneMapper];
  const operatorName = details ? details.name : 'HDR';

  if (mode === 'split') {
    el.viewportLabelLeft.textContent = 'SDR (Clamped)';
    el.viewportLabelLeft.style.display = 'block';
    el.viewportLabelLeft.style.left = '20px';
    el.viewportLabelLeft.style.right = 'auto';
    el.viewportLabelLeft.style.top = '20px';
    el.viewportLabelLeft.style.bottom = 'auto';

    el.viewportLabelRight.textContent = `HDR (${operatorName})`;
    el.viewportLabelRight.style.display = 'block';
    el.viewportLabelRight.style.left = 'auto';
    el.viewportLabelRight.style.right = '20px';
    el.viewportLabelRight.style.top = '20px';
    el.viewportLabelRight.style.bottom = 'auto';
  } else if (mode === 'split-h') {
    el.viewportLabelLeft.textContent = 'SDR (Clamped)';
    el.viewportLabelLeft.style.display = 'block';
    el.viewportLabelLeft.style.left = '20px';
    el.viewportLabelLeft.style.right = 'auto';
    el.viewportLabelLeft.style.top = '20px';
    el.viewportLabelLeft.style.bottom = 'auto';

    el.viewportLabelRight.textContent = `HDR (${operatorName})`;
    el.viewportLabelRight.style.display = 'block';
    el.viewportLabelRight.style.left = '20px';
    el.viewportLabelRight.style.right = 'auto';
    el.viewportLabelRight.style.top = 'auto';
    el.viewportLabelRight.style.bottom = '150px';
  } else if (mode === 'side-by-side') {
    el.viewportLabelLeft.textContent = 'SDR (Clamped)';
    el.viewportLabelLeft.style.display = 'block';
    el.viewportLabelLeft.style.left = '20px';
    el.viewportLabelLeft.style.right = 'auto';
    el.viewportLabelLeft.style.top = '20px';
    el.viewportLabelLeft.style.bottom = 'auto';

    el.viewportLabelRight.textContent = `HDR (${operatorName})`;
    el.viewportLabelRight.style.display = 'block';
    el.viewportLabelRight.style.left = 'auto';
    el.viewportLabelRight.style.right = '20px';
    el.viewportLabelRight.style.top = '20px';
    el.viewportLabelRight.style.bottom = 'auto';
  } else if (mode === 'blend') {
    const hdrPct = renderOptions.blendOpacity;
    const sdrPct = 100 - hdrPct;
    el.viewportLabelLeft.textContent = `SDR (Clamped) (${sdrPct}%)`;
    el.viewportLabelLeft.style.display = 'block';
    el.viewportLabelLeft.style.left = '20px';
    el.viewportLabelLeft.style.right = 'auto';
    el.viewportLabelLeft.style.top = '20px';
    el.viewportLabelLeft.style.bottom = 'auto';

    el.viewportLabelRight.textContent = `HDR (${operatorName}) (${hdrPct}%)`;
    el.viewportLabelRight.style.display = 'block';
    el.viewportLabelRight.style.left = 'auto';
    el.viewportLabelRight.style.right = '20px';
    el.viewportLabelRight.style.top = '20px';
    el.viewportLabelRight.style.bottom = 'auto';
  } else if (mode === 'hdr') {
    el.viewportLabelLeft.style.display = 'none';

    el.viewportLabelRight.textContent = `HDR (${operatorName})`;
    el.viewportLabelRight.style.display = 'block';
    el.viewportLabelRight.style.left = '20px';
    el.viewportLabelRight.style.right = 'auto';
    el.viewportLabelRight.style.top = '20px';
    el.viewportLabelRight.style.bottom = 'auto';
  } else if (mode === 'sdr') {
    el.viewportLabelLeft.textContent = 'SDR (Clamped)';
    el.viewportLabelLeft.style.display = 'block';
    el.viewportLabelLeft.style.left = '20px';
    el.viewportLabelLeft.style.right = 'auto';
    el.viewportLabelLeft.style.top = '20px';
    el.viewportLabelLeft.style.bottom = 'auto';

    el.viewportLabelRight.style.display = 'none';
  }
}

// Render Request
function requestRender() {
  cachedHdrToneMapper = null;
  if (renderer && currentImage.data) {
    let exposure = renderOptions.exposure;
    if (renderOptions.autoExposureCorrect) {
      exposure += Math.log2(80.0 / renderOptions.sdrWhite);
    }
    
    let resolvedSplitX = renderOptions.activeSplitX;
    let resolvedSplitY = renderOptions.activeSplitY;
    if (renderOptions.previewMode === 'hdr') {
      resolvedSplitX = 0.0;
      resolvedSplitY = 0.0;
    } else if (renderOptions.previewMode === 'sdr') {
      resolvedSplitX = 1.0;
      resolvedSplitY = 1.0;
    }

    const options = {
      ...renderOptions,
      splitX: resolvedSplitX,
      splitY: resolvedSplitY,
      blendOpacity: renderOptions.blendOpacity / 100.0,
      exposure: exposure,
      toneMapWhite: renderOptions.targetPeak / renderOptions.sdrWhite,
      // Override SDR-exclusive options for HDR inputs
      smartUpmix: currentImage.isHDR ? false : renderOptions.smartUpmix,
      sdrBoost: currentImage.isHDR ? 1.0 : renderOptions.sdrBoost
    };
    renderer.render(options);
    
    if (el.splitInstructions) {
      if (renderOptions.previewMode === 'split') {
        el.splitInstructions.innerHTML = 'Comparison Slider: Left side is <span>Standard SDR (Clamped)</span>, right side is <span>Processed HDR</span>';
        el.splitInstructions.classList.add('visible');
      } else if (renderOptions.previewMode === 'split-h') {
        el.splitInstructions.innerHTML = 'Comparison Slider: Top side is <span>Standard SDR (Clamped)</span>, bottom side is <span>Processed HDR</span>';
        el.splitInstructions.classList.add('visible');
      } else {
        el.splitInstructions.classList.remove('visible');
      }
    }
    
    updateViewportLabels();
    drawHistogram();
  }
}

// Toggle SDR-exclusive controls visibility and state based on whether the input image is HDR
function toggleSdrExclusiveControls(isHDR) {
  if (isHDR) {
    if (el.groupSmartUpmix) el.groupSmartUpmix.style.display = 'none';
    if (el.groupSdrBoost) el.groupSdrBoost.style.display = 'none';
    el.sliderSdrBoost.disabled = true;
    el.sliderSdrBoost.value = 1.0;
    el.valSdrBoost.textContent = '1.00x';
  } else {
    if (el.groupSmartUpmix) el.groupSmartUpmix.style.display = 'flex';
    if (el.groupSdrBoost) el.groupSdrBoost.style.display = 'block';
    el.sliderSdrBoost.disabled = false;
  }
}

// Load Synthetic Image (Procedural Test)
function loadSyntheticImage() {
  if (el.selectExampleScene) {
    el.selectExampleScene.selectedIndex = 0;
  }
  if (el.exampleDetails) {
    el.exampleDetails.style.display = 'none';
  }

  showLoading('Generating HDR scene...');
  
  // Run on setTimeout to let UI update
  setTimeout(() => {
    try {
      const width = 1024;
      const height = 768;
      const patternType = el.selectSyntheticPattern ? el.selectSyntheticPattern.value : 'cosmic';
      const parsed = generateSyntheticHDR(width, height, patternType);

      let filename = 'Procedural_Test_HDR.hdr';
      let formatName = 'Synthetic HDR (Cosmic)';
      if (patternType === 'macbeth') {
        filename = 'Calibration_Macbeth_HDR.hdr';
        formatName = 'Synthetic HDR (Macbeth)';
      } else if (patternType === 'landscape') {
        filename = 'Sunset_Landscape_HDR.hdr';
        formatName = 'Synthetic HDR (Landscape)';
      } else if (patternType === 'neon') {
        filename = 'Neon_Cyberpunk_HDR.hdr';
        formatName = 'Synthetic HDR (Neon)';
      } else if (patternType === 'radial') {
        filename = 'Radial_Test_Pattern_HDR.hdr';
        formatName = 'Synthetic HDR (Radial)';
      }

      currentImage = {
        name: filename,
        width: parsed.width,
        height: parsed.height,
        data: parsed.data,
        isHDR: true,
        maxLuminance: calculateMaxLuminance(parsed.data)
      };

      renderer.setImage(currentImage.width, currentImage.height, currentImage.data);
      updateMetadata(currentImage.name, formatName, currentImage.width, currentImage.height, '32-bit Float', 4);
      updateMetadataDisplay();
      
      // Reset and hide SDR-exclusive controls since synthetic images are HDR
      toggleSdrExclusiveControls(true);
      renderOptions.sdrBoost = 1.0;

      requestRender();
      showToast('Generated HDR test image');
    } catch (err) {
      showToast('Scene generation error: ' + err.message, 'error');
    } finally {
      hideLoading();
    }
  }, 50);
}

// Parse and Load Single File
function handleSingleFile(file) {
  if (!file) return;

  if (el.selectExampleScene) {
    el.selectExampleScene.selectedIndex = 0;
  }
  if (el.exampleDetails) {
    el.exampleDetails.style.display = 'none';
  }

  const ext = file.name.split('.').pop().toLowerCase();
  showLoading(`Loading and decoding .${ext} file...`);

  setTimeout(async () => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      let decoded = null;
      let formatName = '';
      let depthName = '32-bit Float';
      let isHDR = true;

      if (ext === 'jxr' || ext === 'wdp') {
        decoded = await decodeJXR(arrayBuffer);
        formatName = 'JPEG XR (.jxr)';
        depthName = 'Half/Full Float (HDR)';
      } else if (ext === 'exr') {
        decoded = decodeEXR(arrayBuffer);
        formatName = 'OpenEXR (.exr)';
      } else if (ext === 'hdr') {
        decoded = decodeRGBE(arrayBuffer);
        formatName = 'Radiance HDR (.hdr)';
      } else if (ext === 'avif') {
        decoded = await decodeAVIF(arrayBuffer, file);
        formatName = decoded.isHDR ? 'AVIF (HDR)' : 'AVIF (SDR)';
        depthName = decoded.isHDR ? '10-bit PQ/HLG (HDR)' : '8-bit Integer (SDR)';
        isHDR = decoded.isHDR;
      } else {
        // Standard Web formats (PNG, JPG, WebP)
        decoded = await decodeStandardImage(file);
        formatName = 'SDR Image (Standard)';
        depthName = '8-bit Integer (SDR)';
        isHDR = false;
      }

      currentImage = {
        name: file.name,
        width: decoded.width,
        height: decoded.height,
        data: decoded.data,
        isHDR: isHDR,
        maxLuminance: calculateMaxLuminance(decoded.data)
      };

      renderer.setImage(currentImage.width, currentImage.height, currentImage.data);
      updateMetadata(currentImage.name, formatName, currentImage.width, currentImage.height, depthName, 4);
      updateMetadataDisplay();

      // Handle SDR-exclusive controls visibility and state
      toggleSdrExclusiveControls(isHDR);
      if (isHDR) {
        renderOptions.sdrBoost = 1.0;
      } else {
        showToast('SDR file loaded. You can use the "SDR Boost" slider to artificially expand dynamic range.');
      }

      requestRender();
      showToast(`Loaded file: ${file.name}`);
    } catch (err) {
      showToast(`Error loading: ${err.message}`, 'error');
      console.error(err);
    } finally {
      hideLoading();
    }
  }, 50);
}

// Decode standard SDR formats using HTML Image + Canvas 2D
function decodeStandardImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, img.width, img.height);
      const numPixels = img.width * img.height;
      const floatData = new Float32Array(numPixels * 4);

      // Convert standard 0-255 uint8 values to 0.0-1.0 float values
      for (let i = 0; i < numPixels * 4; i++) {
        floatData[i] = imgData.data[i] / 255.0;
      }
      resolve({ width: img.width, height: img.height, data: floatData });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image. The file may be corrupted.'));
    };
    img.src = url;
  });
}

// Update UI Sidebar Metadata Details
function updateMetadata(name, format, width, height, depth, channels) {
  el.metaEmpty.style.display = 'none';
  el.metaDetails.style.display = 'grid';
  
  el.metaName.textContent = name;
  el.metaFormat.textContent = format;
  el.metaResolution.textContent = `${width} × ${height} px`;
  el.metaDepth.textContent = depth;
  el.metaChannels.textContent = `${channels} (RGBA)`;
}

// Interactive Viewport Events: Mouse interactions (Pan / Drag Divider)
function onMouseDown(e) {
  if (!currentImage.data) return;

  const rect = el.canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  
  // Normalized split divider position in client pixels
  const splitLineX = rect.width * renderOptions.activeSplitX;
  const splitLineY = rect.height * renderOptions.activeSplitY;

  // If click is near the split line (within 15px) and split mode is active, initiate dragging divider
  if (renderOptions.previewMode === 'split' && Math.abs(mouseX - splitLineX) < 15) {
    isDraggingDivider = true;
    el.canvas.style.cursor = 'ew-resize';
  } else if (renderOptions.previewMode === 'split-h' && Math.abs(mouseY - splitLineY) < 15) {
    isDraggingDivider = true;
    el.canvas.style.cursor = 'ns-resize';
  } else {
    // Otherwise drag to Pan camera view
    isPanning = true;
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startPanX = renderer.panX;
    startPanY = renderer.panY;
    el.canvas.style.cursor = 'grabbing';
  }
}

function onMouseMove(e) {
  if (!currentImage.data) {
    updatePixelHUD(null);
    return;
  }

  const rect = el.canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (isDraggingDivider) {
    if (renderOptions.previewMode === 'split') {
      renderOptions.activeSplitX = Math.max(0.0, Math.min(1.0, mouseX / rect.width));
    } else if (renderOptions.previewMode === 'split-h') {
      renderOptions.activeSplitY = Math.max(0.0, Math.min(1.0, mouseY / rect.height));
    }
    requestRender();
  } else if (isPanning) {
    const dx = e.clientX - startMouseX;
    const dy = e.clientY - startMouseY;
    
    // Smooth panning responsive to zoom factor
    const factorX = (2.0 / renderer.zoom) * (currentImage.width / rect.width);
    const factorY = (2.0 / renderer.zoom) * (currentImage.height / rect.height);

    renderer.panX = startPanX + (dx / rect.width) * factorX;
    renderer.panY = startPanY - (dy / rect.height) * factorY; // webgl y starts from bottom
    requestRender();
  } else {
    // Set dynamic cursor on hover
    const splitLineX = rect.width * renderOptions.activeSplitX;
    const splitLineY = rect.height * renderOptions.activeSplitY;
    if (renderOptions.previewMode === 'split' && Math.abs(mouseX - splitLineX) < 15) {
      el.canvas.style.cursor = 'ew-resize';
    } else if (renderOptions.previewMode === 'split-h' && Math.abs(mouseY - splitLineY) < 15) {
      el.canvas.style.cursor = 'ns-resize';
    } else {
      if (renderOptions.previewMode === 'split' || renderOptions.previewMode === 'split-h') {
        el.canvas.style.cursor = 'grab';
      } else {
        el.canvas.style.cursor = 'default';
      }
    }

    // Normal mouse movement: update Pixel HUD color inspector
    // Check if mouse is within canvas borders
    if (mouseX >= 0 && mouseX <= rect.width && mouseY >= 0 && mouseY <= rect.height) {
      updatePixelHUD({ x: mouseX, y: mouseY, rect });
    } else {
      updatePixelHUD(null);
    }
  }
}

function onMouseUp() {
  isDraggingDivider = false;
  isPanning = false;
  if (el.canvas) {
    if (renderOptions.previewMode === 'split' || renderOptions.previewMode === 'split-h') {
      el.canvas.style.cursor = 'grab';
    } else {
      el.canvas.style.cursor = 'default';
    }
  }
}

// Mouse Wheel Zooming
function onWheel(e) {
  if (!currentImage.data) return;
  e.preventDefault(); // Stop page scrolling

  const rect = el.canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // Zoom factor multiplier
  const zoomFactor = 1.1;
  const oldZoom = renderer.zoom;
  
  if (e.deltaY < 0) {
    renderer.setZoom(renderer.zoom * zoomFactor);
  } else {
    renderer.setZoom(renderer.zoom / zoomFactor);
  }

  // Shift pan slightly towards cursor focal point
  const actualRatio = renderer.zoom / oldZoom;
  const u = (mouseX / rect.width) - 0.5;
  const v = 0.5 - (mouseY / rect.height); // WebGL Y coordinate flip
  
  renderer.panX += u * (1.0 / oldZoom - 1.0 / renderer.zoom);
  renderer.panY += v * (1.0 / oldZoom - 1.0 / renderer.zoom);

  requestRender();
}
// Calculate HDR luminance (nits) before tone mapping, matching the shader logic
function calculateHdrNits(r, g, b, options) {
  let color = [r, g, b];

  // 1. Smart SDR-to-HDR upmix or linear boost
  if (options.smartUpmix) {
    const L = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
    if (L > 0.0) {
      const th = 0.75;
      let L_new = L;
      if (L > th) {
        const t = (L - th) / (1.0 - th);
        L_new = th + (L - th) * (1.0 + (options.sdrBoost - 1.0) * t);
      }
      const scale = L_new / L;
      color[0] *= scale;
      color[1] *= scale;
      color[2] *= scale;
    }
  } else {
    color[0] *= options.sdrBoost;
    color[1] *= options.sdrBoost;
    color[2] *= options.sdrBoost;
  }

  // 2. Exposure Offset (stops)
  let exposure = options.exposure;
  if (options.autoExposureCorrect) {
    exposure += Math.log2(80.0 / options.sdrWhite);
  }
  const expFactor = Math.pow(2.0, exposure);
  color[0] *= expFactor;
  color[1] *= expFactor;
  color[2] *= expFactor;

  // 3. Color Grading (Temp, Tint, Shadows, Highlights)
  color[0] += options.temp * 0.12 - options.tint * 0.06;
  color[1] += options.tint * 0.12;
  color[2] += -options.temp * 0.12 - options.tint * 0.06;
  color[0] = Math.max(0.0, color[0]);
  color[1] = Math.max(0.0, color[1]);
  color[2] = Math.max(0.0, color[2]);

  const L_grad = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  const shadowMask = Math.pow(1.0 - Math.min(1.0, Math.max(0.0, L_grad)), 2.0);
  const highlightMask = Math.pow(Math.min(1.0, Math.max(0.0, L_grad)), 2.0);
  color[0] += color[0] * options.shadows * shadowMask;
  color[1] += color[1] * options.shadows * shadowMask;
  color[2] += color[2] * options.shadows * shadowMask;
  color[0] += color[0] * options.highlights * highlightMask;
  color[1] += color[1] * options.highlights * highlightMask;
  color[2] += color[2] * options.highlights * highlightMask;
  color[0] = Math.max(0.0, color[0]);
  color[1] = Math.max(0.0, color[1]);
  color[2] = Math.max(0.0, color[2]);

  // Saturation
  const L_sat = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  color[0] = L_sat + (color[0] - L_sat) * options.saturation;
  color[1] = L_sat + (color[1] - L_sat) * options.saturation;
  color[2] = L_sat + (color[2] - L_sat) * options.saturation;

  const finalLuminance = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  return Math.max(0.0, finalLuminance * options.sdrWhite);
}

// Pixel HUD Inspector logic
function updatePixelHUD(mouseData) {
  if (!mouseData || !currentImage.data) {
    el.pixelHud.style.display = 'none';
    return;
  }

  const { x, y, rect } = mouseData;
  const imgW = currentImage.width;
  const imgH = currentImage.height;

  const clientXRatio = x / rect.width;
  const clientYRatio = y / rect.height;
  let isSdrSide = false;

  const canvasAspect = rect.width / rect.height;
  let effectiveCanvasAspect = canvasAspect;
  let effectiveXRatio = clientXRatio;

  if (renderOptions.previewMode === 'side-by-side') {
    effectiveCanvasAspect = canvasAspect * 0.5;
    if (clientXRatio < 0.5) {
      effectiveXRatio = clientXRatio * 2.0;
      isSdrSide = true;
    } else {
      effectiveXRatio = (clientXRatio - 0.5) * 2.0;
      isSdrSide = false;
    }
  } else if (renderOptions.previewMode === 'split') {
    let resolvedSplitX = renderOptions.activeSplitX;
    isSdrSide = clientXRatio < resolvedSplitX;
  } else if (renderOptions.previewMode === 'split-h') {
    let resolvedSplitY = renderOptions.activeSplitY;
    isSdrSide = clientYRatio < resolvedSplitY;
  } else if (renderOptions.previewMode === 'sdr') {
    isSdrSide = true;
  } else if (renderOptions.previewMode === 'hdr') {
    isSdrSide = false;
  } else if (renderOptions.previewMode === 'blend') {
    isSdrSide = null; // Blend mode uses a custom layout mix
  }

  // WebGL coordinate calculations matching shader aspect fits
  let aspectScaleX = 1.0;
  let aspectScaleY = 1.0;
  const imageAspect = imgW / imgH;

  if (effectiveCanvasAspect > imageAspect) {
    aspectScaleX = imageAspect / effectiveCanvasAspect;
  } else {
    aspectScaleY = effectiveCanvasAspect / imageAspect;
  }

  // Map viewport client coordinate back to normal center-based [-0.5, 0.5] range
  const nx = effectiveXRatio - 0.5;
  const ny = 0.5 - clientYRatio; // Flip Y

  // Apply inverse aspect scale, inverse zoom and inverse pan
  let u = nx / aspectScaleX;
  let v = ny / aspectScaleY;

  u = u / renderer.zoom + 0.5 - renderer.panX;
  v = v / renderer.zoom + 0.5 - renderer.panY;

  // If outside actual image bounds, hide HUD
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) {
    el.pixelHud.style.display = 'none';
    return;
  }

  // Get raw pixel index
  const px = Math.floor(u * imgW);
  const py = Math.floor((1.0 - v) * imgH); // Flip Y back for standard row index
  const idx = (py * imgW + px) * 4;

  const data = currentImage.data;
  if (idx < 0 || idx >= data.length) {
    el.pixelHud.style.display = 'none';
    return;
  }

  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];

  let nits = 0.0;
  let finalR = r;
  let finalG = g;
  let finalB = b;

  const sdr_gamma_map = (val) => {
    let clamped = Math.min(1.0, Math.max(0.0, val));
    return Math.pow(clamped, 1.0 / 2.2);
  };

  if (isSdrSide === true) {
    // SDR path: standard clamp and 2.2 gamma
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    nits = Math.max(0.0, luminance * renderOptions.sdrWhite);
    finalR = sdr_gamma_map(r);
    finalG = sdr_gamma_map(g);
    finalB = sdr_gamma_map(b);
  } else {
    // HDR path: uses the lazily instantiated cachedHdrToneMapper
    if (!cachedHdrToneMapper) {
      let resolvedExposure = renderOptions.exposure;
      let resolvedOperator = renderOptions.toneMapper === 0 ? 'linear' :
                             renderOptions.toneMapper === 1 ? 'reinhard' :
                             renderOptions.toneMapper === 2 ? 'aces' :
                             renderOptions.toneMapper === 3 ? 'hable' :
                             renderOptions.toneMapper === 4 ? 'lottes' :
                             renderOptions.toneMapper === 5 ? 'uchimura' : 'linear';

      cachedHdrToneMapper = createToneMapperFunc(
        resolvedExposure,
        resolvedOperator,
        renderOptions.gamma,
        renderOptions.contrast,
        renderOptions.sdrWhite,
        renderOptions.targetPeak,
        renderOptions.autoExposureCorrect,
        {
          sdrBoost: currentImage.isHDR ? 1.0 : renderOptions.sdrBoost,
          smartUpmix: currentImage.isHDR ? false : renderOptions.smartUpmix,
          saturation: renderOptions.saturation,
          highlights: renderOptions.highlights,
          shadows: renderOptions.shadows,
          temp: renderOptions.temp,
          tint: renderOptions.tint
        }
      );
    }

    const resolvedOptions = {
      ...renderOptions,
      sdrBoost: currentImage.isHDR ? 1.0 : renderOptions.sdrBoost,
      smartUpmix: currentImage.isHDR ? false : renderOptions.smartUpmix
    };

    if (isSdrSide === false) {
      nits = calculateHdrNits(r, g, b, resolvedOptions);
      const mapped = cachedHdrToneMapper(r, g, b);
      finalR = mapped[0];
      finalG = mapped[1];
      finalB = mapped[2];
    } else {
      // Blend mode (isSdrSide === null)
      const sdrNits = Math.max(0.0, (0.2126 * r + 0.7152 * g + 0.0722 * b) * renderOptions.sdrWhite);
      const hdrNits = calculateHdrNits(r, g, b, resolvedOptions);
      const opacity = renderOptions.blendOpacity / 100.0;

      nits = sdrNits + (hdrNits - sdrNits) * opacity;

      const sdrColor = [sdr_gamma_map(r), sdr_gamma_map(g), sdr_gamma_map(b)];
      const hdrColor = cachedHdrToneMapper(r, g, b);
      finalR = sdrColor[0] + (hdrColor[0] - sdrColor[0]) * opacity;
      finalG = sdrColor[1] + (hdrColor[1] - sdrColor[1]) * opacity;
      finalB = sdrColor[2] + (hdrColor[2] - sdrColor[2]) * opacity;
    }
  }

  // Convert to 0-255 range
  const sdrR = Math.round(finalR * 255);
  const sdrG = Math.round(finalG * 255);
  const sdrB = Math.round(finalB * 255);

  // Update DOM HUD values
  el.hudPos.textContent = `X: ${px}, Y: ${py}`;
  el.hudNits.textContent = `${nits.toFixed(2)} nit`;
  el.hudRawRgb.textContent = `R: ${r.toFixed(3)}, G: ${g.toFixed(3)}, B: ${b.toFixed(3)}`;
  el.hudSdrRgb.textContent = `RGB (${sdrR}, ${sdrG}, ${sdrB})`;
  el.hudSwatch.style.backgroundColor = `rgb(${sdrR}, ${sdrG}, ${sdrB})`;

  el.pixelHud.style.display = 'flex';
}

// Draw Luminance and Channel Histogram
function drawHistogram() {
  const canvas = el.histogramCanvas;
  const ctx = canvas.getContext('2d');
  
  // Set physical display width/height for canvas rendering
  const width = canvas.width = canvas.clientWidth;
  const height = canvas.height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);

  if (!currentImage.data) return;

  const numBins = histogramState.expanded ? 256 : 128;
  const maxSamples = histogramState.expanded ? 100000 : 25000;

  // Cache check: recalculate only when dynamic state changes or new file is loaded
  const needRecalculate = !cachedHistogram || 
                          cachedHistogram.imageName !== currentImage.name ||
                          cachedHistogram.imageData !== currentImage.data ||
                          cachedHistogram.numBins !== numBins;

  if (needRecalculate) {
    const data = currentImage.data;
    const numPixels = currentImage.width * currentImage.height;
    const step = Math.max(1, Math.floor(numPixels / maxSamples));
    
    const histR = new Float32Array(numBins);
    const histG = new Float32Array(numBins);
    const histB = new Float32Array(numBins);
    const histLum = new Float32Array(numBins);

    // Map luminance value to bins: Left 50% = linear SDR [0..1], Right 50% = logarithmic HDR (1..32)
    const mapLuminanceToBin = (val) => {
      if (val <= 1.0) {
        return Math.floor(val * (numBins / 2 - 1));
      } else {
        const logVal = Math.log2(val);
        const normLog = Math.min(1.0, logVal / 5.0); // max 32.0 (2^5 = 32)
        return Math.floor(numBins / 2 + normLog * (numBins / 2 - 1));
      }
    };

    let totalSamples = 0;
    for (let i = 0; i < numPixels; i += step) {
      const idx = i * 4;
      if (idx >= data.length) break;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      histR[Math.max(0, Math.min(numBins - 1, mapLuminanceToBin(r)))]++;
      histG[Math.max(0, Math.min(numBins - 1, mapLuminanceToBin(g)))]++;
      histB[Math.max(0, Math.min(numBins - 1, mapLuminanceToBin(b)))]++;
      histLum[Math.max(0, Math.min(numBins - 1, mapLuminanceToBin(lum)))]++;
      totalSamples++;
    }

    // Find max value to normalize scaling
    let maxBinVal = 0;
    for (let i = 0; i < numBins; i++) {
      if (histR[i] > maxBinVal) maxBinVal = histR[i];
      if (histG[i] > maxBinVal) maxBinVal = histG[i];
      if (histB[i] > maxBinVal) maxBinVal = histB[i];
      if (histLum[i] > maxBinVal) maxBinVal = histLum[i];
    }

    cachedHistogram = {
      imageName: currentImage.name,
      imageData: currentImage.data,
      numBins,
      histR,
      histG,
      histB,
      histLum,
      maxBinVal,
      totalSamples
    };
  }

  const { histR, histG, histB, histLum, maxBinVal, totalSamples } = cachedHistogram;

  // Account for tick labels space at the bottom if expanded
  const axisHeight = histogramState.expanded ? 20 : 0;
  const drawHeight = height - axisHeight;

  // Logarithmic height scale vs linear height scale
  const scaleHeight = (val) => {
    if (val === 0) return 0;
    if (histogramState.scale === 'log') {
      const factor = Math.log10(val) / Math.log10(maxBinVal);
      return Math.max(0, factor * (drawHeight - 10));
    } else {
      const factor = val / maxBinVal;
      return Math.max(0, factor * (drawHeight - 10));
    }
  };

  const drawPath = (histogram, color, fillStyle) => {
    ctx.beginPath();
    ctx.moveTo(0, drawHeight);
    
    for (let i = 0; i < numBins; i++) {
      const x = (i / (numBins - 1)) * width;
      const h = scaleHeight(histogram[i]);
      const y = drawHeight - h;
      ctx.lineTo(x, y);
    }
    
    ctx.lineTo(width, drawHeight);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  };

  // Draw filtered paths
  const ch = histogramState.channel;
  if (ch === 'all') {
    drawPath(histR, 'rgba(239, 68, 68, 0.75)', 'rgba(239, 68, 68, 0.04)');
    drawPath(histG, 'rgba(16, 185, 129, 0.75)', 'rgba(16, 185, 129, 0.04)');
    drawPath(histB, 'rgba(59, 130, 246, 0.75)', 'rgba(59, 130, 246, 0.04)');
    drawPath(histLum, 'rgba(241, 245, 249, 0.85)', 'rgba(241, 245, 249, 0.02)');
  } else if (ch === 'r') {
    drawPath(histR, 'rgba(239, 68, 68, 0.95)', 'rgba(239, 68, 68, 0.08)');
  } else if (ch === 'g') {
    drawPath(histG, 'rgba(16, 185, 129, 0.95)', 'rgba(16, 185, 129, 0.08)');
  } else if (ch === 'b') {
    drawPath(histB, 'rgba(59, 130, 246, 0.95)', 'rgba(59, 130, 246, 0.08)');
  } else if (ch === 'lum') {
    drawPath(histLum, 'rgba(241, 245, 249, 0.95)', 'rgba(241, 245, 249, 0.08)');
  }

  // Draw central dashed line divider representing SDR White boundary (1.0)
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(width / 2, 0);
  ctx.lineTo(width / 2, drawHeight);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.stroke();
  ctx.setLineDash([]); // clear dash

  if (histogramState.expanded) {
    // Horizontal axis line
    ctx.beginPath();
    ctx.moveTo(0, drawHeight);
    ctx.lineTo(width, drawHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.stroke();

    const getXForNits = (nitVal) => {
      const pixelVal = nitVal / renderOptions.sdrWhite;
      if (pixelVal <= 0) return 0;
      if (pixelVal <= 1.0) {
        return pixelVal * (width / 2);
      } else {
        const logVal = Math.log2(pixelVal);
        const normLog = Math.min(1.0, logVal / 5.0); // max 32.0 (2^5 = 32)
        return width / 2 + normLog * (width / 2);
      }
    };

    // Major round nit labels
    const ticks = [
      [0, '0'],
      [100, '100 n'],
      [renderOptions.sdrWhite, `SDR Ref (${Math.round(renderOptions.sdrWhite)} n)`],
      [500, '500 n'],
      [1000, '1000 n'],
      [2000, '2000 n'],
      [4000, '4000 n']
    ];

    ctx.font = '500 8px Outfit';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.textAlign = 'center';

    ticks.forEach(([nitVal, label]) => {
      const x = getXForNits(nitVal);
      if (x >= 0 && x <= width) {
        ctx.beginPath();
        ctx.moveTo(x, drawHeight);
        ctx.lineTo(x, drawHeight + 4);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.stroke();

        if (nitVal === 0) {
          ctx.textAlign = 'left';
          ctx.fillText(label, x + 2, drawHeight + 11);
        } else if (x > width - 20) {
          ctx.textAlign = 'right';
          ctx.fillText(label, x - 2, drawHeight + 11);
        } else {
          ctx.textAlign = 'center';
          ctx.fillText(label, x, drawHeight + 11);
        }
      }
    });
  } else {
    // Basic labels when collapsed
    ctx.font = '700 8px Outfit';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillText('SDR', 6, 12);
    ctx.fillText(`HDR (max ${Math.round(32 * renderOptions.sdrWhite)} nit)`, width / 2 + 8, 12);
  }

  // Draw Vertical Hairline and Intersection Circles on hover
  if (histogramState.hoverX !== null && histogramState.hoverX >= 0 && histogramState.hoverX <= width && histogramState.hoverY <= drawHeight) {
    const hx = histogramState.hoverX;

    // Draw hairline
    ctx.beginPath();
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, drawHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1.0;
    ctx.stroke();

    const ratio = hx / width;
    const binIdx = Math.max(0, Math.min(numBins - 1, Math.floor(ratio * numBins)));

    const drawDot = (histogram, dotColor) => {
      const h = scaleHeight(histogram[binIdx]);
      const y = drawHeight - h;
      ctx.beginPath();
      ctx.arc(hx, y, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = dotColor;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.0;
      ctx.stroke();
    };

    if (ch === 'all') {
      drawDot(histR, '#ef4444');
      drawDot(histG, '#10b981');
      drawDot(histB, '#3b82f6');
      drawDot(histLum, '#f1f5f9');
    } else if (ch === 'r') {
      drawDot(histR, '#ef4444');
    } else if (ch === 'g') {
      drawDot(histG, '#10b981');
    } else if (ch === 'b') {
      drawDot(histB, '#3b82f6');
    } else if (ch === 'lum') {
      drawDot(histLum, '#f1f5f9');
    }
  }
}

// Map bin index back to relative luminance [0..32]
function mapBinToLuminance(binIdx, numBins) {
  const halfBins = numBins / 2;
  if (binIdx < halfBins) {
    return binIdx / (halfBins - 1);
  } else {
    const normLog = (binIdx - halfBins) / (halfBins - 1);
    return Math.pow(2.0, normLog * 5.0);
  }
}

// Update floating hover tooltip content and position
function updateHistogramTooltip() {
  if (!currentImage.data || !cachedHistogram || histogramState.hoverX === null) {
    el.histogramTooltip.style.display = 'none';
    return;
  }

  const rect = el.histogramCanvas.getBoundingClientRect();
  const ratio = Math.max(0.0, Math.min(1.0, histogramState.hoverX / rect.width));
  const numBins = cachedHistogram.numBins;
  const binIdx = Math.max(0, Math.min(numBins - 1, Math.floor(ratio * numBins)));

  const lum = mapBinToLuminance(binIdx, numBins);
  const nitVal = lum * renderOptions.sdrWhite;
  const totalSamples = cachedHistogram.totalSamples;

  const pctLum = ((cachedHistogram.histLum[binIdx] / totalSamples) * 100).toFixed(2);
  const pctR = ((cachedHistogram.histR[binIdx] / totalSamples) * 100).toFixed(2);
  const pctG = ((cachedHistogram.histG[binIdx] / totalSamples) * 100).toFixed(2);
  const pctB = ((cachedHistogram.histB[binIdx] / totalSamples) * 100).toFixed(2);

  const isHdrSide = lum > 1.0;
  const zoneLabel = isHdrSide ? 'HDR (Extended)' : 'SDR (Standard)';

  const html = `
    <div class="tooltip-title">${zoneLabel}</div>
    <div class="tooltip-row">
      <span class="tooltip-label">Luminance:</span>
      <span class="tooltip-value" style="color: var(--accent-cyan); font-weight: 600;">${nitVal.toFixed(1)} nit</span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">Raw Float:</span>
      <span class="tooltip-value">${lum.toFixed(3)}</span>
    </div>
    <div class="tooltip-row" style="margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 4px;">
      <span class="tooltip-label" style="color: var(--text-primary);">Lum Count:</span>
      <span class="tooltip-value" style="color: var(--text-primary);">${pctLum}%</span>
    </div>
    <div class="tooltip-row" style="color: #fca5a5;">
      <span class="tooltip-label">Red Count:</span>
      <span class="tooltip-value">${pctR}%</span>
    </div>
    <div class="tooltip-row" style="color: #6ee7b7;">
      <span class="tooltip-label">Green Count:</span>
      <span class="tooltip-value">${pctG}%</span>
    </div>
    <div class="tooltip-row" style="color: #93c5fd;">
      <span class="tooltip-label">Blue Count:</span>
      <span class="tooltip-value">${pctB}%</span>
    </div>
  `;

  el.histogramTooltip.innerHTML = html;

  let tooltipX = histogramState.hoverX + 12;
  let tooltipY = histogramState.hoverY + 12;

  // Approximate sizes for clean layout boundaries
  const tooltipWidth = 175;
  const tooltipHeight = 135;

  if (tooltipX + tooltipWidth > rect.width) {
    tooltipX = histogramState.hoverX - tooltipWidth - 12;
  }
  if (tooltipY + tooltipHeight > rect.height) {
    tooltipY = histogramState.hoverY - tooltipHeight - 12;
  }

  el.histogramTooltip.style.left = `${tooltipX}px`;
  el.histogramTooltip.style.top = `${tooltipY}px`;
}

// Single Image Export
function exportImage() {
  if (!currentImage.data) return;

  const format = el.selectExportFormat.value;
  const filename = currentImage.name.replace(/\.[^/.]+$/, ""); // strip extension

  if (format === 'hdr') {
    // HDR Export: encode Float32Array directly to .hdr RGBE format
    showLoading('Generating HDR file...');
    setTimeout(() => {
      try {
        const fileBytes = encodeRGBE(currentImage.width, currentImage.height, currentImage.data);
        downloadBlob(new Blob([fileBytes], { type: 'image/vnd.radiance' }), `${filename}_converted.hdr`);
        showToast('Successfully exported Radiance HDR file!');
      } catch (err) {
        showToast('Export error: ' + err.message, 'error');
      } finally {
        hideLoading();
      }
    }, 50);
  } else if (format.startsWith('png') && format !== 'png') {
    // Custom High Bit-Depth PNG Export (10/12/16-bit SDR/HDR)
    showLoading('Generating high bit-depth PNG file...');
    setTimeout(async () => {
      try {
        const isSdr = format.endsWith('sdr');
        const bitDepth = format.includes('10') ? 10 : format.includes('12') ? 12 : 16;
        
        let transfer = 'linear';
        if (format.endsWith('pq')) {
          transfer = 'pq';
        } else if (format.endsWith('hlg')) {
          transfer = 'hlg';
        }
        
        let toneMapperFunc = null;
        if (isSdr) {
          const activeOperator = renderOptions.toneMapper === 0 ? 'linear' :
                                 renderOptions.toneMapper === 1 ? 'reinhard' :
                                 renderOptions.toneMapper === 2 ? 'aces' :
                                 renderOptions.toneMapper === 3 ? 'hable' :
                                 renderOptions.toneMapper === 4 ? 'lottes' :
                                 renderOptions.toneMapper === 5 ? 'uchimura' : 'linear';
          
          toneMapperFunc = createToneMapperFunc(
            renderOptions.exposure,
            activeOperator,
            renderOptions.gamma,
            renderOptions.contrast,
            renderOptions.sdrWhite,
            renderOptions.targetPeak,
            renderOptions.autoExposureCorrect,
            {
              sdrBoost: currentImage.isHDR ? 1.0 : renderOptions.sdrBoost,
              smartUpmix: currentImage.isHDR ? false : renderOptions.smartUpmix,
              saturation: renderOptions.saturation,
              highlights: renderOptions.highlights,
              shadows: renderOptions.shadows,
              temp: renderOptions.temp,
              tint: renderOptions.tint
            }
          );
        }

        let resolvedExposure = renderOptions.exposure;
        if (renderOptions.autoExposureCorrect) {
          resolvedExposure += Math.log2(80.0 / renderOptions.sdrWhite);
        }

        const pngBytes = await encodePNG(currentImage.width, currentImage.height, currentImage.data, {
          bitDepth: bitDepth,
          type: isSdr ? 'sdr' : 'hdr',
          transfer: transfer,
          exposure: resolvedExposure,
          contrast: renderOptions.contrast,
          sdrBoost: currentImage.isHDR ? 1.0 : renderOptions.sdrBoost,
          sdrWhite: renderOptions.sdrWhite,
          maxLuminance: currentImage.maxLuminance,
          toneMapperFunc: toneMapperFunc,
          smartUpmix: currentImage.isHDR ? false : renderOptions.smartUpmix,
          saturation: renderOptions.saturation,
          highlights: renderOptions.highlights,
          shadows: renderOptions.shadows,
          temp: renderOptions.temp,
          tint: renderOptions.tint
        });

        downloadBlob(new Blob([pngBytes], { type: 'image/png' }), `${filename}_converted.png`);
        showToast(`Successfully exported ${bitDepth}-bit ${isSdr ? 'SDR' : 'HDR'} PNG file!`);
      } catch (err) {
        showToast('Export error: ' + err.message, 'error');
      } finally {
        hideLoading();
      }
    }, 50);
  } else {
    // SDR Export (PNG 8-bit, JPEG, WebP)
    // To preserve full image resolution, we resize the WebGL canvas to native resolution,
    // render, read pixels, and restore original viewport viewport size.
    showLoading('Processing output image...');
    
    setTimeout(() => {
      try {
        const w = currentImage.width;
        const h = currentImage.height;

        // Resize Canvas to original image dimensions
        el.canvas.width = w;
        el.canvas.height = h;
        
        // Render with full quality (temporarily hiding split comparison line and disabling native HDR)
        let exposure = renderOptions.exposure;
        if (renderOptions.autoExposureCorrect) {
          exposure += Math.log2(80.0 / renderOptions.sdrWhite);
        }
        
        const options = {
          ...renderOptions,
          previewMode: 'hdr',
          splitX: 0.0,
          splitY: 0.0,
          heatmap: false,
          clippingWarning: false,
          nativeHdr: false, // Ensure standard tone-mapped SDR output
          exposure: exposure,
          toneMapWhite: renderOptions.targetPeak / renderOptions.sdrWhite,
          smartUpmix: currentImage.isHDR ? false : renderOptions.smartUpmix,
          sdrBoost: currentImage.isHDR ? 1.0 : renderOptions.sdrBoost
        };
        
        // Temporarily reset pan and zoom for export to capture the whole image
        const oldZoom = renderer.zoom;
        const oldPanX = renderer.panX;
        const oldPanY = renderer.panY;
        renderer.zoom = 1.0;
        renderer.panX = 0.0;
        renderer.panY = 0.0;
        
        renderer.render(options, true);
        
        // Read back the tone-mapped 8-bit pixels from canvas buffer
        const pixels = renderer.readPixels();
        
        // Restore zoom and pan
        renderer.zoom = oldZoom;
        renderer.panX = oldPanX;
        renderer.panY = oldPanY;
        
        // Restore screen layout size
        el.canvas.width = el.canvas.clientWidth;
        el.canvas.height = el.canvas.clientHeight;
        requestRender();

        // Write the readback pixels onto a temporary Canvas 2D for download creation
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = w;
        exportCanvas.height = h;
        const exportCtx = exportCanvas.getContext('2d');
        const imgData = exportCtx.createImageData(w, h);
        imgData.data.set(pixels);
        exportCtx.putImageData(imgData, 0, 0);

        // Download
        if (format === 'png') {
          exportCanvas.toBlob((blob) => {
            downloadBlob(blob, `${filename}_converted.png`);
            showToast('Exported PNG file!');
            hideLoading();
          }, 'image/png');
        } else if (format === 'webp') {
          exportCanvas.toBlob((blob) => {
            downloadBlob(blob, `${filename}_converted.webp`);
            showToast('Exported WebP file!');
            hideLoading();
          }, 'image/webp');
        } else {
          const quality = parseInt(el.sliderJpegQuality.value, 10) / 100.0;
          exportCanvas.toBlob((blob) => {
            downloadBlob(blob, `${filename}_converted.jpg`);
            showToast('Exported JPEG file!');
            hideLoading();
          }, 'image/jpeg', quality);
        }
      } catch (err) {
        showToast('Export error: ' + err.message, 'error');
        hideLoading();
      }
    }, 50);
  }
}

// Download blob helper
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// --- BATCH CONVERTER ---

// Add files to Batch List Queue
function addBatchFiles(files) {
  if (isBatchProcessing) return;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = file.name.split('.').pop().toLowerCase();
    
    // Validate extensions
    if (['jxr', 'wdp', 'exr', 'hdr', 'avif'].includes(ext)) {
      // Avoid duplicates
      if (!batchFiles.some(bf => bf.file.name === file.name && bf.file.size === file.size)) {
        batchFiles.push({
          file: file,
          status: 'pending',
          error: ''
        });
      }
    } else {
      showToast(`File "${file.name}" has an unsupported HDR format. Skipped.`, 'error');
    }
  }

  updateBatchUI();
}

// Clear Batch List Queue
function clearBatch() {
  if (isBatchProcessing) return;
  batchFiles = [];
  updateBatchUI();
  el.batchProgress.style.display = 'none';
}

// Update Batch View Interface
function updateBatchUI() {
  if (batchFiles.length === 0) {
    el.batchEmptyState.style.display = 'flex';
    el.batchFilesList.style.display = 'none';
    el.batchFilesList.innerHTML = '';
  } else {
    el.batchEmptyState.style.display = 'none';
    el.batchFilesList.style.display = 'block';
    
    el.batchFilesList.innerHTML = '';
    batchFiles.forEach((item, index) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'batch-item';

      let statusBadge = '';
      if (item.status === 'pending') {
        statusBadge = '<span class="batch-item-status status-pending">Pending</span>';
      } else if (item.status === 'processing') {
        statusBadge = '<span class="batch-item-status status-processing">Processing</span>';
      } else if (item.status === 'done') {
        statusBadge = '<span class="batch-item-status status-done">Done</span>';
      } else {
        statusBadge = `<span class="batch-item-status status-error" title="${item.error}">Error</span>`;
      }

      const sizeKB = (item.file.size / 1024).toFixed(0);
      const ext = item.file.name.split('.').pop().toUpperCase();

      itemEl.innerHTML = `
        <div class="batch-item-info">
          <div class="batch-item-name">${item.file.name}</div>
          <div class="batch-item-meta">
            <span>Format: ${ext}</span>
            <span>Rozmiar: ${sizeKB} KB</span>
          </div>
        </div>
        ${statusBadge}
        <button class="batch-item-remove" data-index="${index}">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
          </svg>
        </button>
      `;

      itemEl.querySelector('.batch-item-remove').addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        batchFiles.splice(idx, 1);
        updateBatchUI();
      });

      el.batchFilesList.appendChild(itemEl);
    });
  }
}

// Run Batch Processing
async function runBatchConversion() {
  if (batchFiles.length === 0 || isBatchProcessing) return;

  isBatchProcessing = true;
  el.batchProgress.style.display = 'flex';
  el.btnBatchStart.disabled = true;
  el.btnBatchClear.disabled = true;

  // Retrieve batch conversion settings
  const outputFormat = el.batchSelectFormat.value;

  // Set preset options for CPU-based tone mapping loop based on interactive UI settings
  let exposure = renderOptions.exposure;
  const opValue = parseInt(el.batchSelectOperator.value, 10);
  const operator = opValue === 0 ? 'linear' :
                   opValue === 1 ? 'reinhard' :
                   opValue === 2 ? 'aces' :
                   opValue === 3 ? 'hable' :
                   opValue === 4 ? 'lottes' :
                   opValue === 5 ? 'uchimura' : 'linear';
  let gamma = renderOptions.gamma;
  let contrast = renderOptions.contrast;
  let sdrWhite = renderOptions.sdrWhite;
  let targetPeak = renderOptions.targetPeak;
  let autoExposureCorrect = renderOptions.autoExposureCorrect;

  const zip = new JSZip();
  const numFiles = batchFiles.length;

  for (let i = 0; i < numFiles; i++) {
    const item = batchFiles[i];
    item.status = 'processing';
    updateBatchUI();
    
    // Update progress bar
    const percent = Math.round((i / numFiles) * 100);
    el.batchProgressPercent.textContent = `${percent}%`;
    el.batchProgressLabel.textContent = `Converting (${i + 1}/${numFiles}): ${item.file.name}`;
    el.batchProgressBar.style.width = `${percent}%`;

    try {
      const buffer = await item.file.arrayBuffer();
      const ext = item.file.name.split('.').pop().toLowerCase();
      let decoded = null;

      // 1. Decode
      if (ext === 'jxr' || ext === 'wdp') {
        decoded = await decodeJXR(buffer);
      } else if (ext === 'exr') {
        decoded = decodeEXR(buffer);
      } else if (ext === 'hdr') {
        decoded = decodeRGBE(buffer);
      } else if (ext === 'avif') {
        decoded = await decodeAVIF(buffer, item.file);
      } else {
        throw new Error('Unsupported format');
      }

      const fileIsHdr = decoded.isHDR !== false;

      // 2. Encode
      const filename = item.file.name.replace(/\.[^/.]+$/, ""); // strip extension
      
      if (outputFormat === 'hdr') {
        // HDR conversion: output the raw float values directly
        const fileBytes = encodeRGBE(decoded.width, decoded.height, decoded.data);
        zip.file(`${filename}_converted.hdr`, fileBytes);
      } else if (outputFormat.startsWith('png') && outputFormat !== 'png') {
        // Custom 10/12/16-bit SDR/HDR PNG
        const isSdr = outputFormat.endsWith('sdr');
        const bitDepth = outputFormat.includes('10') ? 10 : outputFormat.includes('12') ? 12 : 16;
        
        let transfer = 'linear';
        if (outputFormat.endsWith('pq')) {
          transfer = 'pq';
        } else if (outputFormat.endsWith('hlg')) {
          transfer = 'hlg';
        }

        let toneMapperFunc = null;
        if (isSdr) {
          toneMapperFunc = createToneMapperFunc(
            exposure,
            operator,
            gamma,
            contrast,
            sdrWhite,
            targetPeak,
            autoExposureCorrect,
            {
              sdrBoost: fileIsHdr ? 1.0 : renderOptions.sdrBoost,
              smartUpmix: fileIsHdr ? false : renderOptions.smartUpmix,
              saturation: renderOptions.saturation,
              highlights: renderOptions.highlights,
              shadows: renderOptions.shadows,
              temp: renderOptions.temp,
              tint: renderOptions.tint
            }
          );
        }
        
        let resolvedExposure = exposure;
        if (autoExposureCorrect) {
          resolvedExposure += Math.log2(80.0 / sdrWhite);
        }

        const maxLuminance = calculateMaxLuminance(decoded.data);
        const fileBytes = await encodePNG(decoded.width, decoded.height, decoded.data, {
          bitDepth: bitDepth,
          type: isSdr ? 'sdr' : 'hdr',
          transfer: transfer,
          exposure: resolvedExposure,
          contrast: contrast,
          sdrBoost: fileIsHdr ? 1.0 : renderOptions.sdrBoost,
          sdrWhite: sdrWhite,
          maxLuminance: maxLuminance,
          toneMapperFunc: toneMapperFunc,
          smartUpmix: fileIsHdr ? false : renderOptions.smartUpmix,
          saturation: renderOptions.saturation,
          highlights: renderOptions.highlights,
          shadows: renderOptions.shadows,
          temp: renderOptions.temp,
          tint: renderOptions.tint
        });
        zip.file(`${filename}_converted.png`, fileBytes);
      } else {
        // SDR conversion (PNG 8-bit, JPEG, WebP)
        // Perform CPU-based tone-mapping calculations
        const sdrBytes = toneMapOnCPU(
          decoded.width,
          decoded.height,
          decoded.data,
          exposure,
          operator,
          gamma,
          contrast,
          sdrWhite,
          targetPeak,
          autoExposureCorrect,
          {
            sdrBoost: fileIsHdr ? 1.0 : renderOptions.sdrBoost,
            smartUpmix: fileIsHdr ? false : renderOptions.smartUpmix,
            saturation: renderOptions.saturation,
            highlights: renderOptions.highlights,
            shadows: renderOptions.shadows,
            temp: renderOptions.temp,
            tint: renderOptions.tint
          }
        );
        
        // Write bytes to virtual Canvas 2D to create compressed image blob
        const canvas = document.createElement('canvas');
        canvas.width = decoded.width;
        canvas.height = decoded.height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(decoded.width, decoded.height);
        imgData.data.set(sdrBytes);
        ctx.putImageData(imgData, 0, 0);

        const imgBlob = await new Promise((resolve) => {
          if (outputFormat === 'png') {
            canvas.toBlob(resolve, 'image/png');
          } else if (outputFormat === 'webp') {
            canvas.toBlob(resolve, 'image/webp');
          } else {
            canvas.toBlob(resolve, 'image/jpeg', 0.9);
          }
        });

        const extension = outputFormat === 'png' ? 'png' : (outputFormat === 'webp' ? 'webp' : 'jpg');
        zip.file(`${filename}_converted.${extension}`, imgBlob);
      }

      item.status = 'done';
    } catch (err) {
      item.status = 'error';
      item.error = err.message;
      console.error(err);
    }
    
    updateBatchUI();
  }

  // 3. Complete and zip download
  el.batchProgressPercent.textContent = '100%';
  el.batchProgressLabel.textContent = 'Compressing zip archive...';
  el.batchProgressBar.style.width = '100%';

  try {
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(zipBlob, `Lumina_HDR_Batch_${Date.now()}.zip`);
    showToast('Batch processing completed successfully. Downloaded zip archive!');
  } catch (err) {
    showToast('ZIP generation error: ' + err.message, 'error');
  } finally {
    isBatchProcessing = false;
    el.btnBatchStart.disabled = false;
    el.btnBatchClear.disabled = false;
  }
}

// Unified function to create a tone mapper matching WebGL and CPU pipelines
function createToneMapperFunc(exposure, operator, gamma, contrast, sdrWhite = 200.0, targetPeak = 1000.0, autoExposureCorrect = true, extraOptions = {}) {
  let finalExposure = exposure;
  if (autoExposureCorrect) {
    finalExposure += Math.log2(80.0 / sdrWhite);
  }
  const expFactor = Math.pow(2.0, finalExposure);
  const whiteVal = Math.max(0.01, targetPeak / sdrWhite);

  const sdrBoost = extraOptions.sdrBoost !== undefined ? extraOptions.sdrBoost : 1.0;
  const smartUpmix = extraOptions.smartUpmix !== undefined ? extraOptions.smartUpmix : true;
  const saturation = extraOptions.saturation !== undefined ? extraOptions.saturation : 1.0;
  const highlights = extraOptions.highlights !== undefined ? extraOptions.highlights : 0.0;
  const shadows = extraOptions.shadows !== undefined ? extraOptions.shadows : 0.0;
  const temp = extraOptions.temp !== undefined ? extraOptions.temp : 0.0;
  const tint = extraOptions.tint !== undefined ? extraOptions.tint : 0.0;

  const aces = (v) => {
    const a = 2.51; const b = 0.03; const c = 2.43; const d = 0.59; const e = 0.14;
    return Math.min(1.0, Math.max(0.0, (v * (a * v + b)) / (v * (c * v + d) + e)));
  };

  const hableOp = (v) => {
    const A = 0.15; const B = 0.50; const C = 0.10; const D = 0.20; const E = 0.02; const F = 0.30;
    return ((v * (A * v + C * B) + D * E) / (v * (A * v + B) + D * F)) - E / F;
  };

  // Lottes parameters
  const a_lottes = 1.6;
  const d_lottes = 0.977;
  const hdrMax_lottes = whiteVal;
  const midIn_lottes = 0.18;
  const midOut_lottes = 0.267;
  const denom_lottes = Math.max(1e-5, Math.pow(hdrMax_lottes, a_lottes * d_lottes) * midOut_lottes - Math.pow(midIn_lottes, a_lottes * d_lottes) * midOut_lottes);
  const b_lottes = (-Math.pow(midIn_lottes, a_lottes) + (midOut_lottes * Math.pow(hdrMax_lottes, a_lottes * d_lottes) * Math.pow(midIn_lottes, a_lottes)) / denom_lottes) / (Math.pow(midIn_lottes, a_lottes * d_lottes) * midOut_lottes);
  const c_lottes = (Math.pow(hdrMax_lottes, a_lottes * d_lottes) * Math.pow(midIn_lottes, a_lottes) - Math.pow(hdrMax_lottes, a_lottes) * Math.pow(midIn_lottes, a_lottes * d_lottes) * midOut_lottes) / denom_lottes;

  const lottesOp = (v) => {
    const z = Math.pow(Math.max(0.0, v), a_lottes);
    return Math.min(1.0, Math.max(0.0, z / (Math.pow(z, d_lottes) * b_lottes + c_lottes)));
  };

  // Uchimura parameters
  const P_u = 1.0;
  const a_u = 1.0;
  const m_u = 0.22;
  const l_u = 0.4;
  const c_u = 1.33;
  const b_u = 0.0;
  const l0_u = ((P_u - m_u) * l_u) / a_u;
  const S0_u = m_u + l0_u;
  const S1_u = m_u + a_u * l0_u;
  const C2_u = (a_u * P_u) / (P_u - S1_u);
  const CP_u = -C2_u / P_u;

  const uchimuraOp = (v) => {
    const scaledX = v * (5.0 / whiteVal);
    if (scaledX <= 0.0) return b_u;
    
    let val = 0;
    if (scaledX < m_u) {
      const t = Math.min(1.0, Math.max(0.0, scaledX / m_u));
      const w0 = 1.0 - (t * t * (3.0 - 2.0 * t));
      const T = m_u * Math.pow(scaledX / m_u, c_u) + b_u;
      const L = m_u + a_u * (scaledX - m_u);
      val = T * w0 + L * (1.0 - w0);
    } else if (scaledX >= m_u + l0_u) {
      val = P_u - (P_u - S1_u) * Math.exp(CP_u * (scaledX - S0_u));
    } else {
      val = m_u + a_u * (scaledX - m_u);
    }
    return Math.min(1.0, Math.max(0.0, val));
  };
  
  const whiteAces = aces(whiteVal);
  const hableWhiteScale = hableOp(whiteVal);

  return (r, g, b) => {
    let color = [r, g, b];

    // 1. Smart SDR-to-HDR upmix or linear boost
    if (smartUpmix) {
      const L = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
      if (L > 0.0) {
        const th = 0.75;
        let L_new = L;
        if (L > th) {
          const t = (L - th) / (1.0 - th);
          L_new = th + (L - th) * (1.0 + (sdrBoost - 1.0) * t);
        }
        const scale = L_new / L;
        color[0] *= scale;
        color[1] *= scale;
        color[2] *= scale;
      }
    } else {
      color[0] *= sdrBoost;
      color[1] *= sdrBoost;
      color[2] *= sdrBoost;
    }

    // 2. Exposure Offset (stops)
    color[0] *= expFactor;
    color[1] *= expFactor;
    color[2] *= expFactor;

    // 3. Color Grading (Temp, Tint, Shadows, Highlights, Saturation)
    color[0] += temp * 0.12 - tint * 0.06;
    color[1] += tint * 0.12;
    color[2] += -temp * 0.12 - tint * 0.06;
    color[0] = Math.max(0.0, color[0]);
    color[1] = Math.max(0.0, color[1]);
    color[2] = Math.max(0.0, color[2]);

    const L_grad = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
    const shadowMask = Math.pow(1.0 - Math.min(1.0, Math.max(0.0, L_grad)), 2.0);
    const highlightMask = Math.pow(Math.min(1.0, Math.max(0.0, L_grad)), 2.0);
    color[0] += color[0] * shadows * shadowMask;
    color[1] += color[1] * shadows * shadowMask;
    color[2] += color[2] * shadows * shadowMask;
    color[0] += color[0] * highlights * highlightMask;
    color[1] += color[1] * highlights * highlightMask;
    color[2] += color[2] * highlights * highlightMask;
    color[0] = Math.max(0.0, color[0]);
    color[1] = Math.max(0.0, color[1]);
    color[2] = Math.max(0.0, color[2]);

    const L_sat = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
    color[0] = L_sat + (color[0] - L_sat) * saturation;
    color[1] = L_sat + (color[1] - L_sat) * saturation;
    color[2] = L_sat + (color[2] - L_sat) * saturation;
    color[0] = Math.max(0.0, color[0]);
    color[1] = Math.max(0.0, color[1]);
    color[2] = Math.max(0.0, color[2]);

    // Apply tone mapper operator
    let mapped = [color[0], color[1], color[2]];
    if (operator === 'reinhard') {
      const toneMap = (v) => v * (1.0 + v / (whiteVal * whiteVal)) / (v + 1.0);
      mapped[0] = toneMap(mapped[0]);
      mapped[1] = toneMap(mapped[1]);
      mapped[2] = toneMap(mapped[2]);
    } else if (operator === 'aces') {
      const acesOp = (v) => aces(v) / (whiteAces > 0.0 ? whiteAces : 1.0);
      mapped[0] = acesOp(mapped[0]);
      mapped[1] = acesOp(mapped[1]);
      mapped[2] = acesOp(mapped[2]);
    } else if (operator === 'hable') {
      const hableOp2 = (v) => hableOp(v) / (hableWhiteScale > 0.0 ? hableWhiteScale : 1.0);
      mapped[0] = hableOp2(mapped[0]);
      mapped[1] = hableOp2(mapped[1]);
      mapped[2] = hableOp2(mapped[2]);
    } else if (operator === 'lottes') {
      mapped[0] = lottesOp(mapped[0]);
      mapped[1] = lottesOp(mapped[1]);
      mapped[2] = lottesOp(mapped[2]);
    } else if (operator === 'uchimura') {
      mapped[0] = uchimuraOp(mapped[0]);
      mapped[1] = uchimuraOp(mapped[1]);
      mapped[2] = uchimuraOp(mapped[2]);
    } else {
      mapped[0] = Math.min(1.0, Math.max(0.0, mapped[0]));
      mapped[1] = Math.min(1.0, Math.max(0.0, mapped[1]));
      mapped[2] = Math.min(1.0, Math.max(0.0, mapped[2]));
    }

    mapped[0] = Math.min(1.0, Math.max(0.0, mapped[0]));
    mapped[1] = Math.min(1.0, Math.max(0.0, mapped[1]));
    mapped[2] = Math.min(1.0, Math.max(0.0, mapped[2]));

    // Apply contrast
    if (contrast !== 1.0) {
      mapped[0] = Math.pow(mapped[0], contrast);
      mapped[1] = Math.pow(mapped[1], contrast);
      mapped[2] = Math.pow(mapped[2], contrast);
    }

    // Apply display gamma
    mapped[0] = Math.pow(mapped[0], 1.0 / gamma);
    mapped[1] = Math.pow(mapped[1], 1.0 / gamma);
    mapped[2] = Math.pow(mapped[2], 1.0 / gamma);

    return [
      Math.min(1.0, Math.max(0.0, mapped[0])),
      Math.min(1.0, Math.max(0.0, mapped[1])),
      Math.min(1.0, Math.max(0.0, mapped[2]))
    ];
  };
}

// CPU-based Tone Mapping Loop for Batch Exports
function toneMapOnCPU(w, h, data, exposure, operator, gamma, contrast, sdrWhite = 200.0, targetPeak = 1000.0, autoExposureCorrect = true, extraOptions = {}) {
  const numPixels = w * h;
  const sdrBytes = new Uint8ClampedArray(numPixels * 4);
  
  const toneMap = createToneMapperFunc(exposure, operator, gamma, contrast, sdrWhite, targetPeak, autoExposureCorrect, extraOptions);

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const mapped = toneMap(data[idx], data[idx + 1], data[idx + 2]);
    sdrBytes[idx] = Math.round(mapped[0] * 255);
    sdrBytes[idx + 1] = Math.round(mapped[1] * 255);
    sdrBytes[idx + 2] = Math.round(mapped[2] * 255);
    sdrBytes[idx + 3] = Math.round(Math.min(1.0, Math.max(0.0, data[idx + 3])) * 255);
  }

  return sdrBytes;
}

// Start Application on DOM Load
window.addEventListener('DOMContentLoaded', init);
