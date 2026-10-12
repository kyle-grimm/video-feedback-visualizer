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
//   8. Header keys (pause/freeze/reset/random/fullscreen), fit to window
// ===================================================================

var REPORT = [];
window.addEventListener('error', function (e) { REPORT.push('ERROR ' + e.message + ' @' + e.lineno); });

// -------------------------------------------------------------
// 1. Palette and UI kit
// -------------------------------------------------------------
var P = { ink: '#ebebeb', inkDim: '#a6a4a8', inkMute: '#8f8d92', line: '#515053', accent: '#dce8ff', accentGlow: 'rgba(160,195,255,0.8)', accent3: '#af78ed', select: '#eded78',
  rec: '#f0484a', off: '#3d3b40', byp: '#3568b8', tabSub: '#333236', idle: '#77757b' };
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

// Value <-> knob position (0..1), with optional log taper and a snap point (e.g. Zoom snaps to 1, Rotate to 0).
function toV(d, x) {
  if (d.log) return Math.log(x / d.min) / Math.log(d.max / d.min);
  return clamp((x - d.min) / (d.max - d.min));
}
function fromV(d, v) {
  v = clamp(v);
  var x = d.log ? d.min * Math.pow(d.max / d.min, v) : d.min + v * (d.max - d.min);
  if (d.step) x = +(Math.round(x / d.step) * d.step).toFixed(6);
  if (d.snap != null && Math.abs(x - d.snap) < 0.015 * (d.max - d.min)) x = d.snap;
  return clamp(x, d.min, d.max);
}
var steps = function (d) { var n = d.step ? Math.round((d.max - d.min) / d.step) + 1 : 0; return n && n <= 61 ? n : 0; };

// Vertical drag (Shift = fine), wheel, double-click = default.
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
// (a .fam-<fam> fill under the outline) and nameplate colour come from the UI scheme in style.css.
function sec(x, y, w, h, title, fam) {
  if (fam) famFill(fam, x, y, w, h, roundedPath([[0, 0], [w, 0], [w, h], [0, h]]));
  var b = el('div', at(x, y, w, h) + ';box-sizing:border-box;border:1px solid ' + P.inkMute + ';border-radius:3px;pointer-events:none');
  nameplate(b, 12, -9, title, fam);
  return b;
}
function nameplate(parent, x, y, title, fam) {
  var t = el('span', at(x, y) + ';padding:2px 8px;background:' + P.ink + ';color:#19181a;font-size:10px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;line-height:14px;white-space:pre', parent, title);
  if (fam) t.className = 'tab tab-' + fam;
  return t;
}
// Path through right-angled points (clockwise) with 3 px rounded corners, offset by (ox, oy).
function roundedPath(pts, ox, oy) {
  var r = 3, d = '';
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
  f.className = 'fam fam-' + fam;
  return f;
}
// Outlined section of any right-angled shape (points clockwise), corners rounded like sec().
function outline(pts, title, tabX, tabY, fam) {
  var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
  var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys), w = Math.max.apply(null, xs) - x0, h = Math.max.apply(null, ys) - y0;
  if (fam) famFill(fam, x0, y0, w, h, roundedPath(pts, x0, y0));
  var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(w + 2)); svg.setAttribute('height', String(h + 2)); svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = at(x0, y0) + ';overflow:visible;pointer-events:none';
  var path = document.createElementNS(NS, 'path');
  path.setAttribute('d', roundedPath(pts, x0, y0));
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', P.inkMute); path.setAttribute('stroke-width', '1');
  path.setAttribute('transform', 'translate(0.5 0.5)');
  svg.appendChild(path);
  panel.appendChild(svg);
  nameplate(panel, tabX, tabY - 9, title, fam);
}

