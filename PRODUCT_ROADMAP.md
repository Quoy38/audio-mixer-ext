# Product Roadmap

Updated: 2026-09-04

This document summarizes the current product state and the work remaining before a broad public launch. `AGENTS.md` remains authoritative for runtime invariants, fragile code, and validation requirements.

## Product Direction

The product is evolving into a creator-first sample and stem studio:

> Capture or load audio, shape it, trim it, split it, and export usable material.

Primary audience: producers, remixers, and sample-based creators.

Secondary audience: music listeners interested in sound transformation.

Brand direction: creative, precise, premium, soulful, and personal. The visual system should combine modern sampling-hardware discipline with music-editorial energy while refining the existing gel-frame character.

## Decisions

- Voice Isolation remains removed from the UI and dormant in code.
- Stem Separation is the only shipping AI feature.
- The macOS Local companion remains free, unlimited, private, offline, and accountless.
- Cloud Separation will provide Windows and ChromeOS access, with limited free usage and a paid Stripe subscription.
- Google sign-in will be required only for Cloud features.
- Cloud processing may accept uploaded files and tab recordings only after explicit rights confirmation.
- Advertising means external marketing campaigns, not ads inside the extension.
- A private Mac beta comes before the broad cross-platform launch.
- Final naming and identity should precede public Cloud domains, OAuth branding, billing descriptors, and store materials.

## Completed And Verified

### Core Product

- Chrome MV3 extension with Capture & Edit, FX & Shapes, and AI & Stems workflows.
- Browser audio capture, recording, playback transport, effects, presets, and exports.
- Four-source Stem Separation: vocals, drums, bass, and other.
- Stem audition, gain/mute controls, cleanup controls, individual downloads, and stem-mix export.
- Session restoration through offscreen state and IndexedDB.

### macOS Local Companion

- Self-contained Intel and Apple Silicon runtimes.
- Signed, notarized, and stapled `.pkg` installers for both architectures.
- Successful installation and Stem Separation tests on Intel and Apple Silicon hardware.
- Public GitHub `v1.0.0` release with both installers and checksums.
- Direct Apple Silicon and Intel download links in the extension.
- LaunchAgent startup, health checks, restart recovery, dependency lock, profile lock, and model integrity checks.

### Functional Polish Verified 2026-09-04

- Loaded and restored audio automatically opens the Recorded Playback and Waveform sections.
- UI terminology now uses `Waveform`, not `Wavetable`.
- Trim remains non-destructive while controlling playback, processed export, Stem Separation input, individual stem downloads, and stem-mix downloads.
- Stem Separation sends only the selected range to both Kuielab and the companion.
- Generated stems remain aligned with the source timeline for audition.
- Changing trim cancels in-flight generation and invalidates stale stems.
- A loaded last recording changes the Recording export to `Download Trimmed WAV` when a partial range is selected.
- Trimmed Recording WAV export was manually verified at the selected duration.
- Trimmed Stem Separation was manually verified end to end.
- Nonzero-pitch recording waits for the Signalsmith processor instead of silently recording without pitch.
- Processed WAV export now inserts Signalsmith for nonzero pitch.
- Recording and export shaping checks passed in Chrome.

### Distribution And Validation

- Public GitHub source repository and release assets.
- Popup syntax, diagnostics, whitespace checks, 16 isolation guards, companion doctor, launchd smoke test, and 22-field profile drift check are green.
- Full automated release gate is green.

## Remaining Work

### 1. Brand Identity

- Write the final creator-first positioning statement and messaging hierarchy.
- Generate an ownable master-name shortlist with the descriptor `Sample & Stem Studio`.
- Screen candidate names across domains, Chrome Web Store, GitHub, social handles, common-law use, USPTO, and WIPO.
- Obtain qualified trademark guidance before commitment.
- Create the wordmark, symbol, extension/store icons, typography, color, motion, voice, installer naming, and campaign system.
- Avoid imitation of reference brands or their recognizable trade dress.

### 2. Test Automation And UX Cohesion

- Add deterministic audio golden tests for trim duration, speed, pitch, gain, spectrum, clipping, stem alignment, and live/export parity.
- Add Playwright workflow tests for loading, waveform behavior, trimming, stem invalidation, restoration, and downloads.
- Add visual-regression screenshots for popup and side panel, light/dark themes, and empty/loading/success/error states.
- Add `axe-core` checks plus manual VoiceOver and keyboard testing.
- Add failure-injection tests: companion offline/restarting, cancellation, popup closure, low disk, corrupt files, short/long/mono audio, and repeated actions.
- Clarify output language throughout the UI: Source Audio, Edited Mix, Stem Mix, and Individual Stems.

### 3. Accessibility, Onboarding, And Support

