'use strict';

// ===================================================================
// Video Feedback Visualizer
// See DESIGN.md for the full design (ping-pong framebuffer technique,
// GLSL formula reference, pipeline order, non-goals for v1).
//
// File is organized top-to-bottom as:
//   1. Palette and UI kit (ported from the Oscilloscope Visualizer's
//      L9 panel: sections, MS-20 knobs, rubber keys, glass screens)
//   2. Parameter definitions + state
//   3. Panel layout (fixed 900 x 1440 stage, scaled to the window)
//   4. WebGL2 boilerplate + ring-buffer framebuffers
//   5. GLSL source (vertex, feedback fragment, display fragment)
//   6. Camera source
//   7. Uniform upload + render loop
//   8. Header keys (day-night/fullscreen/freeze/save/recall/record-capture), presets, recording, fit to window
// ===================================================================

var REPORT = [];
window.addEventListener('error', function (e) { REPORT.push('ERROR ' + e.message + ' @' + e.lineno); });

// -------------------------------------------------------------
// 1. Palette and UI kit
// -------------------------------------------------------------
var P = { ink: '#ebebeb', inkDim: '#a6a4a8', inkMute: '#8f8d92', line: '#515053', accent: '#dce8ff', accentGlow: 'rgba(160,195,255,0.8)', accent3: '#af78ed', select: '#eded78',
  rec: '#f0484a', off: '#3d3b40', mod: '#ff9a3c', modGlow: 'rgba(255,154,60,0.75)', byp: '#3568b8', tabSub: '#333236', idle: '#77757b' };
var ICON_GREEN = '#3fbf6a';
var TAU = Math.PI * 2;
function clamp(v, a, b) { a = a == null ? 0 : a; b = b == null ? 1 : b; return v < a ? a : v > b ? b : v; }
var stage = document.getElementById('stage'), panel = document.getElementById('panel'), tip = document.getElementById('tip');
function el(tag, style, parent, text) {
  var e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text != null) e.textContent = text;
  (parent || panel).appendChild(e);
  return e;
}
function at(x, y, w, h) { return 'position:absolute;left:' + x + 'px;top:' + y + 'px' + (w != null ? ';width:' + w + 'px' : '') + (h != null ? ';height:' + h + 'px' : ''); }
function PRINT(fs, col) { return 'font-size:' + fs + 'px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:' + (col || P.inkMute) + ';line-height:1;white-space:nowrap'; }
function cl(x, y, w, t, st) { return el('span', at(x - w / 2, y, w) + ';text-align:center;' + st, panel, t); }

var dragging = false;
function stageScale() { return parseFloat(stage.dataset.scale || '1'); }
function showTip(target, text) {
  var r = target.getBoundingClientRect(), s = stage.getBoundingClientRect(), k = stageScale();
  var lines = String(text).split('\n').length;   // a tip of several lines grows upwards
  tip.textContent = text;
  tip.style.whiteSpace = lines > 1 ? 'pre' : '';
  tip.style.display = 'block';
  tip.style.left = ((r.left + r.width / 2 - s.left) / k) + 'px';
  tip.style.top = ((r.top - s.top) / k - 24 - 15 * (lines - 1)) + 'px';
}
function hideTip() { tip.style.display = 'none'; }
var tipTimer = 0;
function flashTip(target, text) { showTip(target, text); clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 2200); }

// Value <-> knob position (0..1), with optional log taper, exponential taper (exp > 0 gives the low end more of the
// travel, exp < 0 the high end) and a snap point (e.g. Zoom snaps to 1, Rotate to 0).
function taper(d, u) { var k = Math.abs(d.exp), e = Math.exp(k) - 1; return d.exp > 0 ? (Math.exp(k * u) - 1) / e : 1 - (Math.exp(k * (1 - u)) - 1) / e; }
function untaper(d, f) { var k = Math.abs(d.exp), e = Math.exp(k) - 1; return d.exp > 0 ? Math.log(1 + f * e) / k : 1 - Math.log(1 + (1 - f) * e) / k; }
function toV(d, x) {
  if (d.log) return Math.log(x / d.min) / Math.log(d.max / d.min);
  var f = clamp((x - d.min) / (d.max - d.min));
  return d.exp ? untaper(d, f) : f;
}
// The value a double-click returns a knob to: 0, or no effect where 0 isn't the neutral value (1x for Zoom, Contrast,
// Saturation and Osc Size; Mix for Blend Mode); the knob's minimum where 0 is out of range.
function zeroOf(d) { return d.zero != null ? d.zero : d.snap != null ? d.snap : clamp(0, d.min, d.max); }
function fromV(d, v) {
  v = clamp(v);
  var x = d.log ? d.min * Math.pow(d.max / d.min, v) : d.min + (d.exp ? taper(d, v) : v) * (d.max - d.min);
  if (d.step) x = +(Math.round(x / d.step) * d.step).toFixed(6);
  if (d.snap != null && Math.abs(x - d.snap) < 0.015 * (d.max - d.min)) x = d.snap;
  return clamp(x, d.min, d.max);
}
var steps = function (d) { var n = d.step ? Math.round((d.max - d.min) / d.step) + 1 : 0; return n && n <= 61 ? n : 0; };

// Vertical drag (Shift = fine), wheel, double-click = zero (ctl.def).
function dragValue(target, ctl, range) {
  target.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); target.setPointerCapture(e.pointerId); dragging = true;
    var raw = ctl.v, ly = e.clientY;
    var move = function (ev) { raw = clamp(raw + (ly - ev.clientY) / (ev.shiftKey ? range * 10 : range)); ly = ev.clientY; ctl.set(raw); showTip(target, ctl.text()); };
    var up = function () { dragging = false; target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); hideTip(); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
    showTip(target, ctl.text());
  });
  target.addEventListener('pointerenter', function () { if (!dragging) showTip(target, ctl.text()); });
  target.addEventListener('pointerleave', function () { if (!dragging) hideTip(); });
  target.addEventListener('dblclick', function () { if (ctl.def != null) { ctl.set(ctl.def); showTip(target, ctl.text()); } });
  target.addEventListener('wheel', function (e) {
    e.preventDefault();
    var st = ctl.steps ? 1 / (ctl.steps - 1) : (e.shiftKey ? 0.002 : 0.01);
    ctl.set(clamp(ctl.v - (e.deltaY > 0 ? st : -st))); showTip(target, ctl.text());
  }, { passive: false });
}

