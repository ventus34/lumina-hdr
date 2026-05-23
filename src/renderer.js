/**
 * WebGL2 Renderer for High Precision Floating-Point Images.
 * Provides GPU-accelerated rendering, real-time tone mapping, split-screen comparisons,
 * panning, zooming, and checkerboard background rendering.
 */

const VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  // Flip Y for standard image orientation
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_image;
uniform float u_zoom;
uniform vec2 u_pan;
uniform float u_image_aspect;
uniform float u_canvas_aspect;

// Tone mapping uniforms
uniform float u_exposure;
uniform float u_gamma;
uniform float u_contrast;
uniform float u_sdr_boost;
uniform int u_tone_mapper; // 0=Linear, 1=Reinhard, 2=ACES, 3=Hable, 4=Lottes, 5=Uchimura
uniform float u_tone_map_white;

// Comparison uniforms
uniform int u_comparison_mode; // 0=Split V, 1=Split H, 2=Side-by-Side, 3=Opacity Blend
uniform float u_split_x; // [0.0, 1.0]
uniform float u_split_y; // [0.0, 1.0]
uniform float u_blend_opacity; // [0.0, 1.0]

// Native HDR uniforms
uniform int u_native_hdr; // 0 = standard SDR, 1 = native Rec2100 PQ
uniform float u_sdr_white; // SDR Reference White in nits (e.g., 200)

// Visualizations & Overlays
uniform int u_heatmap; // 0 = disabled, 1 = enabled
uniform int u_clipping_warning; // 0 = disabled, 1 = enabled

// Smart SDR-to-HDR upmix
uniform int u_smart_upmix; // 0 = simple boost, 1 = smart upmix curve

// Color Grading uniforms
uniform float u_saturation;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_temp;
uniform float u_tint;

// Linear Rec.709 to Linear Rec.2020 transformation matrix
const mat3 RGB709to2020 = mat3(
  0.6274040, 0.0690970, 0.0163916,
  0.3292820, 0.9195400, 0.0880132,
  0.0433136, 0.0113612, 0.8955950
);

// PQ Constants (SMPTE ST 2084)
const float m1 = 0.1593017578125;
const float m2 = 78.84375;
const float c1 = 0.8359375;
const float c2 = 18.8515625;
const float c3 = 18.6875;

vec3 linearToPQ(vec3 linearColor) {
  vec3 cp = pow(max(linearColor, 0.0) / 10000.0, vec3(m1));
  return pow((c1 + c2 * cp) / (1.0 + c3 * cp), vec3(m2));
}

// Tone Mapping Operators
vec3 Reinhard(vec3 color, float white) {
  return color * (vec3(1.0) + color / (white * white)) / (color + vec3(1.0));
}

vec3 ACESFilm(vec3 x, float white) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  vec3 rawAces = clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  
  vec3 w = vec3(white);
  vec3 whiteAces = clamp((w * (a * w + b)) / (w * (c * w + d) + e), 0.0, 1.0);
  return rawAces / whiteAces;
}

