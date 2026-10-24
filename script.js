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
  tip.textContent = text;
  tip.style.display = 'block';
  tip.style.left = ((r.left + r.width / 2 - s.left) / k) + 'px';
  tip.style.top = ((r.top - s.top) / k - 24) + 'px';
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
  brightness: { min: -1 / 3, max: 1 / 3, def: 0, step: 0.005, snap: 0, f: function (v) { return sgn(v, 2); } },
  contrast: { min: 0, max: 2, def: 1.03, step: 0.005, snap: 1, f: function (v) { return v.toFixed(2) + '×'; } },
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
// Colors EQ (Advanced page): seven bands, each a gain (eqGn, 0-2x saturation, 1 = unchanged), a centre hue (eqHn,
// degrees) and a width (eqWn, degrees: the bell's standard deviation). eqWsel stands in for the selected band's width
// on the single Width knob of the Spectrum and Wheel styles. eqStyle (localStorage 'vfv-eq-style') picks how the
// window looks: see buildColorsEq.
var EQ_N = 7, EQ_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta'], EQ_HUES = [0, 30, 60, 120, 180, 240, 300];
var EQ_STYLES = ['Console', 'Spectrum', 'Rainbow', 'Wheel', 'Encoders', 'Keys', 'Dots', 'Dials', 'Bloom', 'Levels', 'Pads', 'Seven'], eqStyle = 0, eqSel = 0;
// Modulation window layouts (localStorage 'vfv-mod-style'): see buildLfo.
var LFO_STYLES = ['Rows', 'Columns', 'Grid', 'Matrix'], lfoStyle = 0;
try { lfoStyle = Math.max(0, Math.min(3, parseInt(localStorage.getItem('vfv-mod-style'), 10) || 0)); } catch (e) { /* Rows */ }
try { eqStyle = Math.max(0, Math.min(EQ_STYLES.length - 1, parseInt(localStorage.getItem('vfv-eq-style'), 10) || 0)); } catch (e) { /* Console */ }
var EQ_WIDTH = { min: 6, max: 120, def: 22, zero: 22, log: true, step: 0.5, f: function (v) { return '±' + Math.round(v) + '°'; } };
for (q = 0; q < EQ_N; q++) { PD['eqH' + q] = { min: 0, max: 360, def: EQ_HUES[q], zero: EQ_HUES[q], step: 1, f: deg }; PD['eqW' + q] = EQ_WIDTH; }
PD.eqWsel = EQ_WIDTH;
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

// Controls by id: [label, knob options]. 'camera' and 'keyOn' are key clusters, not knobs.
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
// The Advanced page (experimental): the Colors hue EQ along the whole bottom; above it on the right, the LFO window
// (four oscillators over their four target keys, in the green Chromakey family colours) and the Mix window (the XY
// pad, in the purple Transform family colours). The Main / Advanced tab at the top right of the screen switches; the
// choice is kept. pickLfo >= 0 while the Main page is open to pick that LFO's target.
var page = 'main';
try { if (localStorage.getItem('vfv-page') === 'adv') page = 'adv'; } catch (e) { /* main */ }
var pickLfo = -1;
function setPage(p) {
  page = p === 'adv' ? 'adv' : 'main';
  if (page === 'adv') pickLfo = -1;
  try { localStorage.setItem('vfv-page', page); } catch (e) { /* not kept */ }
  build(); scaleStage();
}
// Main / Advanced tabs at the top right of the screen (the Lab key is top left).
function makeTabs() {
  var h = 22 * UK, f = 9 * UL, x = ui.bezel[0] + ui.bezel[2] - 14, y = ui.bezel[1] + 14;
  ui.tabs = [['adv', 'Advanced'], ['main', 'Main']].map(function (t) {
    var w = textW(t[1], f, 700, 0.08) + 18 * UL;
    x -= w;
    var k = key(x, y, w, h, t[1], null, { fs: f, aria: t[1] + ' page', onClick: function () { if (page !== t[0]) setPage(t[0]); } });
    var on = page === t[0];
    k.b.style.zIndex = '5'; k.b.setAttribute('aria-pressed', on ? 'true' : 'false');
    k.txt.style.color = on ? P.accent : P.inkMute; k.txt.style.textShadow = on ? '0 0 6px ' + P.accentGlow : 'none';
    x -= 4;
    return k;
  });
}

// The WebGL canvas outlives layout rebuilds (its context, programs and camera texture stay); only its size changes.
var glCanvas = document.createElement('canvas');
glCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';

// Screen: a bezel holding the WebGL canvas, no text. Double-click for fullscreen.
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
// Header keys: Day/Night, Full, Freeze, Presets (Save while the presets window is open), Record (Capture while frozen)
// in the NKEYS rects [x, y, w, h].
// The label size shrinks from fs if the longest label the keys can show would not fit the key width. Class hk marks
// them for the Style Lab, which colours them to the background (the Day/Night key in the other scheme's colours, the
// Record key red).
var NKEYS = 5, KEY_LABELS = ['Night', 'Day', 'Full', 'Freeze', 'Presets', 'Save', 'Record', 'Capture', 'Stop', 'Saving'];
function makeKeys(r, fs) {
  fs = fs || 10;
  var widest = Math.max.apply(null, KEY_LABELS.map(function (t) { return textW(t.toUpperCase(), fs, 700, 0.08); }));
  fs = Math.min(fs, Math.floor(fs * (r[0][2] - 10) / widest * 10) / 10);
  var K = function (i, label, led, o, cls) { o.fs = fs; var k = key(r[i][0], r[i][1], r[i][2], r[i][3], label, led, o); k.b.className += ' hk' + (cls ? ' ' + cls : ''); return k; };
  ui.scheme = K(0, 'Day', null, { aria: 'Day / night colour scheme', onClick: toggleScheme }, 'hk-scheme');
  ui.full = K(1, 'Full', 'off', { noLed: true, aria: 'Fullscreen', onClick: toggleFullscreen });
  ui.freeze = K(2, 'Freeze', 'off', { tint: 'blue', aria: 'Freeze the feedback loop', onClick: function () { frozen = !frozen; ui.freeze.set(frozen ? 'on' : 'off'); syncRec(); } });
  ui.presets = K(3, 'Presets', null, { aria: 'Presets', onClick: presetsKey });
  ui.rec = K(4, 'Record', 'off', { noLed: true, aria: 'Record the output to a video file', onClick: toggleRecording }, 'hk-rec');
  // Full: the label inside segmented corner brackets, like a fullscreen glyph.
  var bl = Math.round(fs * 0.5) + 'px', bt = Math.max(1.5, Math.round(fs * 0.12 * 2) / 2) + 'px', bg = 'linear-gradient(currentColor,currentColor) ';
  ui.full.txt.style.cssText = 'padding:' + Math.round(fs * 0.25) + 'px ' + Math.round(fs * 0.45) + 'px;line-height:1;background:' +
    ['left top', 'right top', 'left bottom', 'right bottom'].map(function (p) { return bg + p + '/' + bl + ' ' + bt + ' no-repeat,' + bg + p + '/' + bt + ' ' + bl + ' no-repeat'; }).join(',');
  ui.freeze.set(frozen ? 'on' : 'off'); ui.full.set(pseudoFs ? 'on' : 'off'); syncScheme(); syncRec(); syncPresetsKey(); renderPresets();
  makeTabs();   // here, once the layout has set its control scale
}
// Camera cluster centred on (cx, cy): a tall On key on the left, Back over Front on the right, label below.
function makeCamera(cx, cy, fam) {
  var k = UK, bw = 104 * k, g = 4 * k, cw = (bw - g) / 2, top = cy - 30 * k, h = 52 * k, hh = (h - g) / 2, bx = cx - bw / 2;
  ui.camOn = key(bx, top, cw, h, 'On', 'off', { aria: 'Camera on', onClick: function () { if (cam.stream || cam.busy) stopCamera(); else startCamera(cam.facing); } });
  ui.camFacing = ['user', 'environment'].map(function (f, i) {
    return key(bx + cw + g, i ? top : top + hh + g, cw, hh, i ? 'Back' : 'Front', 'off', { fs: 9 * UL, aria: (i ? 'Back' : 'Front') + ' camera', onClick: function () { startCamera(f); } });
  });
  var lab = cl(cx, cy + 35 + 20 * (k - 1), 120 * UL, 'Camera', LABEL()); lab.className = 'knob-label'; if (fam) lab.dataset.fam = fam;
  syncCam();
}
// On / Off key for boolean params[param] centred on (cx, cy), no label: the key names the state and glows softly while
// on (Chromakey; Luma Key on the Advanced page).
function makeOnOff(cx, cy, param, aria) {
  var k = key(cx - 36 * UK, cy - 14 * UK, 72 * UK, 28 * UK, 'Off', null, { aria: aria, onClick: function () { params[param] = !params[param]; syncKeyOn(); } });
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
  if (id === 'camera') return { w: Math.max(104 * UK, lw('Camera')), top: 30 * UK, bot: 35 + 20 * (UK - 1) + lab };
  if (id === 'keyOn') return { w: 72 * UK, top: 14 * UK, bot: 14 * UK };
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
  secBox(mix, 'Mix', 'transform');
  var tab = 9 * UL, s = Math.min(mix[2] - 2 * m, mix[3] - tab - 2 * m);
  makePad(mix[0] + (mix[2] - s) / 2, mix[1] + tab + m + (mix[3] - tab - 2 * m - s) / 2, s);
}