// Outlined section with its nameplate tab on the top border. fam names the parameter family, whose surface texture
// (a .fam-<fam> fill under the outline) and nameplate colour come from the Anodized theme in style.css.
var SEC_R = 3; // section corner radius (a layout engine can change it)
// Control and label scale for the makers below (labels include the section nameplates): 1 by default; the portrait
// built-in layout sets 1.2 and 2.
var UK = 1, UL = 1;
function sec(x, y, w, h, title, fam) {
  if (fam) famFill(fam, x, y, w, h, roundedPath([[0, 0], [w, 0], [w, h], [0, h]]));
  var b = el('div', at(x, y, w, h) + ';box-sizing:border-box;border:1px solid ' + P.inkMute + ';border-radius:' + SEC_R + 'px;pointer-events:none');
  if (fam) { b.className = 'frame frame-' + fam; b.dataset.fam = fam; }
  b.tab = nameplate(b, UL > 1 ? 8 : 12, -9 * UL, title, fam);   // 2x nameplates sit closer in, to fit narrow windows
  return b;
}
function nameplate(parent, x, y, title, fam) {
  var t = el('span', at(x, y) + ';padding:' + 2 * UL + 'px 8px;background:' + P.ink + ';color:#19181a;font-size:' + 10 * UL + 'px;font-weight:800;letter-spacing:' + (UL > 1 ? 0.1 : 0.16) + 'em;text-transform:uppercase;line-height:' + 14 * UL + 'px;white-space:pre', parent, title);
  if (fam) { t.className = 'tab tab-' + fam; t.dataset.fam = fam; }
  return t;
}
// Path through right-angled points (clockwise) with 3 px rounded corners, offset by (ox, oy).
function roundedPath(pts, ox, oy) {
  var r = SEC_R, d = '';
  ox = ox || 0; oy = oy || 0;
  for (var i = 0; i < pts.length; i++) {
    var p0 = pts[(i + pts.length - 1) % pts.length], p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    var a = [Math.sign(p1[0] - p0[0]), Math.sign(p1[1] - p0[1])], b = [Math.sign(p2[0] - p1[0]), Math.sign(p2[1] - p1[1])];
    var s = [p1[0] - a[0] * r - ox, p1[1] - a[1] * r - oy], e = [p1[0] + b[0] * r - ox, p1[1] + b[1] * r - oy];
    d += (i ? 'L' : 'M') + s[0] + ' ' + s[1] + 'Q' + (p1[0] - ox) + ' ' + (p1[1] - oy) + ' ' + e[0] + ' ' + e[1];
  }
  return d + 'Z';
}
// The family's surface: a box clipped to the section's shape, behind everything drawn after it.
function famFill(fam, x, y, w, h, d) {
  var f = el('div', at(x, y, w, h) + ';pointer-events:none;clip-path:path("' + d + '");-webkit-clip-path:path("' + d + '")');
  f.className = 'fam fam-' + fam; f.dataset.fam = fam;
  return f;
}
// Knob scale: n ticks spread over the 270-degree sweep (11 by default; stepped knobs get one tick per position).
function scaleCss(n) {
  var per = 270 / (n - 1);
  return 'position:absolute;inset:0;border-radius:50%;background:repeating-conic-gradient(from -136deg,' + P.inkDim + ' 0deg 2deg,transparent 2deg ' + per + 'deg);' +
    '-webkit-mask:radial-gradient(closest-side,transparent calc(100% - 6px),#000 calc(100% - 5px)),conic-gradient(from -137deg,#000 0deg 274deg,transparent 274deg);-webkit-mask-composite:source-in;' +
    'mask:radial-gradient(closest-side,transparent calc(100% - 6px),#000 calc(100% - 5px)),conic-gradient(from -137deg,#000 0deg 274deg,transparent 274deg);mask-composite:intersect;pointer-events:none';
}
// MS-20 knob centred on (x, y) bound to params[key] through definition PD[key]. o: fs, ticks, after, fam, range (px of
// drag for the full sweep).
// Parts carry knob-* classes (and the wrap data-fam) so design-mode colour schemes can restyle them.
var syncers = [];
function knob(x, y, size, label, key, o) {
  o = o || {};
  var d = PD[key], R = size / 2 + 10, S = 2 * R;
  var wrap = el('div', at(x - R - 16, y - R, S + 32) + ';display:flex;flex-direction:column;align-items:center;pointer-events:none');
  wrap.className = 'knob'; if (o.fam) wrap.dataset.fam = o.fam;
  var ring = el('div', 'position:relative;flex:none;width:' + S + 'px;height:' + S + 'px;cursor:ns-resize;touch-action:none;pointer-events:auto', wrap);
  ring.setAttribute('role', 'slider'); ring.tabIndex = 0;
  el('div', scaleCss(o.ticks || 11), ring).className = 'knob-scale';
  var skirt = el('div', 'position:absolute;left:10px;top:10px;width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:repeating-conic-gradient(#1f1e21 0deg 4deg,#121113 4deg 8deg);box-shadow:0 0 0 1px #050505,0 6px 10px rgba(0,0,0,0.6);pointer-events:none', ring);
  skirt.className = 'knob-skirt';
  el('div', 'position:absolute;inset:15%;border-radius:50%;background:radial-gradient(circle at 45% 35%,#3b393e 0%,#201f22 60%,#161517 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,0.10)', skirt).className = 'knob-cap';
  var ptr = el('div', 'position:absolute;inset:0', skirt);
  el('div', 'position:absolute;left:50%;top:4%;width:2px;height:42%;margin-left:-1px;border-radius:1px;background:' + P.ink, ptr).className = 'knob-ptr';
  var lab = el('span', (UL > 1 ? 'margin-top:3px;line-height:1;' : 'margin-top:5px;') + 'font-size:' + (o.fs || 10 * UL) + 'px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:' + P.inkDim + ';white-space:nowrap', wrap, label);
  lab.className = 'knob-label';
  var k = {
    v: 0, R: R, steps: steps(d), def: toV(d, zeroOf(d)),
    text: function () { return label + '  ' + d.f(params[key]); },
    show: function (v) { k.v = v; ptr.style.transform = 'rotate(' + (-135 + v * 270) + 'deg)'; ring.setAttribute('aria-valuetext', d.f(params[key])); },
    set: function (v) { var x = fromV(d, v); params[key] = x; k.show(k.steps ? toV(d, x) : clamp(v)); if (o.after) o.after(x); },
    sync: function () { k.show(toV(d, params[key])); ring.setAttribute('aria-label', label); if (o.after) o.after(params[key]); }
  };
  k.sync();
  dragValue(ring, k, o.range || 220);
  ring.addEventListener('keydown', function (e) {
    var st = k.steps ? 1 / (k.steps - 1) : 0.01;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { k.set(clamp(k.v + st)); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { k.set(clamp(k.v - st)); e.preventDefault(); }
  });
  syncers.push(k.sync);
  (ui.knobs = ui.knobs || {})[key] = { ring: ring, R: R, x: x, y: y };   // for LFO target picking and modulation dots
  return k;
}

// Rubber key. led: on / sel / rec / off / null. o: glyph, fs, onClick, aria, tint ('blue': no LED, the whole key lights),
// noLed (the state is kept, and shown only as aria-pressed).
var LED = { on: P.accent, sel: P.select, rec: P.rec, off: P.off, mod: P.mod };
var TINT = {
  blue: { on: ['linear-gradient(to bottom,#5b8fe0,#3568b8)', '0 2px 0 #0f0e10,0 4px 7px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.3)', '#ffffff'],
          off: ['linear-gradient(to bottom,#2e3c55,#222d40)', '0 2px 0 #0f0e10,0 4px 7px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.06)', '#7d8cab'] }
};
function key(x, y, w, h, label, led, o) {
  o = o || {};
  var tint = o.tint ? TINT[o.tint] : null, init = led;
  if (tint) led = null;
  var b = el('button', at(x, y, w, h) + ';box-sizing:border-box;padding:' + (led != null && !o.noLed ? '6px' : '0') + ' 0 0;border:none;border-radius:5px;' +
    'background:linear-gradient(to bottom,#49474d,#363439 55%,#2d2c30);box-shadow:0 2px 0 #0f0e10,0 4px 7px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.09);' +
    'display:flex;align-items:center;justify-content:center;font-family:inherit;font-size:' + (o.fs || 10 * UL) + 'px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:' + P.ink + ';cursor:pointer;transition:transform 40ms');
  b.type = 'button'; b.setAttribute('aria-label', o.aria || label); b.className = tint ? 'key key-tint' : 'key';
  var ledEl = el('span', 'position:absolute;left:50%;top:5px;width:10px;height:3px;margin-left:-5px;border-radius:2px', b);
  var txt = el('span', '', b, o.glyph || label || '');
  var k = {
    b: b, txt: txt, state: null,
    set: function (s) {
      k.state = s;
      if (tint) {
        ledEl.style.display = 'none';
        var on = s != null && s !== 'off', st = tint[on ? 'on' : 'off'];
        b.style.background = st[0]; b.style.boxShadow = st[1]; b.style.color = st[2]; b.setAttribute('aria-pressed', on ? 'true' : 'false');
        return;
      }
      if (o.noLed) { ledEl.style.display = 'none'; b.setAttribute('aria-pressed', s != null && s !== 'off' ? 'true' : 'false'); return; }
      if (s == null) { ledEl.style.display = 'none'; return; }
      ledEl.style.display = ''; ledEl.style.background = LED[s]; ledEl.style.boxShadow = s === 'off' ? 'none' : '0 0 7px ' + LED[s];
      b.setAttribute('aria-pressed', s === 'off' ? 'false' : 'true');
    }
  };
  k.set(tint ? init : led);
  b.addEventListener('pointerdown', function () { b.style.transform = 'translateY(1px)'; });
  ['pointerup', 'pointerleave'].forEach(function (ev) { b.addEventListener(ev, function () { b.style.transform = ''; }); });
  if (o.onClick) b.addEventListener('click', o.onClick);
  return k;
}
function flash(k) { var s = k.state; k.set('rec'); setTimeout(function () { k.set(s); }, 300); }
function glass(x, y, w, h, aria) {
  var g = el('div', at(x, y, w, h) + ';border-radius:4px;background:#050406;box-shadow:inset 0 2px 5px rgba(0,0,0,0.9),0 1px 0 rgba(255,255,255,0.06);overflow:hidden');
  g.setAttribute('aria-label', aria);
  var c = el('canvas', 'position:absolute;inset:0;width:100%;height:100%', g);
  c.width = Math.round(w * 2); c.height = Math.round(h * 2);
  return { g: g, c: c, x: c.getContext('2d'), w: c.width, h: c.height };
}
function syncUI() { syncers.forEach(function (s) { s(); }); }

// -------------------------------------------------------------
// 2. Parameter definitions + state
// -------------------------------------------------------------
var RING_SIZE = 32; // feedback history slots (see section 4); Delay reaches RING_SIZE - 2 frames back
var BLEND_NAMES = ['Darken', 'Mix', 'Add', 'Mult', 'Diff'];
var sgn = function (v, n) { return (v > 0 ? '+' : '') + v.toFixed(n); };
var deg = function (v) { return Math.round(v) + '°'; };
var pct = function (v) { return Math.round(v * 100) + '%'; };
// def: the starting value; zero: where a double-click returns the knob (see zeroOf); exp, log, snap: see toV / fromV.
var PD = {
  // Feedback
  blendMode: { min: 0, max: 4, def: 1, zero: 1, step: 1, f: function (v) { return BLEND_NAMES[v]; } },
  modulateAmount: { min: 0, max: 1, def: 0.15, step: 0.001, exp: 4, f: function (v) { return v < 0.0005 ? 'Off' : v.toFixed(3); } },   // half the travel below 0.12
  feedback: { min: 0, max: 1, def: 0.94, step: 0.001, exp: -5, f: function (v) { return v.toFixed(3); } },   // half the travel above 0.92
  delay: { min: 0, max: RING_SIZE - 2, def: 0, step: 1, f: function (v) { return v < 0.5 ? 'Live' : v + (v === 1 ? ' frame' : ' frames'); } },
  // Transform (per frame)
  zoom: { min: 0.8, max: 1.2, def: 1.012, step: 0.001, snap: 1, f: function (v) { return v.toFixed(3) + '×'; } },
  rotate: { min: -0.5, max: 0.5, def: 0.012, step: 0.001, snap: 0, f: function (v) { return sgn(v * 180 / Math.PI, 2) + '°'; } },
  translateX: { min: -0.04, max: 0.04, def: 0, step: 0.0005, snap: 0, f: function (v) { return sgn(v * 100, 2) + '%'; } },
  translateY: { min: -0.04, max: 0.04, def: 0, step: 0.0005, snap: 0, f: function (v) { return sgn(v * 100, 2) + '%'; } },
  hueDrift: { min: -0.1, max: 0.1, def: 0.01, step: 0.001, snap: 0, f: function (v) { return sgn(v * 360, 1) + '°'; } },
  // Color
  hue: { min: 0, max: 360, def: 0, step: 1, f: deg },
  saturate: { min: 2 / 3, max: 4 / 3, def: 1.1, step: 0.005, snap: 1, f: function (v) { return v.toFixed(2) + '×'; } },
  brightness: { min: -1 / 30, max: 1 / 30, def: 0, step: 0.0005, snap: 0, f: function (v) { return sgn(v, 3); } },
  contrast: { min: 0.9, max: 1.1, def: 1.03, step: 0.0005, snap: 1, f: function (v) { return v.toFixed(3) + '×'; } },
  // Chromakey (key colour as HSL)
  keyHue: { min: 0, max: 360, def: 120, step: 1, f: deg },
  keySat: { min: 0, max: 1, def: 1, step: 0.01, f: pct },
  keyLight: { min: 0, max: 1, def: 0.5, step: 0.01, f: pct },
  chromakeyThreshold: { min: 0, max: 1.5, def: 0.4, step: 0.01, f: function (v) { return v.toFixed(2); } },
  chromakeySoftness: { min: 0.001, max: 0.5, def: 0.15, step: 0.001, f: function (v) { return v.toFixed(3); } },
  // Layers
  oscSize: { min: 0.25, max: 4, def: 1, log: true, step: 0.01, snap: 1, f: function (v) { return v.toFixed(2) + '×'; } },   // band width (8 bands at 1x)
  noiseScale: { min: 0.5, max: 20, def: 4, step: 0.1, f: function (v) { return v.toFixed(1); } },
  shapeSides: { min: 3, max: 12, def: 5, step: 1, f: function (v) { return v + ' sides'; } }
};
// Advanced page (experimental): four LFOs, each with a waveform, a speed, a depth and a target (one of the Main page's
// knobs, or none). Depth is a share of the target knob's sweep, peak to peak, around where the knob is set.
var LFO_N = 4, LFO_WAVES = ['Sine', 'Tri', 'Saw', 'Square', 'S&H'];
var LFO_DEF = { wave: [0, 1, 2, 4], rate: [0.1, 0.25, 0.5, 1] };
for (var q = 0; q < LFO_N; q++) {
  PD['lfo' + q + 'Wave'] = { min: 0, max: 4, def: LFO_DEF.wave[q], zero: 0, step: 1, f: function (v) { return LFO_WAVES[v]; } };
  PD['lfo' + q + 'Rate'] = { min: 0.02, max: 20, def: LFO_DEF.rate[q], log: true, step: 0.01, f: function (v) { return v.toFixed(2) + ' Hz'; } };
  PD['lfo' + q + 'Depth'] = { min: 0, max: 1, def: 0.3, step: 0.01, f: pct };
}
// Fixed generator settings that no longer have knobs.
var FIXED = { frequency: 8, speed: 0.3, sync: 0.2, shapeSmoothing: 0.05, noiseSpeed: 0.2 };
// Colors EQ (Advanced page): seven bands at fixed hues (EQ_HUES) and a fixed width (EQ_WIDTH_DEG, degrees: each bell's
// standard deviation), each with a gain (eqGn, 0-2x saturation, 1 = unchanged) on a fader.
var EQ_N = 7, EQ_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta'], EQ_HUES = [0, 30, 60, 120, 180, 240, 300];
var EQ_WIDTH_DEG = 22;
var DEFAULTS = { chromakeyEnabled: false, mixX: 0.75, mixY: 0.75 };
for (q = 0; q < EQ_N; q++) DEFAULTS['eqG' + q] = 1;
for (q = 0; q < LFO_N; q++) DEFAULTS['lfo' + q + 'Target'] = '';   // a Main page knob's id, '' for none
Object.keys(PD).forEach(function (k) { DEFAULTS[k] = PD[k].def; });
var params = Object.assign({}, DEFAULTS);
// Camera layer state (not a preset parameter): facing 'user' (front, mirrored) or 'environment' (back).
var cam = { facing: 'user', stream: null, busy: false, aspect: 16 / 9 };

// XY mixer: bilinear weights for the four corners, always summing to 1 (vector-synthesis style).
// Corners match the pad and the Layers knobs: Camera top-left, Oscillator top-right, Noise bottom-left, Shape bottom-right.
function mixWeights() {
  var x = params.mixX, y = params.mixY;
  return [(1 - x) * y, x * y, (1 - x) * (1 - y), x * (1 - y)];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  var f = function (n) { var k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}

// -------------------------------------------------------------
// 3. Panel layout.
// Makers place one part of the panel at stage coordinates: makeScreen, makeKeys, makeItem (a knob, the Camera
// cluster or the Chromakey On key, from CONTROLS), makePad and makeSwatch. SECTIONS lists each parameter family's
// controls. The built-in layouts (buildDefault) use them, as can a layout engine (layoutEngine).
//
// Built-in layouts, chosen by the window's shape (or #portrait / #landscape in the URL):
// Portrait, 900 x 1336: the 9:16 screen top left with the header keys under it, the Layers knobs and XY Mix pad below
// that, and the effect knobs in two columns down the right.
// Landscape, 1336 x 908: the same panel rotated 90 degrees clockwise and flipped horizontally (a transpose). The screen
// stays top left but turns 16:9, the header keys stand in a column to its right, Layers and Mix sit right of that, the
// effect knobs run in two rows along the bottom.
// Written in portrait coordinates; pt() and box() transpose them for landscape (y gains 8 so the top nameplates clear
// the edge).
// -------------------------------------------------------------
var M = 8;
var LW = 560, RX = M + LW + 16, RW = 900 - M - RX;               // left column (screen) and right column (knobs)
var BEZ = [M, 16, LW, 980];                                      // bezel; the canvas inside is 540 x 960 (9:16)
var KEY_Y = 1008, LOW_Y = 1056, LOW_B = 1328;
var ROW_Y0 = 8, ROW_P = (LOW_B + 8 - ROW_Y0) / 10;               // ten knob rows on the right
var LAND = false, SW = 900, SH = LOW_B + 8, CW = 720, CH = 1280;  // orientation, stage size, render resolution
var PAD_T = false;                                               // XY pad drawn transposed (landscape built-in layout)
function pt(x, y) { return LAND ? [y, x + 8] : [x, y]; }
function box(x, y, w, h) { return LAND ? [y, x + 8, h, w] : [x, y, w, h]; }
function secBox(b, title, fam) { return sec(b[0], b[1], b[2], b[3], title, fam); }
function LABEL() { return 'font-size:' + 10 * UL + 'px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:' + P.inkDim + ';white-space:nowrap' + (UL > 1 ? ';line-height:1' : ''); }

// Controls by id: [label, knob options]. 'camera' and 'keyOn' are keys, not knobs.
var CONTROLS = {
  blendMode: ['Blend Mode', { ticks: 5, range: 90, after: function () { syncBlendLegend(); }, legend: BLEND_NAMES }],   // a short drag per position
  modulateAmount: ['Modulate'], feedback: ['Persistence'], delay: ['Delay'],
  keyOn: [''], keyHue: ['Key Hue', { after: function () { syncKeySwatch(); } }],
  keySat: ['Key Sat', { after: function () { syncKeySwatch(); } }], keyLight: ['Key Light', { after: function () { syncKeySwatch(); } }],
  chromakeyThreshold: ['Threshold'], chromakeySoftness: ['Softness'],
  zoom: ['Zoom'], rotate: ['Rotate'], translateX: ['Shift X'], translateY: ['Shift Y'], hueDrift: ['Hue Drift'],
  hue: ['Hue'], saturate: ['Saturation'], brightness: ['Brightness'], contrast: ['Contrast'],
  camera: ['Camera'], oscSize: ['Osc Size'], noiseScale: ['Noise Scale'], shapeSides: ['Shape Sides', { ticks: 10, after: function () { drawPad(); } }],
  // Advanced page: the LFOs' knobs (their waveforms are picked on a small screen, their targets with a key)
  lfo0Rate: ['Speed'], lfo1Rate: ['Speed'], lfo2Rate: ['Speed'], lfo3Rate: ['Speed'],
  lfo0Depth: ['Depth'], lfo1Depth: ['Depth'], lfo2Depth: ['Depth'], lfo3Depth: ['Depth']
};
var SECTIONS = {
  feedback: { title: 'Feedback', items: ['blendMode', 'modulateAmount', 'feedback', 'delay'] },
  chroma: { title: 'Chromakey', items: ['keyOn', 'keyHue', 'keySat', 'keyLight', 'chromakeyThreshold', 'chromakeySoftness'] },
  transform: { title: 'Transform', items: ['zoom', 'rotate', 'translateX', 'translateY', 'hueDrift'] },
  color: { title: 'Color', items: ['hue', 'saturate', 'brightness', 'contrast'] },
  layers: { title: 'Layers', items: ['camera', 'oscSize', 'noiseScale', 'shapeSides'] },
  mix: { title: 'Mix', items: [] }
};
// Knobs an LFO can drive: every knob on the Main page.
var LFO_TARGETS = {};
Object.keys(SECTIONS).forEach(function (f) { SECTIONS[f].items.forEach(function (id) { if (PD[id]) LFO_TARGETS[id] = 1; }); });
// The Mod page (internally 'adv'; experimental): the Colors hue EQ along the whole bottom; above it on the right, the
// Modulation window (four LFOs over their four target keys, in the red Feedback family colours) and the Mix window (the
// XY pad, in the green Chromakey family colours). The header key naming the other page switches; the choice is kept.
// pickLfo >= 0 while the Main page is open to pick that LFO's target.
var page = 'main';
try { if (localStorage.getItem('vfv-page') === 'adv') page = 'adv'; } catch (e) { /* main */ }
var pickLfo = -1;
function setPage(p) {
  page = p === 'adv' ? 'adv' : 'main';
  if (page === 'adv') pickLfo = -1;
  try { localStorage.setItem('vfv-page', page); } catch (e) { /* not kept */ }
  build(); scaleStage();
}
// The WebGL canvas outlives layout rebuilds (its context, programs and camera texture stay); only its size changes.
var glCanvas = document.createElement('canvas');
glCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';

// Screen: a bezel holding the WebGL canvas, no text. Double-click for fullscreen (there is no Full key).
function makeScreen(x, y, w, h) {
  ui.bezel = [x, y, w, h];
  var bez = el('div', at(x, y, w, h) + ';box-sizing:border-box;padding:10px;border-radius:8px;background:#0b0b0c;box-shadow:inset 0 2px 6px rgba(0,0,0,0.9),0 1px 0 rgba(255,255,255,0.06)');
  bez.className = 'bezel';
  bez.setAttribute('aria-label', 'Video feedback output');
  ui.screen = el('div', 'position:relative;width:100%;height:100%;border-radius:3px;background:#000;overflow:hidden', bez);
  ui.screen.id = 'screen';
  if (!pseudoFs) ui.screen.appendChild(glCanvas);   // a full-screen overlay keeps the canvas through rebuilds
  ui.screen.addEventListener('dblclick', toggleFullscreen);
}
// Header keys, in order: Day/Night, Presets/Output (yellow), Record (red; Capture while frozen), Freeze/Play (blue),
// Main/Mod (green), each naming the option it switches to (DESIGN.md §32), in the NKEYS rects [x, y, w, h].
// The label size shrinks from fs if the longest label the keys can show would not fit the key width. Class hk marks
// them for the Style Lab, which colours them to the background (the Day/Night key in the other scheme's colours) or in
// their own colour (hk-green, hk-blue, hk-yellow, hk-rec red).
var NKEYS = 5, KEY_LABELS = ['Night', 'Day', 'Main', 'Mod', 'Freeze', 'Play', 'Presets', 'Output', 'Record', 'Capture', 'Stop', 'Saving'];
function makeKeys(r, fs) {
  fs = fs || 10;
  var widest = Math.max.apply(null, KEY_LABELS.map(function (t) { return textW(t.toUpperCase(), fs, 700, 0.08); }));
  fs = Math.min(fs, Math.floor(fs * (r[0][2] - 10) / widest * 10) / 10);
  var K = function (i, label, led, o, cls) { o.fs = fs; var k = key(r[i][0], r[i][1], r[i][2], r[i][3], label, led, o); k.b.className += ' hk' + (cls ? ' ' + cls : ''); return k; };
  ui.scheme = K(0, 'Day', null, { aria: 'Day / night colour scheme', onClick: toggleScheme }, 'hk-scheme');
  ui.presets = K(1, 'Presets', null, { aria: 'Presets', onClick: presetsKey }, 'hk-yellow');
  ui.rec = K(2, 'Record', 'off', { noLed: true, aria: 'Record the output to a video file', onClick: toggleRecording }, 'hk-rec');
  ui.freeze = K(3, 'Freeze', 'off', { noLed: true, aria: 'Freeze the feedback loop', onClick: function () { frozen = !frozen; syncFreeze(); syncRec(); } }, 'hk-blue');
  ui.pageKey = K(4, page === 'adv' ? 'Main' : 'Mod', null, { aria: 'Page', onClick: function () { setPage(page === 'adv' ? 'main' : 'adv'); } }, 'hk-green');
  // Main / Mod, like Day / Night, names only the page the key switches to (DESIGN.md §32).
  ui.pageKey.b.setAttribute('aria-label', 'Switch to the ' + (page === 'adv' ? 'Main' : 'Mod') + ' page');
  syncFreeze(); syncScheme(); syncRec(); syncPresetsKey(); renderPresets();
}
// Freeze / Play: names what a tap does (DESIGN.md §32).
function syncFreeze() {
  if (!ui.freeze) return;
  ui.freeze.set(frozen ? 'on' : 'off'); ui.freeze.txt.textContent = frozen ? 'Play' : 'Freeze';
  ui.freeze.b.setAttribute('aria-label', frozen ? 'Play: resume the feedback loop' : 'Freeze the feedback loop');
}
// Camera: one square key centred on (cx, cy), label below. A tap steps On -> Front <-> Back: while off it reads On and a
// tap starts the front camera; while live it names the camera in use (LED lit) and a tap switches to the other one.
// Press and hold (HOLD_MS) turns the camera off.
var SQ = 52, HOLD_MS = 600;   // least square key side (x UK) for the Camera and Chromakey keys
// Side of the square Camera and Chromakey keys: SQ x UK, or wider if their longest label would not fit.
function sqSide() { return Math.max(SQ * UK, textW('Front', 9 * UL, 700, 0.08) + 12 * UK); }
function makeCamera(cx, cy, fam) {
  var k = UK, S = sqSide(), top = cy + 22 * k - S, held = false, timer = 0;
  ui.camOn = key(cx - S / 2, top, S, S, 'On', 'off', { fs: 9 * UL, aria: 'Camera', onClick: function () {
    if (held) { held = false; return; }
    if (cam.busy) return;
    if (!cam.stream) startCamera('user');
    else startCamera(cam.facing === 'user' ? 'environment' : 'user');
  } });
  var b = ui.camOn.b, clear = function () { clearTimeout(timer); timer = 0; };
  b.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    held = false; clear();
    timer = setTimeout(function () { timer = 0; if (cam.stream || cam.busy) { held = true; stopCamera(); flashTip(b, 'Camera off'); } }, HOLD_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { b.addEventListener(ev, clear); });
  b.addEventListener('contextmenu', function (e) { e.preventDefault(); });   // a long press on a phone
  var lab = cl(cx, cy + 35 + 20 * (k - 1), 120 * UL, 'Camera', LABEL()); lab.className = 'knob-label'; if (fam) lab.dataset.fam = fam;
  syncCam();
}
// Square On / Off key for boolean params[param] centred on (cx, cy), no label: the key names the state and glows softly while
// on (Chromakey; Luma Key on the Advanced page).
function makeOnOff(cx, cy, param, aria) {
  var S = sqSide(), k = key(cx - S / 2, cy - S / 2, S, S, 'Off', null, { fs: 9 * UL, aria: aria, onClick: function () { params[param] = !params[param]; syncKeyOn(); } });
  k.shadow = k.b.style.boxShadow; k.param = param;
  (ui.onOff = ui.onOff || []).push(k);
  if (param === 'chromakeyEnabled') ui.keyOn = k;
  syncers.push(syncKeyOn);
  syncKeyOn();
}
// One control by id, its knob ring (or key cluster) centred on (cx, cy). o: fam, legend (false: no legend around a
// stepped knob that has one, e.g. Blend Mode's).
function makeItem(id, cx, cy, size, o) {
  o = o || {};
  if (id === 'camera') return makeCamera(cx, cy, o.fam);
  if (id === 'keyOn') return makeOnOff(cx, cy, 'chromakeyEnabled', 'Chromakey');
  var c = CONTROLS[id], opts = Object.assign({ fam: o.fam }, c[1] || {});
  var k = knob(cx, cy, size, c[0], id, opts);
  if (id === 'blendMode') ui.blend = k;
  if (opts.legend && o.legend !== false) ringLegend(k, id, opts.legend, cx, cy);
  return k;
}
// The runaway guard's state (the engine: guardStep, after the feedback shader).
var GUARD_EVERY = 4, GUARD_SYNC = false;   // GUARD_SYNC: read the proxy at once (tests; it stalls the GPU)
var guard = { stats: null, n: 0, fence: null, fb: 1, act: 0, ex: null, T: null };

// A chip of the key colour, usually beside the Chromakey nameplate.
function makeSwatch(x, y) {
  ui.keySwatch = el('span', at(x, y, 26, 12) + ';border-radius:2px;box-shadow:0 0 0 1px #050505,inset 0 1px 0 rgba(255,255,255,0.2)');
  syncKeySwatch();
}

// Layout engine hook (design mode used it; unused since the Style Lab replaced it, 2026-10-13): an object
// { key(): string, build(): void } replaces the built-in layouts. key() changes
// whenever the layout should be rebuilt (window shape, candidate); build() sets SW / SH / CW / CH and places the parts.
var layoutEngine = null, builtKey = '';
function layoutKey() { return layoutEngine ? layoutEngine.key() : (wantLand() ? 'land' : 'port'); }
var ui = {};
function build() {
  hideTip(); panel.innerHTML = ''; syncers = []; ui = {}; SEC_R = 3; PAD_T = false;
  UK = 1; UL = 1;
  builtKey = layoutKey();
  if (layoutEngine) layoutEngine.build(); else buildDefault(wantLand());
  stage.style.width = SW + 'px'; stage.style.height = SH + 'px';
  if (glCanvas.width !== CW || glCanvas.height !== CH) {
    glCanvas.width = CW; glCanvas.height = CH;
    if (typeof gl !== 'undefined' && gl && buffers) resizeTargets();
  }
  if (window.onPanelBuilt) window.onPanelBuilt();
}

// Portrait (900 x 1336), controls 1.2x and labels 2x (UK / UL), spaced regularly: each window spreads its controls
// with equal gaps between them and to its edges (by their measured extents, labels included; the top edge is the
// nameplate's bottom), and the right column's windows are sized so that gap is the same in all of them. Windows sit
// PG apart (plus a nameplate's overhang), the header keys PG from the screen above and the Layers nameplate below,
// and the XY pad PG inside the top, right and bottom edges of Layers.
var PG = 14, fontsRebuild = false;
function buildPortraitPanel() {
  UK = 1.2; UL = 2;
  var ks = 42 * UK, tab = 9 * UL, top0 = 26;
  var kg = 8, kw = (LW - (NKEYS - 1) * kg) / NKEYS, kh = 28 * UK, ky = BEZ[1] + BEZ[3] + PG, rects = [];
  for (var i = 0; i < NKEYS; i++) rects.push([M + i * (kw + kg), ky, kw, kh]);
  makeKeys(rects, 10 * UL);

  // Layers: the pad square against the right edge, the four layer controls in a 2 x 2 grid left of it.
  var ly = ky + kh + PG + tab, lay = [M, ly, LW, LOW_B - ly], pad = lay[3] - 2 * PG, sep = PG + tab;
  if (page === 'adv') {
    // Advanced: Colors across the whole bottom, the Mix window square at the foot of the right column (level with the
    // header keys), the LFO window above it.
    var my = ly - sep - RW - tab;
    buildAdvanced([M, ly, SW - 2 * M, LOW_B - ly], [RX, top0, RW, my - sep - top0], [RX, my, RW, RW + tab], PG);
  } else {
    secBox(lay, 'Layers', 'layers');
    makePad(M + LW - PG - pad, ly + PG, pad);
    gridIn([M, ly, LW - PG - pad, lay[3]], [['camera', 'oscSize'], ['noiseScale', 'shapeSides']], 40 * UK, 'layers');

    // Right column: one vertical gap g shared by every window. Each window's controls are its section's items in rows
    // of two (Feedback, Chromakey) or one (Transform, Color).
    var rows = function (fam, n) { var it = SECTIONS[fam].items, out = []; for (var r = 0; r < it.length; r += n) out.push(it.slice(r, r + n)); return [fam, out]; };
    var wins = [rows('feedback', 2), rows('chroma', 2), rows('transform', 1), rows('color', 1)];
    var hs = wins.map(function (w) { return gridSize(w[1], ks); });
    var tc = hs[2].h > hs[3].h ? hs[2] : hs[3], stack = [hs[0], hs[1], tc];
    var used = stack.reduce(function (a, z) { return a + tab + z.h; }, 0) + 2 * sep;
    var g = (LOW_B - top0 - used) / stack.reduce(function (a, z) { return a + z.n + 1; }, 0);
    var hOf = function (z) { return tab + z.h + (z.n + 1) * g; };
    var y = top0, fb = [RX, y, RW, hOf(hs[0])];
    y += fb[3] + sep; var ck = [RX, y, RW, hOf(hs[1])];
    y += ck[3] + sep; var tr = [RX, y, RW / 2 - 8, LOW_B - y], co = [RX + RW / 2 + 8, y, RW / 2 - 8, LOW_B - y];
    [fb, ck, tr, co].forEach(function (b, k) {
      var fam = wins[k][0];
      secBox(b, SECTIONS[fam].title, fam);
      gridIn(b, wins[k][1], ks, fam);
    });
    makeSwatch(ck[0] + 8 + textW(SECTIONS.chroma.title, 10 * UL, 800, 0.1) + 16 + 10, ck[1] - 6 * UK);
  }
  afterPanel();

  // Text is measured for the spacing; once the web font arrives, measure again.
  if (document.fonts && document.fonts.status !== 'loaded' && !fontsRebuild) {
    fontsRebuild = true;
    document.fonts.ready.then(function () { if (!currentFullscreenElement()) { build(); scaleStage(); } });
  }
}
// Text measuring for the spacing. The Style Lab (lab.js) sets TEXT to the label font, weight (0 = as asked),
// letter-spacing (0 = as asked) and case of the design on show, and rebuilds the panel when they change.
var TEXT = { font: '"Barlow Semi Condensed", "Segoe UI", sans-serif', weight: 0, ls: 0, upper: true };
var measureCtx = null;
function textW(t, px, weight, ls) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = (TEXT.weight || weight) + ' ' + px + 'px ' + TEXT.font;
  var str = TEXT.upper ? String(t).toUpperCase() : String(t);
  return measureCtx.measureText(str).width + str.length * (TEXT.ls || ls) * px;
}
// A control's extent around its centre: width, and height above (top) and below (bot), label included.
function itemExt(id, ks) {
  var R = ks / 2 + 10, lab = 10 * UL, lw = function (t) { return textW(t, lab, 700, 0.1); };
  if (id === 'camera') return { w: Math.max(sqSide(), lw('Camera')), top: sqSide() - 22 * UK, bot: 35 + 20 * (UK - 1) + lab };
  if (id === 'keyOn') return { w: sqSide(), top: sqSide() / 2, bot: sqSide() / 2 };
  var e = { w: Math.max(2 * R, lw(CONTROLS[id][0])), top: R, bot: R + 3 + lab }, names = (CONTROLS[id][1] || {}).legend;
  if (names) {   // the legend around the ring
    var r = R + 7 * UK, bh = 12 * UL;
    names.forEach(function (n, i) {
      var a = legendAngle(i, names.length) * Math.PI / 180, nw = textW(n, 9 * UL, 800, 0.12), side = Math.abs(Math.sin(a)) > 0.01;
      e.w = Math.max(e.w, 2 * (side ? Math.abs(r * Math.sin(a)) + nw : nw / 2));
      e.top = Math.max(e.top, side ? r * Math.cos(a) + bh / 2 : r + bh);
    });
  }
  return e;
}
// Column widths, row extents and total row height of a grid of control ids (rows of columns).
function gridSize(grid, ks) {
  var z = { cw: [], rt: [], rb: [], h: 0, n: grid.length };
  grid.forEach(function (row, r) {
    row.forEach(function (id, c) {
      var e = itemExt(id, ks);
      z.cw[c] = Math.max(z.cw[c] || 0, e.w); z.rt[r] = Math.max(z.rt[r] || 0, e.top); z.rb[r] = Math.max(z.rb[r] || 0, e.bot);
    });
    z.h += z.rt[r] + z.rb[r];
  });
  return z;
}
// Starts of boxes of the given sizes spread over [lo, hi] with equal gaps between them and at both ends.
function spread(lo, hi, sizes) {
  var g = (hi - lo - sizes.reduce(function (a, v) { return a + v; }, 0)) / (sizes.length + 1), p = lo + g;
  return sizes.map(function (v) { var at0 = p; p += v + g; return at0; });
}
// Place a grid of controls in window b = [x, y, w, h], below its nameplate.
function gridIn(b, grid, ks, fam) {
  var z = gridSize(grid, ks);
  var xs = spread(b[0], b[0] + b[2], z.cw), ys = spread(b[1] + 9 * UL, b[1] + b[3], z.rt.map(function (t, r) { return t + z.rb[r]; }));
  grid.forEach(function (row, r) { row.forEach(function (id, c) { makeItem(id, xs[c] + z.cw[c] / 2, ys[r] + z.rt[r], ks, { fam: fam }); }); });
}

function buildDefault(land) {
  LAND = land; PAD_T = land;
  SW = LAND ? LOW_B + 8 : 900; SH = LAND ? 908 : LOW_B + 8; CW = LAND ? 1280 : 720; CH = LAND ? 720 : 1280;
  var b = box(BEZ[0], BEZ[1], BEZ[2], BEZ[3]);
  makeScreen(b[0], b[1], b[2], b[3]);
  if (!LAND) return buildPortraitPanel();
  // Header keys: a column beside the screen.
  var kn = NKEYS, kg = 10, rects = [], kh = (LW - (kn - 1) * kg) / kn;
  for (var i = 0; i < kn; i++) rects.push([BEZ[1] + BEZ[3] + 6, BEZ[0] + 8 + i * (kh + kg), 48, kh]);
  makeKeys(rects, 9);
  if (page === 'adv') {
    // Advanced: the portrait arrangement transposed. Colors runs the full height of the right edge, the LFO and Mix
    // windows share the band along the bottom (Mix square, against Colors).
    var eq = box(M, LOW_Y, 900 - 2 * M, LOW_B - LOW_Y), band = box(RX, 16, RW, LOW_Y - 32), mx = band[0] + band[2] - RW;
    buildAdvanced(eq, [band[0], band[1], mx - 16 - band[0], RW], [mx, band[1], RW, RW], 16);
  } else { buildLayers(); buildMix(); buildRight(); }
  afterPanel();
}

// Layers: one control per mixer corner, laid out 2 x 2 like the pad beside it (transposed with it in landscape). The
// section spans the pad too: the mixer belongs to Layers, with no section of its own.
var PAD = 238;
function buildLayers() {
  var x = M, w = 278, top = LOW_Y + 20;
  secBox(box(x, LOW_Y, LW, LOW_B - LOW_Y), 'Layers', 'layers');
  var cx = [x + w / 4, x + 3 * w / 4], cy = [top + PAD / 4, top + 3 * PAD / 4];
  [['camera', 0, 0], ['oscSize', 1, 0], ['noiseScale', 0, 1], ['shapeSides', 1, 1]].forEach(function (d) {
    var p = pt(cx[d[1]], cy[d[2]]); makeItem(d[0], p[0], p[1], 40, { fam: 'layers' });
  });
}

// Mixer: XY pad crossfading the four layers' opacity, inside the Layers section.
var PAD_ICONS = (function () {
  var noise = '', i, t;
  for (i = 0; i <= 360; i++) {
    t = i / 360 * TAU;
    noise += (i ? 'L' : 'M') + (50 + 36 * (0.6 * Math.sin(3 * t) + 0.4 * Math.sin(7 * t + 1))).toFixed(1) + ' ' + (50 + 36 * (0.6 * Math.cos(4 * t + 0.3) + 0.4 * Math.sin(9 * t))).toFixed(1);
  }
  var osc = '';
  for (i = 0; i < 4; i++) { var x0 = 20 + i * 17; osc += 'M' + x0 + ' 14Q' + (x0 + 26) + ' 50 ' + x0 + ' 86'; }
  return {
    camera: 'M50 22a15 15 0 1 1 -0.01 0Z M20 86C22 62 78 62 80 86',
    osc: osc,
    noise: noise
  };
})();
function polygonPath(n) {
  var d = '';
  for (var i = 0; i < n; i++) { var a = i / n * TAU; d += (i ? 'L' : 'M') + (50 + 34 * Math.sin(a)).toFixed(2) + ' ' + (54 - 34 * Math.cos(a)).toFixed(2); }
  return d + 'Z';
}
// Pad space (u rightward, v downward, 0..1) <-> mixer position. A transposed pad (PAD_T) keeps the layers' corners
// matching transposed Layers knobs: normal u = mixX, v = 1 - mixY; transposed u = 1 - mixY, v = mixX.
function mixToPad() { return PAD_T ? [1 - params.mixY, params.mixX] : [params.mixX, 1 - params.mixY]; }
function padToMix(u, v) {
  u = clamp(u); v = clamp(v);
  if (PAD_T) { params.mixY = 1 - u; params.mixX = v; } else { params.mixX = u; params.mixY = 1 - v; }
  drawPad();
}
function buildMix() {
  var s = box(M + 278 + 16, LOW_Y, LW - 278 - 16, LOW_B - LOW_Y);
  makePad(s[0] + (s[2] - PAD) / 2, s[1] + 20, PAD);
}
// XY pad: a square glass screen of side `size` at (x, y).
function makePad(x, y, size) {
  ui.pad = glass(x, y, size, size, 'Layer mixer: drag to crossfade Camera, Oscillator, Noise and Shape');
  var g = ui.pad.g;
  g.style.cursor = 'crosshair'; g.style.touchAction = 'none';
  g.setAttribute('role', 'slider'); g.tabIndex = 0;
  var setFrom = function (e) { var r = g.getBoundingClientRect(); padToMix((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); };
  g.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); g.setPointerCapture(e.pointerId); dragging = true; setFrom(e);
    var up = function () { dragging = false; g.removeEventListener('pointermove', setFrom); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up); };
    g.addEventListener('pointermove', setFrom); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', function () { padToMix(0.5, 0.5); });
  g.addEventListener('keydown', function (e) {
    var dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0, dy = { ArrowDown: 1, ArrowUp: -1 }[e.key] || 0;
    if (!dx && !dy) return;
    e.preventDefault(); var p = mixToPad(); padToMix(p[0] + dx * 0.02, p[1] + dy * 0.02);
  });
  syncers.push(drawPad);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawPad);
}
function drawPad() {
  var p = ui.pad; if (!p) return;
  var c = p.x, w = p.w, h = p.h, wt = mixWeights(), q = w / 2;
  c.clearRect(0, 0, w, h);
  // Centre axes with quarter ticks.
  c.strokeStyle = 'rgba(143,141,146,0.35)'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(q, 0); c.lineTo(q, h); c.moveTo(0, h / 2); c.lineTo(w, h / 2);
  [0.25, 0.75].forEach(function (f) { c.moveTo(f * w, h / 2 - 8); c.lineTo(f * w, h / 2 + 8); c.moveTo(q - 8, f * h); c.lineTo(q + 8, f * h); });
  c.stroke();
  // Layer glyphs, brighter the more of that layer is in the mix.
  var icons = [PAD_ICONS.camera, PAD_ICONS.osc, PAD_ICONS.noise, polygonPath(Math.round(params.shapeSides))];
  var names = ['Camera', 'Osc', 'Noise', 'Shape'];
  icons.forEach(function (d, i) {
    var col = PAD_T ? Math.floor(i / 2) : i % 2, row = PAD_T ? i % 2 : Math.floor(i / 2);
    var ox = col * q, oy = row * q, s = q * 0.5 / 100;
    c.save();
    c.globalAlpha = 0.22 + 0.78 * wt[i];
    c.translate(ox + q * 0.25, oy + q * 0.27); c.scale(s, s);
    c.strokeStyle = ICON_GREEN; c.lineWidth = (i === 2 ? 1.6 : 2.4) / s * 1.2; c.lineJoin = 'round'; c.lineCap = 'round';
    c.shadowColor = 'rgba(63,191,106,0.7)'; c.shadowBlur = 6;
    c.stroke(new Path2D(d));
    c.restore();
    // Corner label and its share of the mix.
    var right = col === 1, bottom = row === 1, tx = right ? w - 14 : 14;
    c.textAlign = right ? 'right' : 'left';
    c.font = '800 17px "Barlow Semi Condensed", "Segoe UI", sans-serif';
    c.fillStyle = P.inkMute;
    c.fillText(names[i].toUpperCase() + (i === 0 && !cam.stream ? ' (OFF)' : ''), tx, bottom ? h - 34 : 28);
    c.font = '700 19px "Barlow Semi Condensed", "Segoe UI", sans-serif';
    c.fillStyle = P.accent;
    c.fillText(Math.round(wt[i] * 100) + '%', tx, bottom ? h - 12 : 50);
  });
  // Puck with crosshair.
  var pp = mixToPad(), px = pp[0] * w, py = pp[1] * h;
  c.strokeStyle = 'rgba(220,232,255,0.28)'; c.lineWidth = 2; c.setLineDash([6, 8]);
  c.beginPath(); c.moveTo(px, 0); c.lineTo(px, h); c.moveTo(0, py); c.lineTo(w, py); c.stroke(); c.setLineDash([]);
  c.shadowColor = P.accentGlow; c.shadowBlur = 10;
  c.strokeStyle = P.accent; c.lineWidth = 4;
  c.beginPath(); c.arc(px, py, 16, 0, TAU); c.stroke();
  c.fillStyle = P.accent; c.beginPath(); c.arc(px, py, 5, 0, TAU); c.fill();
  c.shadowBlur = 0;
  p.g.setAttribute('aria-valuetext', names.map(function (n, i) { return n + ' ' + Math.round(wt[i] * 100) + '%'; }).join(', '));
}

