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
* **HDR Monitor Mode (Experimental):** Renders the preview using the browser's native HDR capabilities (requires HDR monitor, OS support, and enabling experimental Web Platform features in Chrome).

### 3. Advanced Export Formats
* **PNG Output:**
  * Standard SDR (8-bit, 10-bit, 12-bit, 16-bit)
  * HDR PQ BT.2100 (10-bit, 12-bit, 16-bit) with custom `cICP` chunk injection
  * HDR HLG BT.2100 (10-bit, 12-bit, 16-bit)
  * HDR Linear Rec.709 (10-bit, 12-bit, 16-bit)
* **Radiance HDR (`.hdr`):** Exports to standard 32-bit float RGBE format.
* **JPEG & WebP:** Supports standard 8-bit SDR compressed exports with configurable quality.

---

## 🛠️ Tech Stack & Used Libraries

Lumina HDR is built as a modern, zero-install client-side web application. It runs entirely in your browser without uploading files to any external server.

### Core Technologies
* **HTML5 & Vanilla Javascript (ES Modules):** Application shell and business logic.
* **WebGL2:** High-performance, real-time shaders for image rendering, tone mapping operators, false color heatmaps, clipping overlays, and split-screen comparisons.
* **Vite:** High-performance local development environment and build tool.

### Dependency Libraries (listed in `package.json`)
* **[`parse-exr`](https://github.com/scijs/parse-exr)** (v1.0.2) — Lightweight parser for decoding OpenEXR (`.exr`) image buffers into raw floating-point arrays. *License: MIT*
* **[`jpegxr`](https://github.com/yushijinhun/jpegxr-js)** (v0.3.0) — WebAssembly port of the JPEG XR reference library (`jxrlib`), used to decode `.jxr` screenshots (such as those captured by Windows HDR). *License: MIT*

---

## 🚀 Getting Started

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed on your machine.

### Installation
1. Clone the repository to your local machine:
   ```bash
   git clone https://github.com/ventus34/lumina-hdr.git
   cd lumina-hdr
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

### Running Locally
Start the development server:
```bash
npm run dev
```
Open the local server URL (usually `http://localhost:5173`) in your browser to run the app.

### Building for Production
To bundle and optimize the project for web deployment:
```bash
npm run build
```
This builds the application into a single, fully self-contained HTML file (using `vite-plugin-singlefile`) in the `dist/` directory, containing all CSS, JS, and embedded assets. This file can be run offline or easily hosted on platforms like GitHub Pages, Vercel, or Netlify.

---

## 📜 Acknowledgements & Third-Party Credits

We would like to acknowledge the following libraries, formats, and individuals whose research and tools made this project possible:

* **Radiance HDR (.hdr / RGBE) Format:** Developed by Greg Ward. The encoder and decoder in `src/decoders/rgbe.js` are custom pure-JavaScript implementations of this format.
* **JPEG XR Reference Software (`jxrlib`):** Maintained by Microsoft and the JPEG committee. Distributed under a BSD-like license, which is compiled to WASM in our loader.
* **Native Browser HDR AVIF Decoding:** Employs native browser image rendering onto an offscreen Canvas `rec2100-pq` + `float16` context. This extracts high-precision BT.2100 PQ/HLG color data natively, enabling direct support for uncompressed Steam HDR screenshots (`.avif`) without heavy external WASM decoders.
* **Tone Mapping Operators:**
  * **ACES Filmic:** Academy Color Encoding System, with WebGL implementation formulas inspired by Stephen Hill and Krzysztof Narkowicz.
  * **Hable (Uncharted 2 Curve):** Designed by John Hable.
  * **Lottes:** Designed by Timothy Lottes.
  * **Uchimura (GT Tone Mapper):** Designed by Hajime Uchimura (Gran Turismo Sport / SEG).
  * **Reinhard:** Developed by Erik Reinhard.

---

## ⚠️ Screenshot Disclaimer

All game screenshots, titles, and related assets included in the `docs/examples/` directory are trademarks and copyrights of their respective owners. They are used in this project strictly for non-commercial, educational, and demonstration purposes under Fair Use guidelines. No copyright infringement is intended.

---

## 📄 License

This project is open-source and licensed under the **MIT License**.