// Colors EQ (Advanced page): a seven-band parametric EQ on saturation around the hue spectrum. Each band has a gain on a
// vertical slider (0-2x, 1 = unchanged), a centre hue and a width. The saturation multiplier at a hue is 1 plus every
// band's (gain - 1) times its bell (a Gaussian of the hue distance over the width), clamped at 0; the shader (hueEq)
// applies the same sum at each pixel's hue after Saturation, skipped while every gain is 1. Keys on the window's top
// edge (inside it when they don't fit) step through twelve styles, and Flat sets every gain back to 1:
// 1 Console: per band a colour chip, a fader whose cap carries the band's hue, and Hue (its scale is the spectrum) and
//   Width knobs.
// 2 Spectrum: one glass screen; each band is a slider track standing on the spectrum at its hue under the response
//   curve. Drag a cap up or down for gain, sideways to move its hue; the wheel, or the Width knob (for the band last
//   touched), sets its width.
// 3 Rainbow: Hue and Width knobs over faders whose wide tracks run from grey through the band's hue to full colour.
// 4 Wheel: a polar screen (hue around the ring, gain outwards) beside thin faders. Drag a band's dot around for hue
//   and in or out for gain; the Width knob sets the band last touched.
// 5-12: after the OP-1, see eqOpEncoders and the styles below it.
// Every fader snaps to 1x at its centre line, double-click returns 1x, and the wheel and arrow keys nudge it.
function eqHueCss(i, l, sat) { return 'hsl(' + Math.round(params['eqH' + i]) + ',' + (sat == null ? 90 : sat) + '%,' + (l == null ? 56 : l) + '%)'; }
function eqHd(a, b) { return Math.abs((((a - b) % 360) + 540) % 360 - 180); }
function eqAt(h) {
  var k = 1;
  for (var i = 0; i < EQ_N; i++) { var d = eqHd(h, params['eqH' + i]) / params['eqW' + i]; k += (params['eqG' + i] - 1) * Math.exp(-0.5 * d * d); }
  return Math.max(0, k);
}
function eqActive() { for (var i = 0; i < EQ_N; i++) if (params['eqG' + i] !== 1) return true; return false; }
function eqRefresh() { (ui.eqParts || []).forEach(function (f) { f(); }); }
function eqSelect(i) { eqSel = i; params.eqWsel = params['eqW' + i]; if (ui.eqWknob) ui.eqWknob.sync(); eqRefresh(); }
function eqSetGain(i, g) { g = clamp(g, 0, 2); if (Math.abs(g - 1) < 0.05) g = 1; params['eqG' + i] = Math.round(g * 100) / 100; }
function eqTipText(i) { return EQ_NAMES[i] + '  ' + params['eqG' + i].toFixed(2) + '×  ' + Math.round(params['eqH' + i]) % 360 + '°  ±' + Math.round(params['eqW' + i]) + '°'; }
function eqTip(target, i) { showTip(target, eqTipText(i)); }
// Style keys on a window's top edge, right of its nameplate (inside the window under the nameplate when they don't
// fit): the current style's name on a dark chip, keys 1..n with the current one lit (with more than six styles, the
// chip numbers the style and previous / next keys step through them), then any extra keys (e.g. Flat). pick(i) runs
// for a style; extra: [{ t, aria, click(key) }]. Returns { top: where the window's content can start, keys: the style
// keys (with the stepper, the chip stands in for each) }.
function frameKeys(b, m, title, names, cur, pick, extra) {
  extra = extra || [];
  var kh = 22 * UK, f = 9 * UL, gap = 4 * UK, keys = [], stepper = names.length > 6, nk = stepper ? 2 : names.length;
  var labels = (stepper ? ['◀', '▶'] : names.map(function (n, i) { return String(i + 1); })).concat(extra.map(function (e) { return e.t; }));
  var ws = labels.map(function (t) { return Math.max(kh * 1.2, textW(t, f, 700, 0.08) + 16 * UL); });
  var chipText = stepper ? (cur + 1) + ' ' + names[cur] : names[cur], nw = textW(chipText, f, 800, 0.12) + 14 * UL;
  var total = nw + 6 * UK + ws.reduce(function (a, v) { return a + v; }, 0) + gap * (labels.length - 1) + (extra.length ? 8 * UK : 0);
  var plate = (UL > 1 ? 8 : 12) + textW(title, 10 * UL, 800, UL > 1 ? 0.1 : 0.16) + 16 + 12;
  var onEdge = plate + total + 12 <= b[2];
  var ky = onEdge ? b[1] - kh / 2 : b[1] + 9 * UL + 6, x = b[0] + b[2] - (onEdge ? 10 : m) - total;
  var chip = el('span', at(x, ky, nw, kh) + ';box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:3px;background:#141316;' +
    PRINT(f, P.accent) + ';z-index:2', panel, chipText);
  if (stepper) keys = names.map(function () { return { b: chip }; });
  x += nw + 6 * UK;
  labels.forEach(function (t, i) {
    var st = i < nk, ex = extra[i - nk], n = names.length;
    if (i === nk) x += 8 * UK;
    var aria = !st ? ex.aria : stepper ? title + (i ? ' next style' : ' previous style') : title + ' style ' + t + ': ' + names[i];
    var k = key(x, ky, ws[i], kh, t, null, { fs: f, aria: aria, onClick: !st ? function () { ex.click(k); } : stepper ? function () { pick((cur + (i ? 1 : n - 1)) % n); } : function () { pick(i); } });
    k.b.style.zIndex = '2';
    if (st && !stepper) {
      var on = i === cur;
      k.b.setAttribute('aria-pressed', on ? 'true' : 'false'); k.txt.style.color = on ? P.accent : P.inkMute; k.txt.style.textShadow = on ? '0 0 6px ' + P.accentGlow : 'none';
      keys.push(k);
    }
    x += ws[i] + gap;
  });
  return { top: onEdge ? b[1] + 9 * UL + m * 0.6 : ky + kh + m * 0.6, keys: keys };
}
// Switch a window's style (kept under store) and rebuild, then name the style over its key.
function pickStyle(store, i, names, set, keysOf) {
  set(i);
  try { localStorage.setItem(store, String(i)); } catch (e) { /* not kept */ }
  build(); scaleStage();
  var k = keysOf(); if (k && k[i]) flashTip(k[i].b, 'Style ' + (i + 1) + ': ' + names[i]);
}
function buildColorsEq(b, m) {
  secBox(b, 'Colors EQ', 'layers');
  ui.eqParts = [];
  var fk = frameKeys(b, m, 'Colors EQ', EQ_STYLES, eqStyle, function (i) { pickStyle('vfv-eq-style', i, EQ_STYLES, function (v) { eqStyle = v; }, function () { return ui.eqKeys; }); },
    [{ t: 'Flat', aria: 'Flatten the EQ (every gain to 1x)', click: function (k) { for (var j = 0; j < EQ_N; j++) params['eqG' + j] = 1; eqRefresh(); flashTip(k.b, 'EQ flat'); } }]);
  ui.eqKeys = fk.keys;
  var C = [b[0] + m, fk.top, b[2] - 2 * m, b[1] + b[3] - m - fk.top];
  [function () { eqStrips(C, 'console'); }, function () { eqSpectrum(C); }, function () { eqStrips(C, 'rainbow'); }, function () { eqWheel(C); },
    eqOpEncoders, eqOpKeys, eqOpDots, eqOpDials, eqOpBloom, eqOpLevels, eqOpPads, eqOpSeven][eqStyle](C);
  syncers.push(eqRefresh);
  eqRefresh();
}
// A vertical gain fader for band i in [x, y, w, h]. look: 'console' (dark slot, a cap with a stripe in the band's
// hue), 'rainbow' (a wide track from grey through the band's hue to full colour, a white cap) or 'thin' (a narrow slot,
// a round cap in the band's hue). Ticks mark 0, 0.5, 1 (the centre line, longer), 1.5 and 2x.
function eqFader(x, y, w, h, i, look) {
  var t = el('div', at(x, y, w, h) + ';touch-action:none;cursor:ns-resize');
  t.setAttribute('role', 'slider'); t.tabIndex = 0; t.setAttribute('aria-label', EQ_NAMES[i] + ' saturation');
  var capH = look === 'thin' ? Math.min(w * 0.7, 18 * UK) : look === 'rainbow' ? Math.max(8, 10 * UK) : Math.max(12, Math.min(24 * UK, h * 0.14));
  var sw = look === 'rainbow' ? Math.min(w * 0.5, 26 * UK) : Math.max(4, (look === 'thin' ? 5 : 7) * UK), travel = h - capH;
  [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
    var c = v === 0.5, inset = c ? 4 : 22;
    el('div', 'position:absolute;left:' + inset + '%;right:' + inset + '%;height:' + (c ? 2 : 1) + 'px;top:' + (capH / 2 + (1 - v) * travel) + 'px;pointer-events:none;background:' +
      (c ? 'rgba(220,232,255,0.45)' : 'rgba(143,141,146,0.4)'), t);
  });
  var slot = el('div', 'position:absolute;left:50%;top:' + capH / 2 + 'px;bottom:' + capH / 2 + 'px;width:' + sw + 'px;margin-left:' + -sw / 2 + 'px;border-radius:' + sw / 2 + 'px;' +
    'background:#050406;box-shadow:inset 0 1px 3px rgba(0,0,0,0.9),0 1px 0 rgba(255,255,255,0.07);pointer-events:none', t);
  var cw = look === 'thin' ? capH : look === 'rainbow' ? sw + 10 * UK : Math.min(w * 0.82, 48 * UK);
  var cap = el('div', 'position:absolute;left:50%;width:' + cw + 'px;margin-left:' + -cw / 2 + 'px;height:' + capH + 'px;pointer-events:none;box-sizing:border-box;' +
    (look === 'thin' ? 'border-radius:50%;border:2px solid #0b0b0c' : look === 'rainbow' ? 'border-radius:3px;background:linear-gradient(#f4f4f6,#b9b8bd);box-shadow:0 0 0 1px #0b0b0c,0 2px 4px rgba(0,0,0,0.6)'
      : 'border-radius:3px;background:linear-gradient(#5d5b61,#2b2a2e);box-shadow:0 0 0 1px #0b0b0c,0 3px 6px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,255,255,0.15)'), t);
  var stripe = look === 'console' ? el('div', 'position:absolute;left:12%;right:12%;top:50%;height:' + Math.max(2, 3 * UK) + 'px;margin-top:' + -Math.max(1, 1.5 * UK) + 'px;border-radius:1px', cap) : null;
  ui.eqParts.push(function () {
    var g = params['eqG' + i], c = eqHueCss(i);
    cap.style.top = (1 - g / 2) * travel + 'px';
    if (stripe) { stripe.style.background = c; stripe.style.boxShadow = '0 0 5px ' + c; }
    if (look === 'thin') { cap.style.background = c; cap.style.boxShadow = '0 0 8px ' + eqHueCss(i, 50) + (i === eqSel ? ',0 0 0 2px #fff' : ''); }
    if (look === 'rainbow') slot.style.background = 'linear-gradient(to top,hsl(' + Math.round(params['eqH' + i]) + ',0%,42%),' + c + ' 50%,' + eqHueCss(i, 62, 100) + ')';
    t.setAttribute('aria-valuetext', g.toFixed(2) + '×');
  });
  var setFrom = function (e) {
    var r = t.getBoundingClientRect(), k = r.height / h;
    eqSetGain(i, (1 - ((e.clientY - r.top) / k - capH / 2) / travel) * 2);
    eqRefresh(); eqTip(t, i);
  };
  t.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); t.setPointerCapture(e.pointerId); dragging = true;
    if (eqSel !== i) eqSelect(i);
    setFrom(e);
    var up = function () { dragging = false; hideTip(); t.removeEventListener('pointermove', setFrom); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up); };
    t.addEventListener('pointermove', setFrom); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
  });
  var nudge = function (d) { eqSetGain(i, params['eqG' + i] + d); eqRefresh(); eqTip(t, i); };
  t.addEventListener('dblclick', function () { params['eqG' + i] = 1; eqRefresh(); eqTip(t, i); });
  t.addEventListener('wheel', function (e) { e.preventDefault(); nudge(e.deltaY > 0 ? -0.05 : 0.05); }, { passive: false });
  t.addEventListener('keydown', function (e) {
    var d = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
    if (d) { e.preventDefault(); nudge(d); }
  });
  t.addEventListener('pointerleave', function () { if (!dragging) hideTip(); });
}
// A band's Hue knob (its scale ring is the spectrum, so the pointer shows the hue) or Width knob, label hidden (the
// tooltip names it).
function eqKnob(cx, cy, ks, i, what) {
  var id = (what === 'hue' ? 'eqH' : 'eqW') + i;
  var k = knob(cx, cy, ks, EQ_NAMES[i] + (what === 'hue' ? ' hue' : ' width'), id, { after: eqRefresh, ticks: what === 'hue' ? 13 : 11 });
  var ring = ui.knobs[id].ring;
  ring.parentNode.lastChild.style.display = 'none';
  if (what === 'hue') {
    var stops = []; for (var j = 0; j <= 12; j++) stops.push('hsl(' + j * 30 + ',90%,56%) ' + j * 22.5 + 'deg');
    ring.querySelector('.knob-scale').style.background = 'conic-gradient(from -135deg,' + stops.join(',') + ',transparent 270deg)';
  }
  return k;
}
// The single Width knob (Spectrum, Wheel) for the selected band, named over it in the band's colour.
function eqWidthKnob(cx, cy, ks) {
  syncers.push(function () { params.eqWsel = params['eqW' + eqSel]; });   // before the knob's own sync
  params.eqWsel = params['eqW' + eqSel];
  ui.eqWknob = knob(cx, cy, ks, 'Width', 'eqWsel', { after: function (v) { params['eqW' + eqSel] = v; eqRefresh(); } });
  var chip = el('span', at(cx - 50 * UL, cy - ks / 2 - 12 - 13 * UL, 100 * UL, 12 * UL) + ';text-align:center;' + PRINT(9 * UL));
  ui.eqParts.push(function () { chip.textContent = EQ_NAMES[eqSel]; chip.style.color = eqHueCss(eqSel, 64); });
}
// A colour chip with the band's initial.
function eqChip(x, y, w, h, i) {
  var c = el('span', at(x, y, w, h) + ';box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:3px;' + PRINT(Math.min(h * 0.75, 9 * UL), '#141316') + ';box-shadow:0 0 0 1px #0b0b0c', panel, EQ_NAMES[i][0]);
  ui.eqParts.push(function () { c.style.background = eqHueCss(i); c.style.boxShadow = '0 0 0 1px #0b0b0c' + (i === eqSel ? ',0 0 0 ' + Math.max(1.5, UK * 1.5) + 'px #fff' : '') + ',0 0 8px ' + eqHueCss(i, 45); });
  c.style.cursor = 'pointer'; c.setAttribute('role', 'button'); c.setAttribute('aria-label', EQ_NAMES[i] + ' band');
  c.addEventListener('click', function () { eqSelect(i); });
}
// Styles 1 (look 'console') and 3 ('rainbow'): one strip per band.
function eqStrips(C, look) {
  var sw = C[2] / EQ_N, gap = 6 * UK, chip = 13 * UK, row = sw >= 90 * UK;
  // Knobs side by side in a row when the strips are wide, stacked when narrow (landscape).
  var ks = row ? Math.min(34 * UK, (sw - gap) / 2 - 20) : Math.max(14, Math.min(30 * UK, sw - 22)), R = ks / 2 + 10, kb = row ? 2 * R : 4 * R + gap;
  for (var i = 0; i < EQ_N; i++) {
    var cx = C[0] + sw * (i + 0.5), fw = Math.min(sw - 8, 64 * UK), y0, y1, kTop;
    if (look === 'console') { y0 = C[1] + chip + gap; y1 = C[1] + C[3] - kb - gap; kTop = y1 + gap; eqChip(cx - Math.min(sw - 10, 40 * UK) / 2, C[1], Math.min(sw - 10, 40 * UK), chip, i); }
    else { kTop = C[1]; y0 = C[1] + kb + gap; y1 = C[1] + C[3] - chip - gap; eqChip(cx - Math.min(sw - 10, 40 * UK) / 2, y1 + gap, Math.min(sw - 10, 40 * UK), chip, i); }
    eqFader(cx - fw / 2, y0, fw, y1 - y0, i, look);
    if (row) { eqKnob(cx - R - gap / 2, kTop + R, ks, i, 'hue'); eqKnob(cx + R + gap / 2, kTop + R, ks, i, 'width'); }
    else { eqKnob(cx, kTop + R, ks, i, 'hue'); eqKnob(cx, kTop + 3 * R + gap, ks, i, 'width'); }
  }
}
// Style 2: the spectrum screen, the Width knob beside it (wide window) or under it (tall).
var EQ_H0 = -20;   // hue at the screen's left edge, so red's bell isn't split
function eqSpectrum(C) {
  var wide = C[2] >= C[3], ks = 44 * UK, R = ks / 2 + 10, lab = 10 * UL, G;
  if (wide) { var col = 2 * R + 40 * UK; G = [C[0], C[1], C[2] - col - 8, C[3]]; eqWidthKnob(C[0] + C[2] - col / 2, C[1] + C[3] / 2, ks); }
  else { var rw = 2 * R + lab + 30 * UK; G = [C[0], C[1], C[2], C[3] - rw - 8]; eqWidthKnob(C[0] + C[2] / 2, C[1] + C[3] - R - lab - 6, ks); }
  var E = ui.eqSpec = glass(G[0], G[1], G[2], G[3], 'Colors EQ: drag a slider cap up or down for saturation, sideways for its hue; the wheel sets its width');
  var g = E.g, w = E.w, h = E.h, top = 0.07 * h, bot = 0.82 * h;
  var xOf = function (hu) { return ((((hu - EQ_H0) % 360) + 360) % 360) / 360 * w; }, yOf = function (v) { return bot - v / 2 * (bot - top); };
  var capW = Math.max(26, Math.min(48, w / 13)), capH = capW * 0.55;
  ui.eqParts.push(function () {
    var c = E.x; c.clearRect(0, 0, w, h);
    var spec = c.createLinearGradient(0, 0, w, 0);
    for (var s0 = 0; s0 <= 24; s0++) spec.addColorStop(s0 / 24, 'hsl(' + Math.round((EQ_H0 + s0 * 15 + 360) % 360) + ',85%,55%)');
    c.lineWidth = 2;
    [0.5, 1, 1.5].forEach(function (v) { c.strokeStyle = v === 1 ? 'rgba(220,232,255,0.35)' : 'rgba(143,141,146,0.25)'; c.setLineDash(v === 1 ? [] : [6, 8]); c.beginPath(); c.moveTo(0, yOf(v)); c.lineTo(w, yOf(v)); c.stroke(); });
    c.setLineDash([]);
    var hueX = function (x) { return EQ_H0 + x / w * 360; };
    c.beginPath(); c.moveTo(0, bot);
    for (var x = 0; x <= w; x += 4) c.lineTo(x, yOf(Math.min(2, eqAt(hueX(x)))));
    c.lineTo(w, bot); c.closePath(); c.save(); c.globalAlpha = 0.25; c.fillStyle = spec; c.fill(); c.restore();
    c.beginPath(); for (x = 0; x <= w; x += 4) c[x ? 'lineTo' : 'moveTo'](x, yOf(Math.min(2, eqAt(hueX(x)))));
    c.strokeStyle = P.accent; c.lineWidth = 4; c.shadowColor = P.accentGlow; c.shadowBlur = 10; c.stroke(); c.shadowBlur = 0;
    for (var i = 0; i < EQ_N; i++) {   // slider tracks standing on the spectrum, their caps at the gain
      var bx = xOf(params['eqH' + i]), by = yOf(params['eqG' + i]), col = eqHueCss(i), sel = i === eqSel;
      c.globalAlpha = sel ? 0.55 : 0.28; c.fillStyle = col; c.fillRect(bx - 3, top - capH / 2, 6, bot - top + capH / 2); c.globalAlpha = 1;
      if (sel) {   // the width, as a bracket at the cap's height
        var wx = params['eqW' + i] / 360 * w; c.strokeStyle = col; c.lineWidth = 3;
        c.beginPath(); c.moveTo(bx - wx, by - 10); c.lineTo(bx - wx, by); c.lineTo(bx + wx, by); c.lineTo(bx + wx, by - 10); c.stroke();
      }
      c.fillStyle = col; c.strokeStyle = sel ? '#fff' : '#0b0b0c'; c.lineWidth = sel ? 4 : 3;
      c.beginPath(); c.roundRect ? c.roundRect(bx - capW / 2, by - capH / 2, capW, capH, 6) : c.rect(bx - capW / 2, by - capH / 2, capW, capH); c.fill(); c.stroke();
      c.fillStyle = '#141316'; c.fillRect(bx - capW * 0.32, by - 1.5, capW * 0.64, 3);
    }
    c.fillStyle = spec; c.fillRect(0, 0.87 * h, w, 0.1 * h);
    for (x = 0; x < w; x += 4) { var k = Math.min(1, eqAt(hueX(x))); if (k < 1) { c.fillStyle = 'rgba(128,128,128,' + (1 - k) + ')'; c.fillRect(x, 0.87 * h, 4, 0.1 * h); } }
    g.setAttribute('aria-valuetext', EQ_NAMES.map(function (n, j) { return n + ' ' + params['eqG' + j].toFixed(2) + 'x at ' + Math.round(params['eqH' + j]) + '°'; }).join(', '));
  });
  var at0 = function (e) { var r = g.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * w, (e.clientY - r.top) / r.height * h]; };
  var nearest = function (p) {
    var best = 0, bd = 1e9;
    for (var i = 0; i < EQ_N; i++) { var d = Math.abs(p[0] - xOf(params['eqH' + i])); d = Math.min(d, w - d); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  eqDrag(g, at0, nearest, function (i, p, p0, h0, moved) {
    eqSetGain(i, (bot - p[1]) / (bot - top) * 2);
    if (moved) params['eqH' + i] = Math.round((((h0 + (p[0] - p0[0]) / w * 360) % 360) + 360) % 360);
  });
}
// Dragging on an EQ screen: pick the nearest band on pointer down, then move(i, point, start point, start hue, moved)
// on every move (moved: the pointer has gone far enough sideways / around to shift the hue, not just the gain).
// Double-click returns the nearest band to 1x; the wheel widens or narrows it.
function eqDrag(g, pos, nearest, move) {
  g.style.cursor = 'grab'; g.style.touchAction = 'none'; g.setAttribute('role', 'group');
  g.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); g.setPointerCapture(e.pointerId); dragging = true;
    var p0 = pos(e), i = nearest(p0, true), h0 = params['eqH' + i], moved = false;
    eqSelect(i); eqTip(g, i);
    var mv = function (ev) { var p = pos(ev); if (!moved && Math.hypot(p[0] - p0[0], p[1] - p0[1]) > 14) moved = true; if (moved) { move(i, p, p0, h0, true); eqRefresh(); eqTip(g, i); } };
    var up = function () { dragging = false; hideTip(); g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up); };
    g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', function (e) { var i = nearest(pos(e)); params['eqG' + i] = 1; eqSelect(i); eqTip(g, i); });
  g.addEventListener('wheel', function (e) {
    e.preventDefault(); var i = nearest(pos(e)), k = 'eqW' + i;
    params[k] = clamp(Math.round(params[k] * (e.deltaY > 0 ? 0.9 : 1.1) * 2) / 2, EQ_WIDTH.min, EQ_WIDTH.max); eqSelect(i); eqTip(g, i);
  }, { passive: false });
  g.addEventListener('pointerleave', function () { if (!dragging) hideTip(); });
}
// Style 4: the polar screen and thin faders (with chips) and the Width knob; screen on the right in a wide window, on
// top in a tall one.
function eqWheel(C) {
  var wide = C[2] >= C[3], ks = 40 * UK, R = ks / 2 + 10, lab = 10 * UL, gap = 8 * UK, chip = 13 * UK, s, G, F, kx, ky;
  if (wide) {
    s = C[3]; G = [C[0] + C[2] - s, C[1], s, s];
    var col = 2 * R + 40 * UK; F = [C[0], C[1], C[2] - s - col - 2 * gap, C[3]]; kx = F[0] + F[2] + gap + col / 2; ky = C[1] + C[3] / 2;
  } else {
    s = C[2]; G = [C[0], C[1], s, s];
    var rw = 2 * R + lab + 30 * UK; F = [C[0], C[1] + s + gap, C[2], C[3] - s - gap - rw]; kx = C[0] + C[2] / 2; ky = C[1] + C[3] - R - lab - 6;
  }
  var fsw = F[2] / EQ_N;
  for (var i = 0; i < EQ_N; i++) {
    var cx = F[0] + fsw * (i + 0.5), fw = Math.min(fsw - 4, 40 * UK);
    eqFader(cx - fw / 2, F[1], fw, F[3] - chip - gap, i, 'thin');
    eqChip(cx - Math.min(fsw - 6, 30 * UK) / 2, F[1] + F[3] - chip, Math.min(fsw - 6, 30 * UK), chip, i);
  }
  eqWidthKnob(kx, ky, ks);
  var E = ui.eqWheel = glass(G[0], G[1], G[2], G[3], 'Colors EQ: drag a band around the ring for its hue, in or out for its saturation; the wheel sets its width');
  var g = E.g, w = E.w, cx0 = w / 2, cy0 = E.h / 2, rIn = 0.13 * w, rMax = 0.37 * w, rRing = 0.43 * w, ringW = 0.05 * w;
  var ang = function (hu) { return hu / 360 * TAU - Math.PI / 2; }, rOf = function (v) { return rIn + Math.min(2, v) / 2 * (rMax - rIn); };
  var dot = function (i) { var a = ang(params['eqH' + i]), r = rOf(params['eqG' + i]); return [cx0 + r * Math.cos(a), cy0 + r * Math.sin(a)]; };
  ui.eqParts.push(function () {
    var c = E.x; c.clearRect(0, 0, w, E.h);
    for (var j = 0; j < 120; j++) {   // the hue ring
      c.beginPath(); c.arc(cx0, cy0, rRing, ang(j * 3) - 0.004, ang(j * 3 + 3) + 0.004);
      c.strokeStyle = 'hsl(' + j * 3 + ',85%,55%)'; c.lineWidth = ringW; c.stroke();
    }
    c.lineWidth = 2;
    [0.5, 1, 1.5].forEach(function (v) { c.strokeStyle = v === 1 ? 'rgba(220,232,255,0.4)' : 'rgba(143,141,146,0.25)'; c.setLineDash(v === 1 ? [] : [6, 8]); c.beginPath(); c.arc(cx0, cy0, rOf(v), 0, TAU); c.stroke(); });
    c.setLineDash([]);
    c.beginPath();
    for (var hh = 0; hh <= 360; hh += 3) { var a = ang(hh), r = rOf(eqAt(hh)); c[hh ? 'lineTo' : 'moveTo'](cx0 + r * Math.cos(a), cy0 + r * Math.sin(a)); }
    c.closePath(); c.save(); c.globalAlpha = 0.16; c.fillStyle = P.accent; c.fill(); c.restore();
    c.strokeStyle = P.accent; c.lineWidth = 4; c.shadowColor = P.accentGlow; c.shadowBlur = 10; c.stroke(); c.shadowBlur = 0;
    for (var i = 0; i < EQ_N; i++) {
      var d = dot(i), col = eqHueCss(i), sel = i === eqSel;
      c.strokeStyle = col; c.globalAlpha = 0.35; c.lineWidth = 2; c.beginPath(); c.moveTo(cx0 + rIn * Math.cos(ang(params['eqH' + i])), cy0 + rIn * Math.sin(ang(params['eqH' + i]))); c.lineTo(d[0], d[1]); c.stroke(); c.globalAlpha = 1;
      if (sel) { c.lineWidth = 5; c.beginPath(); c.arc(cx0, cy0, rRing - ringW * 0.9, ang(params['eqH' + i] - params['eqW' + i]), ang(params['eqH' + i] + params['eqW' + i])); c.stroke(); }
      c.beginPath(); c.arc(d[0], d[1], 0.034 * w, 0, TAU); c.fillStyle = col; c.fill(); c.strokeStyle = sel ? '#fff' : '#0b0b0c'; c.lineWidth = sel ? 4 : 3; c.stroke();
    }
    g.setAttribute('aria-valuetext', EQ_NAMES.map(function (n, j) { return n + ' ' + params['eqG' + j].toFixed(2) + 'x at ' + Math.round(params['eqH' + j]) + '°'; }).join(', '));
  });
  var pos = function (e) { var r = g.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * w, (e.clientY - r.top) / r.height * E.h]; };
  var nearest = function (p) {
    var best = 0, bd = 1e9;
    for (var i = 0; i < EQ_N; i++) { var d = dot(i), dd = Math.hypot(p[0] - d[0], p[1] - d[1]); if (dd < bd) { bd = dd; best = i; } }
    return best;
  };
  eqDrag(g, pos, nearest, function (i, p) {
    var dx = p[0] - cx0, dy = p[1] - cy0;
    params['eqH' + i] = Math.round(((Math.atan2(dy, dx) + Math.PI / 2) / TAU * 360 + 360) % 360);
    eqSetGain(i, (Math.hypot(dx, dy) - rIn) / (rMax - rIn) * 2);
  });
}

