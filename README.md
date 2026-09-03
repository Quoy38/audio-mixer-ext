# Audio Mixer Extension Workspace Map

This repository now keeps the live extension paths in place and adds editor-side organization only.

The goal is simple: make future edits easier without changing any runtime file locations.

> **Start here for anything involving isolation, the companion, or “why did it break”:**
> [`AGENTS.md`](AGENTS.md) is the authoritative operational + regression guide (fragile code,
> the anti-drift lock system, the validation gate, and self-heal). This README is the file map.

## Quick Companion Install (macOS)

- Double-click `Install Companion.command` in the repo root for one-click setup.
- Terminal alternative: `bash companion_app/install-macos-service.sh`
- Verify status any time: `bash companion_app/doctor.sh`

## Runtime Entry Points

- `manifest.json`: extension wiring and web-accessible resources
- `popup/`: popup UI and most user-facing state logic
- `background/`: service worker entry point
- `content/`: page injection logic
- `offscreen/`: offscreen audio document
- `companion_app/`: local Python companion service for desktop integration
- `libs/`: browser-side runtime libraries
- `models/`: ONNX separation models used at runtime
- `pitch-shifter-worklet.js`: audio worklet loaded by the extension
- `voice-isolation-worklet.js`: audio worklet loaded by the extension

## Fast Edit Guide

- Popup visuals: start in `popup/popup.html` and `popup/popup.css`
- Popup behavior and persistence: start in `popup/popup.js`
- Capture/session issues that survive popup close: check `popup/popup.js`, `background/background.js`, and `offscreen/offscreen.js`
- Voice isolation/model loading: check `popup/popup.js`, `models/`, `libs/ort.min.js`, and `voice-isolation-worklet.js`
- Companion app behavior: check `companion_app/server.py` and `companion_app/README.md`

## Design And Reference Files

These are useful while editing, but they are not runtime entry points.

- `TEXTURE_REVIEW.html`: visual review sheet for texture exports
- `TEXTURE_CURATION.md`: texture pipeline notes and current CSS integration
- `VOICE_ISOLATION_INTEGRATION.md`: ⚠️ historical — early ONNX/UVR-MDX-NET plan, superseded by the Demucs prepared-flow (see `AGENTS.md`)
- `VOICE_ISOLATION_STATUS.md`: ⚠️ historical — describes the old live-streaming approach, superseded (see `AGENTS.md`)
- `GET_VOICE_MODEL.md`: model acquisition/setup notes referenced by popup logging
- `COMPANION_APP_PROTOCOL.md`: companion app protocol reference
- `OPTIMIZATIONS.md`: performance notes
- `READY_TO_TEST.md`: ⚠️ historical setup notes (old ONNX model) — for current validation use `AGENTS.md` “Validate EVERY change”
- `Audio Extension Plan Doc.txt`: planning notes

## Asset Layout

- `assets/`: extension icons and design assets
- `assets/design/exports/`: production-ready exported textures
- `assets/design/exports/frutiger-v1/`: current popup texture set used by popup CSS
- `assets/design/exports/README.md`: export folder summary
- `assets/design/exports/ASSET_SOURCES.md`: source provenance for exported assets

## Checkpoints

`checkpoints/` stores archived plans and checkpoints. The workspace settings hide checkpoint archive blobs in the Explorer so the editable markdown files stay easier to scan.

## Safe Organization Rule

Do not move files under `popup/`, `background/`, `content/`, `offscreen/`, `libs/`, `models/`, or either worklet path unless you also update every manifest/code reference. The current workspace organization intentionally avoids that risk.

## Voice Isolation Regression Lock

Prepared vocal isolation is a locked feature path. See [`AGENTS.md`](AGENTS.md) for the full
regression guide, fragile-code list, and the complete validation gate.

Before shipping any change that touches popup audio state, companion settings, or routing logic, run:

```bash
cd ~/Developer/audio-mixer-ext
bash checkpoints/verify_voice_isolation_lock.sh
```

Use `--skip-health` only when the companion service is intentionally offline.