# ambientCG Candidate Review

This review is based on the downloaded 1K JPG packs and extracted color maps in `assets/design/ambientcg/`.

## Keep

1. `Ground093C`
- Role: soft background base
- Result: best raw candidate for a UI-safe atmosphere layer
- Notes: low-frequency, cloudy surface; still warm, but workable with existing cool CSS gradients

2. `Onyx015`
- Role: gamma overlay candidate
- Result: usable as a soft luminous overlay
- Notes: lighter and less aggressive than `Onyx013`; survives low-opacity use better

## Maybe

1. `Ground103`
- Role: backup atmosphere source
- Result: too literal as-is, but could work after heavier grading and blur

2. `Ground104`
- Role: backup atmosphere source
- Result: slightly too stony and granular, but not unusable

3. `Tiles138`
- Role: highlight source material
- Result: too tiled for direct use, but may still inform streak extraction if manually edited later

4. `Tiles132A`
- Role: highlight source material
- Result: too grid-like for direct UI texture use

## Reject

1. `Ground037`
- Reason: moss/forest detail reads too photographic and distracts from UI

2. `Ground085`
- Reason: pebble contrast is too explicit for subtle grain

3. `Onyx013`
- Reason: line structure is too assertive for a soft glow layer

4. `Fabric083`
- Reason: woven pattern reads immediately and breaks the intended gel look

## Generated Export Profile

Created in `assets/design/exports/ambientcg-v1/`:

1. `bg-aurora-gel-ambientcg-v1.jpg`
- Source: `Ground093C`
- Processing: center crop to 4:3, resize to 1600x1200

2. `gamma-glow-soft-ambientcg-v1.jpg`
- Source: `Onyx015`
- Processing: resize to 1024x1024

3. `noise-gel-ambientcg-v1.png`
- Source: `Ground093C`
- Processing: resize to 256x256
- Note: included only as a placeholder grain candidate, not yet recommended for live use
