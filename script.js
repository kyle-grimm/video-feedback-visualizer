'use strict';

// ===================================================================
// Video Feedback Visualizer
// See DESIGN.md for the full design (ping-pong framebuffer technique,
// GLSL formula reference, pipeline order, non-goals for v1).
//
// File is organized top-to-bottom as:
//   1. WebGL2 boilerplate (context, shader/program compile helpers)
//   2. Ping-pong framebuffer management
//   3. GLSL source (vertex, feedback fragment, display fragment)
//   4. Parameter state + defaults
//   5. Knob widgets (generic, bound directly to the params object)
//   6. Control panel construction
//   7. Uniform upload + render loop
//   8. Header actions (pause/freeze/reset), presets, randomize
// ===================================================================

const canvas = document.getElementById('gl');
const panel = document.getElementById('panel');
const W = canvas.width, H = canvas.height;

const gl = canvas.getContext('webgl2');
if (!gl) {
  const err = document.createElement('div');
  err.className = 'gl-error';
  err.textContent = 'WebGL2 is not available in this browser, so the visualizer cannot run here.';
  panel.prepend(err);
  throw new Error('WebGL2 not available');
}

// -------------------------------------------------------------
// 1. WebGL2 boilerplate
// -------------------------------------------------------------
function compileShader(type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error:\n${info}\n---\n${source}`);
  }
  return sh;
}

function linkProgram(vsSource, fsSource) {
  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    throw new Error(`Program link error:\n${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function uniformLocations(prog, names) {
  const locs = {};
  for (const name of names) locs[name] = gl.getUniformLocation(prog, name);
  return locs;
}

// A full-screen triangle needs no vertex buffer at all - positions are
// computed from gl_VertexID in the vertex shader. WebGL2 always has a
// default vertex array object bound, so drawArrays(TRIANGLES, 0, 3)
// with zero attributes just works.
function drawFullscreenTriangle() {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// -------------------------------------------------------------
// 2. Ring-buffer framebuffers
//
// Feedback (reading "last frame" while writing "this frame") needs at
// least two framebuffers so a shader never reads and writes the same
// texture in one draw call - see DESIGN.md section 2. This is that
// same ping-pong technique generalized from 2 slots to RING_SIZE
// slots: each frame writes into the next slot and reads from
// `1 + delay` slots behind it, so `delay = 0` reads the
// most-recently-completed frame (identical to plain 2-buffer
// ping-pong) and a higher `delay` reads further into the past,
// producing an echo/stutter instead of smooth persistence decay.
// RGBA8 color only, no depth/stencil (this is a pure 2D compositor).
// -------------------------------------------------------------
const RING_SIZE = 32; // ~0.5s of history at 60fps; 4MB/slot at 1000x1000 RGBA8

function createFBO(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex };
}

function clearFBO(target) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function createRingBuffers() {
  return Array.from({ length: RING_SIZE }, () => createFBO(W, H));
}

function wrapIndex(i, n) { return ((i % n) + n) % n; }

let buffers = createRingBuffers();
let ringWriteIndex = 0;
for (const b of buffers) clearFBO(b);

// -------------------------------------------------------------
// 3. GLSL source
// -------------------------------------------------------------
const VERTEX_SRC = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 pos[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  vec2 p = pos[gl_VertexID];
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// 2D simplex noise - standard public implementation (Ian McEwan /
// Stefan Gustavson, MIT-licensed webgl-noise), reused as-is since it's
// the common-knowledge reference implementation rather than anything
// specific to Hydra.
const SIMPLEX_NOISE_GLSL = `
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}`;

// Transform / color / blend math restated from hydra-synth's
// glsl-functions.js (MIT license, see DESIGN.md section 5) as explicit
// named GLSL functions - not Hydra's implicit-argument macro system.
const FEEDBACK_FRAGMENT_SRC = `#version 300 es
precision highp float;

uniform sampler2D u_prevFrame;
uniform vec2  u_resolution;
uniform float u_time;

// feedback
uniform float u_feedback;
uniform float u_zoom;
uniform float u_rotate;
uniform vec2  u_translate;
uniform float u_hueDrift;

// generator
uniform int   u_genType; // 0 osc, 1 noise, 2 shape, 3 gradient, 4 solid, 5 camera
uniform float u_frequency;
uniform float u_speed;
uniform float u_sync;
uniform float u_shapeSides;
uniform float u_shapeSmoothing;
uniform float u_noiseScale;
uniform vec3  u_solidColor;
uniform sampler2D u_camera;
uniform float u_cameraAspect;

// color
uniform float u_hue;
uniform float u_saturate;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_invertAmount;

// chromakey
uniform float u_chromakeyEnabled;
uniform vec3  u_chromakeyColor;
uniform float u_chromakeyThreshold;
uniform float u_chromakeySoftness;

// blend
uniform int   u_blendMode; // 0 mix, 1 add, 2 mult, 3 diff
uniform float u_modulateAmount;

in vec2 v_uv;
out vec4 fragColor;

${SIMPLEX_NOISE_GLSL}

vec2 rotateUV(vec2 st, float angle) {
  vec2 xy = st - 0.5;
  float c = cos(angle), s = sin(angle);
  xy = mat2(c, -s, s, c) * xy;
  return xy + 0.5;
}

vec2 scaleUV(vec2 st, float amount, vec2 offset) {
  vec2 xy = st - offset;
  xy *= 1.0 / max(amount, 0.0001);
  return xy + offset;
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 hueRotate(vec3 rgb, float hue) {
  vec3 hsv = rgb2hsv(clamp(rgb, 0.0, 1.0));
  hsv.x = fract(hsv.x + hue);
  return hsv2rgb(hsv);
}

vec3 saturateColor(vec3 c, float amount) {
  const vec3 W = vec3(0.2125, 0.7154, 0.0721);
  vec3 gray = vec3(dot(c, W));
  return mix(gray, c, amount);
}

vec3 brightnessColor(vec3 c, float amount) { return c + amount; }

vec3 contrastColor(vec3 c, float amount) { return (c - 0.5) * amount + 0.5; }

vec3 invertColor(vec3 c, float amount) { return (1.0 - c) * amount + c * (1.0 - amount); }

vec2 modulateUV(vec2 st, vec4 b, float amount) { return st + b.xy * amount; }

vec4 blendFn(vec4 prev, vec4 gen, int mode, float feedback) {
  if (mode == 1) return vec4(prev.rgb * feedback + gen.rgb, 1.0);
  if (mode == 2) return vec4(mix(gen.rgb, prev.rgb * gen.rgb, feedback), 1.0);
  if (mode == 3) return vec4(mix(gen.rgb, abs(prev.rgb - gen.rgb), feedback), 1.0);
  return vec4(mix(gen.rgb, prev.rgb, feedback), 1.0);
}

vec4 genOsc(vec2 st) {
  float phase = u_time * u_speed;
  float r = sin((st.x * u_frequency + phase) * 6.28318530718) * 0.5 + 0.5;
  float g = sin((st.x * u_frequency + phase + u_sync) * 6.28318530718) * 0.5 + 0.5;
  float b = sin((st.x * u_frequency + phase + u_sync * 2.0) * 6.28318530718) * 0.5 + 0.5;
  return vec4(r, g, b, 1.0);
}

vec4 genNoise(vec2 st) {
  vec2 p = st * u_noiseScale;
  float t = u_time * u_speed;
  float nr = snoise(p + vec2(t, 0.0)) * 0.5 + 0.5;
  float ng = snoise(p + vec2(0.0, t) + 5.2) * 0.5 + 0.5;
  float nb = snoise(p + vec2(t * 0.7, t * 0.3) + 9.7) * 0.5 + 0.5;
  return vec4(nr, ng, nb, 1.0);
}

vec4 genShape(vec2 st) {
  vec2 c = st - 0.5;
  float a = atan(c.x, c.y) + 3.14159265359;
  float r = 6.28318530718 / max(u_shapeSides, 3.0);
  float d = cos(floor(0.5 + a / r) * r - a) * length(c);
  float s = smoothstep(0.3, 0.3 - max(u_shapeSmoothing, 0.001), d);
  return vec4(vec3(s), 1.0);
}

vec4 genGradient(vec2 st) {
  float hue = fract(st.x + st.y * 0.5 + u_time * u_speed);
  return vec4(hsv2rgb(vec3(hue, 1.0, 1.0)), 1.0);
}

// Mirrored (selfie-style) cover-fit sample of the live camera texture:
// the canvas is a 1:1 square, so a non-square camera frame gets its
// long axis center-cropped rather than squashed to fit. Y is flipped
// because texImage2D uploads a <video> frame top-row-first while our
// v_uv convention has v=0 at the bottom, so an unflipped sample comes
// out upside down.
vec4 genCamera(vec2 st) {
  vec2 uv = vec2(1.0 - st.x, 1.0 - st.y);
  vec2 scale = u_cameraAspect > 1.0 ? vec2(1.0 / u_cameraAspect, 1.0) : vec2(1.0, u_cameraAspect);
  uv = (uv - 0.5) * scale + 0.5;
  return texture(u_camera, uv);
}

vec4 generate(vec2 st) {
  if (u_genType == 1) return genNoise(st);
  if (u_genType == 2) return genShape(st);
  if (u_genType == 3) return genGradient(st);
  if (u_genType == 4) return vec4(u_solidColor, 1.0);
  if (u_genType == 5) return genCamera(st);
  return genOsc(st);
}

void main() {
  vec2 uv = v_uv;

  vec4 gen = generate(uv);
  gen.rgb = hueRotate(gen.rgb, u_hue);

  // Feedback read: rotate/zoom/translate a little further from last
  // frame's image each frame - this is the actual "video feedback" step.
  vec2 fbUV = uv;
  fbUV = rotateUV(fbUV, u_rotate);
  fbUV = scaleUV(fbUV, u_zoom, vec2(0.5));
  fbUV += u_translate;
  if (u_modulateAmount > 0.0001) fbUV = modulateUV(fbUV, gen, u_modulateAmount);

  vec4 prev = texture(u_prevFrame, fract(fbUV));
  prev.rgb = hueRotate(prev.rgb, u_hueDrift);

  // Chromakey: pixels of the fresh generator layer close to the key
  // color are replaced with the feedback-read color instead, so a
  // keyed color (e.g. a camera's green-screen background) shows the
  // swirling feedback through it rather than flat color every frame.
  if (u_chromakeyEnabled >= 0.5) {
    float dist = length(gen.rgb - u_chromakeyColor);
    float keyMask = smoothstep(u_chromakeyThreshold - u_chromakeySoftness, u_chromakeyThreshold + u_chromakeySoftness, dist);
    gen.rgb = mix(prev.rgb, gen.rgb, keyMask);
  }

  vec4 result = blendFn(prev, gen, u_blendMode, u_feedback);

  result.rgb = saturateColor(result.rgb, u_saturate);
  result.rgb = brightnessColor(result.rgb, u_brightness);
  result.rgb = contrastColor(result.rgb, u_contrast);
  result.rgb = invertColor(result.rgb, u_invertAmount);
  result.rgb = clamp(result.rgb, 0.0, 1.0);
  result.a = 1.0;

  fragColor = result;
}`;

// Post-fx (scanlines/vignette/chroma-offset/grain) was removed along
// with the whole Post FX section - this pass is now just a plain blit
// of the feedback FBO to the visible canvas.
const DISPLAY_FRAGMENT_SRC = `#version 300 es
precision highp float;

uniform sampler2D u_frame;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = texture(u_frame, v_uv);
}`;

const feedbackProgram = linkProgram(VERTEX_SRC, FEEDBACK_FRAGMENT_SRC);
const displayProgram = linkProgram(VERTEX_SRC, DISPLAY_FRAGMENT_SRC);

const feedbackUniforms = uniformLocations(feedbackProgram, [
  'u_prevFrame', 'u_resolution', 'u_time',
  'u_feedback', 'u_zoom', 'u_rotate', 'u_translate', 'u_hueDrift',
  'u_genType', 'u_frequency', 'u_speed', 'u_sync', 'u_shapeSides', 'u_shapeSmoothing',
  'u_noiseScale', 'u_solidColor', 'u_camera', 'u_cameraAspect',
  'u_hue', 'u_saturate', 'u_brightness', 'u_contrast', 'u_invertAmount',
  'u_chromakeyEnabled', 'u_chromakeyColor', 'u_chromakeyThreshold', 'u_chromakeySoftness',
  'u_blendMode', 'u_modulateAmount',
]);
const displayUniforms = uniformLocations(displayProgram, ['u_frame']);

// -------------------------------------------------------------
// 4. Parameter state + defaults
// -------------------------------------------------------------
const GEN_TYPES = ['osc', 'noise', 'shape', 'gradient', 'solid', 'camera'];
const BLEND_MODES = ['mix', 'add', 'mult', 'diff'];

// -------------------------------------------------------------
// Live camera source. A plain (non-FBO) texture uploaded from a hidden
// <video> element each frame while a getUserMedia stream is active;
// defaults to a 1x1 black pixel so selecting "Camera" before enabling
// it just renders black instead of erroring.
// -------------------------------------------------------------
const cameraVideo = document.createElement('video');
cameraVideo.autoplay = true;
cameraVideo.playsInline = true;
cameraVideo.muted = true;

function createCameraTexture() {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  return tex;
}
let cameraTexture = createCameraTexture();
let cameraStream = null;
let cameraReady = false;
let cameraAspect = 1.0;

function updateCameraTexture() {
  if (!cameraReady || cameraVideo.readyState < 2) return; // HAVE_CURRENT_DATA
  if (cameraVideo.videoWidth && cameraVideo.videoHeight) {
    cameraAspect = cameraVideo.videoWidth / cameraVideo.videoHeight;
  }
  gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cameraVideo);
}

window.addEventListener('beforeunload', () => {
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
});

const DEFAULTS = {
  feedback: 0.94, delay: 0, zoom: 1.012, rotate: 0.012, translateX: 0.0, translateY: 0.0, hueDrift: 0.01,
  genType: 'osc', frequency: 8, speed: 0.3, sync: 0.2,
  shapeSides: 5, shapeSmoothing: 0.05, noiseScale: 4,
  solidR: 1.0, solidG: 0.4, solidB: 0.1,
  hue: 0.0, saturate: 1.1, brightness: 0.0, contrast: 1.03, invertAmount: 0,
  chromakeyEnabled: 0, keyR: 0.0, keyG: 1.0, keyB: 0.0, chromakeyThreshold: 0.4, chromakeySoftness: 0.15,
  blendMode: 'mix', modulateAmount: 0.15,
};
const params = { ...DEFAULTS };

// -------------------------------------------------------------
// 5. Knob widgets - bound directly to `params[key]`, no hidden native
// inputs to shadow (unlike the sibling oscilloscope app, there's no
// native form control this project needs to stay compatible with).
// -------------------------------------------------------------
const KNOB_ANGLE_MIN = -132;
const KNOB_ANGLE_MAX = 132;
const KNOB_FULL_SWEEP_PX = 220;
const KNOB_OPTION_STEP_PX = 18;
const FINE_DRAG_FACTOR = 0.1;

const knobControls = []; // { render } - called after any programmatic param change
const registry = {};     // key -> { min, max, step } | { options }

function createKnobTooltip(dial) {
  const tip = document.createElement('div');
  tip.className = 'knob-tooltip';
  tip.style.display = 'none';
  dial.appendChild(tip);
  return {
    show(text) { tip.textContent = text; tip.style.display = 'block'; },
    update(text) { tip.textContent = text; },
    hide() { tip.style.display = 'none'; },
  };
}

function defaultFormat(v, step) {
  if (step >= 1) return String(Math.round(v));
  return v.toFixed(step >= 0.01 ? 2 : 3);
}

function createKnobRow(parent, { key, label, min, max, step, format, snapZero }) {
  registry[key] = { type: 'value', min, max, step };

  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);

  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap';
  const dial = document.createElement('div');
  dial.className = 'knob-dial' + (snapZero ? ' has-notch' : '');
  const indicator = document.createElement('div');
  indicator.className = 'knob-indicator';
  dial.appendChild(indicator);
  wrap.appendChild(dial);
  row.appendChild(wrap);

  const readout = document.createElement('div');
  readout.className = 'readout';
  row.appendChild(readout);
  parent.appendChild(row);

  const tooltip = createKnobTooltip(dial);
  const fmt = format || ((v) => defaultFormat(v, step));

  function render() {
    const frac = max > min ? (params[key] - min) / (max - min) : 0;
    dial.style.transform = `rotate(${KNOB_ANGLE_MIN + frac * (KNOB_ANGLE_MAX - KNOB_ANGLE_MIN)}deg)`;
    readout.textContent = fmt(params[key]);
  }
  render();

  const snapWindow = (max - min) * 0.035;
  function setValue(v) {
    v = Math.round(Math.min(max, Math.max(min, v)) / step) * step;
    if (snapZero && Math.abs(v) < snapWindow) v = 0;
    params[key] = v;
    render();
  }

  let dragging = false, startY = 0, startVal = 0, fine = false;
  dial.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startVal = params[key];
    fine = e.shiftKey;
    dial.setPointerCapture(e.pointerId);
    tooltip.show(readout.textContent);
    e.preventDefault();
  });
  dial.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const sensitivity = fine ? FINE_DRAG_FACTOR : 1;
    setValue(startVal + ((startY - e.clientY) / KNOB_FULL_SWEEP_PX) * (max - min) * sensitivity);
    tooltip.update(readout.textContent);
  });
  dial.addEventListener('pointerup', (e) => {
    dragging = false;
    tooltip.hide();
    try { dial.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  });
  dial.addEventListener('wheel', (e) => {
    e.preventDefault();
    setValue(params[key] + (e.deltaY < 0 ? step : -step));
  }, { passive: false });

  const control = { render };
  knobControls.push(control);
  return control;
}