// Styles 5-12, after the Teenage Engineering OP-1: black screens drawn in thin vector lines, flat grey keys and pads,
// and coloured endless encoders matched by colour to the values on screen: blue steps the selected band, green turns
// its gain, white its hue and orange its width.
// 5 Encoders: a screen of seven level bars (each band's bell drawn under its bar) and all four encoders.
// 6 Keys: flat grey keys, one per band with its level lit up the key (drag a key for gain), a curve screen and the
//   white and orange encoders.
// 7 Dots: a dot-matrix screen, eight dots per band (0.25 to 2x; the colour square below them is 0); tap or sweep
//   across it; white and orange encoders.
// 8 Dials: a screen of arc gauges (drag one up or down for gain; the arc in its foot is the width); white and orange.
// 9 Bloom: a flower whose petals are the bands (angle the hue, length the gain, fatness the width; drag a petal's tip)
//   beside a list of every value, and all four encoders.
// 10 Levels: lollipop levels joined by cables to markers on a hue tape (greyed where saturation is cut): sweep the
//   levels for gain, slide a marker for hue; the wheel, or the orange encoder, sets the width.
// 11 Pads: grey pads, each a disc in its band's colour that grows with the gain and glows with the width (tap steps
//   1, 1.5, 2, 0, 0.5x; drag for any level), under a status screen; white and orange encoders.
// 12 Seven: an encoder per band, capped in its colour, under a screen of readouts; Gain, Hue and Width keys pick what
//   they all turn.
// In a tall window (landscape) the bands run down the window instead of across.
var OP = { blue: '#4d8bff', green: '#36c874', white: '#f0f0ec', orange: '#ff7a2a', dim: 'rgba(240,240,236,0.26)', faint: 'rgba(240,240,236,0.1)' };
var OP_FONT = '"Barlow Semi Condensed", "Segoe UI", sans-serif', OP_MODES = ['gain', 'hue', 'width'], opMode = 0, opAcc = 0;
// Relative gain change (encoders, keys, pads): stops once at 1x on the way through.
function opGain(i, d) { var g0 = params['eqG' + i], g = clamp(g0 + d, 0, 2); if ((g0 - 1) * (g - 1) < 0) g = 1; params['eqG' + i] = Math.round(g * 1000) / 1000; }
function opHue(h) { return Math.round((((h % 360) + 360) % 360) * 10) / 10; }
// What each encoder colour turns on band i: turn(i, n) by n ticks, reset(i) on double-click, val(i) for the screens.
var OPR = {
  band: { col: OP.blue, name: 'Band', notch: 20, val: function () { return EQ_NAMES[eqSel]; },
    turn: function (i, n) { opAcc += n; var s = Math.trunc(opAcc / 20); if (s) { opAcc -= s * 20; eqSelect((((eqSel + s) % EQ_N) + EQ_N) % EQ_N); } } },
  gain: { col: OP.green, name: 'Gain', val: function (i) { return params['eqG' + i].toFixed(2) + '×'; }, turn: function (i, n) { opGain(i, n * 0.005); }, reset: function (i) { params['eqG' + i] = 1; } },
  hue: { col: OP.white, name: 'Hue', val: function (i) { return Math.round(params['eqH' + i]) % 360 + '°'; }, turn: function (i, n) { params['eqH' + i] = opHue(params['eqH' + i] + n * 0.5); }, reset: function (i) { params['eqH' + i] = EQ_HUES[i]; } },
  width: { col: OP.orange, name: 'Width', val: function (i) { return '±' + Math.round(params['eqW' + i]) + '°'; },
    turn: function (i, n) { params['eqW' + i] = clamp(params['eqW' + i] * Math.exp(n * 0.008), EQ_WIDTH.min, EQ_WIDTH.max); }, reset: function (i) { params['eqW' + i] = EQ_WIDTH.def; } }
};
// An endless encoder, cap diameter d in colour col (a CSS colour, or a function for one that changes), centred on
// (cx, cy). Drag up or down, the wheel or the arrow keys turn it: f.turn(n) gets ticks (one per stage pixel of drag,
// Shift for a fifth; f.notch per wheel notch or key press, 8 by default); f.reset() on double-click; f.tip() for the
// tooltip. The cap's dot spins with the turn.
function opEnc(cx, cy, d, col, aria, f) {
  var t = el('div', at(cx - d / 2 - 5, cy - d / 2 - 5, d + 10, d + 10) + ';border-radius:50%;cursor:ns-resize;touch-action:none;background:#1d1d20;' +
    'box-shadow:inset 0 2px 4px rgba(0,0,0,0.85),0 1px 0 rgba(255,255,255,0.22)');
  t.setAttribute('role', 'slider'); t.tabIndex = 0; t.setAttribute('aria-label', aria);
  var cap = el('div', 'position:absolute;left:5px;top:5px;width:' + d + 'px;height:' + d + 'px;border-radius:50%;pointer-events:none;' +
    'box-shadow:0 3px 5px rgba(0,0,0,0.55),inset 0 -3px 0 rgba(0,0,0,0.2),inset 0 2px 1px rgba(255,255,255,0.4)', t);
  var rot = el('div', 'position:absolute;inset:0', cap), ds = Math.max(3, d * 0.1);
  el('div', 'position:absolute;left:50%;top:10%;width:' + ds + 'px;height:' + ds + 'px;margin-left:' + -ds / 2 + 'px;border-radius:50%;background:rgba(0,0,0,0.4)', rot);
  var ang = 0, notch = f.notch || 8;
  ui.eqParts.push(function () { cap.style.background = 'radial-gradient(circle at 40% 30%,rgba(255,255,255,0.3),rgba(255,255,255,0) 58%),' + (typeof col === 'function' ? col() : col); t.setAttribute('aria-valuetext', f.tip()); });
  var go = function (n) { if (!n) return; ang += n * 2.5; rot.style.transform = 'rotate(' + ang + 'deg)'; f.turn(n); eqRefresh(); showTip(t, f.tip()); };
  t.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); t.setPointerCapture(e.pointerId); dragging = true;
    var ly = e.clientY, k = stageScale();
    var mv = function (ev) { var n = (ly - ev.clientY) / k * (ev.shiftKey ? 0.2 : 1); ly = ev.clientY; go(n); };
    var up = function () { dragging = false; hideTip(); t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up); };
    t.addEventListener('pointermove', mv); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
    showTip(t, f.tip());
  });
  t.addEventListener('wheel', function (e) { e.preventDefault(); go(e.deltaY > 0 ? -notch : notch); }, { passive: false });
  t.addEventListener('keydown', function (e) {
    var s = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (s) { e.preventDefault(); go(s * notch); }
  });
  t.addEventListener('dblclick', function () { if (f.reset) { f.reset(); eqRefresh(); showTip(t, f.tip()); } });
  t.addEventListener('pointerenter', function () { if (!dragging) showTip(t, f.tip()); });
  t.addEventListener('pointerleave', function () { if (!dragging) hideTip(); });
  return t;
}
// Encoders for the selected band (roles: of band, gain, hue, width) in box B: in a row, a column or a grid, whichever
// gives them the most room.
function opEncs(B, roles) {
  var n = roles.length, best = { s: 0 };
  for (var cols = 1; cols <= n; cols++) { var rows = Math.ceil(n / cols), s = Math.min(B[2] / cols, B[3] / rows); if (s > best.s) best = { s: s, cols: cols, rows: rows }; }
  var d = Math.max(20, Math.min(56 * UK, best.s - 22)), cw = B[2] / best.cols, rh = B[3] / best.rows;
  roles.forEach(function (r, j) {
    var o = OPR[r];
    opEnc(B[0] + cw * (j % best.cols + 0.5), B[1] + rh * (Math.floor(j / best.cols) + 0.5), d, o.col, 'Colors EQ ' + o.name.toLowerCase() + ' encoder (selected band)', {
      notch: o.notch, turn: function (t) { o.turn(eqSel, t); }, reset: o.reset && function () { o.reset(eqSel); },
      tip: function () { return r === 'band' ? 'Band  ' + EQ_NAMES[eqSel] : EQ_NAMES[eqSel] + ' ' + o.name.toLowerCase() + '  ' + o.val(eqSel); } });
  });
}
// An OP screen: a glass with a bezel; its canvas is 2x the stage size.
function opScreen(G, aria) {
  var E = glass(G[0], G[1], G[2], G[3], aria), s = E.g.style;
  s.background = '#000'; s.borderRadius = 6 * UK + 'px';
  s.boxShadow = '0 0 0 ' + 3 * UK + 'px #18181a,0 0 0 ' + (3 * UK + 1) + 'px rgba(255,255,255,0.28),inset 0 0 12px rgba(0,0,0,0.9)';
  return E;
}
// The selected band's name (in its colour) and the values its encoders turn (each in its encoder's colour) as one line
// of text on a screen canvas: left-aligned at x, centred on y, fs canvas pixels high (smaller when it would pass maxW).
function opStatus(c, x, y, fs, maxW, roles) {
  var i = eqSel, items = [[roles.indexOf('band') >= 0 ? OP.blue : null, EQ_NAMES[i].toUpperCase(), eqHueCss(i, 62)]];
  roles.forEach(function (r) { if (r !== 'band') items.push([OPR[r].col, OPR[r].val(i), OPR[r].col]); });
  c.font = '700 ' + fs + 'px ' + OP_FONT;
  var tw = items.reduce(function (a, t) { return a + c.measureText(t[1]).width + fs * 1.75; }, 0);
  if (tw > maxW) { fs *= maxW / tw; c.font = '700 ' + fs + 'px ' + OP_FONT; }
  c.textBaseline = 'middle'; c.textAlign = 'left';
  items.forEach(function (t) {
    if (t[0]) { c.fillStyle = t[0]; c.beginPath(); c.arc(x + fs * 0.3, y, fs * 0.26, 0, TAU); c.fill(); }
    x += fs * 0.85; c.fillStyle = t[2]; c.fillText(t[1], x, y); x += c.measureText(t[1]).width + fs * 0.9;
  });
}
// A screen strip of only the status line.
function opStrip(G, roles) {
  var E = opScreen(G, 'Colors EQ: the selected band and its encoder values'), w = E.w, h = E.h;
  ui.eqParts.push(function () { var c = E.x; c.clearRect(0, 0, w, h); opStatus(c, 14 * UK, h / 2, Math.min(18 * UL, h * 0.5), w - 28 * UK, roles); });
}
// Band axis and level axis in a canvas rectangle: at(a, v) for a (0-1 along the bands) and v (0-1 up the level) gives
// the canvas point; of(point) the reverse. Wide: bands left to right, level upwards; tall: bands downwards, level to
// the right.
function opAxis(wide, x0, y0, W, H) {
  return wide ? { along: W, across: H, at: function (a, v) { return [x0 + a * W, y0 + (1 - v) * H]; }, of: function (p) { return [(p[0] - x0) / W, 1 - (p[1] - y0) / H]; } }
    : { along: H, across: W, at: function (a, v) { return [x0 + v * W, y0 + a * H]; }, of: function (p) { return [(p[1] - y0) / H, (p[0] - x0) / W]; } };
}
// Pointer handling on an OP screen: apply(point, first) on pointer down and on every move while held, returning the
// band it touched; idx(point) names the band under a point for the wheel (its width) and double-click (gain to 1x).
function opTouch(g, w, h, apply, idx) {
  var pos = function (e) { var r = g.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * w, (e.clientY - r.top) / r.height * h]; };
  g.style.cursor = 'pointer'; g.style.touchAction = 'none'; g.setAttribute('role', 'group');
  g.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); g.setPointerCapture(e.pointerId); dragging = true;
    var i = apply(pos(e), true); eqRefresh(); eqTip(g, i);
    var mv = function (ev) { var j = apply(pos(ev), false); eqRefresh(); eqTip(g, j); };
    var up = function () { dragging = false; hideTip(); g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up); };
    g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', function (e) { var i = idx(pos(e)); params['eqG' + i] = 1; eqSelect(i); eqTip(g, i); });
  g.addEventListener('wheel', function (e) {
    e.preventDefault(); var i = idx(pos(e));
    params['eqW' + i] = clamp(params['eqW' + i] * (e.deltaY > 0 ? 0.9 : 1.1), EQ_WIDTH.min, EQ_WIDTH.max); eqSelect(i); eqTip(g, i);
  }, { passive: false });
  g.addEventListener('pointerleave', function () { if (!dragging) hideTip(); });
}
// Split C into a main box and an encoder box (side: its width in a wide window, its height in a tall one).
function opSplit(C, side) {
  var gap = 10 * UK;
  return C[2] >= C[3] ? [[C[0], C[1], C[2] - side - gap, C[3]], [C[0] + C[2] - side, C[1], side, C[3]]] : [[C[0], C[1], C[2], C[3] - side - gap], [C[0], C[1] + C[3] - side, C[2], side]];
}
function opSelLast() { var o = []; for (var i = 0; i < EQ_N; i++) if (i !== eqSel) o.push(i); o.push(eqSel); return o; }
function opValText() { return EQ_NAMES.map(function (n, j) { return n + ' ' + params['eqG' + j].toFixed(2) + 'x at ' + Math.round(params['eqH' + j]) + '°'; }).join(', '); }