// Knob scale: n ticks spread over the 270-degree sweep (11 by default; stepped knobs get one tick per position).
function scaleCss(n) {
  var per = 270 / (n - 1);
  return 'position:absolute;inset:0;border-radius:50%;background:repeating-conic-gradient(from -136deg,' + P.inkDim + ' 0deg 2deg,transparent 2deg ' + per + 'deg);' +
    '-webkit-mask:radial-gradient(closest-side,transparent calc(100% - 6px),#000 calc(100% - 5px)),conic-gradient(from -137deg,#000 0deg 274deg,transparent 274deg);-webkit-mask-composite:source-in;' +
    'mask:radial-gradient(closest-side,transparent calc(100% - 6px),#000 calc(100% - 5px)),conic-gradient(from -137deg,#000 0deg 274deg,transparent 274deg);mask-composite:intersect;pointer-events:none';
}
// MS-20 knob centred on (x, y) bound to params[key] through definition PD[key]. o: fs, ticks, after.
var syncers = [];
function knob(x, y, size, label, key, o) {
  o = o || {};
  var d = PD[key], R = size / 2 + 10, S = 2 * R;
  var wrap = el('div', at(x - R - 16, y - R, S + 32) + ';display:flex;flex-direction:column;align-items:center;pointer-events:none');
  var ring = el('div', 'position:relative;flex:none;width:' + S + 'px;height:' + S + 'px;cursor:ns-resize;touch-action:none;pointer-events:auto', wrap);
  ring.setAttribute('role', 'slider'); ring.tabIndex = 0;
  el('div', scaleCss(o.ticks || 11), ring);
  var skirt = el('div', 'position:absolute;left:10px;top:10px;width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:repeating-conic-gradient(#1f1e21 0deg 4deg,#121113 4deg 8deg);box-shadow:0 0 0 1px #050505,0 6px 10px rgba(0,0,0,0.6);pointer-events:none', ring);
  el('div', 'position:absolute;inset:15%;border-radius:50%;background:radial-gradient(circle at 45% 35%,#3b393e 0%,#201f22 60%,#161517 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,0.10)', skirt);
  var ptr = el('div', 'position:absolute;inset:0', skirt);
  el('div', 'position:absolute;left:50%;top:4%;width:2px;height:42%;margin-left:-1px;border-radius:1px;background:' + P.ink, ptr);
  var lab = el('span', 'margin-top:5px;font-size:' + (o.fs || 10) + 'px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:' + P.inkDim + ';white-space:nowrap', wrap, label);
  var k = {
    v: 0, R: R, steps: steps(d), def: toV(d, d.def),
    text: function () { return label + '  ' + d.f(params[key]); },
    show: function (v) { k.v = v; ptr.style.transform = 'rotate(' + (-135 + v * 270) + 'deg)'; ring.setAttribute('aria-valuetext', d.f(params[key])); },
    set: function (v) { var x = fromV(d, v); params[key] = x; k.show(k.steps ? toV(d, x) : clamp(v)); if (o.after) o.after(x); },
    sync: function () { k.show(toV(d, params[key])); ring.setAttribute('aria-label', label); if (o.after) o.after(params[key]); }
  };
  k.sync();
  dragValue(ring, k, 220);
  ring.addEventListener('keydown', function (e) {
    var st = k.steps ? 1 / (k.steps - 1) : 0.01;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { k.set(clamp(k.v + st)); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { k.set(clamp(k.v - st)); e.preventDefault(); }
  });
  syncers.push(k.sync);
  return k;
}

// Rubber key. led: on / sel / rec / off / null. o: glyph, fs, onClick, aria, tint ('blue': no LED, the whole key lights).
var LED = { on: P.accent, sel: P.select, rec: P.rec, off: P.off };
var TINT = {
  blue: { on: ['linear-gradient(to bottom,#5b8fe0,#3568b8)', '0 2px 0 #0f0e10,0 4px 7px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.3)', '#ffffff'],
          off: ['linear-gradient(to bottom,#2e3c55,#222d40)', '0 2px 0 #0f0e10,0 4px 7px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.06)', '#7d8cab'] }
};
function key(x, y, w, h, label, led, o) {
  o = o || {};
  var tint = o.tint ? TINT[o.tint] : null, init = led;
  if (tint) led = null;
  var b = el('button', at(x, y, w, h) + ';box-sizing:border-box;padding:' + (led != null ? '6px' : '0') + ' 0 0;border:none;border-radius:5px;' +
    'background:linear-gradient(to bottom,#49474d,#363439 55%,#2d2c30);box-shadow:0 2px 0 #0f0e10,0 4px 7px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.09);' +
    'display:flex;align-items:center;justify-content:center;font-family:inherit;font-size:' + (o.fs || 10) + 'px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:' + P.ink + ';cursor:pointer;transition:transform 40ms');
  b.type = 'button'; b.setAttribute('aria-label', o.aria || label);
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

// Horizontal fader: a glass slot holding a colour ramp, with a rubber cap. Drag or tap anywhere along it.
function fader(x, y, w, label, key, o) {
  o = o || {};
  var d = PD[key], capW = 16, capH = 30;
  var hit = el('div', at(x, y - capH / 2, w, capH) + ';cursor:ew-resize;touch-action:none');
  hit.setAttribute('role', 'slider'); hit.tabIndex = 0; hit.setAttribute('aria-label', label);
  var slot = el('div', at(0, capH / 2 - 7, w, 14) + ';box-sizing:border-box;padding:3px;border-radius:7px;background:#050406;box-shadow:inset 0 2px 5px rgba(0,0,0,0.9),0 1px 0 rgba(255,255,255,0.06)', hit);
  var ramp = el('div', 'width:100%;height:100%;border-radius:4px', slot);
  var cap = el('div', at(0, 0, capW, capH) + ';box-sizing:border-box;margin-left:-' + (capW / 2) + 'px;border-radius:4px;pointer-events:none;' +
    'background:linear-gradient(to bottom,#49474d,#363439 55%,#2d2c30);box-shadow:0 2px 0 #0f0e10,0 4px 7px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.09)', hit);
  el('div', 'position:absolute;left:50%;top:5px;bottom:5px;width:2px;margin-left:-1px;border-radius:1px;background:' + P.ink, cap);
  cl(x + w / 2, y + capH / 2 + 8, w, label, PRINT(10, P.inkDim));
  var k = {
    v: 0, ramp: ramp, def: toV(d, d.def),
    text: function () { return label + '  ' + d.f(params[key]); },
    show: function (v) { k.v = v; cap.style.left = (capW / 2 + v * (w - capW)) + 'px'; hit.setAttribute('aria-valuetext', d.f(params[key])); },
    set: function (v) { var xv = fromV(d, v); params[key] = xv; k.show(toV(d, xv)); if (o.after) o.after(xv); },
    sync: function () { k.show(toV(d, params[key])); if (o.after) o.after(params[key]); }
  };
  k.sync();
  var fromX = function (cx) { var r = hit.getBoundingClientRect(), cw = capW * r.width / w; return clamp((cx - r.left - cw / 2) / (r.width - cw)); };
  hit.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); hit.setPointerCapture(e.pointerId); dragging = true;
    k.set(fromX(e.clientX)); showTip(cap, k.text());
    var move = function (ev) { k.set(fromX(ev.clientX)); showTip(cap, k.text()); };
    var up = function () { dragging = false; hit.removeEventListener('pointermove', move); hit.removeEventListener('pointerup', up); hit.removeEventListener('pointercancel', up); hideTip(); };
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerup', up); hit.addEventListener('pointercancel', up);
  });
  hit.addEventListener('pointerenter', function () { if (!dragging) showTip(cap, k.text()); });
  hit.addEventListener('pointerleave', function () { if (!dragging) hideTip(); });
  hit.addEventListener('dblclick', function () { k.set(k.def); showTip(cap, k.text()); });
  hit.addEventListener('wheel', function (e) { e.preventDefault(); k.set(clamp(k.v - (e.deltaY > 0 ? 0.01 : -0.01))); showTip(cap, k.text()); }, { passive: false });
  hit.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { k.set(clamp(k.v + 0.01)); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { k.set(clamp(k.v - 0.01)); e.preventDefault(); }
  });
  syncers.push(k.sync);
  return k;
}
function syncUI() { syncers.forEach(function (s) { s(); }); }

