let originalVolumes = new WeakMap();
let isMuted = false;
let wasPlayingBeforePause = new WeakMap();
let isPausedForIsolation = false;
let desiredPlaybackRate = 1;
let mediaObserver = null;
// State for chunked buffer download (DOWNLOAD_BUFFER_BEGIN/CHUNK/FINALIZE)
let _bufDl = null;

// YouTube Music Repeat-One hold. Engaging YT's OWN repeat mode makes YT loop the
// SAME track at its true end with no gapless boundary race (there is no next track
// to auto-advance to). We remember the user's original repeat mode and restore it
// when isolation stops. `engaged` is reported back so the popup knows whether it
// still needs its seek-loop fallback.
let _repeatHoldActive = false;
let _savedRepeatLabel = null;

// --- Lifecycle diagnostics (logging only, no behavior change) ----------------
// Attaches once-per-element listeners so the YouTube Music TAB console shows the
// EXACT moment YT swaps/tears-down a media element (the autoplay-advance / MSE
// teardown that breaks the prepared-instrumental loop). Look for [Audio Mixer][LC].
const _lcAttached = new WeakSet();
function _lcStamp(el) {
  const dur = Number.isFinite(el.duration) ? el.duration.toFixed(2) : "?";
  const ct = Number.isFinite(el.currentTime) ? el.currentTime.toFixed(2) : "?";
  return `tag=${el.tagName[0]} dur=${dur} ct=${ct} paused=${el.paused} ended=${el.ended} @+${Date.now() - _contextBootEpochMs}ms`;
}
function _attachLifecycleDiag() {
  const els = document.querySelectorAll("video, audio");
  for (const el of els) {
    if (_lcAttached.has(el)) {
      continue;
    }
    _lcAttached.add(el);
    for (const evt of ["loadstart", "loadedmetadata", "durationchange", "emptied", "ended", "play", "pause", "seeking", "seeked"]) {
      el.addEventListener(evt, () => {
        console.log(`[Audio Mixer][LC] ${evt} ${_lcStamp(el)} nEls=${document.querySelectorAll("video, audio").length}`);
      });
    }
  }
}

// Cache the native HTMLMediaElement volume accessor from the prototype. In Chrome's
// MV3 isolated content-script world, calling these bindings directly goes through
// the IDL → C++ path and updates the browser's real audio state, regardless of any
// JavaScript-level property overrides. Using the prototype explicitly also prevents
// any page-world shadowing from intercepting the call.
const _volumeProto = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
const _nativeGetVolume = _volumeProto?.get;
const _nativeSetVolume = _volumeProto?.set;
const _volumeLockHandlers = new WeakMap();

// Dataset keys stored on each media element so any re-injected content-script
// context can read the lock state and the TRUE pre-mute volume, even after the
// original context that saved originalVolumes (a WeakMap) has been invalidated.
const _MUTE_LOCK_ATTR = "_amxVolLock"; // presence means element is locked at 0
const _MUTE_ORIG_ATTR = "_amxOrigVol"; // original volume before first mute
const _PAUSE_LOCK_ATTR = "_amxPauseLock"; // presence means isolation pause lock is intended
const _PAUSE_ORIG_PLAYING_ATTR = "_amxPauseOrigPlaying"; // whether media was playing before pause lock
const _CONTINUITY_VERSION = 1;

let _contextBootEpochMs = Date.now();
let _lastRehydrateEpochMs = _contextBootEpochMs;
let _lockMuteRehydrated = false;
let _lockPauseRehydrated = false;
let _continuityReason = "CONTINUITY_OK";

function _setContinuityReason(reason) {
  _continuityReason = reason;
}

function _hasPauseLockInDom() {
  return Array.from(document.querySelectorAll("video, audio"))
    .some((el) => Boolean(el.dataset[_PAUSE_LOCK_ATTR]));
}

