'use strict';
// ===================================================================
// Style Lab (replaced design mode, 2026-10-13). Loaded after script.js.
//
// Experiments with the panel's look, never its layout: window colours, texture, knob design, text font and text
// colour. A design is a set of categorical features over 22 dimensions (DIMS below). Rounds of 16 designs are rated
// 1-5 stars on the live panel. Every rating is logged as a datapoint: the design's features, measures derived from
// its rendered colours (label/window contrast, nameplate contrast, pointer/cap contrast, texture amount, panel
// lightness, colour harmony and temperature, text polarity), the time spent looking, and any re-rating. The Insights
// tab fits a rating model to that log (ridge regression: each value's effect with everything else held equal) and
// reports preferences, dislikes, threshold rules ("text must contrast with its window"), combinations that work or
// clash beyond their separate effects, and which dimensions drive the ratings most.
//
// Breeding each new round of 16:
// - Popular features: about half of each design's features are drawn from the features of designs rated above 3
//   stars (weighted by stars above 3; recent rounds count more). The rest come from Thompson sampling over every
//   active value, which favours untested values.
// - High variability: features are drawn independently, so a design recombines traits of many liked designs instead
//   of tweaking one. Each design must differ from every liked design in at least 45% of its features and from every
//   other design in the round in at least 40%. No value may fill more than its share of a round, 4 explorer designs
//   per round use the least-tested values, and no design is ever shown twice.
// - Elimination and novelty: once a value has 4+ ratings, scores clearly below average, has a clearly negative effect
//   in the rating model (so it is not blamed for bad company) and rarely appears in liked designs, it is retired and replaced from a reserve of untried values; at least 2 new values enter every round
//   while reserves last, and each new value appears in at least 2 designs of its first round.
// - No early convergence: everything above, plus at least 3 active values per dimension, and every 4th round the best
//   retired value comes back for a retest.
// Every 5-star design is kept in the 5★ folder; one can be adopted as the app's look, and the folder can be saved to
// a folder on disk. "Send to home base" copies the folder as JSON to paste into the project, where it is curated and
// altered in favorites/favorites.json; the folder tab lists those home-base designs too. Any favourite can be opened in
// the tuner, which cycles each element through the values the favourites chose (see "tuner" below). Storage:
// localStorage 'vfv-lab-v1'.
//
// Talks to script.js through: P, ICON_GREEN, TEXT (text measuring for the portrait layout), key, ui, build,
// scaleStage, drawPad, syncBlendLegend, currentFullscreenElement, UK / UL, and window.onPanelBuilt.
// ===================================================================
(function () {
  var STORE = 'vfv-lab-v1', ROUND = 16, EXPLORERS = 4, MIN_RATED = 12, K = 2;

  // ---------------------------------------------------------------- utilities
  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  var pick = function (a) { return a[Math.floor(Math.random() * a.length)]; };
  var shuffle = function (a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var wrap = function (h) { return ((h % 360) + 360) % 360; };
  var cl = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var gauss = function () { var u = 1 - Math.random(), v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  var uid = function () { return Math.random().toString(36).slice(2, 9); };
  var sum = function (a) { return a.reduce(function (s, v) { return s + v; }, 0); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var hsl = function (h, s, l, a) { return 'hsl' + (a != null ? 'a' : '') + '(' + Math.round(wrap(h)) + ',' + Math.round(cl(s, 0, 1) * 100) + '%,' + Math.round(cl(l, 0, 1) * 100) + '%' + (a != null ? ',' + a : '') + ')'; };
  // Colour maths for the derived measures: sRGB 0-255, WCAG relative luminance and contrast ratio.
  function rgb(h, s, l) {
    h = wrap(h); s = cl(s, 0, 1); l = cl(l, 0, 1);
    var f = function (n) { var k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
    return [f(0), f(8), f(4)];
  }
  function lum(c) { var t = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]; }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function mix(a, b, t) { return [0, 1, 2].map(function (i) { return a[i] * (1 - t) + b[i] * t; }); }
  var css3 = function (c) { return 'rgb(' + c.map(Math.round).join(',') + ')'; };

  // ---------------------------------------------------------------- feature space
  var FAMS = ['feedback', 'chroma', 'transform', 'color', 'layers', 'mix'];   // mix has no section any more; it mirrors layers
  var FAM5 = FAMS.slice(0, 5);
  var HUES = { red: 0, orange: 24, amber: 40, yellow: 54, lime: 85, green: 125, mint: 150, teal: 168, cyan: 188, sky: 200,
    blue: 215, indigo: 245, violet: 272, magenta: 305, pink: 335, neutral: null };
  var HUE_INIT = ['red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'violet', 'magenta', 'neutral'];
  var HUE_RES = ['amber', 'indigo', 'pink', 'mint', 'sky'];
  var PSAT = { muted: 0.14, soft: 0.28, rich: 0.48, vivid: 0.72 };
  var PLIGHT = { deep: 0.12, dark: 0.22, mid: 0.34, light: 0.55, pale: 0.74 };
  var STAGES = { black: [0, 0, 0.03], charcoal: [0, 0, 0.11], slate: [215, 0.12, 0.15], warm: [30, 0.12, 0.14], tinted: null, light: [40, 0.06, 0.86] };
  var ACCENTS = { green: [141, 1], cyan: [188, 1], amber: [40, 1], magenta: [305, 1], white: [0, 0], red: [2, 1], blue: [218, 1] };
  var TEXSTR = { subtle: 0.2, mild: 0.45, medium: 0.75, strong: 1.1 };
  var SHEEN = { matte: 0, soft: 0.4, glossy: 0.9 };
  var TRACK = { tight: 0.02, normal: 0.1, wide: 0.18 };
  // Fonts: [family, weights to load ('' = already loaded by index.html)]. All condensed, so the portrait layout's
  // measured spacing holds.
  var FONTS = { barlowSC: ['Barlow Semi Condensed', ''], barlowC: ['Barlow Condensed', '500;600;700;800'], robotoC: ['Roboto Condensed', '500;600;700;800'],
    oswald: ['Oswald', '500;600;700'], sairaC: ['Saira Condensed', '500;600;700;800'], archivoN: ['Archivo Narrow', '500;600;700'],
    plexC: ['IBM Plex Sans Condensed', '500;600;700'], firaC: ['Fira Sans Condensed', '500;600;700;800'], asapC: ['Asap Condensed', '500;600;700;800'],
    antonio: ['Antonio', '500;600;700'], encodeC: ['Encode Sans Condensed', '500;600;700;800'], sofiaC: ['Sofia Sans Condensed', '500;600;700;800'], teko: ['Teko', '500;600;700'] };
  var fontNames = {}; Object.keys(FONTS).forEach(function (k) { fontNames[k] = FONTS[k][0]; });

  // Dimensions: key, label, group, initial values, reserve values (introduced later), display names.
  var DIMS = [];
  FAM5.forEach(function (f) {
    DIMS.push({ k: 'hue.' + f, label: { feedback: 'Feedback', chroma: 'Chromakey', transform: 'Transform', color: 'Color', layers: 'Layers' }[f] + ' window colour',
      group: 'Colour', init: HUE_INIT, reserve: HUE_RES });
  });
  DIMS.push(
    { k: 'panel.sat', label: 'Window saturation', group: 'Colour', init: ['muted', 'soft', 'rich', 'vivid'], reserve: [] },
    { k: 'panel.light', label: 'Window lightness', group: 'Colour', init: ['deep', 'dark', 'mid', 'light', 'pale'], reserve: [] },
    { k: 'stage', label: 'Background', group: 'Colour', init: ['black', 'charcoal', 'slate', 'warm', 'tinted', 'light'], reserve: [] },
    { k: 'accent', label: 'Glass accent', group: 'Colour', init: ['green', 'cyan', 'amber', 'magenta', 'white'], reserve: ['red', 'blue'] },
    { k: 'outline', label: 'Window outline', group: 'Colour', init: ['none', 'gray', 'family'], reserve: ['light', 'thick'],
      names: { gray: 'grey', family: 'family colour', thick: 'thick family colour' } },
    { k: 'texture', label: 'Texture', group: 'Texture', init: ['flat', 'brushed', 'hatch', 'grille', 'spun', 'carbon'], reserve: ['grain', 'linen', 'scanlines', 'dots', 'weave', 'stripes'] },
    { k: 'texStrength', label: 'Texture strength', group: 'Texture', init: ['subtle', 'mild', 'medium', 'strong'], reserve: [] },
    { k: 'sheen', label: 'Sheen', group: 'Texture', init: ['matte', 'soft', 'glossy'], reserve: [] },
    { k: 'cap', label: 'Knob cap', group: 'Knobs', init: ['black', 'silver', 'family', 'chrome', 'ivory', 'graphite'], reserve: ['brass', 'red', 'glass'],
      names: { family: 'family colour' } },
    { k: 'skirt', label: 'Knob skirt', group: 'Knobs', init: ['knurled', 'smooth', 'none', 'ring'], reserve: ['fluted', 'metal'], names: { ring: 'family ring' } },
    { k: 'pointer', label: 'Knob pointer', group: 'Knobs', init: ['line', 'dot', 'needle', 'wedge'], reserve: ['triangle', 'notch'] },
    { k: 'pointerColor', label: 'Pointer colour', group: 'Knobs', init: ['ink', 'family', 'accent', 'red', 'black'], reserve: ['amber'],
      names: { ink: 'white', family: 'family colour' } },
    { k: 'scale', label: 'Knob scale', group: 'Knobs', init: ['ticks', 'faint', 'none', 'arc', 'familyArc'], reserve: ['glowArc'],
      names: { faint: 'faint ticks', familyArc: 'family-colour arc', glowArc: 'glowing arc' } },
    { k: 'font', label: 'Font', group: 'Font', init: ['barlowSC', 'barlowC', 'robotoC', 'oswald', 'sairaC', 'archivoN', 'plexC'],
      reserve: ['firaC', 'asapC', 'antonio', 'encodeC', 'sofiaC', 'teko'], names: fontNames },
    { k: 'weight', label: 'Label weight', group: 'Font', init: ['500', '600', '700', '800'], reserve: [], names: { 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'heavy' } },
    { k: 'case', label: 'Text case', group: 'Font', init: ['upper', 'title'], reserve: [], names: { upper: 'UPPERCASE', title: 'Title Case' } },
    { k: 'tracking', label: 'Letter spacing', group: 'Font', init: ['tight', 'normal', 'wide'], reserve: [] },
    { k: 'labelColor', label: 'Label colour', group: 'Text colour', init: ['dim', 'bright', 'family', 'familyDark', 'black', 'ivory', 'accent'], reserve: [],
      names: { dim: 'grey', bright: 'white', family: 'family tint', familyDark: 'dark family tint' } },
    { k: 'nameplate', label: 'Nameplate', group: 'Text colour', init: ['ink', 'filled', 'dark', 'outline', 'black'], reserve: ['panel', 'underline'],
      names: { ink: 'white chip', filled: 'family-colour chip', dark: 'dark chip', outline: 'outlined', black: 'black chip', panel: 'window-tone chip', underline: 'underlined' } }
  );
  var DIM = {}; DIMS.forEach(function (d) { DIM[d.k] = d; });
  // Override keys (exact values set at home base) that each element controls: changing the element (in the tuner) drops them.
  var OKEYS = { 'panel.sat': ['pSat'], 'panel.light': ['pLight'], stage: ['sHue', 'sSat', 'sLight'], accent: ['accentHue', 'glassHue', 'accSat', 'glassSat'],
    outline: ['outline'], texture: ['texture', 'texStr'], texStrength: ['texStr'], sheen: ['sheen'], cap: ['cap'], skirt: ['skirt'], pointer: ['pointer'],
    pointerColor: ['ptr'], scale: ['scale'], font: ['font'], weight: ['weight'], case: ['textCase'], tracking: ['tracking'], labelColor: ['label'], nameplate: ['tab'] };
  FAM5.forEach(function (f) { OKEYS['hue.' + f] = ['hue', 'sat']; });
  // Derived categorical measures (not sampled; computed from each design).
  var DERIVED = { harmony: 'Colour harmony', temperature: 'Colour temperature', polarity: 'Text polarity', hueAny: 'Window colour (any window)' };
  // Derived numeric measures, for threshold rules.
  var texName = function (v) { return v <= 0.05 ? 'none' : v <= 0.32 ? 'subtle' : v <= 0.6 ? 'mild' : v <= 0.92 ? 'medium' : 'strong'; };
  var NUMS = {
    labelContrast: { label: 'label/window contrast', fmt: function (v) { return v.toFixed(1) + ':1'; },
      up: 'Text must contrast with its window background', down: 'Softer, low-contrast labels are preferred' },
    tabContrast: { label: 'nameplate contrast', fmt: function (v) { return v.toFixed(1) + ':1'; },
      up: 'Nameplate text must contrast with its chip', down: 'Subtle nameplates are preferred' },
    ptrContrast: { label: 'pointer/cap contrast', fmt: function (v) { return v.toFixed(1) + ':1'; },
      up: 'Knob pointers must stand out from their caps', down: 'Pointers that blend into the cap are preferred' },
    texAmount: { label: 'texture amount', fmt: texName, up: 'Stronger textures are preferred', down: 'Textures should stay mild' },
    panelLight: { label: 'window lightness', fmt: function (v) { return Math.round(v * 100) + '% lightness'; },
      up: 'Lighter windows are preferred', down: 'Darker windows are preferred' },
    hueCount: { label: 'distinct window colours', fmt: function (v) { return Math.round(v) + ' colours'; },
      up: 'More distinct window colours are preferred', down: 'Fewer distinct window colours are preferred' }
  };
  function featLabel(k) { return DIM[k] ? DIM[k].label : DERIVED[k] || k; }
  function valueName(k, v) { var d = DIM[k]; return d && d.names && d.names[v] != null ? d.names[v] : String(v); }

  // ---------------------------------------------------------------- designs -> style parameters
  // Style parameters are design mode's colour genome plus the new knob / text fields; STYLE0 holds the new fields'
  // defaults, which add no CSS, so the shipped scheme renders exactly as it did under design mode.
  var STYLE0 = { skirt: 'knurled', pointer: 'line', scale: 'ticks', font: 'barlowSC', weight: '700', textCase: 'upper', tracking: 'normal', accSat: 1, glassSat: 0.5 };
  // The look the app shipped with before the day / night schemes (2026-10-16); kept for reference.
  var ORIGINAL = {
    id: 'shipped', tag: 'current',
    raw: { hue: [38.483, 85.606, 149.781, 319.632, 165.593, 254.772], sat: [0.72, 0.98, 1.05, 1.1, 1.1, 0.22], pSat: 0.3211, pLight: 0.3479,
      kSat: 0.72, kLight: 0.68, sHue: 16.187, sSat: 0, sLight: 0.0513, texture: 'grille', texStr: 0.0463, sheen: 0.5, outline: 'none', tab: 'ink',
      ptr: 'family', label: 'dim', cap: 'black', glassHue: 141, accentHue: 164.74 },
    f: { 'hue.feedback': 'amber', 'hue.chroma': 'lime', 'hue.transform': 'mint', 'hue.color': 'magenta', 'hue.layers': 'teal', 'panel.sat': 'soft',
      'panel.light': 'mid', stage: 'black', accent: 'cyan', outline: 'none', texture: 'grille', texStrength: 'subtle', sheen: 'soft', cap: 'black',
      skirt: 'knurled', pointer: 'line', pointerColor: 'family', scale: 'ticks', font: 'barlowSC', weight: '700', case: 'upper', tracking: 'normal',
      labelColor: 'dim', nameplate: 'ink' }
  };
  // The standard looks of the two colour schemes (the Day / Night key). Day is Favourite 17 tuned 2. Night (the app's
  // standard look) is Day with only its colour scheme, texture and window labels (nameplates) taken from Favourite 6
  // tuned (NIGHT_SRC), so both schemes share Day's knobs, font and label text. Both sources are home-base designs, so
  // later edits to them in favorites/favorites.json carry over (matched by id at startup). A design adopted in the Lab
  // replaces the look of the scheme on show.
  var NIGHT_SRC = { id: 'm4dqf4b', home: true, name: 'Favourite 6 tuned', f: {"hue.feedback":"red","hue.chroma":"lime","hue.transform":"violet","hue.color":"blue","hue.layers":"neutral","panel.sat":"rich","panel.light":"pale","stage":"slate","accent":"cyan","outline":"none","texture":"scanlines","texStrength":"subtle","sheen":"soft","cap":"graphite","skirt":"knurled","pointer":"line","pointerColor":"family","scale":"ticks","font":"barlowSC","weight":"700","case":"upper","tracking":"normal","labelColor":"familyDark","nameplate":"black"}, j: {"h":[10.917,-10.665,2.294,0.226,-2.808],"s":[0.004,0.043,-0.063,0.025,-0.062],"l":0.003,"p":0.005} };
  var BUILTIN = {
    day: { id: '3w46slf', home: true, name: 'Favourite 17 tuned 2', f: {"hue.feedback":"red","hue.chroma":"lime","hue.transform":"violet","hue.color":"amber","hue.layers":"blue","panel.sat":"rich","panel.light":"pale","stage":"light","accent":"cyan","outline":"family","texture":"hatch","texStrength":"subtle","sheen":"soft","cap":"graphite","skirt":"knurled","pointer":"line","pointerColor":"family","scale":"ticks","font":"sairaC","weight":"700","case":"upper","tracking":"tight","labelColor":"familyDark","nameplate":"ink"}, j: {"h":[9.091,-8.965,-9.177,-3.191,-5.68],"s":[0.036,-0.034,-0.051,0.053,0.086],"l":-0.006,"p":-0.001} }
  };
  var NIGHT_OWN = DIMS.filter(function (d) { return d.group === 'Colour' || d.group === 'Texture'; }).map(function (d) { return d.k; }).concat(['nameplate']);
  function nightFrom(day, src) {
    var sc = clone(day), owned = {};
    NIGHT_OWN.forEach(function (k) { sc.f[k] = src.f[k]; OKEYS[k].forEach(function (o) { owned[o] = 1; }); });
    sc.j = clone(src.j || { h: [0, 0, 0, 0, 0], s: [0, 0, 0, 0, 0], l: 0, p: 0 });   // the jitter only varies colour
    var o = {};
    if (day.o) Object.keys(day.o).forEach(function (k) { if (!owned[k]) o[k] = clone(day.o[k]); });
    if (src.o) Object.keys(src.o).forEach(function (k) { if (owned[k]) o[k] = clone(src.o[k]); });
    delete sc.o; delete sc.raw; delete sc.home;
    if (Object.keys(o).length) sc.o = o;
    sc.id = 'night'; sc.name = 'Night (Day + ' + src.name + ' colours)';
    return sc;
  }
  BUILTIN.night = nightFrom(BUILTIN.day, NIGHT_SRC);
  var SHIPPED = BUILTIN.night;
  // A design's style: from its raw parameters (the shipped scheme) or its features + jitter, then any overrides (o):
  // exact style values set at home base, e.g. { "pLight": 0.3, "hue": [40, 125, 168, 305, 168] }.
  function resolve(sc) {
    var st = resolveBase(sc);
    if (sc.o) Object.keys(sc.o).forEach(function (k) { st[k] = clone(sc.o[k]); });
    ['hue', 'sat'].forEach(function (k) { if (st[k] && st[k].length === 5) st[k].push(st[k][4]); });   // mix mirrors layers
    return st;
  }
  function resolveBase(sc) {
    if (sc.raw) return Object.assign({}, STYLE0, clone(sc.raw));
    var f = sc.f, j = sc.j || { h: [0, 0, 0, 0, 0], s: [0, 0, 0, 0, 0], l: 0, p: 0 }, st = Object.assign({}, STYLE0);
    st.hue = []; st.sat = [];
    FAM5.forEach(function (fam, i) {
      var h = HUES[f['hue.' + fam]];
      st.hue.push(h == null ? 220 : wrap(h + j.h[i])); st.sat.push(h == null ? 0 : 1 + j.s[i]);
    });
    st.hue.push(st.hue[4]); st.sat.push(st.sat[4]);
    st.pSat = cl(PSAT[f['panel.sat']] + j.p, 0, 1); st.pLight = cl(PLIGHT[f['panel.light']] + j.l, 0.04, 0.9);
    st.kSat = 0.72; st.kLight = 0.68;
    var sg = STAGES[f.stage] || [st.hue[0], 0.25, 0.12]; st.sHue = sg[0]; st.sSat = sg[1]; st.sLight = sg[2];
    var ac = ACCENTS[f.accent]; st.accentHue = st.glassHue = ac[0]; st.accSat = ac[1]; st.glassSat = ac[1] * 0.5;
    st.texture = f.texture; st.texStr = f.texture === 'flat' ? 0 : TEXSTR[f.texStrength]; st.sheen = SHEEN[f.sheen];
    st.outline = f.outline; st.tab = f.nameplate; st.ptr = f.pointerColor; st.label = f.labelColor; st.cap = f.cap;
    st.skirt = f.skirt; st.pointer = f.pointer; st.scale = f.scale; st.font = f.font; st.weight = f.weight; st.textCase = f.case; st.tracking = f.tracking;
    return st;
  }

  // ---------------------------------------------------------------- style parameters -> CSS
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
      case 'grain': return { img: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'140\' height=\'140\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'.85\' numOctaves=\'2\' stitchTiles=\'stitch\'/%3E%3CfeColorMatrix type=\'saturate\' values=\'0\'/%3E%3C/filter%3E%3Crect width=\'140\' height=\'140\' filter=\'url(%23n)\' opacity=\'' + Math.min(1, 0.32 * a).toFixed(3) + '\'/%3E%3C/svg%3E"),' + sheen, size: '140px 140px,auto' };
      case 'linen': return { img: 'repeating-linear-gradient(0deg,rgba(255,255,255,' + f(0.07) + ') 0 1px,transparent 1px 3px),repeating-linear-gradient(90deg,rgba(0,0,0,' + f(0.12) + ') 0 1px,transparent 1px 3px),' + sheen, size: 'auto' };
      case 'scanlines': return { img: 'repeating-linear-gradient(0deg,rgba(0,0,0,' + f(0.3) + ') 0 1px,transparent 1px 4px),' + sheen, size: 'auto' };
      case 'dots': return { img: 'radial-gradient(circle,rgba(255,255,255,' + f(0.22) + ') 1.3px,transparent 1.8px),' + sheen, size: '7px 7px,auto' };
      case 'weave': return { img: 'repeating-linear-gradient(45deg,rgba(255,255,255,' + f(0.07) + ') 0 2px,transparent 2px 6px),repeating-linear-gradient(-45deg,rgba(0,0,0,' + f(0.12) + ') 0 2px,transparent 2px 6px),' + sheen, size: 'auto' };
      case 'stripes': return { img: 'repeating-linear-gradient(90deg,rgba(255,255,255,' + f(0.06) + ') 0 14px,rgba(0,0,0,' + f(0.08) + ') 14px 28px),' + sheen, size: 'auto' };
      default: return { img: sheen, size: 'auto' };
    }
  }
  function panelColor(g, i) { return hsl(g.hue[i], g.pSat * g.sat[i], g.pLight); }
  function keyColor(g, i) { return hsl(g.hue[i], g.kSat * Math.min(1, g.sat[i] + 0.2), g.kLight); }
  var CAP_IMG = {
    silver: 'radial-gradient(circle at 45% 35%,#e8e8ec 0%,#a3a3a9 55%,#6b6b72 100%)',
    family: 'radial-gradient(circle at 45% 35%,color-mix(in srgb,var(--fc,#888) 70%,#fff),color-mix(in srgb,var(--fc,#888) 55%,#000) 60%,color-mix(in srgb,var(--fc,#888) 25%,#000) 100%)',
    chrome: 'conic-gradient(#f4f4f6,#8c8c94 12%,#e6e6ea 25%,#77777f 37%,#f0f0f2 50%,#85858d 62%,#ececf0 75%,#7a7a82 87%,#f4f4f6)',
    ivory: 'radial-gradient(circle at 45% 35%,#fbf5e6 0%,#d9cfb4 60%,#a89f86 100%)',
    graphite: 'radial-gradient(circle at 45% 35%,#46454a 0%,#3a393d 70%,#2e2d31 100%)',
    brass: 'radial-gradient(circle at 45% 35%,#f6dd95 0%,#b8913e 58%,#6e5420 100%)',
    red: 'radial-gradient(circle at 45% 35%,#ff7b6b 0%,#c0281c 60%,#6a0f08 100%)',
    glass: 'radial-gradient(circle at 45% 35%,rgba(255,255,255,0.4) 0%,rgba(255,255,255,0.08) 55%,rgba(0,0,0,0.25) 100%)'
  };
  function styleCss(g) {
    var css = '', stageC = hsl(g.sHue, g.sSat, g.sLight), tx = texture(g), acc = hsl(g.accentHue, g.accSat, 0.8);
    FAMS.forEach(function (f, i) { css += '#stage [data-fam="' + f + '"]{--anod:' + panelColor(g, i) + ';--fc:' + keyColor(g, i) + '}\n'; });
    css += 'html,body{background:' + stageC + '!important}\n';
    css += '#panel{background:linear-gradient(to bottom,' + hsl(g.sHue, g.sSat, g.sLight + 0.03) + ',' + stageC + ' 48px)!important}\n';
    css += '#stage .fam{background-color:var(--anod)!important;background-image:' + tx.img + '!important;background-size:' + tx.size + '!important}\n';
    css += {
      filled: '#stage .tab{background:var(--fc)!important;color:#19181a!important}',
      dark: '#stage .tab{background:#141316!important;color:var(--fc)!important;box-shadow:0 0 0 1px var(--fc)}',
      ink: '#stage .tab{background:#ebebeb!important;color:#19181a!important}',
      outline: '#stage .tab{background:' + stageC + '!important;color:var(--fc)!important;box-shadow:inset 0 0 0 1px var(--fc)}',
      black: '#stage .tab{background:#111013!important;color:#ebebeb!important}',
      panel: '#stage .tab{background:color-mix(in srgb,var(--anod) 70%,#000)!important;color:#ebebeb!important}',
      underline: '#stage .tab{background:' + stageC + '!important;color:#ebebeb!important;box-shadow:inset 0 -2px 0 var(--fc)}'
    }[g.tab] + '\n';
    css += { gray: '', family: '#stage div.frame{border-color:var(--fc)!important}', none: '#stage div.frame{border-color:transparent!important}',
      light: '#stage div.frame{border-color:rgba(255,255,255,0.55)!important}', thick: '#stage div.frame{border:2px solid var(--fc)!important}' }[g.outline] + '\n';
    css += { dim: '', family: '#stage .knob-label{color:var(--fc,#a6a4a8)!important}', bright: '#stage .knob-label{color:#ebebeb!important}',
      familyDark: '#stage .knob-label{color:color-mix(in srgb,var(--fc,#888) 45%,#000)!important}', black: '#stage .knob-label{color:#161517!important}',
      ivory: '#stage .knob-label{color:#efe6cf!important}', accent: '#stage .knob-label{color:' + acc + '!important}' }[g.label] + '\n';
    css += { ink: '', family: '#stage .knob-ptr{background:var(--fc,#ebebeb)!important}', accent: '#stage .knob-ptr{background:' + hsl(g.accentHue, 1, 0.8) + '!important;box-shadow:0 0 4px ' + hsl(g.accentHue, 1, 0.7) + '}',
      red: '#stage .knob-ptr{background:#ff4a3d!important}', black: '#stage .knob-ptr{background:#141316!important}', amber: '#stage .knob-ptr{background:#ffb02e!important}' }[g.ptr] + '\n';
    css += (g.cap === 'black' ? '' : '#stage .knob-cap{background:' + CAP_IMG[g.cap] + '!important}' + (g.cap === 'glass' ? '#stage .knob-cap{box-shadow:inset 0 0 0 1px rgba(255,255,255,0.3)!important}' : '')) + '\n';
    // The new dimensions add CSS only when they differ from STYLE0.
    css += {
      knurled: '', smooth: '#stage .knob-skirt{background:#1b1a1d!important}',
      none: '#stage .knob-skirt{background:transparent!important;box-shadow:none!important}#stage .knob-cap{inset:3%!important;box-shadow:0 0 0 1px #050505,0 5px 9px rgba(0,0,0,0.55),inset 0 1px 0 rgba(255,255,255,0.12)!important}',
      ring: '#stage .knob-skirt{background:var(--fc,#888)!important}',
      fluted: '#stage .knob-skirt{background:repeating-conic-gradient(#2c2b2f 0deg 11.25deg,#141316 11.25deg 22.5deg)!important}',
      metal: '#stage .knob-skirt{background:conic-gradient(#d6d6da,#6d6d74 25%,#cfcfd4 50%,#66666d 75%,#d6d6da)!important}'
    }[g.skirt];
    css += {
      line: '', dot: '#stage .knob-ptr{width:6px!important;height:6px!important;margin-left:-3px!important;top:9%!important;border-radius:50%!important}',
      needle: '#stage .knob-ptr{width:1.5px!important;margin-left:-0.75px!important;top:2%!important;height:48%!important}',
      wedge: '#stage .knob-ptr{width:5px!important;margin-left:-2.5px!important;top:5%!important;height:30%!important;border-radius:2px!important}',
      triangle: '#stage .knob-ptr{width:10px!important;height:11px!important;margin-left:-5px!important;top:6%!important;border-radius:0!important;clip-path:polygon(50% 0,100% 100%,0 100%)}',
      notch: '#stage .knob-ptr{width:4px!important;margin-left:-2px!important;top:0!important;height:18%!important;border-radius:0!important}'
    }[g.pointer];
    css += {
      ticks: '', faint: '#stage .knob-scale{opacity:0.4}', none: '#stage .knob-scale{display:none}',
      arc: '#stage .knob-scale{background:conic-gradient(from -135deg,#8f8d92 0deg 270deg,transparent 270deg)!important}',
      familyArc: '#stage .knob-scale{background:conic-gradient(from -135deg,var(--fc,#a6a4a8) 0deg 270deg,transparent 270deg)!important}',
      glowArc: '#stage .knob-scale{background:conic-gradient(from -135deg,' + acc + ' 0deg 270deg,transparent 270deg)!important;filter:drop-shadow(0 0 3px ' + acc + ')}'
    }[g.scale];
    if (g.font !== 'barlowSC') css += '#stage{font-family:"' + FONTS[g.font][0] + '","Barlow Semi Condensed","Segoe UI",sans-serif!important}';
    if (g.weight !== '700') css += '#stage .knob-label{font-weight:' + g.weight + '!important}';
    if (g.textCase === 'title') css += '#stage .knob-label,#stage .tab{text-transform:none!important}';
    if (g.tracking !== 'normal') css += '#stage .knob-label{letter-spacing:' + TRACK[g.tracking] + 'em!important}';
    return css;
  }

  // ---------------------------------------------------------------- derived measures
  var CAPC = { black: [42, 41, 45], silver: [163, 163, 169], chrome: [184, 184, 190], ivory: [217, 207, 180], graphite: [58, 57, 61], brass: [184, 145, 62], red: [192, 40, 28], glass: [70, 70, 76] };
  var WARM = { red: 1, orange: 1, amber: 1, yellow: 1, pink: 1, magenta: 1 }, COOL = { green: 1, mint: 1, teal: 1, cyan: 1, sky: 1, blue: 1, indigo: 1, violet: 1 };
  function harmony(hs) {
    if (!hs.length) return 'neutral';
    if (hs.length === 1) return 'monochrome';
    var s = hs.slice().sort(function (a, b) { return a - b; }), gap = 0;
    for (var i = 0; i < s.length; i++) gap = Math.max(gap, wrap(s[(i + 1) % s.length] - s[i]) || 360);
    var span = 360 - gap, near = function (a, b, tol) { var d = Math.abs(wrap(a - b)); return Math.min(d, 360 - d) <= tol; };
    if (span <= 70) return 'analogous';
    var fits = function (step, tol) { return s.some(function (h0) { return s.every(function (h) { for (var k = 0; k < 360; k += step) if (near(h, h0 + k, tol)) return true; return false; }); }); };
    if (fits(180, 35)) return 'complementary';
    if (s.length >= 3 && fits(120, 30)) return 'triadic';
    return span >= 250 ? 'rainbow' : 'mixed';
  }
  function derive(st, f) {
    var bg = [], fc = [], i;
    for (i = 0; i < 5; i++) {
      bg.push(rgb(st.hue[i], st.pSat * st.sat[i], st.pLight));
      fc.push(rgb(st.hue[i], st.kSat * Math.min(1, st.sat[i] + 0.2), st.kLight));
    }
    var acc = rgb(st.accentHue, st.accSat, 0.8), stage = rgb(st.sHue, st.sSat, st.sLight), W = [235, 235, 235], D = [25, 24, 26];
    var lab = function (k) { return { dim: [166, 164, 168], bright: W, family: fc[k], familyDark: mix(fc[k], [0, 0, 0], 0.55), black: [22, 21, 23], ivory: [239, 230, 207], accent: acc }[st.label]; };
    var tab = function (k) { return { ink: [W, D], filled: [fc[k], D], dark: [[20, 19, 22], fc[k]], outline: [stage, fc[k]], black: [[17, 16, 19], W], panel: [mix(bg[k], [0, 0, 0], 0.3), W], underline: [stage, W] }[st.tab]; };
    var labelContrast = Infinity, tabContrast = Infinity;
    for (i = 0; i < 5; i++) {
      labelContrast = Math.min(labelContrast, contrast(lab(i), bg[i]));
      var t = tab(i); tabContrast = Math.min(tabContrast, contrast(t[0], t[1]));
    }
    var cap = st.cap === 'family' ? mix(fc[0], [0, 0, 0], 0.45) : CAPC[st.cap];
    var ptr = { ink: W, family: fc[0], accent: rgb(st.accentHue, 1, 0.8), red: [255, 74, 61], black: [20, 19, 22], amber: [255, 176, 46] }[st.ptr];
    var names = FAM5.map(function (fam) { return f['hue.' + fam]; }).filter(function (n) { return n !== 'neutral'; });
    var uniq = names.filter(function (n, k) { return names.indexOf(n) === k; });
    var w = names.filter(function (n) { return WARM[n]; }).length, c = names.filter(function (n) { return COOL[n]; }).length;
    return {
      num: { labelContrast: labelContrast, tabContrast: tabContrast, ptrContrast: contrast(ptr, cap), texAmount: st.texStr, panelLight: st.pLight, hueCount: uniq.length },
      cat: { harmony: harmony(uniq.map(function (n) { return HUES[n]; })), temperature: w + c === 0 ? 'neutral' : w >= 0.75 * (w + c) ? 'warm' : c >= 0.75 * (w + c) ? 'cool' : 'mixed',
        polarity: lum(lab(0)) > lum(bg[0]) ? 'light text on a darker window' : 'dark text on a lighter window' },
      hues: uniq
    };
  }

  // ---------------------------------------------------------------- state
  var S;
  function initPools() {
    var p = {};
    DIMS.forEach(function (d) { p[d.k] = { active: d.init.slice(), retired: [], reserve: shuffle(d.reserve.slice()), fresh: [], retest: [] }; });
    return p;
  }
  function fresh() { return { v: 1, open: false, tab: 'rate', round: 0, cands: [], sel: 0, fsel: -1, recs: [], pools: initPools(), folder: [], mode: 'night', looks: { night: null, day: null }, lookV: 2, seen: {}, log: [], meta: [] }; }
  function load() {
    try { S = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { S = null; }
    if (!S || S.v !== 1) S = fresh();
    // Day / night schemes (2026-10-16): each scheme keeps its own adopted look. A look adopted before then is dropped
    // so the new standard (Favourite 6 tuned) shows.
    if (!S.looks) S.looks = { night: null, day: null };
    delete S.adopted;
    // Night rebuilt on Day's base (2026-10-16): looks adopted before then are dropped so the new standards show.
    if (S.lookV !== 2) { S.looks = { night: null, day: null }; S.lookV = 2; }
    if (S.mode !== 'day') S.mode = 'night';
  }
  function look() { return S.looks[S.mode]; }
  var saveFailed = false, simulating = false;
  function save() {
    if (simulating) return;
    try { localStorage.setItem(STORE, JSON.stringify(S)); saveFailed = false; }
    catch (e) { if (!saveFailed) flashMsg('Browser storage is full: export the data (Insights) to keep it.'); saveFailed = true; }
  }
  var hashF = function (f) { return DIMS.map(function (d) { return f[d.k]; }).join('|'); };

  // ---------------------------------------------------------------- analysis
  function catFeatures(r) {
    var out = [];
    DIMS.forEach(function (d) { out.push([d.k, r.f[d.k]]); });
    Object.keys(r.d).forEach(function (k) { out.push([k, r.d[k]]); });
    (r.h || []).forEach(function (v) { out.push(['hueAny', v]); });
    return out;
  }
  function analyze() {
    var recs = S.recs.filter(function (r) { return r.stars; }), n = recs.length, mu = n ? sum(recs.map(function (r) { return r.stars; })) / n : 3, val = {};
    recs.forEach(function (r) {
      catFeatures(r).forEach(function (kv) {
        if (kv[1] === 'n/a' || kv[1] == null) return;
        var m = val[kv[0]] = val[kv[0]] || {}, s = m[kv[1]] = m[kv[1]] || { n: 0, sum: 0, pop: 0 };
        s.n++; s.sum += r.stars; if (r.stars > 3) s.pop++;
      });
    });
    return { recs: recs, n: n, mu: mu, val: val };
  }
  function shr(s, mu) { return (s.sum + K * mu) / (s.n + K); }
  function stat(A, k, v) { return (A.val[k] && A.val[k][v]) || { n: 0, sum: 0, pop: 0 }; }

  // The rating model: ridge regression of stars on every feature value (one-hot), the derived categories and the
  // standardised derived measures. A coefficient is a value's effect in stars with everything else held equal, so a
  // feature that merely rides along in liked designs (confounding) gets little credit. Cached per set of ratings.
  var LAMBDA = 3, modelCache = { key: '', m: null };
  function model(A) {
    var key = A.n + ':' + A.recs.map(function (r) { return r.stars; }).join('');
    if (modelCache.key === key) return modelCache.m;
    var recs = A.recs, mu = A.mu, cols = [], idx = {};
    var add = function (id, c) { if (idx[id] == null) { idx[id] = cols.length; cols.push(c); } };
    var cats = function (r) {
      var out = [];
      DIMS.forEach(function (d) { if (r.f[d.k] !== 'n/a') out.push([d.k, r.f[d.k]]); });
      ['harmony', 'temperature', 'polarity'].forEach(function (k) { out.push([k, r.d[k]]); });
      return out;
    };
    recs.forEach(function (r) { cats(r).forEach(function (kv) { add(kv[0] + '=' + kv[1], { k: kv[0], v: kv[1] }); }); });
    var nums = Object.keys(NUMS).filter(function (k) { return recs.every(function (r) { return r.x && r.x[k] != null && isFinite(r.x[k]); }); });
    nums.forEach(function (k) {
      var xs = recs.map(function (r) { return r.x[k]; }), m = sum(xs) / xs.length, sd = Math.sqrt(sum(xs.map(function (x) { return (x - m) * (x - m); })) / xs.length) || 1;
      add('#' + k, { k: k, num: true, m: m, sd: sd });
    });
    var p = cols.length, M = new Float64Array(p * p), b = new Float64Array(p), rows = [];
    recs.forEach(function (r) {
      var e = cats(r).map(function (kv) { return [idx[kv[0] + '=' + kv[1]], 1]; });
      nums.forEach(function (k) { var c = cols[idx['#' + k]]; e.push([idx['#' + k], (r.x[k] - c.m) / c.sd]); });
      var y = r.stars - mu;
      e.forEach(function (a) { b[a[0]] += a[1] * y; e.forEach(function (c) { M[a[0] * p + c[0]] += a[1] * c[1]; }); });
      rows.push(e);
    });
    for (var i = 0; i < p; i++) M[i * p + i] += LAMBDA;
    var beta = cholSolve(M, b, p);
    // Residuals (for interactions) and each feature's share of the explained variance (for drivers).
    var resid = [], contrib = {};
    rows.forEach(function (e, ri) {
      var fit = 0, per = {};
      e.forEach(function (a) { var v = a[1] * beta[a[0]], g = cols[a[0]].k; fit += v; per[g] = (per[g] || 0) + v; });
      resid.push(recs[ri].stars - mu - fit);
      Object.keys(per).forEach(function (g) { (contrib[g] = contrib[g] || []).push(per[g]); });
    });
    var share = {}, tv = 0;
    Object.keys(contrib).forEach(function (g) { var c = contrib[g], m = sum(c) / recs.length; share[g] = sum(c.map(function (v) { return (v - m) * (v - m); })) / recs.length; tv += share[g]; });
    Object.keys(share).forEach(function (g) { share[g] /= tv || 1; });
    var sigma = Math.sqrt(sum(resid.map(function (e) { return e * e; })) / Math.max(1, resid.length)) || 1;
    var ns = cols.map(function (c) { return c.num ? 0 : stat(A, c.k, c.v).n; });
    // rel(k, v): value v's effect against the other values of feature k (weighted by how often each was rated),
    // everything else equal, and its approximate standard error.
    var rel = function (k, v) {
      var i0 = idx[k + '=' + v]; if (i0 == null) return { e: 0, se: Infinity };
      var on = 0, os = 0;
      cols.forEach(function (c, i) { if (!c.num && c.k === k && i !== i0) { on += ns[i]; os += ns[i] * beta[i]; } });
      if (!on) return { e: 0, se: Infinity };
      return { e: beta[i0] - os / on, se: sigma * Math.sqrt(1 / (ns[i0] + LAMBDA) + 1 / (on + LAMBDA)) };
    };
    var m = { beta: function (id) { return idx[id] == null ? 0 : beta[idx[id]]; }, rel: rel, cols: cols, idx: idx, b: beta, resid: resid, share: share, sigma: sigma };
    modelCache = { key: key, m: m };
    return m;
  }
  function cholSolve(M, b, n) {   // M symmetric positive definite (ridge makes it so)
    var L = new Float64Array(n * n), i, j, k, s;
    for (i = 0; i < n; i++) for (j = 0; j <= i; j++) {
      s = M[i * n + j];
      for (k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j];
    }
    var y = new Float64Array(n), x = new Float64Array(n);
    for (i = 0; i < n; i++) { s = b[i]; for (k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
    for (i = n - 1; i >= 0; i--) { s = y[i]; for (k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
    return x;
  }

  // Insights: plain statements, each with a strength score for ordering.
  function insights() {
    var A = analyze(), out = [], mu = A.mu;
    if (A.n < 20) return { A: A, items: [], note: 'Rate at least 20 designs for insights (' + A.n + ' so far). Each round of 16 sharpens them.' };
    var Mo = model(A), star = function (v) { return v.toFixed(1) + '★'; }, sgn = function (v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '★'; };
    // Preferences and dislikes: model effects, with the plain average for context.
    var prefs = [], avoids = [];
    Mo.cols.forEach(function (c, i) {
      if (c.num) return;
      var s = stat(A, c.k, c.v), r = Mo.rel(c.k, c.v), e = r.e;
      if (s.n < 5 || Math.abs(e) / r.se < 3) return;   // ~150 values are tested at once, so the bar is 3 standard errors
      var it = { k: c.k, v: c.v, s: s, e: e };
      if (e >= 0.4) prefs.push(it); else if (e <= -0.4) avoids.push(it);
    });
    var bestOf = {};
    prefs.forEach(function (p) { if (!bestOf[p.k] || p.e > bestOf[p.k].e) bestOf[p.k] = p; });
    prefs = Object.keys(bestOf).map(function (k) { return bestOf[k]; });
    var conf = function (it) { return Math.abs(it.e) * Math.min(1, it.s.n / 8); };
    prefs.sort(function (a, b) { return conf(b) - conf(a); }).slice(0, 12).forEach(function (it) {
      out.push({ kind: 'prefer', score: 2 + conf(it), text: featLabel(it.k) + ': ' + valueName(it.k, it.v) + ' preferred: ' + sgn(it.e) +
        ' against the alternatives, everything else equal (' + star(it.s.sum / it.s.n) + ' average over ' + it.s.n + ' ratings).' });
    });
    avoids.sort(function (a, b) { return conf(b) - conf(a); }).slice(0, 10).forEach(function (it) {
      out.push({ kind: 'avoid', score: 1.8 + conf(it), text: featLabel(it.k) + ': ' + valueName(it.k, it.v) + ' disliked: ' + sgn(it.e) +
        ' against the alternatives, everything else equal (' + star(it.s.sum / it.s.n) + ' average over ' + it.s.n + ' ratings).' });
    });
    // Threshold rules on the derived measures: the cut that best separates ratings, kept only if nearly all liked
    // designs sit on one side and the model, with every feature held equal, agrees on the direction.
    Object.keys(NUMS).forEach(function (k) {
      var rs = A.recs.filter(function (r) { return r.x && r.x[k] != null && isFinite(r.x[k]); }).sort(function (a, b) { return a.x[k] - b.x[k]; });
      if (rs.length < 12) return;
      var best = null;
      for (var i = 4; i <= rs.length - 4; i++) {
        if (rs[i].x[k] === rs[i - 1].x[k]) continue;
        var lo = rs.slice(0, i), hi = rs.slice(i), ml = sum(lo.map(function (r) { return r.stars; })) / lo.length, mh = sum(hi.map(function (r) { return r.stars; })) / hi.length;
        if (!best || Math.abs(mh - ml) > Math.abs(best.d)) best = { d: mh - ml, t: (rs[i].x[k] + rs[i - 1].x[k]) / 2, lo: lo, hi: hi, ml: ml, mh: mh };
      }
      if (!best || Math.abs(best.d) < 0.8) return;
      var bnum = Mo.beta('#' + k);
      if (bnum * best.d <= 0 || Math.abs(bnum) < 0.1) return;   // explained by other features
      var good = best.d > 0 ? best.hi : best.lo, bad = best.d > 0 ? best.lo : best.hi;
      var liked = A.recs.filter(function (r) { return r.stars >= 4 && r.x && r.x[k] != null; });
      var share = liked.length ? liked.filter(function (r) { return good.indexOf(r) >= 0; }).length / liked.length : 0;
      if (share < 0.8 || liked.length < 4) return;
      var N = NUMS[k], gm = best.d > 0 ? best.mh : best.ml, bm = best.d > 0 ? best.ml : best.mh;
      var edge = best.d > 0 ? good[0].x[k] : good[good.length - 1].x[k];   // the good side's value nearest the cut
      out.push({ kind: 'rule', score: 3 + Math.abs(best.d) * share,
        text: (best.d > 0 ? N.up : N.down) + ': keep the ' + N.label + ' ' + (best.d > 0 ? 'at or above ' : 'at or below ') + N.fmt(k === 'texAmount' ? edge : best.t) + '. ' +
          Math.round(share * 100) + '% of your 4–5★ designs do; designs on the other side average ' + star(bm) + ' (n=' + bad.length + ') vs ' + star(gm) + ' (n=' + good.length + ').' });
    });
    // Interactions: pairs of values whose designs score well above (or below) what the model predicts from the two
    // separately. Many pairs are tested, so the bar is high: 8+ designs, half a star, and a t-score of 3.5.
    var pairs = {};
    A.recs.forEach(function (r, ri) {
      var fs = catFeatures(r).filter(function (kv) { return kv[1] !== 'n/a' && kv[0] !== 'hueAny'; }), e = Mo.resid[ri];
      for (var a = 0; a < fs.length; a++) for (var b = a + 1; b < fs.length; b++) {
        var key = fs[a][0] + '=' + fs[a][1] + '|' + fs[b][0] + '=' + fs[b][1], s = pairs[key] = pairs[key] || { n: 0, sum: 0, sq: 0, st: 0 };
        s.n++; s.sum += e; s.sq += e * e; s.st += r.stars;
      }
    });
    var inter = [];
    Object.keys(pairs).forEach(function (key) {
      var s = pairs[key]; if (s.n < 8) return;
      var m = s.sum / s.n, sd = Math.sqrt(Math.max(1e-6, s.sq / s.n - m * m)), t = m / (sd / Math.sqrt(s.n - 1));
      if (Math.abs(m) < 0.5 || Math.abs(t) < 3.5) return;
      var p = key.split('|').map(function (x) { var i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; });
      inter.push({ m: m, t: t, n: s.n, avg: s.st / s.n, text: featLabel(p[0][0]).toLowerCase() + ' ' + valueName(p[0][0], p[0][1]) + ' with ' + featLabel(p[1][0]).toLowerCase() + ' ' + valueName(p[1][0], p[1][1]) });
    });
    inter.sort(function (a, b) { return Math.abs(b.t) - Math.abs(a.t); }).slice(0, 6).forEach(function (c) {
      out.push({ kind: c.m > 0 ? 'combo' : 'clash', score: 1.5 + Math.abs(c.m),
        text: (c.m > 0 ? 'Works together: ' : 'Clash: ') + c.text + ': ' + sgn(c.m) + ' beyond their separate effects (' + star(c.avg) + ' average, n=' + c.n + ').' });
    });
    // Drivers: each feature's share of what the model explains.
    var drivers = Object.keys(Mo.share).map(function (g) { return { name: NUMS[g] ? NUMS[g].label : featLabel(g).toLowerCase(), v: Mo.share[g] }; }).sort(function (a, b) { return b.v - a.v; });
    out.push({ kind: 'drivers', score: 2.5, text: 'What drives your ratings most: ' + drivers.slice(0, 5).map(function (d) { return d.name + ' (' + Math.round(d.v * 100) + '%)'; }).join(', ') + '.' });
    // A one-line taste profile from the strongest preference in each group.
    var groups = {};
    prefs.forEach(function (it) { var g = DIM[it.k] && DIM[it.k].group; if (g && (!groups[g] || it.e > groups[g].e)) groups[g] = it; });
    var prof = ['Colour', 'Texture', 'Knobs', 'Font', 'Text colour'].filter(function (g) { return groups[g]; }).map(function (g) { var it = groups[g]; return featLabel(it.k).toLowerCase() + ' ' + valueName(it.k, it.v); });
    if (prof.length) out.push({ kind: 'taste', score: 10, text: 'Your taste so far: ' + prof.join(' · ') + '.' });
    out.sort(function (a, b) { return b.score - a.score; });
    return { A: A, items: out, note: '' };
  }
  function cap1(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }

  // ---------------------------------------------------------------- breeding
  function jitter() {
    return { h: FAM5.map(function () { return gauss() * 6; }), s: FAM5.map(function () { return rnd(-0.1, 0.1); }), l: rnd(-0.02, 0.02), p: rnd(-0.03, 0.03) };
  }
  function dist(a, b) { var d = 0; DIMS.forEach(function (x) { if (a[x.k] !== b[x.k]) d++; }); return d / DIMS.length; }
  function minDist(f, list) { var m = 1; list.forEach(function (g) { m = Math.min(m, dist(f, g)); }); return m; }
  function diversity(cands) {
    var t = 0, n = 0;
    for (var a = 0; a < cands.length; a++) for (var b = a + 1; b < cands.length; b++) { t += dist(cands[a].f, cands[b].f); n++; }
    return n ? t / n : 0;
  }
  function popularDists() {
    var w = {};
    S.recs.forEach(function (r) {
      if (!(r.stars > 3)) return;
      var wt = (r.stars - 3) * Math.pow(0.8, Math.max(0, S.round - r.round));
      DIMS.forEach(function (d) { var v = r.f[d.k]; if (v === 'n/a') return; (w[d.k] = w[d.k] || {}); w[d.k][v] = (w[d.k][v] || 0) + wt; });
    });
    return w;
  }
  function pickValue(d, explorer, counts, pop, A) {
    var p = S.pools[d.k], cap = Math.max(3, Math.ceil(ROUND / p.active.length) + 2);
    var allowed = p.active.filter(function (v) { return (counts[d.k][v] || 0) < cap; });
    if (!allowed.length) allowed = p.active.slice();
    if (explorer) {
      if (Math.random() < 0.7) {
        var least = Infinity, opts = [];
        allowed.forEach(function (v) { var n = stat(A, d.k, v).n; if (n < least) { least = n; opts = [v]; } else if (n === least) opts.push(v); });
        return pick(opts);
      }
      return pick(allowed);
    }
    var w = pop[d.k];
    if (w && Math.random() < 0.5) {
      var ws = allowed.map(function (v) { return w[v] || 0; }), tot = sum(ws);
      if (tot > 0) { var r = Math.random() * tot; for (var i = 0; i < allowed.length; i++) { r -= ws[i]; if (r <= 0) return allowed[i]; } }
    }
    var best = null, bs = -Infinity;   // Thompson sampling: untested values have wide posteriors, so they get picked
    allowed.forEach(function (v) {
      var s = stat(A, d.k, v), x = shr(s, A.mu) + gauss() * 1.4 / Math.sqrt(s.n + 1);
      if (x > bs) { bs = x; best = v; }
    });
    return best;
  }
  function breed() {
    var A = analyze(), pop = popularDists(), liked = S.recs.filter(function (r) { return r.stars > 3; }).map(function (r) { return r.f; });
    var cands = [], counts = {};
    DIMS.forEach(function (d) { counts[d.k] = {}; });
    var tally = function (f) { DIMS.forEach(function (d) { counts[d.k][f[d.k]] = (counts[d.k][f[d.k]] || 0) + 1; }); };
    if (S.round === 1) {
      // First round: the current look as a reference, then every dimension's values dealt out evenly at random.
      var cur = look() || BUILTIN[S.mode], c0 = { id: uid(), f: clone(cur.f), stars: 0, tag: 'current' };
      if (cur.raw) c0.raw = clone(cur.raw); else c0.j = clone(cur.j || { h: [0, 0, 0, 0, 0], s: [0, 0, 0, 0, 0], l: 0, p: 0 });
      cands.push(c0);
      var deal = {};
      DIMS.forEach(function (d) { var a = []; while (a.length < ROUND) a = a.concat(shuffle(S.pools[d.k].active.slice())); deal[d.k] = a; });
      for (var k = 1; k < ROUND; k++) {
        var f1 = {}; DIMS.forEach(function (d) { f1[d.k] = deal[d.k][k]; });
        cands.push({ id: uid(), f: f1, j: jitter(), stars: 0 });
      }
    } else {
      for (var c = 0; c < ROUND; c++) {
        var explorer = c >= ROUND - EXPLORERS, best = null, bestScore = -Infinity;
        for (var a = 0; a < 90; a++) {
          var f = {};
          DIMS.forEach(function (d) { f[d.k] = pickValue(d, explorer, counts, pop, A); });
          var dl = liked.length ? minDist(f, liked) : 1, dc = minDist(f, cands.map(function (x) { return x.f; })), seen = S.seen[hashF(f)];
          var relax = Math.floor(a / 30) * 0.05;
          if (!seen && dl >= 0.45 - relax && dc >= 0.4 - relax) { best = f; break; }
          var score = Math.min(dl, dc) - (seen ? 1 : 0);
          if (score > bestScore) { bestScore = score; best = f; }
        }
        tally(best);
        cands.push({ id: uid(), f: best, j: jitter(), stars: 0, tag: explorer ? 'explore' : '' });
      }
      // Each value introduced this round appears in at least 2 designs.
      DIMS.forEach(function (d) {
        S.pools[d.k].fresh.forEach(function (v) {
          var have = cands.filter(function (x) { return x.f[d.k] === v; }).length;
          shuffle(cands.slice()).forEach(function (x) { if (have < 2 && x.f[d.k] !== v) { x.f[d.k] = v; have++; } });
        });
      });
    }
    cands.forEach(function (x) { S.seen[hashF(x.f)] = 1; });
    return cands;
  }
  // Between rounds: retire values that clearly fail, bring in new ones, and now and then retest a retired one.
  function evolvePools() {
    var A = analyze(), mu = A.mu, P = S.pools, ch = { round: S.round + 1, retired: [], introduced: [], retest: [] };
    DIMS.forEach(function (d) { P[d.k].fresh = []; P[d.k].retest = []; });
    var introduce = function (k) { var p = P[k]; if (!p.reserve.length) return false; var v = p.reserve.shift(); p.active.push(v); p.fresh.push(v); ch.introduced.push([k, v]); return true; };
    var cands = [], Mo = A.n >= 20 ? model(A) : null;
    DIMS.forEach(function (d) {
      P[d.k].active.forEach(function (v) {
        var s = stat(A, d.k, v); if (s.n < 4) return;
        var m = shr(s, mu), e = Mo ? Mo.rel(d.k, v).e : m - mu;
        if (m <= mu - 0.4 && e <= -0.4 && s.pop / s.n < 0.2) cands.push({ k: d.k, v: v, m: e });
      });
    });
    cands.sort(function (a, b) { return a.m - b.m; }).slice(0, 5).forEach(function (c) {
      var p = P[c.k];
      if (p.active.length <= 3 && !p.reserve.length) return;   // keep at least 3 values in play
      p.active.splice(p.active.indexOf(c.v), 1); p.retired.push(c.v); ch.retired.push([c.k, c.v]);
      introduce(c.k);
    });
    var withRes = DIMS.filter(function (d) { return P[d.k].reserve.length; });
    while (ch.introduced.length < 2 && withRes.length) {
      var d = withRes.splice(Math.floor(Math.random() * withRes.length), 1)[0];
      introduce(d.k);
    }
    if ((S.round + 1) % 4 === 0) {   // retest the best retired value
      var best = null;
      DIMS.forEach(function (d2) { P[d2.k].retired.forEach(function (v) { var m = shr(stat(A, d2.k, v), mu); if (!best || m > best.m) best = { k: d2.k, v: v, m: m }; }); });
      if (best) { var p2 = P[best.k]; p2.retired.splice(p2.retired.indexOf(best.v), 1); p2.active.push(best.v); p2.fresh.push(best.v); p2.retest.push(best.v); ch.retest.push([best.k, best.v]); }
    }
    return ch;
  }
  function nextRound(force) {
    var rated = S.cands.filter(function (c) { return c.stars; }).length;
    if (S.round && rated < MIN_RATED && !force) return flashMsg('Rate at least ' + MIN_RATED + ' of the 16 first (' + rated + ' so far).');
    var ch = S.round ? evolvePools() : null;
    S.round++;
    S.cands = breed(); S.sel = 0; selT = Date.now();
    S.meta.push({ round: S.round, div: +diversity(S.cands).toFixed(3) });
    if (ch) S.log.push(ch);
    save();
    if (!force) { apply(); flashMsg(ch ? changeText(ch) : 'Round 1: rate each design 1–5 on the live panel.'); }
  }
  function changeText(ch) {
    var f = function (l) { return l.map(function (x) { return valueName(x[0], x[1]) + ' (' + featLabel(x[0]).toLowerCase() + ')'; }).join(', '); };
    var t = 'Round ' + ch.round + '.';
    if (ch.retired.length) t += ' Retired: ' + f(ch.retired) + '.';
    if (ch.introduced.length) t += ' New: ' + f(ch.introduced) + '.';
    if (ch.retest.length) t += ' Retesting: ' + f(ch.retest) + '.';
    return t;
  }

  // ---------------------------------------------------------------- rating and the 5★ folder
  var selT = Date.now();
  function featuresOf(c) { var f = clone(c.f); if (f.texture === 'flat') f.texStrength = 'n/a'; return f; }
  function rate(i, stars, quiet) {
    var c = S.cands[i]; if (!c) return;
    var prev = c.stars; c.stars = stars;
    var rec = null; S.recs.forEach(function (r) { if (r.id === c.id) rec = r; });
    if (!rec) {
      var d = derive(resolve(c), c.f);
      S.recs.push({ id: c.id, round: S.round, t: Date.now(), dwell: Date.now() - selT, stars: stars, f: featuresOf(c), d: d.cat, x: roundNums(d.num), h: d.hues });
    } else if (rec.stars !== stars) { rec.prev = rec.stars; rec.stars = stars; rec.t2 = Date.now(); }
    if (stars === 5) addToFolder(c); else if (prev === 5) S.folder = S.folder.filter(function (x) { return x.id !== c.id; });
    save();
    if (quiet) return;
    var next = -1;
    for (var k = 1; k <= ROUND; k++) { var j = (i + k) % ROUND; if (!S.cands[j].stars) { next = j; break; } }
    if (next >= 0) select(next); else { apply(); render(); }
    if (next < 0 && S.cands.every(function (x) { return x.stars; })) flashMsg('All 16 rated: press Next round.');
  }
  function roundNums(o) { var r = {}; Object.keys(o).forEach(function (k) { r[k] = isFinite(o[k]) ? Math.round(o[k] * 1000) / 1000 : null; }); return r; }
  function addToFolder(c) {
    if (S.folder.some(function (x) { return x.id === c.id; })) return;
    var sc = { id: c.id, f: clone(c.f) }; if (c.raw) sc.raw = clone(c.raw); else sc.j = clone(c.j);
    S.folder.push({ id: c.id, sc: sc, round: S.round, letter: String.fromCharCode(65 + S.cands.indexOf(c)), t: Date.now() });
  }
  function select(i) { S.sel = (i + ROUND) % ROUND; selT = Date.now(); save(); apply(); render(); }
  function adopt(sc) { S.looks[S.mode] = clone(sc); save(); apply(); flashMsg('Adopted as the ' + S.mode + ' look' + (sc.home ? ' (and follows edits made at home base).' : '.')); }

  // ---------------------------------------------------------------- home base favourites
  // favorites/favorites.json in the repo (deployed with the site): designs sent from a device with "Send to home
  // base", curated and altered there. Each entry: { id, name, note, from, features, jitter, raw, overrides }.
  // A design adopted from home base follows later edits to the file (matched by id).
  var HOME = { designs: [], state: 'loading' }, previewFav = null;
  function homeScheme(d) {
    var sc = { id: d.id, f: d.features, home: true };
    if (d.jitter) sc.j = d.jitter; if (d.raw) sc.raw = d.raw; if (d.overrides) sc.o = d.overrides;
    return sc;
  }
  function loadHome() {
    return fetch('favorites/favorites.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        HOME.designs = (data.designs || []).filter(function (d) { return d && d.id && d.features; }).map(function (d) {
          return { id: d.id, name: d.name || d.id, note: d.note || '', from: d.from || '', edited: !!d.overrides || !!d.edited, sc: homeScheme(d) };
        });
        HOME.state = 'ok';
      }).catch(function () { HOME.state = 'unavailable'; });
  }
  function homeById(id) { var r = null; HOME.designs.forEach(function (d) { if (d.id === id) r = d; }); return r; }
  // What "Send to home base" carries: the 5★ folder (features, jitter and raw values; no rendered style, so it stays
  // small enough to paste) plus the current insights for context.
  function homeExport() {
    var I = S.recs.length ? insights() : { items: [] };
    return { kind: 'vfv-favorites', version: 1, exported: new Date().toISOString(), ratings: S.recs.length, rounds: S.round,
      designs: S.folder.map(function (it) {
        var d = { id: it.id, from: it.from || 'round ' + it.round + ' design ' + it.letter + ' (5★)', features: it.sc.f };
        if (it.name) d.name = it.name;
        if (it.sc.j) d.jitter = roundJitter(it.sc.j); if (it.sc.raw) d.raw = it.sc.raw; if (it.sc.o) d.overrides = it.sc.o;
        return d;
      }), insights: I.items.map(function (x) { return x.kind + ': ' + x.text; }) };
  }
  function roundJitter(j) { var r = function (v) { return Math.round(v * 1000) / 1000; }; return { h: j.h.map(r), s: j.s.map(r), l: r(j.l), p: r(j.p) }; }
  var copyBox = '';
  function sendHome() {
    if (!S.folder.length) return flashMsg('The 5★ folder is empty.');
    var text = JSON.stringify(homeExport());
    var done = function () { copyBox = ''; flashMsg('Copied ' + S.folder.length + ' favourites. Paste them to Claude at home base.'); };
    var fail = function () { copyBox = text; render(); var t = hud.querySelector('textarea'); if (t) { t.focus(); t.select(); } flashMsg('Copy the text below and paste it to Claude at home base.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail); else fail();
  }

  // ---------------------------------------------------------------- applying a design to the live panel
  var colorStyle = document.createElement('style');
  document.head.appendChild(colorStyle);
  var textKey = 'barlowSC|700|upper|normal', relayoutT = 0, fontLinks = {};
  function fontCss(k) { return '"' + FONTS[k][0] + '", "Barlow Semi Condensed", "Segoe UI", sans-serif'; }
  function loadFont(k) {
    if (!FONTS[k] || !FONTS[k][1]) return Promise.resolve();
    if (!fontLinks[k]) {
      fontLinks[k] = new Promise(function (res) {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=' + FONTS[k][0].replace(/ /g, '+') + ':wght@' + FONTS[k][1] + '&display=swap';
        l.onload = l.onerror = function () { res(); };
        document.head.appendChild(l);
      }).then(function () {
        return Promise.all(FONTS[k][1].split(';').map(function (w) { return document.fonts.load(w + ' 20px "' + FONTS[k][0] + '"').catch(function () {}); }));
      });
    }
    return fontLinks[k];
  }
  // The header keys take the background's colour, the Day/Night key the other scheme's (so it shows what it switches
  // to); Freeze has blue text when off and lights blue when on; Record / Capture is red with white text. In the day
  // scheme the screen's bezel is slate.
  function keyCss(sel, g) {
    var dark = g.sLight < 0.5, c = function (dl) { return hsl(g.sHue, g.sSat, cl(g.sLight + dl, 0, 0.98)); };
    return sel + '{background:linear-gradient(to bottom,' + (dark ? c(0.1) + ',' + c(0.05) + ' 55%,' + c(0.02) : c(0.07) + ',' + c(0.01) + ' 55%,' + c(-0.045)) + ')!important;' +
      'color:' + (dark ? '#ebebeb' : hsl(g.sHue, g.sSat, 0.2)) + '!important;box-shadow:' + (dark ? '0 2px 0 rgba(0,0,0,0.6),0 4px 7px rgba(0,0,0,0.45),inset 0 1px 0 rgba(255,255,255,0.08)'
      : '0 2px 0 rgba(0,0,0,0.22),0 3px 6px rgba(0,0,0,0.16),inset 0 1px 0 rgba(255,255,255,0.75)') + '!important}\n';
  }
  function schemeCss(st) {
    var om = S.mode === 'day' ? 'night' : 'day', css = keyCss('#stage .hk', st) + keyCss('#stage .hk.hk-scheme', resolve(S.looks[om] || BUILTIN[om]));
    css += '#stage .hk.key-tint[aria-pressed="true"]{background:linear-gradient(to bottom,#5b8fe0,#3568b8)!important;color:#fff!important}' +
      '#stage .hk.key-tint:not([aria-pressed="true"]){color:' + (st.sLight < 0.5 ? '#86aaf5' : '#2f62c2') + '!important}\n';
    css += '#stage .hk.hk-rec{background:linear-gradient(to bottom,#e5493b,#c62f23 55%,#a8231a)!important;color:#fff!important}' +
      '#stage .hk-rec[aria-pressed="true"]>span:first-child{background:#fff!important;box-shadow:0 0 7px #fff!important}\n';
    if (S.mode === 'day') css += '#stage .bezel{background:' + hsl(STAGES.slate[0], STAGES.slate[1], STAGES.slate[2]) + '!important}\n';
    return css;
  }
  function applyStyle(sc) {
    var st = resolve(sc);
    colorStyle.textContent = styleCss(st) + schemeCss(st);
    P.accent = hsl(st.accentHue, st.accSat, 0.93); P.accentGlow = hsl(st.accentHue, st.accSat, 0.75, 0.8); ICON_GREEN = hsl(st.glassHue, st.glassSat, 0.5);
    TEXT.font = fontCss(st.font); TEXT.weight = st.weight === '700' ? 0 : +st.weight; TEXT.ls = st.tracking === 'normal' ? 0 : TRACK[st.tracking]; TEXT.upper = st.textCase !== 'title';
    drawPad(); syncBlendLegend(); syncKeyOn();
    var tk = [st.font, st.weight, st.textCase, st.tracking].join('|');
    if (tk !== textKey) {   // the portrait layout spaces controls by measured label widths: measure again
      textKey = tk;
      loadFont(st.font).then(function () {
        clearTimeout(relayoutT);
        relayoutT = setTimeout(function () { if (!currentFullscreenElement()) { build(); scaleStage(); } }, 40);
      });
    }
  }
  function selItem() {
    var k = typeof S.fsel === 'number' ? 'd:' + S.fsel : String(S.fsel || ''), i = +k.slice(2);
    if (k.indexOf('h:') === 0 && HOME.designs[i]) return { home: true, i: i, item: HOME.designs[i], sc: HOME.designs[i].sc };
    if (k.indexOf('d:') === 0 && S.folder[i]) return { home: false, i: i, item: S.folder[i], sc: S.folder[i].sc };
    return null;
  }
  function shown() {
    if (S.open && S.tune) return S.tune.sc;
    if (!S.open && previewFav) return previewFav.sc;
    if (S.open) {
      var fi = selItem();
      if (S.tab === 'folder' && fi) return fi.sc;
      if (S.tab !== 'folder' && S.cands[S.sel]) return S.cands[S.sel];
    }
    return look() || BUILTIN[S.mode];
  }
  function apply() { applyStyle(shown()); }

  // ---------------------------------------------------------------- thumbnails
  function drawThumb(cv, sc) {
    var st = resolve(sc), x = cv.getContext('2d'), w = cv.width, h = cv.height, u = w / 160;
    x.fillStyle = hsl(st.sHue, st.sSat, st.sLight); x.fillRect(0, 0, w, h);
    var win = function (i, bx, by, bw, bh, big) {
      x.fillStyle = panelColor(st, i); x.fillRect(bx, by, bw, bh);
      texThumb(x, st, bx, by, bw, bh, u);
      if (st.sheen) { var g = x.createLinearGradient(bx, by, bx, by + bh); g.addColorStop(0, 'rgba(255,255,255,' + 0.18 * st.sheen + ')'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,' + 0.35 * st.sheen + ')'); x.fillStyle = g; x.fillRect(bx, by, bw, bh); }
      if (st.outline !== 'none') { x.strokeStyle = st.outline === 'gray' ? '#8f8d92' : st.outline === 'light' ? 'rgba(255,255,255,0.55)' : keyColor(st, i); x.lineWidth = (st.outline === 'thick' ? 2 : 1) * u; x.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1); }
      var tc = tabColors(st, i), tw = (big ? 46 : 22) * u, th = (big ? 10 : 6) * u;
      x.fillStyle = tc[0]; x.fillRect(bx + 4 * u, by - th / 2, tw, th);
      if (big) { x.fillStyle = tc[1]; x.font = '800 ' + 7 * u + 'px ' + fontCss(st.font); x.textBaseline = 'middle'; x.fillText(st.textCase === 'title' ? 'Feedback' : 'FEEDBACK', bx + 7 * u, by + 0.5 * u); }
    };
    win(0, 6 * u, 10 * u, 88 * u, h - 16 * u, true);
    [1, 2, 3, 4].forEach(function (i, k) { win(i, 102 * u, (8 + k * 22) * u, 52 * u, 17 * u, false); });
    knobThumb(x, st, 0, 30 * u, 46 * u, 15 * u);
    knobThumb(x, st, 0, 70 * u, 46 * u, 11 * u);
    var lab = labelRGB(st, 0); x.fillStyle = css3(lab);
    x.font = st.weight + ' ' + 9 * u + 'px ' + fontCss(st.font); x.textBaseline = 'alphabetic'; x.textAlign = 'center';
    x.fillText(st.textCase === 'title' ? 'Zoom' : 'ZOOM', 30 * u, 74 * u); x.fillText(st.textCase === 'title' ? 'Hue' : 'HUE', 70 * u, 74 * u);
    x.textAlign = 'left';
    [1, 2, 3, 4].forEach(function (i, k) { knobThumb(x, st, i, 140 * u, (17 + k * 22) * u, 5 * u); });
  }
  function labelRGB(st, i) {
    var fc = rgb(st.hue[i], st.kSat * Math.min(1, st.sat[i] + 0.2), st.kLight);
    return { dim: [166, 164, 168], bright: [235, 235, 235], family: fc, familyDark: mix(fc, [0, 0, 0], 0.55), black: [22, 21, 23], ivory: [239, 230, 207], accent: rgb(st.accentHue, st.accSat, 0.8) }[st.label];
  }
  function tabColors(st, i) {
    var fc = keyColor(st, i), stage = hsl(st.sHue, st.sSat, st.sLight);
    return { ink: ['#ebebeb', '#19181a'], filled: [fc, '#19181a'], dark: ['#141316', fc], outline: [stage, fc], black: ['#111013', '#ebebeb'], panel: [hsl(st.hue[i], st.pSat * st.sat[i], st.pLight * 0.7), '#ebebeb'], underline: [stage, '#ebebeb'] }[st.tab];
  }
  function texThumb(x, st, bx, by, bw, bh, u) {
    var a = st.texStr; if (!a || st.texture === 'flat') return;
    x.save(); x.beginPath(); x.rect(bx, by, bw, bh); x.clip();
    var line = function (al, dark) { x.strokeStyle = (dark ? 'rgba(0,0,0,' : 'rgba(255,255,255,') + Math.min(0.9, al * a) + ')'; x.lineWidth = u; };
    var t = st.texture, i, j;
    if (t === 'brushed' || t === 'scanlines' || t === 'linen') { line(t === 'scanlines' ? 0.5 : 0.18, t === 'scanlines'); for (i = by; i < by + bh; i += (t === 'brushed' ? 2 : 3) * u) { x.beginPath(); x.moveTo(bx, i); x.lineTo(bx + bw, i); x.stroke(); } }
    if (t === 'linen' || t === 'stripes') { line(t === 'stripes' ? 0.12 : 0.18, true); for (i = bx; i < bx + bw; i += (t === 'stripes' ? 12 : 3) * u) { x.beginPath(); x.moveTo(i, by); x.lineTo(i, by + bh); x.lineWidth = (t === 'stripes' ? 6 : 1) * u; x.stroke(); } }
    if (t === 'hatch' || t === 'weave') { line(0.3, false); for (i = -bh; i < bw; i += 7 * u) { x.beginPath(); x.moveTo(bx + i, by + bh); x.lineTo(bx + i + bh, by); x.stroke(); if (t === 'weave') { x.beginPath(); x.moveTo(bx + i, by); x.lineTo(bx + i + bh, by + bh); x.stroke(); } } }
    if (t === 'grille' || t === 'dots' || t === 'grain') {
      x.fillStyle = (t === 'dots' ? 'rgba(255,255,255,' : 'rgba(0,0,0,') + Math.min(0.9, (t === 'grille' ? 0.9 : 0.4) * a) + ')';
      var step = (t === 'grain' ? 3 : 6) * u;
      for (i = bx; i < bx + bw; i += step) for (j = by; j < by + bh; j += step) { if (t === 'grain' && Math.random() < 0.5) continue; x.fillRect(i, j, u * (t === 'grain' ? 1 : 1.6), u * (t === 'grain' ? 1 : 1.6)); }
    }
    if (t === 'spun') { line(0.25, false); for (i = 4 * u; i < Math.max(bw, bh); i += 3 * u) { x.beginPath(); x.arc(bx + bw / 2, by + bh / 2, i, 0, 7); x.stroke(); } }
    if (t === 'carbon') { x.fillStyle = 'rgba(0,0,0,' + Math.min(0.9, 0.5 * a) + ')'; for (i = bx; i < bx + bw; i += 4 * u) for (j = by; j < by + bh; j += 4 * u) if (((i - bx) / (4 * u) + (j - by) / (4 * u)) % 2 < 1) x.fillRect(i, j, 2 * u, 2 * u); }
    x.restore();
  }
  function knobThumb(x, st, i, cx, cy, r) {
    var fc = keyColor(st, i);
    if (st.scale !== 'none') { x.strokeStyle = st.scale === 'familyArc' ? fc : st.scale === 'glowArc' ? hsl(st.accentHue, st.accSat, 0.8) : 'rgba(166,164,168,' + (st.scale === 'faint' ? 0.35 : 0.85) + ')'; x.lineWidth = Math.max(1, r * 0.12); x.beginPath(); x.arc(cx, cy, r * 1.3, Math.PI * 0.75, Math.PI * 2.25); x.stroke(); }
    var sk = { knurled: '#1f1e21', smooth: '#1b1a1d', none: null, ring: fc, fluted: '#2c2b2f', metal: '#a9a9ae' }[st.skirt];
    if (sk) { x.fillStyle = sk; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill(); }
    var capC = { black: '#2a292d', silver: '#a3a3a9', family: fc, chrome: '#c4c4ca', ivory: '#ddd3b8', graphite: '#3a393d', brass: '#b8913e', red: '#c0281c', glass: 'rgba(255,255,255,0.25)' }[st.cap];
    x.fillStyle = capC; x.beginPath(); x.arc(cx, cy, r * (sk ? 0.7 : 0.95), 0, 7); x.fill();
    var pc = { ink: '#ebebeb', family: fc, accent: hsl(st.accentHue, 1, 0.8), red: '#ff4a3d', black: '#141316', amber: '#ffb02e' }[st.ptr];
    var a = -Math.PI / 2 + 0.6, ex = Math.cos(a), ey = Math.sin(a);
    x.strokeStyle = x.fillStyle = pc;
    if (st.pointer === 'dot') { x.beginPath(); x.arc(cx + ex * r * 0.6, cy + ey * r * 0.6, Math.max(1, r * 0.12), 0, 7); x.fill(); return; }
    var r0 = st.pointer === 'needle' ? 0 : st.pointer === 'notch' ? r * 0.65 : r * 0.25, r1 = r * 0.92;
    x.lineWidth = Math.max(1, r * (st.pointer === 'wedge' ? 0.22 : st.pointer === 'triangle' ? 0.3 : st.pointer === 'notch' ? 0.18 : 0.1));
    x.beginPath(); x.moveTo(cx + ex * r0, cy + ey * r0); x.lineTo(cx + ex * r1, cy + ey * r1); x.stroke();
  }

  // ---------------------------------------------------------------- files
  function download(name, text, type) {
    var a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  function designRecord(item) {
    var st = resolve(item.sc), d = derive(st, item.sc.f);
    return { id: item.id, round: item.round, candidate: item.letter, features: item.sc.f, derived: d.cat, measures: roundNums(d.num), style: st, scheme: item.sc };
  }
  function saveFolderToDisk() {
    if (!S.folder.length) return flashMsg('The 5★ folder is empty.');
    if (!window.showDirectoryPicker) {
      download('home-base.json', JSON.stringify(homeExport(), null, 1));
      return flashMsg('This browser cannot write folders: downloaded home-base.json instead.');
    }
    window.showDirectoryPicker({ id: 'vfv-5star', mode: 'readwrite', startIn: 'downloads' }).then(function (root) {
      return root.getDirectoryHandle('video-feedback-5-star-designs', { create: true });
    }).then(function (dir) {
      var write = function (name, data) { return dir.getFileHandle(name, { create: true }).then(function (fh) { return fh.createWritable(); }).then(function (w) { return w.write(data).then(function () { return w.close(); }); }); };
      var jobs = S.folder.map(function (item) {
        var base = 'round' + item.round + '-' + item.letter + '-' + item.id;
        var cv = document.createElement('canvas'); cv.width = 640; cv.height = 400; drawThumb(cv, item.sc);
        return write(base + '.json', JSON.stringify(designRecord(item), null, 1)).then(function () {
          return new Promise(function (res) { cv.toBlob(function (b) { res(b); }, 'image/png'); });
        }).then(function (b) { return write(base + '.png', b); });
      });
      return Promise.all(jobs).then(function () { return write('index.json', JSON.stringify(S.folder.map(designRecord), null, 1)); })
        .then(function () { return write('home-base.json', JSON.stringify(homeExport(), null, 1)); });
    }).then(function () { flashMsg('Saved ' + S.folder.length + ' designs to video-feedback-5-star-designs/.'); })
      .catch(function (e) { if (e && e.name !== 'AbortError') flashMsg('Could not save the folder: ' + (e.message || e)); });
  }
  function exportCsv() {
    var nk = Object.keys(NUMS), dk = ['harmony', 'temperature', 'polarity'];
    var head = ['round', 'id', 'stars', 'previous_stars', 'dwell_ms', 'time'].concat(DIMS.map(function (d) { return d.k; }), dk, nk, ['window_hues']);
    var rows = S.recs.map(function (r) {
      return [r.round, r.id, r.stars, r.prev || '', r.dwell, new Date(r.t).toISOString()].concat(DIMS.map(function (d) { return r.f[d.k]; }),
        dk.map(function (k) { return r.d[k]; }), nk.map(function (k) { return r.x[k]; }), [(r.h || []).join(' ')]);
    });
    download('style-lab-ratings.csv', [head].concat(rows).map(function (row) { return row.map(function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n'), 'text/csv');
  }

  // ---------------------------------------------------------------- tuner: fine-tune a favourite
  // Opened from any favourite in the 5★ Folder (home base or this device), in a window that takes the Lab window's
  // place. Each element (every window colour, saturation, lightness, background, accent, outline, texture, knob part,
  // font setting and text colour) has ◀ ▶ buttons that cycle it through the values chosen in any favourite; each group
  // (colour scheme, texture, knobs, text font, text colour) cycles as a whole through the favourites' combinations.
  // Elements every favourite agrees on are listed as fixed. The panel previews the result live; it can be adopted, or
  // saved as a new favourite on this device ("Send to home base" carries it with its name and origin). The work in
  // progress is kept in S.tune, so it survives a reload.
  var TGROUPS = [['Colour', 'Colour scheme'], ['Texture', 'Texture'], ['Knobs', 'Knobs'], ['Font', 'Text font'], ['Text colour', 'Text colour']];
  var zeroJ = function () { return { h: [0, 0, 0, 0, 0], s: [0, 0, 0, 0, 0], l: 0, p: 0 }; };
  var groupDims = function (g) { return DIMS.filter(function (d) { return d.group === g; }); };
  function favPool() {   // every favourite: home base first, then this device's 5★ folder (ids deduplicated)
    var out = [], ids = {};
    HOME.designs.forEach(function (d) { ids[d.id] = 1; out.push({ name: d.name, sc: d.sc }); });
    S.folder.forEach(function (it) { if (!ids[it.id]) { ids[it.id] = 1; out.push({ name: itemName(it), sc: it.sc }); } });
    return out;
  }
  function tuneOptions(k) {   // the values the favourites chose, in the dimension's own order
    var d = DIM[k], order = d.init.concat(d.reserve), n = {};
    favPool().forEach(function (fv) { var v = fv.sc.f[k]; if (v != null) n[v] = (n[v] || 0) + 1; });
    var vals = order.filter(function (v) { return n[v]; }).concat(Object.keys(n).filter(function (v) { return order.indexOf(v) < 0; }));
    return { vals: vals, n: n };
  }
  function groupBundles(g) {   // each favourite's combination for a group, duplicates merged
    var out = [], dims = groupDims(g);
    favPool().forEach(function (fv) {
      var key = dims.map(function (d) { return fv.sc.f[d.k]; }).join('|'), b = null;
      out.forEach(function (x) { if (x.key === key) b = x; });
      if (b) b.names.push(fv.name); else out.push({ key: key, names: [fv.name], sc: fv.sc });
    });
    return out;
  }
  function bundleIndex(g, bs) { var key = groupDims(g).map(function (d) { return S.tune.sc.f[d.k]; }).join('|'), r = -1; bs.forEach(function (b, i) { if (b.key === key) r = i; }); return r; }
  function openTune() {
    var fi = selItem(); if (!fi) return;
    var base = clone(fi.sc); base.id = 'tune'; delete base.home;
    S.tune = { from: fi.home ? fi.item.name : itemName(fi.item), base: base, sc: clone(base) };
    save(); apply(); render();
  }
  function tuneSet(k, v) {
    var sc = S.tune.sc;
    if (sc.raw) { delete sc.raw; sc.j = sc.j || zeroJ(); }   // the built-in look's exact values give way to its features
    sc.f[k] = v;
    if (sc.o) { OKEYS[k].forEach(function (o) { delete sc.o[o]; }); if (!Object.keys(sc.o).length) delete sc.o; }
  }
  function tuneCycle(k, dir) {
    var opts = tuneOptions(k).vals, i = opts.indexOf(S.tune.sc.f[k]), n = opts.length;
    if (n < 2) return;
    tuneSet(k, opts[i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n]);
    save(); apply(); render();
  }
  function tuneGroup(g, dir) {   // the next favourite's whole combination for the group, with its exact colour variation and overrides
    var bs = groupBundles(g), i = bundleIndex(g, bs), n = bs.length;
    if (n < 2) return;
    var src = bs[i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n].sc, sc = S.tune.sc;
    groupDims(g).forEach(function (d) { tuneSet(d.k, src.f[d.k]); });
    if (g === 'Colour') sc.j = clone(src.j || zeroJ());
    if (src.o) groupDims(g).forEach(function (d) { OKEYS[d.k].forEach(function (o) { if (src.o[o] != null) { sc.o = sc.o || {}; sc.o[o] = clone(src.o[o]); } }); });
    save(); apply(); render();
  }
  function tuneShuffle() {
    DIMS.forEach(function (d) { var opts = tuneOptions(d.k).vals; if (opts.length > 1) tuneSet(d.k, pick(opts)); });
    save(); apply(); render();
  }
  var tuneChanged = function () { return JSON.stringify(S.tune.sc) !== JSON.stringify(S.tune.base); };
  function tuneName() {   // "Favourite 4 tuned", then "Favourite 4 tuned 2", ...
    var stem = S.tune.from.replace(/ tuned( \d+)?$/, '') + ' tuned', name = stem, k = 1;
    var taken = function (nm) { return S.folder.some(function (it) { return it.name === nm; }) || HOME.designs.some(function (d) { return d.name === nm; }); };
    while (taken(name)) name = stem + ' ' + (++k);
    return name;
  }
  function tuneSave() {
    var id = uid(), sc = clone(S.tune.sc), name = tuneName(); sc.id = id;
    S.folder.push({ id: id, sc: sc, round: S.round, letter: 'T', name: name, from: 'tuned from ' + S.tune.from, t: Date.now() });
    S.tune.base = clone(S.tune.sc); S.tune.from = name;
    save(); flashMsg('Saved as "' + name + '" in this device\'s 5★ folder. Send to home base to bring it here.');
  }
  function tuneAdopt() {
    var sc = clone(S.tune.sc); sc.id = uid(); sc.name = S.tune.from + (tuneChanged() ? ' (tuned)' : '');
    adopt(sc);
  }
  function tuneHtml() {
    var T = S.tune, f = T.sc.f, bf = T.base.f, total = favPool().length;
    var h = '<div class="hd"><span>Tune · ' + esc(T.from) + '</span><button class="x" data-act="tclose" title="Back to the Lab">×</button></div><div class="bd">';
    h += '<div class="row"><button data-act="tadopt" class="on">Adopt</button><button data-act="tsave"' + (tuneChanged() ? '' : ' disabled') + '>Save as favourite</button></div>';
    h += '<div class="row"><button data-act="tshuffle">Shuffle</button><button data-act="treset"' + (tuneChanged() ? '' : ' disabled') + '>Reset</button><button data-act="tclose">Back</button></div>';
    h += '<div class="hint" style="margin-top:2px">◀ ▶ cycle each element through the values your ' + total + ' favourites use (the count shows how many use it). The top row of a group swaps in another favourite\'s whole set.</div>';
    TGROUPS.forEach(function (g) {
      var bs = groupBundles(g[0]), bi = bundleIndex(g[0], bs), fixed = [];
      var bname = bi < 0 ? 'custom mix' : bs[bi].names[0] + (bs[bi].names.length > 1 ? ' +' + (bs[bi].names.length - 1) : '');
      h += '<div class="tr tg"><span>' + g[1] + '</span><button data-act="tgrp" data-g="' + g[0] + '" data-d="-1"' + (bs.length > 1 ? '' : ' disabled') + '>◀</button><b>' + esc(bname) +
        '</b><button data-act="tgrp" data-g="' + g[0] + '" data-d="1"' + (bs.length > 1 ? '' : ' disabled') + '>▶</button></div>';
      groupDims(g[0]).forEach(function (d) {
        var o = tuneOptions(d.k), v = f[d.k], na = d.k === 'texStrength' && f.texture === 'flat';
        if (o.vals.length < 2) { if (!na) fixed.push(featPhrase(d.k, v)); return; }
        var sw = d.k.indexOf('hue.') === 0 ? '<span class="sw" style="background:' + (HUES[v] == null ? '#8f8d92' : hsl(HUES[v], 0.6, 0.62)) + '"></span>' : '';
        var face = d.k === 'font' && FONTS[v] ? ' style="font-family:' + esc(fontCss(v)) + '"' : '';
        h += '<div class="tr"><span>' + esc(d.k.indexOf('hue.') === 0 ? d.label.split(' ')[0] : d.label) + '</span>' +
          '<button data-act="tcyc" data-k="' + d.k + '" data-d="-1"' + (na ? ' disabled' : '') + '>◀</button>' +
          '<b class="' + (na ? 'na' : v !== bf[d.k] ? 'chg' : '') + '"' + face + '>' + (na ? 'n/a (flat)' : sw + esc(valueName(d.k, v)) + '<i>' + (o.n[v] || 0) + '/' + total + '</i>') + '</b>' +
          '<button data-act="tcyc" data-k="' + d.k + '" data-d="1"' + (na ? ' disabled' : '') + '>▶</button></div>';
      });
      if (fixed.length) h += '<div class="tfix">Every favourite: ' + esc(fixed.join(' · ')) + '</div>';
    });
    return h + '<div class="msg">' + esc(msgText) + '</div></div>';
  }
  function tuneClick(e) {
    var el = e.target.closest('[data-act]'); if (!el || el.disabled || !S.tune) return;
    var a = el.dataset.act, d = +el.dataset.d;
    if (a === 'tclose') { S.tune = null; save(); apply(); return render(); }
    if (a === 'tcyc') return tuneCycle(el.dataset.k, d);
    if (a === 'tgrp') return tuneGroup(el.dataset.g, d);
    if (a === 'tshuffle') return tuneShuffle();
    if (a === 'treset') { S.tune.sc = clone(S.tune.base); save(); apply(); return render(); }
    if (a === 'tsave') return tuneSave();
    if (a === 'tadopt') { tuneAdopt(); return render(); }
  }

  // ---------------------------------------------------------------- HUD
  var css = document.createElement('style');
  css.textContent =
    '#lab{position:fixed;z-index:50;width:340px;max-width:calc(100vw - 12px);display:none;box-sizing:border-box;font-family:"Barlow Semi Condensed","Segoe UI",sans-serif;overflow:auto;' +
    'color:#ebebeb;background:rgba(22,21,24,0.96);border:1px solid #515053;border-radius:7px;box-shadow:0 10px 30px rgba(0,0,0,0.6);user-select:none;-webkit-user-select:none;touch-action:pan-y;scrollbar-width:thin;scrollbar-color:#4a484e transparent}' +
    '#lab .hd{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:6px;padding:7px 8px 7px 10px;background:#19181b;border-bottom:1px solid #3d3b40;cursor:move;touch-action:none;font-size:11px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase}' +
    '#lab .hd span{flex:1}#lab .bd{padding:8px 10px 10px}#lab.min .bd{display:none}' +
    '#lab button{font-family:inherit;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#ebebeb;background:linear-gradient(#49474d,#2d2c30);border:none;border-radius:4px;padding:6px 8px;cursor:pointer;box-shadow:0 1px 0 #0f0e10,inset 0 1px 0 rgba(255,255,255,0.09)}' +
    '#lab button:disabled{opacity:0.4;cursor:default}#lab button.on{background:linear-gradient(#5b8fe0,#3568b8)}#lab button.x{padding:3px 7px}' +
    '#lab .row{display:flex;gap:6px;margin:6px 0;align-items:center;flex-wrap:wrap}#lab .row>button{flex:1}' +
    '#lab .meta{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#a6a4a8}' +
    '#lab .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:6px 0}' +
    '#lab .cand{position:relative;border-radius:4px;background:#0b0b0c;padding:2px;cursor:pointer;box-shadow:0 0 0 1px #3d3b40}' +
    '#lab .cand.sel{box-shadow:0 0 0 2px #eded78}#lab .cand canvas{display:block;width:100%;border-radius:2px}' +
    '#lab .cand b{position:absolute;left:4px;top:2px;font-size:10px;text-shadow:0 0 3px #000,0 0 2px #000}#lab .cand i{display:block;font-style:normal;font-size:9px;color:#eded78;text-align:center;height:11px;line-height:11px}' +
    '#lab .cand em{position:absolute;right:3px;top:2px;font-style:normal;font-size:7px;font-weight:800;letter-spacing:0.06em;color:#9ad;text-transform:uppercase;text-shadow:0 0 3px #000,0 0 2px #000}' +
    '#lab .stars{display:flex;gap:2px;flex:1}#lab .stars button{flex:1;font-size:16px;padding:3px 0;color:#77757b;background:#1f1e21}#lab .stars button.lit{color:#eded78}' +
    '#lab .msg{min-height:13px;font-size:10px;color:#eded78;letter-spacing:0.04em;line-height:1.4;margin-top:4px}#lab .hint{font-size:9px;color:#77757b;letter-spacing:0.05em;margin-top:6px;line-height:1.4}' +
    '#lab .feat{font-size:10px;color:#c9c6d0;line-height:1.45;letter-spacing:0.02em}#lab .feat b{color:#8f8d92;font-weight:700;text-transform:uppercase;font-size:9px;letter-spacing:0.08em}' +
    '#lab ul{margin:4px 0;padding:0;list-style:none}#lab li{font-size:11px;line-height:1.4;padding:5px 0;border-bottom:1px solid #2e2d31;letter-spacing:0.01em}' +
    '#lab li s{display:inline-block;text-decoration:none;font-size:8px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;padding:1px 4px;border-radius:2px;margin-right:5px;vertical-align:1px;color:#141316}' +
    '#lab .k-taste{background:#eded78}#lab .k-rule{background:#ff8a7a}#lab .k-prefer{background:#7fd99a}#lab .k-avoid{background:#c9c6d0}#lab .k-combo{background:#8ab8ff}#lab .k-clash{background:#e8a0ff}#lab .k-drivers{background:#f0b45a}' +
    // the tuner window's element rows: label, ◀, value, ▶
    '#lab .tr{display:grid;grid-template-columns:92px 26px 1fr 26px;gap:4px;align-items:center;margin:3px 0}#lab .tr button{padding:4px 0;font-size:11px}' +
    '#lab .tr>span{font-size:9px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:#a6a4a8;line-height:1.15}' +
    '#lab .tr>b{font-size:11px;font-weight:600;text-align:center;background:#0b0b0c;border-radius:3px;padding:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 0 0 1px #2e2d31}' +
    '#lab .tr>b.chg{box-shadow:0 0 0 1px #eded78}#lab .tr>b i{font-style:normal;font-size:9px;color:#77757b;margin-left:5px}#lab .tr>b.na{color:#5d5b60}' +
    '#lab .tg{margin-top:9px;padding-top:8px;border-top:1px solid #3d3b40}#lab .tg>span{font-size:10px;color:#eded78}#lab .tg>b{color:#eded78}' +
    '#lab .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px;box-shadow:0 0 0 1px rgba(0,0,0,0.6)}' +
    '#lab .tfix{font-size:9px;color:#77757b;letter-spacing:0.04em;line-height:1.4;margin-top:2px}#lab .cand i.tn{color:#9ad;cursor:pointer;font-weight:800;letter-spacing:0.08em}';
  css.textContent = css.textContent.replace(/#lab/g, '.lw');   // shared by the Lab window and the tuner window
  document.head.appendChild(css);
  var hud = document.createElement('div');
  hud.id = 'lab'; hud.className = 'lw';
  document.body.appendChild(hud);
  var tw = document.createElement('div');   // the tuner window takes the Lab window's place while it is open
  tw.id = 'tune'; tw.className = 'lw';
  document.body.appendChild(tw);
  tw.addEventListener('click', tuneClick);
  var hudPos = false;
  function placeHud() {
    if (hudPos || !ui.screen) return;
    var r = ui.screen.getBoundingClientRect();
    if (!r.width) return;
    hud.style.width = Math.max(240, Math.min(360, r.width - 12)) + 'px';
    hud.style.left = Math.max(6, r.left + 6) + 'px';
    hud.style.top = Math.max(6, r.top + 6) + 'px';
    hud.style.maxHeight = Math.max(260, Math.min(window.innerHeight - 12, r.height - 12)) + 'px';
    syncTw();
  }
  function syncTw() { ['left', 'top', 'width', 'maxHeight'].forEach(function (p) { tw.style[p] = hud.style[p]; }); }
  var msgT = 0, msgText = '';
  function flashMsg(t) { msgText = t; render(); clearTimeout(msgT); msgT = setTimeout(function () { msgText = ''; render(); }, 7000); }
  var starStr = function (n) { return n ? '★★★★★'.slice(0, n) : ''; };
  // The selected design's features, grouped, e.g. "Knobs ivory cap · smooth skirt · dot pointer · red pointer colour".
  var SUFFIX = { 'panel.sat': ' saturation', 'panel.light': ' windows', stage: ' background', accent: ' accent', outline: ' outline', texStrength: ' strength',
    sheen: ' sheen', cap: ' cap', skirt: ' skirt', pointer: ' pointer', pointerColor: ' pointer colour', scale: ' scale', weight: ' weight', tracking: ' spacing',
    labelColor: ' labels', nameplate: ' nameplates' };
  function featPhrase(k, v) { return k.indexOf('hue.') === 0 ? DIM[k].label.split(' ')[0].toLowerCase() + ' ' + valueName(k, v) : valueName(k, v) + (SUFFIX[k] || ''); }
  function featSummary(f) {
    var by = {};
    DIMS.forEach(function (d) {
      if (d.k === 'texStrength' && f.texture === 'flat') return;
      (by[d.group] = by[d.group] || []).push(featPhrase(d.k, f[d.k]));
    });
    return Object.keys(by).map(function (g) { return '<b>' + g + '</b> ' + esc(by[g].join(' · ')); }).join('<br>');
  }
  function itemName(it) { return it.name || 'R' + it.round + it.letter; }
  function tileName(n) { return n.length > 12 ? n.replace(/^Favourite /, 'Fav ') : n; }
  function render() {
    tw.style.display = 'none';
    if (!S.open) { hud.style.display = 'none'; return; }
    if (S.tune) {
      hud.style.display = 'none'; tw.style.display = 'block'; syncTw();
      var top = tw.scrollTop; tw.innerHTML = tuneHtml(); tw.scrollTop = top;
      return;
    }
    hud.style.display = 'block';
    var h = '<div class="hd"><span>Style Lab · Round ' + S.round + '</span><button class="x" data-act="min">' + (hud.classList.contains('min') ? '+' : '–') + '</button><button class="x" data-act="close">×</button></div><div class="bd">';
    h += '<div class="row">' + [['rate', 'Rate'], ['folder', '5★ Folder (' + S.folder.length + ')'], ['insights', 'Insights']].map(function (t) {
      return '<button data-act="tab" data-t="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div>';
    if (S.tab === 'rate') h += rateHtml(); else if (S.tab === 'folder') h += folderHtml(); else h += insightsHtml();
    h += '<div class="msg">' + esc(msgText) + '</div></div>';
    hud.innerHTML = h;
    hud.querySelectorAll('[data-thumb]').forEach(function (el) {
      var t = el.dataset.thumb.split(':'), sc = t[0] === 'c' ? S.cands[+t[1]] : t[0] === 'h' ? HOME.designs[+t[1]].sc : S.folder[+t[1]].sc;
      var cv = document.createElement('canvas'); cv.width = 160; cv.height = 100; drawThumb(cv, sc); el.insertBefore(cv, el.firstChild);
    });
  }
  function rateHtml() {
    var rated = S.cands.filter(function (c) { return c.stars; }).length, c = S.cands[S.sel], meta = S.meta[S.meta.length - 1];
    var h = '<div class="meta">' + rated + '/16 rated · diversity ' + (meta ? Math.round(meta.div * 100) : 0) + '% · ' + S.recs.length + ' datapoints</div><div class="grid">';
    S.cands.forEach(function (x, i) {
      h += '<div class="cand' + (i === S.sel ? ' sel' : '') + '" data-act="sel" data-i="' + i + '" data-thumb="c:' + i + '"><b>' + String.fromCharCode(65 + i) + '</b>' +
        (x.tag ? '<em>' + x.tag + '</em>' : '') + '<i>' + starStr(x.stars) + '</i></div>';
    });
    h += '</div><div class="row"><span class="meta" style="width:22px">' + String.fromCharCode(65 + S.sel) + '</span><div class="stars">' +
      [1, 2, 3, 4, 5].map(function (n) { return '<button data-act="rate" data-i="' + n + '" class="' + (c && c.stars >= n ? 'lit' : '') + '">★</button>'; }).join('') + '</div></div>';
    h += '<div class="row"><button data-act="prev">◀</button><button data-act="next">▶</button><button data-act="round" class="on"' + (rated < MIN_RATED ? ' disabled' : '') + '>Next round ▸</button></div>';
    if (c) h += '<div class="feat">' + featSummary(c.f) + '</div>';
    h += '<div class="hint">1–5 rate (moves to the next unrated) · ←/→ browse · N next round. Rate on the live panel; at least ' + MIN_RATED + ' of 16 to continue.</div>';
    return h;
  }
  function folderHtml() {
    var fi = selItem(), sel = fi && fi.item, h = '';
    h += '<div class="row"><button data-act="adopt"' + (fi ? '' : ' disabled') + '>Adopt</button><button data-act="tune"' + (fi ? '' : ' disabled') + '>Tune…</button><button data-act="fremove"' + (fi && !fi.home ? '' : ' disabled') + '>Remove</button><button data-act="builtin"' + (look() ? '' : ' disabled') + ' title="Back to the standard ' + S.mode + ' look">Standard</button></div>';
    h += '<div class="row"><button data-act="send" class="on"' + (S.folder.length ? '' : ' disabled') + '>Send to home base</button><button data-act="savedisk"' + (S.folder.length ? '' : ' disabled') + '>Save folder…</button><button data-act="exportadopted"' + (look() ? '' : ' disabled') + '>Export adopted</button></div>';
    if (copyBox) h += '<textarea readonly style="width:100%;height:70px;box-sizing:border-box;font:10px monospace;background:#0b0b0c;color:#c9c6d0;border:1px solid #3d3b40;border-radius:4px">' + esc(copyBox) + '</textarea>';
    var lk = look(), lkName = function (sc) { return sc.home && homeById(sc.id) ? homeById(sc.id).name : sc.name || 'design ' + sc.id; };
    h += '<div class="meta">' + (S.mode === 'day' ? 'Day' : 'Night') + ' look: ' + esc(lk ? lkName(lk) + ' (adopted)' : lkName(BUILTIN[S.mode]) + ' (standard)') + '</div>';
    if (sel) {
      h += '<div class="feat" style="margin-top:4px"><b>' + esc(fi.home ? sel.name : itemName(sel)) + '</b>' + (sel.from ? ' ' + esc(sel.from) : '') +
        (fi.home && sel.edited ? ' · edited at home base' : '') + (fi.home && sel.note ? '<br>' + esc(sel.note) : '') + '<br>' + featSummary(sel.sc.f) + '</div>';
    }
    h += '<div class="meta" style="margin-top:8px">Home base (' + (HOME.state === 'ok' ? HOME.designs.length : HOME.state === 'loading' ? '…' : 'offline') + ')</div>';
    if (HOME.designs.length) {
      h += '<div class="grid">';
      HOME.designs.forEach(function (d, i) {
        h += '<div class="cand' + (S.fsel === 'h:' + i ? ' sel' : '') + '" data-act="fsel" data-k="h:' + i + '" data-thumb="h:' + i + '"><b>' + esc(tileName(d.name).slice(0, d.edited ? 8 : 12)) + '</b>' + (d.edited ? '<em>edited</em>' : '') + '<i class="tn" data-act="tune" data-k="h:' + i + '">Tune ▸</i></div>';
      });
      h += '</div>';
    } else h += '<div class="feat">Favourites curated at home base appear here. Send yours with "Send to home base".</div>';
    h += '<div class="meta" style="margin-top:8px">This device: 5★ (' + S.folder.length + ')</div>';
    if (!S.folder.length) h += '<div class="feat">Every design you rate 5★ lands here. Pick one to preview it on the panel, then Adopt it as the app\'s look.</div>';
    else {
      h += '<div class="grid">';
      S.folder.forEach(function (it, i) { h += '<div class="cand' + (S.fsel === 'd:' + i || S.fsel === i ? ' sel' : '') + '" data-act="fsel" data-k="d:' + i + '" data-thumb="f:' + i + '"><b>' + esc(tileName(itemName(it)).slice(0, 12)) + '</b><i class="tn" data-act="tune" data-k="d:' + i + '">Tune ▸</i></div>'; });
      h += '</div>';
    }
    return h;
  }
  function insightsHtml() {
    var I = insights(), h = '<div class="meta">' + I.A.n + ' ratings · ' + S.round + ' rounds · average ' + I.A.mu.toFixed(2) + '★</div>';
    if (I.note) h += '<div class="feat" style="margin-top:6px">' + esc(I.note) + '</div>';
    else h += '<ul>' + I.items.map(function (it) { return '<li><s class="k-' + it.kind + '">' + it.kind + '</s>' + esc(it.text) + '</li>'; }).join('') + '</ul>';
    var act = 0, ret = 0; DIMS.forEach(function (d) { act += S.pools[d.k].active.length; ret += S.pools[d.k].retired.length; });
    h += '<div class="meta" style="margin-top:6px">In play: ' + act + ' values · retired: ' + ret + '</div>';
    S.log.slice(-3).reverse().forEach(function (ch) { h += '<div class="feat">' + esc(changeText(ch)) + '</div>'; });
    h += '<div class="row"><button data-act="csv"' + (S.recs.length ? '' : ' disabled') + '>Export CSV</button><button data-act="json"' + (S.recs.length ? '' : ' disabled') + '>Export all JSON</button><button data-act="reset">Reset lab…</button></div>';
    return h;
  }
  function toggle() {
    S.open = !S.open;
    if (S.open && !S.round) nextRound(true);
    if (S.open) Object.keys(FONTS).forEach(loadFont);
    save(); apply(); render();
    if (ui.labKey) ui.labKey.set(S.open ? 'on' : 'off');
    if (S.open) placeHud();
  }
  hud.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
    var a = el.dataset.act, i = +el.dataset.i;
    if (a === 'close') return toggle();
    if (a === 'min') { hud.classList.toggle('min'); return render(); }
    if (a === 'tab') { S.tab = el.dataset.t; copyBox = ''; save(); apply(); return render(); }
    if (a === 'sel') return select(i);
    if (a === 'rate') return rate(S.sel, i);
    if (a === 'prev') return select(S.sel - 1);
    if (a === 'next') return select(S.sel + 1);
    if (a === 'round') { nextRound(); return render(); }
    if (a === 'tune') { if (el.dataset.k) S.fsel = el.dataset.k; return openTune(); }
    if (a === 'fsel') { S.fsel = el.dataset.k; save(); apply(); return render(); }
    if (a === 'adopt') { var fi = selItem(); if (fi) adopt(fi.sc); return render(); }
    if (a === 'fremove') { var fr = selItem(); if (fr && !fr.home) { S.folder.splice(fr.i, 1); S.fsel = ''; save(); apply(); } return render(); }
    if (a === 'send') return sendHome();
    if (a === 'builtin') { S.looks[S.mode] = null; save(); apply(); return flashMsg('Back to the standard ' + S.mode + ' look.'); }
    if (a === 'savedisk') return saveFolderToDisk();
    if (a === 'fjson') return download('five-star-designs.json', JSON.stringify(S.folder.map(designRecord), null, 1));
    if (a === 'exportadopted') return download('adopted-style.json', JSON.stringify({ scheme: look(), style: resolve(look()) }, null, 1));
    if (a === 'csv') return exportCsv();
    if (a === 'json') return download('style-lab-data.json', JSON.stringify(S));
    if (a === 'reset') {
      if (!window.confirm('Reset the Style Lab? All ratings, rounds and the 5★ folder are deleted (export them first). The adopted day and night looks stay.')) return;
      var keep = S.looks, km = S.mode; S = fresh(); S.looks = keep; S.mode = km; S.open = true; nextRound(true); save(); apply(); return render();
    }
  });
  [hud, tw].forEach(function (win) {   // drag by the title bar; both windows share one position
    win.addEventListener('pointerdown', function (e) {
      if (!e.target.closest('.hd') || e.target.closest('button')) return;
      var r = win.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      win.setPointerCapture(e.pointerId);
      var move = function (ev) { hudPos = true; hud.style.left = cl(ev.clientX - dx, 0, window.innerWidth - 60) + 'px'; hud.style.top = cl(ev.clientY - dy, 0, window.innerHeight - 30) + 'px'; syncTw(); };
      var up = function () { win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); };
      win.addEventListener('pointermove', move); win.addEventListener('pointerup', up);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (!S.open || S.tune || (e.target && e.target.getAttribute && e.target.getAttribute('role') === 'slider')) return;
    if (S.tab === 'rate' && e.key >= '1' && e.key <= '5') rate(S.sel, +e.key);
    else if (S.tab === 'rate' && e.key === 'ArrowRight') select(S.sel + 1);
    else if (S.tab === 'rate' && e.key === 'ArrowLeft') select(S.sel - 1);
    else if (e.key === 'n' || e.key === 'N') { nextRound(); render(); }
    else return;
    e.preventDefault();
  });
  window.addEventListener('resize', function () { if (S.open) setTimeout(placeHud, 160); });

  // ---------------------------------------------------------------- the Lab key on the screen
  window.onPanelBuilt = function () {
    if (!ui.bezel) return;
    ui.labKey = key(ui.bezel[0] + 14, ui.bezel[1] + 14, 52 * UK, 22 * UK, 'Lab', S.open ? 'on' : 'off', { fs: 9 * UL, aria: 'Style Lab', onClick: toggle });
    ui.labKey.b.style.zIndex = '5';
    placeHud();
  };

  // ---------------------------------------------------------------- start
  load();
  scheme = S.mode;   // script.js's Night / Day key
  window.onSchemeChange = function (m) {
    S.mode = m === 'day' ? 'day' : 'night'; save(); apply(); render();
    if (S.open) flashMsg((S.mode === 'day' ? 'Day' : 'Night') + ' scheme: adopting now sets the ' + S.mode + ' look.');
  };
  var hp = {};
  location.hash.slice(1).split('&').forEach(function (kv) { var p = kv.split('='); hp[p[0]] = p[1] == null ? true : p[1]; });
  if (hp.labfresh) { S = fresh(); save(); }
  if (hp.lab && !S.open) { S.open = true; if (!S.round) nextRound(true); }
  if (S.open && !S.round) nextRound(true);
  if (S.open) Object.keys(FONTS).forEach(loadFont);
  loadHome().then(function () {
    var bd = homeById(BUILTIN.day.id), bn = homeById(NIGHT_SRC.id);   // the standard looks follow edits at home base too
    if (bd) BUILTIN.day = Object.assign(clone(bd.sc), { name: bd.name });
    if (bn) NIGHT_SRC = Object.assign(clone(bn.sc), { name: bn.name });
    BUILTIN.night = SHIPPED = nightFrom(BUILTIN.day, NIGHT_SRC);
    ['night', 'day'].forEach(function (m) {
      var lk = S.looks[m], d = lk && lk.home ? homeById(lk.id) : null;
      if (d && JSON.stringify(d.sc) !== JSON.stringify(lk)) { S.looks[m] = clone(d.sc); save(); }
    });
    if (hp.fav) previewFav = homeById(decodeURIComponent(hp.fav));
    if (hp.tune) { S.open = true; if (!S.round) nextRound(true); S.tab = 'folder'; S.fsel = decodeURIComponent(hp.tune); openTune(); placeHud(); }
    apply(); render();
    var rep = document.getElementById('__report');
    if (hp.fav && rep) rep.textContent = JSON.stringify({ fav: hp.fav, found: !!previewFav, home: HOME.state, count: HOME.designs.length, errors: REPORT });
  });
  apply();
  build();   // the panel was built before this module loaded; rebuild to add the Lab key
  scaleStage();
  render();

  // Self-test (index.html#labsim=N): a simulated rater who likes green Chromakey windows, readable labels, mild
  // textures, and ivory caps only on deep windows, rates N rounds; reports the insights found, per-round diversity and how many values stay in play.
  function simulate(rounds, keepState) {
    var keep = S; simulating = true; S = fresh(); S.open = false; nextRound(true);
    var rater = function (c) {
      var st = resolve(c), d = derive(st, c.f), s = 3;
      if (c.f['hue.chroma'] === 'green') s += 1.2;
      s += d.num.labelContrast >= 4.5 ? 0.8 : -1.4;
      s += { flat: 0, subtle: 0.3, mild: 0.9, medium: -0.2, strong: -1.2 }[c.f.texture === 'flat' ? 'flat' : c.f.texStrength];
      if (c.f.cap === 'ivory' && c.f['panel.light'] === 'deep') s += 1.2;   // a planted interaction
      return Math.max(1, Math.min(5, Math.round(s + gauss() * 0.6)));
    };
    var shares = [];
    for (var r = 0; r < rounds; r++) {
      var maxShare = 0;
      DIMS.forEach(function (d) { if (S.pools[d.k].active.length <= 2) return; var cnt = {}; S.cands.forEach(function (c) { cnt[c.f[d.k]] = (cnt[c.f[d.k]] || 0) + 1; }); Object.keys(cnt).forEach(function (v) { maxShare = Math.max(maxShare, cnt[v] / ROUND); }); });
      shares.push(+maxShare.toFixed(2));
      S.cands.forEach(function (c, i) { rate(i, rater(c), true); });
      if (r < rounds - 1) nextRound(true);
    }
    var I = insights(), act = {};
    DIMS.forEach(function (d) { act[d.k] = S.pools[d.k].active.length; });
    var out = { rounds: S.round, ratings: S.recs.length, folder: S.folder.length, diversity: S.meta.map(function (m) { return m.div; }), maxValueShare: shares,
      minActive: Math.min.apply(null, Object.keys(act).map(function (k) { return act[k]; })), retired: S.log.reduce(function (n, c) { return n + c.retired.length; }, 0),
      introduced: S.log.reduce(function (n, c) { return n + c.introduced.length; }, 0), insights: I.items.map(function (it) { return it.kind + ': ' + it.text; }) };
    if (!keepState) { S = keep; simulating = false; }
    return out;
  }
  window.__lab = { state: function () { return S; }, rate: rate, nextRound: nextRound, select: select, toggle: toggle, insights: insights, simulate: simulate,
    openTune: function (k) { S.fsel = k; openTune(); }, tuneCycle: tuneCycle, tuneGroup: tuneGroup, tuneShuffle: tuneShuffle, tuneSave: tuneSave,
    styleCss: function (sc) { return styleCss(resolve(sc || SHIPPED)); }, shipped: SHIPPED, builtin: BUILTIN, original: ORIGINAL, home: HOME, homeExport: homeExport, resolve: resolve, derive: function (sc) { return derive(resolve(sc), sc.f); } };
  if (hp.labdemo) {   // index.html#labdemo=N: show N simulated rounds in the HUD (nothing is saved)
    var real = S; simulate(+hp.labdemo || 8, true); simulating = true; S.open = true; S.looks = real.looks; S.mode = real.mode; apply(); render();
  }
  if (hp.labsim) {
    var rep = document.getElementById('__report');
    if (rep) rep.textContent = JSON.stringify(simulate(+hp.labsim || 8));
  }
})();
