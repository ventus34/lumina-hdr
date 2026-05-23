/**
 * Procedural HDR Image Generator.
 * Creates synthetic HDR scenes and patterns with extreme dynamic range.
 * 
 * @param {number} width 
 * @param {number} height 
 * @param {string} patternType 
 * @returns {{width: number, height: number, data: Float32Array}}
 */
export function generateSyntheticHDR(width = 1024, height = 768, patternType = 'cosmic') {
  const numPixels = width * height;
  const data = new Float32Array(numPixels * 4);

  if (patternType === 'macbeth') {
    generateMacbeth(width, height, data);
  } else if (patternType === 'landscape') {
    generateLandscape(width, height, data);
  } else if (patternType === 'neon') {
    generateNeon(width, height, data);
  } else if (patternType === 'radial') {
    generateRadial(width, height, data);
  } else {
    generateCosmic(width, height, data);
  }

  return { width, height, data };
}

/**
 * Helper to convert sRGB to linear float values.
 */
function srgbToLinear(r, g, b) {
  const f = (x) => {
    const u = x / 255.0;
    return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
  };
  return [f(r), f(g), f(b)];
}

/**
 * Float linear interpolator helper.
 */
function mix(a, b, t) {
  return a * (1.0 - t) + b * t;
}

/**
 * 1. Cosmic HDR Scene
 * Starry sky with super-bright yellow sun and high-intensity neon plasma orb.
 */
function generateCosmic(width, height, data) {
  const sunX = width * 0.45;
  const sunY = height * 0.4;
  const sunRadius = Math.min(width, height) * 0.15;

  const orbX = width * 0.7;
  const orbY = height * 0.65;
  const orbRadius = Math.min(width, height) * 0.08;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;
      const ny = (y / height) * 2.0 - 1.0;

      let r = 0.015;
      let g = 0.018;
      let b = 0.035;

      // Horizon gradient (simulating sunset glow at the bottom)
      const horizonY = 0.5;
      if (ny > -horizonY) {
        const horizonFactor = (ny + horizonY) / (1.0 + horizonY);
        r += 0.15 * Math.pow(horizonFactor, 2.0);
        g += 0.06 * Math.pow(horizonFactor, 2.0);
        b += 0.25 * Math.pow(horizonFactor, 2.0);
      }

      // Background stars
      const starDensity = 0.002;
      const randomVal = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1.0;
      if (randomVal < starDensity) {
        const starBrightness = 0.8 + 7.2 * Math.pow(randomVal / starDensity, 3.0);
        r += starBrightness;
        g += starBrightness;
        b += starBrightness;
      }

      // Sun (peaking at 50.0)
      const distToSun = Math.sqrt(Math.pow(x - sunX, 2) + Math.pow(y - sunY, 2));
      if (distToSun < sunRadius * 2.5) {
        const t = distToSun / (sunRadius * 2.5);
        const glow = 2.0 * Math.pow(1.0 - t, 3.0);
        r += glow * 1.0;
        g += glow * 0.8;
        b += glow * 0.4;

        if (distToSun < sunRadius) {
          const sunT = distToSun / sunRadius;
          const sunIntensity = 50.0 * Math.pow(1.0 - sunT, 2.0);
          r += sunIntensity * 1.0;
          g += sunIntensity * 0.95;
          b += sunIntensity * 0.85;
        }
      }

      // Neon Plasma Orb (peaking at 20.0)
      const distToOrb = Math.sqrt(Math.pow(x - orbX, 2) + Math.pow(y - orbY, 2));
      if (distToOrb < orbRadius * 3.0) {
        const t = distToOrb / (orbRadius * 3.0);
        const glow = 1.5 * Math.pow(1.0 - t, 2.5);
        r += glow * 0.8;
        b += glow * 1.0;

        if (distToOrb < orbRadius) {
          const orbT = distToOrb / orbRadius;
          const orbIntensity = 20.0 * Math.pow(1.0 - orbT, 2.0);
          r += orbIntensity * 0.9;
          g += orbIntensity * 0.05;
          b += orbIntensity * 1.0;
        }
      }

      // Exposure step bars at the bottom
      if (y > height * 0.85 && y < height * 0.95) {
        const stepWidth = width / 6;
        const stepIndex = Math.floor(x / stepWidth);
        if (x % Math.floor(stepWidth) > 4) {
          let barIntensity = 0.0;
          let barColor = [1.0, 1.0, 1.0];
          switch (stepIndex) {
            case 0: barIntensity = 0.01; barColor = [0.2, 0.5, 1.0]; break;
            case 1: barIntensity = 0.1; barColor = [0.2, 1.0, 0.5]; break;
            case 2: barIntensity = 1.0; barColor = [1.0, 1.0, 1.0]; break;
            case 3: barIntensity = 5.0; barColor = [1.0, 0.6, 0.0]; break;
            case 4: barIntensity = 15.0; barColor = [1.0, 0.0, 0.3]; break;
            case 5: barIntensity = 40.0; barColor = [0.0, 1.0, 1.0]; break;
          }
          r += barColor[0] * barIntensity;
          g += barColor[1] * barIntensity;
          b += barColor[2] * barIntensity;
        }
      }

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 1.0;
    }
  }
}