function _buildContinuitySnapshot() {
  const lockMuteIntended = isMuted || Array.from(document.querySelectorAll("video, audio"))
    .some((el) => Boolean(el.dataset[_MUTE_LOCK_ATTR]));
  const lockPauseIntended = isPausedForIsolation || _hasPauseLockInDom();
  const observerReady = Boolean(mediaObserver);
  const controlReady = observerReady && _lockMuteRehydrated && _lockPauseRehydrated;
  let continuityReason = _continuityReason;
  if (!observerReady) {
    continuityReason = "CONTINUITY_OBSERVER_NOT_READY";
  } else if (!_lockMuteRehydrated) {
    continuityReason = "CONTINUITY_MUTE_NOT_REHYDRATED";
  } else if (!_lockPauseRehydrated) {
    continuityReason = "CONTINUITY_PAUSE_NOT_REHYDRATED";
  }
  return {
    continuityVersion: _CONTINUITY_VERSION,
    lockMuteIntended,
    lockPauseIntended,
    lockMuteRehydrated: _lockMuteRehydrated,
    lockPauseRehydrated: _lockPauseRehydrated,
    contextBootEpochMs: _contextBootEpochMs,
    lastRehydrateEpochMs: _lastRehydrateEpochMs,
    controlReady,
    continuityReason: controlReady ? "CONTINUITY_OK" : continuityReason
  };
}

function _getVol(el) {
  return _nativeGetVolume ? _nativeGetVolume.call(el) : el.volume;
}

function _setVol(el, val) {
  if (_nativeSetVolume) {
    _nativeSetVolume.call(el, val);
  } else {
    el.volume = val;
  }
}

function getPrimaryMediaElement() {
  const mediaElements = Array.from(document.querySelectorAll("video, audio"));
  if (!mediaElements.length) {
    return null;
  }

  const hasRealDuration = (el) => Number.isFinite(el.duration) && el.duration > 0;

  // Prefer a real, LOADED element (duration > 0). YouTube Music keeps extra
  // <video>/<audio> nodes around (ad slot, player rebuilds). An empty element
  // (duration 0, currentTime 0) can report paused=false, and the previous
  // "first non-paused element" rule would pick that phantom — making the entire
  // page timeline read as frozen at 0:00 (ct=0/dur=0). That broke the prepared
  // instrumental sync loop: it could never detect end-of-track, and drift
  // correction kept yanking the buffer back to 0 (the "first second on repeat").
  // Among real elements, prefer the one actually playing, else the longest one.
  const realElements = mediaElements.filter(hasRealDuration);
  if (realElements.length) {
    return realElements.find((el) => !el.paused && !el.ended)
      || realElements.slice().sort((a, b) => b.duration - a.duration)[0];
  }

  // No element has a usable duration yet — fall back to any playing element,
  // then the first element.
  return mediaElements.find((el) => !el.paused && !el.ended)
    || mediaElements[0]
    || null;
}

function setPlaybackRate(playbackRate, preservePitch = true) {
  desiredPlaybackRate = playbackRate;
  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    el.playbackRate = playbackRate;
    el.defaultPlaybackRate = playbackRate;
    if ("preservesPitch" in el) {
      el.preservesPitch = preservePitch;
    }
    if ("mozPreservesPitch" in el) {
      el.mozPreservesPitch = preservePitch;
    }
    if ("webkitPreservesPitch" in el) {
      el.webkitPreservesPitch = preservePitch;
    }
  }
}

function _resyncMuteFromDom() {
  // Called on module load and inside the MutationObserver to recover mute state
  // after a content-script context re-injection.  When the script context is
  // invalidated (e.g. YT Music soft-navigates during the processing loop), the
  // new context starts with isMuted=false even though _MUTE_LOCK_ATTR is still
  // set on every media element.  Without this re-sync, the first DOM mutation
  // (player rebuild on seek/play) would leave new <video> elements unsilenced.
  if (isMuted) {
    _lockMuteRehydrated = true;
    _lastRehydrateEpochMs = Date.now();
    return;
  }
  const shouldBeMuted = Array.from(document.querySelectorAll("video, audio"))
    .some((el) => Boolean(el.dataset[_MUTE_LOCK_ATTR]));
  if (shouldBeMuted) {
    // muteOriginalMedia will read _MUTE_ORIG_ATTR for elements whose volume is
    // already 0, so the saved original volume is preserved correctly.
    muteOriginalMedia();
    _setContinuityReason("CONTINUITY_CONTEXT_REINJECTED");
  }
  _lockMuteRehydrated = true;
  _lastRehydrateEpochMs = Date.now();
}