// Style 5: level bars and the four encoders.
function eqOpEncoders(C) {
  var wide = C[2] >= C[3], S = opSplit(C, wide ? Math.min(C[3] * 1.05, C[2] * 0.3) : Math.min(C[2] * 1.05, C[3] * 0.36));
  opEncs(S[1], ['band', 'gain', 'hue', 'width']);
  var E = opScreen(S[0], 'Colors EQ levels: tap a band to pick it, drag for its saturation; the blue, green, white and orange encoders turn its band, gain, hue and width');
  var w = E.w, h = E.h, fs = 18 * UL, pad = 14 * UK, top = pad * 2 + fs, bellH = Math.min(h * 0.14, 40 * UK), bot = h - pad * 1.6 - bellH, cw = (w - 2 * pad) / EQ_N;
  var yOf = function (g) { return bot - g / 2 * (bot - top); }, col = function (p) { return clamp(Math.floor((p[0] - pad) / cw), 0, EQ_N - 1); }, held = 0;
  ui.eqParts.push(function () {
    var c = E.x; c.clearRect(0, 0, w, h);
    opStatus(c, pad, pad + fs / 2, fs, w - 2 * pad, ['band', 'gain', 'hue', 'width']);
    c.strokeStyle = OP.dim; c.lineWidth = 2; c.setLineDash([4, 6]); c.beginPath(); c.moveTo(pad, yOf(1)); c.lineTo(w - pad, yOf(1)); c.stroke(); c.setLineDash([]);
    for (var i = 0; i < EQ_N; i++) {
      var cx = pad + cw * (i + 0.5), bw = cw * 0.42, g = params['eqG' + i], hue = eqHueCss(i), sel = i === eqSel;
      c.strokeStyle = sel ? OP.white : OP.dim; c.lineWidth = sel ? 3 : 2; c.strokeRect(cx - bw / 2, top, bw, bot - top);
      c.fillStyle = hue; c.fillRect(cx - bw / 2 + 5, yOf(g), bw - 10, bot - yOf(g));
      c.fillStyle = OP.white; c.fillRect(cx - bw / 2 - 5, yOf(g) - 2, bw + 10, 4);
      var sd = params['eqW' + i] / (360 / EQ_N) * cw, by = h - pad;   // the bell, to the scale of the band's share of the hue circle
      c.beginPath();
      for (var k = 0; k <= 40; k++) { var dx = (k / 40 - 0.5) * cw * 0.9; c[k ? 'lineTo' : 'moveTo'](cx + dx, by - bellH * Math.exp(-0.5 * (dx / sd) * (dx / sd))); }
      c.strokeStyle = hue; c.lineWidth = sel ? 3 : 2; c.stroke();
    }
    E.g.setAttribute('aria-valuetext', opValText());
  });
  opTouch(E.g, w, h, function (p, first) { if (first) { held = col(p); eqSelect(held); } eqSetGain(held, (bot - p[1]) / (bot - top) * 2); return held; }, col);
}

