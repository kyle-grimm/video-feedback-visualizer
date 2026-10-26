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

**Rebuilt 2026-10-11 (supersedes the tables below).** The panel is now a fixed
900 x 1336 stage (900 x 1440 before the Background strip was removed) scaled to fit the window, styled after the Oscilloscope
Visualizer's L9 panel (graphite, outlined sections with ink nameplates, MS-20
knobs, rubber keys with LEDs, black glass screens, Barlow Semi Condensed). Layout,
from the user's sketch:

- **Screen** (top left): a 9:16 canvas (rendered at 720 x 1280) in a bezel.
  Under it, a row of keys: Pause, Freeze, Reset, Random, Full (fullscreen; a
  double-click on the screen does the same).
- **Layers** (below, left), 2 x 2 in the same order as the pad corners: Camera
  (On key + Front / Back), Osc Speed, Noise Scale, Shape Sides.
- **Mix** (below, right of Layers): an XY pad that crossfades the four layers'
  opacity with bilinear weights that always sum to 1 (Camera top-left,
  Oscillator top-right, Noise bottom-left, Shape bottom-right). The generator
  `type` selector is gone: all four layers are drawn and mixed every frame.
- **Right column**, two knobs per row (ten rows): Feedback (Blend Mode,
  Modulate, Persistence, Delay); Chromakey (On, Key Hue, Key Sat, Key Light,
  Threshold, Softness); then Transform (Zoom, Rotate, Shift X, Shift Y, Hue
  Drift) and Color (Hue, Saturation, Brightness, Contrast, Invert) side by side,
  each a single column of five. (Reordered 2026-10-12; before that Transform and
  Color shared a row with stepped outlines and Chromakey came last.)
- ~~Background~~ (removed 2026-10-12): there were Hue / Saturation / Lightness
  faders for a layer under the mix. Now whatever the mix leaves uncovered
  (around the shape, or the camera's share while the camera is off) is black.

Dropped in the rebuild: the Gradient and Solid generators (Solid became the
Background, since removed), the Frequency, Osc Sync and Shape Soft knobs (now fixed at 8, 0.2
and 0.05), and the localStorage preset list. The chromakey key colour is now set
as HSL (converted to RGB in JS). Noise drifts at a fixed rate, so Osc Speed
moves only the oscillator.

**Landscape layout (2026-10-11).** When the window is wider than tall (or the
URL hash contains `landscape` / `portrait`), the panel is the same layout
transposed (rotated 90° clockwise, then flipped horizontally) on a 1336 x 908
stage. The screen turns 16:9 (rendered at 1280 x 720), the header keys stand in a
column beside it, Layers and Mix sit to its right, the effect knobs run in two
rows along the bottom (Transform and Color as two stacked rows of five). The XY
pad transposes with the Layers knobs, so
Camera / Noise are along its top and Osc / Shape along its bottom in landscape. The
mixer state itself (`mixX`, `mixY`) is orientation-independent. Layout code is
written in portrait coordinates and `pt()` / `box()` transpose them. The WebGL
canvas persists across rebuilds; only the ring buffers are recreated at the new
size. A rotation while fullscreen is applied when fullscreen ends.

Theme: Anodized (brushed-metal grain over a saturated tint per parameter family,
family-coloured nameplates), chosen from nine candidates. It stays in style.css as the
underlying look, but since 2026-10-12 the shipped scheme is one evolved in design mode
(`COLOR_DEFAULT` in design.js, applied as CSS whenever no scheme is adopted): muted
family tints (amber Feedback, olive Chromakey, green Transform, magenta Color, teal
Layers, grey Mix) with a fine grille texture, ink nameplates, family-coloured knob
pointers, no section outlines, near-black stage, teal accents.

**Design mode (2026-10-12, `design.js`; replaced by the Style Lab, §17, on 2026-10-13).** Experimentation tooling opened by the
Design key on the screen's top left (hidden since 2026-10-12; add `#design` to the URL to show it): preference-driven evolution of layouts and
colour schemes. A layout genome is a split tree whose leaves are the blocks
(screen, keys, Layers, Mix, Feedback, Chromakey, Transform, Color), plus screen
aspect, knob scale, gap, padding, corner radius and per-section columns. Blocks
grid their controls (`SECTIONS` / `CONTROLS` in script.js) inside their box, on
a stage shaped like the window; candidates that would be unusable are rejected.
A colour genome covers family hues and saturation, panel and nameplate lightness,
stage colour, texture and sheen, outline / nameplate / pointer / label / knob-cap
styles and the glass accents, applied as CSS through `data-fam` and `knob-*`
hooks. The user rates 8 candidates per generation with 1-5 stars. Evolve keeps
the top 2, breeds 5 (crossover and mutation, weighted by stars squared) and adds
1 random newcomer. Adopt makes a candidate the app's normal look (localStorage
`vfv-design-v1`), and Export copies the adopted genomes as JSON so they can be
built in. script.js exposes the makers (`makeScreen`, `makeKeys`, `makeItem`,
`makePad`, `makeSwatch`) and a `layoutEngine` / `onPanelBuilt` hook; the
built-in layouts use the same makers.

The rest of this section is the earlier plan, kept for history.

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

## 11. Performance (analysis and optimizations, 2026-10-12)

Measured with the `index.html#bench` hook. It reports ms per frame for several settings, GPU memory held by the
feedback history, uniform-upload and main-thread costs, and an output fingerprint: a hash of every pixel after 60
deterministic frames, so a change can be checked for identical output. Run it in headless Chrome on the real GPU
(`--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`). SwiftShader (the software fallback) executes every
branch of the shader, so it badly misjudges the branch-skipping costs.

Baseline on a GTX 1070: the feedback pass took about 0.25 ms per frame at 720 x 1280 (0.11 ms with only the
oscillator; the noise layer is the costliest at about 0.12 ms), the display blit about 0.02 ms, the uniform upload
about 2 us, a Mix pad redraw about 0.1 ms and a full panel rebuild about 2.7 ms. So on desktop the per-frame GPU
work is small. What actually cost something:

- **Refresh rate.** The loop rendered every animation frame, and zoom / rotate / drift / hue drift are per frame,
  so 120 / 144 Hz displays did 2-2.4x the GPU work *and* ran the visuals that much faster than designed. Now
  rendering is scheduled on a fixed 60 Hz grid (every frame at 60 / 59.94 Hz, an even 60 at 90-240 Hz; simulated
  across refresh rates with timestamp jitter).
- **Memory.** The 32-slot feedback history was allocated up front: 112.5 MB of GPU memory, a real risk of context
  loss on phones, while Delay is usually 0. It now starts at 2 slots (7 MB) and doubles only when Delay needs more
  (8 slots for a delay of 5). Existing history keeps its order and new slots start as copies of the oldest frame.
  Output is bit-identical to the old ring (same fingerprints, including with Delay set).
- **Camera.** The 1280 x 720 video frame was re-uploaded on every render frame (twice per camera frame at 60 fps,
  more at higher refresh rates), and also while the Camera layer had no weight in the mix. Now it uploads only
  when a new video frame has arrived (`requestVideoFrameCallback`, with a `currentTime` fallback) and the layer is
  in the mix, and same-size frames go through `texSubImage2D` instead of reallocating the texture.
- **Canvas.** The context is created with `alpha: false, depth: false, stencil: false`: every pixel is opaque and
  nothing is depth tested, so the compositor can treat the canvas as opaque, and no canvas-sized depth buffer is
  allocated or cleared.