// Right column (portrait) / bottom band (landscape), ten knob rows: Feedback (rows 1-2), Chromakey (rows 3-5), then
// Transform and Color side by side as single columns of five (rows 6-10; in landscape, two stacked rows of five).
function buildRight() {
  var c1 = RX + RW / 4, c2 = RX + 3 * RW / 4, mid = RX + RW / 2;
  var B = function (k) { return ROW_Y0 + ROW_P * k; }, cy = function (i) { return ROW_Y0 + ROW_P * (i + 0.5); };
  var ks = 42;
  secBox(box(RX, B(0) + 8, RW, B(2) - B(0) - 16), SECTIONS.feedback.title, 'feedback');
  var ck = box(RX, B(2) + 8, RW, B(5) - B(2) - 16);
  secBox(ck, SECTIONS.chroma.title, 'chroma');
  secBox(box(RX, B(5) + 8, RW / 2 - 8, B(10) - B(5) - 16), SECTIONS.transform.title, 'transform');
  secBox(box(mid + 8, B(5) + 8, RW / 2 - 8, B(10) - B(5) - 16), SECTIONS.color.title, 'color');
  var place = function (fam, cols, row0) {
    SECTIONS[fam].items.forEach(function (id, i) {
      var p = pt(cols[i % cols.length], cy(row0 + Math.floor(i / cols.length)));
      if (LAND && fam === 'feedback' && i < 2) p[0] += 24;   // room for the Blend Mode legend inside the window's left edge
      makeItem(id, p[0], p[1], ks, { fam: fam });
    });
  };
  place('feedback', [c1, c2], 0);
  place('chroma', [c1, c2], 2);
  place('transform', [c1], 5);
  place('color', [c2], 5);
  if (page !== 'adv') makeSwatch(ck[0] + 116, ck[1] - 6);
}