// A flat grey key for band i in rectangle R: upright (level up the key) in a wide window, lying (level to the right)
// in a tall one. Drag along it to raise or lower the gain (tap only selects it).
function opKey(R, i, up) {
  var t = el('div', at(R[0], R[1], R[2], R[3]) + ';border-radius:' + 5 * UK + 'px;cursor:' + (up ? 'ns-resize' : 'ew-resize') + ';touch-action:none;transition:transform 40ms');
  t.setAttribute('role', 'slider'); t.tabIndex = 0; t.setAttribute('aria-label', EQ_NAMES[i] + ' saturation key');
  var len = up ? R[3] : R[2], th = up ? R[2] : R[3], ds = Math.max(8, Math.min(th * 0.26, 15 * UK)), m0 = Math.max(6, th * 0.17), sw = Math.max(4, th * 0.13);
  var dot = el('div', 'position:absolute;width:' + ds + 'px;height:' + ds + 'px;border-radius:50%;' + (up ? 'left:50%;margin-left:' + -ds / 2 + 'px;top:' + m0 + 'px' : 'top:50%;margin-top:' + -ds / 2 + 'px;left:' + m0 + 'px'), t);
  var s0 = m0 * 1.8 + ds, slot = el('div', 'position:absolute;border-radius:' + sw / 2 + 'px;background:rgba(40,40,46,0.16);box-shadow:inset 0 1px 2px rgba(0,0,0,0.25);' +
    (up ? 'left:50%;width:' + sw + 'px;margin-left:' + -sw / 2 + 'px;top:' + s0 + 'px;bottom:' + m0 + 'px' : 'top:50%;height:' + sw + 'px;margin-top:' + -sw / 2 + 'px;left:' + s0 + 'px;right:' + m0 + 'px'), t);
  var fill = el('div', 'position:absolute;border-radius:inherit;' + (up ? 'left:0;right:0;bottom:0' : 'top:0;bottom:0;left:0'), slot);
  el('div', 'position:absolute;background:#3a3a3f;' + (up ? 'left:-5px;right:-5px;top:50%;height:2px;margin-top:-1px' : 'top:-5px;bottom:-5px;left:50%;width:2px;margin-left:-1px'), slot);
  ui.eqParts.push(function () {
    var g = params['eqG' + i], c = eqHueCss(i), sel = i === eqSel;
    t.style.background = sel ? 'linear-gradient(#d4d4d1,#c3c3c0)' : 'linear-gradient(#f3f3f1,#d8d8d5)';
    t.style.boxShadow = sel ? '0 1px 0 #87878a,0 2px 3px rgba(0,0,0,0.3),inset 0 1px 3px rgba(0,0,0,0.15)' : '0 3px 0 #96969a,0 5px 8px rgba(0,0,0,0.35),inset 0 1px 0 #fff';
    t.style.transform = sel ? 'translateY(2px)' : '';
    dot.style.background = c; dot.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.25)' + (sel ? ',0 0 7px ' + c : '');
    fill.style[up ? 'height' : 'width'] = g / 2 * 100 + '%'; fill.style.background = c;
    t.setAttribute('aria-valuetext', g.toFixed(2) + '×');
  });
  t.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); t.setPointerCapture(e.pointerId); dragging = true;
    eqSelect(i); eqTip(t, i);
    var last = up ? e.clientY : e.clientX, k = stageScale();
    var mv = function (ev) { var p = up ? ev.clientY : ev.clientX; opGain(i, (up ? last - p : p - last) / k / len * 2.4); last = p; eqRefresh(); eqTip(t, i); };
    var end = function () { dragging = false; hideTip(); t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', end); t.removeEventListener('pointercancel', end); };
    t.addEventListener('pointermove', mv); t.addEventListener('pointerup', end); t.addEventListener('pointercancel', end);
  });
  var nudge = function (d) { opGain(i, d); eqSelect(i); eqTip(t, i); };
  t.addEventListener('wheel', function (e) { e.preventDefault(); nudge(e.deltaY > 0 ? -0.05 : 0.05); }, { passive: false });
  t.addEventListener('keydown', function (e) { var d = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key]; if (d) { e.preventDefault(); nudge(d); } });
  t.addEventListener('dblclick', function () { params['eqG' + i] = 1; eqSelect(i); eqTip(t, i); });
  t.addEventListener('pointerleave', function () { if (!dragging) hideTip(); });
}
// A screen of the response curve over the hue circle with each band a dot at its hue (tap one to pick it; the wheel
// sets its width) and the status line along the top.
function opCurve(G, roles) {
  var E = opScreen(G, 'Colors EQ curve: tap a band to pick it; the wheel sets its width'), w = E.w, h = E.h, fs = 18 * UL, pad = 14 * UK;
  var top = pad * 2 + fs, bot = h - pad * 2.4, x0 = pad, x1 = w - pad, span = x1 - x0;
  var xOf = function (hu) { return x0 + ((((hu - EQ_H0) % 360) + 360) % 360) / 360 * span; }, yOf = function (v) { return bot - Math.min(2, v) / 2 * (bot - top); };
  ui.eqParts.push(function () {
    var c = E.x; c.clearRect(0, 0, w, h);
    opStatus(c, pad, pad + fs / 2, fs, w - 2 * pad, roles);
    c.strokeStyle = OP.faint; c.lineWidth = 2;
    for (var k = 0; k <= 12; k++) { c.beginPath(); c.moveTo(x0 + k / 12 * span, top); c.lineTo(x0 + k / 12 * span, bot); c.stroke(); }
    c.strokeStyle = OP.dim; c.setLineDash([4, 6]); c.beginPath(); c.moveTo(x0, yOf(1)); c.lineTo(x1, yOf(1)); c.stroke(); c.setLineDash([]);
    c.beginPath(); for (k = 0; k <= 120; k++) c[k ? 'lineTo' : 'moveTo'](x0 + k / 120 * span, yOf(eqAt(EQ_H0 + k * 3)));
    c.strokeStyle = OP.white; c.lineWidth = 3; c.stroke();
    for (k = 0; k < 48; k++) { c.fillStyle = 'hsl(' + Math.round((EQ_H0 + (k + 0.5) * 7.5 + 360) % 360) + ',85%,55%)'; c.fillRect(x0 + k / 48 * span, h - pad * 1.5, span / 48 + 1, pad * 0.7); }
    opSelLast().forEach(function (i) {
      var sel = i === eqSel; c.beginPath(); c.arc(xOf(params['eqH' + i]), yOf(eqAt(params['eqH' + i])), (sel ? 9 : 7) * UK, 0, TAU); c.fillStyle = eqHueCss(i); c.fill();
      if (sel) { c.strokeStyle = OP.white; c.lineWidth = 3; c.stroke(); }
    });
    E.g.setAttribute('aria-valuetext', opValText());
  });
  var near = function (p) { var best = 0, bd = 1e9; for (var i = 0; i < EQ_N; i++) { var d = Math.abs(p[0] - xOf(params['eqH' + i])); d = Math.min(d, span - d); if (d < bd) { bd = d; best = i; } } return best; };
  opTouch(E.g, w, h, function (p, first) { if (first) eqSelect(near(p)); return eqSel; }, near);
}
// Style 6: keys, the curve screen and the white and orange encoders.
function eqOpKeys(C) {
  var wide = C[2] >= C[3], gap = 10 * UK, kg = 6 * UK, K, G, B;
  if (wide) {
    var side = Math.min(C[2] * 0.42, C[3] * 2.2), ec = Math.min(C[3] / 2, 100 * UK);
    K = [C[0], C[1], C[2] - side - gap, C[3] - 4 * UK]; B = [C[0] + C[2] - ec, C[1], ec, C[3]]; G = [K[0] + K[2] + gap, C[1], side - ec - gap, C[3]];
  } else {
    var sh = Math.min(C[2] * 0.62, C[3] * 0.24), eh = Math.min(C[2] / 2, 100 * UK);
    G = [C[0], C[1], C[2], sh]; B = [C[0], C[1] + sh + gap, C[2], eh]; K = [C[0], B[1] + eh + gap, C[2], C[3] - sh - eh - 2 * gap - 4 * UK];
  }
  opEncs(B, ['hue', 'width']);
  var kl = ((wide ? K[2] : K[3]) - (EQ_N - 1) * kg) / EQ_N;
  for (var i = 0; i < EQ_N; i++) opKey(wide ? [K[0] + i * (kl + kg), K[1], kl, K[3]] : [K[0], K[1] + i * (kl + kg), K[2], kl], i, wide);
  opCurve(G, ['hue', 'width']);
}

// Style 7: the dot matrix and the white and orange encoders.
function eqOpDots(C) {
  var wide = C[2] >= C[3], S = opSplit(C, wide ? Math.min(C[3] / 2, 100 * UK) : Math.min(C[2] / 2, 100 * UK));
  opEncs(S[1], ['hue', 'width']);
  var E = opScreen(S[0], 'Colors EQ dots: tap or sweep the dots to set each band, 0 to 2x in quarter steps'), w = E.w, h = E.h, fs = 18 * UL, pad = 14 * UK;
  var A = opAxis(wide, pad, pad * 2 + fs, w - 2 * pad, h - pad * 3 - fs), L = 9;   // slot 0: the band's colour (0x); 1-8: 0.25-2x
  var r = Math.min(A.along / EQ_N, A.across / L) * 0.36;
  var cell = function (p) { var q = A.of(p); return [clamp(Math.floor(q[0] * EQ_N), 0, EQ_N - 1), clamp(Math.round(q[1] * L - 0.5), 0, L - 1)]; };
  ui.eqParts.push(function () {
    var c = E.x; c.clearRect(0, 0, w, h);
    opStatus(c, pad, pad + fs / 2, fs, w - 2 * pad, ['hue', 'width']);
    for (var i = 0; i < EQ_N; i++) {
      var g = params['eqG' + i], hue = eqHueCss(i), a = (i + 0.5) / EQ_N;
      if (i === eqSel) { var p0 = A.at(i / EQ_N, 1), p1 = A.at((i + 1) / EQ_N, 0); c.strokeStyle = OP.dim; c.lineWidth = 2; c.strokeRect(Math.min(p0[0], p1[0]) + 3, Math.min(p0[1], p1[1]) + 3, Math.abs(p1[0] - p0[0]) - 6, Math.abs(p1[1] - p0[1]) - 6); }
      var q = A.at(a, 0.5 / L); c.fillStyle = hue; c.fillRect(q[0] - r * 0.8, q[1] - r * 0.8, r * 1.6, r * 1.6);
      for (var lv = 1; lv < L; lv++) {
        var pt = A.at(a, (lv + 0.5) / L), on = clamp((g - (lv - 1) * 0.25) / 0.25, 0, 1);
        c.beginPath(); c.arc(pt[0], pt[1], r, 0, TAU); c.fillStyle = '#1c1c1f'; c.fill();
        if (on > 0) { c.globalAlpha = on; c.fillStyle = hue; c.fill(); c.globalAlpha = 1; }
        if (lv === 4) { c.strokeStyle = OP.white; c.lineWidth = 2; c.stroke(); }   // the 1x dot
      }
    }
    E.g.setAttribute('aria-valuetext', opValText());
  });
  opTouch(E.g, w, h, function (p, first) { var t = cell(p); if (first || t[0] !== eqSel) eqSelect(t[0]); params['eqG' + t[0]] = t[1] * 0.25; return t[0]; }, function (p) { return cell(p)[0]; });
}