function createSelectKnobRow(parent, { key, label, options }) {
  registry[key] = { type: 'select', options };

  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);

  const selWrap = document.createElement('div');
  selWrap.className = 'knob-select';
  const dial = document.createElement('div');
  dial.className = 'knob-dial';
  const indicator = document.createElement('div');
  indicator.className = 'knob-indicator';
  dial.appendChild(indicator);
  const readout = document.createElement('div');
  readout.className = 'knob-readout';
  selWrap.appendChild(dial);
  selWrap.appendChild(readout);
  row.appendChild(selWrap);
  parent.appendChild(row);

  const tooltip = createKnobTooltip(dial);

  function currentIndex() {
    const i = options.findIndex((o) => o.value === params[key]);
    return i < 0 ? 0 : i;
  }

  function render() {
    const index = currentIndex();
    const frac = options.length > 1 ? index / (options.length - 1) : 0.5;
    dial.style.transform = `rotate(${KNOB_ANGLE_MIN + frac * (KNOB_ANGLE_MAX - KNOB_ANGLE_MIN)}deg)`;
    readout.textContent = options[index].label;
  }
  render();

  function setIndex(newIndex) {
    newIndex = Math.max(0, Math.min(options.length - 1, newIndex));
    if (options[newIndex].value !== params[key]) {
      params[key] = options[newIndex].value;
      render();
    }
  }

  let dragging = false, startY = 0, startIndex = 0;
  dial.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startIndex = currentIndex();
    dial.setPointerCapture(e.pointerId);
    tooltip.show(readout.textContent);
    e.preventDefault();
  });
  dial.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setIndex(startIndex + Math.round((startY - e.clientY) / KNOB_OPTION_STEP_PX));
    tooltip.update(readout.textContent);
  });
  dial.addEventListener('pointerup', (e) => {
    dragging = false;
    tooltip.hide();
    try { dial.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  });
  dial.addEventListener('wheel', (e) => {
    e.preventDefault();
    setIndex(currentIndex() + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  const control = { render };
  knobControls.push(control);
  return control;
}

function renderAllKnobs() {
  for (const c of knobControls) c.render();
}

// Small helper for the Moog-Grandmother-style colored generator
// "fields" (see DESIGN.md/style.css .gen-field*) - a labeled, tinted
// sub-panel inside the Generator fieldset that groups one generator
// type's own parameters.
function createGenField(parent, colorClass, label) {
  const field = document.createElement('div');
  field.className = `gen-field ${colorClass}`;
  const cap = document.createElement('div');
  cap.className = 'gen-field-label';
  cap.textContent = label;
  field.appendChild(cap);
  parent.appendChild(field);
  return field;
}

// -------------------------------------------------------------
// 6. Control panel construction
// -------------------------------------------------------------
const groups = {
  feedback: document.getElementById('feedbackGroup'),
  generator: document.getElementById('generatorGroup'),
  color: document.getElementById('colorGroup'),
  chromakey: document.getElementById('chromakeyGroup'),
  blend: document.getElementById('blendGroup'),
};

createKnobRow(groups.feedback, { key: 'feedback', label: 'Persistence', min: 0, max: 1, step: 0.005 });
createKnobRow(groups.feedback, { key: 'delay', label: 'Delay', min: 0, max: RING_SIZE - 2, step: 1, format: (v) => (v < 0.5 ? 'Live' : `${Math.round(v)}f`) });
createKnobRow(groups.feedback, { key: 'zoom', label: 'Zoom', min: 0.9, max: 1.1, step: 0.001 });
createKnobRow(groups.feedback, { key: 'rotate', label: 'Rotate', min: -0.2, max: 0.2, step: 0.001, snapZero: true });
createKnobRow(groups.feedback, { key: 'translateX', label: 'Drift X', min: -0.02, max: 0.02, step: 0.0005, snapZero: true });
createKnobRow(groups.feedback, { key: 'translateY', label: 'Drift Y', min: -0.02, max: 0.02, step: 0.0005, snapZero: true });
createKnobRow(groups.feedback, { key: 'hueDrift', label: 'Hue Drift', min: -0.05, max: 0.05, step: 0.001, snapZero: true });

createSelectKnobRow(groups.generator, { key: 'genType', label: 'Type', options: GEN_TYPES.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) });
createKnobRow(groups.generator, { key: 'speed', label: 'Speed', min: -2, max: 2, step: 0.01, snapZero: true });

const cameraField = createGenField(groups.generator, 'gen-field-camera', 'Camera');
const cameraRow = document.createElement('div');
cameraRow.className = 'row';
const cameraLabel = document.createElement('label');
cameraLabel.textContent = 'Enable';
cameraRow.appendChild(cameraLabel);
const cameraBtn = document.createElement('button');
cameraBtn.type = 'button';
cameraBtn.className = 'wide-btn ghost';
cameraBtn.style.flex = '1 1 auto';
cameraBtn.textContent = 'Enable';
cameraRow.appendChild(cameraBtn);
cameraField.appendChild(cameraRow);

const cameraHint = document.createElement('div');
cameraHint.className = 'hint';
cameraHint.style.margin = '-2px 0 6px';
cameraField.appendChild(cameraHint);

cameraBtn.addEventListener('click', async () => {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    cameraReady = false;
    cameraBtn.textContent = 'Enable';
    cameraBtn.classList.remove('active');
    cameraHint.textContent = '';
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraHint.textContent = 'Camera not available (needs a secure context / supported browser).';
    return;
  }
  cameraBtn.disabled = true;
  cameraHint.textContent = 'Requesting camera access...';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    cameraStream = stream;
    cameraVideo.srcObject = stream;
    await cameraVideo.play();
    cameraReady = true;
    cameraBtn.textContent = 'Disable';
    cameraBtn.classList.add('active');
    cameraHint.textContent = 'Camera active - set Type to Camera above.';
  } catch (err) {
    cameraHint.textContent = `Camera error: ${err.message || err.name || 'permission denied'}`;
  } finally {
    cameraBtn.disabled = false;
  }
});