/**
 * 2. Macbeth Color Chart & Calibration Pattern
 * Standard 24 patches, horizontal nit steps (0.01 to 10,000 nits) and saturation sweeps.
 */
function generateMacbeth(width, height, data) {
  const patches = [
    [115, 82, 68],   // Dark skin
    [194, 150, 130], // Light skin
    [98, 122, 157],  // Blue sky
    [87, 108, 67],   // Foliage
    [129, 128, 177], // Blue flower
    [102, 189, 170], // Bluish green
    [219, 116, 39],  // Orange
    [71, 91, 170],   // Purplish blue
    [187, 61, 74],   // Moderate red
    [81, 45, 109],   // Purple
    [161, 188, 64],  // Yellow green
    [224, 163, 46],  // Orange yellow
    [43, 61, 160],   // Blue
    [74, 149, 71],   // Green
    [166, 34, 47],   // Red
    [220, 192, 49],  // Yellow
    [174, 71, 139],  // Magenta
    [44, 126, 168],  // Cyan
    [240, 240, 240], // White
    [199, 201, 201], // Neutral 8
    [159, 161, 162], // Neutral 6.5
    [119, 120, 121], // Neutral 5
    [75, 77, 77],    // Neutral 3.5
    [42, 42, 42]     // Black
  ];

  const nitSteps = [
    { nits: 0.01 }, { nits: 0.1 }, { nits: 1.0 }, { nits: 10.0 }, { nits: 80.0 }, 
    { nits: 203.0 }, { nits: 500.0 }, { nits: 1000.0 }, { nits: 2000.0 }, { nits: 4000.0 }, 
    { nits: 10000.0 }
  ];

  const sweepColors = [
    [1.0, 0.0, 0.0], // Red
    [0.0, 1.0, 0.0], // Green
    [0.0, 0.0, 1.0], // Blue
    [0.0, 1.0, 1.0], // Cyan
    [1.0, 0.0, 1.0], // Magenta
    [1.0, 1.0, 0.0]  // Yellow
  ];

  const chartX = width * 0.15;
  const chartY = height * 0.08;
  const chartW = width * 0.7;
  const chartH = height * 0.44;

  const rampY = height * 0.58;
  const rampH = height * 0.12;
  const rampX = width * 0.05;
  const rampW = width * 0.9;

  const sweepY = height * 0.74;
  const sweepH = height * 0.20;
  const sweepX = width * 0.05;
  const sweepW = width * 0.9;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;

      // Dark background grid
      let r = 0.02, g = 0.02, b = 0.02;
      if (x % 64 === 0 || y % 64 === 0) {
        r = 0.035; g = 0.035; b = 0.045;
      }

      // Draw Color Chart
      if (x >= chartX && x < chartX + chartW && y >= chartY && y < chartY + chartH) {
        const localX = x - chartX;
        const localY = y - chartY;
        const cellW = chartW / 6.0;
        const cellH = chartH / 4.0;
        const col = Math.floor(localX / cellW);
        const row = Math.floor(localY / cellH);

        const border = 4;
        const rx = localX % cellW;
        const ry = localY % cellH;

        if (rx > border && rx < cellW - border && ry > border && ry < cellH - border) {
          const patchIdx = row * 6 + col;
          const srgb = patches[patchIdx];
          const lin = srgbToLinear(srgb[0], srgb[1], srgb[2]);
          r = lin[0];
          g = lin[1];
          b = lin[2];
        } else {
          r = 0.005; g = 0.005; b = 0.005;
        }
      }
      // Draw Grayscale blocks (Nits scale, referenced to 200 nits SDR white)
      else if (x >= rampX && x < rampX + rampW && y >= rampY && y < rampY + rampH) {
        const localX = x - rampX;
        const localY = y - rampY;
        const blockW = rampW / nitSteps.length;
        const blockIdx = Math.floor(localX / blockW);
        
        const border = 2;
        const rx = localX % blockW;
        if (rx > border && rx < blockW - border && localY > border && localY < rampH - border) {
          const step = nitSteps[blockIdx];
          const val = step.nits / 200.0;
          r = val; g = val; b = val;
        } else {
          r = 0.005; g = 0.005; b = 0.005;
        }
      }
      // Draw Saturation Sweeps (from 0 to 15.0 float value = 3000 nits)
      else if (x >= sweepX && x < sweepX + sweepW && y >= sweepY && y < sweepY + sweepH) {
        const localX = x - sweepX;
        const localY = y - sweepY;
        const sweepRowH = sweepH / sweepColors.length;
        const sweepRowIdx = Math.floor(localY / sweepRowH);
        
        const borderY = 1;
        const ry = localY % sweepRowH;

        if (ry > borderY && ry < sweepRowH - borderY) {
          const t = localX / sweepW;
          const colorBase = sweepColors[sweepRowIdx];
          const intensity = Math.pow(t, 2.0) * 15.0;
          r = colorBase[0] * intensity;
          g = colorBase[1] * intensity;
          b = colorBase[2] * intensity;
        } else {
          r = 0.005; g = 0.005; b = 0.005;
        }
      }

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 1.0;
    }
  }
}