// Style 8: arc gauges and the white and orange encoders.
function eqOpDials(C) {
  var wide = C[2] >= C[3], S = opSplit(C, wide ? Math.min(C[3] / 2, 100 * UK) : Math.min(C[2] / 2, 100 * UK));
  opEncs(S[1], ['hue', 'width']);
  var E = opScreen(S[0], 'Colors EQ dials: drag a dial up or down for its saturation; the arc in its foot is its width'), w = E.w, h = E.h, fs = 18 * UL, pad = 14 * UK;
  var R = [pad, pad * 2 + fs, w - 2 * pad, h - pad * 3 - fs], best = { s: 0 }, ctr = [], held = 0, ly = 0;
  for (var cols = 1; cols <= EQ_N; cols++) { var rows = Math.ceil(EQ_N / cols), s = Math.min(R[2] / cols, R[3] / rows); if (s > best.s) best = { s: s, cols: cols, rows: rows }; }
  var cw = R[2] / best.cols, rh = R[3] / best.rows, rad = Math.min(cw * 0.4, rh * 0.34), a0 = Math.PI * 0.75;
  for (var i = 0; i < EQ_N; i++) {
    var row = Math.floor(i / best.cols), inRow = Math.min(best.cols, EQ_N - row * best.cols);
    ctr.push([R[0] + (R[2] - inRow * cw) / 2 + cw * (i - row * best.cols + 0.5), R[1] + rh * (row + 0.5)]);
  }
  ui.eqParts.push(function () {
    var c = E.x; c.clearRect(0, 0, w, h);
    opStatus(c, pad, pad + fs / 2, fs, w - 2 * pad, ['hue', 'width']);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (var i = 0; i < EQ_N; i++) {
      var p = ctr[i], g = params['eqG' + i], hue = eqHueCss(i), sp = params['eqW' + i] / EQ_WIDTH.max * Math.PI * 0.2;
      if (i === eqSel) { c.beginPath(); c.arc(p[0], p[1], rad * 0.74, 0, TAU); c.fillStyle = OP.faint; c.fill(); c.strokeStyle = OP.white; c.lineWidth = 2; c.stroke(); }
      c.lineCap = 'round';
      c.beginPath(); c.arc(p[0], p[1], rad, a0, a0 + Math.PI * 1.5); c.strokeStyle = 'rgba(240,240,236,0.14)'; c.lineWidth = rad * 0.16; c.stroke();
      if (g > 0) { c.beginPath(); c.arc(p[0], p[1], rad, a0, a0 + Math.PI * 1.5 * g / 2); c.strokeStyle = hue; c.lineWidth = rad * 0.2; c.stroke(); }
      c.beginPath(); c.arc(p[0], p[1], rad, Math.PI / 2 - sp, Math.PI / 2 + sp); c.strokeStyle = OP.orange; c.lineWidth = rad * 0.08; c.stroke();
      c.lineCap = 'butt';
      c.strokeStyle = OP.white; c.lineWidth = 2; c.beginPath(); c.moveTo(p[0], p[1] - rad * 1.18); c.lineTo(p[0], p[1] - rad * 1.36); c.stroke();   // 1x
      c.fillStyle = OP.white; c.font = '700 ' + rad * 0.4 + 'px ' + OP_FONT; c.fillText(g.toFixed(2), p[0], p[1] - rad * 0.05);
      c.fillStyle = hue; c.font = '800 ' + rad * 0.26 + 'px ' + OP_FONT; c.fillText(EQ_NAMES[i].slice(0, 3).toUpperCase(), p[0], p[1] + rad * 0.4);
    }
    E.g.setAttribute('aria-valuetext', opValText());
  });
  var near = function (q) { var b = 0, bd = 1e9; ctr.forEach(function (p, j) { var d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; b = j; } }); return b; };
  opTouch(E.g, w, h, function (p, first) {
    if (first) { held = near(p); eqSelect(held); } else opGain(held, (ly - p[1]) / (rad * 5) * 2);
    ly = p[1]; return held;
  }, near);
}

// Style 9: the flower, its value list and the four encoders.
function eqOpBloom(C) {
  var wide = C[2] >= C[3], S = opSplit(C, wide ? Math.min(C[2] * 0.4, C[3] * 2.4) : Math.min(C[2], C[3] * 0.34));
  opEncs(S[1], ['band', 'gain', 'hue', 'width']);
  var E = opScreen(S[0], 'Colors EQ bloom: drag a petal tip around for its hue, in or out for its saturation; tap a row of the list to pick a band'), w = E.w, h = E.h, pad = 14 * UK;
  var side = w >= h, F = side ? h : w, li = side ? [F, pad, w - F - pad, h - 2 * pad] : [pad, F, w - 2 * pad, h - F - pad];
  var cx0 = F / 2, cy0 = F / 2, rIn = F * 0.07, rMax = F * 0.44, rowH = li[3] / EQ_N, fs = Math.min(rowH * 0.5, 18 * UL);
  var ang = function (hu) { return hu / 360 * TAU - Math.PI / 2; }, rOf = function (g) { return rIn + Math.min(2, g) / 2 * (rMax - rIn); };
  var tip = function (i) { var a = ang(params['eqH' + i]), r = rOf(params['eqG' + i]); return [cx0 + r * Math.cos(a), cy0 + r * Math.sin(a)]; };
  var inList = function (p) { return side ? p[0] >= F : p[1] >= F; };
  ui.eqParts.push(function () {
    var c = E.x; c.clearRect(0, 0, w, h);
    c.strokeStyle = OP.dim; c.lineWidth = 2; c.setLineDash([4, 6]); c.beginPath(); c.arc(cx0, cy0, rOf(1), 0, TAU); c.stroke(); c.setLineDash([]);
    opSelLast().forEach(function (i) {
      var a = ang(params['eqH' + i]), r = rOf(params['eqG' + i]), sp = Math.min(1.1, params['eqW' + i] / 180 * Math.PI * 1.4), hue = eqHueCss(i), sel = i === eqSel, k = r * 0.62;
      var T = tip(i), b0 = [cx0 + rIn * 0.6 * Math.cos(a), cy0 + rIn * 0.6 * Math.sin(a)];
      c.beginPath(); c.moveTo(b0[0], b0[1]);
      c.quadraticCurveTo(cx0 + k * Math.cos(a - sp), cy0 + k * Math.sin(a - sp), T[0], T[1]);
      c.quadraticCurveTo(cx0 + k * Math.cos(a + sp), cy0 + k * Math.sin(a + sp), b0[0], b0[1]);
      c.globalAlpha = sel ? 0.5 : 0.26; c.fillStyle = hue; c.fill(); c.globalAlpha = 1; c.strokeStyle = hue; c.lineWidth = sel ? 4 : 3; c.stroke();
      c.beginPath(); c.arc(T[0], T[1], F * 0.024, 0, TAU); c.fillStyle = hue; c.fill(); if (sel) { c.strokeStyle = OP.white; c.lineWidth = 3; c.stroke(); }
    });
    c.beginPath(); c.arc(cx0, cy0, rIn, 0, TAU); c.fillStyle = '#000'; c.fill(); c.strokeStyle = OP.white; c.lineWidth = 3; c.stroke();
    c.textBaseline = 'middle'; c.font = '700 ' + fs + 'px ' + OP_FONT;
    for (var i = 0; i < EQ_N; i++) {
      var y = li[1] + rowH * (i + 0.5), sel = i === eqSel;
      if (sel) { c.fillStyle = OP.faint; c.fillRect(li[0], y - rowH / 2 + 2, li[2], rowH - 4); }
      c.fillStyle = eqHueCss(i); c.beginPath(); c.arc(li[0] + fs * 0.6, y, fs * 0.3, 0, TAU); c.fill();
      c.textAlign = 'left'; c.fillStyle = sel ? OP.white : 'rgba(240,240,236,0.6)'; c.fillText(EQ_NAMES[i].toUpperCase(), li[0] + fs * 1.3, y);
      c.textAlign = 'right';
      [['gain', 0.6], ['hue', 0.8], ['width', 1]].forEach(function (t) { c.fillStyle = sel ? OPR[t[0]].col : 'rgba(240,240,236,0.42)'; c.fillText(OPR[t[0]].val(i), li[0] + li[2] * t[1] - fs * 0.3, y); });
    }
    E.g.setAttribute('aria-valuetext', opValText());
  });
  var near = function (p) {
    if (inList(p)) return clamp(Math.floor((p[1] - li[1]) / rowH), 0, EQ_N - 1);
    var b = 0, bd = 1e9; for (var i = 0; i < EQ_N; i++) { var t = tip(i), d = Math.hypot(p[0] - t[0], p[1] - t[1]); if (d < bd) { bd = d; b = i; } } return b;
  };
  var held = 0, p0 = null, moved = false, listTap = false;
  opTouch(E.g, w, h, function (p, first) {
    if (first) { held = near(p); p0 = p; moved = false; listTap = inList(p); eqSelect(held); return held; }
    if (listTap) return held;
    if (!moved && Math.hypot(p[0] - p0[0], p[1] - p0[1]) > 12) moved = true;
    if (moved) { var dx = p[0] - cx0, dy = p[1] - cy0; params['eqH' + held] = opHue(Math.round((Math.atan2(dy, dx) + Math.PI / 2) / TAU * 360)); eqSetGain(held, (Math.hypot(dx, dy) - rIn) / (rMax - rIn) * 2); }
    return held;
  }, near);
}

// Style 10: levels, cables and the hue tape, and the orange encoder.
function eqOpLevels(C) {
  var wide = C[2] >= C[3], S = opSplit(C, wide ? Math.min(C[3] * 0.62, 100 * UK) : Math.min(C[2] * 0.5, 100 * UK));
  opEncs(S[1], ['width']);
  var E = opScreen(S[0], 'Colors EQ levels: sweep the levels for saturation, slide a marker along the hue tape for its hue; the wheel or the orange encoder sets the width'), w = E.w, h = E.h, fs = 18 * UL, pad = 14 * UK;
  var A = opAxis(wide, pad, pad * 2 + fs, w - 2 * pad, h - pad * 3 - fs);
  // Across the level axis: the hue tape (0-0.08), markers and cables (to 0.34), then the levels (0 at 0.34, 2x at 0.98).
  var V0 = 0.34, V1 = 0.98, lv = function (g) { return V0 + Math.min(2, g) / 2 * (V1 - V0); };
  var aHue = function (hu) { return ((((hu - EQ_H0) % 360) + 360) % 360) / 360; }, aBand = function (i) { return (i + 0.5) / EQ_N; };
  var bandAt = function (a) { return clamp(Math.floor(a * EQ_N), 0, EQ_N - 1); };
  var marker = function (a) { var b = 0, bd = 9; for (var i = 0; i < EQ_N; i++) { var d = Math.abs(a - aHue(params['eqH' + i])); d = Math.min(d, 1 - d); if (d < bd) { bd = d; b = i; } } return b; };
  var rect = function (a0, v0, a1, v1) { var p = A.at(a0, v0), q = A.at(a1, v1); return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(q[0] - p[0]) + 1, Math.abs(q[1] - p[1]) + 1]; };
  ui.eqParts.push(function () {
    var c = E.x; c.clearRect(0, 0, w, h);
    opStatus(c, pad, pad + fs / 2, fs, w - 2 * pad, ['width']);
    for (var s0 = 0; s0 < 60; s0++) {   // the tape, greyed where the EQ cuts saturation
      var hu = EQ_H0 + (s0 + 0.5) * 6, k = Math.min(1, eqAt(hu)), R = rect(s0 / 60, 0, (s0 + 1) / 60, 0.08);
      c.fillStyle = 'hsl(' + Math.round((hu + 360) % 360) + ',' + Math.round(85 * k) + '%,' + Math.round(55 - 15 * (1 - k)) + '%)'; c.fillRect(R[0], R[1], R[2], R[3]);
    }
    var r1 = A.at(0, lv(1)), r2 = A.at(1, lv(1));
    c.strokeStyle = OP.dim; c.lineWidth = 2; c.setLineDash([4, 6]); c.beginPath(); c.moveTo(r1[0], r1[1]); c.lineTo(r2[0], r2[1]); c.stroke(); c.setLineDash([]);
    opSelLast().forEach(function (i) {
      var hue = eqHueCss(i), sel = i === eqSel, ah = aHue(params['eqH' + i]), ab = aBand(i);
      var m0 = A.at(ah, 0.12), c1 = A.at(ah, 0.24), c2 = A.at(ab, 0.2), b0 = A.at(ab, V0);
      c.beginPath(); c.moveTo(m0[0], m0[1]); c.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], b0[0], b0[1]);
      c.strokeStyle = hue; c.globalAlpha = sel ? 1 : 0.55; c.lineWidth = sel ? 4 : 3; c.stroke(); c.globalAlpha = 1;
      var t0 = A.at(ah, 0.085), tl = A.at(ah - 0.016, 0.13), tr = A.at(ah + 0.016, 0.13);
      c.beginPath(); c.moveTo(t0[0], t0[1]); c.lineTo(tl[0], tl[1]); c.lineTo(tr[0], tr[1]); c.closePath(); c.fillStyle = hue; c.fill();
      if (sel) { c.strokeStyle = OP.white; c.lineWidth = 2; c.stroke(); }
      var s1 = A.at(ab, lv(params['eqG' + i])), rr = (0.3 + params['eqW' + i] / EQ_WIDTH.max * 0.7) * Math.min(A.along / EQ_N * 0.3, A.across * 0.08);
      c.beginPath(); c.moveTo(b0[0], b0[1]); c.lineTo(s1[0], s1[1]); c.strokeStyle = OP.white; c.lineWidth = 3; c.stroke();
      c.beginPath(); c.arc(s1[0], s1[1], rr, 0, TAU); c.fillStyle = hue; c.fill(); c.strokeStyle = sel ? OP.white : '#000'; c.lineWidth = 3; c.stroke();
    });
    E.g.setAttribute('aria-valuetext', opValText());
  });
  var onTape = false, held = 0, a0 = 0, h0 = 0;
  opTouch(E.g, w, h, function (p, first) {
    var q = A.of(p);
    if (first) { onTape = q[1] < 0.2; held = onTape ? marker(q[0]) : bandAt(q[0]); a0 = q[0]; h0 = params['eqH' + held]; eqSelect(held); if (onTape) return held; }
    if (onTape) { params['eqH' + held] = opHue(Math.round(h0 + (q[0] - a0) * 360)); return held; }
    var i = bandAt(q[0]); if (i !== eqSel) eqSelect(i);
    eqSetGain(i, (q[1] - V0) / (V1 - V0) * 2); return i;
  }, function (p) { var q = A.of(p); return q[1] < 0.2 ? marker(q[0]) : bandAt(q[0]); });
}

