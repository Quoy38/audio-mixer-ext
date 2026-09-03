# macOS Control Center Implementation Brief

## Goal

Rebuild the extension popup so it reads as a strict macOS Control Center style surface before any Frutiger influence is added.

This brief is the source of truth for the next UI passes.

## Locked Reference

- Primary reference: user-provided macOS Control Center screenshot on May 3, 2026.
- Priority: strict macOS accuracy.
- Frutiger status: deferred until the macOS version is approved.

## Working Assumptions

- The popup cannot become a literal native macOS panel because Chrome popup geometry and browser compositing are not OS-native.
- The correct target is visual match of Control Center hierarchy, material, spacing, and control language inside popup constraints.
- One screenshot is enough to lock direction, but not enough to infer every interaction state. If later needed, additional screenshots should only be used to resolve specific missing states.

## Non-Negotiables

1. No generic web glassmorphism decisions.
2. No decorative texture-first styling.
3. No Frutiger gradients, glow, or chroma accents until the macOS baseline is approved.
4. No broad theme pass on the live popup before a single section is matched convincingly.
5. All future changes must be evaluated against the Control Center reference, not against abstract terms like "clean" or "glass".

## What The Reference Actually Shows

### Surface Model

1. The outer panel is a cool gray translucent slab, not a bright white card.
2. Depth comes from soft layering, subtle border light, and restrained shadow, not from loud contrast.
3. The material is smooth and low-noise. Texture is not visible as a graphic element.

### Grouping Model

1. Content is organized into grouped modules.
2. The modules are large rounded rectangles with even padding and stable spacing.
3. Internal controls are aligned to a grid and share a consistent inset rhythm.

### Typography Model

1. Typography is quiet and system-like.
2. Headings are compact and medium-weight.
3. Secondary text is lighter and lower contrast.
4. Layout and material do more work than font styling.

### Control Model

1. Controls are compact and dense.
2. Primary attention comes from placement and iconography, not saturated button fills.
3. Sliders are inset and system-like, not glossy web sliders.
4. Nested pill rows should feel like control cells, not separate floating capsules.

## Current Popup Deviations

The current popup diverges from Control Center in the following ways:

1. The backdrop is too designed and too visible.
2. The repeated accordion rows read as generic frosted web cards.
3. The section chrome is too bright and too uniformly white.
4. Primary buttons use a strong web-blue treatment instead of native restraint.
5. The overall hierarchy is long-form settings UI rather than grouped Control Center modules.
6. Decorative material cues are being used before structural matching is solved.

## Mapping From Current Popup To Control Center Structure

### Keep As Functional Groups

1. Header: `Audio Mixer`
2. Status row
3. Audio Capture section
4. Recorded Playback and Waveform section
5. Playback and Shaping section
6. Audio Effects section
7. Filters and Presets section
8. AI Voice Isolation section
9. AI Source Stems section

### Change In Visual Model

1. Treat each top-level section as a grouped Control Center module, not a floating glass pill.
2. Treat section summaries as compact row headers inside modules.
3. Treat nested areas as inset subgroups, not separate glossy containers.
4. Treat status and hint blocks as subtle system labels, not standalone frosted chips.

## Token Targets

These are target directions, not final literal extracted values.

### Radii

1. Outer shell radius: large, soft, close to current Control Center panel behavior.
2. Group card radius: slightly smaller than outer shell.
3. Internal cell radius: moderate, not pill-heavy.
4. Button/control radius: compact system curve, not bubble style.

### Spacing

1. Tight vertical rhythm between title, groups, and rows.
2. Generous internal padding inside each group card.
3. Consistent inset distance for all row content.
4. Avoid stacked micro-gaps that make the UI feel web-form-like.

### Material

1. Base panel tint: cool neutral gray-blue.
2. Border light: soft top/edge highlight, low contrast.
3. Shadow: broad, diffused, low-opacity ambient shadow.
4. Inner highlight: subtle, mostly top-weighted.
5. Blur: moderate and restrained.
6. Noise/texture: effectively invisible at baseline.

### Color

1. Default surfaces should stay neutral.
2. Accent blue should be used sparingly and only where the reference implies active state.
3. Secondary labels should be muted gray-blue, not saturated color.
4. Remove purple and decorative cyan from the macOS pass.

## Prohibited Visual Cues During macOS Pass

1. Visible mesh textures.
2. Frutiger wave graphics.
3. Purple glow accents.
4. Candy-gloss buttons.
5. Over-bright white cards.
6. Excessive blend-mode layering that reads as an effect rather than material.

## Build Sequence

This is the exact order to follow.

### Phase 1: Structural Reset

1. Remove or neutralize visible texture, noise, and decorative overlays in `popup/popup.css`.
2. Reduce the popup to a calm neutral panel with grouped cards.
3. Replace floating-pill logic with grouped Control Center module logic.

### Phase 2: One-Section Match

1. Choose one top-level section as the calibration section.
2. Match only these properties first:
   - outer shell spacing
   - group radius
   - group padding
   - summary row height
   - typography scale
   - divider/border feel
3. Do not tune global color drama during this phase.

### Phase 3: Control Anatomy

1. Restyle buttons, sliders, toggles, and nested rows to feel native.
2. Remove strong glossy button treatments.
3. Build a compact control cell pattern and reuse it.

### Phase 4: Material Refinement

1. Add restrained blur and edge lighting.
2. Tune panel translucency.
3. Add only subtle backdrop influence.
4. Keep texture effectively non-obvious.

### Phase 5: Propagation

1. Apply the approved module pattern to the remaining top-level sections.
2. Preserve section functionality and current behavior.
3. Re-check visual consistency after each section, not only at the end.

### Phase 6: Deferred Frutiger Pass

Only after explicit approval of the macOS baseline:

1. Add minimal chroma softening.
2. Introduce extremely restrained material richness.
3. Do not alter control anatomy.

## Acceptance Criteria For The macOS Baseline

The popup is considered on target only when all of the following are true:

1. The UI reads as a macOS Control Center-style panel before the user notices any custom styling.
2. The sections feel like grouped modules, not a stack of frosted web accordions.
3. The panel no longer depends on visible texture for its identity.
4. The hierarchy is driven by grouping and spacing, not by decorative gradients.
5. Buttons and sliders no longer feel like custom glossy web controls.
6. The whole popup feels quieter, denser, and more system-like than it does now.

## What To Do If The Result Starts Drifting Again

If a future change makes the UI feel less macOS-native, stop and check:

1. Did the surface get brighter or more decorative?
2. Did the group structure become weaker?
3. Did controls become more expressive than the reference?
4. Did texture become visible as design instead of invisible as material?
5. Did accent color start carrying too much of the hierarchy?

If the answer to any of those is yes, revert that direction and return to the previous approved state.

## Immediate Next Task

The next UI implementation pass should do only this:

1. Strip the current popup down to a strict neutral Control Center shell.
2. Convert one top-level section into a convincing grouped macOS module.
3. Validate that single section before touching the rest.