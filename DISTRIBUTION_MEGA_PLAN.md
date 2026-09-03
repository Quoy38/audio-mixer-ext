# Audio Splitter & Mixer Pro — Distribution Mega-Plan

> **Status:** Planning (updated 2026-08-05). Forward-looking distribution/architecture plan,
> **not** a description of current runtime behavior. For shipped behavior and invariants,
> `AGENTS.md` remains authoritative.
>
> **⚠️ SCOPE CHANGE (2026-08-05): the live "Voice Isolation" feature — *isolate what's playing in
> the tab* — was REMOVED at the user's request** (it kept failing; UI hidden + entry points
> neutralized, deep code left dormant). **Stem Separation is now the sole shipping AI feature and is
> unaffected** (parity-verified byte-identical). This dissolves the plan's biggest tension: the old
> flagship/hosted split (Concern A) is gone, the "two honest jobs" architecture **collapses to one
> job** (stem separation of a loaded buffer), and the local companion drops from **mandatory** (the
> legal home of the flagship) to **optional** (privacy/offline/unlimited + the R3-safe home for
> separating **tab-recorded** audio). Already landed from this plan: the **PNA/CORS preflight** and
> the **output-parity harness**. Sections below are annotated where the removal changes them.

---

## 0. North Star (TL;DR)

Ship the working Demucs stem-separation engine to a **public, mass-market, non-technical**
audience with **zero stress**, via a **hybrid engine**:

- **Cloud (hosted) = default, zero-install** — for **files the user provides/owns**.
- **Local companion = optional, one-click, free/private/offline** — for unlimited on-device
  processing and the **only** R3-safe place to separate **tab-recorded** audio (a stream the user
  captured to a file). *(The live "isolate what's playing" flagship was removed 2026-08-05; the
  local engine is no longer mandatory — see the scope-change banner.)*

**Prime directive:** do **not** regress the 100+ hour working **stem-separation** engine. Every
step below is additive and gated.

---

## 1. Goal & Resolved Decisions

**Goal.** Zero-install default path for the masses; optional on-device power-user path for
privacy/offline/free processing on **macOS + Windows**; public distribution means
signed/notarized installers, auto-update, and support telemetry.

**Resolved (user, 2026-07-15):**
1. Separation location: **HYBRID** — hosted default, on-device optional.
2. Audience: **PUBLIC / mass-market**, non-technical.
3. Platforms (on-device): **macOS + Windows**.
4. Signing: **YES** — Apple Developer + notarize, and Windows code signing.

---

## 2. Preservation Contract (non-regression firewall — PRIME DIRECTIVE)

Nothing in hosted/hybrid/Windows work may regress the working engine. If a step here conflicts
with a feature, the feature yields.

1. **Additive-only** around the `AGENTS.md` fragile functions (`startPreparedInstrumentalMode`,
   `capturePreparedInstrumentalPass`, `syncPreparedInstrumentalPlayback` [must stay
   `setTimeout`-free], the `…PreparedInstrumentalSessionCurrent` state machine,
   `restartAndPlayActiveTabFromZero`, `COMPANION_LOCK_PROFILE`/`isCompanionProfileLocked`,
   `content.js restartAndPlayFromZero`). New engine code **wraps**, never edits.
2. **Local path unchanged by default.** If a healthy local companion is present, use the existing
   code path byte-for-byte. Hosted is used only when no local engine exists or the user opts in.
3. **Don't weaken the lock.** Keep the 8 locked profile fields exactly for LOCAL. Hosted gets a
   **separate** versioned contract (`hosted_profile`/`api_version`). Only sanctioned local change:
   device enum accepts `{mps,cpu,cuda,directml}` via the existing CPU-fallback pattern (extend,
   don't delete the lock).
4. **Don't reactivate dormant code.** As of 2026-08-05 the **entire live isolation feature is
   dormant** — `startLiveCompanionIsolation` **and** `startPreparedInstrumentalMode` (UI hidden +
   entry points neutralized). Leave it inert (this keeps `verify_voice_isolation_lock.sh` green);
   do **not** re-route to it, and no `mediaEl.loop=true`/Repeat-One DOM clicks. The preservation
   firewall's **live** subject is now **Stem Separation** (`generateStems`, `requestCompanionStems`,
   `requestKuielabVocalIsolation`, the `/v1/stems/split` contract, `COMPANION_LOCK_PROFILE`).
