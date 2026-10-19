# Lumina HDR - HDR Screenshot Preview & Conversion Tool

https://ventus34.github.io/lumina-hdr/

Lumina HDR is a feature-rich, client-side web application designed for viewing, calibrating, and tone mapping HDR screenshots and images (including JXR, AVIF, EXR, and Radiance HDR). It provides interactive tools to preview high-dynamic-range content and export it to modern formats (like high-precision HDR/SDR PNGs) with precise control. Made with Antigravity (and Gemini 3.5 Flash) to solve the problem of viewing JXR HDR screenshots from the Xbox app and AVIF HDR screenshots from Steam in Discord/macOS.

---

## 🌟 Key Features

### 1. Interactive Preview & Calibration
* **Multi-Format Loader:** Drag-and-drop or select HDR files like `.jxr`, `.avif` (such as Steam HDR screenshots), `.exr`, and `.hdr` as well as standard SDR images (`.png`, `.jpg`, `.webp`, `.avif`).
* **Comparison Slider:** Compare the processed HDR output with standard SDR (clamped) using multiple layout modes:
  * Vertical Split-screen
  * Horizontal Split-screen
  * Side-by-Side
  * Opacity Blend
* **Interactive Viewport:** Smooth zooming and panning using your mouse wheel, trackpad, and dragging.
* **Metadata Inspector:** Instantly view image details: name, format, dimensions, bit depth, channels, and estimated peak brightness.
* **Interactive Histogram:** A real-time, canvas-based histogram displaying brightness and individual color channel distributions (All, Lum, R, G, B) with logarithmic or linear scaling. Includes an **Expand/Zoom** mode for a high-fidelity view (256 bins, 100,000 samples) with axis scale ticks and interactive hover tooltips showing nit range, bin count, and percentile distribution.
* **Pixel Inspector HUD:** Hover over any pixel to inspect its coordinates, raw floating-point RGB, converted SDR RGB, and absolute luminance in nits.

### 2. Tone Mapping & Color Tuning
* **Tone Mapping Operators:** Choose between ACES Filmic, Hable, Lottes, Uchimura (GT), Reinhard, or Linear (Clamp). UI features collapsible **About this Operator** information cards describing each operator's style characteristics, best-use cases, and rendering formulas.
* **Fine-Tuning Controls:** Adjust Exposure (stops), Gamma, Contrast, SDR-to-HDR Boost, Saturation, Highlights, Shadows, Color Temperature, and Tint.
* **Visualizations:**
  * **False Color Heatmap:** Map luminance values to a multi-color gradient to locate bright highlights and dark shadows.
  * **Highlight Clipping Zebra:** Display zebra stripes on areas exceeding specified SDR or HDR brightness thresholds.
* **HDR Monitor Mode (Experimental):** Available when the browser supports the required HDR drawing-buffer color space. HDR display output also requires compatible hardware and OS settings; the app reports the detected capabilities.

### 3. Advanced Export Formats
* **PNG Output:**
  * Standard SDR (8-bit, 10-bit, 12-bit, 16-bit)
  * HDR PQ BT.2100 (10-bit, 12-bit, 16-bit) with custom `cICP` chunk injection
  * HDR HLG BT.2100 (10-bit, 12-bit, 16-bit)
  * HDR Linear Rec.709 (10-bit, 12-bit, 16-bit)
* **Radiance HDR (`.hdr`):** Exports RGBE pixels with three mantissa bytes and a shared exponent; choose original pixels or processed output explicitly.
* **JPEG & WebP:** Supports standard 8-bit SDR compressed exports with configurable quality.

The current JPEG XR backend does not decode the source alpha channel. JXR images are loaded as opaque with an explicit warning; RGB values are preserved. Premultiplied JXR that requires unavailable alpha is rejected. PNG and EXR transparency handling is unchanged.

---

## 🛠️ Tech Stack & Used Libraries

Lumina HDR is built as a modern, zero-install client-side web application. It runs entirely in your browser without uploading files to any external server.

### Core Technologies
* **HTML5 & Vanilla Javascript (ES Modules):** Application shell and business logic.
* **WebGL2:** High-performance, real-time shaders for image rendering, tone mapping operators, false color heatmaps, clipping overlays, and split-screen comparisons.
* **Vite:** High-performance local development environment and build tool.

