# Checkpoint: VERIFIED LOCK-DOWN (2026-07-07)

Archive: `audio-mixer-checkpoint-20260707-185710.tar.gz`
Checksum: `audio-mixer-checkpoint-20260707-185710.sha256`

This supersedes `audio-mixer-checkpoint-20260620-221152` (prepared-instrumental
working). It is the first checkpoint created by `checkpoints/make_checkpoint.sh`,
which only archives from a GREEN `release_gate.sh`, so this archive is a verified
known-good state of BOTH the code and the anti-drift lock system.

## What is guaranteed green in this checkpoint
- `release_gate.sh` passes clean (live + `--skip-health`). The old overlap
  self-contradiction (verify wanted 0.25, smoke wanted 0.1) is fixed.
- Dependency lock: `.venv` matches `companion_app/requirements.lock` exactly
  (torch/torchaudio/numpy pinned — the #1 "broke with no edits" cause).
- Model weights: 4 `htdemucs_ft` files present + size-verified against
  `companion_app/model_weights.manifest.json` (sha256 with `doctor.sh --deep`).
- Profile: canonical `companion_app/companion_profile.json` agrees with live
  `/v1/health`, the installed plist, and popup.js COMPANION_LOCK_PROFILE
  (22-field cross-check via `check_profile_drift.sh`).
- No runtime-critical file is iCloud-offloaded (see drift vector #4 below).

## The lock system added (all bundled in this archive)
- `companion_app/requirements.lock` — full pinned env (pip freeze --all).
- `companion_app/companion_profile.json` — single source of truth for the 8-field
  profile + port + model + runtime env.
- `companion_app/model_weights.manifest.json` — htdemucs_ft weight integrity.
- `companion_app/doctor.sh` — one-command diagnosis + safe auto-repair
  (`--fix`), sha256 weights (`--deep`), offline mode (`--static`).
- `checkpoints/check_profile_drift.sh` — canonical-vs-live/plist/popup drift check.
- `checkpoints/make_checkpoint.sh` — gated checkpoint creator.
- `release_gate.sh` — now also runs doctor --static + drift check.

## Drift vector #4 discovered this session: iCloud offloading
"Desktop & Documents in iCloud" + **Optimize Mac Storage** was evicting this
project's files to the cloud (filesystem flag: `dataless`). When the extension or
companion reads such a file, iCloud fault-in can time out (`ETIMEDOUT`) →
**isolation breaks with ZERO code edits and later "heals itself"** when iCloud
re-downloads. This matches the recurring mystery breakage precisely.

- Found `voice-isolation-worklet.js` OFFLOADED and unrecoverable via iCloud
  (`brctl status` → "Client zone not found"). Restored byte-identical (3213 B)
  from the 2026-06-20 checkpoint tarball; it is LOCAL again.
- `doctor.sh` now checks runtime-critical files for the dataless flag (section 8).
- **PERMANENT FIX (user action):** disable iCloud "Optimize Mac Storage", OR move
  the project off `~/Desktop`, OR Finder → right-click folder → "Keep Downloaded".
  Until then, files can be re-evicted at any time.

## Restore
```sh
cd /Users/user/Desktop/audio-mixer-ext
shasum -a 256 -c checkpoints/audio-mixer-checkpoint-20260707-185710.sha256
tar -xzf checkpoints/audio-mixer-checkpoint-20260707-185710.tar.gz
```
Archive excludes `models/`, `libs/`, `.venv/`, `.git/`, and prior checkpoint
tarballs. After restoring code, re-verify with:
```sh
bash companion_app/doctor.sh          # expect ALL GREEN
bash checkpoints/release_gate.sh      # expect all automated checks green
```