- **Shader.** The camera layer is skipped while the camera is off (the default mix gives it 19% weight).
  Hue / Hue Drift of exactly 0 skip the HSV round trip and just clamp. Hue defaults to 0, so that rotation is
  always skipped by default. Against the old shader the first frame differs by at most 1/255 in rare pixels:
  the skipped round trip's own rounding error. After 60 frames of feedback that has spread to at most a few
  levels in a small share of pixels, the same scale as running on a different GPU.
- **Context loss.** Recovery used to rebuild only the framebuffers; the shader programs are lost too, so the screen
  stayed black. It now relinks the programs, rebuilds the history and the camera texture, and keeps Freeze separate
  from the lost-context state.
- **Resize.** Rebuilding the panel is now debounced while a window is being resized (design-mode layouts follow the
  window's shape and would otherwise rebuild on every size step); the stage still rescales immediately.

Not changed, on purpose: the render resolution stays 720 x 1280 / 1280 x 720 even when the screen is shown smaller.
The feedback's per-frame resampling blur is in texels, so a lower resolution would change how the image smears and
evolves, not just its sharpness. A "render quality" setting could trade that off later if phones need it.

## 12. Recording (2026-10-12)

The header keys are now Pause, Freeze, Reset, Random, **Record**, Full. Record starts a take (red LED, label
Stop); Stop finishes it (Saving) and the browser downloads `feedback-YYYY-MM-DD-HHMMSS.mp4`, which lands in the
Downloads folder unless the browser is set to ask.

- **What is recorded:** the output canvas at its full render resolution (720 x 1280 portrait, 1280 x 720
  landscape), not the scaled on-screen copy. No panel, no audio. Upscaling on export would add no detail, and
  rendering larger would change how the feedback evolves (see §11), so the render size is the maximum.
- **Encoding:** WebCodecs `VideoEncoder`, H.264 High profile (falls back to Main, then Baseline), variable bitrate
  of about 0.32 bits per pixel per frame (17.7 Mbps at 720p60, capped at 50 Mbps), keyframe every 2 s,
  `latencyMode: 'quality'`. Muxed into a standard MP4 by `vendor/mp4-muxer.min.js` (mp4-muxer 5.2.2, MIT), with
  `moov` at the end.
- **Constant 60 fps:** each frame the render loop draws (the fixed 60 fps grid from §11) is encoded with timestamp
  n / 60 s, so the file plays at the designed speed regardless of display refresh rate or timing jitter. Freeze
  holds the frozen image in the recording rather than pausing it. If the encoder falls behind, a frame is skipped
  (the previous one is held longer) instead of piling up GPU frames: the queue limit is 12, or 45 until the encoder
  has produced its first output and worked off that backlog (a hardware encoder takes about 0.3 s to start).
- **Memory:** the muxer streams through `StreamTarget` into Blob parts, folded every 32 MB so the browser can move
  them to disk; late header fix-ups are spliced in with `Blob.slice`. A take is not held in the JS heap.
- **Fallback:** without WebCodecs, `MediaRecorder` on `canvas.captureStream(60)`, preferring
  `video/mp4;codecs=avc1` (H.264), else WebM.
- **Ends itself** if the render size changes mid-take (the window rotates between portrait and landscape); what
  was recorded is saved.

Self-test: `index.html#rectest` feeds 180 frames in real time through the recorder and reports the file size,
MP4 box layout, `avcC` profile and level, sample count, and what a `<video>` element decodes. GTX 1070 / Chrome:
180 of 180 frames, no drops over 4 runs, 3.000 s, 7.2 MB (about 19 Mbps; the noise and oscillator layers are
dense). Clicking Record, then Stop, through the real render loop produced a file that Windows reports as
720 x 1280, 60.00 fps, H.264. The MediaRecorder fallback produced an H.264 .mp4 at 720 x 1280. Not yet tried on
phones (iOS Safari has WebCodecs H.264 from 16.4; downloads there go through the Files prompt).

## 13. Layers holds the mixer (2026-10-12)

The cyan Layers section now spans the XY pad as well as the four layer controls, in both built-in layouts; the
separate Mix section and its nameplate are gone. Positions are unchanged. (A first attempt that enlarged the
portrait controls and rearranged that panel was reverted.) Design mode still treats Layers and Mix as separate
blocks.

## 14. Larger portrait controls, in place (2026-10-12)

In the portrait built-in layout the controls are 1.5x and their labels 2x the base size, with every section where
it was and the stage still 900 x 1336: knobs 63 px (Layers 60), header keys 42 px tall, camera and Chromakey On
keys 1.5x, knob labels / key text 20 px, Blend Mode legend 18 px. The makers read `UK` (control scale) and `UL`
(label scale); `buildDefault` sets 1.5 / 2 for portrait and `build()` resets both to 1, so landscape and design-mode
layouts are unchanged. Section nameplates and the XY pad keep their size (no room).
To fit: labels sit 3 px under their ring with line-height 1; each right-column section spreads its rows between its
nameplate and its bottom edge rather than centring them in the ten equal rows; the left knob column moves in 8 px
for Blend Mode's legend; the header keys are 6 px higher with 6 px gaps; the Layers controls sit at x 92 / 238.

## 15. Fullscreen on phones (2026-10-12)

Full (and double-clicking the screen) used only the Fullscreen API on `#screen`. iPhone Safari doesn't offer it for
anything but `<video>`, and a browser may also refuse the request; both cases did nothing. Now:
- The API is used where it's available (desktop, Android, iPad), with `navigationUI: 'hide'`.
- If it's missing (`fullscreenEnabled` false), the request is rejected, or a prefixed request hasn't taken effect
  after 1 s, the canvas moves into `#fsview`: a fixed black overlay on `body`, outside the scaled stage (whose
  transform would trap `position: fixed`), with the canvas letterboxed by `object-fit: contain`. An exit button
  (top right, inside the safe area) shows for 3 s on entry and after each tap; Escape and Full also exit. Panel
  rebuilds (a rotation) leave the canvas in the overlay; it returns to the current screen on exit.
On iPhone the browser's own bars stay visible; only an installed home-screen web app could hide them.
Tested headless at phone size: missing API, refused request (both go to the overlay), and a real click (true
fullscreen, no overlay). Not yet tried on a real phone.

Update (2026-10-12): portrait controls reduced by 20%, from 1.5x to 1.2x (`UK = 1.2`; knobs 50 px, Layers 48 px,
header keys 34 px tall). Labels stay 2x. The fitting rules above are unchanged.

## 16. Regular portrait spacing, 2x nameplates (2026-10-12)

`buildPortraitPanel` replaces the fitted ten-row grid. Every window spreads its controls with equal gaps between
them and to its edges, horizontally and vertically (space-evenly), using each control's measured extent: ring or
key cluster plus label, and Blend Mode's legend. Label widths come from `textW` (canvas `measureText` in the panel
font plus letter-spacing), and the panel is rebuilt once when the web font finishes loading. The vertical top edge
of a window is its nameplate's bottom. The right column's windows (Feedback, Chromakey, Transform | Color) are
sized so that vertical gap is the same in all of them (about 19 px). Windows sit `PG` = 14 px apart plus the
nameplate overhang; the header keys sit 14 px below the screen and 14 px above the Layers nameplate; the XY pad
sits 14 px inside the top, right and bottom edges of Layers (so it is now about 210 px), with the four layer controls
spread evenly to its left.
Nameplates are 2x in portrait (20 px). To fit the 146 px Transform window they sit 8 px in (12 at 1x), with 8 px
side padding and 0.1em letter-spacing (0.16em at 1x). Landscape and design mode are unchanged.

