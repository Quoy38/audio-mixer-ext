# Design Reference Triage

## Goal
Turn mixed-quality inspiration images into a clean production asset pipeline.

## Folder Triage Summary

### Keep as Reference Only
These are useful for style direction but should not be used directly in UI due to unknown licensing, compression artifacts, or mismatched resolution.

- assets/design/Inspiration Images/
- assets/design/Icon Reference/
- assets/design/Color palette/

### Candidate Texture Source Material
These can seed the visual atmosphere but should be cropped, reduced, and normalized before use.

- assets/design/Textures/Aurora Gradient .jpg
- assets/design/Textures/Clear gel gradient.jpg
- assets/design/Textures/Frutiger aqua gradient texture.jpg
- assets/design/Textures/Purple gradient tex.png

### Production-Ready Inputs
These can be used directly in app with minimal risk.

- assets/design/Font/TokyoSoft.ttf
- assets/design/Font/Futury-Light.ttf

## Quality Rubric
Score each source image 1 to 5 in each category.

- Resolution clarity: sharp edges and no heavy JPEG artifacts
- Composition utility: reusable as texture or shape source
- Lighting relevance: matches clear gel + gamma glow direction
- Color relevance: aligns with primary gel and secondary purple
- License confidence: safe for use in shipped extension

Only assets scoring 4 or better in all categories should graduate to production.

## Production Asset Targets
Create these in assets/design/exports/ and use these in CSS.

1. bg-aurora-gel-1600x1200.jpg
- Soft cyan-to-blue base
- Purple light strands
- Low visual noise

2. noise-gel-256.png
- Subtle monochrome grain at very low contrast
- Tileable

3. gloss-pill-overlay.svg
- Thin top highlight arc for buttons and cards

4. card-inner-shadow.svg (optional)
- Very subtle bottom interior shading for depth

5. icon-badge-base.svg
- Reusable glossy circular badge base for icon system

## Fast Extraction Workflow
1. Choose one texture reference from assets/design/Textures.
2. Crop to remove focal hotspots and obvious artifacts.
3. Reduce saturation 10 to 20 percent.
4. Add slight blur if harsh edges remain.
5. Export final background at 1600x1200 and compressed quality around 78 to 84.
6. Generate a separate tiny noise texture at 256x256.

## Asset Usage Rules
- Use large raster only for background atmosphere.
- Use SVG for highlights, gloss, and icon shells.
- Keep interactive components mostly CSS-driven for fast tuning.
- Avoid embedding text inside images.

## Next Step
After first visual pass review, replace temporary background texture with curated exports in assets/design/exports/.