function _resyncPauseFromDom() {
  const shouldBePaused = _hasPauseLockInDom();
  if (!shouldBePaused) {
    _lockPauseRehydrated = true;
    _lastRehydrateEpochMs = Date.now();
    return;
  }

  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    const shouldResume = el.dataset[_PAUSE_ORIG_PLAYING_ATTR] === "1";
    wasPlayingBeforePause.set(el, shouldResume);
    if (!el.paused) {
      el.pause();
    }
  }
  isPausedForIsolation = true;
  _lockPauseRehydrated = true;
  _lastRehydrateEpochMs = Date.now();
  _setContinuityReason("CONTINUITY_CONTEXT_REINJECTED");
}

function ensureObserver() {
  if (mediaObserver) {
    return;
  }

  mediaObserver = new MutationObserver(() => {
    setPlaybackRate(desiredPlaybackRate);
    _attachLifecycleDiag();
    // Always try to re-sync first — this is a no-op when isMuted is already
    // true, but recovers gracefully when the context was re-injected.
    _resyncMuteFromDom();
    _resyncPauseFromDom();
    if (isMuted) {
      muteOriginalMedia();
    }
    if (isPausedForIsolation) {
      pauseOriginalMedia();
    }
  });

  mediaObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

// --- YouTube Music Repeat-One control ---------------------------------------
// The repeat toggle lives in the player bar (shadow DOM) and carries class
// `.repeat`; its aria-label/title reflects the CURRENT mode ("Repeat off" ->
// "Repeat all" -> "Repeat one", cycled per click). We only ever act on a control
// whose accessible label mentions "repeat", so we never click an unrelated
// element (the mistake that broke a previous attempt).
function _repeatCtrlLabel(el) {
  return String((el && (el.getAttribute("aria-label") || el.getAttribute("title"))) || "").toLowerCase();
}

function _findRepeatControl() {
  const { element } = querySelectorDeep([
    "ytmusic-player-bar #right-controls yt-icon-button.repeat",
    "ytmusic-player-bar #right-controls tp-yt-paper-icon-button.repeat",
    "ytmusic-player-bar yt-icon-button.repeat",
    "ytmusic-player-bar tp-yt-paper-icon-button.repeat",
    "ytmusic-player-bar .repeat",
    "yt-icon-button.repeat",
    "tp-yt-paper-icon-button.repeat"
  ]);
  return element || null;
}

// Click the repeat toggle (off -> all -> one -> off) until `predicate(label)` is
// satisfied. Re-resolves the control each iteration (YT rebuilds the player bar)
// and caps at a full cycle so we never spin. Returns { ok }.
async function _cycleRepeatUntil(predicate, maxClicks = 3) {
  let btn = _findRepeatControl();
  if (!btn) {
    return { ok: false, reason: "not-found" };
  }
  for (let i = 0; i <= maxClicks; i += 1) {
    btn = _findRepeatControl() || btn;
    if (predicate(_repeatCtrlLabel(btn))) {
      return { ok: true };
    }
    try { btn.click(); } catch (_e) { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: predicate(_repeatCtrlLabel(_findRepeatControl() || btn)) };
}

async function enableRepeatOne() {
  const btn = _findRepeatControl();
  if (!btn) {
    console.warn("[Audio Mixer] Repeat control not found — popup will fall back to the safe seek-loop.");
    return { engaged: false, reason: "not-found" };
  }
  if (!_repeatHoldActive) {
    _savedRepeatLabel = _repeatCtrlLabel(btn);
  }
  _repeatHoldActive = true;
  const res = await _cycleRepeatUntil((label) => label.includes("one"));
  console.log("[Audio Mixer] Repeat-One", res.ok ? "ENGAGED" : "could NOT be confirmed",
    "(will restore:", _savedRepeatLabel || "unknown", ")");
  return { engaged: res.ok };
}

async function restoreRepeatMode() {
  if (!_repeatHoldActive) {
    return { restored: true };
  }
  _repeatHoldActive = false;
  const target = _savedRepeatLabel;
  _savedRepeatLabel = null;
  if (!target) {
    return { restored: true };
  }
  const res = await _cycleRepeatUntil((label) => label === target);
  console.log("[Audio Mixer] Repeat mode restored to", JSON.stringify(target), res.ok ? "OK" : "(best-effort)");
  return { restored: res.ok };
}

function muteOriginalMedia() {
  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    if (!originalVolumes.has(el)) {
      // If this element already has a lock (set by a previous content-script
      // context that was later invalidated), el.volume is already 0 and does NOT
      // represent the user's real pre-mute volume. Read the persisted original
      // from the dataset instead, falling back to 1 if absent.
      const alreadyLocked = Boolean(el.dataset[_MUTE_LOCK_ATTR]);
      const currentVol = _getVol(el);
      if (alreadyLocked && currentVol === 0) {
        const stored = parseFloat(el.dataset[_MUTE_ORIG_ATTR]);
        originalVolumes.set(el, isFinite(stored) && stored > 0 ? stored : 1);
      } else {
        originalVolumes.set(el, currentVol);
        // Persist the real pre-mute volume so any future re-injection can read it.
        if (currentVol > 0) {
          el.dataset[_MUTE_ORIG_ATTR] = String(currentVol);
        }
      }
    }
    el.dataset[_MUTE_LOCK_ATTR] = "1";
    _setVol(el, 0);
    if (!_volumeLockHandlers.has(el)) {
      const handler = () => {
        if (el.dataset[_MUTE_LOCK_ATTR] && _getVol(el) !== 0) {
          _setVol(el, 0);
        }
      };
      el.addEventListener("volumechange", handler);
      _volumeLockHandlers.set(el, handler);
    }
  }
  isMuted = true;
  _lockMuteRehydrated = true;
  _lastRehydrateEpochMs = Date.now();
  console.log("[Audio Mixer] Muted", mediaElements.length, "media elements");
}

function unmuteOriginalMedia() {
  // Quick-exit: if we are not tracking a mute AND no element has our lock
  // attribute set (e.g. from a previous context), there is nothing to undo.
  // This makes it safe to broadcast UNMUTE_ORIGINAL_MEDIA to all tabs on
  // popup startup without briefly resetting volumes on unrelated tabs.
  const hasActiveLock = isMuted || Array.from(document.querySelectorAll("video, audio"))
    .some((el) => Boolean(el.dataset[_MUTE_LOCK_ATTR]));
  if (!hasActiveLock) {
    return;
  }

  // Clear both dataset attrs on EVERY media element on the page — not just the
  // ones in our WeakMap — so orphaned volumechange guards from previous contexts
  // become no-ops immediately, before we restore the volume.
  document.querySelectorAll("video, audio").forEach((el) => {
    delete el.dataset[_MUTE_LOCK_ATTR];
    delete el.dataset[_MUTE_ORIG_ATTR];
    delete el.dataset[_PAUSE_LOCK_ATTR];
    delete el.dataset[_PAUSE_ORIG_PLAYING_ATTR];
  });

  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    const handler = _volumeLockHandlers.get(el);
    if (handler) {
      el.removeEventListener("volumechange", handler);
      _volumeLockHandlers.delete(el);
    }
    const originalVolume = originalVolumes.get(el);
    _setVol(el, originalVolume !== undefined ? Math.max(0, Math.min(1, originalVolume)) : 1);
  }
  originalVolumes = new WeakMap();
  isMuted = false;
  // Clear isolation pause state on unmute so MutationObserver won't force-pause.
  isPausedForIsolation = false;
  wasPlayingBeforePause = new WeakMap();
  _lockMuteRehydrated = true;
  _lockPauseRehydrated = true;
  _lastRehydrateEpochMs = Date.now();
  console.log("[Audio Mixer] Unmuted", mediaElements.length, "media elements");
}