// Advanced page: Colors (eq), the LFO window (lfo) and the Mix window holding the XY pad (mix), each [x, y, w, h] in
// stage coordinates; m is the margin inside a window (below the nameplate at the top).
function buildAdvanced(eq, lfo, mix, m) {
  buildColorsEq(eq, m);
  buildLfo(lfo, m);
  secBox(mix, 'Mix', 'chroma');
  var tab = 9 * UL, s = Math.min(mix[2] - 2 * m, mix[3] - tab - 2 * m);
  makePad(mix[0] + (mix[2] - s) / 2, mix[1] + tab + m + (mix[3] - tab - 2 * m - s) / 2, s);
}

// Colors EQ (Advanced page): a seven-band EQ on saturation around the hue spectrum. The saturation multiplier at a hue
// is 1 plus every band's (gain - 1) times its bell (a Gaussian of the hue distance over the width), clamped at 0; the
// shader (hueEq) applies the same sum at each pixel's hue after Saturation, skipped while every gain is 1. The window is
// seven fader columns filling it, the standard spacing m apart (the Encoders style, chosen from twelve), on a blue
// window (family 'eq', blue in both schemes) and a Flat key on its top edge (every gain
// back to 1). A column fills from the bottom to its level: below the middle (1x) in the band's colour, greying towards
// the bottom, and white from the middle up. Tap or drag a column for its level; double-click returns 1x; the wheel and
// arrow keys nudge it.
function eqActive() { for (var i = 0; i < EQ_N; i++) if (params['eqG' + i] !== 1) return true; return false; }
function eqRefresh() { (ui.eqParts || []).forEach(function (f) { f(); }); }
function eqSetGain(i, g) { g = clamp(g, 0, 2); if (Math.abs(g - 1) < 0.05) g = 1; params['eqG' + i] = Math.round(g * 100) / 100; }
// Relative change (the wheel, arrow keys): stops once at 1x on the way through.
function eqNudge(i, d) { var g0 = params['eqG' + i], g = clamp(g0 + d, 0, 2); if ((g0 - 1) * (g - 1) < 0) g = 1; params['eqG' + i] = Math.round(g * 1000) / 1000; }
function eqTip(target, i) { showTip(target, EQ_NAMES[i] + '  ' + params['eqG' + i].toFixed(2) + '×'); }
function buildColorsEq(b, m) {
  secBox(b, 'Colors EQ', 'eq');
  ui.eqParts = [];
  var kh = 22 * UK, f = 9 * UL, kw = Math.max(kh * 1.2, textW('Flat', f, 700, 0.08) + 16 * UL);
  var flat = key(b[0] + b[2] - 10 - kw, b[1] - kh / 2, kw, kh, 'Flat', null, { fs: f, aria: 'Flatten the EQ (every gain to 1x)',
    onClick: function () { for (var j = 0; j < EQ_N; j++) params['eqG' + j] = 1; eqRefresh(); flashTip(flat.b, 'EQ flat'); } });
  flat.b.style.zIndex = '2';
  var top = b[1] + 9 * UL + m * 0.6, C = [b[0] + m, top, b[2] - 2 * m, b[1] + b[3] - m - top], g = m, cw = (C[2] - (EQ_N - 1) * g) / EQ_N;
  for (var i = 0; i < EQ_N; i++) eqColumn(C[0] + i * (cw + g), C[1], cw, C[3], i);
  syncers.push(eqRefresh);
  eqRefresh();
}
function eqColumn(x, y, w, h, i) {
  var t = el('div', at(x, y, w, h) + ';border-radius:' + 5 * UK + 'px;overflow:hidden;cursor:ns-resize;touch-action:none;background:#0b0b0d;' +
    'box-shadow:inset 0 2px 5px rgba(0,0,0,0.9),0 1px 0 rgba(255,255,255,0.12)');
  t.setAttribute('role', 'slider'); t.tabIndex = 0; t.setAttribute('aria-label', EQ_NAMES[i] + ' saturation');
  var low = el('div', 'position:absolute;left:0;right:0;bottom:0;pointer-events:none', t), high = el('div', 'position:absolute;left:0;right:0;bottom:50%;background:#f4f4f2;pointer-events:none', t);
  el('div', 'position:absolute;left:0;right:0;top:50%;height:2px;margin-top:-1px;background:rgba(128,128,132,0.55);pointer-events:none', t);
  ui.eqParts.push(function () {
    var v = params['eqG' + i], k = Math.min(v, 1);
    low.style.height = k * 50 + '%'; low.style.background = 'hsl(' + EQ_HUES[i] + ',' + Math.round(90 * k) + '%,' + Math.round(50 + 6 * k) + '%)';
    high.style.height = Math.max(0, v - 1) * 50 + '%';
    t.setAttribute('aria-valuetext', v.toFixed(2) + '×');
  });
  var setFrom = function (e) { var r = t.getBoundingClientRect(); eqSetGain(i, (1 - (e.clientY - r.top) / r.height) * 2); eqRefresh(); eqTip(t, i); };
  t.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); t.setPointerCapture(e.pointerId); dragging = true;
    setFrom(e);
    var up = function () { dragging = false; hideTip(); t.removeEventListener('pointermove', setFrom); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up); };
    t.addEventListener('pointermove', setFrom); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
  });
  var nudge = function (d) { eqNudge(i, d); eqRefresh(); eqTip(t, i); };
  t.addEventListener('dblclick', function () { params['eqG' + i] = 1; eqRefresh(); eqTip(t, i); });
  t.addEventListener('wheel', function (e) { e.preventDefault(); nudge(e.deltaY > 0 ? -0.05 : 0.05); }, { passive: false });
  t.addEventListener('keydown', function (e) { var d = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key]; if (d) { e.preventDefault(); nudge(d); } });
  t.addEventListener('pointerleave', function () { if (!dragging) hideTip(); });
}

// Modulation window (Advanced page): four LFO channels, each with a Wave screen (tap it to step through Sine, Tri,
// Saw, Square and S&H; the wheel and arrow keys step too) showing the wave and where the LFO is in its cycle, Speed and
// Depth knobs, and a Target key naming the knob it drives (tap it to pick one on the Main page, pickLfo). The channels
// sit as 2 x 2 tiles (the Grid layout, chosen from four), each Wave over the two knobs over Target (a wide tile: Wave
// and Target on the left, the knobs on the right).
function buildLfo(b, m) {
  secBox(b, 'Modulation', 'feedback');
  ui.lfoWave = []; ui.lfoTarget = [];
  var top = b[1] + 9 * UL + m * 0.6, C = [b[0] + m, top, b[2] - 2 * m, b[1] + b[3] - m - top], g = 10 * UK, tw = (C[2] - g) / 2, th = (C[3] - g) / 2;
  for (var i = 0; i < LFO_N; i++) lfoCell(i, [C[0] + (i % 2) * (tw + g), C[1] + Math.floor(i / 2) * (th + g), tw, th]);
  syncers.push(syncLfo); syncLfo();
}
// Size of a Speed or Depth knob whose ring fits wRoom across and whose ring and label fit hRoom down.
function lfoKnobSize(wRoom, hRoom) { return Math.max(16, Math.min(42 * UK, wRoom - 20, hRoom - 20 - (10 * UL + 3))); }
function lfoKnob(i, which, x, y, ks) { makeItem('lfo' + i + which, x, y, ks, { fam: 'feedback' }); }
// One channel's tile in the box r = [x, y, w, h], on a faint plate.
function lfoCell(i, r) {
  el('div', at(r[0], r[1], r[2], r[3]) + ';box-sizing:border-box;border-radius:5px;background:rgba(0,0,0,0.07);box-shadow:inset 0 0 0 1px rgba(0,0,0,0.13);pointer-events:none');
  var p = 6 * UK, g = 8 * UK, kh = 28 * UK, lab = 10 * UL + 3, x = r[0] + p, y = r[1] + p, w = r[2] - 2 * p, h = r[3] - 2 * p;
  var ks, R, ew, waveH;
  if (w > 1.6 * h) {   // wide tile: Wave over Target on the left, the knobs side by side on the right
    var lw = w * 0.46, rw = w - lw - g;
    ks = lfoKnobSize(rw / 2, h); R = ks / 2 + 10;
    makeLfoWave(i, x, y, lw, h - kh - g);
    makeLfoTarget(i, x, y + h - kh, lw, kh);
    var kx = spread(x + lw + g, x + w, [2 * R, 2 * R]), ky = y + (h - lab) / 2;
    lfoKnob(i, 'Rate', kx[0] + R, ky, ks); lfoKnob(i, 'Depth', kx[1] + R, ky, ks);
  } else {   // tile: Wave over the knobs over Target
    waveH = Math.min(h * 0.32, w * 0.6);
    ew = textW('Speed', 10 * UL, 700, 0.1) + 6 * UK;
    ks = lfoKnobSize(Math.min(w / 2, ew + 20), h - waveH - kh - 2 * g); R = ks / 2 + 10; ew = Math.max(ew, 2 * R);
    var ty = spread(y, y + h, [waveH, 2 * R + lab, kh]), kx2 = spread(x, x + w, [ew, ew]);
    makeLfoWave(i, x, ty[0], w, waveH);
    lfoKnob(i, 'Rate', kx2[0] + ew / 2, ty[1] + R, ks); lfoKnob(i, 'Depth', kx2[1] + ew / 2, ty[1] + R, ks);
    makeLfoTarget(i, x, ty[2], w, kh);
  }
}
function makeLfoWave(i, x, y, w, h) {
  var G = glass(x, y, w, h, ''), g = G.g, wk = 'lfo' + i + 'Wave', last = 0;
  var step = function (d) { params[wk] = (params[wk] + d + LFO_WAVES.length) % LFO_WAVES.length; drawLfoWaves(); flashTip(g, 'LFO ' + (i + 1) + '  ' + LFO_WAVES[params[wk]]); };
  g.style.cursor = 'pointer'; g.setAttribute('role', 'button'); g.tabIndex = 0;
  g.addEventListener('click', function () { step(1); });
  g.addEventListener('wheel', function (e) {   // one step per flick, not per wheel event
    e.preventDefault(); var now = performance.now(); if (now - last < 180) return; last = now; step(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  g.addEventListener('keydown', function (e) {
    var d = { Enter: 1, ' ': 1, ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); step(d); }
  });
  ui.lfoWave[i] = G;
}
function makeLfoTarget(i, x, y, w, h) {
  var k = key(x, y, w, h, '', 'off', { fs: 9 * UL, onClick: function () { pickLfo = i; setPage('main'); } });
  k.w = w; ui.lfoTarget[i] = k;
}
function syncLfo() {
  (ui.lfoTarget || []).forEach(function (k, i) {
    var t = lfoLive(i, true), name = t ? CONTROLS[t][0] : 'None', s = (i + 1) + ' · ' + name, fs = 9 * UL;
    fs = Math.min(fs, Math.floor(fs * (k.w - 14 * UK) / textW(s, fs, 700, 0.08) * 10) / 10);
    k.txt.textContent = s; k.txt.style.fontSize = fs + 'px';
    k.set(t ? 'mod' : 'off');
    k.b.setAttribute('aria-label', 'LFO ' + (i + 1) + ' target: ' + name + '. Pick a knob on the Main page');
  });
  drawLfoWaves();
}
var SH_DRAW = [0.55, -0.35, 0.9, -0.8, 0.15, -0.55];   // the S&H screen's picture of random steps
function lfoShape(w, p) {
  switch (w) {
    case 0: return Math.sin(p * TAU);
    case 1: return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);
    case 2: return 2 * p - 1;
    case 3: return p < 0.5 ? 1 : -1;
    default: return SH_DRAW[Math.floor(p * SH_DRAW.length) % SH_DRAW.length];
  }
}
// Each waveform screen: the LFO's number, its wave's name, one cycle of the wave (dimmer while the LFO drives nothing)
// and a dot where the LFO is now.
function drawLfoWaves() {
  (ui.lfoWave || []).forEach(function (G, i) {
    var c = G.x, w = G.w, h = G.h, wv = params['lfo' + i + 'Wave'], fs = Math.round(Math.min(h * 0.19, w * 0.15));
    var x0 = w * 0.09, x1 = w * 0.91, y0 = h * 0.4, y1 = h * 0.88, mid = (y0 + y1) / 2, a = (y1 - y0) / 2;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(143,141,146,0.3)'; c.lineWidth = 2; c.beginPath(); c.moveTo(x0, mid); c.lineTo(x1, mid); c.stroke();
    c.save(); c.globalAlpha = lfoLive(i) ? 1 : 0.5;
    c.beginPath();
    for (var k = 0; k <= 120; k++) { var p = Math.min(k / 120, 0.9999); c[k ? 'lineTo' : 'moveTo'](x0 + p * (x1 - x0), mid - a * lfoShape(wv, p)); }
    c.strokeStyle = ICON_GREEN; c.lineWidth = Math.max(3, h * 0.022); c.lineJoin = 'round'; c.lineCap = 'round';
    c.shadowColor = 'rgba(63,191,106,0.7)'; c.shadowBlur = 6; c.stroke();
    var px = x0 + lfoPh[i] * (x1 - x0), py = mid - a * lfoOut(i);
    c.shadowBlur = 0; c.strokeStyle = 'rgba(220,232,255,0.3)'; c.setLineDash([4, 6]);
    c.beginPath(); c.moveTo(px, y0 - a * 0.15); c.lineTo(px, y1 + a * 0.1); c.stroke(); c.setLineDash([]);
    c.shadowColor = P.accentGlow; c.shadowBlur = 8; c.fillStyle = P.accent;
    c.beginPath(); c.arc(px, py, Math.max(5, h * 0.04), 0, TAU); c.fill();
    c.restore();
    c.font = '800 ' + fs + 'px "Barlow Semi Condensed", "Segoe UI", sans-serif';
    c.textAlign = 'left'; c.fillStyle = P.inkMute; c.fillText(String(i + 1), x0, h * 0.07 + fs);
    c.textAlign = 'right'; c.fillStyle = P.accent; c.fillText(LFO_WAVES[wv].toUpperCase(), x1, h * 0.07 + fs);
    G.g.setAttribute('aria-label', 'LFO ' + (i + 1) + ' waveform: ' + LFO_WAVES[wv] + '. Tap for the next');
  });
}

// Picking an LFO's target (the Main page with pickLfo >= 0): every knob that can be a target gets an orange ring to
// tap (the LFO's current target filled), and a bar across the foot of the screen names the LFO, with Clear (no target)
// and Cancel. Tapping a knob, Clear, Cancel, Escape or the Advanced tab goes back to the Advanced page.
function makePickRings() {
  var cur = lfoLive(pickLfo, true);
  Object.keys(ui.knobs || {}).forEach(function (id) {
    if (!LFO_TARGETS[id]) return;
    var K = ui.knobs[id], name = CONTROLS[id][0];
    var d = el('div', at(K.x - K.R, K.y - K.R, 2 * K.R, 2 * K.R) + ';box-sizing:border-box;border-radius:50%;z-index:4;cursor:pointer;touch-action:manipulation;' +
      'border:' + 3 * UK + 'px solid ' + P.mod + ';background:' + (id === cur ? 'rgba(255,154,60,0.38)' : 'rgba(255,154,60,0.07)') + ';box-shadow:0 0 ' + 12 * UK + 'px ' + P.modGlow + ',inset 0 0 ' + 8 * UK + 'px ' + P.modGlow);
    d.className = 'pick'; d.setAttribute('role', 'button'); d.tabIndex = 0;
    d.setAttribute('aria-label', 'Make ' + name + ' the target of LFO ' + (pickLfo + 1));
    d.addEventListener('click', function () { pickTarget(id); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickTarget(id); } });
    d.addEventListener('pointerenter', function () { showTip(d, name); });
    d.addEventListener('pointerleave', hideTip);
  });
}
function makePickBanner() {
  var b = ui.bezel, h = 34 * UK, x = b[0] + 16, w = b[2] - 32, y = b[1] + b[3] - 16 - h, kw = 66 * UK, kh = h - 10 * UK, pad = 5 * UK;
  var bar = el('div', at(x, y, w, h) + ';box-sizing:border-box;z-index:5;display:flex;align-items:center;padding-left:' + 12 * UK + 'px;border-radius:6px;' +
    'background:rgba(12,12,15,0.82);box-shadow:0 0 0 2px ' + P.mod + ',0 0 14px ' + P.modGlow);
  bar.setAttribute('role', 'status');
  el('span', PRINT(9 * UL, P.mod), bar, 'LFO ' + (pickLfo + 1) + ' target · tap a knob');
  [['Cancel', function () { setPage('adv'); }], ['Clear', function () { pickTarget(''); }]].forEach(function (d, j) {
    var k = key(x + w - pad - (j + 1) * kw - j * pad, y + (h - kh) / 2, kw, kh, d[0], null, { fs: 8 * UL, aria: d[0] === 'Clear' ? 'No target for LFO ' + (pickLfo + 1) : 'Cancel picking', onClick: d[1] });
    k.b.style.zIndex = '6';
  });
}
function pickTarget(id) {
  var i = pickLfo; if (i < 0) return;
  params['lfo' + i + 'Target'] = id;
  setPage('adv');
  if (ui.lfoTarget && ui.lfoTarget[i]) flashTip(ui.lfoTarget[i].b, 'LFO ' + (i + 1) + ' → ' + (id ? CONTROLS[id][0] : 'none'));
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pickLfo >= 0) setPage('adv'); });
// On the Main page, an orange dot rides the scale of each knob an LFO drives, showing the value the frame is drawn
// with (updated every frame by lfoUi).
function syncModDots() {
  Object.keys(ui.modDots || {}).forEach(function (id) { ui.modDots[id].remove(); });
  ui.modDots = {};
  for (var i = 0; i < LFO_N; i++) {
    var id = lfoLive(i), K = id && ui.knobs && ui.knobs[id];
    if (!K || ui.modDots[id]) continue;
    var c = el('div', 'position:absolute;inset:0;pointer-events:none', K.ring), s = 10 * UK;
    el('div', 'position:absolute;left:50%;top:1px;width:' + s + 'px;height:' + s + 'px;margin-left:' + (-s / 2) + 'px;border-radius:50%;background:' + P.mod + ';box-shadow:0 0 8px ' + P.modGlow, c);
    ui.modDots[id] = c;
  }
  lfoUi();
}
function afterPanel() {
  if (page !== 'main') return;
  syncers.push(syncModDots); syncModDots();
  if (pickLfo >= 0) { makePickRings(); makePickBanner(); }
}
// Per rendered frame: the waveform screens (Advanced page) or the modulation dots (Main page).
function lfoUi() {
  if (page === 'adv') { drawLfoWaves(); return; }
  for (var id in ui.modDots || {}) {
    var v = clamp(toV(PD[id], params[id]) + (lfoOff[id] || 0));
    ui.modDots[id].style.transform = 'rotate(' + (-135 + v * 270) + 'deg)';
  }
}