## 17. Style Lab (replaces design mode, 2026-10-13)

`lab.js` replaces `design.js`. Open it with the **Lab** key on the screen's top-left corner (or `#lab` in the URL). It
experiments only with the look, never the layout.

**Design space.** A design is one categorical value in each of 22 dimensions:
- Colour: five window colours (Feedback, Chromakey, Transform, Color, Layers; 11 hues incl. neutral, 5 more in reserve),
  window saturation, window lightness (deep to pale), background, glass accent, window outline.
- Texture: type (6, plus 6 in reserve: grain, linen, scanlines, dots, weave, stripes), strength (subtle to strong), sheen.
- Knobs: cap (6 + brass, red, glass), skirt (4 + fluted, metal), pointer shape (4 + triangle, notch), pointer colour,
  scale (ticks, faint, none, arc, family-colour arc + glowing arc).
- Font: family (7 condensed Google fonts + 6 in reserve; all condensed so the portrait spacing holds), label weight,
  case, letter spacing.
- Text colour: label colour (7 options), nameplate style (5 + 2).
Small random jitter (hue, saturation, lightness) varies designs within a value without being a feature. The renderer
is design mode's colour CSS extended with the new dimensions; their defaults add no CSS, so the built-in look
(the scheme shipped 2026-10-12) renders byte-for-byte as before. Changing font, weight, case or spacing rebuilds the
panel once the font has loaded, because the portrait layout spaces controls by measured label widths (`TEXT` in
script.js tells `textW` the current text style).

**Datapoints.** Each rating stores: round, design id, stars, time spent viewing before rating, any re-rating, all 22
features (texture strength recorded as n/a for flat), and derived measures computed from the rendered colours:
label/window contrast (WCAG ratio, worst window), nameplate contrast, pointer/cap contrast, texture amount, window
lightness, number of distinct window colours, colour harmony (monochrome, analogous, complementary, triadic, rainbow,
mixed), temperature, and text polarity. Exports: CSV (one row per rating) and full JSON.

**Insights.** A ridge regression of stars on every feature value, the derived categories and the standardised
measures (λ = 3) gives each value's effect *against the alternatives with everything else held equal*, so values that
merely ride along in liked designs get little credit. Reported:
- preferences and dislikes: effect of at least 0.4★ and at least 3 standard errors (about 150 values are tested), with
  5+ ratings;