const oscField = createGenField(groups.generator, 'gen-field-osc', 'Oscillator');
createKnobRow(oscField, { key: 'frequency', label: 'Frequency', min: 1, max: 40, step: 1 });
createKnobRow(oscField, { key: 'sync', label: 'Osc Sync', min: 0, max: 2, step: 0.01 });

const noiseField = createGenField(groups.generator, 'gen-field-noise', 'Noise');
createKnobRow(noiseField, { key: 'noiseScale', label: 'Noise Scale', min: 0.5, max: 20, step: 0.1 });

const shapeField = createGenField(groups.generator, 'gen-field-shape', 'Shape');
createKnobRow(shapeField, { key: 'shapeSides', label: 'Shape Sides', min: 3, max: 12, step: 1 });
createKnobRow(shapeField, { key: 'shapeSmoothing', label: 'Shape Soft', min: 0.001, max: 0.3, step: 0.001 });

const solidField = createGenField(groups.generator, 'gen-field-solid', 'Solid');
createKnobRow(solidField, { key: 'solidR', label: 'Solid R', min: 0, max: 1, step: 0.01 });
createKnobRow(solidField, { key: 'solidG', label: 'Solid G', min: 0, max: 1, step: 0.01 });
createKnobRow(solidField, { key: 'solidB', label: 'Solid B', min: 0, max: 1, step: 0.01 });