// -------------------------------------------------------------
// 2. Parameter definitions + state
// -------------------------------------------------------------
var RING_SIZE = 32; // feedback history slots (see section 4); Delay reaches RING_SIZE - 2 frames back
var BLEND_NAMES = ['Mix', 'Add', 'Mult', 'Diff'];
var sgn = function (v, n) { return (v > 0 ? '+' : '') + v.toFixed(n); };
var deg = function (v) { return Math.round(v) + '°'; };
var pct = function (v) { return Math.round(v * 100) + '%'; };
var PD = {
  // Feedback
  blendMode: { min: 0, max: 3, def: 0, step: 1, f: function (v) { return BLEND_NAMES[v]; } },
  modulateAmount: { min: 0, max: 1, def: 0.15, step: 0.005, f: function (v) { return v < 0.005 ? 'Off' : v.toFixed(3); } },
  feedback: { min: 0, max: 1, def: 0.94, step: 0.005, f: function (v) { return v.toFixed(3); } },
  delay: { min: 0, max: RING_SIZE - 2, def: 0, step: 1, f: function (v) { return v < 0.5 ? 'Live' : v + (v === 1 ? ' frame' : ' frames'); } },
  // Transform (per frame)
  zoom: { min: 0.9, max: 1.1, def: 1.012, step: 0.001, snap: 1, f: function (v) { return v.toFixed(3) + '×'; } },
  rotate: { min: -0.2, max: 0.2, def: 0.012, step: 0.001, snap: 0, f: function (v) { return sgn(v * 180 / Math.PI, 2) + '°'; } },
  translateX: { min: -0.02, max: 0.02, def: 0, step: 0.0005, snap: 0, f: function (v) { return sgn(v * 100, 2) + '%'; } },
  translateY: { min: -0.02, max: 0.02, def: 0, step: 0.0005, snap: 0, f: function (v) { return sgn(v * 100, 2) + '%'; } },
  hueDrift: { min: -0.05, max: 0.05, def: 0.01, step: 0.001, snap: 0, f: function (v) { return sgn(v * 360, 1) + '°'; } },
  // Color
  hue: { min: 0, max: 360, def: 0, step: 1, f: deg },
  saturate: { min: 0, max: 2, def: 1.1, step: 0.01, f: function (v) { return v.toFixed(2) + '×'; } },
  brightness: { min: -1, max: 1, def: 0, step: 0.01, snap: 0, f: function (v) { return sgn(v, 2); } },
  contrast: { min: 0.5, max: 1.5, def: 1.03, step: 0.005, snap: 1, f: function (v) { return v.toFixed(2) + '×'; } },
  invertAmount: { min: 0, max: 1, def: 0, step: 0.01, f: pct },
  // Chromakey (key colour as HSL)
  keyHue: { min: 0, max: 360, def: 120, step: 1, f: deg },
  keySat: { min: 0, max: 1, def: 1, step: 0.01, f: pct },
  keyLight: { min: 0, max: 1, def: 0.5, step: 0.01, f: pct },
  chromakeyThreshold: { min: 0, max: 1.5, def: 0.4, step: 0.01, f: function (v) { return v.toFixed(2); } },
  chromakeySoftness: { min: 0.001, max: 0.5, def: 0.15, step: 0.001, f: function (v) { return v.toFixed(3); } },
  // Layers
  speed: { min: -2, max: 2, def: 0.3, step: 0.01, snap: 0, f: function (v) { return sgn(v, 2); } },
  noiseScale: { min: 0.5, max: 20, def: 4, step: 0.1, f: function (v) { return v.toFixed(1); } },
  shapeSides: { min: 3, max: 12, def: 5, step: 1, f: function (v) { return v + ' sides'; } },
  // Background layer (HSL)
  bgHue: { min: 0, max: 360, def: 270, step: 1, f: deg },
  bgSat: { min: 0, max: 1, def: 0.5, step: 0.01, f: pct },
  bgLight: { min: 0, max: 1, def: 0.12, step: 0.01, f: pct }
};
// Fixed generator settings that no longer have knobs.
var FIXED = { frequency: 8, sync: 0.2, shapeSmoothing: 0.05, noiseSpeed: 0.2 };
var DEFAULTS = { chromakeyEnabled: false, mixX: 0.75, mixY: 0.75 };
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
// 3. Panel layout. 900 x 1440 stage (the layout sketch): the 9:16 screen top-left with the header keys under it, the
// Layers knobs and XY Mix pad below that, the effect knobs in two columns down the right, and the Background HSL faders
// along the bottom.
// -------------------------------------------------------------
var SW = 900, SH = 1440, M = 8;
var LW = 560, RX = M + LW + 16, RW = SW - M - RX;               // left column (screen) and right column (knobs)
var BEZ = [M, 16, LW, 980];                                      // bezel; the canvas inside is 540 x 960 (9:16)
var KEY_Y = 1008, LOW_Y = 1056, LOW_B = 1328, BG_Y = 1344, BG_B = SH - M;
var ROW_Y0 = 8, ROW_P = (LOW_B + 8 - ROW_Y0) / 10;               // ten knob rows on the right
var CW = 720, CH = 1280;                                         // render resolution