function pauseOriginalMedia() {
  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    if (!wasPlayingBeforePause.has(el)) {
      wasPlayingBeforePause.set(el, !el.paused && !el.ended);
    }
    if (!el.paused) {
      el.pause();
    }
    el.dataset[_PAUSE_LOCK_ATTR] = "1";
    el.dataset[_PAUSE_ORIG_PLAYING_ATTR] = wasPlayingBeforePause.get(el) ? "1" : "0";
  }
  isPausedForIsolation = true;
  _lockPauseRehydrated = true;
  _lastRehydrateEpochMs = Date.now();
  console.log("[Audio Mixer] Paused", mediaElements.length, "media elements");
}

function resumeOriginalMedia() {
  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    const shouldResume = wasPlayingBeforePause.get(el);
    if (shouldResume) {
      el.play().catch((e) => console.debug("[Audio Mixer] Resume play blocked:", e));
    }
    delete el.dataset[_PAUSE_LOCK_ATTR];
    delete el.dataset[_PAUSE_ORIG_PLAYING_ATTR];
  }
  wasPlayingBeforePause = new WeakMap();
  isPausedForIsolation = false;
  _lockPauseRehydrated = true;
  _lastRehydrateEpochMs = Date.now();
  console.log("[Audio Mixer] Resume requested for", mediaElements.length, "media elements");
}

