// Home base favourites (favorites/favorites.json): list them, or merge a "Send to home base" export into them.
//   node tools/favorites.mjs list
//   node tools/favorites.mjs import <export.json>     (the JSON from "Send to home base" or home-base.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'favorites', 'favorites.json');
const GROUPS = {
  Colour: ['hue.feedback', 'hue.chroma', 'hue.transform', 'hue.color', 'hue.layers', 'panel.sat', 'panel.light', 'stage', 'accent', 'outline'],
  Texture: ['texture', 'texStrength', 'sheen'],
  Knobs: ['cap', 'skirt', 'pointer', 'pointerColor', 'scale'],
  Font: ['font', 'weight', 'case', 'tracking'],
  'Text colour': ['labelColor', 'nameplate']
};
const load = () => JSON.parse(readFileSync(FILE, 'utf8'));
const save = (data) => { data.updated = new Date().toISOString().slice(0, 10); writeFileSync(FILE, JSON.stringify(data, null, 1) + '\n'); };

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'list') {
  const data = load();
  if (!data.designs.length) console.log('No home base favourites yet.');
  data.designs.forEach((d, i) => {
    console.log(`${i + 1}. ${d.name || d.id}  [${d.id}]${d.from ? '  ' + d.from : ''}${d.overrides ? '  (edited)' : ''}`);
    if (d.note) console.log('   ' + d.note);
    for (const [g, keys] of Object.entries(GROUPS)) console.log(`   ${g.padEnd(11)} ${keys.map((k) => `${k}=${d.features[k]}`).join('  ')}`);
    if (d.overrides) console.log('   Overrides   ' + JSON.stringify(d.overrides));
  });
  if (data.insights && data.insights.length) { console.log('\nLatest insights sent with favourites:'); data.insights.forEach((t) => console.log(' - ' + t)); }
} else if (cmd === 'import' && arg) {
  const inc = JSON.parse(readFileSync(arg, 'utf8')), data = load();
  const list = Array.isArray(inc) ? inc : inc.designs || [];
  let added = 0;
  for (const raw of list) {
    const d = raw.scheme ? { id: raw.id, from: raw.candidate ? `round ${raw.round} design ${raw.candidate} (5★)` : '', features: raw.scheme.f, jitter: raw.scheme.j, raw: raw.scheme.raw } : raw;
    if (!d.id || !d.features || data.designs.some((x) => x.id === d.id)) continue;
    data.designs.push({ id: d.id, name: d.name || `Favourite ${data.designs.length + 1}`, from: d.from || '', features: d.features,
      ...(d.jitter ? { jitter: d.jitter } : {}), ...(d.raw ? { raw: d.raw } : {}), ...(d.overrides ? { overrides: d.overrides } : {}) });
    added++;
  }
  if (inc.insights) data.insights = inc.insights;
  save(data);
  console.log(`Added ${added} of ${list.length}; ${data.designs.length} home base favourites now.`);
} else {
  console.log('Usage: node tools/favorites.mjs list | import <export.json>');
}