var ui = {};
function build() {
  stage.style.width = SW + 'px'; stage.style.height = SH + 'px';

  // Screen: a bezel holding the 9:16 WebGL canvas, no text. Double-click for fullscreen.
  var bez = el('div', at(BEZ[0], BEZ[1], BEZ[2], BEZ[3]) + ';box-sizing:border-box;padding:10px;border-radius:8px;background:#0b0b0c;box-shadow:inset 0 2px 6px rgba(0,0,0,0.9),0 1px 0 rgba(255,255,255,0.06)');
  bez.setAttribute('aria-label', 'Video feedback output');
  ui.screen = el('div', 'position:relative;width:100%;height:100%;border-radius:3px;background:#000;overflow:hidden', bez);
  ui.screen.id = 'screen';
  ui.canvas = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;display:block', ui.screen);
  ui.canvas.width = CW; ui.canvas.height = CH;
  ui.screen.addEventListener('dblclick', toggleFullscreen);

  // Header keys under the screen.
  var kn = 5, kg = 10, kw = (LW - (kn - 1) * kg) / kn, kx = function (i) { return M + i * (kw + kg); };
  ui.pause = key(kx(0), KEY_Y, kw, 28, 'Pause', 'off', { tint: 'blue', aria: 'Pause time', onClick: function () { timePaused = !timePaused; ui.pause.set(timePaused ? 'on' : 'off'); } });
  ui.freeze = key(kx(1), KEY_Y, kw, 28, 'Freeze', 'off', { tint: 'blue', aria: 'Freeze the feedback loop', onClick: function () { frozen = !frozen; ui.freeze.set(frozen ? 'on' : 'off'); } });
  ui.reset = key(kx(2), KEY_Y, kw, 28, 'Reset', null, { aria: 'Reset all controls and clear the screen', onClick: resetAll });
  ui.rand = key(kx(3), KEY_Y, kw, 28, 'Random', null, { aria: 'Randomize', onClick: randomize });
  ui.full = key(kx(4), KEY_Y, kw, 28, 'Full', 'off', { aria: 'Fullscreen', onClick: toggleFullscreen });

  buildLayers();
  buildMix();
  buildRight();
  buildBackground();
  buildSchemeKey();
}

// TEMPORARY: cycles the surface-texture schemes that tell the parameter families apart (see "UI schemes" in
// style.css). Remove this key, the fam classes' CSS for the losing schemes, and data-scheme once one is chosen.
var SCHEMES = [['base', 'Base'], ['plates', 'Plates'], ['hatch', 'Hatch'], ['brushed', 'Brushed'], ['grille', 'Grille']];
function buildSchemeKey() {
  var i = 0;
  try { i = Math.max(0, SCHEMES.map(function (s) { return s[0]; }).indexOf(localStorage.getItem('vfv-ui-scheme'))); } catch (e) { /* storage blocked */ }
  var apply = function () {
    stage.dataset.scheme = SCHEMES[i][0];
    ui.scheme.txt.textContent = 'UI ' + (i + 1) + '/' + SCHEMES.length + ' · ' + SCHEMES[i][1];
    try { localStorage.setItem('vfv-ui-scheme', SCHEMES[i][0]); } catch (e) { /* storage blocked */ }
  };
  ui.scheme = key(BEZ[0] + 18, BEZ[1] + 18, 132, 26, '', null, { fs: 10, aria: 'Cycle UI scheme (temporary)', onClick: function () { i = (i + 1) % SCHEMES.length; apply(); } });
  ui.scheme.b.style.zIndex = '5';
  apply();
}

// Layers: one control per mixer corner, laid out 2 x 2 like the pad beside it.
var PAD = 238;
function buildLayers() {
  var x = M, w = 278, top = LOW_Y + 20;
  sec(x, LOW_Y, w, LOW_B - LOW_Y, 'Layers', 'layers');
  var cx = [x + w / 4, x + 3 * w / 4], cy = [top + PAD / 4, top + 3 * PAD / 4];
  // Camera: On (enable) over a Front / Back pair.
  var bw = 104, bx = cx[0] - bw / 2;
  ui.camOn = key(bx, cy[0] - 34, bw, 26, 'On', 'off', { aria: 'Camera on', onClick: function () { if (cam.stream || cam.busy) stopCamera(); else startCamera(cam.facing); } });
  ui.camFacing = ['user', 'environment'].map(function (f, i) {
    return key(bx + i * (bw / 2 + 2), cy[0] - 2, bw / 2 - 2, 22, i ? 'Back' : 'Front', 'off', { fs: 9, aria: (i ? 'Back' : 'Front') + ' camera', onClick: function () { startCamera(f); } });
  });
  cl(cx[0], cy[0] + 35, 120, 'Camera', 'font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:' + P.inkDim + ';white-space:nowrap');
  syncCam();
  knob(cx[1], cy[0], 40, 'Osc Speed', 'speed');
  knob(cx[0], cy[1], 40, 'Noise Scale', 'noiseScale');
  knob(cx[1], cy[1], 40, 'Shape Sides', 'shapeSides', { ticks: 10, after: drawPad });
}