function playOriginalMedia() {
  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    el.play().catch((e) => console.debug("[Audio Mixer] Play failed:", e));
    delete el.dataset[_PAUSE_LOCK_ATTR];
    delete el.dataset[_PAUSE_ORIG_PLAYING_ATTR];
  }
  isPausedForIsolation = false;
  _lockPauseRehydrated = true;
  _lastRehydrateEpochMs = Date.now();
  console.log("[Audio Mixer] Play requested for", mediaElements.length, "media elements");
  return { success: true, count: mediaElements.length, continuity: _buildContinuitySnapshot() };
}

function getMediaCurrentTime() {
  const primary = getPrimaryMediaElement();
  if (primary && Number.isFinite(primary.currentTime)) {
    return { success: true, currentTime: primary.currentTime };
  }

  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    if (Number.isFinite(el.currentTime)) {
      return { success: true, currentTime: el.currentTime };
    }
  }
  // Fallback: return 0 if no element with a valid time found.
  return { success: false, currentTime: 0 };
}

function getMediaState() {
  const primary = getPrimaryMediaElement();
  const _allMedia = Array.from(document.querySelectorAll("video, audio"));
  const _elInfo = _allMedia.map((el) => `${el.tagName[0]}:${Number.isFinite(el.duration) ? el.duration.toFixed(1) : "?"}@${Number.isFinite(el.currentTime) ? el.currentTime.toFixed(1) : "?"}${el.paused ? "P" : "p"}${el.ended ? "E" : ""}`).join(",");
  if (!primary) {
    return {
      success: false,
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
      playbackRate: 1,
      title: document.title || "",
      elInfo: _elInfo,
      csVersion: "picker-fix-2",
      continuity: _buildContinuitySnapshot()
    };
  }

  return {
    success: true,
    currentTime: Number.isFinite(primary.currentTime) ? primary.currentTime : 0,
    duration: Number.isFinite(primary.duration) ? primary.duration : 0,
    paused: Boolean(primary.paused),
    ended: Boolean(primary.ended),
    playbackRate: Number.isFinite(primary.playbackRate) ? primary.playbackRate : 1,
    title: document.title || "",
    elInfo: _elInfo,
    csVersion: "picker-fix-2",
    continuity: _buildContinuitySnapshot()
  };
}

function seekMediaToTime(targetTime, options = {}) {
  const t = Math.max(0, Number(targetTime) || 0);
  const { forceAtZero = false } = options;
  const mediaElements = document.querySelectorAll("video, audio");
  let changed = 0;

  for (const el of mediaElements) {
    if (!Number.isFinite(el.currentTime)) {
      continue;
    }
    // Non-zero target: skip if already within 50ms (avoids redundant seeks).
    if (t !== 0 && Math.abs(el.currentTime - t) < 0.05) {
      continue;
    }
    // Target is exactly 0: skip if the element is already paused at the start
    // (e.g. after our Demucs-phase hold). Only force-seek when the element is
    // actively playing at 0 (YT auto-advanced to a new song) or has ended, so
    // we don't trigger a YT Music media-reload that would briefly reset
    // el.volume to 1 before the MutationObserver can re-apply the mute lock.
    if (!forceAtZero && t === 0 && el.paused && !el.ended && el.currentTime < 0.05) {
      continue;
    }
    try {
      el.currentTime = t;
      changed += 1;
    } catch (_error) {
      // Some players may block seeks temporarily; ignore and continue.
    }
  }

  console.log("[Audio Mixer] Seeked media to", t.toFixed(2), "seconds on", changed, "elements");
  return { success: changed > 0, count: changed };
}