vec3 HableOperator(vec3 x) {
  float A = 0.15;
  float B = 0.50;
  float C = 0.10;
  float D = 0.20;
  float E = 0.02;
  float F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

vec3 Hable(vec3 color, float white) {
  return HableOperator(color) / HableOperator(vec3(white));
}

vec3 Lottes(vec3 x, float white) {
  float a = 1.6;
  float d = 0.977;
  float hdrMax = white;
  float midIn = 0.18;
  float midOut = 0.267;

  float denom = pow(hdrMax, a * d) * midOut - pow(midIn, a * d) * midOut;
  denom = max(denom, 1e-5);

  float b = (-pow(midIn, a) + (midOut * pow(hdrMax, a * d) * pow(midIn, a)) / denom) / (pow(midIn, a * d) * midOut);
  float c = (pow(hdrMax, a * d) * pow(midIn, a) - pow(hdrMax, a) * pow(midIn, a * d) * midOut) / denom;

  vec3 z = pow(max(x, vec3(0.0)), vec3(a));
  vec3 mapped = z / (pow(z, vec3(d)) * b + vec3(c));
  return clamp(mapped, 0.0, 1.0);
}

vec3 UchimuraOperator(vec3 x, float P, float a, float m, float l, float c, float b) {
  float l0 = ((P - m) * l) / a;
  float S0 = m + l0;
  float S1 = m + a * l0;
  float C2 = (a * P) / (P - S1);
  float CP = -C2 / P;

  vec3 w0 = 1.0 - smoothstep(0.0, m, x);
  vec3 w2 = step(vec3(m + l0), x);
  vec3 w1 = 1.0 - w0 - w2;

  vec3 T = m * pow(max(x / m, vec3(0.0)), vec3(c)) + b;
  vec3 S = P - (P - S1) * exp(CP * (x - S0));
  vec3 L = m + a * (x - m);

  return T * w0 + L * w1 + S * w2;
}

vec3 Uchimura(vec3 color, float white) {
  // Scale input so that 'white' maps to 5.0 (shoulder saturation point)
  vec3 scaledColor = color * (5.0 / white);
  return UchimuraOperator(scaledColor, 1.0, 1.0, 0.22, 0.4, 1.33, 0.0);
}

// Visualizations color ramp mapping
vec3 getHeatmapColor(float nits) {
  if (nits < 2.0) {
    return mix(vec3(0.08, 0.08, 0.12), vec3(0.0, 0.0, 0.8), nits / 2.0);
  } else if (nits < 80.0) {
    return mix(vec3(0.0, 0.0, 0.8), vec3(0.0, 0.9, 0.9), (nits - 2.0) / 78.0);
  } else if (nits < 203.0) {
    return mix(vec3(0.0, 0.9, 0.9), vec3(0.0, 0.9, 0.0), (nits - 80.0) / 123.0);
  } else if (nits < 500.0) {
    return mix(vec3(0.0, 0.9, 0.0), vec3(0.9, 0.9, 0.0), (nits - 203.0) / 297.0);
  } else if (nits < 1000.0) {
    return mix(vec3(0.9, 0.9, 0.0), vec3(0.9, 0.0, 0.0), (nits - 500.0) / 500.0);
  } else if (nits < 2000.0) {
    return mix(vec3(0.9, 0.0, 0.0), vec3(0.9, 0.0, 0.9), (nits - 1000.0) / 1000.0);
  } else {
    return mix(vec3(0.9, 0.0, 0.9), vec3(1.0, 1.0, 1.0), min(1.0, (nits - 2000.0) / 2000.0));
  }
}

// Compute standard clamped SDR path
vec3 computeSDR(vec3 rawColor) {
  vec3 color = clamp(rawColor, 0.0, 1.0);
  if (u_native_hdr == 1) {
    vec3 colorInNits = color * u_sdr_white;
    vec3 color2020 = RGB709to2020 * colorInNits;
    return linearToPQ(color2020);
  } else {
    return pow(color, vec3(1.0 / 2.2));
  }
}

// Compute processed HDR path with grading and upmixing
vec3 computeHDR(vec3 rawColor, out float outNits, out bool outClipping) {
  // 1. Smart SDR-to-HDR upmix or linear boost
  vec3 color = rawColor;
  if (u_smart_upmix == 1) {
    float L = dot(color, vec3(0.2126, 0.7152, 0.0722));
    if (L > 0.0) {
      float th = 0.75;
      float L_new = L;
      if (L > th) {
        float t = (L - th) / (1.0 - th);
        L_new = th + (L - th) * (1.0 + (u_sdr_boost - 1.0) * t);
      }
      color = color * (L_new / L);
    }
  } else {
    color = color * u_sdr_boost;
  }

  // 2. Exposure Offset (stops)
  color = color * pow(2.0, u_exposure);

  // 3. Color Grading (Temp, Tint, Shadows, Highlights, Saturation)
  color.r += u_temp * 0.12 - u_tint * 0.06;
  color.g += u_tint * 0.12;
  color.b += -u_temp * 0.12 - u_tint * 0.06;
  color = max(color, 0.0);

  float L_grad = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float shadowMask = pow(1.0 - clamp(L_grad, 0.0, 1.0), 2.0);
  float highlightMask = pow(clamp(L_grad, 0.0, 1.0), 2.0);
  color += color * u_shadows * shadowMask;
  color += color * u_highlights * highlightMask;
  color = max(color, 0.0);

  float L_sat = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(L_sat), color, u_saturation);
  color = max(color, 0.0);

  // Save nits before tone mapping
  float finalLuminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  outNits = finalLuminance * u_sdr_white;

  // Determine clipping (exceeding tone mapping white limit)
  float whiteVal = max(0.01, u_tone_map_white);
  outClipping = (color.r > whiteVal || color.g > whiteVal || color.b > whiteVal);

  // 4. Tone Mapping & Color Space encoding
  if (u_native_hdr == 1) {
    vec3 colorInNits = color * u_sdr_white;
    vec3 color2020 = RGB709to2020 * colorInNits;
    return linearToPQ(color2020);
  } else {
    vec3 mapped;
    if (u_tone_mapper == 1) {
      mapped = Reinhard(color, whiteVal);
    } else if (u_tone_mapper == 2) {
      mapped = ACESFilm(color, whiteVal);
    } else if (u_tone_mapper == 3) {
      mapped = Hable(color, whiteVal);
    } else if (u_tone_mapper == 4) {
      mapped = Lottes(color, whiteVal);
    } else if (u_tone_mapper == 5) {
      mapped = Uchimura(color, whiteVal);
    } else {
      mapped = clamp(color, 0.0, 1.0);
    }

    mapped = clamp(mapped, 0.0, 1.0);
    if (u_contrast != 1.0) {
      mapped = pow(mapped, vec3(u_contrast));
    }

    return pow(mapped, vec3(1.0 / u_gamma));
  }
}