/**
 * 3. Sunset Mountain Landscape
 * Sunset skies, sun (12,000 nits), lake with shimmering reflections, mountains with shadow details.
 */
function generateLandscape(width, height, data) {
  const sunX = width * 0.45;
  const sunY = height * 0.28;
  const sunRadius = Math.min(width, height) * 0.08;
  const horizonY = height * 0.65;

  const noise = (x, scale) => {
    return Math.sin(x * scale) * 0.5 + Math.sin(x * scale * 2.33 + 1.0) * 0.25 + Math.sin(x * scale * 0.5 - 2.0) * 0.25;
  };

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;

      let r = 0.0, g = 0.0, b = 0.0;

      // Silhouette mountain height profiles
      const h1 = height * 0.46 + height * 0.08 * noise(x, 0.004) + height * 0.02 * noise(x, 0.012);
      const h2 = height * 0.54 + height * 0.06 * noise(x + 500, 0.008) + height * 0.015 * noise(x, 0.024);
      const h3 = height * 0.62 + height * 0.04 * noise(x + 1000, 0.016) + height * 0.01 * noise(x, 0.05);

      if (y < horizonY) {
        // Sky gradient
        const skyT = y / horizonY;
        const skyBaseR = mix(0.01, 1.8, Math.pow(skyT, 3.5));
        const skyBaseG = mix(0.005, 0.35, Math.pow(skyT, 4.0));
        const skyBaseB = mix(0.04, 0.05, skyT);
        r = skyBaseR; g = skyBaseG; b = skyBaseB;

        // Sun & Glow
        const distToSun = Math.sqrt(Math.pow(x - sunX, 2) + Math.pow(y - sunY, 2));
        const maxSunDist = sunRadius * 6.5;
        if (distToSun < maxSunDist) {
          const t = distToSun / maxSunDist;
          const glow = 2.5 * Math.pow(1.0 - t, 3.0);
          r += glow * 1.5;
          g += glow * 0.7;
          b += glow * 0.1;

          if (distToSun < sunRadius) {
            const sunT = distToSun / sunRadius;
            const sunIntensity = 60.0 * Math.pow(1.0 - sunT, 2.0); // 12,000 nits core
            r += sunIntensity;
            g += sunIntensity * 0.95;
            b += sunIntensity * 0.8;
          }
        }

        // Overlay Mountains (back to front)
        if (y >= h1) {
          const distFromPeak = (y - h1) / (horizonY - h1);
          r = 0.06 + 0.15 * (1.0 - distFromPeak);
          g = 0.02 + 0.04 * (1.0 - distFromPeak);
          b = 0.04 + 0.02 * (1.0 - distFromPeak);
        }
        if (y >= h2) {
          const distFromPeak = (y - h2) / (horizonY - h2);
          r = 0.02 + 0.05 * (1.0 - distFromPeak);
          g = 0.01 + 0.01 * (1.0 - distFromPeak);
          b = 0.025 + 0.01 * (1.0 - distFromPeak);
        }
        if (y >= h3) {
          // Shadow details: low-intensity grid in shadows (2-6 nits)
          const shadowPattern = Math.abs(Math.sin(x * 0.15) * Math.cos(y * 0.15)) * 0.015;
          r = 0.003 + shadowPattern;
          g = 0.003 + shadowPattern * 0.8;
          b = 0.008 + shadowPattern * 0.5;
        }
      } else {
        // Water Mirror
        const waterY = y - horizonY;
        const waterT = waterY / (height - horizonY);
        const reflectedY = horizonY - waterY;
        const skyT = reflectedY / horizonY;
        
        const skyBaseR = mix(0.01, 1.8, Math.pow(skyT, 3.5));
        const skyBaseG = mix(0.005, 0.35, Math.pow(skyT, 4.0));
        const skyBaseB = mix(0.04, 0.05, skyT);

        r = skyBaseR * 0.4;
        g = skyBaseG * 0.35;
        b = skyBaseB * 0.5 + 0.01;

        // Specular shimmer reflection
        const wave = Math.sin(y * 0.4) * Math.cos(x * 0.1 + y * 0.05);
        const reflectedSunX = sunX + wave * 18.0 * (1.0 + waterT * 2.0);
        const dx = Math.abs(x - reflectedSunX);
        const sunWidth = sunRadius * (1.2 + waterT * 1.5);
        
        if (dx < sunWidth) {
          const specFactor = Math.pow(1.0 - dx / sunWidth, 4.0) * (0.8 / (waterT + 0.1));
          const spec = Math.min(25.0, specFactor * 4.0); // up to 5000 nits shimmer
          r += spec * 1.0;
          g += spec * 0.85;
          b += spec * 0.4;
        }

        // Shoreline shading
        if (waterY < 40.0) {
          const shoreFactor = waterY / 40.0;
          r = mix(0.004, r, shoreFactor);
          g = mix(0.004, g, shoreFactor);
          b = mix(0.009, b, shoreFactor);
        }
      }

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 1.0;
    }
  }
}

