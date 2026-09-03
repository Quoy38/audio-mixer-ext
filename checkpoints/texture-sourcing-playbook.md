# Texture Sourcing Playbook (Frutiger Gel + Gamma Accent)

## Objective
Find legally safe, high-quality textures that make the popup feel polished and true to the aesthetic direction:
- clear gel
- soft aqua/cyan atmosphere
- subtle gamma-purple energy
- clean, low-noise UI-friendly backgrounds

## Safe Source Priority
Use this order to minimize licensing risk and maximize quality.

1. Poly Haven (CC0)
- https://polyhaven.com/textures
- License: CC0 (commercial use, no attribution required)

2. ambientCG (CC0)
- https://ambientcg.com/list?type=atlas,material,decal
- License: CC0 (commercial use, no attribution required)

3. cgbookcase (free, unrestricted per site statement)
- https://www.cgbookcase.com/textures
- Verify specific asset/license page before final ship

4. Photo sources for atmosphere overlays only (not direct UI textures)
- Unsplash license: https://unsplash.com/license
- Pexels license: https://www.pexels.com/license/

## What To Download (Target Set)
Build this production pack in assets/design/exports/:

1. bg-aurora-gel-1600x1200.jpg
- Main backdrop for shell atmosphere
- Soft cyan/blue gradients with very low detail frequency

2. noise-gel-256.png
- Tileable grain at very low contrast
- Used as a subtle overlay only

3. gloss-pill-overlay.svg
- Highlight streak for card/button top sheen

4. card-inner-shadow.svg
- Optional micro-depth for section cards

5. gamma-glow-soft-1024.png
- Very soft purple bloom used sparingly (opacity 8-16%)

## Search Queries (High Yield)
Use these exact phrases on texture sites:

- "frosted plastic"
- "acrylic"
- "clear resin"
- "smooth painted"
- "soft noise"
- "micro surface"
- "water ripple subtle"
- "glass blur"
- "pastel gradient"
- "aqua"

Avoid high-frequency textures (heavy concrete, brick, wood grain) for shell surfaces.

## Selection Rubric (Pass/Fail)
Keep only assets that pass all checks.

1. Readability-safe:
- At 12px text, no visual interference in background

2. Frequency-safe:
- No repetitive obvious pattern at popup size

3. Contrast-safe:
- Controls still pop with clear foreground/background separation

4. Color-safe:
- Works with gel-blue base and gamma-purple accents

5. License-safe:
- Confirmed commercial-friendly and redistributable for extension packaging

## Normalization Pipeline (Per Asset)
Run this quick edit pipeline before import:

1. Crop out hotspots and recognizable focal objects
2. Reduce saturation by 10-20%
3. Lift exposure slightly (+0.1 to +0.2)
4. Add small blur if detail competes with text
5. Export JPG quality 78-84 for large background
6. Export PNG for small overlays/noise

## Integration Rules

1. One dominant texture at a time:
- Do not stack multiple busy rasters

2. Keep UI component materials CSS-driven:
- Use images only for atmosphere and subtle overlays

3. Cap overlay opacity:
- Noise 4-8%
- Glow 8-16%

4. Test in real popup dimensions:
- Open/close quickly to ensure no perceived lag

## Quick QA Checklist

- Popup opens instantly on no-audio pages
- Text remains legible in every section
- Focus rings remain clearly visible
- Hover/active states are obvious
- No stutter when opening popup repeatedly

## Tracking Template
When you shortlist assets, record entries like this:

- filename:
- source url:
- license:
- intended usage:
- notes (contrast/frequency):
- final status: keep/reject