// A grey pad (side s) for band i at (x, y): a disc in the band's colour, its size the gain (the printed ring is 1x)
// and its glow the width. Tap steps the gain through 1, 1.5, 2, 0 and 0.5x; drag up or down for any level.
var OP_PAD_STEPS = [1, 1.5, 2, 0, 0.5];
function opPad(x, y, s, i) {
  var t = el('div', at(x, y, s, s) + ';border-radius:' + 6 * UK + 'px;cursor:pointer;touch-action:none;transition:transform 40ms');
  t.setAttribute('role', 'slider'); t.tabIndex = 0; t.setAttribute('aria-label', EQ_NAMES[i] + ' saturation pad');
  var disc = el('div', 'position:absolute;left:50%;top:50%;border-radius:50%;pointer-events:none', t), rs = s * 0.41;
  el('div', 'position:absolute;left:50%;top:50%;width:' + rs + 'px;height:' + rs + 'px;margin:' + -rs / 2 + 'px 0 0 ' + -rs / 2 + 'px;border-radius:50%;box-sizing:border-box;border:' +
    Math.max(1, 1.5 * UK) + 'px solid rgba(40,40,46,0.5);pointer-events:none', t);
  el('span', 'position:absolute;left:' + s * 0.09 + 'px;top:' + s * 0.09 + 'px;' + PRINT(Math.max(8, s * 0.11), '#5a5a5f') + ';pointer-events:none', t, EQ_NAMES[i][0]);
  ui.eqParts.push(function () {
    var g = params['eqG' + i], d = g / 2 * s * 0.82, c = eqHueCss(i), sel = i === eqSel;
    disc.style.width = disc.style.height = d + 'px'; disc.style.margin = -d / 2 + 'px 0 0 ' + -d / 2 + 'px';
    disc.style.background = c; disc.style.boxShadow = '0 0 ' + (params['eqW' + i] / EQ_WIDTH.max * s * 0.24).toFixed(1) + 'px ' + c;
    t.style.background = sel ? 'linear-gradient(#d6d6d3,#c6c6c3)' : 'linear-gradient(#f1f1ef,#dadad7)';
    t.style.boxShadow = sel ? '0 1px 0 #8a8a8d,0 2px 3px rgba(0,0,0,0.3),inset 0 1px 3px rgba(0,0,0,0.15)' : '0 3px 0 #98989b,0 5px 8px rgba(0,0,0,0.35),inset 0 1px 0 #fff';
    t.style.transform = sel ? 'translateY(2px)' : '';
    t.setAttribute('aria-valuetext', g.toFixed(2) + '×');
  });
  t.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); t.setPointerCapture(e.pointerId); dragging = true;
    var y0 = e.clientY, ly = y0, moved = false, k = stageScale();
    eqSelect(i); eqTip(t, i);
    var mv = function (ev) { if (!moved && Math.abs(ev.clientY - y0) / k > 6) moved = true; if (moved) { opGain(i, (ly - ev.clientY) / k / s * 2); eqRefresh(); eqTip(t, i); } ly = ev.clientY; };
    var end = function (ev) {
      dragging = false; hideTip(); t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', end); t.removeEventListener('pointercancel', end);
      if (moved || ev.type !== 'pointerup') return;
      var g = params['eqG' + i], j = 0; OP_PAD_STEPS.forEach(function (v, n) { if (Math.abs(v - g) < Math.abs(OP_PAD_STEPS[j] - g)) j = n; });
      params['eqG' + i] = OP_PAD_STEPS[(j + 1) % OP_PAD_STEPS.length]; eqRefresh(); flashTip(t, eqTipText(i));
    };
    t.addEventListener('pointermove', mv); t.addEventListener('pointerup', end); t.addEventListener('pointercancel', end);
  });
  var nudge = function (d) { opGain(i, d); eqSelect(i); eqTip(t, i); };
  t.addEventListener('wheel', function (e) { e.preventDefault(); nudge(e.deltaY > 0 ? -0.05 : 0.05); }, { passive: false });
  t.addEventListener('keydown', function (e) { var d = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key]; if (d) { e.preventDefault(); nudge(d); } });
  t.addEventListener('dblclick', function () { params['eqG' + i] = 1; eqSelect(i); eqTip(t, i); });
  t.addEventListener('pointerleave', function () { if (!dragging) hideTip(); });
}
// Style 11: the status strip, the pads (in whichever grid makes them largest) and the white and orange encoders.
function eqOpPads(C) {
  var wide = C[2] >= C[3], gap = 10 * UK, pg = 10 * UK, S = opSplit(C, wide ? Math.min(C[3] / 2, 100 * UK) : Math.min(C[2] / 2, 100 * UK));
  opEncs(S[1], ['hue', 'width']);
  var K = S[0], sh = Math.min(K[3] * 0.22, 40 * UK);
  opStrip([K[0], K[1], K[2], sh], ['hue', 'width']);
  K = [K[0], K[1] + sh + gap, K[2], K[3] - sh - gap - 6 * UK];
  var best = { s: 0 };
  for (var cols = 1; cols <= EQ_N; cols++) { var rows = Math.ceil(EQ_N / cols), s = Math.min((K[2] - (cols - 1) * pg) / cols, (K[3] - (rows - 1) * pg) / rows); if (s > best.s) best = { s: s, cols: cols, rows: rows }; }
  var s = best.s, y0 = K[1] + (K[3] - best.rows * s - (best.rows - 1) * pg) / 2;
  for (var i = 0; i < EQ_N; i++) {
    var row = Math.floor(i / best.cols), inRow = Math.min(best.cols, EQ_N - row * best.cols), x0 = K[0] + (K[2] - inRow * s - (inRow - 1) * pg) / 2;
    opPad(x0 + (i - row * best.cols) * (s + pg), y0 + row * (s + pg), s, i);
  }
}

// Style 12: Gain / Hue / Width keys, a readout screen and an encoder per band.
function eqOpSeven(C) {
  var wide = C[2] >= C[3], gap = 10 * UK, keys = [], R, G, cell;
  var kw = Math.max(70 * UK, textW('Width', 10 * UL, 700, 0.08) + 24 * UL), kh = Math.min(34 * UK, wide ? (C[3] - 2 * gap) / 3 : 34 * UK);
  ['Gain', 'Hue', 'Width'].forEach(function (n, j) {
    var x = wide ? C[0] : C[0] + j * (C[2] + gap) / 3, y = wide ? C[1] + (C[3] - 3 * kh - 2 * gap) / 2 + j * (kh + gap) : C[1];
    keys.push(key(x, y, wide ? kw : (C[2] - 2 * gap) / 3, kh, n, 'off', { fs: 9 * UL, aria: 'Colors EQ encoders turn ' + n.toLowerCase(),
      onClick: function () { opMode = j; eqRefresh(); } }));
  });
  ui.eqParts.push(function () { keys.forEach(function (k, j) { var on = j === opMode; k.set(on ? 'on' : 'off'); k.txt.style.color = on ? OPR[OP_MODES[j]].col : P.inkMute; }); });
  if (wide) {
    R = [C[0] + kw + gap, C[1], C[2] - kw - gap, C[3]]; G = [R[0], R[1], R[2], R[3] * 0.42];
    var cw = R[2] / EQ_N, eh = R[3] - G[3] - gap, d = Math.min(56 * UK, cw - 22, eh - 14);
    cell = function (i) { return [i / EQ_N, 0, 1 / EQ_N, 1]; };
    for (var i = 0; i < EQ_N; i++) opSevenEnc(R[0] + cw * (i + 0.5), G[1] + G[3] + gap + eh / 2, d, i);
  } else {
    R = [C[0], C[1] + kh + gap, C[2], C[3] - kh - gap];
    var rh = R[3] / EQ_N, ec = Math.min(rh, C[2] * 0.42), d2 = Math.min(56 * UK, ec - 22, rh - 14);
    G = [R[0], R[1], R[2] - ec - gap, R[3]];
    cell = function (i) { return [0, i / EQ_N, 1, 1 / EQ_N]; };
    for (var j = 0; j < EQ_N; j++) opSevenEnc(R[0] + R[2] - ec / 2, R[1] + rh * (j + 0.5), d2, j);
  }
  var E = opScreen(G, 'Colors EQ readouts: each band’s gain, hue or width, as the Gain, Hue and Width keys pick'), w = E.w, h = E.h, pad = 10 * UK;
  ui.eqParts.push(function () {
    var c = E.x, mode = OP_MODES[opMode], mc = OPR[mode].col; c.clearRect(0, 0, w, h);
    for (var i = 0; i < EQ_N; i++) {
      var q = cell(i), x = q[0] * w + pad, y = q[1] * h + pad, cw2 = q[2] * w - 2 * pad, ch = q[3] * h - 2 * pad, hue = eqHueCss(i), fs = Math.min(ch * 0.3, cw2 * 0.2, 18 * UL);
      if (i === eqSel) { c.fillStyle = OP.faint; c.fillRect(x - pad * 0.6, y - pad * 0.6, cw2 + pad * 1.2, ch + pad * 1.2); }
      c.font = '800 ' + fs + 'px ' + OP_FONT; c.textBaseline = 'top';
      c.textAlign = 'left'; c.fillStyle = hue; c.fillText(EQ_NAMES[i].slice(0, 3).toUpperCase(), x, y);
      c.textAlign = 'right'; c.fillStyle = mc; c.font = '700 ' + fs + 'px ' + OP_FONT; c.fillText(OPR[mode].val(i), x + cw2, y);
      var gy = y + fs * 1.5, gh = ch - fs * 1.5, mid = gy + gh / 2;
      if (mode === 'gain') {
        var bh = Math.max(4, gh * 0.34), g = params['eqG' + i];
        c.fillStyle = 'rgba(240,240,236,0.14)'; c.fillRect(x, mid - bh / 2, cw2, bh); c.fillStyle = hue; c.fillRect(x, mid - bh / 2, cw2 * g / 2, bh);
        c.fillStyle = OP.white; c.fillRect(x + cw2 / 2 - 1, mid - bh * 0.9, 2, bh * 1.8);
      } else if (mode === 'hue') {
        var th = Math.max(4, gh * 0.22);
        for (var k = 0; k < 24; k++) { c.fillStyle = 'hsl(' + k * 15 + ',85%,55%)'; c.fillRect(x + k / 24 * cw2, mid - th / 2, cw2 / 24 + 1, th); }
        var px = x + (params['eqH' + i] % 360) / 360 * cw2;
        c.beginPath(); c.moveTo(px, mid - th / 2 - 2); c.lineTo(px - th * 0.8, mid - th / 2 - th * 1.3); c.lineTo(px + th * 0.8, mid - th / 2 - th * 1.3); c.closePath(); c.fillStyle = OP.white; c.fill();
      } else {
        var sd = params['eqW' + i] / EQ_WIDTH.max * cw2 * 0.4;
        c.beginPath(); for (k = 0; k <= 40; k++) { var dx = (k / 40 - 0.5) * cw2; c[k ? 'lineTo' : 'moveTo'](x + cw2 / 2 + dx, gy + gh - gh * 0.9 * Math.exp(-0.5 * (dx / sd) * (dx / sd))); }
        c.strokeStyle = hue; c.lineWidth = 3; c.stroke();
      }
    }
    E.g.setAttribute('aria-valuetext', opValText());
  });
}
// One of style 12's encoders: band i, capped in its colour, turning what the mode keys pick.
function opSevenEnc(cx, cy, d, i) {
  var role = function () { return OPR[OP_MODES[opMode]]; };
  opEnc(cx, cy, d, function () { return eqHueCss(i); }, EQ_NAMES[i] + ' encoder', {
    turn: function (n) { eqSel = i; role().turn(i, n); }, reset: function () { role().reset(i); },
    tip: function () { return EQ_NAMES[i] + ' ' + role().name.toLowerCase() + '  ' + role().val(i); } });
}

