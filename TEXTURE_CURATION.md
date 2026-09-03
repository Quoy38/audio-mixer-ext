# Texture Curation and Integration

This file keeps the actionable texture workflow in a tracked location.

## Asset Targets

Export these files into `assets/design/exports/`:

1. `bg-aurora-gel-1600x1200.jpg`
2. `noise-gel-256.png`
3. `gamma-glow-soft-1024.png`
4. `gloss-pill-overlay.svg` (optional)
5. `card-inner-shadow.svg` (optional)

## License-Safe Sources

1. Poly Haven (CC0): https://polyhaven.com/textures
2. ambientCG (CC0): https://ambientcg.com/

## Quick Processing Recipe

1. Desaturate by 10-20%.
2. Lower contrast by 15-25%.
3. Add slight blur (2-6px) if detail competes with text.
4. Export JPG quality 78-84 for large backgrounds.
5. Keep overlays/noise as PNG.

## Current CSS Integration

The popup now supports two independent texture channels:

1. Background texture layer: controlled by `--texture-bg-*`
2. Gamma glow layer: controlled by `--texture-gamma-*`

Both can be enabled at the same time because they are rendered on separate pseudo-elements.

## Drop-In Variables

Set in `popup/popup.css` (`:root`):

```css
--texture-bg-image: url("../assets/design/exports/bg-aurora-gel-1600x1200.jpg");
--texture-bg-opacity: 0.22;
--texture-bg-blend: normal;

--texture-gamma-image: url("../assets/design/exports/gamma-glow-soft-1024.png");
--texture-gamma-opacity: 0.14;
--texture-gamma-blend: screen;
```

## QA Checklist

1. Popup opens quickly on no-audio pages.
2. 12px helper/status text stays readable.
3. Focus ring remains obvious.
4. Slider + button states remain clear.
5. No visible stutter when opening popup repeatedly.