### Dependency Libraries
* **[`@jsquash/avif`](https://github.com/jamsinclair/jSquash/tree/main/packages/avif)** (v2.1.1) — WebAssembly AVIF decoding with high-bit-depth samples for PQ/HLG imports. *License: Apache-2.0*
* **[`parse-exr`](https://github.com/dmnsgn/parse-exr)** (v1.0.2) — Lightweight parser for decoding OpenEXR (`.exr`) image buffers into raw floating-point arrays. *License: MIT*
* **[`jpegxr`](https://github.com/brion/jpegxr)** (v0.3.0) — WebAssembly port of the JPEG XR reference library (`jxrlib`), used to decode `.jxr` screenshots (such as those captured by Windows HDR). *License: BSD-3-Clause*
* **[`vite`](https://github.com/vitejs/vite)** and **[`vite-plugin-singlefile`](https://github.com/richardtallent/vite-plugin-singlefile)** — Development server and standalone HTML build tooling.
* **[`eslint`](https://github.com/eslint/eslint)** — Static checks for JavaScript source, tests and build scripts.

The generated HTML embeds the runtime dependencies' license texts in the `third-party-notices` template, including the portable distribution.

---

## 🚀 Getting Started

### Prerequisites
Use Node.js 24.19.x. The repository pins this version in `.nvmrc` and declares it in `package.json`.

### Installation
1. Clone the repository to your local machine:
   ```bash
   git clone https://github.com/ventus34/lumina-hdr.git
   cd lumina-hdr
   ```
2. Install dependencies:
   ```bash
   npm ci
   ```

### Running Locally
Start the development server:
```bash
npm run dev
```
Open the local server URL (usually `http://localhost:5173`) in your browser to run the app.

### Checks

Run the same checks used in continuous integration:

```bash
npm run check
npm run audit
```

### Portable HTML build

```bash
npm run build
```

This writes `dist/index.html`, a single HTML file containing the application code and styles. It does not include the example image dataset or contact a font service; users can open local files in the app. The example gallery is disabled in this profile so the portable build does not download or copy the roughly 512 MiB dataset.

`dist/` is generated and ignored by Git. The published Pages entry point, `docs/index.html`, remains tracked alongside its example dataset.

### GitHub Pages build

```bash
npm run build:pages
```

This builds into an isolated `dist/pages/` directory, validates `docs/examples/examples.json` and every referenced file, then copies the single HTML file to `docs/index.html` with the repository subpath configured for GitHub Pages. It serves the existing `docs/examples/` directory in place and does not duplicate or rewrite the example images. If the optional dataset is absent, the build succeeds with the gallery disabled.

`npm run dev` uses the same manifest and dataset from `docs/examples/`. The HTML app itself is bundled for distribution; the gallery dataset remains a separate static directory.

The example images currently live in the Git repository, so a fresh clone still downloads them. No Git history rewrite has been performed. If the dataset is moved in the future, publish it as a separately versioned archive with a manifest and checksums, then keep the app's portable build independent of that download.

---

## 📜 Acknowledgements & Third-Party Credits

We would like to acknowledge the following libraries, formats, and individuals whose research and tools made this project possible:

* **Radiance HDR (.hdr / RGBE) Format:** Developed by Greg Ward. The encoder and decoder in `src/decoders/rgbe.js` are custom pure-JavaScript implementations of this format.
* **JPEG XR Reference Software (`jxrlib`):** Distributed by the `jpegxr` package under BSD-3-Clause; see its repository and package metadata for details.
* **Native Browser HDR AVIF Decoding:** Uses browser image and canvas capabilities where available. Support varies by browser; the application reports when a source cannot be preserved as HDR.
* **Tone Mapping Operators:**
  * **ACES Filmic:** Krzysztof Narkowicz's fitted filmic curve; this operator is not a complete ACES color-management pipeline.
  * **Hable (Uncharted 2 Curve):** Designed by John Hable.
  * **Lottes:** Designed by Timothy Lottes.
  * **Uchimura (GT Tone Mapper):** Designed by Hajime Uchimura (Gran Turismo Sport / SEG).
  * **Reinhard:** Developed by Erik Reinhard.

---

## ⚠️ Screenshot Disclaimer

Game screenshots, titles, and related assets in `docs/examples/` belong to their respective rights holders. The manifest identifies each example. Their inclusion here does not imply endorsement or a license from those rights holders.

---

## 📄 License

This project is open-source and licensed under the **MIT License**.