5. **Output-parity harness (new).** Reference corpus (public-domain clips) + expected stems.
   Assert hosted == local: same 4 stems, `instrumental = drums+bass+other`, PCM16 WAV,
   `overlap 0.25`, matching sample rate, within a perceptual tolerance (log-spectral / SI-SDR).
   Catches silent drift across engines **and** versions.
6. **Gate everything.** `release_gate.sh` + `verify_voice_isolation_lock.sh` +
   `check_profile_drift.sh` green before **and** after every change; `make_checkpoint.sh` only from
   green. Add CI running the gate (`--skip-health` where no engine) on every PR/branch.
7. **Branch + checkpoint.** All new work on branches; mainline always restorable from the newest
   checkpoint tarball. Never force-push, never `--no-verify`.
8. **Freeze `requirements.lock`** (`torch==2.2.2`). Any dep change is a deliberate, gated event.
9. **PNA/CORS self-defense (latent regression — act now, additive).** Chrome enforces Private
   Network Access on `chrome-extension://` → `127.0.0.1`. The companion **must** answer the OPTIONS
   preflight (200/204) with `Access-Control-Allow-Private-Network: true` + `Access-Control-Allow-
   Origin` (extension-id allowlist) + `Allow-Methods GET,POST,OPTIONS` + `Allow-Headers
   Content-Type,Authorization`, and `manifest.json` must declare the loopback `host_permission`.
   Missing header ⇒ `Failed to fetch (kPrivateNetworkAccessPermissionDenied)` would silently kill
   the working engine on a future Chrome. Add via an OPTIONS handler that does not touch split/health
   logic; gate before + after.