function rewindMediaBySeconds(seconds) {
  const rewindSeconds = Math.max(0, Number(seconds) || 0);
  if (rewindSeconds <= 0) {
    return { success: false, count: 0 };
  }

  const mediaElements = document.querySelectorAll("video, audio");
  let changed = 0;

  for (const el of mediaElements) {
    if (!Number.isFinite(el.currentTime)) {
      continue;
    }

    const nextTime = Math.max(0, el.currentTime - rewindSeconds);
    if (Math.abs(nextTime - el.currentTime) < 0.01) {
      continue;
    }

    try {
      el.currentTime = nextTime;
      changed += 1;
    } catch (_error) {
      // Some players may block seeks temporarily; ignore and continue.
    }
  }

  console.log("[Audio Mixer] Rewound media by", rewindSeconds.toFixed(2), "seconds on", changed, "elements");
  return { success: changed > 0, count: changed };
}

function querySelectorDeep(selectors) {
  const queue = [document.documentElement];
  while (queue.length > 0) {
    const root = queue.shift();
    if (!root) continue;

    for (const selector of selectors) {
      const found = root.querySelector?.(selector);
      if (found) return { element: found, selector };
    }

    const descendants = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of descendants) {
      if (el.shadowRoot) {
        queue.push(el.shadowRoot);
      }
    }
  }

  return { element: null, selector: "" };
}

function clickTrackControl(selectors, actionLabel) {
  const { element, selector } = querySelectorDeep(selectors);
  if (!element) {
    return { success: false, error: `${actionLabel} control not found` };
  }

  if (element.disabled || element.getAttribute("aria-disabled") === "true") {
    return { success: false, error: `${actionLabel} control is disabled` };
  }

  element.click();
  console.log(`[Audio Mixer] ${actionLabel} via selector:`, selector);
  return { success: true, method: "button", selector };
}

function restartCurrentTrack() {
  // Force a zero-seek here so restart never degrades into a no-op when the
  // player is paused at 0:00 from a transient lock state.
  const seekResult = seekMediaToTime(0, { forceAtZero: true });
  if (seekResult.success) {
    console.log("[Audio Mixer] Restarted current track via seek-to-zero across media elements");
    return {
      success: true,
      method: "seek",
      selector: "all-media",
      currentTime: 0,
      paused: false,
      ended: false,
      count: seekResult.count
    };
  }

  // As a fallback, many players restart current track via previous button when
  // currentTime is greater than a few seconds.
  return skipToPreviousTrack();
}

function getPlayPauseButton() {
  const { element } = querySelectorDeep([
    "ytmusic-player-bar #play-pause-button",
    "ytmusic-player-bar tp-yt-paper-icon-button.play-pause-button",
    "#play-pause-button",
    "tp-yt-paper-icon-button.play-pause-button",
    ".play-pause-button",
    "button[aria-label='Play']",
    "button[title='Play (k)']"
  ]);
  return element || null;
}