// LFO engine. Phases advance with the render clock (simTime), so Freeze holds them and the self-test hooks repeat;
// S&H takes a new random level each time its cycle wraps. liveParams(t) gives the parameters a frame is drawn with:
// params itself while no LFO drives anything, otherwise a copy (LIVE) with each target moved by its LFOs. The move is in
// knob travel (0-1, through the knob's taper), Depth x 1/2 x the wave, so Depth 100% swings across the whole sweep;
// stepped knobs (Blend Mode, Delay, Shape Sides) stay on their steps. The knobs keep showing where they are set.
var lfoPh = [], lfoSH = [], lfoT = null, lfoOff = {}, LIVE = {};
for (q = 0; q < LFO_N; q++) { lfoPh.push(0); lfoSH.push(0); }
function lfoOut(i) { var w = params['lfo' + i + 'Wave']; return w === 4 ? lfoSH[i] : lfoShape(w, lfoPh[i]); }
// The id of the knob LFO i drives ('' for none; any depth when anyDepth, else only while Depth is above 0).
function lfoLive(i, anyDepth) {
  var t = params['lfo' + i + 'Target'];
  return t && LFO_TARGETS[t] && (anyDepth || params['lfo' + i + 'Depth'] > 0) ? t : '';
}
function modValue(d, x, off) {
  var v = clamp(toV(d, x) + off);
  x = d.log ? d.min * Math.pow(d.max / d.min, v) : d.min + (d.exp ? taper(d, v) : v) * (d.max - d.min);
  if (steps(d)) x = Math.round(x / d.step) * d.step;
  return clamp(x, d.min, d.max);
}
function liveParams(t) {
  var i, id;
  if (t !== lfoT) {
    var dt = lfoT == null ? 0 : clamp(t - lfoT, 0, 0.25);
    lfoT = t;
    for (i = 0; i < LFO_N; i++) {
      lfoPh[i] += dt * params['lfo' + i + 'Rate'];
      if (lfoPh[i] >= 1) { lfoPh[i] %= 1; lfoSH[i] = Math.random() * 2 - 1; }
    }
  }
  var off = {}, any = false;
  for (i = 0; i < LFO_N; i++) {
    id = lfoLive(i);
    if (id) { off[id] = (off[id] || 0) + params['lfo' + i + 'Depth'] * 0.5 * lfoOut(i); any = true; }
  }
  lfoOff = off;
  if (!any) return params;
  Object.assign(LIVE, params);
  for (id in off) LIVE[id] = modValue(PD[id], params[id], off[id]);
  return LIVE;
}
function syncKeyOn() {
  (ui.onOff || []).forEach(function (k) {
    var on = !!params[k.param];
    k.txt.textContent = on ? 'On' : 'Off';
    k.b.setAttribute('aria-pressed', on ? 'true' : 'false');
    k.b.style.boxShadow = on ? k.shadow + ',0 0 14px 2px ' + P.accentGlow : k.shadow;
    k.txt.style.color = on ? P.accent : '#b4b2b8'; k.txt.style.textShadow = on ? '0 0 7px ' + P.accentGlow : '';
  });
}
function syncKeySwatch() {
  if (!ui.keySwatch) return;
  var c = hslToRgb(params.keyHue, params.keySat, params.keyLight);
  ui.keySwatch.style.background = 'rgb(' + c.map(function (v) { return Math.round(v * 255); }).join(',') + ')';
}
// Blend Mode positions printed around its knob like a rotary switch (left of the top, centred on it, right of it); tap
// a name to pick it.
function legendAngle(i, n) { return -135 + i * 270 / (n - 1); }
function ringLegend(k, id, names, x, y) {
  var labs = names.map(function (n, i) {
    var deg = legendAngle(i, names.length), a = deg * Math.PI / 180, r = k.R + 7 * UK, lx = x + r * Math.sin(a), ly = y - r * Math.cos(a);
    var bw = 46 * UL, bh = 12 * UL, side = Math.abs(deg) < 1 ? 0 : deg < 0 ? -1 : 1;
    var s = el('span', at(side < 0 ? lx - bw : side > 0 ? lx : lx - bw / 2, side ? ly - bh / 2 : ly - bh, bw, bh) + ';text-align:' +
      (side < 0 ? 'right' : side > 0 ? 'left' : 'center') + ';' + PRINT(9 * UL) + ';cursor:pointer', panel, n);
    s.addEventListener('click', function () { k.set(i / (names.length - 1)); });
    return s;
  });
  (ui.legends = ui.legends || []).push({ id: id, labs: labs });
  syncBlendLegend();
}
// Light the selected name of every ring legend (Blend Mode's, the LFO's waveform).
function syncBlendLegend() {
  (ui.legends || []).forEach(function (L) {
    L.labs.forEach(function (s, i) {
      var on = i === params[L.id];
      s.style.color = on ? P.accent : P.inkMute; s.style.textShadow = on ? '0 0 6px ' + P.accentGlow : 'none';
    });
  });
}

function wantLand() {
  if (/landscape/.test(location.hash)) return true;
  if (/portrait/.test(location.hash)) return false;
  var v = viewSize(); return v[0] > v[1];
}
build();

// -------------------------------------------------------------
// 4. WebGL2 boilerplate + ring-buffer framebuffers
// -------------------------------------------------------------
var canvas = glCanvas;
// Opaque, no depth / stencil: every pixel is written with alpha 1 and nothing is depth-tested, so the browser can
// composite the canvas as opaque and skip allocating (and clearing) a depth buffer the size of the canvas.
var gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false });
if (!gl) {
  el('div', '', ui.screen, 'WebGL2 is not available in this browser, so the visualizer cannot run here.').className = 'gl-error';
  throw new Error('WebGL2 not available');
}

function compileShader(type, source) {
  var sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    var info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error:\n' + info);
  }
  return sh;
}

function linkProgram(vsSource, fsSource) {
  var vs = compileShader(gl.VERTEX_SHADER, vsSource);
  var fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link error:\n' + gl.getProgramInfoLog(prog));
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function uniformLocations(prog, names) {
  var locs = {};
  names.forEach(function (name) { locs[name] = gl.getUniformLocation(prog, name); });
  return locs;
}

// A full-screen triangle needs no vertex buffer at all - positions are
// computed from gl_VertexID in the vertex shader.
function drawFullscreenTriangle() { gl.drawArrays(gl.TRIANGLES, 0, 3); }

// Feedback (reading "last frame" while writing "this frame") needs at
// least two framebuffers so a shader never reads and writes the same
// texture in one draw call - see DESIGN.md section 2. This is that
// same ping-pong technique generalized to RING_SIZE slots: each frame
// writes into the next slot and reads from `1 + delay` slots behind it.
// The slots are half-float (RGBA16F) where the GPU can render to it: 8-bit slots round every pixel to 1/255 on each pass,
// and the loop amplifies that rounding into crawling speckle and pixels toggling between neighbouring levels. Otherwise
// RGBA8, with dither in the loop (u_dither). Extensions must be enabled again after a context loss, hence a function.
function detectFloatBuffers() {
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return false;
  var t = gl.createTexture(), f = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(f); gl.deleteTexture(t);
  return ok;
}
var FB_FLOAT = detectFloatBuffers();
function createFBO(w, h, bytes) {   // bytes: always RGBA8 (the guard's proxy, read back as bytes)
  var tex = gl.createTexture(), f = FB_FLOAT && !bytes;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, f ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, f ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  var fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo: fbo, tex: tex };
}

function clearFBO(target) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.viewport(0, 0, CW, CH);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

// The ring starts with the 2 slots plain ping-pong needs and grows (doubling, up to RING_SIZE) only when Delay asks
// for more history: 32 full-resolution slots are 112 MB of GPU memory, which phones feel, while Delay is usually 0.
function createRingBuffers(n) {
  var list = [];
  for (var i = 0; i < (n || 2); i++) list.push(createFBO(CW, CH));
  return list;
}

