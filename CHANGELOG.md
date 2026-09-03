# Changelog

All notable changes to this project are documented in this file.

## [1.1.1] - 2026-07-15

### Added
- One-click macOS launcher at `Install Companion.command` that runs the companion installer and performs a health check.

### Changed
- Companion setup docs now make the one-click launcher the default path and recommend the pinned install flow over manual `pip install -r requirements.txt` entry.
- Root `README.md` now includes a quick companion install section with one-click and terminal options.

## [1.1.0] - 2026-07-09

### Added
- Self-heal `POST /v1/restart` companion endpoint that exits non-zero so launchd relaunches a fresh, re-configured process (clears profile drift or a wedged MPS engine without opening Terminal).
- "Restart Engine" button in the AI Source Stems section, with a polling recovery flow that waits for the engine to come back healthy.
- Color-coded engine status light (green healthy / amber restarting / red drift) driven by the semantic status system.
- `AGENTS.md` regression guide: isolation invariants, fragile-code list, the anti-drift lock system, the validation gate, self-heal, and a documentation map.
- `DO NOT EDIT casually` markers on the fragile prepared-isolation functions in `popup/popup.js` and `content/content.js`.

### Changed
- Voice/instrumental isolation both run the prepared full-track flow; the local DSP path is now an explicit fallback.
- Companion-unavailable state now shows a persistent "Basic mode (local DSP) — Pro engine offline" warning banner instead of silently degrading.
- `README.md` now points to `AGENTS.md` as the authoritative operational guide; superseded ONNX/UVR-MDX-NET docs carry HISTORICAL banners.

## [1.0.0] - 2026-05-26

### Added
- Capture transport controls in popup UI for previous, restart, and next track actions.
- Regression and release validation instructions in `READY_TO_TEST.md`.
- One-command release gate script at `checkpoints/release_gate.sh` with optional `--skip-health` mode.

### Changed
- Media control routing now prioritizes the captured tab for more reliable transport behavior.
- Filter preset activation flow now clears existing effects before applying the next preset to avoid stacking artifacts.
- Filter preset tuning reduced distortion/output harshness for cleaner default sound.
- Companion launcher behavior in `companion_app/run.sh` is idempotent by default with explicit `--restart` handling.
- Companion app operational docs updated in `companion_app/README.md`.

### Fixed
- Restart semantics now restart the current track consistently.
- Next/previous control reliability improved after restart operations.
- Transport control ordering and visual parity improved in popup UI.