- Verify WCAG 2.1 AA contrast, focus, keyboard flow, text scaling, and screen-reader behavior.
- Add live status announcements and reduced-motion support.
- Add concise first-run guidance and clearer architecture/install help.
- Add structured error codes and copyable diagnostics.
- Establish a support email or alias, issue templates, FAQ, and beta feedback form.

### 4. Private Mac Beta

- Prepare a branded signup/screener, test checklist, feedback survey, privacy notice, and beta expectations.
- Start with 3-5 trusted creators, then recruit 7-20 more through direct contacts, studios, music programs, and producer communities with moderator permission.
- Test both Intel and Apple Silicon.
- Target at least 90% installer completion and 90% first-separation success.
- Track time to first stems, editing/export fidelity, quality ratings, architecture/OS, and recurring confusion points.

### 5. Privacy, Rights, And Legal

- Publish a privacy policy and Chrome Web Store data-use disclosure for the current Local product.
- Decide the public repository licensing posture.
- Add third-party notices for models, libraries, fonts, and other redistributed assets.
- Draft Cloud Terms, acceptable-use rules, subscription/refund/cancellation terms, retention/deletion policy, anti-training promise, and rights confirmation.
- Obtain qualified legal review before public Cloud processing.

### 6. Cloud Stem Separation

- Track loaded-audio provenance as file, tab recording, or unknown.
- Define an asynchronous hosted API for authenticated jobs, signed uploads, queue/progress, cancellation, deletion, quota reporting, and signed stem downloads.
- Benchmark representative 1, 3, 5, and 10-minute files before choosing pricing and providers.
- Deploy GPU Demucs workers with the same output contract and parity checks as Local.
- Add secure object storage, short retention, automatic cleanup verification, rate limits, concurrency limits, idempotency, timeouts, retries, and abuse controls.
- Add staging/production separation, secrets management, budgets, alerts, metrics, incident response, rollback, and status monitoring.

### 7. Accounts, Billing, And Entitlements

- Implement Google sign-in for Cloud only.
- Add users, jobs, usage ledger, plans, entitlements, consent versions, and retention timestamps.
- Integrate Stripe Checkout and Customer Portal.
- Treat signed Stripe webhooks as the billing source of truth.
- Enforce quotas atomically on the server.
- Test renewals, cancellation, failed-payment grace, refunds, plan changes, webhook replay, duplicate jobs, and concurrent quota usage.

### 8. Hybrid Extension Integration

- Add an engine resolver around Stem Separation without touching dormant Voice Isolation.
- Prefer Local when selected and healthy; otherwise offer Cloud.
- Require sign-in and explicit rights confirmation before any upload.
- Never silently upload audio or silently downgrade quality.
- Add durable upload/progress/cancel/retry/download behavior that survives popup lifetime where needed.
- Add Local/Cloud privacy labels, quota/subscription/account controls, billing portal, deletion, policy/support links, feature flags, and structured errors.
- Add extension, Local companion, and Cloud API version negotiation.
- Update Local-specific `no cloud/no subscription` messaging so it does not misrepresent the hybrid product.

### 9. Chrome Web Store Readiness

- Create an allowlisted, reproducible extension ZIP builder.
- Include required ignored `models/` and `libs/` files with verified hashes and licenses.
- Exclude runtimes, installers, secrets, logs, checkpoints, and development-only files.
- Minimize and justify manifest permissions and broad host/content-script scopes.
- Add only the final Cloud origin and verify that no remote executable code is used.
- Prepare final descriptions, screenshots/video, privacy answers, permission justifications, support/policy URLs, reviewer credentials, and Local/Cloud testing instructions.
- Test clean release candidates on Intel Mac, Apple Silicon, Windows Chrome, and ChromeOS.

### 10. Release Engineering

- Add CI for JavaScript syntax, Python compilation, static isolation locks, package integrity, secret scanning, dependency/license checks, hosted parity, API integration, and Stripe webhook tests.
- Add companion update discovery and minimum-version messaging.
- Keep signed rollback artifacts and use staged public rollouts.
- Build a native Windows companion later for private, offline, unlimited processing; Cloud provides initial Windows and ChromeOS availability.

## Immediate Next Sequence

1. Commit and checkpoint the verified functional-polish changes.
2. Build the deterministic audio golden-test harness.
3. Add Playwright visual/workflow tests and accessibility checks.
4. Produce and screen the brand-name shortlist.
5. Refine the UI hierarchy and output language using the selected brand direction.
6. Prepare and recruit the private Mac beta.
7. Begin privacy/legal work and the Cloud economics/API specification in parallel.

## Validation Before Every Release

Run from the repository root:

```sh
node --check popup/popup.js
python3 -m py_compile companion_app/server.py
bash checkpoints/verify_voice_isolation_lock.sh
bash checkpoints/check_profile_drift.sh
bash companion_app/doctor.sh
bash checkpoints/release_gate.sh
```

After automated checks, complete the release gate's manual transport/preset signoffs and the current product-specific Chrome test checklist.