createKnobRow(groups.color, { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.005 });
createKnobRow(groups.color, { key: 'saturate', label: 'Saturate', min: 0, max: 2, step: 0.01 });
createKnobRow(groups.color, { key: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.01, snapZero: true });
createKnobRow(groups.color, { key: 'contrast', label: 'Contrast', min: 0.5, max: 1.5, step: 0.005 });
createKnobRow(groups.color, { key: 'invertAmount', label: 'Invert', min: 0, max: 1, step: 0.01 });

createKnobRow(groups.chromakey, { key: 'chromakeyEnabled', label: 'Enable', min: 0, max: 1, step: 1, format: (v) => (v >= 0.5 ? 'On' : 'Off') });
createKnobRow(groups.chromakey, { key: 'keyR', label: 'Key R', min: 0, max: 1, step: 0.01 });
createKnobRow(groups.chromakey, { key: 'keyG', label: 'Key G', min: 0, max: 1, step: 0.01 });
createKnobRow(groups.chromakey, { key: 'keyB', label: 'Key B', min: 0, max: 1, step: 0.01 });
createKnobRow(groups.chromakey, { key: 'chromakeyThreshold', label: 'Threshold', min: 0, max: 1.5, step: 0.01 });
createKnobRow(groups.chromakey, { key: 'chromakeySoftness', label: 'Softness', min: 0.001, max: 0.5, step: 0.005 });

