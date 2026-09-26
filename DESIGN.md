# Video Feedback Visualizer — Design Document

Status: design only, nothing implemented yet.
Audience: a future Claude Code session implementing this from scratch.
Stack: vanilla HTML/CSS/JS, WebGL2, no build step, no npm, no external runtime dependencies.

## 1. What this project is

A generative visualizer built around **video feedback** — the effect you get when a
camera points at the monitor showing its own output, or (digitally) when a shader
reads the frame it drew a moment ago and draws into it again with a small
transform each time. Repeated over many frames this produces spirals, trails,
drifting color, kaleidoscopic tunnels, and "hall of mirrors" textures, entirely
from a simple recursive rule.

This is a **new, standalone project**, a sibling to `Oscilloscope visualizer` and
`html-visualizer-experiments` (see project memory), not a mode bolted onto the
oscilloscope app. It has no audio dependency. An audio-reactive hook is a stretch
goal (§9) — the oscilloscope project already owns the Web Audio plumbing and could
feed this one a single 0–1 modulation value later, but v1 must work with zero
audio input.

### Reference project

Design is informed by reading [ojack/hydra](https://github.com/hydra-synth/hydra)
(and its rendering engine, `hydra-synth`) — a live-coded WebGL video synth whose
whole vocabulary is built on framebuffer feedback. **We are not embedding Hydra,
depending on it, or copying its source files.** hydra-synth is MIT-licensed
(© Olivia Jack); the GLSL formulas reproduced in §5 are short, standard graphics
math (rotation matrices, HSV conversion, blend equations) restated here as a
reference so this project's shaders can be written from scratch in the same
vocabulary. Hydra itself also credits Jim Crutchfield's 1984 work *"Space-Time
Dynamics in Video Feedback"* as the conceptual root of all this — that's the
actual analog phenomenon being modeled.

## 2. The core technique: ping-pong feedback

**Updated 2026-09-18: generalized from 2 buffers to a 32-slot ring buffer**
to add a `delay` parameter (§8) — read on, the 2-buffer version below is
still exactly what `delay = 0` reduces to, and is the right mental model to
start from.

This is the one idea the whole project rests on. Get this right first; everything
else is decoration on top of it.

**You cannot read from and write to the same WebGL texture in one draw call.**
So feedback needs two framebuffers (FBOs), each with its own color texture,
swapped every frame:

```
frame N:   read = fboA (holds frame N-1's result)   write = fboB
           draw shader, sampling `read` as "the previous frame" -> renders into fboB
           blit fboB to the visible canvas
           swap: now read = fboB, write = fboA

frame N+1: read = fboB   write = fboA   ... repeat
```

This is exactly what Hydra's `output.js` does: it allocates
`this.fbos = [regl.framebuffer(...), regl.framebuffer(...)]` and a
`pingPongIndex` that flips (`0 : 1`) each frame; `getTexture()` always returns
the *other* buffer from the one currently being written. Two textures, one
flipping index — that's the entire trick.

### Minimal implementation shape (vanilla WebGL2, no libraries)

```js
function createFeedbackBuffers(gl, w, h) {
  function makeFBO() {
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
  return { buffers: [makeFBO(), makeFBO()], index: 0 };
}

// each frame:
const read  = state.buffers[state.index];
const write = state.buffers[1 - state.index];
gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
gl.viewport(0, 0, w, h);
gl.useProgram(feedbackProgram);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, read.tex);
gl.uniform1i(u_prevFrame, 0);
// ...set the rest of the uniforms (§4/§5), then draw the full-screen quad...
drawFullscreenQuad();

// blit write.tex to the visible canvas with the display/post-fx shader
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.useProgram(displayProgram);
gl.bindTexture(gl.TEXTURE_2D, write.tex);
drawFullscreenQuad();

state.index = 1 - state.index;
```

### Generalizing to a delay line (2026-09-18)

A plain 2-buffer ping-pong can only ever read "the previous frame" — there's
no way to reach further back since the other slot gets overwritten every
other frame. Reading further into the past (for an echo/stutter effect
distinct from smooth `feedback`-persistence decay) needs a ring of N slots
instead of 2:

```js
const RING_SIZE = 32; // ~0.5s at 60fps; 4MB/slot at 1000x1000 RGBA8
const buffers = Array.from({ length: RING_SIZE }, makeFBO);
let writeIndex = 0;

function wrapIndex(i, n) { return ((i % n) + n) % n; }

// each frame:
const delayFrames = Math.round(params.delay); // 0 .. RING_SIZE-2
const readIndex = wrapIndex(writeIndex - 1 - delayFrames, RING_SIZE);
const write = buffers[writeIndex];
const read  = buffers[readIndex];
// ...bind write.fbo, sample read.tex as u_prevFrame, draw...
writeIndex = wrapIndex(writeIndex + 1, RING_SIZE);
```

`delay = 0` gives `readIndex = writeIndex - 1`, i.e. exactly the "other
buffer" from plain ping-pong — identical behavior, just generalized. The
`delay` knob is capped at `RING_SIZE - 2` so `readIndex` can never land on
`writeIndex` itself (reading a texture that's also the current draw call's
render target is invalid, same restriction as always). Memory is the only
real cost of a bigger `RING_SIZE` — each slot is a full-resolution FBO.

Two programs, two FBOs, one flipping index, a full-screen-quad helper reused for
both draws. Everything from here on is uniforms feeding into these two shaders.

## 3. Architecture (deliberately simpler than Hydra)

Hydra compiles an arbitrary JS chain (`osc().rotate().modulate(noise())...`) into
a bespoke fragment shader per output, at runtime, via its own mini compiler. That
generality is the whole point of a live-coding tool, but it's a lot of machinery
for a fixed-UI visualizer app. **Do not build a shader compiler for v1.**

Instead: **one fixed, uniform-driven fragment shader** implementing a fixed
pipeline (generator → feedback-read/modulate/chromakey → blend → color chain),
where every knob in the UI is just a uniform. This gets the real
video-feedback *behavior* and *look* with none of the DSL complexity. A
dynamic chain builder is an explicit stretch goal (§9), not part of the MVP.
(The transform-chain stage — kaleid/pixelate/mirror — existed in the first
pass but was removed 2026-09-18; see §5/§8.)

### Files (matches this project family's no-build, single-script convention)

```
index.html   - canvas + control panel markup (reuse .row/.group/.wide-btn/.knob-select
               conventions and dark panel theme from the sibling projects)
style.css    - panel styling, same dark theme
script.js    - everything else, organized top-to-bottom as:
               1. WebGL boilerplate (context, resize, fullscreen quad, shader compile helpers)
               2. Framebuffer / ping-pong management
               3. GLSL source strings (feedback shader, display/post-fx shader)
               4. Parameter state + uniform upload
               5. Control panel wiring (knobs, presets, randomize)
               6. Render loop (requestAnimationFrame)
```

Keep it to these three files, matching the existing snapshot-bundling workflow
(see project memory: after each "commit", CSS and JS get inlined into one
standalone HTML file under `snapshots\`). GLSL source strings living as JS
template literals inside `script.js` already inline cleanly — no separate
`.glsl` or `.frag` files to worry about pulling into the bundle.

### Why WebGL2 specifically

- `#version 300 es` gives cleaner texture sampling (`texture()` vs `texture2D()`)
  and is universally available in current browsers — no reason to target WebGL1.
- No extensions needed for anything in this doc (no float textures required;
  `RGBA8` ping-pong buffers are enough — analog feedback doesn't need HDR).
- Fall back path: if `getContext('webgl2')` returns null, show a plain message
  in the panel ("WebGL2 not available") rather than attempting a WebGL1 path —
  don't build two renderers.

## 4. The pipeline, conceptually

Each frame, the feedback fragment shader computes, per pixel:

1. **Sample the previous frame** at a *transformed* UV coordinate — this is
   what makes it feedback rather than a static image. The transform is a small
   composition of rotate/scale/translate, driven by slowly-changing uniforms
   (time-based or user knobs), so each frame the image spirals/zooms/drifts a
   little relative to the last.
2. **Generate a fresh source layer** this frame (an oscillator pattern, noise,
   shapes — see §6) independent of the feedback texture.
3. **Blend** the transformed previous frame with the fresh generator layer
   (add / multiply / difference / mix — see §5), with a `feedback` uniform
   controlling how much of the old image survives vs. how much new signal
   gets injected. `feedback` near 1.0 = long analog-style trails/persistence;
   near 0 = mostly just this frame's generator (no visible feedback).
4. **Color chain**: hue rotate, saturate, brightness, contrast, invert-amount —
   applied to the blended result. Slow hue drift over time is most of what
   gives feedback loops their "psychedelic" analog-video look. (Posterize was
   cut 2026-09-18; brightness was added in its place.)
5. **Modulate** (optional, §5): warp the sampling UV of one layer using the
   *color values* of another layer (this is what makes Hydra's output look
   organic instead of like a plain zoom-rotate spiral) — e.g. warp the
   feedback-read UV by the noise layer's RGB, scaled by an `amount` uniform.
6. **Chromakey** (optional, §5, added 2026-09-18): before the persistence
   blend, pixels of the fresh generator layer close to a chosen key color get
   replaced with the feedback-read color instead — useful for e.g. keying a
   camera's background out so the feedback shows through it.
7. Write the result to the `write` FBO.

Step 7 used to be followed by a **separate second pass** applying scanlines,
vignette, chromatic aberration, and grain to `write`'s texture before it hit
the canvas — that whole Post FX pass was removed 2026-09-18 (§7). The display
shader is now a one-line blit: sample `write`'s texture, output it.

## 5. GLSL reference — transform / color / blend / modulate math

These are restated from hydra-synth's `glsl-functions.js` (MIT license) as a
math reference, not copied files. `_st` is the `vec2` UV coordinate being
transformed (pre-sampling); `_c0`/`_c1` are already-sampled `vec4` colors being
combined. Write them as GLSL functions taking these as explicit parameters —
don't rely on Hydra's implicit-argument macro system, that's part of its
compiler, not needed here.

**Rotate** (`_st`, `angle`)
```glsl
vec2 rotate(vec2 st, float angle) {
  vec2 xy = st - 0.5;
  float c = cos(angle), s = sin(angle);
  xy = mat2(c, -s, s, c) * xy;
  return xy + 0.5;
}
```

**Scale** (`_st`, `amount`, optional per-axis `xMult`/`yMult`, `offset`)
```glsl
vec2 scaleUV(vec2 st, float amount, vec2 offset) {
  vec2 xy = st - offset;
  xy *= 1.0 / amount;
  return xy + offset;
}
```

**Kaleidoscope / Pixelate** — ~~removed~~ (2026-09-18: the whole Transform
section — kaleid/pixelate/mirror — was cut from the app; the user wanted a
simpler control set. Formulas kept here for reference if it comes back:
```glsl
vec2 kaleid(vec2 st, float nSides) {
  vec2 c = st - 0.5;
  float r = length(c);
  float a = atan(c.y, c.x);
  float pi2 = 6.2831853;
  a = mod(a, pi2 / nSides);
  a = abs(a - pi2 / nSides * 0.5);
  return r * vec2(cos(a), sin(a)) + 0.5;
}
vec2 pixelate(vec2 st, vec2 pixels) {
  return (floor(st * pixels) + 0.5) / pixels;
}
```
)

**Hue rotate** (`_c0`, `hue` in turns, i.e. 0..1 = full rotation)
```glsl
vec3 rgb2hsv(vec3 c) { /* standard formula */
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0*d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 hueRotate(vec3 rgb, float hue) {
  vec3 hsv = rgb2hsv(rgb);
  hsv.x = fract(hsv.x + hue);
  return hsv2rgb(hsv);
}
```

**Saturate** (`_c0.rgb`, `amount`)
```glsl
vec3 saturate(vec3 c, float amount) {
  const vec3 W = vec3(0.2125, 0.7154, 0.0721); // luma weights
  vec3 gray = vec3(dot(c, W));
  return mix(gray, c, amount);
}
```

**Contrast / Brightness / Invert** (Posterize was cut 2026-09-18 along with
the rest of that first pass at the Color group — the app now ships
`brightness` instead)
```glsl
vec3 contrast(vec3 c, float amount)   { return (c - 0.5) * amount + 0.5; }
vec3 brightness(vec3 c, float amount) { return c + amount; }
vec3 invertAmt(vec3 c, float amount) { return (1.0 - c) * amount + c * (1.0 - amount); }
```

**Blend modes** (`_c0`, `_c1` already-sampled colors, `amount` mix factor)
```glsl
vec4 blendMix(vec4 a, vec4 b, float amount) { return a * (1.0 - amount) + b * amount; }
vec4 blendAdd(vec4 a, vec4 b, float amount) { return (a + b) * amount + a * (1.0 - amount); }
vec4 blendMult(vec4 a, vec4 b, float amount){ return a * (1.0 - amount) + (a * b) * amount; }
vec4 blendDiff(vec4 a, vec4 b)              { return vec4(abs(a.rgb - b.rgb), max(a.a, b.a)); }
```

**Chromakey** (added 2026-09-18 — not in the original v1 plan; keys a color
out of the fresh generator layer and lets the transformed feedback show
through instead, e.g. a camera's green-screen background):
```glsl
vec3 chromakey(vec3 gen, vec3 prevFeedback, vec3 keyColor, float threshold, float softness) {
  float dist = length(gen - keyColor);
  float keyMask = smoothstep(threshold - softness, threshold + softness, dist);
  // keyMask -> 0 where gen matches keyColor (replaced by feedback),
  // keyMask -> 1 where it doesn't (generator stays).
  return mix(prevFeedback, gen, keyMask);
}
```
Applied to `gen` after the feedback texture (`prev`) has already been
sampled, right before the persistence blend (§4 step 3) — so the keyed
region shows whatever the feedback loop would have drawn there anyway,
rather than flat key color re-injected every frame.

**Modulate** (warp one layer's sample UV using another layer's already-sampled
color — this is the single most important trick for organic-looking feedback;
sample `b` first at the *unwarped* UV, then use its `.rg` to offset the UV you
use to sample `a`)
```glsl
vec2 modulate(vec2 st, vec4 b, float amount) {
  return st + b.xy * amount;
}
```

Note the naming departs slightly from Hydra's `_st`/`_c0` convention on
purpose — those are implicit-argument placeholders generated by Hydra's shader
compiler and don't mean anything outside it. Explicit named GLSL function
parameters are the right approach for a hand-written fixed pipeline.

## 6. Generators

Hydra's exact GLSL for these wasn't retrievable during research (404s on the
raw source paths tried), but these are standard, well-known techniques —
implement from scratch rather than needing Hydra's file:

- **`osc`** — banded oscillator pattern: `sin((st.x * frequency + time * speed) * TAU) * 0.5 + 0.5`
  per channel, with a small per-channel phase offset (`sync` param) so R/G/B
  bands drift apart slightly — this alone, fed through the feedback loop, is
  most of Hydra's iconic look.
- **`noise`** — 2D value or simplex noise (write a standard simplex-noise GLSL
  function; this is common enough to not need Hydra's copy — many public-domain
  implementations exist, e.g. Ashima Arts' `snoise`), `scale` and time-based
  `offset` uniforms.
- **`shape`** — SDF polygon: `nSides`, `radius`, `smoothing` via `smoothstep`
  on a polar-coordinate distance field.
- **`gradient`** — UV-driven hue ramp through `hsv2rgb`, animated by `time * speed`.
- **`solid`** — flat `vec4(r,g,b,a)` uniform, useful as a modulation-free base
  layer or for clearing to black/white.

## 7. Analog-feedback flavor (post-fx pass, display shader)

**Removed 2026-09-18.** The whole Post FX section (chroma offset, scanlines,
vignette, grain) was cut at the user's request along with Transform and
Posterize — the app's second draw call is now a plain blit of the feedback
FBO to the canvas (`DISPLAY_FRAGMENT_SRC` just samples `u_frame` once).
`feedback`/persistence (§4 step 3) is still the main analog-decay knob and
still lives in the Feedback group. The formulas below are kept as reference
in case any of this gets reintroduced later — none of it is wired up in the
current shader:

- **Chromatic aberration / RGB offset** — sample R, G, B channels of the final
  texture at slightly different UV offsets (`uv + vec2(offset,0)` for R,
  `uv - vec2(offset,0)` for B). Reads as VHS/analog chroma smear.
- **Scanlines** — `sin(uv.y * resolution.y * PI) ` modulating brightness slightly.
- **Vignette** — `smoothstep` darkening based on distance from center.
- **Grain** — cheap per-pixel hash noise added at low amplitude, re-seeded by
  `time` so it doesn't feed back and accumulate.
- **Barrel/CRT curvature** (optional, low priority) — warp UV outward from
  center before sampling.

## 8. Control panel plan

Reuse the existing dark-panel conventions from the sibling projects
(`.group`/`.row`/`.wide-btn`/`.knob-select`, per project memory) rather than
inventing new panel CSS. Suggested parameter groups, each a `<fieldset
class="group">`:

**Updated 2026-09-18** — Transform and Post FX groups were removed, Posterize
was cut from Color, and Brightness plus a whole Chromakey group were added.
Current layout:

| Group | Params |
|---|---|
| Feedback | `feedback` (persistence 0–1), `delay` (0..RING_SIZE-2 frames behind "live", added 2026-09-18 — see §2's ring buffer), `zoom` (per-frame scale), `rotate` (per-frame angle), `translateX/Y` drift, `hueDrift` (per-frame hue shift) |
| Generator | `type` (osc/noise/shape/gradient/solid/camera) + `speed` at the top, then each generator's own params grouped into a Moog-Grandmother-style flat-colored sub-field: Camera (enable button), Oscillator (`frequency`, `sync`), Noise (`noiseScale`), Shape (`shapeSides`, `shapeSmoothing`), Solid (`solidR/G/B`) — see `.gen-field*` in style.css |
| Color | `hue`, `saturate`, `brightness`, `contrast`, `invertAmount` |
| Chromakey | `chromakeyEnabled`, `keyR/G/B` (color to key out), `chromakeyThreshold`, `chromakeySoftness` — see §5's chromakey formula |
| Blend | `mode` (mix/add/mult/diff), `modulateAmount` (0 = off) |
| Presets | Save / Randomize / preset list — mirror the existing oscilloscope app's preset system exactly (same localStorage-backed pattern) |

~~Transform~~ (`kaleidSides`, `pixelateAmount`, `mirror`) and ~~Post FX~~
(`chromaOffset`, `scanlineAmount`, `vignetteAmount`, `grainAmount`) are gone;
their GLSL is kept in §5/§7 as reference only, not wired into the shader.

Header actions to match the sibling app's pattern: `Pause`, `Freeze` (stop the
feedback loop but keep displaying the last frame — trivial, just skip the
render-loop body), `Reset` (clear both FBOs to black, reset params to
defaults).

## 9. Explicit non-goals / stretch goals for v1

Not building these now; noted so a future session doesn't accidentally scope-creep
into them or, conversely, forget they were considered:

- **No dynamic shader compiler / live-coding DSL.** The fixed fbo describes a
  reasonable feedback pipeline; a Hydra-style arbitrary chain compiler is a
  much larger project and isn't needed for a visualizer with a fixed UI.
- **No multi-output (`o0`–`o3`) compositing.** One feedback loop, one display.
  Could be added later by generalizing the FBO-pair logic into an array, but
  starts adding real UI complexity (routing which output feeds which).
- **No audio-reactivity in v1.** Leave one clear extension point instead: a
  single `getModulator()` function that returns `0` by default, called once
  per frame and available to wire into any uniform (e.g. `feedback` or
  `zoom`). When/if the oscilloscope project's audio analyser should drive
  this visualizer, that function gets replaced — no need to design the audio
  plumbing now.
- **No WebRTC / networked patch-bay** (Hydra supports streaming between
  browser instances — irrelevant to a single-user local visualizer).
- ~~No external texture/camera/video input for v1~~ — **implemented.** A
  live webcam feed is now a sixth generator type (`camera`, alongside
  osc/noise/shape/gradient/solid). An "Enable" button in the Generator
  group calls `getUserMedia` and uploads the resulting `<video>` frame to
  a plain (non-FBO) texture each render tick; the shader samples it
  mirrored, vertically flipped, and cover-fit (aspect-cropped to the square
  canvas) via `genCamera()`. The flip (`1.0 - st.y`, added 2026-09-18) is
  needed because `texImage2D` uploads a `<video>` frame top-row-first while
  the rest of this project's `v_uv` convention has `v=0` at the bottom —
  every other generator is written directly against that convention so it
  never comes up, but a texture sourced from the DOM needs the explicit
  flip. Bound on texture unit 1, separate from the
  ping-pong `u_prevFrame` on unit 0. Defaults to a 1x1 black pixel before
  the camera is enabled, so selecting the Camera type early just renders
  black instead of erroring. No device picker or resolution constraints
  for v1 — always `{ video: { facingMode: 'user' } }`, default camera.

## 10. Suggested implementation order

1. WebGL2 boilerplate: context creation, resize-to-window handling (with
   devicePixelRatio capped, e.g. `Math.min(devicePixelRatio, 2)`), full-screen
   quad (2 triangles or a single oversized triangle), shader compile/link
   helper with readable error surfacing (console + maybe an on-page banner —
   shader compile errors are otherwise painful to debug blind).
2. Ping-pong FBO pair (§2). Verify by rendering a static `solid()` color into
   the loop and confirming nothing black-screens or throws
   `INVALID_FRAMEBUFFER_OPERATION`.
3. One generator (`osc`) drawn straight through with no feedback yet — confirms
   the generator math and display pass both work in isolation.
4. Wire the actual feedback read (transformed sample of `read.tex`) blended
   with the generator — this is the moment the visualizer starts looking like
   video feedback. Get `feedback`, `zoom`, `rotate`, `hueDrift` working and
   tunable before anything else.
5. Color chain uniforms (§5), then the rest of the generators (§6).
6. Modulate + blend modes (§5) — adds organic warping on top of the
   rotate/zoom spiral.
7. Post-fx display pass (§7).
8. Control panel UI (§8), wired to uniforms; presets + randomize + localStorage,
   mirroring the existing oscilloscope app's implementation.
9. Snapshot bundling: same workflow as the oscilloscope project (see project
   memory) — inline CSS/JS into one file under `snapshots\` after each
   user-called "commit" point.

### Verification notes

- Feedback effects only become visible after several frames accumulate (unlike
  the oscilloscope project's audio-timing caveat, there's no real-time-clock
  dependency here — a headless screenshot just needs enough `requestAnimationFrame`
  ticks pumped first, e.g. driving the loop manually 30–60 times before
  capturing, rather than relying on wall-clock delay).
- Watch for `CONTEXT_LOST_WEBGL` on resize/tab-switch on some GPUs; a minimal
  `webglcontextlost`/`webglcontextrestored` handler that recreates the FBOs is
  worth having even in v1, since a lost context otherwise means a frozen black
  canvas with no obvious cause.
