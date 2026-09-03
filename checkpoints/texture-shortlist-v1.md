# Texture Shortlist v1 (Real Candidate URLs)

## Scope
This shortlist is focused on production-safe candidates that can be normalized into the Frutiger gel + gamma accent look.

Primary source used for concrete links: ambientCG (CC0).
- License reference: https://ambientcg.com/

## Top 10 Candidates

1. Ground103
- URL: https://ambientcg.com/view?id=Ground103
- Role: Base soft atmosphere source for bg-aurora-gel-1600x1200
- Why: Ground families often provide low-contrast, broad tonal variation after blur/desaturation

2. Ground037
- URL: https://ambientcg.com/view?id=Ground037
- Role: Alternate shell background source
- Why: Good candidate for broad gradients and subtle micro-detail extraction

3. Ground104
- URL: https://ambientcg.com/view?id=Ground104
- Role: Backup atmosphere base
- Why: Likely neutral enough for heavy color grading into aqua/cyan

4. Ground085
- URL: https://ambientcg.com/view?id=Ground085
- Role: Noise source extraction (downsample to 256)
- Why: Useful for micro-grain overlays after aggressive contrast reduction

5. Ground093C
- URL: https://ambientcg.com/view?id=Ground093C
- Role: Texture breakup layer at 4-8% opacity
- Why: Candidate for subtle depth without strong pattern repetition

6. Tiles138
- URL: https://ambientcg.com/view?id=Tiles138
- Role: Gloss streak and card highlight source material
- Why: Tile surfaces can yield clean directional sheen when cropped and blurred

7. Tiles132A
- URL: https://ambientcg.com/view?id=Tiles132A
- Role: Secondary gloss/edge light source
- Why: Potential smooth transitions for pill overlays

8. Onyx013
- URL: https://ambientcg.com/view?id=Onyx013
- Role: Gamma glow source (purple energy layer)
- Why: Onyx variants can provide rich purple veins usable as low-opacity bloom

9. Onyx015
- URL: https://ambientcg.com/view?id=Onyx015
- Role: Alternate gamma glow source
- Why: Good candidate for soft purple strands after blur and level compression

10. Fabric083
- URL: https://ambientcg.com/view?id=Fabric083
- Role: Fine grain source for noise-gel-256
- Why: Fabric microstructure can become elegant monochrome grain with heavy processing

## Immediate Keep/Reject Workflow

1. Open each candidate and save one preview frame locally.
2. Run normalization:
- Saturation -15%
- Contrast -20%
- Slight blur 2 to 6px
- Export 1600x1200 for background tests
3. Run readability test in popup:
- 12px text in status/hint regions must remain clean
4. Reject any texture with visible repeating pattern at popup scale.

## Recommended First Pass Order

1. Ground103
2. Ground037
3. Onyx013
4. Fabric083

This set should get you closest to polished gel shell + gamma glow quickly.

## License Notes

ambientCG states assets are CC0 and free for commercial use without attribution:
- https://ambientcg.com/

For future additions, keep Poly Haven and ambientCG as primary sources.