createSelectKnobRow(groups.blend, { key: 'blendMode', label: 'Mode', options: BLEND_MODES.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) });
createKnobRow(groups.blend, { key: 'modulateAmount', label: 'Modulate', min: 0, max: 1, step: 0.005, format: (v) => (v < 0.005 ? 'Off' : v.toFixed(3)) });

// -------------------------------------------------------------
// 7. Uniform upload + render loop
// -------------------------------------------------------------
function uploadFeedbackUniforms(t) {
  const u = feedbackUniforms;
  gl.uniform1i(u.u_prevFrame, 0);
  gl.uniform2f(u.u_resolution, W, H);
  gl.uniform1f(u.u_time, t);
  gl.uniform1f(u.u_feedback, params.feedback);
  gl.uniform1f(u.u_zoom, params.zoom);
  gl.uniform1f(u.u_rotate, params.rotate);
  gl.uniform2f(u.u_translate, params.translateX, params.translateY);
  gl.uniform1f(u.u_hueDrift, params.hueDrift);
  gl.uniform1i(u.u_genType, GEN_TYPES.indexOf(params.genType));
  gl.uniform1f(u.u_frequency, params.frequency);
  gl.uniform1f(u.u_speed, params.speed);
  gl.uniform1f(u.u_sync, params.sync);
  gl.uniform1f(u.u_shapeSides, params.shapeSides);
  gl.uniform1f(u.u_shapeSmoothing, params.shapeSmoothing);
  gl.uniform1f(u.u_noiseScale, params.noiseScale);
  gl.uniform3f(u.u_solidColor, params.solidR, params.solidG, params.solidB);
  gl.uniform1i(u.u_camera, 1);
  gl.uniform1f(u.u_cameraAspect, cameraAspect);
  gl.uniform1f(u.u_hue, params.hue);
  gl.uniform1f(u.u_saturate, params.saturate);
  gl.uniform1f(u.u_brightness, params.brightness);
  gl.uniform1f(u.u_contrast, params.contrast);
  gl.uniform1f(u.u_invertAmount, params.invertAmount);
  gl.uniform1f(u.u_chromakeyEnabled, params.chromakeyEnabled);
  gl.uniform3f(u.u_chromakeyColor, params.keyR, params.keyG, params.keyB);
  gl.uniform1f(u.u_chromakeyThreshold, params.chromakeyThreshold);
  gl.uniform1f(u.u_chromakeySoftness, params.chromakeySoftness);
  gl.uniform1i(u.u_blendMode, BLEND_MODES.indexOf(params.blendMode));
  gl.uniform1f(u.u_modulateAmount, params.modulateAmount);
}