- threshold rules on the measures (e.g. "Text must contrast with its window background: keep the label/window
  contrast at or above 4.5:1"): the best split, kept only when 80%+ of 4–5★ designs sit on the good side, the split
  moves the average by 0.8★+ and the model agrees on the direction;
- interactions: pairs whose designs score at least 0.5★ above or below what the model predicts from the two
  separately, with 8+ designs and a t-score of 3.5;
- drivers: each feature's share of the variance the model explains; and a one-line taste profile.
Insights appear after 20 ratings.

**Rounds of 16.** Round 1: the current look plus 15 designs with every dimension's values dealt out evenly. After
that, for each design and each dimension: with probability 0.5 the value is drawn from the features of designs
rated above 3★ (weight = stars − 3, ×0.8 per round of age), otherwise by Thompson sampling over the active values
(untested values have wide posteriors, so they get tried). 4 of the 16 are explorers that use the least-tested values.
Variability constraints: each design differs from every liked design in ≥45% of features and from the other designs
in the round in ≥40% (relaxed slowly if impossible); no value fills more than its share of a round
(max(3, ⌈16/values⌉ + 2)); no design is ever repeated. Between rounds (12+ of 16 rated): up to 5 values are retired
if they have 4+ ratings, average ≥0.4★ below the mean, a model effect of −0.4★ or worse, and under 20% of their
ratings above 3★. Each retirement brings in a reserve value, at least 2 new values enter per round while reserves
last, each new value appears in at least 2 designs of its first round, every dimension keeps at least 3 values where
it has them, and every 4th round the best retired value returns for a retest.

**5★ folder.** Every 5★ design is kept. Selecting one previews it on the panel; Adopt makes it the app's look
(persisted; applied at startup without opening the Lab). "Save folder…" writes `video-feedback-5-star-designs/`
(one JSON + PNG per design, plus index.json) into a folder you choose (Chrome/Edge); other browsers download one
JSON. "Export adopted" downloads the adopted design for building into the app.

**Self-test** (`#labsim=N`): a simulated rater who likes green Chromakey windows, labels with ≥4.5:1 contrast, mild
textures, and ivory caps only on deep windows. Six runs: the contrast rule (found at 4.5–4.8:1) and the mild-texture
preference appeared in all six; green Chromakey in all three 14-round runs, one of three 8-round runs. Diversity
stayed about 78% through 14 rounds (random is 84%), no value exceeded half a round, and 2+ new values entered every
round. The planted ivory/deep interaction was not found within 14 rounds; interactions need more data. A few weaker
false findings (≈1–3 per run, each labelled with its rating count) still appear. `#labdemo=N` shows N simulated rounds
in the HUD without saving.

**Home base favourites (2026-10-14).** Favourites can be read and altered in the project, not only on the device
that rated them:
- In the Lab, 5★ Folder → **Send to home base** copies the device's 5★ designs (features, jitter, raw values) plus
  the current insights as compact JSON (about 1 KB per design) to paste to Claude; without clipboard access it shows
  the text to copy. **Save folder…** also writes it as `home-base.json` (or downloads it where folders can't be written).
- In the repo, `favorites/favorites.json` holds the curated designs; `node tools/favorites.mjs import <file>` merges
  an export and `node tools/favorites.mjs list` prints them readably. An entry can be altered by changing its
  features (any value of a dimension) or adding `overrides`, exact style values applied last (format in
  `favorites/README.md`).
- The site serves that file; the Lab's 5★ Folder lists it under **Home base** (marked "edited" when overridden), to
  preview and adopt. A design adopted from home base follows later edits to the file (matched by id, refreshed at
  startup). `#fav=<id>` previews one home-base design without adopting it.
Tested over HTTP: export → import → alteration (white labels, window lightness 0.30) → `#fav` preview showed both →
adopted in the Lab → lightness changed to 0.45 in the file → after a reload the adopted look showed 0.45.

## 18. Favourite tuner (2026-10-14)
A Lab module for fine-tuning favourites. In the 5★ Folder every favourite tile (home base and this device) has
**Tune ▸** (also the **Tune…** button for the selected one). It opens a window in the Lab window's place with:
- **Element rows**, grouped as Colour scheme (each window's colour, window saturation, background, glass accent,
  window outline), Texture (texture, strength, sheen), Knobs (cap, skirt, pointer, pointer colour), Text font (font,
  weight, case, letter spacing) and Text colour (label colour, nameplate). Each has ◀ ▶ buttons that cycle it through
  the values chosen in any favourite, never values outside them, shown with how many favourites use each (e.g. 4/7).
  Elements every favourite agrees on are listed under the group as fixed. Changed elements are outlined.
- **Group rows**: ◀ ▶ on a group's top row swap in another favourite's whole set for that group (the colour scheme
  brings its exact colour variation and any home-base overrides with it); the row names the favourite it matches, or
  "custom mix".
- **Adopt** (the app's look), **Save as favourite** (a new entry in this device's 5★ folder named "Favourite 4 tuned";
  "Send to home base" carries its name and origin), **Shuffle** (random pick among the favourites' values for every
  element), **Reset**, **Back**.
The panel previews every change live. Changing an element drops any home-base override that controls it. The work in
progress is kept in the Lab state, so it survives a reload. `#tune=h:3` opens the tuner on home-base favourite 4.
Tested in headless Chrome at 900 and 500 px wide with the seven home-base favourites: group and element cycling,
live CSS change, font change, save (name, origin, export), back, shuffle + adopt, reload.

## 19. Day / night schemes, presets, Capture (2026-10-16)
The header keys are now **Night/Day**, Freeze, Reset, **Save**, **Recall**, Record (**Capture** while frozen), Full.
Pause and Random are gone. Seven keys share the row (portrait) or column (landscape); the label size shrinks from the
layout's size only as far as the longest label any key can show ("Capture") needs to fit the key width.
- **Night / Day**: two colour schemes. Night is the standard look: home-base Favourite 6 tuned (`m4dqf4b`). Day is
  Favourite 17 tuned 2 (`3w46slf`). Both are built into `lab.js` (`BUILTIN`) and refreshed from
  `favorites/favorites.json` by id at startup, so editing either entry there changes the scheme. The key names the
  scheme on show; the choice is kept in the Lab state (`mode`). In the Lab, Adopt sets the look of the scheme on show
  and **Standard** (was Built-in) returns that scheme to its standard look. A look adopted before this change is
  dropped so the new standard shows. The original shipped look stays in `lab.js` as `ORIGINAL`.
- **Save / Recall**: one preset slot (localStorage `vfv-preset-v1`) holding every knob, the mixer puck and Chromakey
  on/off (what Reset restores); camera on/off is left alone. Recall with nothing saved flashes the key and says so.
- **Capture**: while Freeze is on and nothing is recording, Record becomes Capture, which saves the frozen output as a
  PNG at the full render resolution (720 x 1280 or 1280 x 720, `feedback-<date>-<time>.png`, via the browser's
  download). A take already running when Freeze goes on keeps its Stop key and records the frozen image as before.
Tested in headless Chromium (SwiftShader) at 900 x 1340 and 1340 x 910: Night look on first load, Night → Day switches
to Favourite 17 tuned 2 and survives a reload, Save/Recall restores knob and mixer values, Recall with no preset
flashes, Freeze turns Record into Capture and Capture saved a 720 x 1280 PNG, unfreezing restores Record, all seven
labels fit their keys in both layouts.

## 20. Day base for both schemes; header keys follow the background (2026-10-16)
- **Night is built on Day.** Both schemes now share Day's (Favourite 17 tuned 2) knobs, font (Saira Condensed, bold,
  tight spacing, uppercase) and label colour. Night differs only in its colour scheme (window colours, saturation,
  lightness, background, accent, outline), texture (texture, strength, sheen) and window labels (nameplates), which
  come from Favourite 6 tuned (`NIGHT_SRC` in `lab.js`, composed by `nightFrom`). Home-base edits to either favourite
  still carry over. Looks adopted per scheme before this change are dropped once (`lookV: 2`) so the new standards show.
- **Header keys:** Day/Night, Full, Freeze, Save, Recall, Record. Reset is removed. The keys take the background's
  colour and lightness (light keys with dark text on Day, slate keys with light text on Night); Freeze lights blue
  when on. The Day/Night key names and wears the colours of the scheme it switches to: on Day it is the dark Night key,
  on Night the light Day key. Record / Capture is red with white text (its LED turns white while recording). The
  styling is CSS from `schemeCss` in `lab.js` on keys marked `hk` by `makeKeys`.
- **Day bezel:** in the day scheme the ridge around the output is slate (the night background colour).
Checked in headless Chrome at 900 x 1340 and 1340 x 910: both schemes, key colours, Freeze on, Capture red.

## 21. Knob ranges, presets window (2026-10-16)
**Knobs** (`PD` in `script.js`):
- Blend Mode has five positions, Darken · Mix · Add · Mult · Diff (Darken keeps the darker of the feedback and the
  fresh image, by Persistence), with a 90 px drag for the full sweep (was 220) so it turns faster. The legend sits left
  of, centred above and right of the ring.
- Exponential tapers (`exp` in `PD`, `taper` / `untaper`): Modulate gives half its travel to 0–0.12 (`exp: 4`),
  Persistence half its travel to 0.92–1 (`exp: -5`); both step by 0.001.
- Ranges: Zoom 0.8–1.2× (2x), Rotate ±2 rad per frame (10x), Shift X / Y ±4% (2x), Hue Drift ±36° (2x), Saturation
  0.67–1.33× (⅓), Brightness ±0.33 (⅓), Contrast 0–2× (2x).
- Invert is removed (knob, uniform and shader step). Osc Speed became **Osc Size** (0.25–4×, log taper; the stripes
  are 8 per screen at 1×); the oscillator's speed is fixed at its old default, 0.3.
- Double-click returns a knob to zero (`zeroOf`): 0, or no effect where 0 isn't neutral (1× for Zoom, Contrast,
  Saturation and Osc Size; Mix for Blend Mode); the minimum where 0 is out of range (Softness, Noise Scale, Shape Sides).
- Chromakey's key has no label: it reads ON / OFF and glows in the accent colour while on.
- Camera: a tall On key on the left, Back over Front on the right.
- In landscape the Feedback window's first column shifts 24 px right so the legend clears the window edge.
**Header keys:** Day/Night, Full, Freeze, Presets, Record. Full's label sits in segmented corner brackets; Freeze has
blue text while off.
**Presets** replace Save / Recall: a list (localStorage `vfv-presets-v1`, newest first, up to 24) of every knob, the
mixer and Chromakey on/off, each with a 120 px JPEG of the output when saved. The Presets key opens a translucent,
blurred window over the output (inside the screen, below the Lab key); tap a card to recall it (it stays outlined),
× on a card to delete it, × in the corner or Escape to close. While the window is open the key reads **Save** and adds
a preset ("Preset N"). The old single slot (`vfv-preset-v1`) is carried over once as Preset 1, its Blend Mode number
shifted for Darken.
Tested in headless Chrome at 900 x 1340 and 1340 x 910: taper midpoints (Modulate 0.119, Persistence 0.924 at half
travel), double-click zero on every knob, Chromakey ON/OFF and glow, presets save (with picture) / recall / window in
both schemes and layouts, no console errors.

## 22. Presets window on phones, recording glow (2026-10-16)
- **Presets window** controls are sized in device pixels (`dp` in `renderPresets`: stage px = device px / stage
  scale), so they stay large where the stage is scaled down (a phone shows it at about 0.43): a 44 px **Save** button
  and 44 px close button in the header, 36 px delete buttons, 15 px names over 13 px dates, and 2–5 columns of cards
  about 110 px wide. The grid scrolls by touch and keeps its scroll position on redraw; the window redraws when the
  stage scale changes. Checked at 390 x 844 (phone emulation): Save 68 x 44, close 44 x 44, delete 36 x 36, two
  columns of 96 x 219 cards.
- **Rotate** is ±0.5 rad per frame (a quarter of the range set in §21).
- **Full and Record** have no indicator light (`noLed` keys: the state is kept as aria-pressed only). While
  recording, the Record key's text (Stop) pulses a soft white glow at 80 bpm (0.75 s, `rec-pulse` in `style.css`;
  a steady glow under reduced motion).