// Robustly restart the captured track from 0:00 and make sure it is actually
// playing again. YouTube Music streams via MSE and tears down the source buffer
// when a track ENDS, so a raw `el.currentTime = 0` + `el.play()` cannot resume
// an ended track — the timeline stays frozen at the end position (e.g. 0:34)
// even though the page reports a "play" request. To recover we:
//   1. force-seek every media element to 0 (clears the ended position),
//   2. clear any pause lock and call play() (handles the still-playing /
//      paused-mid-track case, where seek+play loops smoothly), and
//   3. if the primary element is still ended/paused (MSE torn down), click the
//      player's Play button so YT re-initiates playback from the start.
// We only click the button when it represents the "Play" action, so we never
// accidentally toggle a healthy playing track into pause.
// --- DO NOT EDIT casually — isolation loop invariant (see AGENTS.md "Fragile code"). ---
function restartAndPlayFromZero() {
  const primary = getPrimaryMediaElement();
  const wasEndedOrPaused = !primary || primary.ended || primary.paused;

  seekMediaToTime(0, { forceAtZero: true });

  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    delete el.dataset[_PAUSE_LOCK_ATTR];
    delete el.dataset[_PAUSE_ORIG_PLAYING_ATTR];
    try {
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch((e) => console.debug("[Audio Mixer] restart play blocked:", e));
      }
    } catch (_e) {
      // ignore — button fallback below handles it
    }
  }
  isPausedForIsolation = false;
  _lockPauseRehydrated = true;
  _lastRehydrateEpochMs = Date.now();

  // If the track had ended (MSE buffer gone), the raw play() above won't resume
  // it. Click YT Music's Play button to force a real replay from the start.
  let clickedButton = false;
  if (wasEndedOrPaused) {
    const btn = getPlayPauseButton();
    if (btn) {
      const label = (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").toLowerCase();
      if (!label.includes("pause")) {
        btn.click();
        clickedButton = true;
        console.log("[Audio Mixer] restartAndPlayFromZero: clicked Play button (label:", label + ")");
      }
    }
  }

  return { success: true, currentTime: 0, clickedButton, continuity: _buildContinuitySnapshot() };
}

function skipToNextTrack() {
  const candidateSelectors = [
    "ytmusic-player-bar tp-yt-paper-icon-button.next-button",
    "tp-yt-paper-icon-button.next-button",
    "button.next-button",
    ".next-button",
    "button[aria-label='Next song']",
    "button[aria-label='Next']",
    "button[title='Next (SHIFT+N)']",
    "button[title='Next (SHIFT+n)']",
    "[data-testid='control-button-skip-forward']"
  ];

  return clickTrackControl(candidateSelectors, "Skipped to next track");
}