function uploadDisplayUniforms() {
  gl.uniform1i(displayUniforms.u_frame, 0);
}

let lastWritten = buffers[0];

function renderFeedbackPass(t) {
  const writeIndex = ringWriteIndex;
  // delay=0 reads slot (writeIndex - 1): the most recently completed
  // frame, same as plain 2-buffer ping-pong. Higher delay reads further
  // back in the ring. Knob is capped at RING_SIZE-2 so this can never
  // land on writeIndex itself (reading the texture we're about to
  // write to in the same draw call is invalid).
  const delayFrames = Math.round(params.delay);
  const readIndex = wrapIndex(writeIndex - 1 - delayFrames, RING_SIZE);
  const write = buffers[writeIndex];
  const read = buffers[readIndex];
  gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
  gl.viewport(0, 0, W, H);
  gl.useProgram(feedbackProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, read.tex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
  uploadFeedbackUniforms(t);
  drawFullscreenTriangle();
  lastWritten = write;
  ringWriteIndex = wrapIndex(ringWriteIndex + 1, RING_SIZE);
}

function renderDisplayPass() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.useProgram(displayProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, lastWritten.tex);
  uploadDisplayUniforms();
  drawFullscreenTriangle();
}

let simTime = 0;
let lastNow = performance.now();
let timePaused = false;
let frozen = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastNow) / 1000, 0.1);
  lastNow = now;
  if (!timePaused) simTime += dt;
  if (frozen) return;
  updateCameraTexture();
  renderFeedbackPass(simTime);
  renderDisplayPass();
}
requestAnimationFrame((now) => { lastNow = now; requestAnimationFrame(frame); });