/**
 * 4. Neon Cyberpunk Cityscape
 * Glowing windows, buildings outlines, geometric signboards (7000 nits), and perspective ground grid.
 */
function generateNeon(width, height, data) {
  const vX = width * 0.5;
  const vY = height * 0.45;

  const rand = (s) => {
    return Math.abs(Math.sin(s * 12.9898) * 43758.5453) % 1.0;
  };

  const buildings = [
    { x1: width * 0.05, w: width * 0.12, h: height * 0.38, seed: 12 },
    { x1: width * 0.19, w: width * 0.10, h: height * 0.48, seed: 37 },
    { x1: width * 0.31, w: width * 0.14, h: height * 0.28, seed: 85 },
    { x1: width * 0.48, w: width * 0.11, h: height * 0.42, seed: 93 },
    { x1: width * 0.62, w: width * 0.15, h: height * 0.34, seed: 54 },
    { x1: width * 0.80, w: width * 0.13, h: height * 0.45, seed: 61 }
  ];

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;

      let r = 0.005, g = 0.002, b = 0.012;
      
      const dxCenter = (x - vX) / width;
      const dyCenter = (y - vY) / height;
      const nebulaGlow = 0.03 * Math.pow(Math.max(0.0, 1.0 - Math.sqrt(dxCenter*dxCenter + dyCenter*dyCenter)), 2.0);
      r += nebulaGlow * 0.8;
      b += nebulaGlow * 1.5;

      if (y > vY) {
        // Perspective grid ground
        const groundY = y - vY;
        const depth = 1.0 / (groundY + 1.0);
        const worldX = (x - vX) * depth * 35.0;
        const worldZ = depth * 400.0;
        const fade = groundY / (height - vY);

        const rx = Math.abs(worldX % 3.0) / 3.0;
        const rz = Math.abs(worldZ % 6.0) / 6.0;
        const lineThick = 0.08 * (1.0 - fade * 0.5);

        if (rx < lineThick || rx > 1.0 - lineThick || rz < lineThick || rz > 1.0 - lineThick) {
          const gridColor = Math.sin(worldX * 0.1) > 0.0 ? [1.5, 0.0, 1.0] : [0.0, 1.0, 1.5];
          const intensity = 0.05 + 1.5 * Math.pow(fade, 2.5);
          r += gridColor[0] * intensity;
          g += gridColor[1] * intensity;
          b += gridColor[2] * intensity;
        } else {
          r += 0.008; g += 0.008; b = 0.015;
        }
      } else {
        // Starfield
        const starVal = rand(x * 17.1 + y * 93.3);
        if (starVal < 0.001) {
          const starIntensity = 0.5 + starVal * 1500;
          r += starIntensity; g += starIntensity; b += starIntensity;
        }

        // Buildings facade
        for (let bIdx = 0; bIdx < buildings.length; bIdx++) {
          const building = buildings[bIdx];
          const topY = vY - building.h;
          
          if (x >= building.x1 && x < building.x1 + building.w && y >= topY && y < vY) {
            bx = x - building.x1;
            by = y - topY;
            
            // Dark facade
            r = 0.006; g = 0.006; b = 0.01;

            // Windows
            const winW = 8, winH = 12, winSpX = 14, winSpY = 22;
            const wx = bx % winSpX;
            const wy = by % winSpY;

            if (wx < winW && wy < winH) {
              const winCol = Math.floor(bx / winSpX);
              const winRow = Math.floor(by / winSpY);
              const winSeed = building.seed + winCol * 3 + winRow * 11;
              
              if (rand(winSeed) > 0.65) {
                const colorSeed = rand(winSeed * 7.7);
                let winColor = [1.2, 1.2, 1.2];
                let winIntensity = 1.0 + rand(winSeed * 13.0) * 3.0; // 200 - 800 nits

                if (colorSeed < 0.25) winColor = [1.5, 0.1, 0.1];
                else if (colorSeed < 0.5) winColor = [0.1, 1.2, 1.5];
                else if (colorSeed < 0.75) winColor = [1.5, 0.8, 0.0];
                else winColor = [1.2, 0.0, 1.5];

                r = winColor[0] * winIntensity;
                g = winColor[1] * winIntensity;
                b = winColor[2] * winIntensity;
              }
            }

            // Neon outline accent stripes
            const borderWidth = 3;
            if (bx < borderWidth || bx > building.w - borderWidth || by < borderWidth) {
              const borderSeed = building.seed * 3.3;
              const borderColors = [
                [0.0, 3.0, 4.0], [4.0, 0.0, 3.0], [0.0, 4.0, 1.0], [4.0, 2.0, 0.0]
              ];
              const bColor = borderColors[Math.floor(rand(borderSeed) * borderColors.length)];
              r = bColor[0]; g = bColor[1]; b = bColor[2];
            }

            // Specular geometric logo circular shapes peaking at 35.0 (7000 nits)
            if (building.seed % 3 === 0 && by > 15 && by < 45 && bx > building.w / 2 - 15 && bx < building.w / 2 + 15) {
              const lcx = bx - building.w / 2;
              const lcy = by - 30;
              const ldist = Math.sqrt(lcx*lcx + lcy*lcy);
              if (Math.abs(ldist - 10.0) < 2.0) {
                r = 35.0; g = 0.0; b = 35.0;
              }
            }
          }
        }
      }

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 1.0;
    }
  }
  // Local building variables bx/by should be declared
  var bx, by;
}