// Mix: XY pad crossfading the four layers' opacity.
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
function buildMix() {
  var x = M + 278 + 16, w = LW - 278 - 16;
  sec(x, LOW_Y, w, LOW_B - LOW_Y, 'Mix', 'mix');
  ui.pad = glass(x + (w - PAD) / 2, LOW_Y + 20, PAD, PAD, 'Layer mixer: drag to crossfade Camera, Oscillator, Noise and Shape');
  var g = ui.pad.g;
  g.style.cursor = 'crosshair'; g.style.touchAction = 'none';
  g.setAttribute('role', 'slider'); g.tabIndex = 0;
  var setFrom = function (e) {
    var r = g.getBoundingClientRect();
    params.mixX = clamp((e.clientX - r.left) / r.width); params.mixY = clamp(1 - (e.clientY - r.top) / r.height);
    drawPad();
  };
  g.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); g.setPointerCapture(e.pointerId); dragging = true; setFrom(e);
    var up = function () { dragging = false; g.removeEventListener('pointermove', setFrom); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up); };
    g.addEventListener('pointermove', setFrom); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', function () { params.mixX = 0.5; params.mixY = 0.5; drawPad(); });
  g.addEventListener('keydown', function (e) {
    var dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0, dy = { ArrowDown: -1, ArrowUp: 1 }[e.key] || 0;
    if (!dx && !dy) return;
    e.preventDefault(); params.mixX = clamp(params.mixX + dx * 0.02); params.mixY = clamp(params.mixY + dy * 0.02); drawPad();
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
    var ox = (i % 2) * q, oy = Math.floor(i / 2) * q, s = q * 0.5 / 100;
    c.save();
    c.globalAlpha = 0.22 + 0.78 * wt[i];
    c.translate(ox + q * 0.25, oy + q * 0.27); c.scale(s, s);
    c.strokeStyle = ICON_GREEN; c.lineWidth = (i === 2 ? 1.6 : 2.4) / s * 1.2; c.lineJoin = 'round'; c.lineCap = 'round';
    c.shadowColor = 'rgba(63,191,106,0.7)'; c.shadowBlur = 6;
    c.stroke(new Path2D(d));
    c.restore();
    // Corner label and its share of the mix.
    var right = i % 2 === 1, bottom = i > 1, tx = right ? w - 14 : 14;
    c.textAlign = right ? 'right' : 'left';
    c.font = '800 17px "Barlow Semi Condensed", "Segoe UI", sans-serif';
    c.fillStyle = P.inkMute;
    c.fillText(names[i].toUpperCase() + (i === 0 && !cam.stream ? ' (OFF)' : ''), tx, bottom ? h - 34 : 28);
    c.font = '700 19px "Barlow Semi Condensed", "Segoe UI", sans-serif';
    c.fillStyle = P.accent;
    c.fillText(Math.round(wt[i] * 100) + '%', tx, bottom ? h - 12 : 50);
  });
  // Puck with crosshair.
  var px = params.mixX * w, py = (1 - params.mixY) * h;
  c.strokeStyle = 'rgba(220,232,255,0.28)'; c.lineWidth = 2; c.setLineDash([6, 8]);
  c.beginPath(); c.moveTo(px, 0); c.lineTo(px, h); c.moveTo(0, py); c.lineTo(w, py); c.stroke(); c.setLineDash([]);
  c.shadowColor = P.accentGlow; c.shadowBlur = 10;
  c.strokeStyle = P.accent; c.lineWidth = 4;
  c.beginPath(); c.arc(px, py, 16, 0, TAU); c.stroke();
  c.fillStyle = P.accent; c.beginPath(); c.arc(px, py, 5, 0, TAU); c.fill();
  c.shadowBlur = 0;
  p.g.setAttribute('aria-valuetext', names.map(function (n, i) { return n + ' ' + Math.round(wt[i] * 100) + '%'; }).join(', '));
}