// Recover from a lost WebGL context (e.g. GPU driver reset on
// resize/tab-switch) by recreating the ring buffers - otherwise the
// canvas just freezes on black with no obvious cause.
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); frozen = true; }, false);
canvas.addEventListener('webglcontextrestored', () => {
  buffers = createRingBuffers();
  ringWriteIndex = 0;
  for (const b of buffers) clearFBO(b);
  lastWritten = buffers[0];
  cameraTexture = createCameraTexture();
  frozen = false;
}, false);

// -------------------------------------------------------------
// 8. Header actions, presets, randomize
// -------------------------------------------------------------
const pauseBtn = document.getElementById('pauseBtn');
const freezeBtn = document.getElementById('freezeBtn');
const resetBtn = document.getElementById('resetBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const stageEl = document.getElementById('stage');

// Vendor-prefixed fallback only matters for older Safari; every other
// current browser exposes the unprefixed Fullscreen API.
function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

fullscreenBtn.addEventListener('click', () => {
  if (!currentFullscreenElement()) {
    const request = stageEl.requestFullscreen || stageEl.webkitRequestFullscreen;
    request.call(stageEl);
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    exit.call(document);
  }
});

function syncFullscreenBtn() {
  const active = currentFullscreenElement() === stageEl;
  fullscreenBtn.classList.toggle('active', active);
  fullscreenBtn.textContent = active ? 'Exit Fullscreen' : 'Fullscreen';
}
document.addEventListener('fullscreenchange', syncFullscreenBtn);
document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);