void main() {
  // 1. Calculate texture coordinates with aspect ratio correction and pan/zoom
  float effective_canvas_aspect = u_canvas_aspect;
  vec2 effective_v_uv = v_uv;

  if (u_comparison_mode == 2) { // Side-by-Side layout
    effective_canvas_aspect = u_canvas_aspect * 0.5;
    if (v_uv.x < 0.5) {
      effective_v_uv.x = v_uv.x * 2.0;
    } else {
      effective_v_uv.x = (v_uv.x - 0.5) * 2.0;
    }
  }

  // Scale factor to fit image inside canvas viewport
  vec2 aspect_scale = vec2(1.0);
  if (effective_canvas_aspect > u_image_aspect) {
    aspect_scale.x = u_image_aspect / effective_canvas_aspect;
  } else {
    aspect_scale.y = effective_canvas_aspect / u_image_aspect;
  }

  // Adjust center-oriented coordinates
  vec2 uv = (effective_v_uv - vec2(0.5)) / aspect_scale;
  uv = uv / u_zoom + vec2(0.5) - u_pan;

  // 2. Draw Checkerboard background if out of bounds
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    vec2 grid = floor(gl_FragCoord.xy / 16.0);
    float check = mod(grid.x + grid.y, 2.0);
    // Premium dark checkerboard
    vec3 checkColor = mix(vec3(0.08, 0.08, 0.1), vec3(0.13, 0.13, 0.17), check);
    fragColor = vec4(checkColor, 1.0);
    return;
  }

  // 3. Sample float pixel
  vec4 texel = texture(u_image, uv);
  vec3 rawColor = texel.rgb;

  // 4. Determine side and process pixel
  bool isSdrSide = false;
  if (u_comparison_mode == 0) { // Split vertical
    isSdrSide = v_uv.x < u_split_x;
  } else if (u_comparison_mode == 1) { // Split horizontal
    isSdrSide = v_uv.y < u_split_y;
  } else if (u_comparison_mode == 2) { // Side-by-Side
    isSdrSide = v_uv.x < 0.5;
  }

  vec3 processedColor;
  float nits = 0.0;
  bool isClipping = false;

  if (u_comparison_mode == 3) { // Opacity Blend
    vec3 sdrOut = computeSDR(rawColor);
    float hdrNits = 0.0;
    bool hdrClipping = false;
    vec3 hdrOut = computeHDR(rawColor, hdrNits, hdrClipping);
    
    processedColor = mix(sdrOut, hdrOut, u_blend_opacity);
    nits = mix(dot(clamp(rawColor, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722)) * u_sdr_white, hdrNits, u_blend_opacity);
    isClipping = hdrClipping;
  } else {
    if (isSdrSide) {
      processedColor = computeSDR(rawColor);
      nits = dot(clamp(rawColor, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722)) * u_sdr_white;
      isClipping = (rawColor.r > 1.001 || rawColor.g > 1.001 || rawColor.b > 1.001);
    } else {
      processedColor = computeHDR(rawColor, nits, isClipping);
    }
  }

  // 5. Apply Visualizations (Heatmap or Clipping warning)
  if (u_heatmap == 1) {
    processedColor = getHeatmapColor(nits);
    if (u_native_hdr == 1) {
      processedColor = RGB709to2020 * (processedColor * u_sdr_white);
      processedColor = linearToPQ(processedColor);
    }
  } else if (u_clipping_warning == 1 && isClipping) {
    // Neon flashing zebra/pink clipping warn
    processedColor = vec3(1.0, 0.0, 0.4);
    if (u_native_hdr == 1) {
      processedColor = RGB709to2020 * (processedColor * u_sdr_white);
      processedColor = linearToPQ(processedColor);
    }
  }

  // 6. Draw comparison split lines
  bool isSplitLine = false;
  if (u_comparison_mode == 0 && u_split_x > 0.0 && u_split_x < 1.0) {
    isSplitLine = (abs(v_uv.x - u_split_x) < 0.002);
  } else if (u_comparison_mode == 1 && u_split_y > 0.0 && u_split_y < 1.0) {
    isSplitLine = (abs(v_uv.y - u_split_y) < 0.002);
  } else if (u_comparison_mode == 2) {
    isSplitLine = (abs(v_uv.x - 0.5) < 0.002);
  }

  if (isSplitLine) {
    if (u_native_hdr == 1) {
      vec3 cyanColor = vec3(0.0, 0.9, 1.0) * u_sdr_white;
      vec3 cyan2020 = RGB709to2020 * cyanColor;
      fragColor = vec4(linearToPQ(cyan2020), 1.0);
    } else {
      fragColor = vec4(0.0, 0.9, 1.0, 1.0); // Vibrant neon cyan line
    }
  } else {
    fragColor = vec4(processedColor, texel.a);
  }
}
`;

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true // Required for exporting images
    });

    if (!this.gl) {
      throw new Error('WebGL2 is not supported on this browser/hardware.');
    }

    // Enable floating point texture extensions and filtering support
    this.gl.getExtension('EXT_color_buffer_float');
    this.floatLinearExt = this.gl.getExtension('OES_texture_float_linear');
    this.halfFloatLinearExt = this.gl.getExtension('OES_texture_half_float_linear');

    console.log('Lumina HDR Renderer - WebGL Extensions:', {
      EXT_color_buffer_float: !!this.gl.getExtension('EXT_color_buffer_float'),
      OES_texture_float_linear: !!this.floatLinearExt,
      OES_texture_half_float_linear: !!this.halfFloatLinearExt
    });

    this.program = null;
    this.texture = null;
    this.imageWidth = 1;
    this.imageHeight = 1;

    // Camera variables
    this.zoom = 1.0;
    this.panX = 0.0;
    this.panY = 0.0;

    this.initShaders();
    this.initBuffers();
  }

  initShaders() {
    const gl = this.gl;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VERTEX_SHADER_SOURCE);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error('Vertex shader compile error: ' + gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, FRAGMENT_SHADER_SOURCE);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      throw new Error('Fragment shader compile error: ' + gl.getShaderInfoLog(fs));
    }

    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('Shader program linking error: ' + gl.getProgramInfoLog(this.program));
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);
  }

  initBuffers() {
    const gl = this.gl;
    const vertices = new Float32Array([
      -1.0, -1.0,
       1.0, -1.0,
      -1.0,  1.0,
      -1.0,  1.0,
       1.0, -1.0,
       1.0,  1.0,
    ]);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const positionAttributeLocation = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);
  }

  /**
   * Uploads floating-point RGBA image data to GPU.
   * @param {number} width 
   * @param {number} height 
   * @param {Float32Array} floatData 
   */
  setImage(width, height, floatData) {
    const gl = this.gl;
    this.imageWidth = width;
    this.imageHeight = height;

    if (this.texture) {
      gl.deleteTexture(this.texture);
    }

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    // Set texture wrapping to clamp
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Determine internal format and filtering mode based on browser extensions
    let internalFormat = gl.RGBA32F;
    let filterMode = gl.NEAREST;

    if (this.floatLinearExt) {
      // Browser supports linear filtering on 32-bit floats
      internalFormat = gl.RGBA32F;
      filterMode = gl.LINEAR;
    } else if (this.halfFloatLinearExt) {
      // Browser supports linear filtering on 16-bit half-floats.
      // WebGL2 automatically converts FLOAT -> HALF_FLOAT during upload.
      internalFormat = gl.RGBA16F;
      filterMode = gl.LINEAR;
    } else {
      // No float linear filtering support at all. Fall back to nearest filtering.
      internalFormat = gl.RGBA32F;
      filterMode = gl.NEAREST;
      console.warn('Lumina HDR Renderer - Float texture linear filtering is not supported on this browser/hardware. Falling back to NEAREST filtering.');
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);

    // Upload as floating point RGBA texture
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      width,
      height,
      0,
      gl.RGBA,
      gl.FLOAT,
      floatData
    );

    // Reset pan & zoom when loading a new image
    this.resetView();
  }

  resetView() {
    this.zoom = 1.0;
    this.panX = 0.0;
    this.panY = 0.0;
  }

  setPan(x, y) {
    this.panX = x;
    this.panY = y;
  }

  setZoom(level) {
    this.zoom = Math.max(0.1, Math.min(50.0, level));
  }

  /**
   * Resize the WebGL canvas drawing buffer to match its display size.
   */
  resize() {
    const canvas = this.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      this.gl.viewport(0, 0, width, height);
    }
  }

  /**
   * Render the image with parameters.
   * @param {{
   *   exposure: number,
   *   gamma: number,
   *   contrast: number,
   *   sdrBoost: number,
   *   toneMapper: number,
   *   splitX: number
   * }} options 
   */
  render(options, isExport = false) {
    const gl = this.gl;
    if (!isExport) {
      this.resize();
    } else {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!this.texture) return;

    gl.useProgram(this.program);

    // Set layout uniforms
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_zoom'), this.zoom);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_pan'), this.panX, this.panY);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_image_aspect'), this.imageWidth / this.imageHeight);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_canvas_aspect'), this.canvas.width / this.canvas.height);

    // Set tone mapping parameter uniforms
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_exposure'), options.exposure);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gamma'), options.gamma);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_contrast'), options.contrast);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_sdr_boost'), options.sdrBoost);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_tone_mapper'), options.toneMapper);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_tone_map_white'), options.toneMapWhite || 5.0);

    // Set split-screen divider position
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_split_x'), options.splitX);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_split_y'), options.splitY !== undefined ? options.splitY : 0.5);

    // Set comparison mode and blend opacity
    let compMode = 0;
    if (options.previewMode === 'split') compMode = 0;
    else if (options.previewMode === 'split-h') compMode = 1;
    else if (options.previewMode === 'side-by-side') compMode = 2;
    else if (options.previewMode === 'blend') compMode = 3;
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_comparison_mode'), compMode);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_blend_opacity'), options.blendOpacity !== undefined ? options.blendOpacity : 0.5);

    // Set native HDR uniforms
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_native_hdr'), options.nativeHdr ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_sdr_white'), options.sdrWhite || 200.0);

    // Set visualization overlays
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_heatmap'), options.heatmap ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_clipping_warning'), options.clippingWarning ? 1 : 0);

    // Set smart upmix uniform
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_smart_upmix'), options.smartUpmix ? 1 : 0);

    // Set color grading uniforms
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_saturation'), options.saturation !== undefined ? options.saturation : 1.0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_highlights'), options.highlights !== undefined ? options.highlights : 0.0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_shadows'), options.shadows !== undefined ? options.shadows : 0.0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_temp'), options.temp !== undefined ? options.temp : 0.0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_tint'), options.tint !== undefined ? options.tint : 0.0);

    // Bind texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);

    // Draw full-screen quad
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Returns standard 8-bit RGBA pixel data currently rendered in the viewport.
   * Useful for exporting the tone-mapped SDR image.
   * @returns {Uint8ClampedArray}
   */
  readPixels() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // WebGL reads pixels bottom-to-top, so we flip the rows vertically
    const flippedPixels = new Uint8ClampedArray(w * h * 4);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const srcRow = y * rowBytes;
      const dstRow = (h - 1 - y) * rowBytes;
      flippedPixels.set(pixels.subarray(srcRow, srcRow + rowBytes), dstRow);
    }

    return flippedPixels;
  }
}