/**
 * 5. Radial Siemens Star & Zone Plate Pattern
 * Siemens spokes and concentric circular zone plates split into peak nit quadrants (1.0, 5.0, 15.0, 50.0).
 */
function generateRadial(width, height, data) {
  const cX1 = width * 0.25;
  const cY1 = height * 0.5;
  
  const cX2 = width * 0.75;
  const cY2 = height * 0.5;

  const maxRadius = height * 0.38;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;

      // Dark background grid
      let r = 0.03, g = 0.03, b = 0.03;
      if (x % 32 === 0 || y % 32 === 0) {
        r = 0.045; g = 0.045; b = 0.055;
      }

      if (Math.abs(x - width * 0.5) < 3) {
        r = 0.5; g = 0.5; b = 0.5;
      }

      const getIntensity = (lx, ly, cx, cy) => {
        const dx = lx - cx;
        const dy = ly - cy;
        if (dx <= 0 && dy <= 0) return 1.0;        // Q1: SDR 200 nits
        if (dx > 0 && dy <= 0) return 5.0;         // Q2: HDR 1000 nits
        if (dx <= 0 && dy > 0) return 15.0;        // Q3: HDR 3000 nits
        return 50.0;                               // Q4: HDR 10000 nits
      };

      // Siemens Star
      if (x < width * 0.5) {
        const dx = x - cX1;
        const dy = y - cY1;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        if (dist < maxRadius) {
          const angle = Math.atan2(dy, dx);
          const spokes = 64;
          const val = Math.cos(angle * spokes);
          
          const edgeWidth = 0.02 * (maxRadius / (dist + 0.1));
          const edge = Math.min(1.0, Math.max(0.0, 0.5 + val / edgeWidth));

          const peakVal = getIntensity(x, y, cX1, cY1);
          const color = mix(0.001, peakVal, edge);
          
          r = color; g = color; b = color;
        } else if (Math.abs(dist - maxRadius) < 3.0) {
          r = 1.0; g = 1.0; b = 1.0;
        }
      } 
      // Zone Plate
      else {
        const dx = x - cX2;
        const dy = y - cY2;
        const dist = Math.sqrt(dx*dx + dy*dy);

        if (dist < maxRadius) {
          const normDist = dist / maxRadius;
          const f = Math.sin(normDist * normDist * 180.0);
          const val = f * 0.5 + 0.5;

          const peakVal = getIntensity(x, y, cX2, cY2);
          const color = val * peakVal;
          r = color; g = color; b = color;
        } else if (Math.abs(dist - maxRadius) < 3.0) {
          r = 1.0; g = 1.0; b = 1.0;
        }
      }

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 1.0;
    }
  }
}