pauseBtn.addEventListener('click', () => {
  timePaused = !timePaused;
  pauseBtn.classList.toggle('active', timePaused);
  pauseBtn.textContent = timePaused ? 'Resume Time' : 'Pause Time';
});

freezeBtn.addEventListener('click', () => {
  frozen = !frozen;
  freezeBtn.classList.toggle('active', frozen);
  freezeBtn.textContent = frozen ? 'Unfreeze' : 'Freeze';
});

resetBtn.addEventListener('click', () => {
  Object.assign(params, DEFAULTS);
  renderAllKnobs();
  for (const b of buffers) clearFBO(b);
  ringWriteIndex = 0;
  lastWritten = buffers[0];
});

const PRESET_STORAGE_KEY = 'video-feedback-visualizer-presets';

function loadPresets() {
  try {
    return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY)) || {};
  } catch (err) {
    return {};
  }
}
function savePresets(presets) {
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
}

const presetListEl = document.getElementById('presetList');

function renderPresetList() {
  const presets = loadPresets();
  const names = Object.keys(presets);
  presetListEl.innerHTML = '';
  if (names.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'preset-empty';
    empty.textContent = 'No presets saved yet.';
    presetListEl.appendChild(empty);
    return;
  }
  for (const name of names) {
    const item = document.createElement('div');
    item.className = 'preset-item';

    const label = document.createElement('span');
    label.className = 'preset-name';
    label.textContent = name;
    label.addEventListener('click', () => {
      Object.assign(params, presets[name]);
      renderAllKnobs();
    });
    item.appendChild(label);

    const del = document.createElement('button');
    del.className = 'preset-delete';
    del.textContent = '×';
    del.title = 'Delete preset';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = loadPresets();
      delete current[name];
      savePresets(current);
      renderPresetList();
    });
    item.appendChild(del);

    presetListEl.appendChild(item);
  }
}
renderPresetList();

document.getElementById('savePresetBtn').addEventListener('click', () => {
  const name = window.prompt('Preset name:');
  if (!name) return;
  const presets = loadPresets();
  presets[name] = { ...params };
  savePresets(presets);
  renderPresetList();
});

function randomInRange(min, max, step) {
  const steps = Math.round((max - min) / step);
  return min + Math.round(Math.random() * steps) * step;
}

document.getElementById('randomizeBtn').addEventListener('click', () => {
  for (const key of Object.keys(registry)) {
    const spec = registry[key];
    if (spec.type === 'value') {
      params[key] = randomInRange(spec.min, spec.max, spec.step);
    } else {
      const opt = spec.options[Math.floor(Math.random() * spec.options.length)];
      params[key] = opt.value;
    }
  }
  renderAllKnobs();
});