// Right column: Feedback, Transform, Color, Chromakey. Transform and Color share row 5 (Hue Drift / Hue), so their
// outlines step around each other there.
function buildRight() {
  var c1 = RX + RW / 4, c2 = RX + 3 * RW / 4, mid = RX + RW / 2, R2 = RX + RW;
  var B = function (k) { return ROW_Y0 + ROW_P * k; }, cy = function (i) { return ROW_Y0 + ROW_P * (i + 0.5); };
  var ks = 42;
  sec(RX, B(0) + 8, RW, B(2) - B(0) - 16, 'Feedback', 'feedback');
  outline([[RX, B(2) + 8], [R2, B(2) + 8], [R2, B(4) - 8], [mid - 8, B(4) - 8], [mid - 8, B(5) - 8], [RX, B(5) - 8]], 'Transform', RX + 12, B(2) + 8, 'transform');
  outline([[mid + 8, B(4) + 8], [R2, B(4) + 8], [R2, B(7) - 8], [RX, B(7) - 8], [RX, B(5) + 8], [mid + 8, B(5) + 8]], 'Color', mid + 20, B(4) + 8, 'color');
  sec(RX, B(7) + 8, RW, B(10) - B(7) - 16, 'Chromakey', 'chroma');

  ui.blend = knob(c1, cy(0), ks, 'Blend Mode', 'blendMode', { ticks: 4, after: syncBlendLegend });
  blendLegend(c1, cy(0), ui.blend.R);
  knob(c2, cy(0), ks, 'Modulate', 'modulateAmount');
  knob(c1, cy(1), ks, 'Persistence', 'feedback');
  knob(c2, cy(1), ks, 'Delay', 'delay');

  knob(c1, cy(2), ks, 'Zoom', 'zoom');
  knob(c2, cy(2), ks, 'Rotate', 'rotate');
  knob(c1, cy(3), ks, 'Shift X', 'translateX');
  knob(c2, cy(3), ks, 'Shift Y', 'translateY');
  knob(c1, cy(4), ks, 'Hue Drift', 'hueDrift');

  knob(c2, cy(4), ks, 'Hue', 'hue');
  knob(c1, cy(5), ks, 'Saturation', 'saturate');
  knob(c2, cy(5), ks, 'Brightness', 'brightness');
  knob(c1, cy(6), ks, 'Contrast', 'contrast');
  knob(c2, cy(6), ks, 'Invert', 'invertAmount');

  ui.keyOn = key(c1 - 36, cy(7) - 14, 72, 28, 'On', 'off', { aria: 'Chromakey on', onClick: function () { params.chromakeyEnabled = !params.chromakeyEnabled; syncKeyOn(); } });
  cl(c1, cy(7) + ks / 2 + 15, 120, 'Enable', 'font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:' + P.inkDim + ';white-space:nowrap');
  syncers.push(syncKeyOn);
  knob(c2, cy(7), ks, 'Key Hue', 'keyHue', { after: syncKeySwatch });
  knob(c1, cy(8), ks, 'Key Sat', 'keySat', { after: syncKeySwatch });
  knob(c2, cy(8), ks, 'Key Light', 'keyLight', { after: syncKeySwatch });
  knob(c1, cy(9), ks, 'Threshold', 'chromakeyThreshold');
  knob(c2, cy(9), ks, 'Softness', 'chromakeySoftness');
  // A chip of the key colour beside the Chromakey nameplate.
  ui.keySwatch = el('span', at(RX + 116, B(7) + 8 - 6, 26, 12) + ';border-radius:2px;box-shadow:0 0 0 1px #050505,inset 0 1px 0 rgba(255,255,255,0.2)');
  syncKeySwatch();
}
function syncKeyOn() { ui.keyOn.set(params.chromakeyEnabled ? 'on' : 'off'); }
function syncKeySwatch() {
  if (!ui.keySwatch) return;
  var c = hslToRgb(params.keyHue, params.keySat, params.keyLight);
  ui.keySwatch.style.background = 'rgb(' + c.map(function (v) { return Math.round(v * 255); }).join(',') + ')';
}
// Blend Mode positions printed around its knob like a rotary switch; tap a name to pick it.
function blendLegend(x, y, R) {
  ui.blendLabs = BLEND_NAMES.map(function (n, i) {
    var a = (-135 + i * 90) * Math.PI / 180, r = R + 7, lx = x + r * Math.sin(a), ly = y - r * Math.cos(a), left = i < 2;
    var s = el('span', at(left ? lx - 40 : lx, ly - 6, 40, 12) + ';text-align:' + (left ? 'right' : 'left') + ';' + PRINT(9) + ';cursor:pointer', panel, n);
    s.addEventListener('click', function () { ui.blend.set(i / 3); });
    return s;
  });
  syncBlendLegend();
}
function syncBlendLegend() {
  if (!ui.blendLabs) return;
  ui.blendLabs.forEach(function (s, i) {
    var on = i === params.blendMode;
    s.style.color = on ? P.accent : P.inkMute; s.style.textShadow = on ? '0 0 6px ' + P.accentGlow : 'none';
  });
}

// Background: the layer under the mix, as Hue / Saturation / Lightness faders.
function buildBackground() {
  sec(M, BG_Y, SW - 2 * M, BG_B - BG_Y, 'Background', 'bg');
  var iw = SW - 2 * M - 48, gap = 40, fw = (iw - 2 * gap) / 3, fy = BG_Y + 34;
  ui.bg = [['Hue', 'bgHue'], ['Saturation', 'bgSat'], ['Lightness', 'bgLight']].map(function (d, i) {
    return fader(M + 24 + i * (fw + gap), fy, fw, d[0], d[1], { after: syncBgRamps });
  });
  syncBgRamps();
}
function syncBgRamps() {
  if (!ui.bg || ui.bg.length < 3) return;
  var h = params.bgHue, s = Math.round(params.bgSat * 100);
  ui.bg[0].ramp.style.background = 'linear-gradient(to right,' + [0, 60, 120, 180, 240, 300, 360].map(function (a) { return 'hsl(' + a + ',100%,50%)'; }).join(',') + ')';
  ui.bg[1].ramp.style.background = 'linear-gradient(to right,hsl(' + h + ',0%,50%),hsl(' + h + ',100%,50%))';
  ui.bg[2].ramp.style.background = 'linear-gradient(to right,#000,hsl(' + h + ',' + s + '%,50%),#fff)';
}

build();