- **Chromakey OFF** reads in light grey (#b4b2b8).

## 23. Advanced page (experimental, 2026-10-22)
A **Main / Advanced** tab at the top right of the screen (the Lab key is top left) switches the panel between two
pages; the choice is kept (localStorage `vfv-page`). Since the second pass (below) the Advanced page has its own
arrangement (`buildAdvanced`): **Colors** along the whole bottom, and in the right column the **LFO** window (green,
the Chromakey family's colours) over the **Mix** window (purple, Transform's), which holds the XY pad. In landscape it
is transposed like the rest of the panel: Colors runs the full height of the right edge, LFO and Mix share the band
along the bottom.
- **Colors** is a hue EQ that scales saturation band by band around the spectrum. Twelve bands 30° apart from red
  (`eq0`..`eq11`, 0–2×, 1 = unchanged; part of presets) are joined by a smooth periodic Catmull-Rom curve, drawn over
  the spectrum on a glass screen that fills the window, with the spectrum strip under it greyed where the curve dips.
  Drag across the screen to draw the curve, wheel over a band to nudge it, double-click a band to flatten it,
  double-click the spectrum strip to flatten every band. In a tall window (landscape) the screen is drawn turned a
  quarter (hue downwards, level to the right). In the shader (`hueEq`) the same curve is sampled at each pixel's hue
  after Saturation, and the step is skipped while the EQ is flat.
- **LFO**: four oscillators at the top, their four target keys at the bottom (portrait: one oscillator per row, the
  keys 2 x 2 under a Targets rule; landscape: one LFO per column, its key at the foot). Each LFO has a **waveform**
  (`lfoNWave`: Sine, Tri, Saw, Square, S&H, picked on a small screen that shows the wave and where the LFO is in its
  cycle; tap, wheel or arrow keys step it), **Speed** (`lfoNRate`, 0.02–20 Hz, log), **Depth** (`lfoNDepth`) and a
  **target** (`lfoNTarget`, the id of a Main page knob or ''). All are part of presets.
- **Picking a target**: tapping a target key switches to the Main page with `pickLfo` set. Every Main page knob gets an
  orange ring (the LFO's current target is filled) and a bar across the foot of the screen names the LFO with Clear
  (no target) and Cancel. Tapping a knob makes it the target and returns to Advanced; Clear, Cancel, Escape or the
  Advanced tab return without one.
- **Modulation** (`liveParams`): each rendered frame the LFO phases advance with the render clock (so Freeze holds
  them), and the frame is drawn with a copy of the parameters in which every target is moved by Depth x 1/2 x the wave,
  in knob travel through the knob's taper (Depth 100% swings across the whole sweep, clamped at the ends; stepped knobs
  stay on their steps; LFOs sharing a target add up). The knobs keep showing where they are set; on the Main page an
  orange dot rides the scale of each driven knob, showing the value in use.
- **Mix**: the same XY layer mixer as in Layers on the Main page (`mixX`, `mixY`).

First pass (same day, replaced): the Advanced page kept every Main window in place, with Colors (Flat and Bypass keys
beside the EQ screen) in Layers' place and placeholder LFO, Luma Key, Kaleido and Clock modules whose knobs drove
nothing. The placeholders' `x_` parameters and `eqBypass` are gone; presets that hold them recall the rest.
Ring legends are generic (`legend: [...]` in `CONTROLS`, `ringLegend`), and On/Off keys share `makeOnOff`.
Tested in headless Chrome in 450 x 668 and 1000 x 680 windows (portrait, landscape): picking, Clear, Cancel and Escape;
LFO 1 on Zoom at Depth 100% swings the drawn zoom 0.81–1.2 around 1.012; no GL or console errors.

## 24. Colors EQ: seven-band parametric, four styles; Modulation (2026-10-24)
- The LFO window is titled **Modulation** (its four oscillators are still LFO 1–4).
- **Colors EQ** replaces the 12-band hue curve with a seven-band parametric EQ on saturation. Each band has a gain
  (`eqGn`, 0–2×, 1 = unchanged) on a vertical slider, a centre hue (`eqHn`; defaults red 0°, orange 30°, yellow 60°,
  green 120°, cyan 180°, blue 240°, magenta 300°) and a width (`eqWn`, ±6–120°, default ±22°, the bell's standard
  deviation). Saturation at a hue is multiplied by 1 + Σ (gain − 1) × bell, clamped at 0; `hueEq` in the shader applies
  the same sum (bands as `u_eqBand`: gain, hue and width in turns), skipped while every gain is 1. All are in presets;
  the old `eq0`..`eq11` are ignored on recall.
- **Four styles** to choose from in the app: keys **1–4** on the window's top edge (inside it when they don't fit, as
  in landscape) with the style's name beside them and **Flat** (every gain to 1). The choice is kept
  (localStorage `vfv-eq-style`).
  1. **Console**: per band a colour chip, a fader whose cap carries a stripe of the band's hue, and Hue (its scale ring
     is the spectrum) and Width knobs under it.
  2. **Spectrum**: one glass screen. Each band is a slider track standing on the spectrum at its hue, under the
     response curve; drag a cap up or down for gain, sideways for hue; the wheel or the Width knob (for the band last
     touched, named over the knob in its colour) sets the width, shown as a bracket.
  3. **Rainbow**: Hue and Width knobs over faders whose wide tracks run from grey through the band's hue to full
     colour, white caps, colour chips at the foot.
  4. **Wheel**: thin faders with round caps in the band's hue beside a polar screen (hue around a spectrum ring, gain
     outwards, the response as a closed curve); drag a band's dot around for hue and in or out for gain; Width knob as
     in Spectrum, the selected band's width drawn as an arc inside the ring.
  Faders snap to 1× at the centre line; double-click returns 1×; wheel and arrow keys nudge by 0.05.
Tested in headless Chrome at 900 x 1340 and 1340 x 910: all four styles build in both layouts, a fader drag to the top
gives 2×, double-click 1×; every gain 0 with wide bands turns the output grey (chroma 223 → 0); no GL or console
errors.

## 25. Modulation layouts (2026-10-24)
The Modulation window lays out its four LFO channels (each: **Wave** screen, **Speed**, **Depth**, **Target** key) in
one of four styles, picked in the app with keys **1–4** beside the style's name (on the window's top edge, or inside it
under the nameplate when they don't fit; kept in localStorage `vfv-mod-style`):
1. **Rows**: a channel per row, Wave · Speed · Depth · Target left to right; in a narrow window (portrait) Target sits
   under Wave.
2. **Columns**: a channel per column, Wave, Speed, Depth and Target top to bottom.
3. **Grid**: the channels as 2 × 2 tiles, Wave over the two knobs over Target; wide tiles (landscape) put Wave and
   Target on the left and the knobs on the right.
4. **Matrix**: a table with a row per feature, labelled Wave / Speed / Depth / Target, and a column per channel; in a
   wide window it turns (a column per feature under a header, a row per channel). The knobs drop their own labels.
Rows, Columns and Grid sit each channel on a faint plate. The style keys and their name chip are shared with Colors EQ
(`frameKeys`, `pickStyle`). The old Targets rule (`lfoRule`) is gone.
Tested in headless Chrome at 900 x 1340 and 1340 x 910: every style builds 4 wave screens, 8 knobs and 4 target keys,
none overlapping and all inside the window; tapping a wave screen steps its waveform; no console errors.

