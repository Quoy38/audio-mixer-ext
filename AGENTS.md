# AGENTS.md — Audio Splitter & Mixer Pro (regression guide)

Read this before editing anything. This project's headline feature — **AI voice /
instrumental isolation** — has broken repeatedly in subtle ways. Most breakage is
**external drift**, not obvious bugs, so the usual "it looks fine" review misses it.
This guide encodes the invariants that keep isolation working **forever**.

Canonical path: `/Users/user/Developer/audio-mixer-ext` (kept OFF iCloud/Desktop on
purpose — see Drift vector #4). Do not move it back under a synced folder.

---

## Prime directive

**Do not regress voice/instrumental isolation or the companion contract.** When in
doubt, make the smallest change and run the gate. Prefer additive changes over
rewrites of the fragile functions listed below.

---

## Validate EVERY change (before and after)

Run these from the repo root. All must stay green.

```sh
node --check popup/popup.js                        # popup.js is a classic script, NOT a module
python3 -m py_compile companion_app/server.py      # companion syntax
bash checkpoints/verify_voice_isolation_lock.sh    # 16 regression guards (needs engine, or --skip-health)
bash checkpoints/check_profile_drift.sh            # 22-field profile agreement (needs engine)
bash companion_app/doctor.sh                        # full diagnosis, expect ALL GREEN
bash checkpoints/release_gate.sh                    # the whole gate (voice-lock + integrity + smoke + drift)
```

After a **green** gate, bank a restorable checkpoint:

```sh
bash checkpoints/make_checkpoint.sh                 # only archives from a green gate
```

Engine health any time:

```sh
curl -s http://127.0.0.1:48231/v1/health           # expect ok:true, device:mps, overlap:0.25, warmed:true
```

---

## Architecture in one screen

- **Chrome MV3 extension.** `manifest.json` exposes the same `popup/popup.html` as BOTH
  a toolbar popup and a side panel. Each surface (toolbar popup, docked side panel,
  standalone tab) is a **separate JS context** with its own `audioContext`/`stream`.
  The toolbar popup is **ephemeral** — it closes on focus loss, destroying capture.
  Debug by right-clicking *inside* the popup → Inspect (keeps it alive).
- **`popup/popup.js`** (~10k lines) holds all capture, FX, stem, and isolation logic.
  It is a **classic script**, so validate with `node --check`, not a bundler.
- **Python companion** (`companion_app/server.py`, FastAPI + Demucs) does the heavy
  separation on-device. Managed by launchd (`com.audiomixerext.companion`), port
  **48231**, model **htdemucs** on **mps**. Endpoints: `GET /v1/health`,
  `POST /v1/stems/split` (raw audio body + `X-Requested-Stems` header),
  `POST /v1/restart` (self-heal).

### The two isolation modes (BOTH now use the PREPARED full-track flow)

Dropdown `#voiceIsolationMode`: `vocals` (default) and `instrumental`. Both run the
identical order-of-operations via `startPreparedInstrumentalMode()`:
seek to 0:00 → mute tab → capture the whole song while looping silently → POST the
requested stem to the companion → play the processed buffer looped perpetually. Only
the stem string differs (`vocals` vs `instrumental`). The old live-streaming path
(`startLiveCompanionIsolation`) is **DORMANT** — left in place, not deleted; do not
re-route to it. If the companion is unavailable, both modes fall back to local DSP and
show the **Basic mode** warning banner (no silent quality drop).

---

## Fragile code — DO NOT EDIT without extreme care

These carry the isolation invariants. Files are marked with `DO NOT EDIT` banners.
Changing them has silently broken isolation before. If you must touch them, run the
full gate AND test both modes in Chrome.

In `popup/popup.js`:
- `startPreparedInstrumentalMode` — the whole prepared flow entry point (contains the
  `keepSongLooping` guardian, hard-loop enforcer, sync watchdog).
- `capturePreparedInstrumentalPass` — full-song capture pass.
- `syncPreparedInstrumentalPlayback` — **must not contain `setTimeout(`** (the
  voice-lock enforces this; it caused runaway timers).
- `schedulePreparedInstrumentalAction` / `setPreparedInstrumentalState` /
  `isPreparedInstrumentalSessionCurrent` — the session-identity state machine that
  prevents a second start from aborting the first (the double-start race).
- `restartAndPlayActiveTabFromZero` — page restart/loop coupling.
- `COMPANION_LOCK_PROFILE` + `isCompanionProfileLocked` — the client half of the
  anti-drift contract; the 8 locked fields MUST match the companion.

In `content/content.js`: `restartAndPlayFromZero` (YouTube Music DOM coupling).

Do **not** reintroduce `mediaEl.loop = true` or Repeat-One DOM clicking as the loop
mechanism — the captured buffer loops independently of the page on purpose.

---

## The anti-drift lock system (why isolation "breaks with zero edits")

Single source of truth: `companion_app/companion_profile.json`. Everything else is
checked against it.

| Guard | Catches |
|---|---|
| `companion_app/requirements.lock` | torch/torchaudio/numpy drift (a silent update → 500s) |
| `companion_app/companion_profile.json` | the 8-field profile + port + model + env |
| `companion_app/model_weights.manifest.json` | missing/corrupt Demucs weights (per model) |
| `companion_app/doctor.sh` | one-command diagnosis + `--fix`, `--deep` (sha256), `--static` (offline) |
| `checkpoints/check_profile_drift.sh` | canonical vs live `/v1/health` vs installed plist vs popup.js (22 fields) |
| `checkpoints/verify_voice_isolation_lock.sh` | 16 code/profile regression guards |
| `checkpoints/release_gate.sh` | runs all of the above |
| `checkpoints/make_checkpoint.sh` | archives ONLY from a green gate |

The **model** field is intentionally NOT one of the 8 locked profile fields, so the
htdemucs⇄htdemucs_ft swap is allowed without tripping the lock.

### Known drift vectors (all external to the code)
1. **Python deps unpinned** → fixed by `requirements.lock`. Re-pin after any deliberate upgrade.
2. **Installed-plist profile drift** (e.g. overlap 0.1 vs 0.25) → companion silently rejected → local DSP. `check_profile_drift.sh` catches it.
3. **YouTube Music DOM / gapless queue** — one media element whose `currentTime` crosses track boundaries; handled via snapshot-duration looping. Fragile; test on real YT Music.
4. **iCloud offloading** — "Optimize Mac Storage" evicts files to the cloud (`dataless` flag); reads time out → breaks with zero edits, then "heals" when re-downloaded. `doctor.sh` §8 flags dataless files. Keep the project off synced folders.

---

## Companion service

- Runs via launchd; the installed LaunchAgent
  (`~/Library/LaunchAgents/com.audiomixerext.companion.plist`) points at THIS repo's
  `companion_app/server.py`, so a code edit loads on restart.
- Restart after a **code** change (re-reads server.py):
  ```sh
  launchctl kickstart -k "gui/$(id -u)/com.audiomixerext.companion"
  ```
- Restart after an **env/plist** change (kickstart won't re-read env — needs a full reload):
  ```sh
  launchctl bootout gui/$(id -u)/com.audiomixerext.companion
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.audiomixerext.companion.plist
  ```
- **KeepAlive is `SuccessfulExit=false`**: launchd relaunches only on a **non-zero**
  exit. A clean `exit(0)` is how the port guard stops restart loops. Therefore the
  self-heal `POST /v1/restart` deliberately exits with `os._exit(42)` so a fresh,
  re-configured process comes back (clearing drift/wedged MPS without a Terminal).
  Startup preloads the model *before* serving, so the first successful `/v1/health`
  after a restart already reports `warmed:true`.
- Logs: `~/Library/Logs/AudioMixerExt/companion.log` (stdout) and `…-error.log` (stderr).

---

## Restore a known-good state

```sh
shasum -a 256 -c checkpoints/audio-mixer-checkpoint-<TS>.sha256
tar -xzf checkpoints/audio-mixer-checkpoint-<TS>.tar.gz
bash companion_app/doctor.sh && bash checkpoints/release_gate.sh
```

Checkpoints exclude `models/`, `libs/`, `.venv/`, `.git/`. The latest verified
checkpoint is the newest `checkpoints/audio-mixer-checkpoint-*.tar.gz`.

---

## Recipes

- **Change isolation behavior** → edit the prepared flow carefully, `node --check`,
  `verify_voice_isolation_lock.sh`, test BOTH modes in Chrome, then checkpoint.
- **Change the companion profile** (overlap, device, fast-clip flags) → edit
  `companion_profile.json` FIRST, then the installed plist env, reload the service,
  then `check_profile_drift.sh` until all 22 fields agree.
- **Deliberately upgrade a Python dep** → upgrade in `.venv`, re-run tests, then
  `pip freeze --all > companion_app/requirements.lock` and `doctor.sh --deep`.
- **Reload after editing popup.js/html/css** → `chrome://extensions` → reload, then
  hard-refresh the YT Music tab (Cmd+Shift+R; `content.js` only re-injects then).

---

## Documentation map

This file is the single source of truth for isolation behavior, ops, and the gate.
Other docs are indexed here so nobody acts on a stale one.

**Authoritative (trust these):**

- `AGENTS.md` (this file) — isolation invariants, fragile code, anti-drift lock, gate, self-heal.
- `README.md` — workspace/file map and the safe-organization rule.
- `companion_app/README.md` — companion install/run/uninstall.
- `COMPANION_APP_PROTOCOL.md` — HTTP contract between popup and companion.
- `CHANGELOG.md` — shipped changes.

**Historical / superseded (kept for context, do NOT follow as instructions):**

- `VOICE_ISOLATION_STATUS.md`, `VOICE_ISOLATION_INTEGRATION.md`, `READY_TO_TEST.md`,
  `GET_VOICE_MODEL.md` — describe the earlier real-time ONNX/UVR-MDX-NET approach.
  The shipping engine is the **Demucs companion prepared full-track flow**. Each of
  these files now carries a "HISTORICAL / SUPERSEDED" banner pointing back here.

**Reference (design/perf, not runtime behavior):**

- `OPTIMIZATIONS.md`, `TEXTURE_CURATION.md`, `TEXTURE_REVIEW.html`,
  `MACOS_CONTROL_CENTER_BRIEF.md`, `Audio Extension Plan Doc.txt`,
  `UI Implementation Plan.txt`, `checkpoints/*.md`.
</content>
</invoke>