*Maintenance risk (track, don't act yet):* the `torch==2.2.2` pin + torchaudio deprecation means
future security updates may break Demucs → plan a controlled, gated re-pin cadence later.

---

## 3. Architecture — the hybrid engine (one job, two engines)

Since the live "isolate what's playing" feature was removed (2026-08-05), there is now **one job** —
**Stem Separation of a loaded audio buffer** (`generateStems` on `loadedAudioBuffer`) — served by
either engine, chosen by **input source**:

| Input source | Engine | Install | Audience |
|---|---|---|---|
| **A file the user picks** (upload) | **Cloud** (Modal/L4) — default | **Zero-install** | Mass-market default |
| **Any audio, unlimited/offline/private** | **Local companion** — optional | One-click, free | Power users |
| **Tab-recorded audio** (`Load Last Recording` → stems) | **Local only** (R3) | — | Must stay on-device |

The one residual legal rule is a **routing gate, not a feature**: the **cloud accepts user-picked
files only**. A buffer sourced from `loadLastRecording` (a recording of streaming/tab audio) must be
separated **on-device** or blocked from the cloud — incumbents (Moises) block streaming input to
avoid label suits, and R3 keeps that risk off our servers. This is a small `if source === recording`
check instead of a whole flagship needing a local engine.

Client routing (Phase B): `COMPANION_API_BASE_URL` becomes configurable; an **engine resolver**
uses a healthy local companion when present, else the cloud (files only), else local **Basic DSP**
fallback — always graceful, never a silent quality drop.

---

## 4. Phased Build Plan (preservation-first order)

1. ✅ **Phase 0 — Stabilize macOS script path** — **DONE 2026-08-05** (checkpoint
   `audio-mixer-checkpoint-20260805-171302`): device auto-detect (MPS ≥ 12.3 else CPU) in
   `install-macos-service.sh`; arch (`uname -m`) logged (Rosetta-aware native detection deferred to
   Phase C); **quarantine strip** in `Install Companion.command`; SSL env already persisted in the plist
   + certifi installed by the installer; audio backend = **torchaudio** (pinned, no soundfile needed);
   live-health device lock relaxed to accept `{mps,cpu}` across the 3 gate scripts + `_device_policy`
   note in `companion_profile.json`. Full gate ALL GREEN.
2. **Preservation harness** *(before any engine change)*: reference corpus + parity test + CI gate.
3. **Phase L — Legal/product gate**: hosted scope = **user-provided files only**; DMCA agent,
   ephemeral no-store, ToS/privacy blueprint. Attorney review before public launch.
4. **Phase A — Hosted engine MVP**: Demucs on **Modal / NVIDIA L4**; HTTPS, auth/token, rate-limit,
   ephemeral no-store, mirror the existing `POST /v1/stems/split` contract; queue + free-tier limits.
5. **Phase B — Extension hybrid routing + UX**: configurable base URL, engine resolver, engine chip
   (Cloud/Local/Basic), privacy disclosure, graceful fallback. **Includes the PNA/CORS fix (do first).**
6. **Phase C — macOS on-device packaging**: `python-build-standalone` + vendored wheels;
   deep-sign + notarize + staple; launch-on-demand LaunchAgent; **3 artifacts** (mac-x86_64,
   mac-arm64, win-x64 — no Universal2); Sparkle 2.x auto-update.
7. **Phase D — Windows on-device packaging**: `python-build-standalone`; **pystray tray supervisor +
   HKCU Run key** (no admin, auto-restart); Azure Trusted Signing; Velopack installer + delta;
   CUDA→DirectML→CPU device ladder; `%LOCALAPPDATA%` state dir, `longPathAware` manifest, `PYTHONUTF8`.
   Generalize the anti-drift lock/health contract cross-platform.
8. **Phase E — Distribution, updates, telemetry**: signed installers on CDN; Sparkle/Velopack delta
   updates; extension⇄API⇄companion version handshake; structured error codes + opt-in telemetry;
   Chrome Web Store submission packet.

---

## 5. Research-backed decisions (R1–R7)

| # | Question | Decision |
|---|---|---|
| **R1** | Chrome MV3 ↔ localhost | PNA **applies** → companion must send `Access-Control-Allow-Private-Network: true` + CORS preflight; `host_permissions` for loopback. **Latent regression → fix now.** |
| **R2** | Packaging / signing / update | **python-build-standalone + vendored wheels** (beats PyInstaller/Nuitka/Briefcase/conda). macOS: Hardened-Runtime entitlements + deep-sign + `notarytool` + `stapler` + **Sparkle 2.x**. Windows: **Azure Trusted Signing** ($9.99/mo) + **Velopack** delta. |
| **R3** | Legal / compliance | Hosted = **user-picked files only**; tab-**recorded** audio stays **on-device** — now a routing gate, not a separate feature (live tab isolation was removed 2026-08-05). DMCA agent ($6), ephemeral 12–24 h purge, "I own rights" checkbox, anti-training guarantee, no-curation. Attorney for final ToS. |
| **R4** | Hosted GPU cost | **Modal on L4** for MVP (~$0.0022/sep, ~10 s, scale-to-zero, best DX). Self-host break-even ≈ **225k sep/mo**. Free (rate-limited, cold) vs Paid (`keep_warm=1`). |
| **R5** | Windows helper | **pystray tray supervisor + HKCU Run** (no admin, exceptional crash-restart, lowest AV risk). CUDA→DirectML→CPU with test-tensor validation. `%LOCALAPPDATA%`, `PYTHONUTF8`, `longPathAware`. |
| **R6** | Relocatable runtime | python-build-standalone runs on **old Intel Airs (macOS 10.15/11+, CPU)**. **No Universal2** → per-arch builds. Install wheels **directly** into standalone `site-packages` (no `venv`); prune ~200 MB. |
| **R7** | Chrome Web Store | **Approvable.** Explicit `host_permissions` (never `<all_urls>`), data-only fetch (`json()`/`arrayBuffer()`, no `eval`), Cloud/Local toggle, reviewer packet (installer + creds + ≤30 s screencast). Loopback ⇒ **3–7 business-day** manual review. |

**Full research docs (Google Drive):**
[R1](https://docs.google.com/document/d/1EcKFHlgN0AmTZC61y6qVDoiFzC8OKoNSpa4282PRsNg/edit) ·
[R2](https://docs.google.com/document/d/1mWI5S8MLP7i5fZc94eoWDEHqw-g953JNaw2_4FZCnzg/edit) ·
[R3](https://docs.google.com/document/d/15GbMBb_GYL7TgjvteYp3DzW-zM8cTCeg351DAIXbGHM/edit) ·
[R4](https://docs.google.com/document/d/1fSp-aPhZPwmGWG1TQnCK7YP6Emo0XhEevChIVkGOv-Y/edit) ·
[R5](https://docs.google.com/document/d/1XTPYaLAFhSJ0UiFanBr-aPKpG7Rh8J5pvzIH94a_L58/edit) ·
[R6](https://docs.google.com/document/d/15FZdea1aGl3YcSBFQtDgdR4BwvTtJLFbkEi4IktazEo/edit) ·
[R7](https://docs.google.com/document/d/1hyr7svX1NngJkp9GLAZYjBHlaGTPdDUac_0cGw4Urzw/edit)

---

## 6. Roadblock & edge-case matrix (condensed)

- **Extension ↔ local:** PNA/CORS preflight (above); port-collision discovery + health token;
  per-browser native-messaging manifests (fallback only); Safari/Firefox out of MVP.
- **macOS friction:** Gatekeeper quarantine → notarize/staple; login-item notice; bind `127.0.0.1`
  to avoid the firewall prompt; MPS 12.3+ floor → CPU/cloud fallback; ship native arm64 (no Rosetta);
  keep off iCloud-synced folders (`doctor.sh` dataless check).
- **Windows friction:** SmartScreen reputation (Azure Trusted Signing); OneDrive Known-Folder-Move →
  `%LOCALAPPDATA%`; non-ASCII usernames + `MAX_PATH` → `PYTHONUTF8`/`longPathAware`/8.3 fallback;
  tray supervisor + HKCU Run (no admin); CUDA/DirectML/CPU detect; prefer a runtime **directory**
  over onefile (AV false-positives).
- **Resources:** disk/RAM preflight; battery/thermal → prefer cloud; cold-start pre-warm + progress;
  hosted queue + per-user rate limit.
- **Network:** corp proxy/TLS interception → bundle certifi, honor proxy env; offline → bundled-model
  option + Basic DSP fallback; metered → compress uploads + warn.
- **Versioning:** 3-way handshake (extension ⇄ hosted `api_version` ⇄ local `/v1/health`); kills the
  re-AirDrop tax.
- **Support:** structured error codes (E-###) as friendly text + "Copy diagnostics"; opt-in telemetry.

---

## 7. Zero-stress UX spec

Default works with **zero install**; never show a terminal; **one** primary action; progressive
disclosure; always a graceful fallback; plain language (no venv/launchd/MPS); visible progress;
trust signals (signed, private).

- **Engine chip:** "Cloud engine — ready" · "Local engine — ready (private, on-device)" ·
  "Working… ~Xs" · "Basic mode (offline)" with a subtle *why?* · "Couldn't reach engine — Retry /
  Use Basic" (1-click).
- **Opt-in local install (the "few clicks"):** Advanced → "Install Local Engine (private & offline)"
  → one signed installer → live checklist (Downloading/Installing/Verifying/Ready) → auto self-test →
  chip flips to Local; failure → 1-click "Use Cloud instead" + "Copy diagnostics". Repair + Uninstall
  in the same panel.
- **Accessibility:** keyboard nav, screen-reader labels, status never color-only.

---

## 8. Cross-platform compatibility + adaptive preflight

Never assume specs. A preflight self-test reports OS+version, arch, RAM, free disk, GPU
(mps/cuda/directml/none), network+proxy, browser+channel, existing companion+version, folder-sync
risk → chooses device/bundle, warns on low disk/RAM/battery, or recommends cloud.

**Coverage:** Apple Silicon (new+old macOS), Intel Mac (CPU), Windows 10/11 (cuda/directml/cpu).
Linux out of MVP (keep server cross-platform for a future community build). **Golden matrix** (CI +
real HW): + "no Python", "Python 3.13 only", "corp proxy", "OneDrive-redirected home", "low disk".
Success = zero terminal, cloud instant, local in a few clicks, survives reboot, stems generate, gate green.

---

## 9. Final concerns & resolutions

- **A. Flagship vs hosted — DISSOLVED (2026-08-05).** This was the plan's biggest tension: the
  legally-mandatory local flagship ("isolate what's playing") vs the zero-install cloud default.
  That feature was **removed**, so the tension is gone and the local engine is **no longer
  mandatory**. The only residue is a **routing gate** (§3): cloud separates **user-picked files**;
  a **tab-recorded** buffer (`Load Last Recording` → stems) separates **on-device** or is blocked
  from cloud. Don't market cloud separation of streaming/tab audio.
- **B. All-in hosted cost > GPU compute.** $0.0022/sep is GPU only; add gateway + queue + storage +
  egress + domain (~$20–60/mo fixed floor at MVP). Egress on 10–40 MB stems can dominate →
  **use Cloudflare R2 (zero egress)** for stem delivery; small gateway or Modal web endpoint.
- **C. `torch-directml` vs `torch==2.2.2` (Windows).** DirectML pins exact torch versions and may not
  support 2.2.2. **Resolution:** Windows gets its own platform-specific torch pin
  (`windows requirements.lock`) matching an available DirectML build; macOS 8-field lock stays
  canonical. **Phase-D spike:** verify early; if too painful, AMD/Intel Windows = CPU, NVIDIA = CUDA.
- **D. Real-hardware CI ownership.** GH Actions covers mac(arm+intel)+Win build/sign/smoke but not
  GPU/DirectML/old-OS. **Resolution:** automate cloud CI; keep a small personal device lab for
  GPU/old-OS runs per release from a documented checklist; accept manual GPU verification at MVP.
- **E. Legal counsel + model license.** Attorney reviews ToS/privacy before public launch; **confirm
  htdemucs weights permit commercial hosted + bundled redistribution** (Demucs code MIT; weights
  believed MIT — verify before monetizing).
- **F. Business model (open).** Recommended default: Free = cloud, ~3 jobs/day, scale-to-zero, uploads
  only; Local = unlimited/free/offline; Paid (later) = pre-warmed + higher limits + priority. Confirm
  pricing later; a generous free tier is affordable.
- **G. PNA fix safety.** Add the OPTIONS handler + headers additively (reflect only the extension-origin
  allowlist; no broad CORS middleware); run the gate + test both isolation modes in Chrome before/after.
  Highest priority — it protects the existing engine.

---

## 10. Immediate next actions (recommended)

1. ✅ **Output-parity harness + CI gate** — DONE (`checkpoints/parity/`, byte-identical golden;
   wired into `make_checkpoint.sh`).
2. ✅ **PNA/CORS OPTIONS handler** — DONE & verified (server.py preflight; reflects the
   `chrome-extension://` origin). `manifest.json` loopback is covered by the broad
   `http://*/*` grant — **tighten to explicit origins at store-publish (R7/Phase E)**.
3. ✅ **Phase 0 macOS stabilize** — DONE (device auto-detect + arch log, quarantine strip, SSL/certifi
   + torchaudio confirmed bundled, live-health lock relaxed to `{mps,cpu}`). Gate ALL GREEN, checkpoint banked.
4. **Open accounts:** Apple Developer, Azure Trusted Signing ($9.99/mo), DMCA agent ($6).
5. **Phase-D DirectML/torch spike** to de-risk the Windows pin conflict early.
6. *(Optional, deferred)* physically delete the ~2 000 dormant isolation lines + migrate
   `verify_voice_isolation_lock.sh` guards to a stem-separation lock — only on request; higher risk,
   own checkpoint.

---

## 11. Still open

- Exact free/paid limits & pricing (Concern F).
- PNA `allow-origin` allowlist strategy (unpacked-dev id vs Web Store id).
- Confirm htdemucs weight commercial license (Concern E).
- Who owns/runs the per-release real-hardware matrix (Concern D).