// -------------------------------------------------------------
// 4. WebGL2 boilerplate + ring-buffer framebuffers
// -------------------------------------------------------------
var canvas = ui.canvas;
var gl = canvas.getContext('webgl2', { antialias: false });
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

function createRingBuffers() {
  var list = [];
  for (var i = 0; i < RING_SIZE; i++) list.push(createFBO(CW, CH));
  return list;
}

function wrapIndex(i, n) { return ((i % n) + n) % n; }

var buffers = createRingBuffers();
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

// layers: weights from the XY mixer (camera, osc, noise, shape), plus the background
uniform vec4  u_mix;
uniform vec3  u_bgColor;
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
  vec2 p = (st - 0.5) * vec2(aspect(), 1.0) * u_noiseScale;
  float t = u_time * u_noiseSpeed;
  float nr = snoise(p + vec2(t, 0.0)) * 0.5 + 0.5;
  float ng = snoise(p + vec2(0.0, t) + 5.2) * 0.5 + 0.5;
  float nb = snoise(p + vec2(t * 0.7, t * 0.3) + 9.7) * 0.5 + 0.5;
  return vec4(nr, ng, nb, 1.0);
}

// White polygon; alpha is the shape itself, so the background shows around it.
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

// The four layers crossfaded by the mixer weights; whatever coverage
// they leave (shape's surroundings, an off camera) is the background.
vec4 generate(vec2 st) {
  vec3 acc = vec3(0.0);
  float cov = 0.0;
  vec4 c;
  if (u_mix.x > 0.001) { c = genCamera(st); acc += u_mix.x * c.a * c.rgb; cov += u_mix.x * c.a; }
  if (u_mix.y > 0.001) { c = genOsc(st);    acc += u_mix.y * c.a * c.rgb; cov += u_mix.y * c.a; }
  if (u_mix.z > 0.001) { c = genNoise(st);  acc += u_mix.z * c.a * c.rgb; cov += u_mix.z * c.a; }
  if (u_mix.w > 0.001) { c = genShape(st);  acc += u_mix.w * c.a * c.rgb; cov += u_mix.w * c.a; }
  return vec4(acc + (1.0 - clamp(cov, 0.0, 1.0)) * u_bgColor, 1.0);
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
  result.rgb = brightnessColor(result.rgb, u_brightness);
  result.rgb = contrastColor(result.rgb, u_contrast);
  result.rgb = invertColor(result.rgb, u_invertAmount);
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

var feedbackProgram = linkProgram(VERTEX_SRC, FEEDBACK_FRAGMENT_SRC);
var displayProgram = linkProgram(VERTEX_SRC, DISPLAY_FRAGMENT_SRC);

var feedbackUniforms = uniformLocations(feedbackProgram, [
  'u_prevFrame', 'u_resolution', 'u_time',
  'u_feedback', 'u_zoom', 'u_rotate', 'u_translate', 'u_hueDrift',
  'u_mix', 'u_bgColor', 'u_frequency', 'u_speed', 'u_sync', 'u_noiseSpeed', 'u_shapeSides', 'u_shapeSmoothing',
  'u_noiseScale', 'u_camera', 'u_cameraAspect', 'u_cameraOn', 'u_cameraMirror',
  'u_hue', 'u_saturate', 'u_brightness', 'u_contrast', 'u_invertAmount',
  'u_chromakeyEnabled', 'u_chromakeyColor', 'u_chromakeyThreshold', 'u_chromakeySoftness',
  'u_blendMode', 'u_modulateAmount'
]);
var displayUniforms = uniformLocations(displayProgram, ['u_frame']);

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

function updateCameraTexture() {
  if (!cam.stream || cameraVideo.readyState < 2) return; // HAVE_CURRENT_DATA
  if (cameraVideo.videoWidth && cameraVideo.videoHeight) cam.aspect = cameraVideo.videoWidth / cameraVideo.videoHeight;
  gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cameraVideo);
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
      return cameraVideo.play();
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
function uploadFeedbackUniforms(t) {
  var u = feedbackUniforms, w = mixWeights(), bg = hslToRgb(params.bgHue, params.bgSat, params.bgLight),
      key = hslToRgb(params.keyHue, params.keySat, params.keyLight);
  gl.uniform1i(u.u_prevFrame, 0);
  gl.uniform2f(u.u_resolution, CW, CH);
  gl.uniform1f(u.u_time, t);
  gl.uniform1f(u.u_feedback, params.feedback);
  gl.uniform1f(u.u_zoom, params.zoom);
  gl.uniform1f(u.u_rotate, params.rotate);
  gl.uniform2f(u.u_translate, params.translateX, params.translateY);
  gl.uniform1f(u.u_hueDrift, params.hueDrift);
  gl.uniform4f(u.u_mix, w[0], w[1], w[2], w[3]);
  gl.uniform3f(u.u_bgColor, bg[0], bg[1], bg[2]);
  gl.uniform1f(u.u_frequency, FIXED.frequency);
  gl.uniform1f(u.u_speed, params.speed);
  gl.uniform1f(u.u_sync, FIXED.sync);
  gl.uniform1f(u.u_noiseSpeed, FIXED.noiseSpeed);
  gl.uniform1f(u.u_shapeSides, params.shapeSides);
  gl.uniform1f(u.u_shapeSmoothing, FIXED.shapeSmoothing);
  gl.uniform1f(u.u_noiseScale, params.noiseScale);
  gl.uniform1i(u.u_camera, 1);
  gl.uniform1f(u.u_cameraAspect, cam.aspect);
  gl.uniform1f(u.u_cameraOn, cam.stream && cameraVideo.readyState >= 2 ? 1 : 0);
  gl.uniform1f(u.u_cameraMirror, cam.facing === 'user' ? 1 : 0);
  gl.uniform1f(u.u_hue, params.hue / 360);
  gl.uniform1f(u.u_saturate, params.saturate);
  gl.uniform1f(u.u_brightness, params.brightness);
  gl.uniform1f(u.u_contrast, params.contrast);
  gl.uniform1f(u.u_invertAmount, params.invertAmount);
  gl.uniform1f(u.u_chromakeyEnabled, params.chromakeyEnabled ? 1 : 0);
  gl.uniform3f(u.u_chromakeyColor, key[0], key[1], key[2]);
  gl.uniform1f(u.u_chromakeyThreshold, params.chromakeyThreshold);
  gl.uniform1f(u.u_chromakeySoftness, params.chromakeySoftness);
  gl.uniform1i(u.u_blendMode, params.blendMode);
  gl.uniform1f(u.u_modulateAmount, params.modulateAmount);
}

var lastWritten = buffers[0];

function renderFeedbackPass(t) {
  // delay=0 reads the most recently completed frame (plain ping-pong);
  // higher delay reads further back. Capped at RING_SIZE-2 so it can
  // never land on the slot being written this draw call.
  var writeIndex = ringWriteIndex;
  var readIndex = wrapIndex(writeIndex - 1 - Math.round(params.delay), RING_SIZE);
  var write = buffers[writeIndex], read = buffers[readIndex];
  gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
  gl.viewport(0, 0, CW, CH);
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
  gl.viewport(0, 0, CW, CH);
  gl.useProgram(displayProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, lastWritten.tex);
  gl.uniform1i(displayUniforms.u_frame, 0);
  drawFullscreenTriangle();
}

var simTime = 0;
var lastNow = performance.now();
var timePaused = false;
var frozen = false;

function frame(now) {
  requestAnimationFrame(frame);
  var dt = Math.min((now - lastNow) / 1000, 0.1);
  lastNow = now;
  if (!timePaused) simTime += dt;
  if (frozen) return;
  updateCameraTexture();
  renderFeedbackPass(simTime);
  renderDisplayPass();
}

// Recover from a lost WebGL context by recreating the ring buffers -
// otherwise the canvas just freezes on black with no obvious cause.
canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); frozen = true; }, false);
canvas.addEventListener('webglcontextrestored', function () {
  buffers = createRingBuffers();
  ringWriteIndex = 0;
  buffers.forEach(clearFBO);
  lastWritten = buffers[0];
  cameraTexture = createCameraTexture();
  frozen = false;
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

function resetAll() {
  Object.assign(params, DEFAULTS);
  syncUI();
  clearScreen();
}

// Every knob, the mixer puck and the background colour. Camera and Chromakey on/off are left alone.
function randomize() {
  Object.keys(PD).forEach(function (k) { params[k] = fromV(PD[k], Math.random()); });
  params.mixX = Math.random(); params.mixY = Math.random();
  syncUI();
}

function currentFullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
function toggleFullscreen() {
  var s = ui.screen;
  if (!currentFullscreenElement()) {
    var req = s.requestFullscreen || s.webkitRequestFullscreen;
    if (req) req.call(s); else flash(ui.full);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}
function syncFullscreen() { ui.full.set(currentFullscreenElement() === ui.screen ? 'on' : 'off'); }
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);

// The visible area in layout pixels: the visual viewport (inside the browser bars on mobile) scaled back to zoom 1.
function viewSize() {
  var v = window.visualViewport;
  if (v && v.width > 0 && v.height > 0) return [v.width * v.scale, v.height * v.scale];
  return [window.innerWidth, window.innerHeight];
}
function fit() {
  var v = viewSize(), k = Math.min(v[0] / SW, v[1] / SH);
  stage.dataset.scale = String(k);
  stage.style.transform = 'translate(' + ((v[0] - SW * k) / 2) + 'px,' + ((v[1] - SH * k) / 2) + 'px) scale(' + k + ')';
}
window.addEventListener('resize', fit);
if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
window.addEventListener('orientationchange', function () { fit(); setTimeout(fit, 400); });
window.addEventListener('pageshow', fit);
document.addEventListener('gesturestart', function (e) { e.preventDefault(); });   // iOS pinch-zoom
fit();

// Self-test / screenshot hook (index.html#shot): headless Chrome only fires a few animation frames, so pump the
// feedback loop directly, then report.
// Parameters can be overridden in the hash, e.g. #shot&feedback=0&mixX=1.
if (location.hash.indexOf('#shot') === 0) {
  location.hash.slice(1).split('&').slice(1).forEach(function (kv) { var p = kv.split('='); if (p[0] === 'scheme') stage.dataset.scheme = p[1]; else if (p[0] in params) params[p[0]] = parseFloat(p[1]); });
  syncUI();
  var n = 0;
  for (; n < 150; n++) { simTime += 1 / 60; renderFeedbackPass(simTime); }
  renderDisplayPass();
  document.getElementById('__report').textContent = JSON.stringify({
    knobs: document.querySelectorAll('[role="slider"]').length, buttons: document.querySelectorAll('button').length,
    glError: gl.getError(), frames: n, errors: REPORT
  });
} else {
  requestAnimationFrame(function (now) { lastNow = now; requestAnimationFrame(frame); });
}