function copyFBO(src, dst) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
  gl.blitFramebuffer(0, 0, CW, CH, 0, 0, CW, CH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// Make room for reading `delay` frames back. The existing history keeps its order (frame k ago stays frame k ago);
// slots for frames older than any recorded start as copies of the oldest one, so raising Delay shows a brief hold
// of that frame rather than black, and turns into real history within `delay` frames.
function ensureHistory(delay) {
  var C = buffers.length, cap = C;
  if (delay + 2 <= C) return;
  while (cap < delay + 2) cap *= 2;
  cap = Math.min(cap, RING_SIZE);
  var ordered = [];
  for (var k = C - 1; k >= 0; k--) ordered.push(buffers[wrapIndex(ringWriteIndex - 1 - k, C)]);   // oldest first
  var fresh = [];
  for (var i = C; i < cap; i++) { var fb = createFBO(CW, CH); copyFBO(ordered[0], fb); fresh.push(fb); }
  buffers = fresh.concat(ordered);   // newest last; the next write goes to slot 0, the oldest copy
  ringWriteIndex = 0;
}

function wrapIndex(i, n) { return ((i % n) + n) % n; }

var buffers = createRingBuffers(2);
var ringWriteIndex = 0;
buffers.forEach(clearFBO);

// -------------------------------------------------------------
// 5. GLSL source
// -------------------------------------------------------------
var VERTEX_SRC = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 pos[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  vec2 p = pos[gl_VertexID];
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// 2D simplex noise - standard public implementation (Ian McEwan /
// Stefan Gustavson, MIT-licensed webgl-noise).
var SIMPLEX_NOISE_GLSL = `
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
// glsl-functions.js (MIT license, see DESIGN.md section 5).
// The canvas is 9:16, so everything spatial (rotation, noise, shape)
// works in aspect-corrected coordinates to stay round.
var FEEDBACK_FRAGMENT_SRC = `#version 300 es
precision highp float;

uniform sampler2D u_prevFrame;
uniform vec2  u_resolution;
uniform float u_time;
uniform sampler2D u_delayFrame;   // the Delay tap: the frame Delay frames further back
uniform float u_delayMix;         // its share of the feedback read (0 when Delay is Live)
uniform float u_diffuse;          // weight of each of the four diffusion taps
uniform float u_dither;           // dither amplitude written into 8-bit slots (0 with half-float slots)
uniform float u_frameSeed;

// feedback
uniform float u_feedback;
uniform float u_zoom;
uniform float u_rotate;
uniform vec2  u_translate;
uniform float u_hueDrift;

// layers: weights from the XY mixer (camera, osc, noise, shape)
uniform vec4  u_mix;
uniform float u_frequency;
uniform float u_speed;
uniform float u_sync;
uniform float u_noiseSpeed;
uniform float u_shapeSides;
uniform float u_shapeSmoothing;
uniform float u_noiseScale;
uniform sampler2D u_camera;
uniform sampler2D u_cameraPrev;   // the camera frame before u_camera
uniform float u_camMix;           // crossfade from u_cameraPrev to u_camera over one camera frame
uniform float u_cameraAspect;
uniform float u_cameraOn;
uniform float u_cameraMirror;

// color
uniform float u_hue;
uniform float u_saturate;
uniform float u_brightness;
uniform float u_contrast;
uniform vec3  u_eqBand[7];   // Colors EQ bands: gain, centre hue (turns), width (turns)
uniform float u_eqOn;

// chromakey
uniform float u_chromakeyEnabled;
uniform vec3  u_chromakeyColor;
uniform float u_chromakeyThreshold;
uniform float u_chromakeySoftness;

// blend
uniform int   u_blendMode; // 0 darken, 1 mix, 2 add, 3 mult, 4 diff
uniform float u_modulateAmount;

in vec2 v_uv;
out vec4 fragColor;

${SIMPLEX_NOISE_GLSL}

float aspect() { return u_resolution.x / u_resolution.y; }

vec2 rotateUV(vec2 st, float angle) {
  vec2 k = vec2(aspect(), 1.0);
  vec2 xy = (st - 0.5) * k;
  float c = cos(angle), s = sin(angle);
  xy = mat2(c, -s, s, c) * xy;
  return xy / k + 0.5;
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

// Colors EQ: saturation times 1 + the sum of each band's (gain - 1) x its bell (a Gaussian of the hue distance over the
// band's width), at the pixel's hue.
vec3 hueEq(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float h = rgb2hsv(c).x, k = 1.0;
  for (int i = 0; i < 7; i++) {
    vec3 b = u_eqBand[i];
    float d = abs(fract(h - b.y + 0.5) - 0.5) / b.z;
    k += (b.x - 1.0) * exp(-0.5 * d * d);
  }
  return saturateColor(c, max(k, 0.0));
}

vec3 brightnessColor(vec3 c, float amount) { return c + amount; }

vec3 contrastColor(vec3 c, float amount) { return (c - 0.5) * amount + 0.5; }

vec2 modulateUV(vec2 st, vec4 b, float amount) { return st + b.xy * amount; }

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

vec4 blendFn(vec4 prev, vec4 gen, int mode, float feedback) {
  if (mode == 0) return vec4(mix(gen.rgb, min(prev.rgb, gen.rgb), feedback), 1.0);
  if (mode == 2) return vec4(prev.rgb * feedback + gen.rgb, 1.0);
  if (mode == 3) return vec4(mix(gen.rgb, prev.rgb * gen.rgb, feedback), 1.0);
  if (mode == 4) return vec4(mix(gen.rgb, abs(prev.rgb - gen.rgb), feedback), 1.0);
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
  vec2 p = (st - 0.5) * vec2(aspect(), 1.0) * u_noiseScale;
  float t = u_time * u_noiseSpeed;
  float nr = snoise(p + vec2(t, 0.0)) * 0.5 + 0.5;
  float ng = snoise(p + vec2(0.0, t) + 5.2) * 0.5 + 0.5;
  float nb = snoise(p + vec2(t * 0.7, t * 0.3) + 9.7) * 0.5 + 0.5;
  return vec4(nr, ng, nb, 1.0);
}

// White polygon; alpha is the shape itself, so the mix shows black around it.
vec4 genShape(vec2 st) {
  vec2 c = (st - 0.5) * vec2(1.0, 1.0 / aspect());
  float a = atan(c.x, c.y) + 3.14159265359;
  float r = 6.28318530718 / max(u_shapeSides, 3.0);
  float d = cos(floor(0.5 + a / r) * r - a) * length(c);
  float s = smoothstep(0.3, 0.3 - max(u_shapeSmoothing, 0.001), d);
  return vec4(1.0, 1.0, 1.0, s);
}

// Cover-fit sample of the live camera texture (the long axis is
// center-cropped to the 9:16 canvas, never squashed). Y is flipped
// because texImage2D uploads a <video> frame top-row-first while our
// v_uv convention has v=0 at the bottom. The front camera is mirrored
// (selfie view); the back camera is not. Alpha is 0 while it is off.
vec4 genCamera(vec2 st) {
  vec2 uv = vec2(u_cameraMirror > 0.5 ? 1.0 - st.x : st.x, 1.0 - st.y);
  float ca = aspect();
  vec2 scale = u_cameraAspect > ca ? vec2(ca / u_cameraAspect, 1.0) : vec2(1.0, u_cameraAspect / ca);
  uv = (uv - 0.5) * scale + 0.5;
  return vec4(mix(texture(u_cameraPrev, uv).rgb, texture(u_camera, uv).rgb, u_camMix), u_cameraOn);
}

// The four layers crossfaded by the mixer weights; whatever they leave
// uncovered (around the shape, an off camera) is black.
vec4 generate(vec2 st) {
  vec3 acc = vec3(0.0);
  vec4 c;
  if (u_mix.x * u_cameraOn > 0.001) { c = genCamera(st); acc += u_mix.x * c.a * c.rgb; }   // an off camera adds nothing
  if (u_mix.y > 0.001) { c = genOsc(st);    acc += u_mix.y * c.a * c.rgb; }
  if (u_mix.z > 0.001) { c = genNoise(st);  acc += u_mix.z * c.a * c.rgb; }
  if (u_mix.w > 0.001) { c = genShape(st);  acc += u_mix.w * c.a * c.rgb; }
  return vec4(acc, 1.0);
}

void main() {
  vec2 uv = v_uv;

  vec4 gen = generate(uv);
  // A zero hue shift is just the clamp (skips the HSV round trip; Hue defaults to 0).
  gen.rgb = u_hue != 0.0 ? hueRotate(gen.rgb, u_hue) : clamp(gen.rgb, 0.0, 1.0);

  // Feedback read: rotate/zoom/translate a little further from last
  // frame's image each frame - this is the actual "video feedback" step.
  vec2 fbUV = uv;
  fbUV = rotateUV(fbUV, u_rotate);
  fbUV = scaleUV(fbUV, u_zoom, vec2(0.5));
  fbUV += u_translate;
  if (u_modulateAmount > 0.0001) fbUV = modulateUV(fbUV, gen, u_modulateAmount);

  // Diffusion: last frame's image slightly blurred (four taps 0.6 px off diagonally), as a camera's optics blur real
  // video feedback; it damps the pixel-scale back-and-forth that resampling and in-loop contrast otherwise amplify.
  vec2 dd = 0.6 / u_resolution;
  vec4 prev = texture(u_prevFrame, fract(fbUV)) * (1.0 - 4.0 * u_diffuse)
    + (texture(u_prevFrame, fract(fbUV + dd)) + texture(u_prevFrame, fract(fbUV - dd))
     + texture(u_prevFrame, fract(fbUV + vec2(dd.x, -dd.y))) + texture(u_prevFrame, fract(fbUV + vec2(-dd.x, dd.y)))) * u_diffuse;
  if (u_delayMix > 0.0) prev = mix(prev, texture(u_delayFrame, fract(fbUV)), u_delayMix);
  prev.rgb = u_hueDrift != 0.0 ? hueRotate(prev.rgb, u_hueDrift) : clamp(prev.rgb, 0.0, 1.0);

  // Chromakey: pixels of the fresh layer mix close to the key color are
  // replaced with the feedback-read color instead, so a keyed color
  // (e.g. a camera's green-screen background) shows the swirling
  // feedback through it rather than flat color every frame.
  if (u_chromakeyEnabled >= 0.5) {
    float dist = length(gen.rgb - u_chromakeyColor);
    float keyMask = smoothstep(u_chromakeyThreshold - u_chromakeySoftness, u_chromakeyThreshold + u_chromakeySoftness, dist);
    gen.rgb = mix(prev.rgb, gen.rgb, keyMask);
  }

  vec4 result = blendFn(prev, gen, u_blendMode, u_feedback);

  result.rgb = saturateColor(result.rgb, u_saturate);
  if (u_eqOn > 0.5) result.rgb = hueEq(result.rgb);
  result.rgb = brightnessColor(result.rgb, u_brightness);
  result.rgb = contrastColor(result.rgb, u_contrast);
  result.rgb = clamp(result.rgb, 0.0, 1.0);
  if (u_dither > 0.0) result.rgb += u_dither * (hash12(gl_FragCoord.xy + u_frameSeed) + hash12(gl_FragCoord.xy + u_frameSeed + 71.3) - 1.0);
  result.a = 1.0;

  fragColor = result;
}`;

// The display pass copies the feedback image to the canvas. In Diff, whose loop flips pixels between two values on
// alternate frames, it shows the average of the last two frames (u_avg 0.5). With half-float slots it adds a fixed
// (not frame-varying) dither as it drops to the canvas's 8 bits, so smooth gradients don't band.
var DISPLAY_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform sampler2D u_prev;
uniform float u_avg;
uniform float u_outDither;
in vec2 v_uv;
out vec4 fragColor;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 c = texture(u_frame, v_uv).rgb;
  if (u_avg > 0.0) c = mix(c, texture(u_prev, v_uv).rgb, u_avg);
  c += u_outDither * (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.3) - 1.0) / 255.0;
  fragColor = vec4(c, 1.0);
}`;

var FEEDBACK_UNIFORMS = [
  'u_prevFrame', 'u_resolution', 'u_time',
  'u_feedback', 'u_zoom', 'u_rotate', 'u_translate', 'u_hueDrift',
  'u_mix', 'u_frequency', 'u_speed', 'u_sync', 'u_noiseSpeed', 'u_shapeSides', 'u_shapeSmoothing',
  'u_noiseScale', 'u_camera', 'u_cameraAspect', 'u_cameraOn', 'u_cameraMirror',
  'u_hue', 'u_saturate', 'u_brightness', 'u_contrast', 'u_eqBand', 'u_eqOn',
  'u_chromakeyEnabled', 'u_chromakeyColor', 'u_chromakeyThreshold', 'u_chromakeySoftness',
  'u_blendMode', 'u_modulateAmount', 'u_delayFrame', 'u_delayMix', 'u_diffuse', 'u_dither', 'u_frameSeed', 'u_cameraPrev', 'u_camMix'
];
var feedbackProgram, displayProgram, feedbackUniforms, displayUniforms;
function linkPrograms() {
  feedbackProgram = linkProgram(VERTEX_SRC, FEEDBACK_FRAGMENT_SRC);
  displayProgram = linkProgram(VERTEX_SRC, DISPLAY_FRAGMENT_SRC);
  feedbackUniforms = uniformLocations(feedbackProgram, FEEDBACK_UNIFORMS);
  displayUniforms = uniformLocations(displayProgram, ['u_frame', 'u_prev', 'u_avg', 'u_outDither']);
}
linkPrograms();

// -------------------------------------------------------------
// 6. Camera source. A plain (non-FBO) texture uploaded from a hidden
// <video> each frame while a getUserMedia stream is active; a 1x1
// black pixel before that.
// -------------------------------------------------------------
var cameraVideo = document.createElement('video');
cameraVideo.autoplay = true;
cameraVideo.playsInline = true;
cameraVideo.muted = true;

function createCameraTexture() {
  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  return tex;
}
// Two textures, the newest frame (cameraTexture) and the one before (cameraPrevTexture): the shader crossfades from
// the older to the newer over one camera frame, so the 24-30 fps camera doesn't step every other render frame (each
// step is a jolt the feedback loop carries on). Each texture's allocated size is kept on it (w, h; 0 = the 1x1
// placeholder).
var cameraTexture = createCameraTexture(), cameraPrevTexture = createCameraTexture();
var camFrameNew = false, camLastTime = -1, camNewAt = 0, camPeriod = 33;
var HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

// Note each new decoded camera frame (the camera runs at 24-30 fps, the render loop at 60).
function watchCameraFrames(stream) {
  camFrameNew = true;
  if (!HAS_RVFC) return;
  var tick = function () { if (cam.stream !== stream) return; camFrameNew = true; cameraVideo.requestVideoFrameCallback(tick); };
  cameraVideo.requestVideoFrameCallback(tick);
}

// Upload the camera frame only when there is a new one and the Camera layer is actually in the mix; a 1280 x 720
// upload every render frame was the costliest per-frame step with the camera on. Same-size frames update the
// texture in place (texSubImage2D) instead of reallocating it.
function updateCameraTexture() {
  if (!cam.stream || cameraVideo.readyState < 2) return; // HAVE_CURRENT_DATA
  if (mixWeights()[0] <= 0.001) return;
  var fresh = HAS_RVFC ? camFrameNew : cameraVideo.currentTime !== camLastTime;
  if (!fresh && cameraTexture.w) return;
  camFrameNew = false; camLastTime = cameraVideo.currentTime;
  var w = cameraVideo.videoWidth, h = cameraVideo.videoHeight;
  if (!w || !h) return;
  cam.aspect = w / h;
  var now = performance.now();
  if (camNewAt) camPeriod = clamp(camPeriod * 0.8 + (now - camNewAt) * 0.2, 15, 100);   // the camera's frame interval, smoothed
  camNewAt = now;
  var t = cameraPrevTexture; cameraPrevTexture = cameraTexture; cameraTexture = t;   // the new frame goes into the older texture
  gl.bindTexture(gl.TEXTURE_2D, t);
  if (w === t.w && h === t.h) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, cameraVideo);
  else { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cameraVideo); t.w = w; t.h = h; }
}

function stopCamera() {
  if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
  cam.stream = null;
  cameraVideo.srcObject = null;
  syncCam();
}

function startCamera(facing) {
  if (cam.busy) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    flash(ui.camOn); flashTip(ui.camOn.b, 'Camera needs https'); return;
  }
  cam.busy = true;
  cam.facing = facing;
  syncCam();
  if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
  navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    .then(function (stream) {
      cam.stream = stream;
      cameraVideo.srcObject = stream;
      return cameraVideo.play().then(function () { watchCameraFrames(stream); });
    })
    .catch(function (err) {
      stopCamera();
      flash(ui.camOn); flashTip(ui.camOn.b, err && err.name === 'NotAllowedError' ? 'Camera blocked' : 'No camera');
    })
    .then(function () { cam.busy = false; syncCam(); });
}

window.addEventListener('beforeunload', function () { if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); }); });

// -------------------------------------------------------------
// 7. Uniform upload + render loop
// -------------------------------------------------------------
var eqVals = new Float32Array(EQ_N * 3);
var DIFFUSE = 0.1;   // weight of each diffusion tap (0 = none; see the feedback shader)
// p: the frame's parameters (liveParams: params with the LFOs applied).
function uploadFeedbackUniforms(t, p) {
  p = p || liveParams(t);
  var u = feedbackUniforms, w = mixWeights(), key = hslToRgb(p.keyHue, p.keySat, p.keyLight);
  gl.uniform1i(u.u_prevFrame, 0);
  gl.uniform2f(u.u_resolution, CW, CH);
  gl.uniform1f(u.u_time, t);
  gl.uniform1f(u.u_feedback, p.feedback);
  gl.uniform1f(u.u_zoom, p.zoom);
  gl.uniform1f(u.u_rotate, p.rotate);
  gl.uniform2f(u.u_translate, p.translateX, p.translateY);
  gl.uniform1f(u.u_hueDrift, p.hueDrift);
  gl.uniform4f(u.u_mix, w[0], w[1], w[2], w[3]);
  gl.uniform1f(u.u_frequency, FIXED.frequency / p.oscSize);
  gl.uniform1f(u.u_speed, FIXED.speed);
  gl.uniform1f(u.u_sync, FIXED.sync);
  gl.uniform1f(u.u_noiseSpeed, FIXED.noiseSpeed);
  gl.uniform1f(u.u_shapeSides, p.shapeSides);
  gl.uniform1f(u.u_shapeSmoothing, FIXED.shapeSmoothing);
  gl.uniform1f(u.u_noiseScale, p.noiseScale);
  gl.uniform1i(u.u_camera, 1);
  gl.uniform1i(u.u_delayFrame, 2);
  gl.uniform1i(u.u_cameraPrev, 3);
  gl.uniform1f(u.u_camMix, clamp((performance.now() - camNewAt) / camPeriod, 0, 1));
  gl.uniform1f(u.u_diffuse, DIFFUSE);
  gl.uniform1f(u.u_dither, FB_FLOAT ? 0 : 1 / 255);
  gl.uniform1f(u.u_cameraAspect, cam.aspect);
  gl.uniform1f(u.u_cameraOn, cam.stream && cameraVideo.readyState >= 2 ? 1 : 0);
  gl.uniform1f(u.u_cameraMirror, cam.facing === 'user' ? 1 : 0);
  gl.uniform1f(u.u_hue, p.hue / 360);
  gl.uniform1f(u.u_saturate, p.saturate);
  gl.uniform1f(u.u_brightness, p.brightness);
  gl.uniform1f(u.u_contrast, p.contrast);
  for (var e = 0; e < EQ_N; e++) { eqVals[3 * e] = p['eqG' + e]; eqVals[3 * e + 1] = EQ_HUES[e] / 360; eqVals[3 * e + 2] = EQ_WIDTH_DEG / 360; }
  gl.uniform3fv(u.u_eqBand, eqVals);
  gl.uniform1f(u.u_eqOn, eqActive() ? 1 : 0);
  gl.uniform1f(u.u_chromakeyEnabled, p.chromakeyEnabled ? 1 : 0);
  gl.uniform3f(u.u_chromakeyColor, key[0], key[1], key[2]);
  gl.uniform1f(u.u_chromakeyThreshold, p.chromakeyThreshold);
  gl.uniform1f(u.u_chromakeySoftness, p.chromakeySoftness);
  gl.uniform1i(u.u_blendMode, p.blendMode);
  gl.uniform1f(u.u_modulateAmount, p.modulateAmount);
}

var lastWritten = buffers[0];

// Runaway guard (always on; the Breathe strategy, chosen from seven, DESIGN.md §30 and §34): keeps the loop from running
// away to a saturated, white, black or flat field. Every few frames a proxy of the field (the image drawn into a grid
// about 18 x 32, read back without stalling: a pixel-buffer read and a fence, collected frames later) gives its
// brightness mean and spread, mean saturation (chroma) and the shares near white and near black. The larger of the
// excess scores (0-1) for those failures shortens Persistence by up to 45%, so the layers refill the field; the
// shortening eases in and out (guardEase).
// Called each feedback pass: collect a finished read, then (every GUARD_EVERY frames) start the next.
function guardStep(measureNow) {
  if (guard.fence) {
    var st = gl.clientWaitSync(guard.fence, 0, 0);
    if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
      gl.deleteSync(guard.fence); guard.fence = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, guard.pbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, guard.px); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      guardStats();
    }
  }
  if (!measureNow || guard.fence || ++guard.n % GUARD_EVERY) return;
  var w = Math.max(4, Math.round(CW / 40)), h = Math.max(4, Math.round(CH / 40));
  if (!guard.fbo || guard.w !== w || guard.h !== h) {
    if (guard.fbo) { gl.deleteFramebuffer(guard.fbo.fbo); gl.deleteTexture(guard.fbo.tex); }
    guard.fbo = createFBO(w, h, true); guard.w = w; guard.h = h; guard.px = new Uint8Array(w * h * 4);
    guard.pbo = guard.pbo || gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, guard.pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, guard.fbo.fbo); gl.viewport(0, 0, w, h);
  gl.useProgram(displayProgram);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, lastWritten.tex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lastWritten.tex);
  gl.uniform1i(displayUniforms.u_frame, 0); gl.uniform1i(displayUniforms.u_prev, 1); gl.uniform1f(displayUniforms.u_avg, 0); gl.uniform1f(displayUniforms.u_outDither, 0);
  drawFullscreenTriangle();
  if (GUARD_SYNC) { gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, guard.px); guardStats(); }
  else {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, guard.pbo); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    guard.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, CW, CH);
}
function guardEase() { if (guard.T != null) guard.fb += (guard.T - guard.fb) * 0.08; }
// The proxy's statistics, the excess scores and the Persistence scale they call for.
function guardStats() {
  var px = guard.px, n = px.length / 4, sl = 0, sl2 = 0, ss = 0, wh = 0, bk = 0;
  for (var i = 0; i < px.length; i += 4) {
    var r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255, l = 0.299 * r + 0.587 * g + 0.114 * b;
    sl += l; sl2 += l * l; ss += Math.max(r, g, b) - Math.min(r, g, b); if (l > 0.9) wh++; if (l < 0.06) bk++;
  }
  var mean = sl / n, st = guard.stats = { mean: mean, sd: Math.sqrt(Math.max(0, sl2 / n - mean * mean)), sat: ss / n, white: wh / n, black: bk / n };
  var c = function (v) { return clamp(v, 0, 1); };
  // Triggers sit past the healthy look (the default field: saturation ~0.83, spread ~0.06, no white or black), at its
  // runaway forms: everything saturated, white or black, or the spread collapsing to a flat field.
  var ex = guard.ex = { sat: c((st.sat - 0.9) / 0.08), white: c((st.white - 0.25) / 0.45), black: c((st.black - 0.4) / 0.45), flat: c((0.03 - st.sd) / 0.025) };
  guard.act = c(Math.max(ex.sat, ex.white, ex.black, ex.flat));
  guard.T = 1 - 0.45 * guard.act;   // eased towards a little every frame (guardEase), so the change never steps
}

