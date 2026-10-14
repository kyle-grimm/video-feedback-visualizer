# Home base favourites

`favorites.json` holds the Style Lab designs kept and edited here. The site serves it, and the Lab's
5★ Folder lists it under **Home base**, where each design can be previewed and adopted. A design adopted from home
base follows later edits to this file (matched by `id`). To preview one directly, open the site with `#fav=<id>`.

## Getting favourites here
In the Lab, open **5★ Folder** and press **Send to home base**. This copies the device's 5★ designs (plus the
current insights) as JSON to paste into a chat or a file. **Save folder…** writes the same JSON as `home-base.json`
(Chrome/Edge desktop; elsewhere it downloads). Merge it with:

    node tools/favorites.mjs import path/to/home-base.json
    node tools/favorites.mjs list

## Entry format
```json
{
  "id": "5k3x6wn",                 // stable; the Lab matches adoption by it
  "name": "Amber night",           // shown in the Lab
  "note": "why it was kept",       // optional
  "from": "round 3 design F (5★)",
  "features": { "hue.chroma": "green", "texture": "grille", "labelColor": "bright", ... },
  "jitter": { "h": [..5], "s": [..5], "l": 0, "p": 0 },   // small per-design variation; leave as is
  "raw": { ... },                  // only for the original built-in scheme (exact parameters)
  "overrides": { ... }             // optional exact style values, applied last
}
```
**Features** are the Lab's categorical choices (the dimension list and values are `DIMS` in `lab.js`): window colours
`hue.feedback|chroma|transform|color|layers`, `panel.sat`, `panel.light`, `stage`, `accent`, `outline`, `texture`,
`texStrength`, `sheen`, `cap`, `skirt`, `pointer`, `pointerColor`, `scale`, `font`, `weight`, `case`, `tracking`,
`labelColor`, `nameplate`. Any value from a dimension's pool works, retired or reserve ones included.

**Overrides** set resolved style values exactly, for alterations finer than a feature: `hue` / `sat` (arrays of 5:
feedback, chroma, transform, color, layers; hue in degrees, sat ×1), `pSat`, `pLight` (window saturation and
lightness, 0–1), `kSat`, `kLight` (family accent colour), `sHue`, `sSat`, `sLight` (background), `texture`, `texStr`,
`sheen`, `accentHue`, `glassHue`, and the style names `tab`, `label`, `ptr`, `cap`, `skirt`, `pointer`, `scale`,
`font`, `weight`, `textCase`, `tracking`, `outline`. An edited design shows "edited" in the Lab.