function skipToPreviousTrack() {
  const candidateSelectors = [
    "ytmusic-player-bar tp-yt-paper-icon-button.previous-button",
    "tp-yt-paper-icon-button.previous-button",
    "button.previous-button",
    ".previous-button",
    "button[aria-label='Previous song']",
    "button[aria-label='Previous']",
    "button[title='Previous (SHIFT+P)']",
    "button[title='Previous (SHIFT+p)']",
    "[data-testid='control-button-skip-back']"
  ];

  return clickTrackControl(candidateSelectors, "Skipped to previous track");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SET_PLAYBACK_RATE") {
    const playbackRate = Number(message.payload?.playbackRate ?? 1);
    const preservePitch = Boolean(message.payload?.preservePitch ?? true);
    setPlaybackRate(playbackRate, preservePitch);
    sendResponse({ success: true });
  } else if (message?.type === "MUTE_ORIGINAL_MEDIA") {
    muteOriginalMedia();
    sendResponse({ success: true, continuity: _buildContinuitySnapshot() });
  } else if (message?.type === "UNMUTE_ORIGINAL_MEDIA") {
    unmuteOriginalMedia();
    sendResponse({ success: true, continuity: _buildContinuitySnapshot() });
  } else if (message?.type === "PAUSE_ORIGINAL_MEDIA") {
    pauseOriginalMedia();
    sendResponse({ success: true, continuity: _buildContinuitySnapshot() });
  } else if (message?.type === "RESUME_ORIGINAL_MEDIA") {
    resumeOriginalMedia();
    sendResponse({ success: true, continuity: _buildContinuitySnapshot() });
  } else if (message?.type === "PLAY_ORIGINAL_MEDIA") {
    sendResponse(playOriginalMedia());
  } else if (message?.type === "REWIND_MEDIA_SECONDS") {
    const seconds = Number(message.payload?.seconds ?? 0);
    sendResponse(rewindMediaBySeconds(seconds));
  } else if (message?.type === "RESTART_CURRENT_TRACK") {
    sendResponse(restartCurrentTrack());
  } else if (message?.type === "RESTART_AND_PLAY_FROM_ZERO") {
    sendResponse(restartAndPlayFromZero());
  } else if (message?.type === "SET_REPEAT_ONE") {
    const enable = Boolean(message?.payload?.enabled);
    (enable ? enableRepeatOne() : restoreRepeatMode())
      .then((result) => sendResponse(result))
      .catch(() => sendResponse(enable ? { engaged: false } : { restored: false }));
    return true; // keep the message channel open for the async repeat toggle
  } else if (message?.type === "SKIP_TO_PREVIOUS_TRACK") {
    sendResponse(skipToPreviousTrack());
  } else if (message?.type === "SKIP_TO_NEXT_TRACK") {
    sendResponse(skipToNextTrack());
  } else if (message?.type === "GET_MEDIA_CURRENT_TIME") {
    sendResponse(getMediaCurrentTime());
  } else if (message?.type === "GET_MEDIA_STATE") {
    sendResponse(getMediaState());
  } else if (message?.type === "SEEK_TO_TIME") {
    const targetTime = Number(message.payload?.time ?? 0);
    const forceAtZero = Boolean(message.payload?.forceAtZero ?? false);
    sendResponse(seekMediaToTime(targetTime, { forceAtZero }));
  } else if (message?.type === "DOWNLOAD_DATA_URL") {
    const url = String(message.payload?.url || "");
    const filename = String(message.payload?.filename || "audio-mixer-download.wav");
    if (!url) {
      sendResponse({ success: false, error: "Missing download URL" });
      return;
    }
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({ success: false, error: String(error?.message || error) });
    }
  } else if (message?.type === "DOWNLOAD_BUFFER_BEGIN") {
    // Start a chunked ArrayBuffer download. Avoids data-URL IPC size limits
    // and chrome.downloads.download() which closes the extension popup.
    _bufDl = {
      filename: String(message.payload?.filename || "audio-mixer-download.wav"),
      mimeType: String(message.payload?.mimeType || "audio/wav"),
      chunks: [],
      totalChunks: Number(message.payload?.totalChunks || 1)
    };
    sendResponse({ success: true });
  } else if (message?.type === "DOWNLOAD_BUFFER_CHUNK") {
    if (!_bufDl) {
      sendResponse({ success: false, error: "No download in progress" });
      return;
    }
    const buf = message.payload?.buffer;
    const idx = Number(message.payload?.index ?? _bufDl.chunks.length);
    if (buf) _bufDl.chunks[idx] = new Uint8Array(buf);
    sendResponse({ success: true });
  } else if (message?.type === "DOWNLOAD_BUFFER_FINALIZE") {
    if (!_bufDl) {
      sendResponse({ success: false, error: "No download in progress" });
      return;
    }
    try {
      const totalBytes = _bufDl.chunks.reduce((s, c) => s + (c ? c.length : 0), 0);
      const merged = new Uint8Array(totalBytes);
      let off = 0;
      for (const chunk of _bufDl.chunks) { if (chunk) { merged.set(chunk, off); off += chunk.length; } }
      const blob = new Blob([merged], { type: _bufDl.mimeType });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = _bufDl.filename;
      a.style.display = "none";
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
      _bufDl = null;
      sendResponse({ success: true });
    } catch (error) {
      _bufDl = null;
      sendResponse({ success: false, error: String(error?.message || error) });
    }
    return true; // keep channel open for async finalise
  } else if (message?.type === "toggleMediaPlayback") {
    const result = toggleBrowserMediaPlayback();
    sendResponse(result);
  }
});

function toggleBrowserMediaPlayback() {
  const mediaElements = document.querySelectorAll("video, audio");
  for (const el of mediaElements) {
    if (el.paused) {
      el.play().catch((e) => console.error("[Audio Mixer] Play failed:", e));
    } else {
      el.pause();
    }
  }
  console.log("[Audio Mixer] Toggled playback for", mediaElements.length, "media elements");
  return { success: true, count: mediaElements.length };
}

// Re-sync muted state from DOM before the observer starts, in case this
// injection is a recovery after the previous context was invalidated.
_resyncMuteFromDom();
_resyncPauseFromDom();
_attachLifecycleDiag();
ensureObserver();