var frameCount = 0;
function renderFeedbackPass(t) {
  // The loop always reads the most recently completed frame; Delay mixes in a second tap from `delay` frames further
  // back. (Reading only the old frame split the image into delay + 1 loops interleaved frame by frame, which strobed.)
  // The ring always holds at least delay+2 slots, so neither read can land on the slot being written.
  var p = liveParams(t), delay = Math.round(p.delay);
  guardStep(false); guardEase();
  ensureHistory(delay);
  var n = buffers.length, writeIndex = ringWriteIndex;
  var write = buffers[writeIndex], read = buffers[wrapIndex(writeIndex - 1, n)], tap = buffers[wrapIndex(writeIndex - 1 - delay, n)];
  gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
  gl.viewport(0, 0, CW, CH);
  gl.useProgram(feedbackProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, read.tex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, tap.tex);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, cameraPrevTexture);
  uploadFeedbackUniforms(t, p);
  gl.uniform1f(feedbackUniforms.u_delayMix, delay > 0 ? 0.5 : 0);
  gl.uniform1f(feedbackUniforms.u_frameSeed, (frameCount++ % 997) * 13.7);
  if (guard.fb < 0.9999) gl.uniform1f(feedbackUniforms.u_feedback, p.feedback * guard.fb);
  drawFullscreenTriangle();
  lastWritten = write;
  ringWriteIndex = wrapIndex(ringWriteIndex + 1, n);
  guardStep(true);
}

function renderDisplayPass() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, CW, CH);
  gl.useProgram(displayProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, lastWritten.tex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, buffers[wrapIndex(buffers.indexOf(lastWritten) - 1, buffers.length)].tex);   // the frame before
  gl.uniform1i(displayUniforms.u_frame, 0);
  gl.uniform1i(displayUniforms.u_prev, 1);
  gl.uniform1f(displayUniforms.u_avg, params.blendMode === 4 ? 0.5 : 0);
  gl.uniform1f(displayUniforms.u_outDither, FB_FLOAT ? 1 : 0);
  drawFullscreenTriangle();
}

var simTime = 0;
var lastNow = performance.now();
var frozen = false;

// Render at most 60 times a second. Zoom, rotate, drift and hue drift are applied per rendered frame, so on a
// 120 / 144 Hz display an uncapped loop ran the visuals 2-2.4x faster than designed and did that much more GPU work.
// Renders are scheduled on a fixed 60 Hz grid (1 ms early is accepted, for timestamp jitter), which gives exactly
// every frame at 60 / 59.94 Hz and an even 60 at 90-240 Hz; after a stall of 3+ frames the grid restarts.
var FRAME_MS = 1000 / 60;
var nextRender = 0;
var contextLost = false;

function frame(now) {
  requestAnimationFrame(frame);
  var dt = Math.min((now - lastNow) / 1000, 0.1);
  lastNow = now;
  simTime += dt;
  if (now < nextRender - 1) return;
  nextRender = now - nextRender > 3 * FRAME_MS ? now + FRAME_MS : nextRender + FRAME_MS;
  if (contextLost) return;
  if (!frozen) {
    updateCameraTexture();
    renderFeedbackPass(simTime);
    renderDisplayPass();
    lfoUi();
  } else if (rec) renderDisplayPass();   // a recording keeps running through a freeze, holding the frozen image
  if (rec) rec.capture();
}

// A lost WebGL context (GPU reset, driver update, memory pressure) drops every program, texture and framebuffer;
// rebuild them all when it comes back, otherwise the canvas stays black.
canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); contextLost = true; }, false);
canvas.addEventListener('webglcontextrestored', function () {
  linkPrograms();
  FB_FLOAT = detectFloatBuffers();
  guard.fbo = null; guard.pbo = null; guard.fence = null; guard.T = null; guard.fb = 1;
  buffers = createRingBuffers(2);
  clearScreen();
  cameraTexture = createCameraTexture(); cameraPrevTexture = createCameraTexture();
  camNewAt = 0; camFrameNew = true;
  contextLost = false;
}, false);

// -------------------------------------------------------------
// 8. Header keys, camera keys, fit to window
// -------------------------------------------------------------
function syncCam() {
  if (!ui.camOn) return;
  var live = !!cam.stream || cam.busy;
  ui.camOn.set(live ? 'on' : 'off');
  var name = cam.facing === 'user' ? 'Front' : 'Back';
  ui.camOn.txt.textContent = live ? name : 'On';
  ui.camOn.b.setAttribute('aria-label', live ? name + ' camera: tap for the ' + (cam.facing === 'user' ? 'back' : 'front') + ', hold to turn off' : 'Camera on');
  drawPad();
}

function clearScreen() {
  buffers.forEach(clearFBO);
  ringWriteIndex = 0;
  lastWritten = buffers[0];
}

// After a layout change the render size can flip (720 x 1280 <-> 1280 x 720): replace the ring buffers at the new size.
function resizeTargets() {
  buffers.forEach(function (b) { gl.deleteFramebuffer(b.fbo); gl.deleteTexture(b.tex); });
  buffers = createRingBuffers(2);
  clearScreen();
}

// Day / night colour scheme: the Style Lab (lab.js) owns the two looks and listens through window.onSchemeChange.
// Night is the standard; Day is Favourite 17 tuned 2, and Night is Day with its own colours, texture and nameplates.
// The key names (and wears the colours of) the scheme it switches to.
var scheme = 'night';
function syncScheme() {
  if (!ui.scheme) return;
  ui.scheme.txt.textContent = scheme === 'day' ? 'Night' : 'Day';
  ui.scheme.b.setAttribute('aria-label', scheme === 'day' ? 'Switch to the night scheme' : 'Switch to the day scheme');
}
function toggleScheme() {
  scheme = scheme === 'day' ? 'night' : 'day';
  syncScheme();
  if (window.onSchemeChange) window.onSchemeChange(scheme);
}

// Presets: saved states of every knob, the mixer and Chromakey on/off (camera on/off is left alone), each with a small
// picture of the output when it was saved, kept in localStorage (newest first, up to PRESETS_MAX). The Presets key
// opens a translucent window over the output listing them: tap one to recall it, × on a card to delete it, × in the
// corner (or Escape) to close. While the window is open the key reads Save and saves the current state as a new preset.
var PRESETS_STORE = 'vfv-presets-v1', PRESETS_MAX = 24, presetsOpen = false, presetsActive = '';
function loadPresets() {
  var list = null;
  try { list = JSON.parse(localStorage.getItem(PRESETS_STORE) || 'null'); } catch (e) { list = null; }
  if (Array.isArray(list)) return list;
  list = [];
  try {   // the single preset slot before 2026-10-16, whose Blend Mode numbers predate Darken
    var old = JSON.parse(localStorage.getItem('vfv-preset-v1') || 'null');
    if (old && old.params) {
      var p = Object.assign({}, old.params);
      if (typeof p.blendMode === 'number') p.blendMode += 1;
      list.push({ id: 'p' + (old.t || 0).toString(36), name: 'Preset 1', t: old.t || Date.now(), params: p, thumb: '' });
    }
  } catch (e) { /* nothing to carry over */ }
  return list;
}
function storePresets(list) { try { localStorage.setItem(PRESETS_STORE, JSON.stringify(list)); return true; } catch (e) { return false; } }
// The output now, about 120 px on its long side. The drawing buffer isn't preserved, so draw and read in one task.
function presetThumb() {
  if (contextLost) return '';
  renderDisplayPass();
  var c = document.createElement('canvas'), k = 120 / Math.max(CW, CH);
  c.width = Math.round(CW * k); c.height = Math.round(CH * k);
  c.getContext('2d').drawImage(glCanvas, 0, 0, c.width, c.height);
  try { return c.toDataURL('image/jpeg', 0.75); } catch (e) { return ''; }
}
// Presets / Output: opens the presets window, and while it is open names the output it returns to (the window has its
// own Save button).
function presetsKey() {
  if (!presetsOpen) { presetsOpen = true; syncPresetsKey(); renderPresets(); return; }
  closePresets();
}
function closePresets() { presetsOpen = false; syncPresetsKey(); renderPresets(); }
function syncPresetsKey() {
  if (!ui.presets) return;
  ui.presets.txt.textContent = presetsOpen ? 'Output' : 'Presets';
  ui.presets.b.setAttribute('aria-label', presetsOpen ? 'Output: close the presets window' : 'Open presets');
}
function savePresetNew() {
  var list = loadPresets();
  if (list.length >= PRESETS_MAX) { flash(ui.presets); flashTip(ui.presets.b, 'Presets full: delete one first'); return; }
  var n = list.reduce(function (m, p) { var d = /(\d+)$/.exec(p.name || ''); return Math.max(m, d ? +d[1] : 0); }, 0) + 1;
  var p = { id: 'p' + Date.now().toString(36), name: 'Preset ' + n, t: Date.now(), params: Object.assign({}, params), thumb: presetThumb() };
  list.unshift(p);
  if (!storePresets(list)) { p.thumb = ''; if (!storePresets(list)) { flash(ui.presets); flashTip(ui.presets.b, 'Could not save'); return; } }
  presetsActive = p.id;
  flashTip(ui.presets.b, p.name + ' saved');
  renderPresets();
}
function recallPresetById(id) {
  var p = loadPresets().filter(function (x) { return x.id === id; })[0];
  if (!p || !p.params) return;
  // Values saved before a knob's range was narrowed are brought inside it.
  Object.keys(params).forEach(function (k) { if (k in p.params) params[k] = PD[k] && typeof p.params[k] === 'number' ? clamp(p.params[k], PD[k].min, PD[k].max) : p.params[k]; });
  syncUI();
  presetsActive = id;
  renderPresets();
}
function deletePreset(id) {
  var list = loadPresets(), p = list.filter(function (x) { return x.id === id; })[0];
  if (!p || !window.confirm('Delete ' + p.name + '?')) return;
  storePresets(list.filter(function (x) { return x.id !== id; }));
  renderPresets();
}
// The window lives inside the screen (rebuilt with the panel), below the Lab key. Its controls are sized in device
// pixels (dp), not stage pixels, so they stay large on a phone where the stage is scaled down: 44 px Save and close
// buttons, 36 px delete buttons, 14-18 px text, and as many columns as fit cards about 110 px wide (2 to 5).
var presetsScale = 0;
function renderPresets() {
  var keep = ui.presetWin ? ui.presetWin.querySelector('.presets-grid').scrollTop : 0;
  if (ui.presetWin) { ui.presetWin.remove(); ui.presetWin = null; }
  if (!presetsOpen || !ui.screen) return;
  var k = stageScale(); presetsScale = k;
  var dp = function (px) { return px / k; }, list = loadPresets(), top = 40 * UK;
  var cols = Math.max(2, Math.min(5, Math.floor((ui.screen.clientWidth - 20 - dp(24)) * k / 110)));
  var btn = 'font:inherit;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;line-height:1;border:none;cursor:pointer;touch-action:manipulation;' +
    'flex:none;display:flex;align-items:center;justify-content:center;border-radius:' + dp(6) + 'px;';
  var w = el('div', 'position:absolute;left:10px;right:10px;top:' + top + 'px;bottom:10px;z-index:3;display:flex;flex-direction:column;box-sizing:border-box;padding:' + dp(12) + 'px;' +
    'border-radius:' + dp(8) + 'px;background:rgba(12,12,15,0.6);-webkit-backdrop-filter:blur(7px) saturate(1.2);backdrop-filter:blur(7px) saturate(1.2);' +
    'box-shadow:0 0 0 1px rgba(255,255,255,0.14),0 10px 30px rgba(0,0,0,0.45);color:#ebebeb;font-family:inherit', ui.screen);
  w.className = 'presets'; w.setAttribute('role', 'dialog'); w.setAttribute('aria-label', 'Presets');
  w.addEventListener('dblclick', function (e) { e.stopPropagation(); });   // the screen's double-click is fullscreen
  ui.presetWin = w;
  var hd = el('div', 'display:flex;align-items:center;gap:' + dp(10) + 'px;margin-bottom:' + dp(12) + 'px', w);
  el('span', 'flex:1;font-size:' + dp(18) + 'px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase', hd, 'Presets');
  var sv = el('button', btn + 'height:' + dp(44) + 'px;padding:0 ' + dp(18) + 'px;font-size:' + dp(15) + 'px;color:#19181a;background:' + P.accent + ';box-shadow:0 0 ' + dp(10) + 'px ' + P.accentGlow, hd, 'Save');
  sv.setAttribute('aria-label', 'Save the current settings as a new preset'); sv.addEventListener('click', savePresetNew);
  var x = el('button', btn + 'width:' + dp(44) + 'px;height:' + dp(44) + 'px;font-size:' + dp(24) + 'px;color:#ebebeb;background:rgba(255,255,255,0.14)', hd, '×');
  x.setAttribute('aria-label', 'Close presets'); x.addEventListener('click', closePresets);
  var grid = el('div', 'flex:1;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;display:grid;grid-template-columns:repeat(' + cols + ',minmax(0,1fr));grid-auto-rows:max-content;gap:' + dp(10) + 'px;align-content:start', w);
  grid.className = 'presets-grid';
  if (!list.length) el('div', 'grid-column:1/-1;font-size:' + dp(15) + 'px;line-height:1.45;color:rgba(235,235,235,0.8);padding:' + dp(8) + 'px 2px', grid,
    'No presets yet. Save keeps every knob, the mixer and Chromakey on/off as a preset with a picture of the output.');
  list.forEach(function (p) {
    var on = p.id === presetsActive, d = new Date(p.t), z = function (v) { return (v < 10 ? '0' : '') + v; };
    var card = el('div', 'position:relative;cursor:pointer;border-radius:' + dp(6) + 'px;overflow:hidden;background:rgba(0,0,0,0.45);touch-action:manipulation;box-shadow:0 0 0 ' +
      (on ? dp(2.5) + 'px ' + P.accent + ',0 0 ' + dp(12) + 'px ' + P.accentGlow : '1px rgba(255,255,255,0.14)'), grid);
    card.setAttribute('role', 'button'); card.setAttribute('aria-label', 'Recall ' + p.name); card.tabIndex = 0;
    var pic = el('div', 'height:0;padding-top:' + (CH / CW * 100).toFixed(2) + '%;background:#000 center/cover no-repeat' + (p.thumb ? ' url(' + p.thumb + ')' : ''), card);
    if (!p.thumb) pic.style.background = 'linear-gradient(135deg,#222026,#0b0b0c)';
    var cap = el('div', 'padding:' + dp(7) + 'px ' + dp(8) + 'px;line-height:1.25;white-space:nowrap;overflow:hidden', card);
    el('div', 'font-size:' + dp(15) + 'px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis' + (on ? ';color:' + P.accent : ''), cap, p.name);
    el('div', 'font-size:' + dp(13) + 'px;color:rgba(235,235,235,0.65)', cap, z(d.getMonth() + 1) + '/' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()));
    var del = el('button', btn + 'position:absolute;right:' + dp(4) + 'px;top:' + dp(4) + 'px;width:' + dp(36) + 'px;height:' + dp(36) + 'px;font-size:' + dp(22) + 'px;color:#ebebeb;background:rgba(0,0,0,0.6)', card, '×');
    del.setAttribute('aria-label', 'Delete ' + p.name);
    del.addEventListener('click', function (e) { e.stopPropagation(); deletePreset(p.id); });
    card.addEventListener('click', function () { recallPresetById(p.id); });
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); recallPresetById(p.id); } });
  });
  grid.scrollTop = keep;
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && presetsOpen && !pseudoFs) closePresets(); });

// Fullscreen. The Fullscreen API where the browser allows it for elements (desktop, Android, iPad). iPhone Safari only
// allows it for <video>, so there, or if the request is refused, the canvas moves into an overlay covering the page
// (outside the scaled stage, whose transform would otherwise trap position:fixed). Tapping the overlay shows its exit
// button for 3 s; Escape and the Full key also exit.
var fsView = null, pseudoFs = false;
function currentFullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
function toggleFullscreen() {
  if (pseudoFs) return exitPseudoFullscreen();
  if (currentFullscreenElement()) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  var s = ui.screen, req = s.requestFullscreen || s.webkitRequestFullscreen;
  if (!req || document.fullscreenEnabled === false || (document.fullscreenEnabled == null && !document.webkitFullscreenEnabled)) return enterPseudoFullscreen();
  try {
    var p = req.call(s, { navigationUI: 'hide' });
    if (p && p.then) p.catch(enterPseudoFullscreen);
    else setTimeout(function () { if (!currentFullscreenElement() && !pseudoFs) enterPseudoFullscreen(); }, 1000);   // prefixed: no promise
  } catch (e) { enterPseudoFullscreen(); }
}
function showFsExit() {
  fsView.classList.add('show-exit');
  clearTimeout(fsView.t); fsView.t = setTimeout(function () { fsView.classList.remove('show-exit'); }, 3000);
}
function enterPseudoFullscreen() {
  if (pseudoFs) return;
  if (!fsView) {
    fsView = document.createElement('div'); fsView.id = 'fsview';
    fsView.setAttribute('aria-label', 'Video feedback output, full screen');
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'fs-exit'; x.textContent = '✕'; x.setAttribute('aria-label', 'Exit full screen');
    x.addEventListener('click', function (e) { e.stopPropagation(); exitPseudoFullscreen(); });
    fsView.appendChild(x);
    fsView.addEventListener('click', showFsExit);
    document.body.appendChild(fsView);
  }
  pseudoFs = true;
  fsView.insertBefore(glCanvas, fsView.firstChild);
  fsView.style.display = 'block';
  showFsExit();
  syncFullscreen();
}
function exitPseudoFullscreen() {
  if (!pseudoFs) return;
  pseudoFs = false;
  fsView.style.display = 'none';
  if (ui.screen) ui.screen.appendChild(glCanvas);
  syncFullscreen();
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pseudoFs) exitPseudoFullscreen(); });
function syncFullscreen() { fit(); }
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);

