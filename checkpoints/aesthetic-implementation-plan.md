# Aesthetic Implementation Plan

## Theme Direction
- Blend Frutiger Aero light energy with early Mac rounded chrome.
- Keep UI bright, tactile, and clean.
- Primary look: clear gel glass.
- Secondary accent: gamma-purple energy glow.

## Asset Intake Checklist
- 8 to 12 inspiration screenshots for layout and component style.
- 6 to 10 texture references for backgrounds and gloss.
- 6 to 10 icon references for shape language.
- 2 font files for headings and controls.
- 3 palette candidates before final lock.

## Workspace Asset Structure
Copy design source files into workspace so they are versioned and easy to reuse.

Suggested structure:
- assets/design/inspiration/
- assets/design/textures/
- assets/design/icons/
- assets/design/fonts/
- assets/design/exports/

## Curation Rules
- Keep only high signal references.
- Remove duplicates and low-resolution files.
- Keep naming consistent: category-purpose-style-size.
- Save final production assets to exports folder only.

## Color System Draft
Use this as the first experiment set.

- gel-0: #f8fcff
- gel-1: #edf7ff
- gel-2: #dcefff
- gel-edge: #bfe4ff
- text-strong: #16324f
- text-soft: #355570
- gamma-500: #735dff
- gamma-400: #8f79ff
- gamma-300: #b3a5ff
- aqua-300: #66d9ff
- mint-300: #8ff1d0

## Material Recipe
Apply to rounded cards and controls.

- Base gradient: linear-gradient(160deg, rgba(255,255,255,0.9), rgba(220,239,255,0.6))
- Border: 1px solid rgba(255,255,255,0.75)
- Inner highlight: inset 0 1px 0 rgba(255,255,255,0.9)
- Inner shade: inset 0 -14px 24px rgba(80,120,160,0.12)
- Outer shadow: 0 10px 26px rgba(40,70,110,0.2)
- Accent glow (active): 0 0 0 1px rgba(143,121,255,0.45), 0 8px 22px rgba(115,93,255,0.35)

## Typography Draft
- Display/sections: TokyoSoft
- Control/body text: Futury-Light
- Fallback stack: "Trebuchet MS", "Verdana", sans-serif

## Build Strategy
1. Tokenize in popup CSS with root variables.
2. Restyle shell background and section cards.
3. Restyle buttons, toggles, and sliders with gel material recipe.
4. Add icon treatment and subtle highlights.
5. Add small motion: reveal fade and press depth.
6. Verify readability and interaction contrast.

## Validation Checklist
- Text legible at all control states.
- Focus rings visible with keyboard navigation.
- Hover and pressed states obvious.
- No major performance drop in popup open time.
- Mobile-size popup still readable.

## Next Action
- Move selected source files into workspace design folders.
- Confirm final palette variant (balanced vs vivid).
- Start first CSS pass on popup shell and controls.