## 26. Colors EQ: eight OP-1-inspired styles (2026-10-24)
Styles 5–12 take their look from the Teenage Engineering OP-1 (inspired by it, not a copy of any of its screens). They
use black screens drawn in thin vector lines, flat light-grey keys and pads, and coloured endless encoders. An encoder's
colour matches the value it turns on screen: **blue** steps the selected band, **green** turns its gain, **white** its
hue and **orange** its width. Encoders turn by vertical drag (Shift for fine), the wheel or the arrow keys; double-click
resets. Relative changes (encoders, keys, pads) stop once at 1× on the way through.
5. **Encoders**: level bars, each band's bell drawn under its bar, and all four encoders.
6. **Keys**: a flat grey key per band with its level lit up the key (drag along it; a tap only selects), a curve
   screen, and the white and orange encoders.
7. **Dots**: a dot matrix, 8 dots per band (0.25–2× in quarter steps; the colour square is 0×). Tap or sweep across
   it to set levels. White and orange encoders.
8. **Dials**: arc gauges. Drag one up or down for gain; the orange arc in its foot is the width. White and orange
   encoders.
9. **Bloom**: a flower whose petals are the bands (angle = hue, length = gain, fatness = width; drag a petal's tip),
   with a value list beside it (tap a row to select) and all four encoders.
10. **Levels**: lollipop levels joined by cables to markers on a hue tape, greyed where saturation is cut. Sweep the
    levels for gain; slide a marker for hue. The wheel or the orange encoder sets width.
11. **Pads**: a grey pad per band holding a disc in its colour. The disc grows with the gain (the printed ring is 1×)
    and its glow shows the width. A tap steps 1 → 1.5 → 2 → 0 → 0.5×; drag for any level. A status screen sits above,
    with the white and orange encoders.
12. **Seven**: an encoder per band, capped in its colour, under a screen of readouts. The Gain / Hue / Width keys pick
    what all seven turn.
In a tall window (landscape) the bands run down the window. With more than six styles, `frameKeys` swaps the
numbered keys for a stepper: a chip with the style's number and name, plus ◀ ▶ keys. Twelve numbered keys don't fit
the landscape window. Tested in headless Chrome at 900 × 1340 and 1340 × 910: every style's controls stay inside the
window without overlapping; each style's drag, tap, encoder and key interactions change the intended parameters; no
console errors.


## 27. Brightness and Contrast at a tenth of their range (2026-10-24)
Brightness now spans ±1/30 (was ±1/3) and Contrast 0.9–1.1× (was 0–2×), with finer steps (0.0005) so both stay
smooth rather than stepped. The default contrast (1.03×) is unchanged. Recalling a preset clamps every numeric value into its
knob's current range, so presets saved with the old wide values land at the ends of the new ones.

## 28. Modulation fixed to Grid; Colors EQ style 5 as full-window faders (2026-10-24)
Modulation now always uses the Grid layout (2 x 2 tiles: Wave over Speed and Depth over Target; wide tiles put Wave
and Target on the left). Its style keys and the Rows, Columns and Matrix layouts are gone (`lfoMatrix`, the row and
column cell modes, `LFO_STYLES` and the `vfv-mod-style` key; recoverable from git at b921382).
Colors EQ style 5 (still named Encoders) is now seven equal columns filling the window and nothing else: no screen,
encoders or status line. Each column is a slider (tap or drag for the level; double-click returns 1x; the wheel and
arrow keys nudge). Building the style sets every band to the fixed default width (±22°). A column fills from the bottom
to its level. Below the middle line (1x) the fill is the band's colour, desaturating towards grey as the level drops
towards 0. Above the middle the fill is white.
Tested in headless Chrome at 900 x 1340 and 1340 x 910: Modulation builds 4 waves, 8 knobs and 4 targets with no
overlaps; the EQ builds 7 equal columns (108 px / 26 px wide); fills check out (1.6x: colour half plus 30% white;
0.4x: 20% greyed; 0x: empty); no errors.

## 29. Flicker reduction (2026-10-24)
Measured with a flicker meter (scratch test, headless Chrome, 720 x 1280). It renders deterministic frames, reads the
displayed image, and per pixel compares successive luminance changes. Reversal energy, sqrt(mean(max(0, -d1·d2))), is
the frame-to-frame back-and-forth; motion, mean |d1|, is all change. Units are 8-bit levels.

| setting | before: flicker / motion | after: flicker / motion |
|---|---|---|
| default | 5.80 / 5.82 | 2.71 / 4.45 |
| Diff blend | 6.95 / 7.98 | 1.88 / 4.34 |
| Delay 5 | 3.03 / 3.03 | 0.08 / 0.37 |
| zoom 0.94 | 4.54 / 4.41 | 2.29 / 3.41 |
| Noise layer | 4.29 / 5.45 | 3.61 / 5.16 |

Before, nearly all change at the default settings was reversal: pixels flipped between two values on alternate frames.
Diagnosis: with zoom, rotate, drift and Modulate at 0 the flicker was ~0. Hue Drift and the in-loop Contrast and
Saturation (above 1) each roughly doubled it. Moving edges, resampled every frame, get amplified.
Changes:
- **Half-float feedback slots** (RGBA16F, via EXT_color_buffer_float / _half_float, checked with a framebuffer
  completeness test, `detectFloatBuffers`; re-detected after a context loss). The fallback is RGBA8 with triangular
  dither written in the loop (`u_dither`). The display pass adds a fixed triangular dither when dropping to the 8-bit
  canvas. This removes rounding drift and banding; the meter barely moves (default 1.15 vs 1.05 with diffusion).
- **Diffusion** (`DIFFUSE` 0.1): the feedback read takes four extra taps 0.6 px off diagonally, as a camera's optics blur
  analogue feedback (the averaging term in Crutchfield's model). This is the largest single gain (default 1.91 → 1.05
  in the ablation with the other fixes in).
- **Diff**: the display shows the average of the last two frames (the loop itself still alternates).
- **Delay**: the loop always reads the last frame and mixes in a 50% tap from `delay` frames further back. Reading only
  the old frame interleaved delay + 1 separate loops and strobed between them.
- **Camera**: two textures, crossfaded from the previous frame to the newest over one camera frame interval (smoothed,
  15–100 ms), so a 24–30 fps camera doesn't step every other render. Costs up to one camera frame of latency.
- The bench hook hashes the 8-bit canvas after a display pass (`readPixels` as bytes can't read half-float slots).
Tried and not kept:
- **A soft knee instead of the final clamp**: at the defaults no pixel reaches 0 or 1, so the clamp wasn't a cause.
  A knee that eases into 0 sits above the identity line, so blacks drift up (mean 54 → 67).
- **Centring Modulate's offset on zero**: it cut default flicker to 1.05, but it took out the marbling, the look's main
  texture (motion 5.8 → 1.3, large flat bands). The one-sided offset stays.

## 30. Runaway guard (experimental, 2026-10-24)
A **Guard** key in the Color window (fifth item; saved with presets as `guardMode`) cycles through strategies that keep
the loop from running away to a saturated, white, black or flat field. Off is the default. The key's text glows while
the guard is acting; its tooltip shows the strategy, how hard it is acting, and the measured field.

**Measuring (an efficient proxy).** Every 4 frames the display shader draws the field into an 18 x 32 RGBA8 target
(`guard.fbo`). The read-back uses a pixel buffer and a fence, collected on a later frame, so the GPU never stalls. From
those 576 samples come brightness mean and spread, mean saturation (chroma), and the shares near white (L > 0.9) and
near black (L < 0.06). Excess scores (0–1) trigger past the healthy look (the default field: saturation ~0.83, spread
~0.06): saturation above 0.9, white above 25%, black above 40%, spread below 0.03. The corrections ease towards their
targets by 8% every frame, so nothing steps. The guard pass in the shader is skipped when every correction is neutral.

**Strategies** (`GUARD`; in the shader they act on last frame's image before the blend):
- **Dull**: every recursion eases 2.5% towards grey. No measuring.
- **Auto**: while the field runs away, scales last frame's saturation and levels by the inverse of the Saturation and
  Contrast knobs, so their compounding stops, plus a little more towards grey; lifts or lowers it.
- **AGC**: automatic levels, like a camera's gain control. Brings saturation (0.25–0.9), brightness (0.2–0.75) and
  spread (≥ 0.06) back into a band and leaves them alone inside it.
- **Breathe**: shortens Persistence by up to 45% while the field runs away, so the layers refill it.
- **Sharpen**: an unsharp mask plus a difference blend of the image against a 2.5 px blur (four extra taps, only while
  acting), triggered by a flat or white field.
- **Hybrid**: Auto and Breathe together.

**Results** (headless, 720 x 1280; 300 frames, then 60 measured. "Healthy" is the share of frames with spread > 0.03,
white and black < 50%, saturation < 0.95. White/black is the share of pixels; flicker uses the meter from §29).
Off runs away in every scenario except Default.

| scenario | Off | Dull | Auto | AGC | Breathe | Sharpen | Hybrid |
|---|---|---|---|---|---|---|---|
| Default (healthy %) | 47 | 85 | 85 | 100 | 98 | 100 | 100 |
| Add, Persistence 0.97: white % | 100 | 100 | 94 | 100 | 53 | 95 | 52 |
| Contrast 1.1 + Sat 4/3: healthy % | 0 (black) | 0 (flat colour) | 0 | 0 | 100 | 0 | 87 |
| Saturation 4/3: healthy % | 0 | 0 | 0 | 0 | 73 | 0 | 100 |
| Darken, Persistence 0.99: healthy % | 0 | 0 | 0 | 0 | 50 | 0 | 57 |
| Mult, Persistence 0.99: healthy % | 0 | 0 | 0 | 0 | 32 | 0 | 52 |
| Default flicker | 1.6 | 2.2 | 2.9 | 3.3 | 3.3 | 5.5 | 3.3 |

Findings:
- **Breathe** is the most dependable and the calmest: letting the fresh layers re-seed the field beats fighting the
  loop's own gain.
- **Hybrid** covers oversaturation fully, but flickers more (5.1) while pulling back from a blackout.
- **Dull** and **AGC** can't win against strong in-loop Contrast or Saturation (+10–33% a frame); they only tidy a
  healthy field.
- **Sharpen** amplifies the high frequencies that make up flicker and fights the diffusion. It barely dents a whiteout
  and adds flicker even on the default image; kept for comparison only.
- Every active strategy adds some flicker to the default image, because it keeps the field moving.

Cost: about 0.30–0.34 ms per frame for all strategies on a GTX 1070, within noise of Off; the proxy read is ~2 KB every
4 frames.

## 31. Colors EQ fixed to Encoders; Main / Mod header key; no Lab key (2026-10-24)
- **Colors EQ** is now only the Encoders layout: seven fader columns filling the window, plus the Flat key on its top
  edge. The other eleven styles (Console, Spectrum, Rainbow, Wheel and the OP-1 set) and their style stepper are gone,
  along with their helpers (`frameKeys`, `pickStyle`, the OP encoders and screens) and `vfv-eq-style`. They are
  recoverable from git at 85d2eda. With no hue or width controls left, the bands sit at fixed hues (`EQ_HUES`) and one
  fixed width (`EQ_WIDTH_DEG`, ±22°). The `eqHn` / `eqWn` / `eqWsel` parameters are removed, and presets that carry
  them simply skip them.
- **Header keys**: Full is replaced by a **Main / Mod** key showing both names. The page on show is at full strength
  and underlined, the other dimmed, so it reads on light and dark keys alike. Tapping switches pages; the names stack in
  the tall keys of the landscape layout. "Advanced" is renamed **Mod** wherever it shows (the page id stays 'adv' and
  `vfv-page` is unchanged). The Main / Advanced tabs on the screen are gone. Fullscreen remains as a double-click on the
  screen.
- **Lab key removed** from the screen. The Style Lab still applies the colour schemes; its window opens only from the
  address (`#lab`, `#tune=...`), and a Lab left open by an earlier session starts closed.

## 32. Standing UI rules (from Kyle, 2026-10-24)
1. **Toggle keys name only the alternative.** A key that switches between views or modes (Day / Night, Main / Mod)
   shows only the option the user can switch to now: "Night" while in Day, "Mod" while on Main. It never shows the
   current state, and never both names. The Main / Mod key now follows this (it had shown both with the current one
   underlined, §31).
2. **Don't stretch to fill.** Avoid extending a key, row or column so it wastes space. When something doesn't fit or
   leaves a gap, find a different arrangement, commit it, and flag that decision for Kyle to review.

## 33. Mod page colours (2026-10-24)
Modulation now takes the red Feedback family colours (fam 'feedback': window surface, nameplate, knob pointers and
labels) and Mix the green Chromakey family (fam 'chroma').

## 34. Guard fixed to Breathe; coloured header keys (2026-10-24)
- **Guard**: Breathe is now always on, with no key. The Color window is back to four knobs. While the measured field
  runs away (saturated, white, black or flat; triggers as in §30), Persistence is shortened by up to 45%, eased in and
  out. Dull, Auto, AGC, Sharpen and Hybrid are removed, along with the shader's guard operations and `guardMode`;
  they are recoverable from git at 85d2eda. Results with it always on (headless, as in §30): Contrast 1.1 +
  Saturation 4/3 is 100% healthy (was black); Saturation 4/3 is 73% healthy (was flat magenta); Add at Persistence 0.97
  is 53% white (was 100%). On the default image it acts at times (its saturation peaks past the trigger): mean
  saturation 0.77 vs 0.93 without it, flicker 3.5 vs 1.6. Cost about 0.31 ms per frame, as without it.
- **Header keys**, each in its own colour in both schemes (the Style Lab's key CSS, classes hk-green / hk-blue /
  hk-yellow / hk-rec):
  - Main/Mod **green**.
  - Freeze/Play **blue**: it now reads Play while frozen. Its old blue-tint-when-on treatment is gone.
  - Presets/Output **yellow** with dark type: while the presets window is open the key reads Output and closes it.
    Saving is the window's own Save button; the key no longer saves.
  - Record red.
  - Day/Night keeps the other scheme's colours.
  All follow §32: they name the option a tap gives.

## 35. Header key order (2026-10-24)
The header keys now run Day/Night, Presets/Output, Record, Freeze/Play, Main/Mod (left to right in portrait, top to
bottom in landscape).

## 36. Colors EQ: spaced faders, blue window (2026-10-24)
The seven faders now sit the standard spacing apart (the window's inner margin: `PG` = 14 px in portrait, 16 in
landscape), which narrows them. The window has its own family, `eq`, blue in both schemes: the Style Lab gives it the
look's blue window colour when the look has one (Layers in Day, Color in Night), else hue 215.

## 37. Square Camera and Chromakey keys (2026-10-24)
- **Camera** is one square key (On, Back and Front keys merged). A tap steps On -> Front <-> Back: while off it reads
  On and a tap starts the front camera; while live it names the camera in use, LED lit, and a tap switches to the
  other one. Press and hold (0.6 s) turns the camera off.
- **Chromakey** On/Off is square.
- Both keys share one side, `sqSide()`: 52 x UK, or wider if Front would not fit (78 px in portrait).

## 38. Narrower Colors EQ bands (2026-10-24)
Each band's width (`EQ_WIDTH_DEG`, the bell's standard deviation) is now ±14° (was ±22°). Halfway between bands 30°
apart (Red, Orange, Yellow) a band now reaches 56% of its gain (was 79%); halfway between bands 60° apart, 10% (was 39%).

## 39. Colors EQ bands narrowed again (2026-10-24)
`EQ_WIDTH_DEG` is now ±9° (was ±14°). Halfway between bands 30° apart a band reaches 25% of its gain; between bands
60° apart, under 1%: each fader now acts on its own colour only.

## 40. Header-key colour variants (experimental, 2026-10-25)
A **Keys n/8** key at the screen's top left (where the Lab key was, so no row or window grows) steps through eight
colour variants of the header keys; the choice is kept in localStorage `vfv-keys-var`. Constraints:
- Record stays red and Freeze a blue.
- Main/Mod and Presets are each a purple, yellow or green.
- The Day/Night key keeps its black / white (the other scheme's colours).
Variants (lab.js `KEYV`; finishes from `skinCss`):

| # | name | finish | Mod | Freeze | Presets | Record |
|---|---|---|---|---|---|---|
| 1 | Bright (the §34 colours) | glossy solid | green | blue | yellow | red |
| 2 | Royal | glossy solid | purple | royal blue | gold | red |
| 3 | Pastel | glossy solid, dark type | lavender | powder blue | sage | coral red |
| 4 | Anodized | glossy solid, deep | deep purple | navy | forest green | oxblood |
| 5 | Outline | dark body, coloured rim and type | yellow | blue | purple | red |
| 6 | LED | dark body, coloured light bar under the type | green | blue | yellow | red |
| 7 | Neon | dark body, glowing type and halo | violet | electric blue | lime | red |
| 8 | Synth | matte flat | mustard | teal blue | plum | red |

The header keys now carry role classes (`hk-page`, `hk-freeze`, `hk-presets`, `hk-rec`) instead of colour names.

## 41. Centred taper on the Transform and Color knobs (2026-10-25)

Kyle asked for the Transform and Color knobs to be exponential, with values between -0.1 and 0.1 taking more of the
travel around the top. Every one of these knobs has its neutral value at mid-range (Zoom, Saturation and Contrast 1x;
Rotate, Shift X/Y, Hue Drift, Hue and Brightness 0), so "-0.1 to 0.1" is read as the inner 10% of the range on either
side of the centre. Their units differ (Hue Drift's whole range is ±0.1), so a literal ±0.1 wouldn't apply to all of them.

- `bi: true` in `PD` selects a mirrored sinh taper, `0.5 + 0.5 sinh(k(2u - 1)) / sinh(k)` with `BI_K` = 4. The inner
  ±10% of the range covers ±58° of the dial (it was ±13.5°), so it takes 43% of each side's travel. A sinh keeps a finite
  slope at the centre (0.15 of linear), so the top of the knob still moves the value; a plain power curve goes flat there.
- The steps are finer (e.g. Rotate 0.001 → 0.0002 rad), so rounding doesn't add a dead zone at the slow centre.
- The snap to neutral is measured in knob travel (1.5%, about ±4°) instead of in range: 1.5% of the range would have
  covered ±19% of the travel.
- Hue moves from 0-360 to -180-180 so that 0 sits at the top like the rest of the row. Presets saved with a Hue above
  180 wrap on recall, and the shader is unchanged (`fract` handles negative hues).
- Some readouts gained a decimal to show the finer centre values: Brightness 4, Contrast 4, Saturation 3, Hue Drift 2.
- LFOs modulate in knob travel (§ LFO engine), so on these knobs a shallow LFO set near the centre now moves the value
  less, and the same depth further out moves it more.
- For review: the strength (`BI_K`) is one constant; 3 gives 29% of the travel to the inner 10%, 5 gives 54%.

## 42. Mod page in the Main page's windows; Trigger window (prototype, 2026-10-25)

Kyle asked for three changes. Mix should run to the bottom of the page, with a narrower Colors EQ to make room.
Modulation should match Feedback and Chromakey in length, and Mix should match Transform and Color. Mix becomes
"Trigger": ADSR modulation of targeted parameters, fired from three keys at the top.

**Layout.** The Mod page now reuses the Main page's window boxes in both orientations: Colors EQ takes Layers' place,
Modulation spans Feedback and Chromakey, and Trigger spans Transform and Color. In portrait, Trigger runs to the foot
of the right column, and the EQ sits under the header keys at the screen's width. Landscape is the transposed version:
Trigger runs out to the right edge, and the EQ is the column beside the header keys. The XY pad leaves the Mod page;
it's still on the Main page, in Layers.

**Trigger.** There are three triggers, each with Attack (5 ms-5 s), Decay (10 ms-5 s), Sustain (0-100%), Release
(10 ms-10 s), Depth (-100% to +100% of the target knob's sweep, snapping to 0) and a Target (any Main page knob,
picked as for an LFO).
- Pressing a key fires its trigger. Holding the key holds the sustain, and letting go starts the release. A retrigger
  starts the attack from the current level, so the value never jumps. The attack is a straight rise; decay and release
  are curves (quadratic ease-out).
- Space or Enter on a focused key fires it, and so do 1-3 on the keyboard on either page. On the Main page, 1-3 fire
  without changing the selection.
- The move is Depth × level in knob travel, added to any LFO on the same knob, so the Main page's orange dots show
  triggers too. Envelopes run on the render clock, like the LFOs, and so they stop during Freeze.
- Each starts on a different target and shape so the keys do something at once: 1 is a zoom punch, 2 a hue swell,
  3 a rotation kick in reverse.

**Decisions for review**
- *Selecting:* there's room for one envelope's controls, so pressing a key also selects that trigger for the editor
  below: an envelope screen, five knobs and the Target key. The key's LED marks the selected trigger, and every key
  glows orange with its envelope's level. The editor knobs follow the selection through a new `knob()` option,
  `pkey`, so there's no rebuild (a rebuild while a key is held would lose the release).
- *Arrangement:* in portrait, the knobs sit two to a row, with Target beside Depth. Seven words of label at 2× don't
  fit in one row. In landscape, the five knobs share one row beside the screen, and there's some free height above and
  below them. I left it free rather than stretch the screen or the knobs.
- *Keyboard:* the digits 1-3 weren't used by anything else.

## 43. Target keys and the Modulation tiles (2026-10-25)

- Every Target key (the four LFOs' and the Trigger window's) reads TARGET in red (`P.rec`) while it has no target, and
  the target knob's name in white once it has one. The "1 ·" and "Target ·" prefixes and the keys' LEDs are gone
  (`syncTargetKey`).
- Each Modulation tile puts its Target key directly under the waveform screen, with Speed above Depth below it. A wide
  tile has the waveform over Target on the left and Speed over Depth on the right.
- For review: in landscape, the Modulation window has the tiles in one row of four instead of 2 × 2, because a window
  more than 1.6× as wide as it is tall gets four across. In 2 × 2, the tiles there are wide and short, and two knobs
  stacked would have shrunk to about 26 px. One row gives tall tiles, like portrait's, with full-size knobs.
