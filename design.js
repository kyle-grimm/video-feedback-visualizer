'use strict';
// ===================================================================
// Design mode (experimentation tooling, loaded after script.js).
//
// Opened from the Design key on the screen's top left. Two tracks, each a small genetic algorithm driven by the
// user's star ratings:
//   Layout - a tree of horizontal / vertical splits whose leaves are the panel's blocks (screen, keys, Layers, Mix,
//            Feedback, Chromakey, Transform, Color), plus screen aspect, knob scale, gaps, padding, corner radius and
//            per-section column counts. Each block grids its controls inside its box. Separate populations for
//            portrait and landscape windows. The stage takes the window's shape.
//   Color  - per-family hue / saturation, panel and nameplate lightness, stage colour, surface texture, sheen,
//            outline / nameplate / pointer / label / knob-cap styles, glass accent colours. Applied as CSS.
// Rate candidates 1-5, Evolve breeds the next generation (the 2 best kept, 5 children of the best-rated parents,
// 1 random newcomer). 4-5 star candidates are kept in Favorites. Adopt makes a candidate the app's normal look
// (stored in localStorage); Export copies the adopted genomes as JSON so they can be built into the app.
// While rating layouts the adopted colours are shown, and vice versa, so each track is judged on its own.
//
// It only talks to script.js through: layoutEngine, onPanelBuilt, build/fit, the makers (makeScreen, makeKeys,
// makeItem, makePad, makeSwatch), sec, key, SECTIONS, SW/SH/CW/CH/SEC_R/PAD_T, P / ICON_GREEN, drawPad,
// syncBlendLegend, wantLand and viewSize.
// ===================================================================
(function () {
  var STORE = 'vfv-design-v1';
  var FAMS = ['feedback', 'chroma', 'transform', 'color', 'layers', 'mix'];
  var POP = 8, ELITE = 2;
  var TITLES = { layers: 'Layers', mix: 'Mix', feedback: 'Feedback', chroma: 'Chromakey', transform: 'Transform', color: 'Color' };

  // ---------------------------------------------------------------- utilities
  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  var ri = function (n) { return Math.floor(Math.random() * n); };
  var pick = function (a) { return a[ri(a.length)]; };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var uid = function () { return Math.random().toString(36).slice(2, 9); };
  var cl = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var wrap = function (h) { return ((h % 360) + 360) % 360; };
  var gauss = function () { var u = 1 - Math.random(), v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  var shuffle = function (a) { for (var i = a.length - 1; i > 0; i--) { var j = ri(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
  var hsl = function (h, s, l, a) { return 'hsl' + (a != null ? 'a' : '') + '(' + Math.round(wrap(h)) + ',' + Math.round(cl(s, 0, 1) * 100) + '%,' + Math.round(cl(l, 0, 1) * 100) + '%' + (a != null ? ',' + a : '') + ')'; };

  // ---------------------------------------------------------------- colour genome
  var TEXTURES = ['flat', 'brushed', 'hatch', 'grille', 'spun', 'carbon'];
  var OUTLINES = ['gray', 'family', 'none'], TABS = ['filled', 'dark', 'ink', 'outline'];
  var PTRS = ['ink', 'family', 'accent'], LABELS = ['dim', 'family', 'bright'], CAPS = ['black', 'silver', 'family'];
  // The shipped Anodized theme, approximately.
  var COLOR_DEFAULT = {
    hue: [261, 144, 215, 34, 185, 240],   // FAMS order: feedback, chroma, transform, color, layers, mix
    sat: [0.72, 0.98, 1.05, 1.1, 1.1, 0.22], pSat: 0.42, pLight: 0.23, kSat: 0.72, kLight: 0.68,
    sHue: 300, sSat: 0.02, sLight: 0.14, texture: 'brushed', texStr: 0.5, sheen: 0.5,
    outline: 'gray', tab: 'filled', ptr: 'ink', label: 'dim', cap: 'black', glassHue: 141, accentHue: 220
  };
  var COLOR_OPS = [
    function (g) { var i = ri(6); g.hue[i] = wrap(g.hue[i] + gauss() * 35); },
    function (g) { var d = gauss() * 40; g.hue = g.hue.map(function (h) { return wrap(h + d); }); },
    function (g) {   // re-space the family hues as a harmony (mono, analogous, pentad, triad, complementary...)
      var base = rnd(0, 360), step = pick([0, 15, 30, 45, 60, 72, 120, 180]), order = shuffle([0, 1, 2, 3, 4, 5]);
      g.hue = order.map(function (k) { return wrap(base + step * k + gauss() * 8); });
    },
    function (g) { var i = ri(6); g.sat[i] = cl(g.sat[i] + gauss() * 0.3, 0, 1.6); },
    function (g) { g.pSat = cl(g.pSat + gauss() * 0.12, 0, 0.9); },
    function (g) { g.pLight = cl(g.pLight + gauss() * 0.06, 0.06, 0.5); },
    function (g) { g.kSat = cl(g.kSat + gauss() * 0.12, 0.1, 1); },
    function (g) { g.kLight = cl(g.kLight + gauss() * 0.07, 0.35, 0.9); },
    function (g) { g.sHue = wrap(g.sHue + gauss() * 60); g.sSat = cl(g.sSat + gauss() * 0.08, 0, 0.4); },
    function (g) { g.sLight = cl(g.sLight + gauss() * 0.05, 0.03, 0.35); },
    function (g) { g.texture = pick(TEXTURES); },
    function (g) { g.texStr = cl(g.texStr + gauss() * 0.25, 0, 1); },
    function (g) { g.sheen = cl(g.sheen + gauss() * 0.25, 0, 1); },
    function (g) { g.outline = pick(OUTLINES); },
    function (g) { g.tab = pick(TABS); },
    function (g) { g.ptr = pick(PTRS); },
    function (g) { g.label = pick(LABELS); },
    function (g) { g.cap = pick(CAPS); },
    function (g) { g.glassHue = wrap(g.glassHue + gauss() * 60); },
    function (g) { g.accentHue = wrap(g.accentHue + gauss() * 60); }
  ];
  function mutateColor(g, n) { g = clone(g); for (var i = 0; i < n; i++) pick(COLOR_OPS)(g); return g; }
  function crossColor(a, b) {
    var c = {};
    Object.keys(a).forEach(function (k) {
      if (Array.isArray(a[k])) c[k] = a[k].map(function (v, i) { return Math.random() < 0.5 ? v : b[k][i]; });
      else c[k] = Math.random() < 0.5 ? a[k] : b[k];
    });
    return c;
  }
  function randomColor() { var g = mutateColor(COLOR_DEFAULT, 14); COLOR_OPS[2](g); return g; }

  function texture(g) {
    var a = g.texStr, s = g.sheen;
    var sheen = 'linear-gradient(170deg,rgba(255,255,255,' + (0.2 * s).toFixed(3) + '),rgba(255,255,255,0) 45%,rgba(0,0,0,' + (0.4 * s).toFixed(3) + '))';
    var f = function (v) { return (v * a).toFixed(3); };
    switch (g.texture) {
      case 'brushed': return { img: 'repeating-linear-gradient(0deg,rgba(255,255,255,' + f(0.056) + ') 0 1px,rgba(0,0,0,' + f(0.1) + ') 1px 2px,transparent 2px 3px,rgba(255,255,255,' + f(0.03) + ') 3px 4px,transparent 4px 7px),' + sheen, size: 'auto' };
      case 'hatch': return { img: 'repeating-linear-gradient(45deg,rgba(255,255,255,' + f(0.2) + ') 0 1.5px,transparent 1.5px 8px),' + sheen, size: 'auto' };
      case 'grille': return { img: 'radial-gradient(circle,rgba(0,0,0,' + f(1) + ') 1.5px,transparent 2px),' + sheen, size: '9px 9px,auto' };
      case 'spun': return { img: 'repeating-radial-gradient(circle at 50% 50%,rgba(255,255,255,' + f(0.06) + ') 0 1px,rgba(0,0,0,' + f(0.1) + ') 1px 2px,transparent 2px 3px),' +
        'conic-gradient(from 20deg at 50% 50%,rgba(255,255,255,' + (0.2 * s).toFixed(3) + '),rgba(0,0,0,' + (0.3 * s).toFixed(3) + ') 25%,rgba(255,255,255,' + (0.16 * s).toFixed(3) + ') 50%,rgba(0,0,0,' + (0.3 * s).toFixed(3) + ') 75%,rgba(255,255,255,' + (0.2 * s).toFixed(3) + '))', size: 'auto' };
      case 'carbon': return { img: 'linear-gradient(45deg,rgba(0,0,0,' + f(0.9) + ') 25%,transparent 25%,transparent 75%,rgba(0,0,0,' + f(0.9) + ') 75%),' + sheen, size: '6px 6px,auto' };
      default: return { img: sheen, size: 'auto' };
    }
  }
  function panelColor(g, i) { return hsl(g.hue[i], g.pSat * g.sat[i], g.pLight); }
  function keyColor(g, i) { return hsl(g.hue[i], g.kSat * Math.min(1, g.sat[i] + 0.2), g.kLight); }
  function colorCss(g) {
    var css = '', stageC = hsl(g.sHue, g.sSat, g.sLight), tx = texture(g);
    FAMS.forEach(function (f, i) { css += '#stage [data-fam="' + f + '"]{--anod:' + panelColor(g, i) + ';--fc:' + keyColor(g, i) + '}\n'; });
    css += 'html,body{background:' + stageC + '!important}\n';
    css += '#panel{background:linear-gradient(to bottom,' + hsl(g.sHue, g.sSat, g.sLight + 0.03) + ',' + stageC + ' 48px)!important}\n';
    css += '#stage .fam{background-color:var(--anod)!important;background-image:' + tx.img + '!important;background-size:' + tx.size + '!important}\n';
    css += {
      filled: '#stage .tab{background:var(--fc)!important;color:#19181a!important}',
      dark: '#stage .tab{background:#141316!important;color:var(--fc)!important;box-shadow:0 0 0 1px var(--fc)}',
      ink: '#stage .tab{background:#ebebeb!important;color:#19181a!important}',
      outline: '#stage .tab{background:' + stageC + '!important;color:var(--fc)!important;box-shadow:inset 0 0 0 1px var(--fc)}'
    }[g.tab] + '\n';
    css += { gray: '', family: '#stage div.frame{border-color:var(--fc)!important}', none: '#stage div.frame{border-color:transparent!important}' }[g.outline] + '\n';
    css += { dim: '', family: '#stage .knob-label{color:var(--fc,#a6a4a8)!important}', bright: '#stage .knob-label{color:#ebebeb!important}' }[g.label] + '\n';
    css += { ink: '', family: '#stage .knob-ptr{background:var(--fc,#ebebeb)!important}', accent: '#stage .knob-ptr{background:' + hsl(g.accentHue, 1, 0.8) + '!important;box-shadow:0 0 4px ' + hsl(g.accentHue, 1, 0.7) + '}' }[g.ptr] + '\n';
    css += {
      black: '',
      silver: '#stage .knob-cap{background:radial-gradient(circle at 45% 35%,#e8e8ec 0%,#a3a3a9 55%,#6b6b72 100%)!important}#stage .knob-ptr{background:#19181a!important;box-shadow:none!important}',
      family: '#stage .knob-cap{background:radial-gradient(circle at 45% 35%,color-mix(in srgb,var(--fc,#888) 70%,#fff),color-mix(in srgb,var(--fc,#888) 55%,#000) 60%,color-mix(in srgb,var(--fc,#888) 25%,#000) 100%)!important}'
    }[g.cap] + '\n';
    return css;
  }
  var P0 = { accent: P.accent, accentGlow: P.accentGlow, icon: ICON_GREEN };
  var colorStyle = document.createElement('style');
  document.head.appendChild(colorStyle);
  function applyColor(g) {
    colorStyle.textContent = g ? colorCss(g) : '';
    P.accent = g ? hsl(g.accentHue, 1, 0.93) : P0.accent;
    P.accentGlow = g ? hsl(g.accentHue, 1, 0.75, 0.8) : P0.accentGlow;
    ICON_GREEN = g ? hsl(g.glassHue, 0.5, 0.5) : P0.icon;
    drawPad(); syncBlendLegend();
  }

  // ---------------------------------------------------------------- layout genome
  // tree: a leaf name, or { d: 'h' | 'v', w: [weights], c: [children] }.
  var LEAF_W = { screen: 6, keys: 0.45, mix: 2, layers: 2, feedback: 2, chroma: 3, transform: 2.5, color: 2.5 };
  var LEAVES = Object.keys(LEAF_W);
  var LAYOUT_DEFAULT = {
    port: { tree: { d: 'h', w: [576, 316], c: [{ d: 'v', w: [992, 44, 290], c: ['screen', 'keys', { d: 'h', w: [294, 266], c: ['layers', 'mix'] }] },
                                              { d: 'v', w: [2, 3, 5], c: ['feedback', 'chroma', { d: 'h', w: [1, 1], c: ['transform', 'color'] }] }] },
            aspect: 'port', knob: 1, gap: 16, pad: 10, radius: 3, cols: { feedback: 2, chroma: 2, transform: 1, color: 1, layers: 2 } },
    land: { tree: { d: 'v', w: [576, 316], c: [{ d: 'h', w: [992, 60, 290], c: ['screen', 'keys', { d: 'v', w: [294, 266], c: ['layers', 'mix'] }] },
                                              { d: 'h', w: [2, 3, 5], c: ['feedback', 'chroma', { d: 'v', w: [1, 1], c: ['transform', 'color'] }] }] },
            aspect: 'land', knob: 1, gap: 16, pad: 10, radius: 3, cols: { feedback: 2, chroma: 3, transform: 5, color: 5, layers: 2 } }
  };
  var isLeaf = function (n) { return typeof n === 'string'; };
  function leavesOf(n, out) { out = out || []; if (isLeaf(n)) out.push(n); else n.c.forEach(function (c) { leavesOf(c, out); }); return out; }
  function countNodes(n) { return isLeaf(n) ? 1 : 1 + n.c.reduce(function (s, c) { return s + countNodes(c); }, 0); }
  function internals(n, out) { out = out || []; if (!isLeaf(n)) { out.push(n); n.c.forEach(function (c) { internals(c, out); }); } return out; }
  function setLeaves(n, seq) { var i = 0; return (function rec(m) { return isLeaf(m) ? seq[i++] : { d: m.d, w: m.w.slice(), c: m.c.map(rec) }; })(n); }
  function subtreeWeight(n) { return leavesOf(n).reduce(function (s, l) { return s + LEAF_W[l]; }, 0); }
  function removeLeaf(root, name) {
    return (function rec(n) {
      if (isLeaf(n)) return n === name ? null : n;
      var kids = [], ws = [];
      n.c.forEach(function (c, i) { var r = rec(c); if (r !== null) { kids.push(r); ws.push(n.w[i]); } });
      if (!kids.length) return null;
      return kids.length === 1 ? kids[0] : { d: n.d, w: ws, c: kids };
    })(root);
  }
  function insertLeaf(root, name) {
    var target = ri(countNodes(root)), idx = 0;
    return (function rec(n) {
      if (idx++ === target) {
        if (!isLeaf(n) && Math.random() < 0.5) {
          var m = clone(n), at = ri(m.c.length + 1), sw = LEAF_W[name] / subtreeWeight(n) * m.w.reduce(function (s, v) { return s + v; }, 0);
          m.c.splice(at, 0, name); m.w.splice(at, 0, sw); return m;
        }
        var pair = Math.random() < 0.5 ? [n, name] : [name, n];
        return { d: pick(['h', 'v']), w: pair.map(function (p) { return subtreeWeight(p) * rnd(0.7, 1.4); }), c: pair };
      }
      return isLeaf(n) ? n : { d: n.d, w: n.w.slice(), c: n.c.map(rec) };
    })(root);
  }
  function randomTree(leaves) {
    if (leaves.length === 1) return leaves[0];
    var k = Math.min(leaves.length, Math.random() < 0.65 ? 2 : 3), order = shuffle(leaves.slice()), cuts = [];
    while (cuts.length < k - 1) { var c = 1 + ri(order.length - 1); if (cuts.indexOf(c) < 0) cuts.push(c); }
    cuts.sort(function (a, b) { return a - b; });
    var groups = [], prev = 0;
    cuts.concat([order.length]).forEach(function (c) { groups.push(order.slice(prev, c)); prev = c; });
    return { d: pick(['h', 'v']), w: groups.map(function (g) { return g.reduce(function (s, l) { return s + LEAF_W[l]; }, 0) * rnd(0.7, 1.4); }), c: groups.map(randomTree) };
  }
  var LAYOUT_OPS = [
    function (L) { var ns = internals(L.tree), n = pick(ns), i = ri(n.w.length); n.w[i] *= Math.exp(gauss() * 0.35); },
    function (L) { var ns = internals(L.tree), n = pick(ns), i = ri(n.w.length); n.w[i] *= Math.exp(gauss() * 0.35); },
    function (L) { pick(internals(L.tree)).d = Math.random() < 0.5 ? 'h' : 'v'; },
    function (L) { var s = leavesOf(L.tree), i = ri(s.length), j = ri(s.length), t = s[i]; s[i] = s[j]; s[j] = t; L.tree = setLeaves(L.tree, s); },
    function (L) { var name = pick(LEAVES), t = removeLeaf(L.tree, name); L.tree = insertLeaf(t, name); },
    function (L) { var n = pick(internals(L.tree)); if (n.c.length > 1) { var i = ri(n.c.length - 1); var c = n.c.splice(i, 1)[0], w = n.w.splice(i, 1)[0]; n.c.splice(i + 1, 0, c); n.w.splice(i + 1, 0, w); } },
    function (L) { if (Math.random() < 0.3) L.aspect = L.aspect === 'port' ? 'land' : 'port'; },
    function (L) { L.knob = cl(L.knob * Math.exp(gauss() * 0.15), 0.7, 1.35); },
    function (L) { L.gap = Math.round(cl(L.gap + gauss() * 4, 12, 30)); },
    function (L) { L.pad = Math.round(cl(L.pad + gauss() * 4, 6, 24)); },
    function (L) { L.radius = Math.round(cl(L.radius + gauss() * 3, 0, 14)); },
    function (L) { var s = pick(['feedback', 'chroma', 'transform', 'color', 'layers']); L.cols[s] = ri(SECTIONS[s].items.length + 1); }
  ];
  function mutateLayout(L, n) { L = clone(L); for (var i = 0; i < n; i++) pick(LAYOUT_OPS)(L); return L; }
  function crossLayout(a, b) {
    var c = clone(a);
    if (Math.random() < 0.5) c.tree = setLeaves(c.tree, leavesOf(b.tree));
    ['aspect', 'knob', 'gap', 'pad', 'radius'].forEach(function (k) { if (Math.random() < 0.5) c[k] = b[k]; });
    Object.keys(c.cols).forEach(function (k) { if (Math.random() < 0.5) c.cols[k] = b.cols[k]; });
    return c;
  }
  function randomLayout(orient) {
    var base = LAYOUT_DEFAULT[orient];
    return { tree: randomTree(LEAVES.slice()), aspect: Math.random() < 0.75 ? base.aspect : (base.aspect === 'port' ? 'land' : 'port'),
             knob: rnd(0.8, 1.25), gap: Math.round(rnd(12, 24)), pad: Math.round(rnd(8, 18)), radius: Math.round(rnd(0, 10)),
             cols: { feedback: 0, chroma: 0, transform: 0, color: 0, layers: 0 } };
  }
  // Breed until the result passes the geometry checks at the current stage size.
  function viable(make) {
    var st = stageSize();
    for (var i = 0; i < 120; i++) { var L = make(); if (geometry(L, st[0], st[1]).ok) return L; }
    return null;
  }

  // Stage for design layouts: the window's shape, 900 (portrait) or 1400 (landscape) wide.
  function orient() { return wantLand() ? 'land' : 'port'; }
  function stageSize() {
    var v = viewSize(), land = v[0] > v[1], w = land ? 1400 : 900;
    return [w, Math.round(cl(w * v[1] / v[0], w * 0.45, w * 2.3) / 4) * 4];
  }

  // Geometry of a layout genome in a W x H stage: a box per block, controls gridded inside. ok = false when anything
  // is unusably small (tiny knobs, cramped cells, a small screen).
  function geometry(L, W, H) {
    var G = { list: [], ok: true, why: '', minKnob: 999, screenFrac: 0 }, gap = L.gap;
    var fail = function (why) { if (G.ok) G.why = why; G.ok = false; };
    function leaf(name, b) {
      var x = b[0], y = b[1], w = b[2], h = b[3], o = { name: name, box: b }, i;
      if (w < 40 || h < 30) fail(name + ' too small');
      if (name === 'screen') {
        var A = L.aspect === 'land' ? 16 / 9 : 9 / 16, cw = Math.max(10, Math.min(w - 20, (h - 20) * A)), ch = cw / A;
        o.bezel = [x + (w - cw - 20) / 2, y + (h - ch - 20) / 2, cw + 20, ch + 20];
        G.screenFrac = (cw + 20) * (ch + 20) / (W * H);
        if (G.screenFrac < 0.16) fail('screen small');
        return o;
      }
      if (name === 'keys') {
        var g = 8; o.rects = [];
        if (w >= h * 1.4) {
          var kw = (w - 4 * g) / 5, kh = Math.min(h, 34); if (kw < 46 || kh < 22) fail('keys narrow');
          for (i = 0; i < 5; i++) o.rects.push([x + i * (kw + g), y + (h - kh) / 2, kw, kh]);
        } else {
          var kh2 = Math.min((h - 4 * g) / 5, 64), kw2 = Math.min(w, 112), y0 = y + (h - (5 * kh2 + 4 * g)) / 2;
          if (kh2 < 24 || kw2 < 46) fail('keys short');
          for (i = 0; i < 5; i++) o.rects.push([x + (w - kw2) / 2, y0 + i * (kh2 + g), kw2, kh2]);
        }
        o.fs = (o.rects[0][2] < 60) ? 9 : 10;
        return o;
      }
      var p = L.pad, cx0 = x + p, cy0 = y + 22, cw0 = w - 2 * p, ch0 = h - 22 - p;
      if (name === 'mix') {
        var s = Math.min(cw0, ch0); if (s < 120) fail('pad small');
        o.pad = [cx0 + (cw0 - s) / 2, cy0 + (ch0 - s) / 2, s]; return o;
      }
      var items = SECTIONS[name].items, n = items.length, best = null;
      var tryCols = function (c) {
        var rows = Math.ceil(n / c), cellW = cw0 / c, cellH = ch0 / rows, size = Math.min(cellH - 37, cellW - 22, 42 * L.knob);
        var bad = cellW < 82 || (items.indexOf('camera') >= 0 && (cellW < 112 || cellH < 86)) || (items.indexOf('keyOn') >= 0 && (cellW < 80 || cellH < 64));
        return { c: c, rows: rows, cellW: cellW, cellH: cellH, size: size, bad: bad ? 1 : 0 };
      };
      var pref = L.cols && L.cols[name];
      if (pref) best = tryCols(Math.min(pref, n));
      else for (var c = 1; c <= n; c++) { var t = tryCols(c); if (!best || t.bad < best.bad || (t.bad === best.bad && t.size > best.size + 0.5)) best = t; }
      if (best.bad) fail(name + ' cramped');
      if (best.size < 20) fail(name + ' knobs small');
      G.minKnob = Math.min(G.minKnob, best.size);
      o.items = items.map(function (id, k) {
        var row = Math.floor(k / best.c), col = k % best.c, inRow = Math.min(best.c, n - row * best.c);
        var ccx = cx0 + (col + 0.5 + (best.c - inRow) / 2) * best.cellW, ccy = cy0 + (row + 0.5) * best.cellH;
        return { id: id, cx: ccx, cy: id === 'camera' ? ccy - 6 : ccy - 8, size: Math.round(best.size), legend: best.cellW >= 2 * (best.size / 2 + 46) };
      });
      o.cols = best.c;
      return o;
    }
    (function split(n, b) {
      if (isLeaf(n)) { G.list.push(leaf(n, b)); return; }
      var horiz = n.d === 'h', tot = n.w.reduce(function (s, v) { return s + v; }, 0);
      var len = (horiz ? b[2] : b[3]) - gap * (n.c.length - 1), pos = horiz ? b[0] : b[1];
      n.c.forEach(function (c, i) {
        var s = len * n.w[i] / tot;
        split(c, horiz ? [pos, b[1], s, b[3]] : [b[0], pos, b[2], s]);
        pos += s + gap;
      });
    })(L.tree, [8, 16, W - 16, H - 24]);
    return G;
  }

  function renderLayout(L) {
    var st = stageSize(); SW = st[0]; SH = st[1];
    CW = L.aspect === 'land' ? 1280 : 720; CH = L.aspect === 'land' ? 720 : 1280;
    SEC_R = L.radius; PAD_T = false;
    geometry(L, SW, SH).list.forEach(function (o) {
      if (o.name === 'screen') return makeScreen(o.bezel[0], o.bezel[1], o.bezel[2], o.bezel[3]);
      if (o.name === 'keys') return makeKeys(o.rects, o.fs);
      var b = o.box, fr = sec(b[0], b[1], b[2], b[3], TITLES[o.name], o.name);
      if (o.pad) makePad(o.pad[0], o.pad[1], o.pad[2]);
      if (o.items) o.items.forEach(function (it) { makeItem(it.id, it.cx, it.cy, it.size, { fam: o.name, legend: it.legend }); });
      if (o.name === 'chroma') makeSwatch(b[0] + 12 + fr.tab.offsetWidth + 8, b[1] - 6);
    });
  }

  // ---------------------------------------------------------------- state
  function newPop(kind, o) {
    var base = clone(kind === 'color' ? COLOR_DEFAULT : LAYOUT_DEFAULT[o]);
    var pop = [{ id: uid(), g: base, stars: 0, tag: 'current' }];
    while (pop.length < POP) {
      var g = kind === 'color' ? randomColor()
        : viable(function () { return randomLayout(o); }) || viable(function () { return mutateLayout(base, 3); }) || clone(base);
      pop.push({ id: uid(), g: g, stars: 0 });
    }
    return { gen: 1, pop: pop, sel: 0 };
  }
  var S = null;
  function load() {
    try { S = JSON.parse(localStorage.getItem(STORE)); } catch (e) { S = null; }
    if (!S || S.v !== 1) S = { v: 1, open: false, track: 'layout', mut: 1, color: null, layout: {}, fav: { color: [], port: [], land: [] }, adopted: { color: null, port: null, land: null }, preview: null };
  }
  var saveT = 0;
  function save() { clearTimeout(saveT); saveT = setTimeout(function () { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* storage full or blocked */ } }, 150); }
  function trackState(t) {
    t = t || S.track;
    if (t === 'color') { if (!S.color) S.color = newPop('color'); return S.color; }
    var o = orient();
    if (!S.layout[o]) S.layout[o] = newPop('layout', o);
    return S.layout[o];
  }
  function favKey(t) { return (t || S.track) === 'color' ? 'color' : orient(); }
  function current(t) {
    var ts = trackState(t);
    if (S.preview && S.preview.track === t && S.preview.orient === (t === 'color' ? 'color' : orient())) return S.preview.item;
    return ts.pop[ts.sel];
  }
  // What the panel shows: the track being rated uses its selected candidate, the other track its adopted genome.
  function shownColor() { if (S.open && S.track === 'color') return current('color').g; return S.adopted.color; }
  function shownLayout() { if (S.open && S.track === 'layout') return current('layout').g; return S.adopted[orient()]; }

  // ---------------------------------------------------------------- evolution
  function evolve() {
    var t = S.track, ts = trackState(), o = orient();
    var rated = ts.pop.filter(function (p) { return p.stars > 0; }).sort(function (a, b) { return b.stars - a.stars; });
    if (!rated.length) { flashMsg('Rate at least one candidate first'); return; }
    var parents = rated.some(function (p) { return p.stars >= 2; }) ? rated.filter(function (p) { return p.stars >= 2; }) : rated;
    var tot = parents.reduce(function (s, p) { return s + p.stars * p.stars; }, 0);
    var roulette = function () { var r = Math.random() * tot; for (var i = 0; i < parents.length; i++) { r -= parents[i].stars * parents[i].stars; if (r <= 0) return parents[i]; } return parents[0]; };
    var next = rated.slice(0, ELITE).map(function (p) { return { id: p.id, g: p.g, stars: p.stars, tag: 'kept' }; });
    var mutN = [1, 2, 4][S.mut];
    while (next.length < POP - 1) {
      var a = roulette(), b = parents.length > 1 ? roulette() : a;
      var make = function () {
        var g = (b !== a && Math.random() < 0.6) ? (t === 'color' ? crossColor(a.g, b.g) : crossLayout(a.g, b.g)) : clone(a.g);
        var n = mutN + ri(mutN + 1) + (a.stars <= 2 ? 1 : 0);
        return t === 'color' ? mutateColor(g, n) : mutateLayout(g, n);
      };
      var child = t === 'color' ? make() : viable(make);
      next.push({ id: uid(), g: child || clone(a.g), stars: 0 });
    }
    var imm = t === 'color' ? randomColor() : viable(function () { return randomLayout(o); });
    if (imm) next.push({ id: uid(), g: imm, stars: 0, tag: 'new' });
    ts.gen++; ts.pop = next; ts.sel = Math.min(ELITE, next.length - 1); S.preview = null;
    save(); apply(); render();
  }
  function rate(stars) {
    var it = current(S.track);
    it.stars = it.stars === stars ? 0 : stars;
    var list = S.fav[favKey()], at = -1;
    list.forEach(function (f, i) { if (f.id === it.id) at = i; });
    if (it.stars >= 4) {
      if (at < 0) list.unshift({ id: it.id, g: it.g, stars: it.stars, gen: trackState().gen }); else list[at].stars = it.stars;
      if (list.length > 16) list.length = 16;
    } else if (at >= 0) list.splice(at, 1);
    save(); render();
  }
  function select(i) { var ts = trackState(); ts.sel = (i + ts.pop.length) % ts.pop.length; S.preview = null; save(); apply(); render(); }
  function adopt() {
    var it = current(S.track);
    if (S.track === 'color') S.adopted.color = clone(it.g); else S.adopted[orient()] = clone(it.g);
    save(); flashMsg('Adopted as the app ' + (S.track === 'color' ? 'colours' : orient() + ' layout')); render();
  }
  function revert() {
    if (S.track === 'color') S.adopted.color = null; else S.adopted[orient()] = null;
    save(); apply(); flashMsg('Back to the built-in ' + (S.track === 'color' ? 'colours' : 'layout')); render();
  }
  function reroll() {
    var ts = trackState(), o = orient();
    ts.pop = ts.pop.map(function (p) {
      if (p.stars > 0 || p.tag === 'current') return p;
      var g = S.track === 'color' ? randomColor() : viable(function () { return randomLayout(o); });
      return g ? { id: uid(), g: g, stars: 0, tag: 'new' } : p;
    });
    save(); apply(); render();
  }
  function resetTrack() {
    if (!window.confirm('Start this track over? Its candidates, ratings and generation count are cleared (favourites and adopted designs stay).')) return;
    if (S.track === 'color') S.color = null; else S.layout[orient()] = null;
    S.preview = null; save(); apply(); render();
  }
  function exportJson() {
    var data = { layout: { port: S.adopted.port, land: S.adopted.land }, color: S.adopted.color,
                 candidate: { track: S.track, orient: orient(), genome: current(S.track).g } };
    var text = JSON.stringify(data, null, 1);
    var done = function () { flashMsg('Copied design JSON to the clipboard'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy the design JSON:', text); });
    else window.prompt('Copy the design JSON:', text);
  }

  // ---------------------------------------------------------------- applying to the panel
  var engine = {
    key: function () { var g = shownLayout(); return g ? 'design:' + stageSize().join('x') + ':' + JSON.stringify(g).length + ':' + hashStr(JSON.stringify(g)) : (wantLand() ? 'land' : 'port'); },
    build: function () { var g = shownLayout(); if (g) renderLayout(g); else buildDefault(wantLand()); }
  };
  function hashStr(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
  function apply() {
    applyColor(shownColor());
    fit();
  }
  layoutEngine = engine;

  // ---------------------------------------------------------------- the Design key on the screen
  window.onPanelBuilt = function () {
    if (!ui.bezel) return;
    ui.designKey = key(ui.bezel[0] + 18, ui.bezel[1] + 18, 84, 24, 'Design', S.open ? 'on' : 'off', { fs: 9, aria: 'Design mode', onClick: toggle });
    ui.designKey.b.style.zIndex = '5';
    applyColor(shownColor());
    placeHud();
  };
  function toggle() { S.open = !S.open; S.preview = null; save(); hud.style.display = S.open ? 'block' : 'none'; apply(); render(); }

  // ---------------------------------------------------------------- HUD
  var css = document.createElement('style');
  css.textContent =
    '#dm{position:fixed;z-index:50;width:304px;max-width:calc(100vw - 16px);display:none;box-sizing:border-box;font-family:"Barlow Semi Condensed","Segoe UI",sans-serif;' +
    'color:#ebebeb;background:rgba(22,21,24,0.95);border:1px solid #515053;border-radius:7px;box-shadow:0 10px 30px rgba(0,0,0,0.6);user-select:none;-webkit-user-select:none;touch-action:pan-x pan-y}' +
    '#dm .hd{display:flex;align-items:center;gap:6px;padding:7px 8px 7px 10px;border-bottom:1px solid #3d3b40;cursor:move;touch-action:none;font-size:11px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase}' +
    '#dm .hd span{flex:1}#dm .bd{padding:8px 10px 10px}#dm.min .bd{display:none}' +
    '#dm button{font-family:inherit;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#ebebeb;background:linear-gradient(#49474d,#2d2c30);border:none;border-radius:4px;padding:6px 8px;cursor:pointer;box-shadow:0 1px 0 #0f0e10,inset 0 1px 0 rgba(255,255,255,0.09)}' +
    '#dm button:disabled{opacity:0.4;cursor:default}#dm button.on{background:linear-gradient(#5b8fe0,#3568b8)}#dm button.x{padding:3px 7px}' +
    '#dm .row{display:flex;gap:6px;margin:6px 0;align-items:center;flex-wrap:wrap}#dm .row>button{flex:1}' +
    '#dm .meta{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#a6a4a8}' +
    '#dm .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0}' +
    '#dm .cand{position:relative;border-radius:4px;background:#0b0b0c;padding:3px;cursor:pointer;box-shadow:0 0 0 1px #3d3b40}' +
    '#dm .cand.sel{box-shadow:0 0 0 2px #eded78}#dm .cand canvas{display:block;width:100%;border-radius:2px}' +
    '#dm .cand b{position:absolute;left:5px;top:3px;font-size:10px;text-shadow:0 0 3px #000}#dm .cand i{display:block;font-style:normal;font-size:9px;color:#eded78;text-align:center;height:11px;line-height:11px;margin-top:2px}' +
    '#dm .cand em{position:absolute;right:4px;top:3px;font-style:normal;font-size:8px;font-weight:800;letter-spacing:0.08em;color:#9ad;text-transform:uppercase;text-shadow:0 0 3px #000}' +
    '#dm .stars{display:flex;gap:2px;flex:1}#dm .stars button{flex:1;font-size:15px;padding:3px 0;color:#77757b;background:#1f1e21}#dm .stars button.lit{color:#eded78}' +
    '#dm .favs{display:flex;gap:5px;overflow-x:auto;padding:2px 1px 4px}#dm .fav{flex:none;width:42px;cursor:pointer;border-radius:3px;box-shadow:0 0 0 1px #3d3b40;background:#0b0b0c;padding:2px}' +
    '#dm .fav.sel{box-shadow:0 0 0 2px #eded78}#dm .fav canvas{display:block;width:100%}' +
    '#dm .msg{min-height:13px;font-size:10px;color:#eded78;letter-spacing:0.06em}#dm .hint{font-size:9px;color:#77757b;letter-spacing:0.06em;margin-top:6px;line-height:1.4}';
  document.head.appendChild(css);
  var hud = document.createElement('div');
  hud.id = 'dm';
  document.body.appendChild(hud);
  var hudPos = null;   // set once the user drags the HUD
  function placeHud() {
    if (hudPos || !ui.screen) return;
    var r = ui.screen.getBoundingClientRect();
    hud.style.left = Math.max(8, Math.min(window.innerWidth - 312, r.left + 8)) + 'px';
    hud.style.top = Math.max(8, r.top + 44) + 'px';
  }
  var msgT = 0, msgText = '';
  function flashMsg(t) { msgText = t; render(); clearTimeout(msgT); msgT = setTimeout(function () { msgText = ''; render(); }, 2600); }

  function thumbW() { return 60; }
  function drawColorThumb(c, g) {
    var x = c.getContext('2d'), w = c.width, h = c.height;
    g = g || COLOR_DEFAULT;
    x.fillStyle = hsl(g.sHue, g.sSat, g.sLight); x.fillRect(0, 0, w, h);
    var cw = (w - 6) / 3, chh = (h - 6) / 2;
    FAMS.forEach(function (f, i) {
      var px = 2 + (i % 3) * (cw + 1), py = 2 + Math.floor(i / 3) * (chh + 2);
      x.fillStyle = panelColor(g, i); x.fillRect(px, py, cw, chh);
      x.fillStyle = g.tab === 'ink' ? '#ebebeb' : keyColor(g, i); x.fillRect(px + 2, py + 2, cw * 0.55, 4);
    });
    x.fillStyle = hsl(g.glassHue, 0.5, 0.5); x.beginPath(); x.arc(w - 6, h - 6, 2.5, 0, 7); x.fill();
  }
  function drawLayoutThumb(c, L, colorG) {
    var x = c.getContext('2d'), w = c.width, h = c.height, st = stageSize(), k = Math.min(w / st[0], h / st[1]);
    var cg = colorG || COLOR_DEFAULT;
    x.fillStyle = hsl(cg.sHue, cg.sSat, cg.sLight); x.fillRect(0, 0, w, h);
    x.save(); x.translate((w - st[0] * k) / 2, (h - st[1] * k) / 2); x.scale(k, k);
    geometry(L, st[0], st[1]).list.forEach(function (o) {
      var b = o.box;
      if (o.name === 'screen') { x.fillStyle = '#000'; x.fillRect(o.bezel[0], o.bezel[1], o.bezel[2], o.bezel[3]); x.strokeStyle = '#444'; x.lineWidth = 6; x.strokeRect(o.bezel[0], o.bezel[1], o.bezel[2], o.bezel[3]); return; }
      if (o.name === 'keys') { x.fillStyle = '#4a4850'; o.rects.forEach(function (r) { x.fillRect(r[0], r[1], r[2], r[3]); }); return; }
      var i = FAMS.indexOf(o.name);
      x.fillStyle = panelColor(cg, i); x.fillRect(b[0], b[1], b[2], b[3]);
      x.fillStyle = keyColor(cg, i); x.fillRect(b[0] + 8, b[1] - 4, Math.min(80, b[2] * 0.5), 10);
      x.fillStyle = 'rgba(0,0,0,0.55)';
      if (o.pad) x.fillRect(o.pad[0], o.pad[1], o.pad[2], o.pad[2]);
      if (o.items) o.items.forEach(function (it) { x.beginPath(); x.arc(it.cx, it.cy, it.size / 2 + 4, 0, 7); x.fill(); });
    });
    x.restore();
  }
  function thumb(g, track, cls) {
    var st = stageSize(), w = thumbW() * 2, h = track === 'color' ? 64 : Math.round(w * cl(st[1] / st[0], 0.5, 1.6));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    if (track === 'color') drawColorThumb(c, g); else drawLayoutThumb(c, g, S.adopted.color);
    return c;
  }
  function starStr(n) { return n ? '★★★★★'.slice(0, n) : ''; }

  function render() {
    if (!S.open) { hud.style.display = 'none'; return; }
    hud.style.display = 'block';
    var t = S.track, ts = trackState(), cur = current(t), favs = S.fav[favKey()], o = orient();
    var adopted = t === 'color' ? S.adopted.color : S.adopted[o];
    hud.innerHTML = '';
    var hd = document.createElement('div'); hd.className = 'hd';
    hd.innerHTML = '<span>Design mode</span><button class="x" data-act="min">' + (hud.classList.contains('min') ? '+' : '–') + '</button><button class="x" data-act="close">×</button>';
    hud.appendChild(hd);
    var bd = document.createElement('div'); bd.className = 'bd'; hud.appendChild(bd);
    var row = function (html) { var r = document.createElement('div'); r.className = 'row'; r.innerHTML = html; bd.appendChild(r); return r; };
    row('<button data-act="track-layout" class="' + (t === 'layout' ? 'on' : '') + '">Layout · ' + (o === 'land' ? 'landscape' : 'portrait') + '</button>' +
        '<button data-act="track-color" class="' + (t === 'color' ? 'on' : '') + '">Color</button>');
    row('<span class="meta" style="flex:1;white-space:nowrap">Gen ' + ts.gen + ' · ' + ts.pop.filter(function (p) { return p.stars; }).length + '/' + ts.pop.length + ' rated</span>' +
        '<span class="meta">Mut.</span>' + ['Low', 'Med', 'High'].map(function (m, i) { return '<button class="x' + (S.mut === i ? ' on' : '') + '" data-act="mut" data-i="' + i + '">' + m + '</button>'; }).join(''));
    var grid = document.createElement('div'); grid.className = 'grid'; bd.appendChild(grid);
    ts.pop.forEach(function (p, i) {
      var d = document.createElement('div');
      d.className = 'cand' + (i === ts.sel && !S.preview ? ' sel' : ''); d.dataset.act = 'sel'; d.dataset.i = i;
      d.appendChild(thumb(p.g, t));
      d.insertAdjacentHTML('beforeend', '<b>' + String.fromCharCode(65 + i) + '</b>' + (p.tag ? '<em>' + p.tag + '</em>' : '') + '<i>' + starStr(p.stars) + '</i>');
      grid.appendChild(d);
    });
    var label = S.preview ? 'Favourite' : 'Candidate ' + String.fromCharCode(65 + ts.sel);
    var r = row('<span class="meta" style="width:74px">' + label + '</span><div class="stars">' +
      [1, 2, 3, 4, 5].map(function (n) { return '<button data-act="rate" data-i="' + n + '" class="' + (cur.stars >= n ? 'lit' : '') + '">★</button>'; }).join('') + '</div>');
    if (S.preview) r.querySelectorAll('.stars button').forEach(function (b) { b.disabled = true; });
    row('<button data-act="prev">◀ Prev</button><button data-act="next">Next ▶</button><button data-act="evolve" class="on">Evolve ▸</button>');
    if (favs.length) {
      bd.insertAdjacentHTML('beforeend', '<div class="meta">Favourites (4–5★)</div>');
      var fv = document.createElement('div'); fv.className = 'favs'; bd.appendChild(fv);
      favs.forEach(function (f, i) {
        var d = document.createElement('div'); d.className = 'fav' + (S.preview && S.preview.item.id === f.id ? ' sel' : ''); d.dataset.act = 'fav'; d.dataset.i = i;
        d.title = starStr(f.stars) + ' · gen ' + f.gen; d.appendChild(thumb(f.g, t)); fv.appendChild(d);
      });
    }
    row('<button data-act="adopt">Adopt</button><button data-act="revert"' + (adopted ? '' : ' disabled') + '>Built-in</button><button data-act="reroll">Reroll unrated</button>');
    row('<button data-act="export">Export JSON</button><button data-act="reset">Restart track</button>');
    bd.insertAdjacentHTML('beforeend', '<div class="msg">' + msgText + '</div><div class="meta">' + (adopted ? 'Adopted: yes' : 'Adopted: built-in') + ' · showing ' +
      (t === 'color' ? (S.adopted[o] ? 'adopted' : 'built-in') + ' layout' : (S.adopted.color ? 'adopted' : 'built-in') + ' colours') + '</div>' +
      '<div class="hint">1–5 rate · ←/→ browse · E evolve · A adopt · L / C switch track. Rate what you like, Evolve breeds from the best.</div>');
  }

  hud.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.dataset.act, i = +el.dataset.i;
    if (a === 'close') return toggle();
    if (a === 'min') { hud.classList.toggle('min'); return render(); }
    if (a === 'track-layout' || a === 'track-color') { S.track = a.slice(6); S.preview = null; save(); apply(); return render(); }
    if (a === 'mut') { S.mut = i; save(); return render(); }
    if (a === 'sel') return select(i);
    if (a === 'rate') return rate(i);
    if (a === 'prev') return select(trackState().sel - 1);
    if (a === 'next') return select(trackState().sel + 1);
    if (a === 'evolve') return evolve();
    if (a === 'fav') { S.preview = { track: S.track, orient: favKey(), item: S.fav[favKey()][i] }; apply(); return render(); }
    if (a === 'adopt') return adopt();
    if (a === 'revert') return revert();
    if (a === 'reroll') return reroll();
    if (a === 'export') return exportJson();
    if (a === 'reset') return resetTrack();
  });
  // Drag the HUD by its header.
  hud.addEventListener('pointerdown', function (e) {
    if (!e.target.closest('.hd') || e.target.closest('button')) return;
    var r = hud.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    hud.setPointerCapture(e.pointerId);
    var move = function (ev) { hudPos = true; hud.style.left = cl(ev.clientX - dx, 0, window.innerWidth - 60) + 'px'; hud.style.top = cl(ev.clientY - dy, 0, window.innerHeight - 30) + 'px'; };
    var up = function () { hud.removeEventListener('pointermove', move); hud.removeEventListener('pointerup', up); };
    hud.addEventListener('pointermove', move); hud.addEventListener('pointerup', up);
  });
  document.addEventListener('keydown', function (e) {
    if (!S.open || (e.target && e.target.getAttribute && e.target.getAttribute('role') === 'slider')) return;
    if (e.key >= '1' && e.key <= '5') { if (!S.preview) rate(+e.key); }
    else if (e.key === 'ArrowRight') select(trackState().sel + 1);
    else if (e.key === 'ArrowLeft') select(trackState().sel - 1);
    else if (e.key === 'e' || e.key === 'E') evolve();
    else if (e.key === 'a' || e.key === 'A') adopt();
    else if (e.key === 'l' || e.key === 'L') { S.track = 'layout'; S.preview = null; save(); apply(); render(); }
    else if (e.key === 'c' || e.key === 'C') { S.track = 'color'; S.preview = null; save(); apply(); render(); }
    else return;
    e.preventDefault();
  });
  // A rotation changes which layout population is showing.
  var hudT = 0;
  window.addEventListener('resize', function () { if (!S.open) return; clearTimeout(hudT); hudT = setTimeout(render, 150); });

  // ---------------------------------------------------------------- start
  load();
  // Test hooks in the hash: #design opens the HUD; dtrack=color|layout, dsel=N pick a candidate, dfresh starts clean.
  var hp = {};
  location.hash.slice(1).split('&').forEach(function (kv) { var p = kv.split('='); hp[p[0]] = p[1] == null ? true : p[1]; });
  if (hp.dfresh) { S = null; try { localStorage.removeItem(STORE); } catch (e) { /* blocked */ } load(); }
  if (hp.design) S.open = true;
  if (hp.dtrack) S.track = hp.dtrack;
  if (hp.dsel != null) trackState().sel = +hp.dsel;
  if (hp.devolve) {   // rate A..C 5/4/3 and evolve once
    [5, 4, 3].forEach(function (s, i) { trackState().sel = i; rate(s); });
    evolve();
  }
  hud.style.display = S.open ? 'block' : 'none';
  apply();
  build();   // the panel was first built before this module loaded; rebuild so the Design key and adopted layout appear
  fit();
  render();
  // Hooks for headless tests.
  window.__design = { state: function () { return S; }, rate: rate, evolve: evolve, select: select, toggle: toggle, geometry: geometry, stageSize: stageSize,
                      track: function (t) { S.track = t; apply(); render(); } };
})();