// Modulation window (Advanced page): four LFO channels, each with a Wave screen (tap it to step through Sine, Tri,
// Saw, Square and S&H; the wheel and arrow keys step too) showing the wave and where the LFO is in its cycle, Speed and
// Depth knobs, and a Target key naming the knob it drives (tap it to pick one on the Main page, pickLfo). Keys 1-4 on
// the window's edge pick how the channels are laid out (lfoStyle):
// 1 Rows: one channel per row, Wave, Speed, Depth and Target left to right (Target under Wave when the row is narrow).
// 2 Columns: one channel per column, Wave, Speed, Depth and Target top to bottom.
// 3 Grid: the channels as 2 x 2 tiles, Wave over the two knobs over Target (wide tiles: Wave and Target left, knobs
//   right).
// 4 Matrix: a table with one row per feature, labelled Wave / Speed / Depth / Target, and one column per channel (in a
//   wide window turned: a column per feature under a header, a row per channel); the knobs drop their own labels.
function buildLfo(b, m) {
  secBox(b, 'Modulation', 'chroma');
  ui.lfoWave = []; ui.lfoTarget = [];
  var fk = frameKeys(b, m, 'Modulation', LFO_STYLES, lfoStyle, function (i) { pickStyle('vfv-mod-style', i, LFO_STYLES, function (v) { lfoStyle = v; }, function () { return ui.lfoKeys; }); });
  ui.lfoKeys = fk.keys;
  var C = [b[0] + m, fk.top, b[2] - 2 * m, b[1] + b[3] - m - fk.top], g = 10 * UK, i;
  for (i = 0; i < LFO_N; i++) {
    if (lfoStyle === 0) { var rh = (C[3] - 3 * g) / LFO_N; lfoCell(i, [C[0], C[1] + i * (rh + g), C[2], rh], 'row'); }
    else if (lfoStyle === 1) { var cw = (C[2] - 3 * g) / LFO_N; lfoCell(i, [C[0] + i * (cw + g), C[1], cw, C[3]], 'col'); }
    else if (lfoStyle === 2) { var tw = (C[2] - g) / 2, th = (C[3] - g) / 2; lfoCell(i, [C[0] + (i % 2) * (tw + g), C[1] + Math.floor(i / 2) * (th + g), tw, th], 'tile'); }
  }
  if (lfoStyle === 3) lfoMatrix(C);
  syncers.push(syncLfo); syncLfo();
}
// Size of a Speed or Depth knob whose ring fits wRoom across and whose ring and label (none when bare) fit hRoom down.
function lfoKnobSize(wRoom, hRoom, bare) { var lab = bare ? 0 : 10 * UL + 3; return Math.max(16, Math.min(42 * UK, wRoom - 20, hRoom - 20 - lab)); }
function lfoKnob(i, which, x, y, ks, bare) {
  var id = 'lfo' + i + which;
  makeItem(id, x, y, ks, { fam: 'chroma' });
  if (bare) ui.knobs[id].ring.parentNode.lastChild.style.display = 'none';
}
// One channel in the box r = [x, y, w, h], laid out as 'row', 'col' or 'tile' (see buildLfo), on a faint plate.
function lfoCell(i, r, mode) {
  el('div', at(r[0], r[1], r[2], r[3]) + ';box-sizing:border-box;border-radius:5px;background:rgba(0,0,0,0.07);box-shadow:inset 0 0 0 1px rgba(0,0,0,0.13);pointer-events:none');
  var p = 6 * UK, g = 8 * UK, kh = 28 * UK, lab = 10 * UL + 3, x = r[0] + p, y = r[1] + p, w = r[2] - 2 * p, h = r[3] - 2 * p, ks, R, ew, waveW, waveH;
  if (mode === 'row') {
    ks = lfoKnobSize(1e9, h, false); R = ks / 2 + 10; ew = Math.max(2 * R, textW('Speed', 10 * UL, 700, 0.1));
    var cy = y + (h - lab) / 2, tw = Math.max(90 * UK, w * 0.26);
    waveW = Math.min(w * 0.3, Math.max(70 * UK, h * 1.3));
    if (waveW + 2 * ew + tw + 3 * g <= w) {   // Wave | Speed | Depth | Target
      var xs = spread(x, x + w, [waveW, ew, ew, tw]);
      makeLfoWave(i, xs[0], y, waveW, h);
      lfoKnob(i, 'Rate', xs[1] + ew / 2, cy, ks); lfoKnob(i, 'Depth', xs[2] + ew / 2, cy, ks);
      makeLfoTarget(i, xs[3], y + (h - kh) / 2, tw, kh);
    } else {   // Wave over Target | Speed | Depth
      waveW = w - 2 * ew - 2 * g; var xs2 = spread(x, x + w, [waveW, ew, ew]);
      makeLfoWave(i, x, y, waveW, h - kh - g);
      makeLfoTarget(i, x, y + h - kh, waveW, kh);
      lfoKnob(i, 'Rate', xs2[1] + ew / 2, cy, ks); lfoKnob(i, 'Depth', xs2[2] + ew / 2, cy, ks);
    }
  } else if (mode === 'col') {
    waveH = Math.min(w * 0.9, h * 0.2);
    ks = lfoKnobSize(w, (h - waveH - kh - 3 * g) / 2, false); R = ks / 2 + 10;
    var ys = spread(y, y + h, [waveH, 2 * R + lab, 2 * R + lab, kh]);
    makeLfoWave(i, x, ys[0], w, waveH);
    lfoKnob(i, 'Rate', x + w / 2, ys[1] + R, ks); lfoKnob(i, 'Depth', x + w / 2, ys[2] + R, ks);
    makeLfoTarget(i, x, ys[3], w, kh);
  } else if (w > 1.6 * h) {   // wide tile: Wave over Target on the left, the knobs side by side on the right
    var lw = w * 0.46, rw = w - lw - g;
    ks = lfoKnobSize(rw / 2, h, false); R = ks / 2 + 10;
    makeLfoWave(i, x, y, lw, h - kh - g);
    makeLfoTarget(i, x, y + h - kh, lw, kh);
    var kx = spread(x + lw + g, x + w, [2 * R, 2 * R]), ky = y + (h - lab) / 2;
    lfoKnob(i, 'Rate', kx[0] + R, ky, ks); lfoKnob(i, 'Depth', kx[1] + R, ky, ks);
  } else {   // tile: Wave over the knobs over Target
    waveH = Math.min(h * 0.32, w * 0.6);
    ew = textW('Speed', 10 * UL, 700, 0.1) + 6 * UK;
    ks = lfoKnobSize(Math.min(w / 2, ew + 20), h - waveH - kh - 2 * g, false); R = ks / 2 + 10; ew = Math.max(ew, 2 * R);
    var ty = spread(y, y + h, [waveH, 2 * R + lab, kh]), kx2 = spread(x, x + w, [ew, ew]);
    makeLfoWave(i, x, ty[0], w, waveH);
    lfoKnob(i, 'Rate', kx2[0] + ew / 2, ty[1] + R, ks); lfoKnob(i, 'Depth', kx2[1] + ew / 2, ty[1] + R, ks);
    makeLfoTarget(i, x, ty[2], w, kh);
  }
}
// Style 4: the table. Labels are knob-label so the Style Lab colours them.
function lfoMatrix(C) {
  var kh = 28 * UK, g = 8 * UK, names = ['Wave', 'Speed', 'Depth', 'Target'], i;
  var label = function (t, cx, cy, w) { var l = cl(cx, cy - 5 * UL, w, t, LABEL()); l.className = 'knob-label'; l.dataset.fam = 'chroma'; };
  if (C[3] > C[2]) {   // a row per feature, a column per channel
    var lw = textW('Target', 10 * UL, 700, 0.1) + 12 * UK, cw = (C[2] - lw - 3 * g) / LFO_N, ks = lfoKnobSize(cw, 42 * UK + 20, true), ring = ks + 20;
    var waveH = Math.min(cw * 0.9, C[3] * 0.22), ys = spread(C[1], C[1] + C[3], [waveH, ring, ring, kh]), mid = [waveH, ring, ring, kh].map(function (v, k) { return ys[k] + v / 2; });
    names.forEach(function (n, k) { label(n, C[0] + lw / 2, mid[k], lw); });
    for (i = 0; i < LFO_N; i++) {
      var x = C[0] + lw + i * (cw + g);
      makeLfoWave(i, x, ys[0], cw, waveH);
      lfoKnob(i, 'Rate', x + cw / 2, mid[1], ks, true); lfoKnob(i, 'Depth', x + cw / 2, mid[2], ks, true);
      makeLfoTarget(i, x, ys[3], cw, kh);
    }
  } else {   // a column per feature under a header, a row per channel
    var hh = 12 * UL, rh = (C[3] - hh - g - 3 * g) / LFO_N, ks2 = lfoKnobSize(rh, rh, true), ring2 = ks2 + 20;
    var waveW = Math.min(rh * 2, C[2] * 0.3), tw = Math.max(90 * UK, (C[2] - waveW - 2 * ring2) * 0.45);
    var xs = spread(C[0], C[0] + C[2], [waveW, ring2, ring2, tw]), widths = [waveW, ring2, ring2, tw];
    names.forEach(function (n, k) { label(n, xs[k] + widths[k] / 2, C[1] + hh / 2, Math.max(widths[k], 60 * UL)); });
    for (i = 0; i < LFO_N; i++) {
      var y = C[1] + hh + g + i * (rh + g), cy = y + rh / 2;
      makeLfoWave(i, xs[0], y, waveW, rh);
      lfoKnob(i, 'Rate', xs[1] + ring2 / 2, cy, ks2, true); lfoKnob(i, 'Depth', xs[2] + ring2 / 2, cy, ks2, true);
      makeLfoTarget(i, xs[3], cy - kh / 2, tw, kh);
    }
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
function createFBO(w, h) {
  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
  return vec4(texture(u_camera, uv).rgb, u_cameraOn);
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

  vec4 prev = texture(u_prevFrame, fract(fbUV));
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
  result.a = 1.0;

  fragColor = result;
}`;

// The display pass is a plain blit of the feedback FBO to the canvas.
var DISPLAY_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_frame;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  fragColor = texture(u_frame, v_uv);
}`;

var FEEDBACK_UNIFORMS = [
  'u_prevFrame', 'u_resolution', 'u_time',
  'u_feedback', 'u_zoom', 'u_rotate', 'u_translate', 'u_hueDrift',
  'u_mix', 'u_frequency', 'u_speed', 'u_sync', 'u_noiseSpeed', 'u_shapeSides', 'u_shapeSmoothing',
  'u_noiseScale', 'u_camera', 'u_cameraAspect', 'u_cameraOn', 'u_cameraMirror',
  'u_hue', 'u_saturate', 'u_brightness', 'u_contrast', 'u_eqBand', 'u_eqOn',
  'u_chromakeyEnabled', 'u_chromakeyColor', 'u_chromakeyThreshold', 'u_chromakeySoftness',
  'u_blendMode', 'u_modulateAmount'
];
var feedbackProgram, displayProgram, feedbackUniforms, displayUniforms;
function linkPrograms() {
  feedbackProgram = linkProgram(VERTEX_SRC, FEEDBACK_FRAGMENT_SRC);
  displayProgram = linkProgram(VERTEX_SRC, DISPLAY_FRAGMENT_SRC);
  feedbackUniforms = uniformLocations(feedbackProgram, FEEDBACK_UNIFORMS);
  displayUniforms = uniformLocations(displayProgram, ['u_frame']);
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
var cameraTexture = createCameraTexture();
var camTexW = 0, camTexH = 0;          // size the camera texture is allocated at (0 = still the 1x1 placeholder)
var camFrameNew = false, camLastTime = -1;
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
  if (!fresh && camTexW) return;
  camFrameNew = false; camLastTime = cameraVideo.currentTime;
  var w = cameraVideo.videoWidth, h = cameraVideo.videoHeight;
  if (!w || !h) return;
  cam.aspect = w / h;
  gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
  if (w === camTexW && h === camTexH) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, cameraVideo);
  else { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cameraVideo); camTexW = w; camTexH = h; }
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
  gl.uniform1f(u.u_cameraAspect, cam.aspect);
  gl.uniform1f(u.u_cameraOn, cam.stream && cameraVideo.readyState >= 2 ? 1 : 0);
  gl.uniform1f(u.u_cameraMirror, cam.facing === 'user' ? 1 : 0);
  gl.uniform1f(u.u_hue, p.hue / 360);
  gl.uniform1f(u.u_saturate, p.saturate);
  gl.uniform1f(u.u_brightness, p.brightness);
  gl.uniform1f(u.u_contrast, p.contrast);
  for (var e = 0; e < EQ_N; e++) { eqVals[3 * e] = p['eqG' + e]; eqVals[3 * e + 1] = p['eqH' + e] / 360; eqVals[3 * e + 2] = p['eqW' + e] / 360; }
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

function renderFeedbackPass(t) {
  // delay=0 reads the most recently completed frame (plain ping-pong);
  // higher delay reads further back. The ring always holds at least
  // delay+2 slots, so the read can never land on the slot being written.
  var p = liveParams(t), delay = Math.round(p.delay);
  ensureHistory(delay);
  var n = buffers.length, writeIndex = ringWriteIndex;
  var readIndex = wrapIndex(writeIndex - 1 - delay, n);
  var write = buffers[writeIndex], read = buffers[readIndex];
  gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
  gl.viewport(0, 0, CW, CH);
  gl.useProgram(feedbackProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, read.tex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
  uploadFeedbackUniforms(t, p);
  drawFullscreenTriangle();
  lastWritten = write;
  ringWriteIndex = wrapIndex(ringWriteIndex + 1, n);
}

function renderDisplayPass() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, CW, CH);
  gl.useProgram(displayProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, lastWritten.tex);
  gl.uniform1i(displayUniforms.u_frame, 0);
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
  buffers = createRingBuffers(2);
  clearScreen();
  cameraTexture = createCameraTexture();
  camTexW = camTexH = 0; camFrameNew = true;
  contextLost = false;
}, false);

// -------------------------------------------------------------
// 8. Header keys, camera keys, fit to window
// -------------------------------------------------------------
function syncCam() {
  if (!ui.camOn) return;
  var live = !!cam.stream || cam.busy;
  ui.camOn.set(live ? 'on' : 'off');
  ui.camFacing.forEach(function (k, i) { k.set(cam.facing === (i ? 'environment' : 'user') ? 'sel' : 'off'); });
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
function presetsKey() {
  if (!presetsOpen) { presetsOpen = true; syncPresetsKey(); renderPresets(); return; }
  savePresetNew();
}
function closePresets() { presetsOpen = false; syncPresetsKey(); renderPresets(); }
function syncPresetsKey() {
  if (!ui.presets) return;
  ui.presets.txt.textContent = presetsOpen ? 'Save' : 'Presets';
  ui.presets.b.setAttribute('aria-label', presetsOpen ? 'Save the current settings as a new preset' : 'Open presets');
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
  Object.keys(params).forEach(function (k) { if (k in p.params) params[k] = p.params[k]; });
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
function syncFullscreen() { if (ui.full) ui.full.set(pseudoFs || currentFullscreenElement() === ui.screen ? 'on' : 'off'); fit(); }
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, lastWritten.fbo);
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