// Record: the output canvas at its full render resolution (720 x 1280 or 1280 x 720), H.264 in an .mp4 at a constant
// 60 fps, saved through the browser's download (the Downloads folder). Every frame the loop renders is encoded with
// the timestamp n / 60 s, so the file plays at the designed speed whatever the display's refresh rate or jitter.
// WebCodecs VideoEncoder + mp4-muxer (vendor/) where available; otherwise MediaRecorder on canvas.captureStream (an
// .mp4 when the browser can record H.264, else .webm). The muxer streams into Blob parts, which the browser may keep
// on disk, so long takes don't sit in JS memory. The take ends and saves if the render size changes (a rotation).
var rec = null;
var REC_FPS = 60, REC_GOP = 2 * REC_FPS;
function recBitrate(w, h) { return Math.round(Math.min(50e6, w * h * REC_FPS * 0.32)); }   // ~17.7 Mbps at 720p60
// While Freeze is on (and nothing is recording) the key is Capture: it saves the frozen output as a PNG at the full
// render resolution. A take already running when Freeze goes on keeps its Stop key.
function syncRec() {
  if (!ui.rec) return;
  var cap = !rec && frozen;
  ui.rec.set(rec ? (rec.saving ? 'sel' : 'rec') : cap ? null : 'off');
  ui.rec.txt.textContent = rec ? (rec.saving ? 'Saving' : 'Stop') : cap ? 'Capture' : 'Record';
  ui.rec.b.dataset.rec = rec && !rec.saving ? '1' : '';   // the text pulses a soft glow while recording (style.css)
  ui.rec.b.setAttribute('aria-label', rec ? 'Stop recording and save' : cap ? 'Capture the output as an image' : 'Record the output to a video file');
}
function toggleRecording() {
  if (rec) { if (!rec.saving) rec.stop(); return; }
  if (frozen) return captureImage();
  startRecording().catch(function (e) { REPORT.push('REC ' + (e && e.message || e)); rec = null; syncRec(); flash(ui.rec); });
}
// The drawing buffer isn't preserved, so draw the display pass and read it back in the same task.
function captureImage() {
  if (contextLost) { flash(ui.rec); return; }
  renderDisplayPass();
  glCanvas.toBlob(function (blob) {
    if (!blob) { REPORT.push('CAPTURE failed'); flash(ui.rec); return; }
    saveBlob(blob, recFileName('png'));
    flashTip(ui.rec.b, 'Image saved');
  }, 'image/png');
  ui.rec.set('on'); setTimeout(function () { if (ui.rec) syncRec(); }, 300);
}
function recFileName(ext) {
  var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
  return 'feedback-' + d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()) + '.' + ext;
}
function saveBlob(blob, name) {
  var a = document.createElement('a'), url = URL.createObjectURL(blob);
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  window.__lastRecording = { name: name, size: blob.size, type: blob.type, blob: blob };
}
// The muxer's output as Blob parts. Writes are mostly appends; the few that land earlier (header fix-ups at the end)
// are spliced in with Blob.slice. Pending parts fold into one Blob every 32 MB.
function BlobSink() {
  var blob = new Blob([]), parts = [], pend = 0, size = 0;
  function fold() { if (parts.length) { blob = new Blob([blob].concat(parts)); parts = []; pend = 0; } }
  return {
    write: function (data, pos) {
      var u = new Uint8Array(data);   // copy: the muxer may reuse its buffer
      if (pos === size) { parts.push(u); pend += u.length; size += u.length; if (pend > 32e6) fold(); return; }
      fold();
      var end = pos + u.length;
      blob = new Blob([blob.slice(0, Math.min(pos, size)), pos > size ? new Uint8Array(pos - size) : new Uint8Array(0), u, blob.slice(Math.min(end, size))]);
      size = Math.max(size, end);
    },
    blob: function (type) { fold(); return new Blob([blob], { type: type }); }
  };
}
function startRecording() {
  var w = glCanvas.width, h = glCanvas.height;
  if (window.VideoEncoder && window.VideoFrame && window.Mp4Muxer) {
    var cfgs = ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a'].map(function (codec) {   // High / Main / Baseline, level 4.2
      return { codec: codec, width: w, height: h, bitrate: recBitrate(w, h), bitrateMode: 'variable', framerate: REC_FPS, latencyMode: 'quality', avc: { format: 'avc' } };
    });
    var pick = function (i) {
      if (i >= cfgs.length) return Promise.resolve(null);
      return VideoEncoder.isConfigSupported(cfgs[i]).then(function (r) { return r.supported ? cfgs[i] : pick(i + 1); }, function () { return pick(i + 1); });
    };
    return pick(0).then(function (cfg) {
      if (rec) return;
      if (!cfg) return startMediaRecorder(w, h);
      rec = webCodecsRecorder(cfg); syncRec();
    });
  }
  return Promise.resolve().then(function () { if (!rec) startMediaRecorder(w, h); });
}
function webCodecsRecorder(cfg) {
  var sink = BlobSink(), n = 0, failed = null, started = false, drained = false;
  var muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.StreamTarget({ onData: sink.write, chunked: true, chunkSize: 4 * 1024 * 1024 }),
    video: { codec: 'avc', width: cfg.width, height: cfg.height, frameRate: REC_FPS },
    fastStart: false, firstTimestampBehavior: 'offset'
  });
  var enc = new VideoEncoder({
    output: function (chunk, meta) { started = true; muxer.addVideoChunk(chunk, meta); },
    error: function (e) { failed = e; REPORT.push('REC encoder ' + e.message); }
  });
  enc.configure(cfg);
  var r = {
    w: cfg.width, h: cfg.height, saving: false, frames: 0, dropped: 0, codec: cfg.codec,
    capture: function () {
      if (r.saving) return;
      if (failed || glCanvas.width !== r.w || glCanvas.height !== r.h) { r.stop(); return; }
      var ts = Math.round(n * 1e6 / REC_FPS);
      // Keep the frame grid even when the encoder falls behind: a skipped frame just holds the previous one longer.
      // Until the encoder has started and worked off its first backlog the queue may run deeper: a hardware encoder
      // can take ~0.3 s to produce its first frame.
      if (started && enc.encodeQueueSize <= 4) drained = true;
      if (enc.encodeQueueSize > (drained ? 12 : 45)) { n++; r.dropped++; return; }
      var vf = new VideoFrame(glCanvas, { timestamp: ts, duration: Math.round(1e6 / REC_FPS) });
      enc.encode(vf, { keyFrame: n % REC_GOP === 0 });
      vf.close();
      n++; r.frames++;
    },
    stop: function () {
      if (r.saving) return;
      r.saving = true; syncRec();
      var done = function () { rec = null; syncRec(); };
      (failed ? Promise.reject(failed) : enc.flush()).then(function () {
        enc.close();
        if (!r.frames) return done();
        muxer.finalize();
        saveBlob(sink.blob('video/mp4'), recFileName('mp4'));
        done();
      }).catch(function (e) {
        REPORT.push('REC ' + (e && e.message || e));
        try { enc.close(); } catch (x) { /* already closed */ }
        done(); flash(ui.rec);
      });
    }
  };
  return r;
}
function startMediaRecorder(w, h) {
  if (!window.MediaRecorder || !glCanvas.captureStream) throw new Error('recording not supported');
  var types = ['video/mp4;codecs=avc1.64002a', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm'];
  var type = types.filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0] || '';
  var stream = glCanvas.captureStream(REC_FPS), parts = [];
  var mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: recBitrate(w, h) });
  var track = stream.getVideoTracks()[0];
  mr.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
  mr.onstop = function () {
    var t = mr.mimeType || type || 'video/webm';
    if (parts.length) saveBlob(new Blob(parts, { type: t }), recFileName(/mp4/.test(t) ? 'mp4' : 'webm'));
    track.stop(); rec = null; syncRec();
  };
  mr.start(1000);
  rec = {
    w: w, h: h, saving: false, frames: 0, codec: type,
    capture: function () {
      if (r2.saving) return;
      if (glCanvas.width !== w || glCanvas.height !== h) { r2.stop(); return; }
      r2.frames++;
    },
    stop: function () { if (r2.saving) return; r2.saving = true; syncRec(); mr.stop(); }
  };
  var r2 = rec;
  syncRec();
}

// The visible area in layout pixels: the visual viewport (inside the browser bars on mobile) scaled back to zoom 1.
function viewSize() {
  var v = window.visualViewport;
  if (v && v.width > 0 && v.height > 0) return [v.width * v.scale, v.height * v.scale];
  return [window.innerWidth, window.innerHeight];
}
// Rebuild the panel when its layout key changes (window orientation, or a design-mode candidate / window shape), but
// not while the screen is fullscreen: rebuilding would drop the fullscreen element, so that waits for fullscreenchange.
function fit() {
  if (layoutKey() !== builtKey && !currentFullscreenElement()) build();
  scaleStage();
}
function scaleStage() {
  var v = viewSize(), k = Math.min(v[0] / SW, v[1] / SH);
  stage.dataset.scale = String(k);
  stage.style.transform = 'translate(' + ((v[0] - SW * k) / 2) + 'px,' + ((v[1] - SH * k) / 2) + 'px) scale(' + k + ')';
  if (presetsOpen && Math.abs(k - presetsScale) > 0.01) renderPresets();   // its controls are sized in device pixels
}
// While a window is being resized, rescale at once but rebuild (a design-mode layout follows the window's shape, so
// every size step would otherwise rebuild the whole panel) only once the resizing pauses.
var fitTimer = 0;
function onResize() { scaleStage(); clearTimeout(fitTimer); fitTimer = setTimeout(fit, 120); }
window.addEventListener('resize', onResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
window.addEventListener('orientationchange', function () { fit(); setTimeout(fit, 400); });
window.addEventListener('pageshow', fit);
document.addEventListener('gesturestart', function (e) { e.preventDefault(); });   // iOS pinch-zoom
fit();

// Self-test / screenshot hook (index.html#shot): headless Chrome only fires a few animation frames, so pump the
// feedback loop directly, then report.
// Parameters can be overridden in the hash, e.g. #shot&feedback=0&mixX=1.
if (location.hash.indexOf('#shot') === 0) {
  location.hash.slice(1).split('&').slice(1).forEach(function (kv) { var p = kv.split('='); if (p[0] in params) params[p[0]] = typeof params[p[0]] === 'string' ? decodeURIComponent(p[1]) : parseFloat(p[1]); });
  syncUI();
  var n = 0;
  for (; n < 150; n++) { simTime += 1 / 60; renderFeedbackPass(simTime); }
  renderDisplayPass();
  document.getElementById('__report').textContent = JSON.stringify({
    knobs: document.querySelectorAll('[role="slider"]').length, buttons: document.querySelectorAll('button').length,
    glError: gl.getError(), frames: n, errors: REPORT
  });
} else if (location.hash.indexOf('#bench') === 0) {
  // Benchmark hook (index.html#bench): ms per frame for the feedback + display passes under several settings, GPU memory
  // for the feedback history, uniform-upload CPU cost, and an output fingerprint (hash of every pixel after 60
  // deterministic frames) so optimizations can be checked for identical output.
  (function () {
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    var out = { gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?', res: CW + 'x' + CH, slotsAtStart: buffers.length, ms: {}, hash: {} };
    var px1 = new Uint8Array(4), all = new Uint8Array(CW * CH * 4);
    var sync = function () { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1); };
    var configs = { default: {}, hueOff: { hueDrift: 0 }, noise: { mixX: 0, mixY: 0 }, allLayers: { mixX: 0.5, mixY: 0.5 },
                    keyModulate: { chromakeyEnabled: true, modulateAmount: 0.5 }, delay5: { delay: 5 } };
    var run = function (setup, n) {
      Object.assign(params, DEFAULTS, setup); syncUI(); clearScreen(); simTime = 0;
      for (var i = 0; i < n; i++) { simTime += 1 / 60; renderFeedbackPass(simTime); }
    };
    Object.keys(configs).forEach(function (k) {
      run(configs[k], 60);
      renderDisplayPass();   // the slots may be half-float, so hash the 8-bit canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, CW, CH, gl.RGBA, gl.UNSIGNED_BYTE, all);
      var h = 2166136261; for (var i = 0; i < all.length; i += 7) h = Math.imul(h ^ all[i], 16777619) >>> 0;
      out.hash[k] = h.toString(16);
      sync();
      var t0 = performance.now(), n = 0;
      do { for (var j = 0; j < 10; j++) { simTime += 1 / 60; renderFeedbackPass(simTime); renderDisplayPass(); } n += 10; sync(); } while (performance.now() - t0 < 300);
      sync();
      out.ms[k] = +((performance.now() - t0) / n).toFixed(3);
    });
    sync();
    var t1 = performance.now();
    for (var d = 0; d < 20; d++) renderDisplayPass();
    sync(); out.displayMs = +((performance.now() - t1) / 20).toFixed(2);
    gl.useProgram(feedbackProgram);
    var t2 = performance.now();
    for (var u = 0; u < 5000; u++) uploadFeedbackUniforms(u);
    out.uniformUs = +((performance.now() - t2) / 5000 * 1000).toFixed(2);
    // Main-thread costs: Mix pad redraw and a full panel rebuild.
    var avg = function (n, f) { var t = performance.now(); for (var i = 0; i < n; i++) f(i); return +((performance.now() - t) / n).toFixed(3); };
    out.padMs = avg(200, function (i) { params.mixX = (i % 50) / 50; drawPad(); });
    out.buildMs = avg(20, function () { build(); });
    out.historyMB = +(buffers.length * CW * CH * 4 / 1048576).toFixed(1);
    out.slots = buffers.length;
    out.glError = gl.getError(); out.errors = REPORT;
    document.getElementById('__report').textContent = JSON.stringify(out);
  })();
} else if (location.hash.indexOf('#rectest') === 0) {
  // Recording self-test (index.html#rectest): 180 frames (3 s) through the recorder, then the saved file's size, MP4
  // box layout, sample count, and what a <video> element decodes from it (duration, size, a non-black frame).
  (function () {
    var out = { res: CW + 'x' + CH, VideoEncoder: !!window.VideoEncoder, muxer: !!window.Mp4Muxer };
    var fin = function () { out.errors = REPORT; document.getElementById('__report').textContent = JSON.stringify(out); };
    var N = 180, i = 0;
    Object.assign(params, DEFAULTS, { mixX: 0.5, mixY: 0.5 }); syncUI(); clearScreen();
    var t0;
    startRecording().then(function () {
      out.codec = rec && rec.codec; t0 = performance.now();
      (function step() {
        // Real-time pacing (one frame per 1/60 s), as the render loop would feed it.
        while (i < N && performance.now() - t0 >= i * FRAME_MS) { simTime += 1 / 60; renderFeedbackPass(simTime); renderDisplayPass(); rec.capture(); i++; }
        if (i < N) return setTimeout(step, 2);
        out.captureMs = +(performance.now() - t0).toFixed(0); out.frames = rec.frames; out.dropped = rec.dropped;
        rec.stop();
        (function wait() {
          if (rec) return setTimeout(wait, 20);
          var f = window.__lastRecording;
          if (!f) { out.file = null; return fin(); }
          out.file = { name: f.name, type: f.type, bytes: f.size };
          f.blob.arrayBuffer().then(function (ab) {
            var dv = new DataView(ab), u8 = new Uint8Array(ab), boxes = [], p = 0;
            while (p + 8 <= ab.byteLength && boxes.length < 20) {
              var sz = dv.getUint32(p), ty = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
              if (sz === 1) sz = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12);
              boxes.push(ty + ':' + sz); if (sz < 8) break; p += sz;
            }
            out.boxes = boxes; out.boxesCoverFile = p === ab.byteLength;
            var find = function (tag) { for (var q = 0; q < u8.length - 4; q++) if (u8[q] === tag.charCodeAt(0) && u8[q + 1] === tag.charCodeAt(1) && u8[q + 2] === tag.charCodeAt(2) && u8[q + 3] === tag.charCodeAt(3)) return q; return -1; };
            var a = find('avcC'); out.avcC = a > 0 ? 'profile ' + u8[a + 5] + ' level ' + u8[a + 7] : 'missing';
            var s = find('stsz'); if (s > 0) out.samples = dv.getUint32(s + 12);
            var v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(f.blob);
            v.onerror = function () { out.decode = 'error ' + (v.error && v.error.code); fin(); };
            v.onloadedmetadata = function () {
              out.decode = { duration: +v.duration.toFixed(3), w: v.videoWidth, h: v.videoHeight };
              v.onseeked = function () {
                var c = document.createElement('canvas'); c.width = 64; c.height = 64;
                var x = c.getContext('2d'); x.drawImage(v, 0, 0, 64, 64);
                var d = x.getImageData(0, 0, 64, 64).data, sum = 0; for (var j = 0; j < d.length; j += 4) sum += d[j] + d[j + 1] + d[j + 2];
                out.decode.meanAt2s = +(sum / (64 * 64 * 3)).toFixed(1); fin();
              };
              v.currentTime = 2;
            };
          }).catch(function (e) { out.parseError = String(e); fin(); });
        })();
      })();
    }).catch(function (e) { out.startError = String(e && e.message || e); fin(); });
  })();
} else {
  requestAnimationFrame(function (now) { lastNow = now; requestAnimationFrame(frame); });
}
