console.log("[Audio Mixer Popup] Script starting execution...");

window.addEventListener("error", (event) => {
  console.error("[Popup] Unhandled startup error:", event.error || event.message || event);
  const status = document.getElementById("status");
  if (status) {
    status.textContent = "Startup error (check popup console)";
  }
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[Popup] Unhandled promise rejection:", event.reason);
  const status = document.getElementById("status");
  if (status) {
    status.textContent = "Startup error (check popup console)";
  }
});

const DOWNLOAD_STRATEGY_VERSION = "v5-content-script-offscreen-fallback";
let warnedOffscreenUnavailable = false;

// ============= OFFSCREEN DOCUMENT INITIALIZATION =============
async function ensureOffscreenExists() {
  try {
    const offscreenUrl = chrome.runtime.getURL("offscreen/offscreen.html");
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    if (existingContexts.length > 0) {
      console.log("[Popup] Offscreen document already exists");
      return true;
    }

    if (chrome.offscreen?.createDocument) {
      await chrome.offscreen.createDocument({
        url: offscreenUrl,
        reasons: ["AUDIO_PLAYBACK"]
      });
    } else {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "ENSURE_OFFSCREEN" }, resolve);
      });
      if (!resp?.ok) {
        throw new Error(resp?.error || "background ENSURE_OFFSCREEN failed");
      }
    }

    console.log("[Popup] Offscreen document created");
    // Give offscreen time to initialize
    await new Promise(resolve => setTimeout(resolve, 500));
    return true;
  } catch (error) {
    const message = String(error?.message || error || "");
    if (message.toLowerCase().includes("offscreen api unavailable")) {
      if (!warnedOffscreenUnavailable) {
        console.warn("[Download] Offscreen unavailable in this runtime; using non-offscreen download paths");
        warnedOffscreenUnavailable = true;
      }
    } else {
      console.error("[Popup] Failed to ensure offscreen:", error);
    }
    return false;
  }
}

async function sendToOffscreen(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    console.log("[Popup] Offscreen response:", response);
    return response;
  } catch (error) {
    console.error("[Popup] Failed to send message to offscreen:", error);
    throw error;
  }
}

// ============= CONSTANTS & STATE =============
let stream = null;
let audioContext = null;
let inputSourceNode = null;
let filePlaybackSource = null;
let loadedAudioBuffer = null;
let rawCaptureDestination = null;
let outputDestinationConnected = false;

let bassNode = null;
let preGainNode = null;
let dryGainNode = null;
let wetGainNode = null;
let inputMixNode = null;
let currentFilterType = "lowshelf";
let activeFilterPreset = null;
let distortionNode = null;
let convolverNode = null;
let reverbGainNode = null;
let chorusDelayNode = null;
let chorusWetGainNode = null;
let chorusLfoNode = null;
let chorusLfoGainNode = null;
let ringModCarrierNode = null;
let ringModGainNode = null;
let delayNode = null;
let delayFeedbackNode = null;
let delayFilterNode = null;
let delayWetGainNode = null;
let pitchShifterNode = null;
let outputGainNode = null;
let reverbImpulseCacheKey = "";

// Live stem splitter nodes
let liveStemLowFilterNode = null;
let liveStemMidLowFilterNode = null;
let liveStemMidHighFilterNode = null;
let liveStemHighFilterNode = null;
let liveStemLowGainNode = null;
let liveStemMidGainNode = null;
let liveStemHighGainNode = null;
let liveStemMixerNode = null;
let liveStemMixingEnabled = false;

// Voice isolation state
let voiceIsolationEnabled = false;
let voiceIsolationProcessor = null;
let voiceIsolationModel = null;
let voiceIsolationStrength = 1;
let voiceIsolationMode = "vocals";
let voiceIsolationTogglePending = false;
let voiceProcessingDelay = 1.5;
let preparedInstrumentalPreparing = false;
let preparedInstrumentalActive = false;
let preparedInstrumentalPlaybackActive = false;
let preparedInstrumentalSessionId = 0;
let preparedInstrumentalSource = null;
let preparedInstrumentalBuffer = null;
let preparedInstrumentalPlaybackStartTime = null;
let preparedInstrumentalPlaybackStartOffset = 0;
let preparedInstrumentalPlaybackRate = 1;
let preparedInstrumentalSyncTimer = null;
let preparedInstrumentalSyncWatchdogTimer = null;
let preparedInstrumentalHardLoopTimer = null;
let preparedInstrumentalHardLoopBusy = false;
// Which stem the ACTIVE prepared full-track session isolates: "instrumental" or
// "vocals". Both dropdown options share the identical prepared order-of-operations;
// only the requested stem differs. Captured at session start; read by the download
// helper and button label so the saved file matches what is actually playing.
let preparedInstrumentalStemName = "instrumental";
let preparedInstrumentalTrackKey = "";
let preparedInstrumentalTrackTitle = "";
// Media time (seconds) at which the capture recorder actually started. Non-zero when
// YT Music needed buffering time before playback began. Used to align desiredOffset
// in the sync loop so buffer[0] maps to song[captureMediaTimeOffset], not song[0].
let preparedInstrumentalCaptureMediaTimeOffset = 0;
// True length (seconds) of the CAPTURED song, snapshotted at flow start before any
// playback. YouTube Music plays the whole queue gaplessly on ONE <video> element:
// once playback passes ~ct=26 it extends the element's live `duration` to the entire
// queue length (e.g. a 36s song reports duration=180) WITHOUT firing `ended` at the
// song boundary. Every loop-boundary decision (processing guardian, hard-loop
// enforcer, playback track-change detection) MUST use this snapshot — never the live
// page duration — or the restart threshold jumps to ~177s and the song silently runs
// on into the next track instead of looping. 0 = unknown.
let preparedInstrumentalSongDurationSeconds = 0;
// True when the content script confirmed YouTube's OWN "Repeat One" is engaged for
// the captured track. When true, YT loops the same song natively at its real end with
// no gapless boundary race, so the hard-loop enforcer's near-end seek is disabled
// (letting it fire would cut the song ~2.5s early). When false we fall back to the
// seek-loop with a SAFE margin so the page can never advance to the wrong track.
let preparedInstrumentalRepeatOneEngaged = false;
const PREPARED_INSTRUMENTAL_STATE = Object.freeze({
  IDLE: "idle",
  CAPTURING: "capturing",
  PROCESSING: "processing",
  PLAYBACK_READY: "playback_ready",
  PLAYBACK_ACTIVE: "playback_active",
  LOOPING: "looping",
  ENDED: "ended"
});
let preparedInstrumentalState = PREPARED_INSTRUMENTAL_STATE.IDLE;
const preparedInstrumentalCache = new Map();
// Processing phase timer — animates the progress bar and shows elapsed/ETA.
let preparedInstrumentalProcessingTimer = null;
let preparedInstrumentalProcessingStartMs = 0;
let preparedInstrumentalProcessingEstimatedMs = 0;

// --- DO NOT EDIT casually — isolation invariant (see AGENTS.md "Fragile code"). ---
// Prepared-session state machine: guards against a second start aborting the first.
// After changes: node --check + verify_voice_isolation_lock.sh + test both modes.
function isPreparedInstrumentalSessionCurrent(sessionId) {
  return sessionId === preparedInstrumentalSessionId;
}

function setPreparedInstrumentalState(nextState, sessionId = preparedInstrumentalSessionId) {
  if (!isPreparedInstrumentalSessionCurrent(sessionId)) {
    return false;
  }
  preparedInstrumentalState = nextState;
  return true;
}

function clearPreparedInstrumentalState() {
  preparedInstrumentalState = PREPARED_INSTRUMENTAL_STATE.IDLE;
}

// Live companion AI isolation (delayed chunk playback).
let liveCompanionIsolationActive = false;
let liveCompanionRecorder = null;
let liveCompanionBusy = false;
let liveCompanionSessionId = 0;
let liveCompanionNextPlaybackTime = 0;
let liveCompanionQueuedSources = new Set();
// True once companion has disconnected inputSourceNode→inputMixNode and muted the tab.
// Kept false until the first processed chunk is scheduled so original audio plays during warmup.
let liveCompanionTookoverRouting = false;

// Browser audio pause/resume state for voice isolation
let browserAudioPausedForIsolation = false;
let userPausedBrowserAudio = false;
let liveCompanionPlaybackPaused = false;
let liveCompanionChunksProcessed = 0;
let liveCompanionGapDetectionTimer = null;
let liveCompanionLastChunkTime = 0;
let liveCompanionDisconnectedDuringWarmup = false;
let liveCompanionFirstChunkTimeoutTimer = null;

// Chunk queue for preventing audio cutoffs (OPTIMIZATION: queue instead of skip)
let liveCompanionChunkQueue = [];
const MAX_COMPANION_QUEUE_SIZE = 4; // Larger queue smooths over occasional slow inference spikes.
let liveCompanionProcessingQueue = false;
let liveCompanionInitChunkBlob = null;
let liveCompanionConsecutiveDecodeFailures = 0;
const LIVE_COMPANION_MAX_DECODE_FAILURES_BEFORE_SHUTDOWN = 2;
let liveCompanionConsecutiveProcessFailures = 0;
const LIVE_COMPANION_MAX_PROCESS_FAILURES_BEFORE_SHUTDOWN = 6;
let liveCompanionCaptureNode = null;
let liveCompanionCaptureSinkNode = null;
let liveCompanionCaptureTimer = null;
let liveCompanionLastRealAudioTime = 0; // Tracks last moment real (non-silent) audio was enqueued
let liveCompanionPcmBlocks = [];
let liveCompanionQueuedSamples = 0;
let liveCompanionTrailingSilenceSamples = 0; // Silence samples accumulated since last real audio
let liveCompanionCaptureChannelCount = 2;
let liveCompanionWarmupStartedAt = 0;
let liveCompanionTimelineRewindApplied = false;
// The media currentTime (seconds) captured just before we paused for processing.
// Used to seek back to the exact start point once AI audio is ready.
let liveCompanionCaptureStartMediaTime = -1;
let liveCompanionPendingPlaybackBuffers = [];
const LIVE_COMPANION_STARTUP_PREFETCH_CHUNKS = 1;

let recordingDestination = null;
let mediaRecorder = null;
let recordingChunks = [];
let lastRecordingBlob = null;
let lastRecordingObjectUrl = null;
let lastRecordingAudioBuffer = null;
let recordingStartedAt = null;

let wantsCapture = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let speedEnforceTimer = null;
let muteSafetyTimer = null;
let inputLevelAnalyserNode = null;
let outputLevelAnalyserNode = null;
let capturedTabId = null;
let muteSafetyAttempts = 0;
let extensionMutedTabId = null;
let extensionMutedTabPreviousState = null;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 800;
const MUTE_SAFETY_MAX_ATTEMPTS = 16;
const MUTE_SAFETY_RETRY_MS = 500;

let ortConfigured = false;

function ensureOrtConfigured() {
  if (ortConfigured || typeof ort === "undefined" || !ort?.env?.wasm) {
    return;
  }

  ort.env.wasm.wasmPaths = {
    "ort-wasm.wasm": chrome.runtime.getURL("libs/ort-wasm.wasm"),
    "ort-wasm-simd.wasm": chrome.runtime.getURL("libs/ort-wasm-simd.wasm")
  };
  ort.env.wasm.numThreads = 1;
  ortConfigured = true;
}

const statusEl = document.getElementById("status");
const panelEl = document.querySelector(".panel");
const rootStyle = document.documentElement.style;
const rootEl = document.documentElement;
const startBtn = document.getElementById("startCapture");
const stopBtn = document.getElementById("stopCapture");
const startRecordingBtn = document.getElementById("startRecording");
const stopRecordingBtn = document.getElementById("stopRecording");
const downloadWavBtn = document.getElementById("downloadWav");
const downloadMp3Btn = document.getElementById("downloadMp3");
const recordingStatusEl = document.getElementById("recordingStatus");
const captureSectionEl = document.getElementById("captureSection");
const themeLightBtn = document.getElementById("themeLightBtn");
const themeDarkBtn = document.getElementById("themeDarkBtn");
const tabCaptureBtn = document.getElementById("tabCaptureBtn");
const tabFxBtn = document.getElementById("tabFxBtn");
const tabAiBtn = document.getElementById("tabAiBtn");

const bassInput = document.getElementById("bass");
const bassValueEl = document.getElementById("bassValue");
const volumeInput = document.getElementById("volume");
const volumeValueEl = document.getElementById("volumeValue");
const effectMixInput = document.getElementById("effectMix");
const effectMixValueEl = document.getElementById("effectMixValue");
const speedInput = document.getElementById("speed");
const speedValueEl = document.getElementById("speedValue");
const pitchInput = document.getElementById("pitch");
const pitchValueEl = document.getElementById("pitchValue");
const resetPlaybackShapingBtn = document.getElementById("resetPlaybackShaping");
const reverbEnable = document.getElementById("reverb-enable");
const reverbInput = document.getElementById("reverb");
const reverbValueEl = document.getElementById("reverbValue");
const reverbTypeInput = document.getElementById("reverbType");
const reverbSizeInput = document.getElementById("reverbSize");
const reverbSizeValueEl = document.getElementById("reverbSizeValue");
const reverbToneInput = document.getElementById("reverbTone");
const reverbToneValueEl = document.getElementById("reverbToneValue");
const chorusEnable = document.getElementById("chorus-enable");
const chorusMixInput = document.getElementById("chorusMix");
const chorusMixValueEl = document.getElementById("chorusMixValue");
const chorusRateInput = document.getElementById("chorusRate");
const chorusRateValueEl = document.getElementById("chorusRateValue");
const chorusTypeInput = document.getElementById("chorusType");
const chorusDepthInput = document.getElementById("chorusDepth");
const chorusDepthValueEl = document.getElementById("chorusDepthValue");
const chorusWidthInput = document.getElementById("chorusWidth");
const chorusWidthValueEl = document.getElementById("chorusWidthValue");
const delayEnable = document.getElementById("delay-enable");
const delayMixInput = document.getElementById("delayMix");
const delayMixValueEl = document.getElementById("delayMixValue");
const delayTypeInput = document.getElementById("delayType");
const delayTimeInput = document.getElementById("delayTime");
const delayTimeValueEl = document.getElementById("delayTimeValue");
const delayFeedbackInput = document.getElementById("delayFeedback");
const delayFeedbackValueEl = document.getElementById("delayFeedbackValue");
const distortionEnable = document.getElementById("distortion-enable");
const distortionInput = document.getElementById("distortion");
const distortionValueEl = document.getElementById("distortionValue");
const resetAudioEffectsBtn = document.getElementById("resetAudioEffects");

const presetClearBtn = document.getElementById("presetClear");
const presetOldRadioBtn = document.getElementById("presetOldRadio");
const presetLoFiBtn = document.getElementById("presetLoFi");
const presetDistortedBtn = document.getElementById("presetDistorted");
const presetCatWahBtn = document.getElementById("presetCatWah");
const presetAlienBtn = document.getElementById("presetAlien");
const presetOuterSpaceBtn = document.getElementById("presetOuterSpace");
const presetDeepReverbBtn = document.getElementById("presetDeepReverb");
const presetPhoneCallBtn = document.getElementById("presetPhoneCall");

const audioFileInput = document.getElementById("audioFileInput");
const loadLastRecordingBtn = document.getElementById("loadLastRecording");
const playLoadedAudioBtn = document.getElementById("playLoadedAudio");
const pauseLoadedAudioBtn = document.getElementById("pauseLoadedAudio");
const stopLoadedAudioBtn = document.getElementById("stopLoadedAudio");
const skipBackLoadedAudioBtn = document.getElementById("skipBackLoadedAudio");
const replayLoadedAudioBtn = document.getElementById("replayLoadedAudio");
const skipForwardLoadedAudioBtn = document.getElementById("skipForwardLoadedAudio");
const pauseBrowserAudioBtn = document.getElementById("pauseBrowserAudio");
const skipBackCaptureMediaBtn = document.getElementById("skipBackCaptureMedia");
const restartCaptureMediaBtn = document.getElementById("restartCaptureMedia");
const prevCaptureMediaTrackBtn = document.getElementById("prevCaptureMediaTrack");
const nextCaptureMediaTrackBtn = document.getElementById("nextCaptureMediaTrack");
const skipForwardCaptureMediaBtn = document.getElementById("skipForwardCaptureMedia");
const downloadProcessedWavBtn = document.getElementById("downloadProcessedWav");
const loadedStatusEl = document.getElementById("loadedStatus");
const recordedPlaybackSectionEl = document.getElementById("recordedPlaybackSection");
const generateStemsBtn = document.getElementById("generateStems");
const cancelStemGenerationBtn = document.getElementById("cancelStemGeneration");
const useStudioStemQualityInput = document.getElementById("useStudioStemQuality");
const stemStatusEl = document.getElementById("stemStatus");
const sourceStemStatusEl = document.getElementById("sourceStemStatus");
const companionStatusEl = document.getElementById("companionStatus");
const stemSectionEl = document.getElementById("stemSection");
const checkCompanionBtn = document.getElementById("checkCompanion");
const restartCompanionBtn = document.getElementById("restartCompanion");
const sourceStemControlsEl = document.getElementById("sourceStemControls");
const downloadStemMixBtn = document.getElementById("downloadStemMix");
const downloadAllStemsBtn = document.getElementById("downloadAllStems");
const presetExcludeVocalsBtn = document.getElementById("presetExcludeVocals");
const presetExcludeDrumsBtn = document.getElementById("presetExcludeDrums");
const presetExcludeBassBtn = document.getElementById("presetExcludeBass");
const presetExcludeDrumsBassBtn = document.getElementById("presetExcludeDrumsBass");
const presetVocalsOnlyBtn = document.getElementById("presetVocalsOnly");
const presetEnableAllStemsBtn = document.getElementById("presetEnableAllStems");
const cleanupStemSelect = document.getElementById("cleanupStemSelect");
const cleanupEnabledInput = document.getElementById("cleanupEnabled");
const cleanupHighpassInput = document.getElementById("cleanupHighpass");
const cleanupLowpassInput = document.getElementById("cleanupLowpass");
const cleanupGateInput = document.getElementById("cleanupGate");
const cleanupTransientReductionInput = document.getElementById("cleanupTransientReduction");
const cleanupHighpassValueEl = document.getElementById("cleanupHighpassValue");
const cleanupLowpassValueEl = document.getElementById("cleanupLowpassValue");
const cleanupGateValueEl = document.getElementById("cleanupGateValue");
const cleanupTransientReductionValueEl = document.getElementById("cleanupTransientReductionValue");
const autoVocalCleanupEnabledInput = document.getElementById("autoVocalCleanupEnabled");
const autoVocalCleanupStrengthInput = document.getElementById("autoVocalCleanupStrength");
const autoVocalCleanupStrengthValueEl = document.getElementById("autoVocalCleanupStrengthValue");
const applyAutoVocalCleanupBtn = document.getElementById("applyAutoVocalCleanup");
const applyAutoVocalCleanupStrongBtn = document.getElementById("applyAutoVocalCleanupStrong");
const applyVocalCleanupPresetBtn = document.getElementById("applyVocalCleanupPreset");
const resetCleanupForStemBtn = document.getElementById("resetCleanupForStem");
const stemProgressEl = document.getElementById("stemProgress");
const stemProgressFillEl = document.getElementById("stemProgressFill");
const stemProgressTextEl = document.getElementById("stemProgressText");
const useLiveStemMixingInput = document.getElementById("useLiveStemMixing");
const useStemMixPlaybackInput = document.getElementById("useStemMixPlayback");

// Voice isolation elements
const enableVoiceIsolationInput = document.getElementById("enableVoiceIsolation");
const startVoiceIsolationBtn = document.getElementById("startVoiceIsolation");
const stopVoiceIsolationBtn = document.getElementById("stopVoiceIsolation");
const voiceIsolationStatusEl = document.getElementById("voiceIsolationStatus");
const voiceIsolationSectionEl = document.getElementById("voiceIsolationSection");
const instrumentalPrepCardEl = document.getElementById("instrumentalPrepCard");
const instrumentalPrepHeadlineEl = document.getElementById("instrumentalPrepHeadline");
const instrumentalPrepDetailEl = document.getElementById("instrumentalPrepDetail");
const instrumentalPrepProgressEl = document.getElementById("instrumentalPrepProgress");
const instrumentalPrepProgressFillEl = document.getElementById("instrumentalPrepProgressFill");
const instrumentalPrepProgressTextEl = document.getElementById("instrumentalPrepProgressText");
const downloadPreparedInstrumentalBtn = document.getElementById("downloadPreparedInstrumentalBtn");
const voiceIsolationStrengthInput = document.getElementById("voiceIsolationStrength");
const voiceIsolationStrengthValueEl = document.getElementById("voiceIsolationStrengthValue");
const voiceIsolationModeInput = document.getElementById("voiceIsolationMode");
const setVoiceModeVocalsBtn = document.getElementById("setVoiceModeVocals");
const setVoiceModeInstrumentalBtn = document.getElementById("setVoiceModeInstrumental");
const processingDelayInput = document.getElementById("processingDelay");
const processingDelayValueEl = document.getElementById("processingDelayValue");
const stemLowGainInput = document.getElementById("stemLowGain");
const stemMidGainInput = document.getElementById("stemMidGain");
const stemHighGainInput = document.getElementById("stemHighGain");
const stemLowGainValueEl = document.getElementById("stemLowGainValue");
const stemMidGainValueEl = document.getElementById("stemMidGainValue");
const stemHighGainValueEl = document.getElementById("stemHighGainValue");
const stemLowMuteInput = document.getElementById("stemLowMute");
const stemMidMuteInput = document.getElementById("stemMidMute");
const stemHighMuteInput = document.getElementById("stemHighMute");

const UI_THEME_KEY = "uiTheme";
const UI_TAB_KEY = "uiTab";

const tabButtons = {
  capture: tabCaptureBtn,
  fx: tabFxBtn,
  ai: tabAiBtn
};

const tabSections = Array.from(document.querySelectorAll(".accordion-section[data-tab]"));

let currentUiTheme = "light";
let currentUiTab = "capture";

// Waveform visualizer elements
const waveformContainer = document.getElementById("waveformContainer");
const waveformCanvas = document.getElementById("waveformCanvas");
const scrubberInput = document.getElementById("scrubberInput");
const trimStartInput = document.getElementById("trimStart");
const trimEndInput = document.getElementById("trimEnd");
const totalDurationEl = document.getElementById("totalDuration");
const currentPlaybackTimeEl = document.getElementById("currentPlaybackTime");
const trimmedDurationEl = document.getElementById("trimmedDuration");
const midpointLabel = document.getElementById("midpointLabel");
const endLabel = document.getElementById("endLabel");
const stemWaveformContainer = document.getElementById("stemWaveformContainer");
const stemWaveformCanvas = document.getElementById("stemWaveformCanvas");
const stemScrubberInput = document.getElementById("stemScrubberInput");
const stemTotalDurationEl = document.getElementById("stemTotalDuration");
const stemCurrentPlaybackTimeEl = document.getElementById("stemCurrentPlaybackTime");
const stemTrimmedDurationEl = document.getElementById("stemTrimmedDuration");
const stemPlayLoadedAudioBtn = document.getElementById("stemPlayLoadedAudio");
const stemPauseLoadedAudioBtn = document.getElementById("stemPauseLoadedAudio");
const stemStopLoadedAudioBtn = document.getElementById("stemStopLoadedAudio");

// Waveform state
let trimStartSeconds = 0;
let trimEndSeconds = 0;
let currentPlaybackSeconds = 0;
let waveformDrawingContext = null;
let animationFrameId = null;
let recordedAudioIsPlaying = false;
let recordedAudioIsPaused = false;
let filePlaybackStartTime = null;
let filePlaybackStartOffsetSeconds = 0;
let filePlaybackRate = 1;
let filePlaybackDirectMonitorNode = null;
let playbackSessionId = 0;
let lastLoadedPlaybackUsedStemMix = false;
let splitStemBuffers = null;
let sourceStemBuffers = null;
let sourceStemMixSettings = {};
let stemCleanupState = {};
let selectedCleanupStem = "";
let autoVocalCleanupEnabled = true;
let autoVocalCleanupStrength = 0.55;
let cachedStemMixBuffer = null;
let cachedStemMixKey = "";
let cachedProcessedStemBuffers = new Map();
let aiStemSessionPromise = null;
let kuielabStemSessionsPromise = null;
let kuielabVocalSessionPromise = null;
let stemGenerationInProgress = false;
let stemGenerationAbortController = null;
let companionEngineAvailable = false;
let companionEngineVersion = "unknown";
let companionRetryTimer = null;
let companionRestartInProgress = false;
let sessionCacheSyncTimer = null;
let presetSwitchInProgress = false;

function isPresetDebugEnabled() {
  try {
    return localStorage.getItem("audioMixerPresetDebug") === "1";
  } catch (_error) {
    return false;
  }
}

function logPresetDebug(stage, extra = {}) {
  if (!isPresetDebugEnabled()) {
    return;
  }

  const snapshot = {
    activeFilterPreset,
    presetSwitchInProgress,
    effectMix: Number(effectMixInput?.value ?? 0),
    reverbEnabled: Boolean(reverbEnable?.checked),
    chorusEnabled: Boolean(chorusEnable?.checked),
    delayEnabled: Boolean(delayEnable?.checked),
    distortionEnabled: Boolean(distortionEnable?.checked),
    ...extra
  };

  console.debug("[PresetDebug]", stage, snapshot);
}

const SESSION_DB_NAME = "audio-mixer-session";
const SESSION_DB_VERSION = 1;
const SESSION_DB_STORE = "kv";

const COMPANION_API_BASE_URL = "http://127.0.0.1:48231";
const COMPANION_HEALTH_TIMEOUT_MS = 3500;
const COMPANION_RETRY_INTERVAL_MS = 10000; // auto-check every 10s when offline
// Self-heal restart poll cadence: launchd honors ThrottleInterval (~10s) before it
// relaunches, then the fresh process reloads the model (warmup), so poll for a while.
const COMPANION_RESTART_POLL_INTERVAL_MS = 3000;
const COMPANION_RESTART_MAX_WAIT_MS = 45000;
const COMPANION_SPLIT_TIMEOUT_MS = 8 * 60 * 1000;
const LIVE_COMPANION_CHUNK_MS = 20000;
const LIVE_COMPANION_ALIGNMENT_OFFSET_SECONDS = 0.5; // Lead time before first AI chunk plays, and seek-back amount.
const LIVE_COMPANION_REQUEST_TIMEOUT_MS = 90 * 1000;
// --- DO NOT EDIT casually — anti-drift contract (see AGENTS.md). These fields MUST
// match companion_profile.json + the companion /v1/health; check_profile_drift.sh enforces it. ---
const COMPANION_LOCK_PROFILE = Object.freeze({
  split: true,
  fast_short_clips: false,
  fast_short_max_seconds: 75,
  fast_medium_clips: true,
  fast_medium_max_seconds: 180,
  fast_medium_segment_seconds: 30,
  overlap: 0.25,
  device: "mps"
});

const KUIELAB_SAMPLE_RATE = 44100;
const KUIELAB_FFT_SIZE = 4096;
const KUIELAB_HOP_SIZE = 1024;
const KUIELAB_FREQ_BINS = 2048;
const KUIELAB_CHUNK_FRAMES = 512;
const KUIELAB_CHUNK_SAMPLES = KUIELAB_HOP_SIZE * (KUIELAB_CHUNK_FRAMES - 1);
const KUIELAB_CHUNK_HOP = Math.floor(KUIELAB_CHUNK_SAMPLES / 2);
const KUIELAB_FRAME_OFFSET = KUIELAB_FFT_SIZE >> 1;
const KUIELAB_STEM_NAMES = ["vocals", "drums", "bass", "other"];
const KUIELAB_MIXTURE_CONSISTENCY_BLEND = 0.35;
const KUIELAB_STUDIO_REVERSE_MAX_SECONDS = 100;
const VOCAL_BLEED_CANCEL_STRENGTH = 0.42;
const VOCAL_BLEED_GATE_RATIO = 1.2;

function isStudioStemQualityEnabled() {
  return Boolean(useStudioStemQualityInput?.checked);
}

function isCompanionProfileLocked(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const same = (value, expected) => String(value) === String(expected);
  const sameNumber = (value, expected) => Number(value) === Number(expected);

  return Boolean(
    same(payload.split, COMPANION_LOCK_PROFILE.split) &&
    same(payload.fast_short_clips, COMPANION_LOCK_PROFILE.fast_short_clips) &&
    sameNumber(payload.fast_short_max_seconds, COMPANION_LOCK_PROFILE.fast_short_max_seconds) &&
    same(payload.fast_medium_clips, COMPANION_LOCK_PROFILE.fast_medium_clips) &&
    sameNumber(payload.fast_medium_max_seconds, COMPANION_LOCK_PROFILE.fast_medium_max_seconds) &&
    sameNumber(payload.fast_medium_segment_seconds, COMPANION_LOCK_PROFILE.fast_medium_segment_seconds) &&
    sameNumber(payload.overlap, COMPANION_LOCK_PROFILE.overlap) &&
    same(payload.device, COMPANION_LOCK_PROFILE.device)
  );
}

function isCompanionProfileCpuFallback(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const same = (value, expected) => String(value) === String(expected);
  const sameNumber = (value, expected) => Number(value) === Number(expected);

  return Boolean(
    same(payload.split, COMPANION_LOCK_PROFILE.split) &&
    same(payload.fast_short_clips, COMPANION_LOCK_PROFILE.fast_short_clips) &&
    sameNumber(payload.fast_short_max_seconds, COMPANION_LOCK_PROFILE.fast_short_max_seconds) &&
    same(payload.fast_medium_clips, COMPANION_LOCK_PROFILE.fast_medium_clips) &&
    sameNumber(payload.fast_medium_max_seconds, COMPANION_LOCK_PROFILE.fast_medium_max_seconds) &&
    sameNumber(payload.fast_medium_segment_seconds, COMPANION_LOCK_PROFILE.fast_medium_segment_seconds) &&
    sameNumber(payload.overlap, COMPANION_LOCK_PROFILE.overlap) &&
    String(payload.device).toLowerCase() === "cpu"
  );
}

function getCompanionProfileDriftMessage(payload) {
  const expected = COMPANION_LOCK_PROFILE;
  const actual = {
    split: payload?.split,
    fast_short_clips: payload?.fast_short_clips,
    fast_short_max_seconds: payload?.fast_short_max_seconds,
    fast_medium_clips: payload?.fast_medium_clips,
    fast_medium_max_seconds: payload?.fast_medium_max_seconds,
    fast_medium_segment_seconds: payload?.fast_medium_segment_seconds,
    overlap: payload?.overlap,
    device: payload?.device
  };
  return `profile drift detected (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`;
}

class Radix2Fft {
  constructor(size) {
    this.size = size;
    this.levels = Math.round(Math.log2(size));
    this.cosTable = new Float32Array(size / 2);
    this.sinTable = new Float32Array(size / 2);
    this.bitReverse = new Uint32Array(size);

    for (let i = 0; i < size / 2; i += 1) {
      const angle = (2 * Math.PI * i) / size;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    for (let i = 0; i < size; i += 1) {
      let x = i;
      let y = 0;
      for (let j = 0; j < this.levels; j += 1) {
        y = (y << 1) | (x & 1);
        x >>= 1;
      }
      this.bitReverse[i] = y;
    }
  }

  transform(real, imag, inverse = false) {
    const size = this.size;
    for (let i = 0; i < size; i += 1) {
      const j = this.bitReverse[i];
      if (j > i) {
        const tmpReal = real[i];
        const tmpImag = imag[i];
        real[i] = real[j];
        imag[i] = imag[j];
        real[j] = tmpReal;
        imag[j] = tmpImag;
      }
    }

    for (let len = 2; len <= size; len <<= 1) {
      const halfLen = len >> 1;
      const step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let i = 0; i < halfLen; i += 1) {
          const tableIndex = i * step;
          const cos = this.cosTable[tableIndex];
          const sin = inverse ? -this.sinTable[tableIndex] : this.sinTable[tableIndex];
          const evenIndex = start + i;
          const oddIndex = evenIndex + halfLen;

          const tre = real[oddIndex] * cos + imag[oddIndex] * sin;
          const tim = -real[oddIndex] * sin + imag[oddIndex] * cos;

          real[oddIndex] = real[evenIndex] - tre;
          imag[oddIndex] = imag[evenIndex] - tim;
          real[evenIndex] += tre;
          imag[evenIndex] += tim;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < size; i += 1) {
        real[i] /= size;
        imag[i] /= size;
      }
    }
  }
}

const kuielabFft = new Radix2Fft(KUIELAB_FFT_SIZE);
const kuielabWindow = (() => {
  const window = new Float32Array(KUIELAB_FFT_SIZE);
  for (let i = 0; i < KUIELAB_FFT_SIZE; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / KUIELAB_FFT_SIZE);
  }
  return window;
})();

// Waveform zoom/scroll state
let waveformZoom = 1.0; // 1.0 = full view, >1 = zoomed in
let waveformScrollOffset = 0; // time offset in seconds

function setStatus(text) {
  applySemanticStatus(statusEl, text);
}

function clearSemanticState(el) {
  if (!el) {
    return;
  }
  el.removeAttribute("data-state");
  el.classList.remove("is-info", "is-success", "is-warning", "is-error");
}

function applySemanticState(el, state) {
  if (!el) {
    return;
  }

  clearSemanticState(el);
  if (!state) {
    return;
  }

  el.dataset.state = state;
  el.classList.add(`is-${state}`);
}

function inferSemanticStateFromText(rawText) {
  const text = String(rawText || "").trim().toLowerCase();
  if (!text) {
    return null;
  }

  if (/\b(error|failed|failure|blocked|exhausted|unavailable|stalled|not detected|no stream|cannot|can't|invalid|panic|drift)\b/.test(text) || /⚠️/.test(text)) {
    return "error";
  }

  if (/\b(warning|retry|retrying|reconnect|reconnecting|buffering|waiting|preparing|checking|prefetching|suspended|paused|off\b|restarting)\b/.test(text) || /⏳|🔄/.test(text)) {
    return "warning";
  }

  if (/\b(active|ready|connected|capturing|running|live|complete|completed|success|on\b|download|generated|synced|idle)\b/.test(text) || /✓/.test(text)) {
    return "success";
  }

  return "info";
}

function applySemanticStatus(statusElRef, text, sectionEl = null) {
  if (!statusElRef) {
    return;
  }

  statusElRef.textContent = text;
  const state = inferSemanticStateFromText(text);
  applySemanticState(statusElRef, state);

  const textLower = String(text || "").toLowerCase();
  const loadingLike = /\b(checking|preparing|buffering|prefetching|retrying|reconnecting|processing|initializing|loading|waiting|restarting)\b/.test(textLower) || /⏳|🔄/.test(text);
  statusElRef.classList.toggle("is-loading", loadingLike);

  if (sectionEl) {
    applySemanticState(sectionEl, state);
    sectionEl.classList.toggle("is-loading", loadingLike);
  }
}

function applyAppearanceSettings() {
  delete rootEl.dataset.contrast;

  if (panelEl) {
    delete panelEl.dataset.density;
  }

  delete rootEl.dataset.visualRegression;
}

function normalizeUiTheme(theme) {
  return theme === "dark" ? "dark" : "light";
}

function normalizeUiTab(tab) {
  if (tab === "fx" || tab === "ai") {
    return tab;
  }
  return "capture";
}

function getFirstVisibleTab() {
  for (const tabName of ["capture", "fx", "ai"]) {
    if (tabSections.some((el) => el.dataset.tab === tabName)) {
      return tabName;
    }
  }
  return "capture";
}

function applyUiTheme(theme, { persist = true } = {}) {
  currentUiTheme = normalizeUiTheme(theme);
  rootEl.dataset.theme = currentUiTheme;

  themeLightBtn?.classList.toggle("is-active", currentUiTheme === "light");
  themeDarkBtn?.classList.toggle("is-active", currentUiTheme === "dark");

  // Re-assert section visibility after theme toggle — the data-theme attribute
  // change triggers a CSS repaint that can cause hidden sections to re-appear.
  if (currentUiTab) {
    tabSections.forEach((sectionEl) => {
      sectionEl.hidden = sectionEl.dataset.tab !== currentUiTab;
    });
  }

  if (persist) {
    void chrome.storage.local.set({ [UI_THEME_KEY]: currentUiTheme });
  }
}

function applyUiTab(tab, { persist = true } = {}) {
  const requestedTab = normalizeUiTab(tab);
  const hasVisibleSections = tabSections.some(
    (el) => el.dataset.tab === requestedTab
  );
  const finalTab = hasVisibleSections ? requestedTab : getFirstVisibleTab();
  const tabChanged = finalTab !== currentUiTab;
  if (!tabChanged && !persist) {
    // Already on this tab — this is the onChanged sync-back call from our own write. Skip.
    return;
  }
  currentUiTab = finalTab;

  Object.entries(tabButtons).forEach(([tabKey, buttonEl]) => {
    buttonEl?.classList.toggle("is-active", tabKey === currentUiTab);
  });

  const visibleSections = [];
  tabSections.forEach((sectionEl) => {
    const shouldShow = sectionEl.dataset.tab === currentUiTab;
    if (shouldShow) {
      sectionEl.hidden = false;
      visibleSections.push(sectionEl);
    } else {
      sectionEl.hidden = true;
    }
  });

  if (visibleSections.length > 0 && !visibleSections.some((el) => el.open)) {
    visibleSections[0].open = true;
  }

  // One-shot waveform redraw after newly visible sections have painted.
  if (tabChanged && loadedAudioBuffer) {
    requestAnimationFrame(() => { if (loadedAudioBuffer) drawWaveform(); });
  }

  if (persist && tabChanged) {
    void chrome.storage.local.set({ [UI_TAB_KEY]: currentUiTab });
  }
}

function syncUiStateFromStorageChanges(changes, areaName) {
  if (areaName !== "local") {
    return;
  }

  if (changes[UI_THEME_KEY] && changes[UI_THEME_KEY].newValue !== currentUiTheme) {
    applyUiTheme(changes[UI_THEME_KEY].newValue, { persist: false });
  }

  if (changes[UI_TAB_KEY] && changes[UI_TAB_KEY].newValue !== currentUiTab) {
    applyUiTab(changes[UI_TAB_KEY].newValue, { persist: false });
  }
}

function applyPopupBackdropImage(dataUrl) {
  if (!dataUrl) {
    rootStyle.setProperty("--captured-tab-image", "none");
    return;
  }

  const escapedUrl = String(dataUrl).replace(/"/g, '\\"');
  rootStyle.setProperty("--captured-tab-image", `url("${escapedUrl}")`);
}

function clearPopupBackdropImage() {
  rootStyle.setProperty("--captured-tab-image", "none");
}

function isPopupMode() {
  try {
    // Popup context has an opener extension view. Side panel does not.
    return Boolean(window.opener);
  } catch {
    return true;
  }
}


function setRecordingStatus(text) {
  applySemanticStatus(recordingStatusEl, `Recording: ${text}`, captureSectionEl);
}

function setLoadedStatus(text) {
  applySemanticStatus(loadedStatusEl, `Loaded: ${text}`, recordedPlaybackSectionEl);
}

function setStemStatus(text) {
  applySemanticStatus(stemStatusEl, `Stems: ${text}`, stemSectionEl);
}

function setSourceStemStatus(text) {
  if (sourceStemStatusEl) {
    applySemanticStatus(sourceStemStatusEl, `Source Stems: ${text}`, stemSectionEl);
  }
}

function serializeAudioBufferForTransfer(audioBuffer) {
  if (!audioBuffer || !Number.isFinite(audioBuffer.length) || !Number.isFinite(audioBuffer.sampleRate)) {
    return null;
  }

  const channels = [];
  for (let i = 0; i < audioBuffer.numberOfChannels; i += 1) {
    const sourceData = audioBuffer.getChannelData(i);
    // Store as plain Array (more reliable with IndexedDB structured clone)
    // Will be converted back to Float32Array on restore
    channels.push(Array.from(sourceData));
  }

  return {
    sampleRate: audioBuffer.sampleRate,
    length: audioBuffer.length,
    numberOfChannels: audioBuffer.numberOfChannels,
    channels
  };
}

function deserializeAudioBufferFromTransfer(audioData) {
  if (!audioData || !Number.isFinite(audioData.length) || !Number.isFinite(audioData.sampleRate)) {
    return null;
  }

  if (!audioData.channels || !Array.isArray(audioData.channels) || audioData.channels.length === 0) {
    console.error("[Deserialize] Invalid channels structure:", audioData);
    return null;
  }

  const buffer = new AudioBuffer({
    length: audioData.length,
    numberOfChannels: audioData.numberOfChannels,
    sampleRate: audioData.sampleRate
  });

  for (let i = 0; i < audioData.numberOfChannels; i += 1) {
    const target = buffer.getChannelData(i);
    const sourceChannel = audioData.channels[i];
    
    // Ensure sourceChannel is array-like with correct length
    if (!sourceChannel || sourceChannel.length !== buffer.length) {
      console.error(`[Deserialize] Channel ${i} has invalid length: got ${sourceChannel?.length}, expected ${buffer.length}`);
      // Fill with zeros to prevent corruption
      target.fill(0);
    } else {
      try {
        // Handle both Float32Array and plain Array
        target.set(sourceChannel);
      } catch (err) {
        console.error(`[Deserialize] Failed to set channel ${i}:`, err);
        target.fill(0);
      }
    }
  }

  return buffer;
}

function serializeSourceStemsForTransfer(stemsByName) {
  if (!stemsByName) return null;
  const out = {};
  for (const [name, buffer] of Object.entries(stemsByName)) {
    const encoded = serializeAudioBufferForTransfer(buffer);
    if (encoded) out[name] = encoded;
  }
  return Object.keys(out).length ? out : null;
}

function deserializeSourceStemsFromTransfer(stemsByName) {
  if (!stemsByName) return null;
  const out = {};
  for (const [name, encoded] of Object.entries(stemsByName)) {
    const decoded = deserializeAudioBufferFromTransfer(encoded);
    if (decoded) out[name] = decoded;
  }
  return Object.keys(out).length ? out : null;
}

function serializeWaveformSessionState() {
  if (!loadedAudioBuffer) {
    return null;
  }

  return {
    trimStartSeconds,
    trimEndSeconds,
    currentPlaybackSeconds,
    waveformZoom,
    waveformScrollOffset,
    lastLoadedPlaybackUsedStemMix
  };
}

function normalizeSourceStemMixSettings(rawSettings, stemsByName) {
  if (!rawSettings || typeof rawSettings !== "object") {
    return {};
  }

  const allowedStemNames = new Set(Object.keys(stemsByName || {}));
  const normalized = {};

  for (const [stemName, state] of Object.entries(rawSettings)) {
    if (!allowedStemNames.has(stemName)) continue;
    const gain = Number(state?.gain);
    normalized[stemName] = {
      gain: Number.isFinite(gain) ? Math.max(0, Math.min(1.5, gain)) : 1,
      mute: Boolean(state?.mute)
    };
  }

  return normalized;
}

function applyRestoredWaveformSessionState(rawState) {
  if (!loadedAudioBuffer || !rawState || typeof rawState !== "object") {
    return;
  }

  const duration = loadedAudioBuffer.duration;
  const startRaw = Number(rawState.trimStartSeconds);
  const endRaw = Number(rawState.trimEndSeconds);
  const start = Number.isFinite(startRaw) ? Math.max(0, Math.min(duration, startRaw)) : 0;
  const endDefault = Number.isFinite(endRaw) ? endRaw : duration;
  const end = Math.max(start + 0.01, Math.min(duration, endDefault));
  const playbackRaw = Number(rawState.currentPlaybackSeconds);
  const playback = Number.isFinite(playbackRaw)
    ? Math.max(start, Math.min(end, playbackRaw))
    : start;
  const zoomRaw = Number(rawState.waveformZoom);
  const zoom = Number.isFinite(zoomRaw) ? Math.max(1, Math.min(16, zoomRaw)) : 1;
  const offsetRaw = Number(rawState.waveformScrollOffset);
  const visibleDuration = duration / zoom;
  const maxOffset = Math.max(0, duration - visibleDuration);
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.min(maxOffset, offsetRaw)) : 0;

  trimStartSeconds = start;
  trimEndSeconds = end;
  currentPlaybackSeconds = playback;
  waveformZoom = zoom;
  waveformScrollOffset = offset;
  lastLoadedPlaybackUsedStemMix = Boolean(rawState.lastLoadedPlaybackUsedStemMix);

  trimStartInput.max = String(duration);
  trimEndInput.max = String(duration);
  trimStartInput.value = String(trimStartSeconds);
  trimEndInput.value = String(trimEndSeconds);
  scrubberInput.max = String(duration);
  scrubberInput.value = String(currentPlaybackSeconds);
  if (stemScrubberInput) {
    stemScrubberInput.max = String(duration);
    stemScrubberInput.value = String(currentPlaybackSeconds);
  }

  updateWaveformDisplay();
}

async function syncSessionCacheToOffscreen() {
  const ready = await ensureOffscreenExists();
  if (!ready) return;

  try {
    await chrome.runtime.sendMessage({
      type: "CACHE_SESSION_STATE",
      sessionState: {
        loadedAudioData: serializeAudioBufferForTransfer(loadedAudioBuffer),
        sourceStemAudioDataByName: serializeSourceStemsForTransfer(sourceStemBuffers),
        waveformSessionState: serializeWaveformSessionState(),
        sourceStemMixSettings
      }
    });
  } catch (error) {
    console.warn("[Popup] Failed to sync session cache to offscreen:", error);
  }
}

function openSessionDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_DB_STORE)) {
        db.createObjectStore(SESSION_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function sessionDbSet(key, value) {
  const db = await openSessionDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_DB_STORE, "readwrite");
      tx.objectStore(SESSION_DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted"));
    });
  } finally {
    db.close();
  }
}

async function sessionDbGet(key) {
  const db = await openSessionDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_DB_STORE, "readonly");
      const request = tx.objectStore(SESSION_DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
    });
  } finally {
    db.close();
  }
}

async function syncSessionCacheToIndexedDb() {
  try {
    await persistSessionCacheToIndexedDbNow();
  } catch (error) {
    console.warn("[Popup] Failed to sync session cache to IndexedDB:", error);
  }
}

async function persistSessionCacheToIndexedDbNow() {
  const serialized = serializeAudioBufferForTransfer(loadedAudioBuffer);
  console.log("[Sync-IndexedDB] Serialized loadedAudioBuffer:", {
    exists: !!serialized,
    hasChannels: !!serialized?.channels,
    channelCount: serialized?.channels?.length,
    channelLengths: serialized?.channels?.map(ch => ch.length),
    length: serialized?.length,
    sampleRate: serialized?.sampleRate
  });
  await sessionDbSet("loadedAudioData", serialized);
  await sessionDbSet("sourceStemAudioDataByName", serializeSourceStemsForTransfer(sourceStemBuffers));
  await sessionDbSet("waveformSessionState", serializeWaveformSessionState());
  await sessionDbSet("sourceStemMixSettings", sourceStemMixSettings);
  await sessionDbSet("updatedAt", Date.now());
}

function scheduleSessionCacheSync() {
  if (sessionCacheSyncTimer) {
    clearTimeout(sessionCacheSyncTimer);
  }
  sessionCacheSyncTimer = setTimeout(() => {
    sessionCacheSyncTimer = null;
    void syncSessionCacheToOffscreen();
    void syncSessionCacheToIndexedDb();
  }, 200);
}

async function restoreSessionCacheFromOffscreen() {
  let restoredLoadedAudio = false;
  let restoredStems = false;
  let restoredWaveformState = null;
  let restoredStemMixSettings = null;

  // Fast path: read offscreen in-memory cache only when the offscreen document
  // is already alive. Do NOT create it during popup startup, because creating
  // extension contexts while the action popup is opening can cause the popup
  // to be dismissed on some Chrome builds.
  let ready = false;
  try {
    const offscreenUrl = chrome.runtime.getURL("offscreen/offscreen.html");
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    ready = contexts.length > 0;
  } catch (_error) {
    ready = false;
  }

  if (ready) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_SESSION_STATE" });
      const session = response?.sessionState || null;

      if (!loadedAudioBuffer && session?.loadedAudioData) {
        const restored = deserializeAudioBufferFromTransfer(session.loadedAudioData);
        if (restored) {
          loadedAudioBuffer = restored;
          showWaveformEditor();
          updateLoadedAudioButtons();
          setLoadedStatus(`restored audio (${restored.duration.toFixed(1)}s)`);
          restoredLoadedAudio = true;
        }
      }

      if (session?.waveformSessionState) {
        restoredWaveformState = session.waveformSessionState;
      }

      if (session?.sourceStemMixSettings && typeof session.sourceStemMixSettings === "object") {
        restoredStemMixSettings = session.sourceStemMixSettings;
      }

      if (!sourceStemBuffers && session?.sourceStemAudioDataByName) {
        const restoredStemsByName = deserializeSourceStemsFromTransfer(session.sourceStemAudioDataByName);
        if (restoredStemsByName) {
          setSourceStemBuffers(restoredStemsByName);
          sourceStemMixSettings = normalizeSourceStemMixSettings(restoredStemMixSettings, restoredStemsByName);
          renderSourceStemControls();
          setStemStatus("restored source stems");
          restoredStems = true;
        }
      }
    } catch (error) {
      console.warn("[Popup] Failed to restore session cache from offscreen:", error);
    }
  }

  // Durable path: fallback to IndexedDB (survives popup closes reliably).
  try {
    if (!restoredLoadedAudio && !loadedAudioBuffer) {
      const loadedAudioData = await sessionDbGet("loadedAudioData");
      console.log("[Restore-IndexedDB] Retrieved loadedAudioData:", {
        exists: !!loadedAudioData,
        hasChannels: !!loadedAudioData?.channels,
        channelCount: loadedAudioData?.channels?.length,
        length: loadedAudioData?.length,
        sampleRate: loadedAudioData?.sampleRate,
        channel0Length: loadedAudioData?.channels?.[0]?.length
      });
      const restored = deserializeAudioBufferFromTransfer(loadedAudioData);
      if (restored) {
        console.log("[Restore-IndexedDB] Successfully deserialized to AudioBuffer:", {
          duration: restored.duration,
          channels: restored.numberOfChannels,
          sampleRate: restored.sampleRate,
          length: restored.length
        });
        loadedAudioBuffer = restored;
        showWaveformEditor();
        updateLoadedAudioButtons();
        setLoadedStatus(`restored audio (${restored.duration.toFixed(1)}s)`);
        restoredLoadedAudio = true;
      }
    }

    if (!restoredWaveformState) {
      restoredWaveformState = await sessionDbGet("waveformSessionState");
    }

    if (!restoredStemMixSettings) {
      restoredStemMixSettings = await sessionDbGet("sourceStemMixSettings");
    }

    if (!restoredStems && !sourceStemBuffers) {
      const sourceStemAudioDataByName = await sessionDbGet("sourceStemAudioDataByName");
      const restoredStemsByName = deserializeSourceStemsFromTransfer(sourceStemAudioDataByName);
      if (restoredStemsByName) {
        setSourceStemBuffers(restoredStemsByName);
        sourceStemMixSettings = normalizeSourceStemMixSettings(restoredStemMixSettings, restoredStemsByName);
        renderSourceStemControls();
        setStemStatus("restored source stems");
        restoredStems = true;
      }
    }
  } catch (error) {
    console.warn("[Popup] Failed to restore session cache from IndexedDB:", error);
  }

  if (restoredLoadedAudio) {
    applyRestoredWaveformSessionState(restoredWaveformState);
  }

  return { restoredLoadedAudio, restoredStems };
}

async function saveDownloadTrace(step, details = {}) {
  try {
    await chrome.storage.local.set({
      lastDownloadTrace: {
        ts: Date.now(),
        step,
        ...details
      }
    });
  } catch (_e) {
    // Non-fatal: tracing should never break downloads.
  }
}

async function restoreDownloadTraceStatus() {
  try {
    const { lastDownloadTrace } = await chrome.storage.local.get(["lastDownloadTrace"]);
    if (!lastDownloadTrace?.step) return;
    const ageSec = Math.max(0, Math.floor((Date.now() - Number(lastDownloadTrace.ts || 0)) / 1000));
    setStatus(`Idle (last dl: ${lastDownloadTrace.step}, ${ageSec}s ago)`);
  } catch (_e) {
    // Non-fatal.
  }
}

function withTimeout(promise, timeoutMs, fallbackValue) {
  let timerId = null;
  const timeoutPromise = new Promise((resolve) => {
    timerId = setTimeout(() => resolve(fallbackValue), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timerId) {
      clearTimeout(timerId);
    }
  });
}

async function emergencyStartupUnmuteSweep() {
  // Keep popup startup extremely light: delegate sweep to background.
  try {
    await chrome.runtime.sendMessage({ type: "EMERGENCY_UNMUTE_SWEEP" });
  } catch (_error) {
    // Non-fatal.
  }
}

async function activeTabIsWebPage() {
  const tab = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
  });
  const url = String(tab?.url || "");
  return /^https?:\/\//i.test(url);
}

async function refreshPopupBackdropFromActiveTab() {
  const activeTab = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
  });

  const activeUrl = String(activeTab?.url || "");
  if (!activeTab?.windowId || isUncapturableTabUrl(activeUrl)) {
    clearPopupBackdropImage();
    return false;
  }

  return await new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(activeTab.windowId, { format: "jpeg", quality: 72 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.warn("[Popup] backdrop capture skipped:", chrome.runtime.lastError.message);
        clearPopupBackdropImage();
        resolve(false);
        return;
      }

      if (!dataUrl) {
        clearPopupBackdropImage();
        resolve(false);
        return;
      }

      applyPopupBackdropImage(dataUrl);
      resolve(true);
    });
  });
}

function setCompanionStatus(text) {
  if (!companionStatusEl) return;
  applySemanticStatus(companionStatusEl, `Pro Engine: ${text}`, stemSectionEl);
  // Show/hide the setup instructions based on companion availability
  const setupHint = document.getElementById("companionSetupHint");
  if (setupHint) {
    setupHint.hidden = companionEngineAvailable;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 0, extraSignal = null) {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(url, { ...options, signal: extraSignal || options.signal });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // If an external signal fires (e.g. user cancelled), abort our internal controller too.
  const onExternalAbort = () => controller.abort();
  extraSignal?.addEventListener("abort", onExternalAbort);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    extraSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function checkCompanionEngine(options = {}) {
  const { silent = false } = options;

  if (!silent) {
    setCompanionStatus("checking...");
  }

  try {
    const response = await fetchWithTimeout(`${COMPANION_API_BASE_URL}/v1/health`, {
      method: "GET",
      cache: "no-store"
    }, COMPANION_HEALTH_TIMEOUT_MS);

    if (!response.ok) {
      throw new Error(`health check failed (${response.status})`);
    }

    let payload = {};
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }

    const profileLocked = isCompanionProfileLocked(payload);
    const cpuFallbackProfile = isCompanionProfileCpuFallback(payload);

    if (!profileLocked && !cpuFallbackProfile) {
      companionEngineAvailable = false;
      companionEngineVersion = "profile-drift";
      const driftMessage = getCompanionProfileDriftMessage(payload);
      setCompanionStatus(`profile drift - restart companion app`);
      if (!silent) {
        console.warn("[Stems] Companion profile drift:", driftMessage, payload);
      }
      if (companionRetryTimer === null) {
        companionRetryTimer = setTimeout(async () => {
          companionRetryTimer = null;
          await checkCompanionEngine({ silent: true });
        }, COMPANION_RETRY_INTERVAL_MS);
      }
      updateLoadedAudioButtons();
      return false;
    }

    companionEngineAvailable = true;
    if (cpuFallbackProfile && !profileLocked) {
      companionEngineVersion = "cpu-fallback";
      setCompanionStatus("connected (cpu fallback)");
      if (!silent) {
        console.warn("[Stems] Companion running in CPU fallback mode; separation will be slower.");
      }
    } else {
      companionEngineVersion = String(payload?.version || payload?.engine || "ready");
      setCompanionStatus(`connected (${companionEngineVersion})`);
    }

    // Cancel any pending retry timer now that we're online
    if (companionRetryTimer !== null) {
      clearTimeout(companionRetryTimer);
      companionRetryTimer = null;
    }
  } catch (error) {
    companionEngineAvailable = false;
    companionEngineVersion = "offline";
    setCompanionStatus("not detected - install/start companion app");
    if (!silent) {
      console.warn("[Stems] Companion engine unavailable:", error);
    }

    // Schedule a background retry so the extension auto-detects when server starts
    if (companionRetryTimer === null) {
      companionRetryTimer = setTimeout(async () => {
        companionRetryTimer = null;
        await checkCompanionEngine({ silent: true });
      }, COMPANION_RETRY_INTERVAL_MS);
    }
  }

  updateLoadedAudioButtons();
  return companionEngineAvailable;
}

// One-click self-heal: ask the engine to restart (it exits non-zero so the LaunchAgent
// relaunches a fresh, re-configured process), then poll health until it warms back up.
// This clears profile drift or a wedged engine WITHOUT the user opening a Terminal.
async function restartCompanionEngine() {
  if (companionRestartInProgress) {
    return;
  }
  companionRestartInProgress = true;
  if (restartCompanionBtn) {
    restartCompanionBtn.disabled = true;
  }
  // Stop any pending background health retry so it can't race the restart poll loop.
  if (companionRetryTimer !== null) {
    clearTimeout(companionRetryTimer);
    companionRetryTimer = null;
  }
  setCompanionStatus("restarting engine...");

  try {
    // Ask the engine to exit non-zero so the LaunchAgent relaunches a fresh process
    // (KeepAlive -> SuccessfulExit=false). The socket may drop as the process dies
    // mid-response, so a failure here is EXPECTED and not treated as an error.
    try {
      await fetchWithTimeout(`${COMPANION_API_BASE_URL}/v1/restart`, {
        method: "POST",
        cache: "no-store"
      }, COMPANION_HEALTH_TIMEOUT_MS);
    } catch (_error) {
      // Expected: process may exit before the response is flushed.
    }

    // Poll health until the relaunched process reports back (locked + warmed), or time out.
    const deadline = Date.now() + COMPANION_RESTART_MAX_WAIT_MS;
    let recovered = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, COMPANION_RESTART_POLL_INTERVAL_MS));
      const secondsLeft = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setCompanionStatus(`restarting engine... (warming up, ${secondsLeft}s)`);
      if (await checkCompanionEngine({ silent: true })) {
        recovered = true;
        break;
      }
    }

    // Final non-silent check so the status reflects the true end state and, if still
    // down, reschedules the normal background retry.
    await checkCompanionEngine({ silent: false });
    if (!recovered) {
      console.warn("[Stems] Companion did not come back within the restart window.");
    }
  } finally {
    companionRestartInProgress = false;
    if (restartCompanionBtn) {
      restartCompanionBtn.disabled = false;
    }
  }
}

function setStemBusy(isBusy) {
  stemGenerationInProgress = Boolean(isBusy);
  if (generateStemsBtn) {
    generateStemsBtn.dataset.busy = stemGenerationInProgress ? "true" : "false";
    const modeLabel = isStudioStemQualityEnabled() ? "Studio" : "Fast";
    generateStemsBtn.textContent = stemGenerationInProgress
      ? `Generating Source Stems (${modeLabel})...`
      : "Generate Source Stems";
  }
  if (cancelStemGenerationBtn) {
    cancelStemGenerationBtn.hidden = !stemGenerationInProgress;
  }
  updateLoadedAudioButtons();
}

function setStemProgress(percent = null, text = "") {
  if (!stemProgressEl || !stemProgressFillEl || !stemProgressTextEl) {
    return;
  }

  const hasProgress = typeof percent === "number" && Number.isFinite(percent);
  if (!stemGenerationInProgress && !hasProgress && !text) {
    stemProgressEl.hidden = true;
    stemProgressFillEl.style.width = "0%";
    stemProgressTextEl.textContent = "";
    return;
  }

  stemProgressEl.hidden = false;
  if (hasProgress) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    stemProgressFillEl.style.width = `${clamped}%`;
  }
  stemProgressTextEl.textContent = text || (hasProgress ? `${Math.round(percent)}%` : "Working...");
}

function ensureStemMixPlaybackEnabled() {
  if (!useStemMixPlaybackInput.checked) {
    useStemMixPlaybackInput.checked = true;
    saveSettings();
  }
}

function setInstrumentalPreparationUi({ visible = false, phase = "idle", headline = "", detail = "", progress = null, progressText = "" } = {}) {
  if (!instrumentalPrepCardEl || !instrumentalPrepHeadlineEl || !instrumentalPrepDetailEl || !instrumentalPrepProgressEl || !instrumentalPrepProgressFillEl || !instrumentalPrepProgressTextEl) {
    return;
  }

  instrumentalPrepCardEl.hidden = !visible;
  instrumentalPrepCardEl.dataset.phase = phase;
  instrumentalPrepHeadlineEl.textContent = headline || "Preparing instrumental playback";
  instrumentalPrepDetailEl.textContent = detail || "";

  const hasProgress = typeof progress === "number" && Number.isFinite(progress);
  instrumentalPrepProgressEl.hidden = !visible;
  instrumentalPrepProgressFillEl.style.width = hasProgress
    ? `${Math.max(0, Math.min(100, Math.round(progress)))}%`
    : "12%";
  instrumentalPrepProgressTextEl.textContent = progressText || (hasProgress ? `${Math.round(progress)}%` : "Working...");

  // Show download button only when the processed stem is ready and playing.
  if (downloadPreparedInstrumentalBtn) {
    const showDownload = Boolean(visible && phase === "playback" && preparedInstrumentalBuffer);
    downloadPreparedInstrumentalBtn.hidden = !showDownload;
    if (showDownload) {
      downloadPreparedInstrumentalBtn.textContent = preparedInstrumentalStemName === "vocals"
        ? "\u2b07 Download Vocals"
        : "\u2b07 Download Instrumental";
    }
  }
}

function clearInstrumentalPreparationUi() {
  setInstrumentalPreparationUi({
    visible: false,
    phase: "idle",
    headline: "",
    detail: "",
    progress: 0,
    progressText: ""
  });
}

function startProcessingProgressTimer(songDurationSeconds) {
  stopProcessingProgressTimer();
  // Empirically: MPS with 30s segments processes at ~1.5×–2× audio duration.
  // We estimate 2× as the ETA so the bar reaches 95% just before typical completion.
  const estimatedMs = Math.max(30000, songDurationSeconds * 2 * 1000);
  preparedInstrumentalProcessingStartMs = Date.now();
  preparedInstrumentalProcessingEstimatedMs = estimatedMs;

  const tick = () => {
    if (!preparedInstrumentalPreparing) return;
    const elapsedMs = Date.now() - preparedInstrumentalProcessingStartMs;
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const elapsedMin = Math.floor(elapsedSec / 60);
    const elapsedDisplay = elapsedMin > 0
      ? `${elapsedMin}m ${elapsedSec % 60}s elapsed`
      : `${elapsedSec}s elapsed`;

    const remainingMs = Math.max(0, estimatedMs - elapsedMs);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const remainingMin = Math.floor(remainingSec / 60);
    const etaDisplay = remainingSec <= 0
      ? "almost done..."
      : (remainingMin > 0
        ? `~${remainingMin}m ${remainingSec % 60}s remaining`
        : `~${remainingSec}s remaining`);

    // Fill to max 95% while still processing; jump to 100% when done.
    const fillPct = Math.min(95, (elapsedMs / estimatedMs) * 100);

    setInstrumentalPreparationUi({
      visible: true,
      phase: "process",
      headline: preparedInstrumentalTrackTitle || "Processing...",
      detail: `Separating vocals from the track using Demucs AI. The track loops silently while this runs — first-time processing usually takes a little longer than 2 full plays of the song.`,
      progress: fillPct,
      progressText: `${elapsedDisplay} · ${etaDisplay}`
    });

    preparedInstrumentalProcessingTimer = setTimeout(tick, 1000);
  };
  preparedInstrumentalProcessingTimer = setTimeout(tick, 1000);
}

function stopProcessingProgressTimer() {
  if (preparedInstrumentalProcessingTimer) {
    clearTimeout(preparedInstrumentalProcessingTimer);
    preparedInstrumentalProcessingTimer = null;
  }
  preparedInstrumentalProcessingStartMs = 0;
  preparedInstrumentalProcessingEstimatedMs = 0;
}

function setVoiceIsolationStatus(text) {
  applySemanticStatus(voiceIsolationStatusEl, `Voice Isolation: ${text}`, voiceIsolationSectionEl);
}

function getVoiceIsolationModeLabel(mode = voiceIsolationMode) {
  return mode === "instrumental" ? "instrumental-only" : "voice-only";
}

function refreshVoiceIsolationStatusWithMode() {
  if (!voiceIsolationEnabled) {
    return;
  }
  if (preparedInstrumentalPreparing) {
    if (preparedInstrumentalState === PREPARED_INSTRUMENTAL_STATE.CAPTURING) {
      setVoiceIsolationStatus("preparing full-track instrumental");
    } else if (preparedInstrumentalState === PREPARED_INSTRUMENTAL_STATE.PROCESSING) {
      setVoiceIsolationStatus("processing full-track instrumental");
    } else if (preparedInstrumentalState === PREPARED_INSTRUMENTAL_STATE.PLAYBACK_READY) {
      setVoiceIsolationStatus("prepared instrumental ready");
    } else {
      setVoiceIsolationStatus("preparing full-track instrumental");
    }
    return;
  }
  if (preparedInstrumentalActive) {
    if (preparedInstrumentalState === PREPARED_INSTRUMENTAL_STATE.LOOPING) {
      setVoiceIsolationStatus("prepared instrumental — looping (disable to stop)");
    } else {
      setVoiceIsolationStatus("prepared instrumental synced to page timeline");
    }
    return;
  }
  if (liveCompanionIsolationActive) {
    if (liveCompanionTookoverRouting) {
      setVoiceIsolationStatus(`active: AI ${getVoiceIsolationModeLabel()} (live)`);
    }
    // While warmup countdown is running, leave the status as-is (countdown manages it).
    return;
  }
  const modelName = voiceIsolationProcessor?.modelName || "active";
  const outputType = voiceIsolationProcessor?.modelOutputType || "vocals";
  setVoiceIsolationStatus(`active: ${modelName}/${outputType} (${getVoiceIsolationModeLabel()})`);
}

async function setVoiceIsolationMode(mode, options = {}) {
  // Voice Isolation was removed from the UI on 2026-08-05 after repeated live-capture
  // failures (CAPTURE_FAIL_TRACK_CHANGED). This entry point is neutralized so isolation
  // can never start; Stem Separation and all capture/FX paths are unaffected.
  return;
  const { autoEnable = true } = options;
  const previousMode = voiceIsolationMode;
  voiceIsolationMode = mode === "instrumental" ? "instrumental" : "vocals";
  if (voiceIsolationModeInput) {
    voiceIsolationModeInput.value = voiceIsolationMode;
  }

  // Determine whether isolation is already running (companion or worklet).
  const companionRunning = liveCompanionIsolationActive;
  const workletRunning = Boolean(voiceIsolationProcessor?.isInitialized);
  const preparedRunning = preparedInstrumentalPreparing || preparedInstrumentalActive;
  const isAlreadyActive = voiceIsolationEnabled && (companionRunning || workletRunning || preparedRunning);

  // Start isolation via a pending-guarded toggle. Selecting a mode from the dropdown
  // auto-starts isolation; without this guard the Start Isolation button stayed
  // pressable during that async start, so a follow-up click fired a SECOND
  // toggleVoiceIsolation. The second start's stopPreparedInstrumentalMode() bumped the
  // session id and aborted the first prepared run mid-capture — the track restarted to
  // 0:00 and played once but never looped and no isolated stem was produced. Setting
  // voiceIsolationTogglePending (which updateVoiceIsolationControlButtons() reads to
  // disable the button) closes that window, and a toggle already in flight is not re-fired.
  const startIsolationGuarded = async () => {
    if (voiceIsolationTogglePending) {
      return;
    }
    voiceIsolationTogglePending = true;
    updateVoiceIsolationControlButtons();
    try {
      await toggleVoiceIsolation(true);
    } finally {
      voiceIsolationTogglePending = false;
      updateVoiceIsolationControlButtons();
    }
  };

  // If isolation is not yet active, enable it. Skip entirely when a toggle is already
  // pending (a button press mid-flight) so the dropdown can't launch a duplicate start.
  if (autoEnable && stream && !isAlreadyActive && !voiceIsolationTogglePending) {
    if (enableVoiceIsolationInput) {
      enableVoiceIsolationInput.checked = true;
    }
    await startIsolationGuarded();
    refreshVoiceIsolationStatusWithMode();
    saveSettings();
    return;
  }

  if (preparedRunning && voiceIsolationMode !== previousMode && !voiceIsolationTogglePending) {
    stopPreparedInstrumentalMode({ preserveBuffer: false, keepStatus: true });
    if (autoEnable && stream) {
      if (enableVoiceIsolationInput) {
        enableVoiceIsolationInput.checked = true;
      }
      await startIsolationGuarded();
      refreshVoiceIsolationStatusWithMode();
      saveSettings();
      return;
    }
  }

  // Isolation is already running — only restart companion when the mode actually changes.
  if (companionRunning && stream && voiceIsolationMode !== previousMode) {
    await startLiveCompanionIsolation();
    refreshVoiceIsolationStatusWithMode();
  } else if (preparedRunning) {
    refreshVoiceIsolationStatusWithMode();
  } else if (workletRunning) {
    voiceIsolationProcessor.updateMode(voiceIsolationMode);
    voiceIsolationProcessor.updateStrength(voiceIsolationStrength);
    refreshVoiceIsolationStatusWithMode();
  } else if (companionRunning) {
    // Same mode re-click while companion is active — just refresh status.
    refreshVoiceIsolationStatusWithMode();
  } else if (!stream) {
    setVoiceIsolationStatus(`mode set: ${getVoiceIsolationModeLabel()} (start capture to apply)`);
  } else {
    setVoiceIsolationStatus(`mode set: ${getVoiceIsolationModeLabel()} (enable isolation to apply)`);
  }

  saveSettings();
}

function setButtons(capturing) {
  startBtn.disabled = capturing;
  stopBtn.disabled = !capturing;
  updateRecordingButtons();
  updateLoadedAudioButtons();
  updateVoiceIsolationControlButtons();
}

function updateVoiceIsolationControlButtons() {
  const captureActive = Boolean(audioContext && stream);
  const isolationPipelineActive = Boolean(
    preparedInstrumentalPreparing ||
    preparedInstrumentalActive ||
    liveCompanionIsolationActive ||
    voiceIsolationProcessor?.isInitialized
  );

  if (startVoiceIsolationBtn) {
    startVoiceIsolationBtn.disabled = voiceIsolationTogglePending || !captureActive || isolationPipelineActive;
  }

  if (stopVoiceIsolationBtn) {
    stopVoiceIsolationBtn.disabled = voiceIsolationTogglePending || !voiceIsolationEnabled;
  }
}

async function setVoiceIsolationFromControls(enable) {
  // Voice Isolation removed from the UI on 2026-08-05 (see setVoiceIsolationMode).
  // Neutralized so the toggle can never start a capture/prep session.
  return;
  const requestedState = Boolean(enable);

  if (!enableVoiceIsolationInput) {
    return;
  }

  if (voiceIsolationTogglePending) {
    return;
  }

  voiceIsolationTogglePending = true;
  enableVoiceIsolationInput.checked = requestedState;
  updateVoiceIsolationControlButtons();

  try {
    await toggleVoiceIsolation(requestedState);
  } catch (error) {
    console.error("[Voice Isolation] Toggle failed:", error);
    voiceIsolationEnabled = false;
    enableVoiceIsolationInput.checked = false;
    setVoiceIsolationStatus(`failed: ${error?.message || error}`);
  } finally {
    voiceIsolationTogglePending = false;
    updateVoiceIsolationControlButtons();
  }
}

function updateRecordingButtons() {
  const captureActive = Boolean(stream);
  const isRecording = mediaRecorder?.state === "recording";

  startRecordingBtn.disabled = !captureActive || isRecording;
  stopRecordingBtn.disabled = !isRecording;
  downloadWavBtn.disabled = !lastRecordingBlob;
  downloadMp3Btn.disabled = !lastRecordingBlob;
  loadLastRecordingBtn.disabled = !lastRecordingBlob;
  
  // Pause browser audio button is enabled whenever a capture stream is active
  if (pauseBrowserAudioBtn) {
    pauseBrowserAudioBtn.disabled = !Boolean(stream);
  }
  if (skipBackCaptureMediaBtn) {
    skipBackCaptureMediaBtn.disabled = !Boolean(stream);
  }
  if (restartCaptureMediaBtn) {
    restartCaptureMediaBtn.disabled = !Boolean(stream);
  }
  if (prevCaptureMediaTrackBtn) {
    prevCaptureMediaTrackBtn.disabled = !Boolean(stream);
  }
  if (nextCaptureMediaTrackBtn) {
    nextCaptureMediaTrackBtn.disabled = !Boolean(stream);
  }
  if (skipForwardCaptureMediaBtn) {
    skipForwardCaptureMediaBtn.disabled = !Boolean(stream);
  }

  refreshPauseBrowserAudioButton();
}

function updateLoadedAudioButtons() {
  // Recover from stale state: if playback flags stayed true but the source is gone,
  // re-enable Play controls so the user can start again.
  if (recordedAudioIsPlaying && !filePlaybackSource) {
    recordedAudioIsPlaying = false;
  }

  const hasLoadedAudio = Boolean(loadedAudioBuffer);
  const isPlaying = recordedAudioIsPlaying;
  const isPaused = recordedAudioIsPaused;
  const hasStems = Boolean(splitStemBuffers) || Boolean(sourceStemBuffers);
  const hasSourceStems = Boolean(sourceStemBuffers);
  const captureActive = Boolean(stream);

  playLoadedAudioBtn.disabled = !hasLoadedAudio || isPlaying;
  pauseLoadedAudioBtn.disabled = !isPlaying;
  stopLoadedAudioBtn.disabled = !isPlaying && !isPaused;
  if (skipBackLoadedAudioBtn) {
    skipBackLoadedAudioBtn.disabled = !hasLoadedAudio;
  }
  if (replayLoadedAudioBtn) {
    replayLoadedAudioBtn.disabled = !hasLoadedAudio;
  }
  if (skipForwardLoadedAudioBtn) {
    skipForwardLoadedAudioBtn.disabled = !hasLoadedAudio;
  }
  if (stemPlayLoadedAudioBtn) {
    stemPlayLoadedAudioBtn.disabled = !hasLoadedAudio || !hasStems || isPlaying;
  }
  if (stemPauseLoadedAudioBtn) {
    stemPauseLoadedAudioBtn.disabled = !isPlaying;
  }
  if (stemStopLoadedAudioBtn) {
    stemStopLoadedAudioBtn.disabled = !isPlaying && !isPaused;
  }
  downloadProcessedWavBtn.disabled = !hasLoadedAudio;
  generateStemsBtn.disabled = !hasLoadedAudio || stemGenerationInProgress;
  
  // Live stem mixing only works when capturing browser audio
  useLiveStemMixingInput.disabled = !captureActive;
  
  // Stem playback mixing requires generated stems
  useStemMixPlaybackInput.disabled = !hasStems;
  stemLowGainInput.disabled = !splitStemBuffers && !captureActive;
  stemMidGainInput.disabled = !splitStemBuffers && !captureActive;
  stemHighGainInput.disabled = !splitStemBuffers && !captureActive;
  stemLowMuteInput.disabled = !splitStemBuffers && !captureActive;
  stemMidMuteInput.disabled = !splitStemBuffers && !captureActive;
  stemHighMuteInput.disabled = !splitStemBuffers && !captureActive;
  if (downloadStemMixBtn) {
    downloadStemMixBtn.disabled = !hasSourceStems;
  }
  if (downloadAllStemsBtn) {
    downloadAllStemsBtn.disabled = !hasSourceStems;
  }
  if (presetExcludeVocalsBtn) {
    presetExcludeVocalsBtn.disabled = !hasSourceStems;
  }
  if (presetExcludeDrumsBtn) {
    presetExcludeDrumsBtn.disabled = !hasSourceStems;
  }
  if (presetExcludeBassBtn) {
    presetExcludeBassBtn.disabled = !hasSourceStems;
  }
  if (presetExcludeDrumsBassBtn) {
    presetExcludeDrumsBassBtn.disabled = !hasSourceStems;
  }
  if (presetVocalsOnlyBtn) {
    presetVocalsOnlyBtn.disabled = !hasSourceStems;
  }
  if (presetEnableAllStemsBtn) {
    presetEnableAllStemsBtn.disabled = !hasSourceStems;
  }

  if (!hasStems) {
    useStemMixPlaybackInput.checked = false;
  }
  
  if (!captureActive) {
    useLiveStemMixingInput.checked = false;
    liveStemMixingEnabled = false;
  }
}

function updateStemGainUI() {
  stemLowGainValueEl.textContent = `${Math.round(Number(stemLowGainInput.value) * 100)}%`;
  stemMidGainValueEl.textContent = `${Math.round(Number(stemMidGainInput.value) * 100)}%`;
  stemHighGainValueEl.textContent = `${Math.round(Number(stemHighGainInput.value) * 100)}%`;
}

function updateVoiceIsolationStrengthUI() {
  voiceIsolationStrengthValueEl.textContent = `${Math.round(Number(voiceIsolationStrengthInput.value) * 100)}%`;
}

function updateProcessingDelayUI() {
  if (!processingDelayInput || !processingDelayValueEl) {
    return;
  }
  processingDelayValueEl.textContent = `${Number(processingDelayInput.value).toFixed(1)}s`;
}

function formatDurationMs(durationMs) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getPreferredRecordingMimeType() {
  const candidates = [
    "audio/mpeg",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "";
}

function updateBassUI() {
  bassValueEl.textContent = `${bassInput.value} dB`;
}

function updateVolumeUI() {
  volumeValueEl.textContent = `${Math.round(Number(volumeInput.value) * 100)}%`;
}

function updateEffectMixUI() {
  effectMixValueEl.textContent = `${Math.round(Number(effectMixInput.value) * 100)}%`;
}

function updateSpeedUI() {
  speedValueEl.textContent = `${Number(speedInput.value).toFixed(2)}x`;
}

function updatePitchUI() {
  const semitones = Number(pitchInput.value);
  pitchValueEl.textContent = `${semitones >= 0 ? "+" : ""}${semitones} st`;
}

function updateReverbUI() {
  reverbValueEl.textContent = `${Math.round(Number(reverbInput.value) * 100)}%`;
}

function updateReverbSizeUI() {
  reverbSizeValueEl.textContent = `${Number(reverbSizeInput.value).toFixed(1)} s`;
}

function updateReverbToneUI() {
  reverbToneValueEl.textContent = `${Math.round(Number(reverbToneInput.value) * 100)}%`;
}

function updateChorusMixUI() {
  chorusMixValueEl.textContent = `${Math.round(Number(chorusMixInput.value) * 100)}%`;
}

function updateChorusRateUI() {
  chorusRateValueEl.textContent = `${Number(chorusRateInput.value).toFixed(1)} Hz`;
}

function updateChorusDepthUI() {
  chorusDepthValueEl.textContent = `${Math.round(Number(chorusDepthInput.value) * 1000)} ms`;
}

function updateChorusWidthUI() {
  chorusWidthValueEl.textContent = `${Math.round(Number(chorusWidthInput.value) * 100)}%`;
}

function updateDelayMixUI() {
  delayMixValueEl.textContent = `${Math.round(Number(delayMixInput.value) * 100)}%`;
}

function updateDelayTimeUI() {
  delayTimeValueEl.textContent = `${Math.round(Number(delayTimeInput.value) * 1000)} ms`;
}

function updateDelayFeedbackUI() {
  delayFeedbackValueEl.textContent = `${Math.round(Number(delayFeedbackInput.value) * 100)}%`;
}

function updateDistortionUI() {
  distortionValueEl.textContent = `${Math.round(Number(distortionInput.value))}%`;
}

function getPitchMultiplier() {
  return Math.pow(2, Number(pitchInput.value) / 12);
}

function getCombinedPlaybackRate() {
  // Keep speed independent from pitch to prevent coupled tempo/pitch behavior.
  return Number(speedInput.value);
}

function isSourceStemPreviewActive() {
  const stemPreviewRequested = recordedAudioIsPlaying || recordedAudioIsPaused
    ? lastLoadedPlaybackUsedStemMix
    : Boolean(useStemMixPlaybackInput?.checked);
  return Boolean(stemPreviewRequested && sourceStemBuffers);
}

function getLoadedPlaybackRate() {
  // Stem audition should be time-accurate: avoid accidental speed-up/slow-down.
  return isSourceStemPreviewActive() ? 1 : getCombinedPlaybackRate();
}

function getEffectivePitchSemitones() {
  // Stem audition should be pitch-accurate by default.
  return isSourceStemPreviewActive() ? 0 : Number(pitchInput.value);
}

let _saveSettingsTimer = null;
function saveSettings() {
  clearTimeout(_saveSettingsTimer);
  _saveSettingsTimer = setTimeout(() => {
    chrome.storage.local.set({
      bass: Number(bassInput.value),
    volume: Number(volumeInput.value),
    effectMix: Number(effectMixInput.value),
    speed: Number(speedInput.value),
    pitch: Number(pitchInput.value),
    reverb: Number(reverbInput.value),
    reverbEnable: reverbEnable.checked,
    reverbType: reverbTypeInput.value,
    reverbSize: Number(reverbSizeInput.value),
    reverbTone: Number(reverbToneInput.value),
    chorusMix: Number(chorusMixInput.value),
    chorusEnable: chorusEnable.checked,
    chorusRate: Number(chorusRateInput.value),
    chorusType: chorusTypeInput.value,
    chorusDepth: Number(chorusDepthInput.value),
    chorusWidth: Number(chorusWidthInput.value),
    delayEnable: delayEnable.checked,
    delayMix: Number(delayMixInput.value),
    delayType: delayTypeInput.value,
    delayTime: Number(delayTimeInput.value),
    delayFeedback: Number(delayFeedbackInput.value),
    distortion: Number(distortionInput.value),
    distortionEnable: distortionEnable.checked,
    activeFilterPreset,
    useLiveStemMixing: useLiveStemMixingInput.checked,
    useStemMixPlayback: useStemMixPlaybackInput.checked,
    useStudioStemQuality: useStudioStemQualityInput ? useStudioStemQualityInput.checked : false,
    stemLowGain: Number(stemLowGainInput.value),
    stemMidGain: Number(stemMidGainInput.value),
    stemHighGain: Number(stemHighGainInput.value),
    stemLowMute: stemLowMuteInput.checked,
    stemMidMute: stemMidMuteInput.checked,
    stemHighMute: stemHighMuteInput.checked,
    stemCleanupState,
    autoVocalCleanupEnabled,
    autoVocalCleanupStrength,
    voiceIsolationEnabled: enableVoiceIsolationInput.checked,
    voiceIsolationStrength: Number(voiceIsolationStrengthInput.value),
    voiceIsolationMode,
      voiceProcessingDelay: processingDelayInput ? Number(processingDelayInput.value) : voiceProcessingDelay
    });
  }, 300);
}

async function saveLastRecordingBlob() {
  if (!lastRecordingBlob) {
    console.log("[Popup] No recording to save");
    return;
  }

  try {
    // Use FileReader data URL to avoid call-stack limits on large recordings.
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.readAsDataURL(lastRecordingBlob);
    });

    await chrome.storage.local.set({
      lastRecordingBlobDataUrl: dataUrl
    });
    console.log("[Popup] Saved recording blob to storage");
  } catch (error) {
    console.error("[Popup] Error saving recording blob:", error);
    setRecordingStatus("recording saved in-memory only (storage restore unavailable)");
  }
}

async function restoreLastRecordingBlob() {
  try {
    const { lastRecordingBlobDataUrl } = await chrome.storage.local.get([
      "lastRecordingBlobDataUrl"
    ]);

    if (lastRecordingBlobDataUrl) {
      const response = await fetch(lastRecordingBlobDataUrl);
      lastRecordingBlob = await response.blob();
      lastRecordingObjectUrl = URL.createObjectURL(lastRecordingBlob);
      console.log("[Popup] Restored recording blob from storage");
      updateRecordingButtons();
      return true;
    }
  } catch (error) {
    console.error("[Popup] Error restoring recording blob:", error);
  }
  return false;
}

async function restoreSettings() {
  const {
    uiTheme = "light",
    uiMode = "pro",
    uiTab = "capture",
    bass = 0,
    volume = 1,
    effectMix = 1,
    speed = 1,
    pitch = 0,
    reverb = 0,
    reverbEnable: reverbEnableState = false,
    reverbType = "hall",
    reverbSize = 4.0,
    reverbTone = 0.6,
    chorusMix = 0,
    chorusEnable: chorusEnableState = false,
    chorusRate = 1.2,
    chorusType = "classic",
    chorusDepth = 0.008,
    chorusWidth = 0.5,
    delayEnable: delayEnableState = false,
    delayMix = 0,
    delayType = "digital",
    delayTime = 0.22,
    delayFeedback = 0.35,
    distortion = 0,
    distortionEnable: distortionEnableState = false,
    activeFilterPreset: storedActiveFilterPreset = null,
    useLiveStemMixing = false,
    useStemMixPlayback = false,
    useStudioStemQuality = false,
    stemLowGain = 1,
    stemMidGain = 1,
    stemHighGain = 1,
    stemLowMute = false,
    stemMidMute = false,
    stemHighMute = false,
    stemCleanupState: storedStemCleanupState = {},
    autoVocalCleanupEnabled: storedAutoVocalCleanupEnabled = true,
    autoVocalCleanupStrength: storedAutoVocalCleanupStrength = 0.55,
    voiceIsolationEnabled: storedVoiceIsolationEnabled = false,
    voiceIsolationStrength: storedVoiceIsolationStrength = 1,
    voiceIsolationMode: storedVoiceIsolationMode = "vocals",
    voiceProcessingDelay: storedVoiceProcessingDelay = 1.5
  } = await chrome.storage.local.get([
    "uiTheme",
    "uiMode",
    "uiTab",
    "bass",
    "volume",
    "effectMix",
    "speed",
    "pitch",
    "reverb",
    "reverbEnable",
    "reverbType",
    "reverbSize",
    "reverbTone",
    "chorusMix",
    "chorusEnable",
    "chorusRate",
    "chorusType",
    "chorusDepth",
    "chorusWidth",
    "delayEnable",
    "delayMix",
    "delayType",
    "delayTime",
    "delayFeedback",
    "distortion",
    "distortionEnable",
    "activeFilterPreset",
    "useLiveStemMixing",
    "useStemMixPlayback",
    "useStudioStemQuality",
    "stemLowGain",
    "stemMidGain",
    "stemHighGain",
    "stemLowMute",
    "stemMidMute",
    "stemHighMute",
    "stemCleanupState",
    "autoVocalCleanupEnabled",
    "autoVocalCleanupStrength",
    "voiceIsolationEnabled",
    "voiceIsolationStrength",
    "voiceIsolationMode",
    "voiceProcessingDelay"
  ]);

  bassInput.value = String(bass);
  volumeInput.value = String(volume);
  effectMixInput.value = String(effectMix);
  speedInput.value = String(speed);
  pitchInput.value = String(pitch);
  reverbInput.value = String(reverb);
  reverbEnable.checked = reverbEnableState;
  reverbTypeInput.value = reverbType;
  reverbSizeInput.value = String(reverbSize);
  reverbToneInput.value = String(reverbTone);
  chorusMixInput.value = String(chorusMix);
  chorusEnable.checked = chorusEnableState;
  chorusRateInput.value = String(chorusRate);
  chorusTypeInput.value = chorusType;
  chorusDepthInput.value = String(chorusDepth);
  chorusWidthInput.value = String(chorusWidth);
  delayEnable.checked = delayEnableState;
  delayMixInput.value = String(delayMix);
  delayTypeInput.value = delayType;
  delayTimeInput.value = String(delayTime);
  delayFeedbackInput.value = String(delayFeedback);
  distortionInput.value = String(distortion);
  distortionEnable.checked = distortionEnableState;
  activeFilterPreset = storedActiveFilterPreset;
  useLiveStemMixingInput.checked = useLiveStemMixing;
  liveStemMixingEnabled = useLiveStemMixing;
  useStemMixPlaybackInput.checked = useStemMixPlayback;
  if (useStudioStemQualityInput) {
    useStudioStemQualityInput.checked = useStudioStemQuality;
  }
  stemLowGainInput.value = String(stemLowGain);
  stemMidGainInput.value = String(stemMidGain);
  stemHighGainInput.value = String(stemHighGain);
  stemLowMuteInput.checked = stemLowMute;
  stemMidMuteInput.checked = stemMidMute;
  stemHighMuteInput.checked = stemHighMute;
  stemCleanupState = storedStemCleanupState && typeof storedStemCleanupState === "object"
    ? storedStemCleanupState
    : {};
  autoVocalCleanupEnabled = Boolean(storedAutoVocalCleanupEnabled);
  autoVocalCleanupStrength = Math.max(0, Math.min(1, Number(storedAutoVocalCleanupStrength ?? 0.55)));
  if (autoVocalCleanupEnabledInput) {
    autoVocalCleanupEnabledInput.checked = autoVocalCleanupEnabled;
  }
  if (autoVocalCleanupStrengthInput) {
    autoVocalCleanupStrengthInput.value = String(autoVocalCleanupStrength);
  }
  // Do not auto-enable isolation from persisted state on popup load.
  // Users must explicitly enable it each session to avoid accidental mute/pause behavior.
  // If isolation is already active in this popup runtime, do not wipe state here.
  const isolationActiveNow = preparedInstrumentalPreparing || preparedInstrumentalActive || liveCompanionIsolationActive;
  enableVoiceIsolationInput.checked = isolationActiveNow;
  voiceIsolationEnabled = isolationActiveNow;
  voiceIsolationStrengthInput.value = String(storedVoiceIsolationStrength);
  voiceIsolationStrength = storedVoiceIsolationStrength;
  voiceIsolationMode = storedVoiceIsolationMode === "instrumental" ? "instrumental" : "vocals";
  if (voiceIsolationModeInput) {
    voiceIsolationModeInput.value = voiceIsolationMode;
  }
  if (processingDelayInput) {
    processingDelayInput.value = String(storedVoiceProcessingDelay);
  }
  voiceProcessingDelay = storedVoiceProcessingDelay;
  applyUiTheme(uiTheme, { persist: false });
  applyUiTab(uiTab, { persist: false });
  applyAppearanceSettings();

  updateBassUI();
  updateVolumeUI();
  updateEffectMixUI();
  updateSpeedUI();
  updatePitchUI();
  updateReverbUI();
  updateReverbSizeUI();
  updateReverbToneUI();
  updateChorusMixUI();
  updateChorusRateUI();
  updateChorusDepthUI();
  updateChorusWidthUI();
  updateDelayMixUI();
  updateDelayTimeUI();
  updateDelayFeedbackUI();
  updateDistortionUI();
  updateStemGainUI();
  updateVoiceIsolationStrengthUI();
  updateProcessingDelayUI();

  if (activeFilterPreset) {
    applyFilterPresetAtStrength();
  }
}

function getReverbStyleProfile(style) {
  const profiles = {
    room: { decay: 2.0, highDamp: 0.8 },
    hall: { decay: 3.4, highDamp: 0.65 },
    plate: { decay: 2.8, highDamp: 0.75 },
    spring: { decay: 1.8, highDamp: 0.5 },
    cathedral: { decay: 5.8, highDamp: 0.55 }
  };
  return profiles[style] || profiles.hall;
}

function generateImpulseResponse(context, seconds = 4.0, decay = 5.0, tone = 0.6) {
  const sampleRate = context.sampleRate;
  const length = Math.floor(sampleRate * seconds);
  const impulse = context.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const channelData = impulse.getChannelData(channel);
    let lowpassState = 0;
    const toneCutoff = 0.02 + tone * 0.45;
    for (let i = 0; i < length; i += 1) {
      const envelope = Math.pow(1 - i / length, decay);
      const noise = (Math.random() * 2 - 1) * envelope;
      lowpassState += toneCutoff * (noise - lowpassState);
      channelData[i] = lowpassState;
    }
  }

  return impulse;
}

function refreshReverbImpulseIfNeeded(context, targetConvolverNode, style, size, tone) {
  if (!targetConvolverNode) {
    return;
  }

  const profile = getReverbStyleProfile(style);
  const seconds = Math.max(0.4, size);
  const decay = Math.max(1.2, profile.decay + size * 0.35);
  const cacheKey = `${style}:${seconds.toFixed(2)}:${decay.toFixed(2)}:${tone.toFixed(2)}`;

  if (cacheKey === reverbImpulseCacheKey) {
    return;
  }

  targetConvolverNode.buffer = generateImpulseResponse(context, seconds, decay, tone * profile.highDamp);
  reverbImpulseCacheKey = cacheKey;
}

function makeDistortionCurve(amount) {
  const samples = 44100;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;
  const k = amount;

  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }

  return curve;
}

// ============= VOICE ISOLATION PROCESSOR =============
// Uses Mid/Side center-channel removal for real-time vocal isolation.
// Vocals are center-panned in stereo music (equal in L and R channels).
// Instrumental mode: attenuate center channel → removes most centered vocals.
// Vocals mode:       isolate center channel → extracts mostly vocals.
class VoiceIsolationProcessor {
  constructor() {
    this.isInitialized = false;
    this.context = null;
    this.modelName = null;
    this.modelOutputType = "ms";
    this.mode = "vocals";

    this.inputNode = null;
    this.outputNode = null;
    this.workletNode = null;
    this._msProcessor = null; // ScriptProcessorNode fallback
    this._strength = 1.0;
  }

  async initialize(context) {
    console.log("[Voice Isolation] Initializing M/S center-channel removal...");

    this.context = context;
    this.inputNode = context.createGain();
    this.outputNode = context.createGain();

    const workletPath = chrome.runtime.getURL('voice-isolation-worklet.js');
    try {
      await context.audioWorklet.addModule(workletPath);

      this.workletNode = new AudioWorkletNode(context, 'voice-isolation-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
        // Default channelCountMode is "explicit" / channelCount 2.  Chrome may
        // up-mix mono → L=R; the worklet handles this via the DRY_FLOOR blend.
      });

      this.workletNode.port.onmessage = (event) => {
        const { type, message } = event.data || {};
        if (type === 'log') {
          console.log(message || event.data);
        } else if (type === 'warning') {
          console.warn(message || event.data);
        }
      };

      this.inputNode.connect(this.workletNode);
      this.workletNode.connect(this.outputNode);

      this.modelName = "M/S Center Removal";
      this.isInitialized = true;

      // Apply stored settings immediately.
      this.updateMode(voiceIsolationMode);
      this.updateStrength(voiceIsolationStrength);

      console.log("[Voice Isolation] ✅ M/S AudioWorklet ready");
      return true;

    } catch (error) {
      console.error("[Voice Isolation] AudioWorklet failed, using ScriptProcessor fallback:", error);
      return this.initializeDSPFallback(context);
    }
  }

  initializeDSPFallback(context) {
    // ScriptProcessorNode M/S fallback when AudioWorklet is unavailable.
    const bufferSize = 4096;
    // Request 2 input channels, but gracefully handle whatever the source provides.
    const sp = context.createScriptProcessor(bufferSize, 2, 2);

    sp.onaudioprocess = (event) => {
      const nIn  = event.inputBuffer.numberOfChannels;
      const nOut = event.outputBuffer.numberOfChannels;
      const inL  = event.inputBuffer.getChannelData(0);
      const inR  = nIn  > 1 ? event.inputBuffer.getChannelData(1)  : null;
      const outL = event.outputBuffer.getChannelData(0);
      const outR = nOut > 1 ? event.outputBuffer.getChannelData(1)  : null;

      const strength       = this._strength;
      const isInstrumental = this.mode === 'instrumental';
      // Same center-subtraction + DRY_FLOOR formula as the AudioWorklet.
      const DRY_FLOOR = 0.15;

      for (let i = 0; i < inL.length; i++) {
        const l = inL[i];
        const r = inR ? inR[i] : l; // treat mono input as L === R

        const mid  = (l + r) * 0.5;
        const side = (l - r) * 0.5;

        let procL, procR;
        if (isInstrumental) {
          // Subtract center from each channel independently (karaoke formula).
          // Polarity on both channels stays consistent — no downstream cancellation.
          procL = l - strength * mid;
          procR = r - strength * mid;
        } else {
          // Keep center, attenuate stereo spread.
          procL = mid + side * (1 - strength);
          procR = mid - side * (1 - strength);
        }

        // 15% dry floor prevents total silence on mono sources.
        outL[i] = (1 - DRY_FLOOR) * procL + DRY_FLOOR * l;
        if (outR) outR[i] = (1 - DRY_FLOOR) * procR + DRY_FLOOR * r;
      }
    };

    this.inputNode.connect(sp);
    sp.connect(this.outputNode);
    this._msProcessor = sp;

    this.modelName = "M/S Center Removal (DSP)";
    this.isInitialized = true;
    this.updateMode(voiceIsolationMode);
    this.updateStrength(voiceIsolationStrength);
    console.log("[Voice Isolation] ✅ M/S ScriptProcessor fallback ready");
    return true;
  }

  updateStrength(strength) {
    const clamped = Math.max(0, Math.min(1, Number(strength) || 0));
    this._strength = clamped;

    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'update-strength', strength: clamped });
    }
    // _msProcessor reads this._strength directly during onaudioprocess.
  }

  updateMode(mode) {
    this.mode = mode === "instrumental" ? "instrumental" : "vocals";

    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'update-mode', mode: this.mode });
    }
    // _msProcessor reads this.mode directly during onaudioprocess.
  }

  connect(destinationNode) {
    if (this.outputNode && destinationNode) {
      this.outputNode.connect(destinationNode);
    }
  }

  disconnect() {
    if (this.outputNode) {
      this.outputNode.disconnect();
    }
  }

  getInputNode() {
    return this.inputNode;
  }

  async cleanup() {
    console.log("[Voice Isolation] Cleaning up processor");

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this._msProcessor) {
      this._msProcessor.disconnect();
      this._msProcessor = null;
    }
    if (this.inputNode) this.inputNode.disconnect();
    if (this.outputNode) this.outputNode.disconnect();

    this.isInitialized = false;
  }
}

async function initializeVoiceIsolation() {
  if (voiceIsolationProcessor && voiceIsolationProcessor.isInitialized) {
    return true;
  }

  voiceIsolationProcessor = new VoiceIsolationProcessor();
  const success = await voiceIsolationProcessor.initialize(audioContext);
  
  if (success) {
    const modelName = voiceIsolationProcessor.modelName || "Unknown";
    const outputType = voiceIsolationProcessor.modelOutputType || "vocals";
    setVoiceIsolationStatus(`active: ${modelName}/${outputType} (${getVoiceIsolationModeLabel()})`);
    console.log(`[Voice Isolation] Ready with model: ${modelName}`);
    
    if (modelName.includes("DSP")) {
      console.warn("[Voice Isolation] ⚠️ Using fallback DSP filters - download AI model for much better results!");
      console.warn("[Voice Isolation] See GET_VOICE_MODEL.md for instructions");
    }
  } else {
    setVoiceIsolationStatus("initialization failed");
  }
  
  return success;
}

async function activateLocalVoiceIsolation(reason = "") {
  const success = await initializeVoiceIsolation();
  if (!success) {
    return false;
  }

  if (inputSourceNode && inputMixNode) {
    try {
      // Disconnect only from inputMixNode (keeps inputLevelAnalyserNode connected).
      try { inputSourceNode.disconnect(inputMixNode); } catch (_e) {}
      inputSourceNode.connect(voiceIsolationProcessor.getInputNode());
      voiceIsolationProcessor.connect(inputMixNode);
      voiceIsolationProcessor.updateMode(voiceIsolationMode);
      voiceIsolationProcessor.updateStrength(voiceIsolationStrength);

      const mediaState = await getActiveTabMediaState();
      const trackTitle = mediaState?.title || "Current track";
      const durationSec = Number.isFinite(mediaState?.duration) ? mediaState.duration : 0;
      const durationLabel = durationSec > 0
        ? `${Math.floor(durationSec / 60)}m ${Math.round(durationSec % 60)}s`
        : "unknown length";
      setInstrumentalPreparationUi({
        visible: true,
        phase: "local-dsp",
        headline: trackTitle,
        detail: `Local DSP ${getVoiceIsolationModeLabel()} active • ${durationLabel}`,
        progress: 100,
        progressText: "Live processing"
      });

      applySafeOriginalMute();
      console.log("[Voice Isolation] Audio routing updated - using local DSP");
    } catch (error) {
      console.error("[Voice Isolation] Local DSP routing failed:", error);
      return false;
    }
  }

  voiceIsolationEnabled = true;

  if (reason) {
    // No silent quality drop: make it unmistakable that this is the degraded local
    // DSP path, not the Pro engine. Force a warning tone (still working, just basic).
    setVoiceIsolationStatus(`Basic mode (local DSP) — ${reason}`);
    applySemanticState(voiceIsolationStatusEl, "warning");
    if (voiceIsolationSectionEl) {
      applySemanticState(voiceIsolationSectionEl, "warning");
    }
  }

  return true;
}

async function toggleVoiceIsolation(enable) {
  if (!audioContext || !stream) {
    console.warn("[Voice Isolation] Cannot toggle - no active audio capture. Click the main Start button to begin tab capture FIRST, then Start Isolation.", { hasAudioContext: Boolean(audioContext), hasStream: Boolean(stream) });
    enableVoiceIsolationInput.checked = false;
    setVoiceIsolationStatus("off - start capture first");
    return;
  }

  if (enable) {
    // Guard against overlapping starts: if a prepared full-track session is already
    // in its capture/processing phase, ignore duplicate enable calls (e.g. a stray
    // button press racing the dropdown auto-start). Starting a second run here would
    // bump the session id and abort the first mid-capture, so it plays once but never
    // loops and no isolated stem is produced. The mode-switch path calls
    // stopPreparedInstrumentalMode() (clearing this flag) before re-enabling, so
    // legitimate restarts still pass.
    if (preparedInstrumentalPreparing) {
      console.warn("[Voice Isolation] Enable ignored — a prepared isolation session is already starting.");
      return;
    }
    console.log("[Voice Isolation] Enabling...");
    console.log("[Voice Isolation] Current mode:", voiceIsolationMode);
    setVoiceIsolationStatus("initializing...");

    // Prepared full-track mode for BOTH voice-only and instrumental-only. Both
    // dropdown options run the identical order-of-operations — seek to 0:00 →
    // mute → capture the full song while looping silently → process the requested
    // stem → play the processed buffer looped perpetually. Only the isolated stem
    // differs (vocals vs instrumental). This replaces the old live-streaming path
    // for voice-only, which continuously processed whatever was playing (no loop,
    // no mute) and bled into the next track.
    console.log(`[Voice Isolation] ${voiceIsolationMode} mode selected - checking companion availability...`);
    const companionAvailable = companionEngineAvailable || await checkCompanionEngine({ silent: true });
    console.log("[Voice Isolation] Companion available:", companionAvailable);
    if (companionAvailable) {
      console.log("[Voice Isolation] Starting prepared full-track mode...");
      const success = await startPreparedInstrumentalMode();
      if (success) {
        voiceIsolationEnabled = true;
        saveSettings();
        return;
      }
      // startPreparedInstrumentalMode already set an error status.
      voiceIsolationEnabled = false;
      enableVoiceIsolationInput.checked = false;
      return;
    }

    // Companion unavailable — fall back to local real-time DSP filter. Surface this
    // loudly (no silent quality drop): the Basic-mode banner tells the user the Pro
    // engine is offline so they can restart it instead of wondering why it sounds off.
    const success = await activateLocalVoiceIsolation("Pro engine offline");
    if (!success) {
      voiceIsolationEnabled = false;
      enableVoiceIsolationInput.checked = false;
      setVoiceIsolationStatus("failed to enable");
    }
  } else {
    console.log("[Voice Isolation] Disabling...");
    voiceIsolationEnabled = false;

    stopPreparedInstrumentalMode({ preserveBuffer: true, keepStatus: false });
    stopLiveCompanionIsolation();

    // Rewire back to direct routing.
    if (inputSourceNode && inputMixNode) {
      try {
        if (voiceIsolationProcessor) {
          // Disconnect inputSourceNode from the worklet input specifically.
          try { inputSourceNode.disconnect(voiceIsolationProcessor.getInputNode()); } catch (_e) {}
          voiceIsolationProcessor.disconnect();
        } else {
          // Safety: remove any stale connection to inputMixNode.
          try { inputSourceNode.disconnect(inputMixNode); } catch (_e) {}
        }
        inputSourceNode.connect(inputMixNode);
        console.log("[Voice Isolation] Audio routing restored to direct");
      } catch (error) {
        console.error("[Voice Isolation] Disconnect failed:", error);
      }
    }

    if (voiceIsolationProcessor) {
      await voiceIsolationProcessor.cleanup();
      voiceIsolationProcessor = null;
    }

    setVoiceIsolationStatus("off");
  }
  
  saveSettings();
  updateVoiceIsolationControlButtons();
}

class PluginHost {
  constructor() {
    this.plugins = [];
  }

  register(plugin) {
    this.plugins.push(plugin);
  }

  apply(state) {
    for (const plugin of this.plugins) {
      if (typeof plugin.apply === "function") {
        plugin.apply(state);
      }
    }
  }
}

const pluginHost = new PluginHost();

pluginHost.register({
  name: "mix",
  apply: () => {
    if (dryGainNode) dryGainNode.gain.value = 0;
    if (wetGainNode) wetGainNode.gain.value = 1;
  }
});

pluginHost.register({
  name: "output",
  apply: (state) => {
    if (outputGainNode) {
      outputGainNode.gain.value = state.volume;
    }
  }
});

pluginHost.register({
  name: "eq",
  apply: (state) => {
    if (!bassNode) {
      return;
    }

    if (state.currentFilterType === "lowshelf" || state.currentFilterType === "highshelf") {
      bassNode.gain.value = state.bass;
    }
  }
});

pluginHost.register({
  name: "reverb",
  apply: (state) => {
    if (!reverbGainNode || !audioContext || !convolverNode) {
      return;
    }

    refreshReverbImpulseIfNeeded(audioContext, convolverNode, state.reverbType, state.reverbSize, state.reverbTone);
    reverbGainNode.gain.value = state.reverbEnabled ? state.reverb : 0;
  }
});

pluginHost.register({
  name: "chorus",
  apply: (state) => {
    if (!chorusWetGainNode || !chorusLfoNode || !chorusLfoGainNode || !chorusDelayNode) {
      return;
    }

    const chorusProfiles = {
      classic: { rateMul: 1.0, depthMul: 1.0, baseDelay: 0.015 },
      ensemble: { rateMul: 0.65, depthMul: 1.5, baseDelay: 0.02 },
      vibrato: { rateMul: 1.35, depthMul: 1.2, baseDelay: 0.01 },
      dimension: { rateMul: 0.8, depthMul: 1.8, baseDelay: 0.022 }
    };

    const profile = chorusProfiles[state.chorusType] || chorusProfiles.classic;
    const widthScale = 0.25 + state.chorusWidth * 1.75;

    chorusWetGainNode.gain.value = state.chorusEnabled ? state.chorusMix : 0;
    chorusLfoNode.frequency.value = state.chorusRate * profile.rateMul;
    chorusLfoGainNode.gain.value = state.chorusDepth * profile.depthMul * widthScale;
    chorusDelayNode.delayTime.value = profile.baseDelay;
  }
});

pluginHost.register({
  name: "delay",
  apply: (state) => {
    if (!delayNode || !delayFeedbackNode || !delayFilterNode || !delayWetGainNode) {
      return;
    }

    const delayProfiles = {
      digital: { feedbackMul: 1.0, lowpassHz: 18000 },
      tape: { feedbackMul: 0.85, lowpassHz: 4200 },
      slap: { feedbackMul: 0.55, lowpassHz: 9500 }
    };

    const profile = delayProfiles[state.delayType] || delayProfiles.digital;
    delayNode.delayTime.value = state.delayType === "slap" ? Math.min(state.delayTime, 0.16) : state.delayTime;
    delayFeedbackNode.gain.value = Math.min(0.95, state.delayFeedback * profile.feedbackMul);
    delayFilterNode.frequency.value = profile.lowpassHz;
    delayWetGainNode.gain.value = state.delayEnabled ? state.delayMix : 0;
  }
});

pluginHost.register({
  name: "distortion",
  apply: (state) => {
    if (!distortionNode) {
      return;
    }

    const distAmount = state.distortionEnabled ? state.distortion : 0;
    distortionNode.curve = distAmount > 0 ? makeDistortionCurve(distAmount) : null;
  }
});

function applyFilterValues() {
  if (!bassNode || !preGainNode || !reverbGainNode || !chorusWetGainNode || !chorusLfoNode || !chorusLfoGainNode || !outputGainNode) {
    return;
  }
  
  // Wet chain input gain.
  preGainNode.gain.value = 1;

  // Plugin host applies chain-global settings and effect plugins.
  pluginHost.apply({
    bass: Number(bassInput.value),
    volume: Number(volumeInput.value),
    filterStrength: Number(effectMixInput.value),
    currentFilterType,
    reverb: Number(reverbInput.value),
    reverbEnabled: reverbEnable.checked,
    reverbType: reverbTypeInput.value,
    reverbSize: Number(reverbSizeInput.value),
    reverbTone: Number(reverbToneInput.value),
    chorusMix: Number(chorusMixInput.value),
    chorusEnabled: chorusEnable.checked,
    chorusRate: Number(chorusRateInput.value),
    chorusType: chorusTypeInput.value,
    chorusDepth: Number(chorusDepthInput.value),
    chorusWidth: Number(chorusWidthInput.value),
    delayEnabled: delayEnable.checked,
    delayMix: Number(delayMixInput.value),
    delayType: delayTypeInput.value,
    delayTime: Number(delayTimeInput.value),
    delayFeedback: Number(delayFeedbackInput.value),
    distortion: Number(distortionInput.value),
    distortionEnabled: distortionEnable.checked
  });
}

// Active Signalsmith Stretch node (exposes .schedule(), .start(), etc.)
let stretchNode = null;

async function createSignalsmithNode(context) {
  if (typeof SignalsmithStretch !== "function") {
    console.warn("[Pitch] SignalsmithStretch not available.");
    return null;
  }
  try {
    // Tell the library to load its worklet from the extension's static URL
    // instead of a blob: URL (which Chrome MV3 blocks for addModule).
    SignalsmithStretch.moduleUrl = chrome.runtime.getURL("libs/SignalsmithStretch.js");
    const node = await SignalsmithStretch(context, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    await node.start();
    return node;
  } catch (err) {
    console.warn("[Pitch] Failed to create Signalsmith node:", err);
    return null;
  }
}

function updatePitchShifterNode() {
  if (!stretchNode) return;
  const semitones = getEffectivePitchSemitones();
  stretchNode.schedule({ semitones });
}

function createFxGraph(context) {
  const graph = {};

  graph.inputMixNode = context.createGain();

  // Live stem splitter nodes (Low <250Hz, Mid 250-4000Hz, High >4000Hz)
  graph.liveStemLowFilterNode = context.createBiquadFilter();
  graph.liveStemLowFilterNode.type = "lowpass";
  graph.liveStemLowFilterNode.frequency.value = 250;
  graph.liveStemLowFilterNode.Q.value = 0.7071;

  graph.liveStemMidLowFilterNode = context.createBiquadFilter();
  graph.liveStemMidLowFilterNode.type = "highpass";
  graph.liveStemMidLowFilterNode.frequency.value = 250;
  graph.liveStemMidLowFilterNode.Q.value = 0.7071;

  graph.liveStemMidHighFilterNode = context.createBiquadFilter();
  graph.liveStemMidHighFilterNode.type = "lowpass";
  graph.liveStemMidHighFilterNode.frequency.value = 4000;
  graph.liveStemMidHighFilterNode.Q.value = 0.7071;

  graph.liveStemHighFilterNode = context.createBiquadFilter();
  graph.liveStemHighFilterNode.type = "highpass";
  graph.liveStemHighFilterNode.frequency.value = 4000;
  graph.liveStemHighFilterNode.Q.value = 0.7071;

  graph.liveStemLowGainNode = context.createGain();
  graph.liveStemLowGainNode.gain.value = 1;

  graph.liveStemMidGainNode = context.createGain();
  graph.liveStemMidGainNode.gain.value = 1;

  graph.liveStemHighGainNode = context.createGain();
  graph.liveStemHighGainNode.gain.value = 1;

  graph.liveStemMixerNode = context.createGain();
  graph.liveStemMixerNode.gain.value = 1;

  // Connect stem splitter chains
  // Low: input → lowpass → gain
  graph.inputMixNode.connect(graph.liveStemLowFilterNode);
  graph.liveStemLowFilterNode.connect(graph.liveStemLowGainNode);
  graph.liveStemLowGainNode.connect(graph.liveStemMixerNode);

  // Mid: input → highpass (250) → lowpass (4000) → gain
  graph.inputMixNode.connect(graph.liveStemMidLowFilterNode);
  graph.liveStemMidLowFilterNode.connect(graph.liveStemMidHighFilterNode);
  graph.liveStemMidHighFilterNode.connect(graph.liveStemMidGainNode);
  graph.liveStemMidGainNode.connect(graph.liveStemMixerNode);

  // High: input → highpass (4000) → gain
  graph.inputMixNode.connect(graph.liveStemHighFilterNode);
  graph.liveStemHighFilterNode.connect(graph.liveStemHighGainNode);
  graph.liveStemHighGainNode.connect(graph.liveStemMixerNode);

  graph.bassNode = context.createBiquadFilter();
  graph.bassNode.type = "lowshelf";
  graph.bassNode.frequency.value = 180;

  graph.preGainNode = context.createGain();
  graph.distortionNode = context.createWaveShaper();
  graph.distortionNode.curve = null;
  graph.distortionNode.oversample = "4x";

  // Wet/dry split nodes
  graph.dryGainNode = context.createGain();
  graph.dryGainNode.gain.value = 0;
  graph.wetGainNode = context.createGain();
  graph.wetGainNode.gain.value = 1;

  graph.convolverNode = context.createConvolver();
  graph.convolverNode.buffer = generateImpulseResponse(context);
  graph.reverbGainNode = context.createGain();
  graph.chorusDelayNode = context.createDelay(0.05);
  graph.chorusDelayNode.delayTime.value = 0.015;
  graph.chorusWetGainNode = context.createGain();
  graph.chorusLfoNode = context.createOscillator();
  graph.chorusLfoGainNode = context.createGain();

  graph.delayNode = context.createDelay(1.0);
  graph.delayNode.delayTime.value = 0.22;
  graph.delayFeedbackNode = context.createGain();
  graph.delayFeedbackNode.gain.value = 0.35;
  graph.delayFilterNode = context.createBiquadFilter();
  graph.delayFilterNode.type = "lowpass";
  graph.delayFilterNode.frequency.value = 18000;
  graph.delayWetGainNode = context.createGain();
  graph.delayWetGainNode.gain.value = 0;

  graph.ringModCarrierNode = context.createOscillator();
  graph.ringModCarrierNode.frequency.value = 0;
  graph.ringModGainNode = context.createGain();
  graph.ringModGainNode.gain.value = 0;

  graph.outputGainNode = context.createGain();

  // Pitch node is wired asynchronously after createFxGraph returns
  // (see buildAudioGraph → createSignalsmithNode). Start with direct routing.
  graph.pitchShifterNode = null;
  graph.inputMixNode.connect(graph.bassNode);
  graph.inputMixNode.connect(graph.dryGainNode);

  graph.bassNode.connect(graph.preGainNode);

  // Dry path (bypasses all effects)
  graph.dryGainNode.connect(graph.outputGainNode);
  
  // Wet path (through all effects)
  graph.preGainNode.connect(graph.distortionNode);
  graph.distortionNode.connect(graph.wetGainNode);
  graph.wetGainNode.connect(graph.convolverNode);
  graph.wetGainNode.connect(graph.chorusDelayNode);
  graph.wetGainNode.connect(graph.delayNode);
  graph.wetGainNode.connect(graph.ringModGainNode);
  graph.wetGainNode.connect(graph.outputGainNode);

  graph.convolverNode.connect(graph.reverbGainNode);
  graph.chorusDelayNode.connect(graph.chorusWetGainNode);

  graph.delayNode.connect(graph.delayWetGainNode);
  graph.delayNode.connect(graph.delayFeedbackNode);
  graph.delayFeedbackNode.connect(graph.delayFilterNode);
  graph.delayFilterNode.connect(graph.delayNode);

  graph.ringModCarrierNode.connect(graph.ringModGainNode.gain);
  graph.ringModCarrierNode.start();

  graph.reverbGainNode.connect(graph.outputGainNode);
  graph.chorusWetGainNode.connect(graph.outputGainNode);
  graph.delayWetGainNode.connect(graph.outputGainNode);
  graph.ringModGainNode.connect(graph.outputGainNode);

  graph.chorusLfoNode.connect(graph.chorusLfoGainNode);
  graph.chorusLfoGainNode.connect(graph.chorusDelayNode.delayTime);
  graph.chorusLfoNode.start();

  graph.dryGainNode.gain.value = 0;
  graph.wetGainNode.gain.value = 1;
  graph.outputGainNode.gain.value = 1;

  // Initial routing: bypass stem splitter (will be set in buildAudioGraph based on liveStemMixingEnabled)
  // Stem routing is set up in toggleLiveStemRouting()

  return graph;
}

function sendMessageToActiveTab(message) {
  const sendWithFallback = (tabId) => {
    if (!tabId) {
      return;
    }

    chrome.tabs.sendMessage(tabId, message, () => {
      if (!chrome.runtime.lastError) {
        return;
      }

      // If the content script context is missing, inject and retry once.
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ["content/content.js"]
        },
        () => {
          if (chrome.runtime.lastError) {
            console.debug("[Audio Mixer] Could not inject content script:", chrome.runtime.lastError.message);
            return;
          }

          chrome.tabs.sendMessage(tabId, message, () => {
            if (chrome.runtime.lastError) {
              console.debug("[Audio Mixer] Could not message tab after inject:", chrome.runtime.lastError.message);
            }
          });
        }
      );
    });
  };

  if (capturedTabId) {
    sendWithFallback(capturedTabId);

    // Also mirror to the currently active tab to keep YouTube controls reliable.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendWithFallback(tabs[0]?.id);
    });
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    sendWithFallback(tabs[0]?.id);
  });
}

async function requestActiveTabMessage(message) {
  const activeTabId = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]?.id ?? null));
  });

  // Try focused tab first (what user is actually viewing), then captured tab.
  const candidates = [];
  if (activeTabId != null) candidates.push(activeTabId);
  if (capturedTabId != null && capturedTabId !== activeTabId) candidates.push(capturedTabId);
  if (candidates.length === 0) return null;

  const trySendToTab = (tabId) => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: true, response: response ?? null });
    });
  });

  const ensureContentScript = (tabId) => new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["content/content.js"]
      },
      () => resolve()
    );
  });

  for (const tabId of candidates) {
    let sent = await trySendToTab(tabId);
    if (sent.ok) return sent.response;

    await ensureContentScript(tabId);
    sent = await trySendToTab(tabId);
    if (sent.ok) return sent.response;
  }

  return null;
}

async function requestCapturedTabMessage(message) {
  const activeTabId = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]?.id ?? null));
  });

  // Track controls should target the captured source tab first.
  const candidates = [];
  if (capturedTabId != null) candidates.push(capturedTabId);
  if (activeTabId != null && activeTabId !== capturedTabId) candidates.push(activeTabId);
  if (candidates.length === 0) return null;

  const trySendToTab = (tabId) => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: true, response: response ?? null });
    });
  });

  const ensureContentScript = (tabId) => new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["content/content.js"]
      },
      () => resolve()
    );
  });

  for (const tabId of candidates) {
    let sent = await trySendToTab(tabId);
    if (sent.ok) return sent.response;

    await ensureContentScript(tabId);
    sent = await trySendToTab(tabId);
    if (sent.ok) return sent.response;
  }

  return null;
}

function forceSpeedOnActiveTab(playbackRate, preservePitch = true) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (!activeTab?.id) {
      return;
    }

    chrome.scripting.executeScript(
    {
        target: { tabId: activeTab.id, allFrames: true },
        args: [playbackRate, preservePitch],
        func: (rate, shouldPreservePitch) => {
          const mediaElements = document.querySelectorAll("video, audio");
          for (const el of mediaElements) {
            el.playbackRate = rate;
            el.defaultPlaybackRate = rate;
            if ("preservesPitch" in el) {
              el.preservesPitch = shouldPreservePitch;
            }
            if ("mozPreservesPitch" in el) {
              el.mozPreservesPitch = shouldPreservePitch;
            }
            if ("webkitPreservesPitch" in el) {
              el.webkitPreservesPitch = shouldPreservePitch;
            }
          }
        }
      },
      () => {
        if (chrome.runtime.lastError) {
          console.debug("[Audio Mixer] executeScript speed apply failed:", chrome.runtime.lastError.message);
        }
      }
    );
  });
}

function applySpeedToActiveTab() {
  const playbackRate = getCombinedPlaybackRate();
  const preservePitch = true;
  sendMessageToActiveTab({
    type: "SET_PLAYBACK_RATE",
    payload: { playbackRate, preservePitch }
  });
  forceSpeedOnActiveTab(playbackRate, preservePitch);
}

function handlePitchChange() {
  updatePitchShifterNode();
}

function startSpeedEnforcer() {
  stopSpeedEnforcer();
  speedEnforceTimer = setInterval(() => {
    if (!stream) {
      return;
    }

    applySpeedToActiveTab();
  }, 1000);
}

function stopSpeedEnforcer() {
  if (speedEnforceTimer) {
    clearInterval(speedEnforceTimer);
    speedEnforceTimer = null;
  }
}

function muteOriginalTabMedia() {
  const targetTabId = capturedTabId;

  // Primary: mute the tab at Chrome level (requires "tabs" permission).
  if (targetTabId) {
    chrome.tabs.update(targetTabId, { muted: true }, () => {
      if (chrome.runtime.lastError) {
        console.debug("[Audio Mixer] Tab-level mute failed:", chrome.runtime.lastError.message);
      }
    });
  }

  // Also zero the volume via executeScript so it works even if tab-level mute is unavailable.
  const scriptTabId = targetTabId || null;
  if (scriptTabId) {
    chrome.scripting.executeScript({
      target: { tabId: scriptTabId, allFrames: false },
      func: () => {
        document.querySelectorAll("video, audio").forEach((el) => {
          if (!el.dataset._amxVolume) el.dataset._amxVolume = String(el.volume);
          el.volume = 0;
        });
      }
    }, () => { void chrome.runtime.lastError; });
  } else {
    sendMessageToActiveTab({ type: "MUTE_ORIGINAL_MEDIA" });
  }

  if (extensionMutedTabId !== scriptTabId) {
    extensionMutedTabId = scriptTabId;
    extensionMutedTabPreviousState = false;
  }
}

function unmuteOriginalTabMedia() {
  const targetTabId = extensionMutedTabId || capturedTabId;

  if (targetTabId) {
    chrome.tabs.update(targetTabId, { muted: false }, () => {
      if (chrome.runtime.lastError) {
        console.debug("[Audio Mixer] Tab-level unmute failed:", chrome.runtime.lastError.message);
      }
    });

    chrome.scripting.executeScript({
      target: { tabId: targetTabId, allFrames: false },
      func: () => {
        document.querySelectorAll("video, audio").forEach((el) => {
          const saved = el.dataset._amxVolume;
          el.volume = saved !== undefined ? Math.max(0, Math.min(1, parseFloat(saved))) : 1;
          delete el.dataset._amxVolume;
        });
      }
    }, () => { void chrome.runtime.lastError; });
  } else {
    sendMessageToActiveTab({ type: "UNMUTE_ORIGINAL_MEDIA" });
  }

  extensionMutedTabId = null;
  extensionMutedTabPreviousState = null;
}

function muteTabChromeLevel() {
  // Chrome's mixer-level mute is applied AFTER the tabCapture tap in the audio
  // pipeline. This silences the user's speakers without affecting rawCaptureDestination,
  // so the MediaRecorder still receives the full audio signal during the capture pass.
  const tabId = capturedTabId;
  if (tabId) {
    chrome.tabs.update(tabId, { muted: true }, () => { void chrome.runtime.lastError; });
  }
}

function unmuteTabChromeLevel() {
  // Reverse of muteTabChromeLevel(). Called before prepared instrumental playback so
  // the Web Audio graph output (audioContext.destination) is audible to the user.
  // Chrome-level tab mute silences ALL audio from the tab — including Web Audio API
  // output — so it must be cleared before the instrumental buffer can be heard.
  const tabId = capturedTabId;
  if (tabId) {
    chrome.tabs.update(tabId, { muted: false }, () => { void chrome.runtime.lastError; });
  }
}

async function silenceMediaElementsOnly() {
  // Use the content script's MUTE_ORIGINAL_MEDIA which sets isMuted=true and activates
  // a volumechange listener that re-enforces el.volume=0 any time the page resets it.
  // requestActiveTabMessage is the awaitable variant of sendMessageToActiveTab —
  // it resolves once the content script calls sendResponse, giving a reliable
  // synchronisation point before we start the capture recorder.
  const response = await requestActiveTabMessage({ type: "MUTE_ORIGINAL_MEDIA" });
  if (!response?.success) {
    // Content script could not be reached even after re-injection. If we continue,
    // the original HTML5 audio element stays at full volume and the user hears both
    // the original (with vocals) and the instrumental simultaneously.
    throw new Error("Could not mute original media — content script unreachable");
  }
}

async function restoreMediaElementVolume() {
  // Reverse silenceMediaElementsOnly — clears isMuted flag, removes the volumechange
  // lock, and restores the saved original volume for every media element.
  await requestActiveTabMessage({ type: "UNMUTE_ORIGINAL_MEDIA" });
}

function pauseOriginalTabMediaForIsolation() {
  // Keep source unmuted for reliability: muting page/tab output can also silence
  // tab-captured audio on some Chrome/media pipelines, yielding silent AI chunks.
}

function resumeOriginalTabMediaForIsolation() {
  if (userPausedBrowserAudio) {
    return;
  }
  unmuteOriginalTabMedia();
}

function refreshPauseBrowserAudioButton() {
  if (!pauseBrowserAudioBtn) {
    return;
  }

  pauseBrowserAudioBtn.textContent = userPausedBrowserAudio
    ? "Resume Browser Audio"
    : "Pause Browser Audio";
}

function setLiveCompanionPlaybackPaused(paused) {
  liveCompanionPlaybackPaused = Boolean(paused);
  if (!audioContext) {
    return;
  }

  if (liveCompanionPlaybackPaused) {
    if (audioContext.state === "running") {
      audioContext.suspend().catch((error) => {
        console.warn("[Voice Isolation] Failed to pause AI playback:", error);
      });
    }
    return;
  }

  if (audioContext.state === "suspended") {
    audioContext.resume().catch((error) => {
      console.warn("[Voice Isolation] Failed to resume AI playback:", error);
    });
  }
}

function rewindActiveTabTimeline(seconds) {
  const rewindSeconds = Math.max(0, Number(seconds) || 0);
  if (rewindSeconds <= 0) {
    return;
  }

  sendMessageToActiveTab({
    type: "REWIND_MEDIA_SECONDS",
    payload: { seconds: rewindSeconds }
  });
}

async function getActiveTabMediaCurrentTime() {
  const response = await requestActiveTabMessage({ type: "GET_MEDIA_CURRENT_TIME" });
  if (response && response.success && Number.isFinite(response.currentTime)) {
    return response.currentTime;
  }
  return -1;
}

async function getActiveTabMediaState() {
  const response = await requestActiveTabMessage({ type: "GET_MEDIA_STATE" });
  if (!response || !response.success) {
    return null;
  }

  const continuity = response.continuity && typeof response.continuity === "object"
    ? {
      continuityVersion: Number(response.continuity.continuityVersion) || 0,
      lockMuteIntended: Boolean(response.continuity.lockMuteIntended),
      lockPauseIntended: Boolean(response.continuity.lockPauseIntended),
      lockMuteRehydrated: Boolean(response.continuity.lockMuteRehydrated),
      lockPauseRehydrated: Boolean(response.continuity.lockPauseRehydrated),
      contextBootEpochMs: Number(response.continuity.contextBootEpochMs) || 0,
      lastRehydrateEpochMs: Number(response.continuity.lastRehydrateEpochMs) || 0,
      controlReady: Boolean(response.continuity.controlReady),
      continuityReason: String(response.continuity.continuityReason || "")
    }
    : null;

  return {
    success: true,
    currentTime: Number.isFinite(response.currentTime) ? response.currentTime : 0,
    duration: Number.isFinite(response.duration) ? response.duration : 0,
    paused: Boolean(response.paused),
    ended: Boolean(response.ended),
    playbackRate: Number.isFinite(response.playbackRate) ? response.playbackRate : 1,
    title: String(response.title || "").trim(),
    elInfo: typeof response.elInfo === "string" ? response.elInfo : undefined,
    csVersion: typeof response.csVersion === "string" ? response.csVersion : "OLD",
    continuity
  };
}

function continuityGatePass(mediaState, gateName, options = {}) {
  const { requireControlReady = true } = options;
  if (!mediaState?.success) {
    console.warn(`[Prepared Instrumental][${gateName}] continuity check failed: media state unavailable`);
    return false;
  }

  const continuity = mediaState.continuity;
  if (!continuity) {
    console.warn(`[Prepared Instrumental][${gateName}] continuity check failed: continuity metadata missing`);
    return false;
  }

  if (requireControlReady && !continuity.controlReady) {
    console.warn(`[Prepared Instrumental][${gateName}] continuity check failed: control not ready (${continuity.continuityReason || "unknown"})`);
    return false;
  }

  return true;
}

function seekActiveTabMediaToTime(targetTime, options = {}) {
  const t = Math.max(0, Number(targetTime) || 0);
  const forceAtZero = Boolean(options.forceAtZero);
  // Use capturedTabId directly when known — sendMessageToActiveTab mirrors to BOTH
  // capturedTabId and the focused tab, which can accidentally seek unrelated tabs.
  // Seek/play must target only the captured YT Music tab.
  if (capturedTabId) {
    chrome.tabs.sendMessage(capturedTabId, { type: "SEEK_TO_TIME", payload: { time: t, forceAtZero } }, () => {
      void chrome.runtime.lastError;
    });
  } else {
    sendMessageToActiveTab({ type: "SEEK_TO_TIME", payload: { time: t, forceAtZero } });
  }
}

function playActiveTabMedia() {
  if (capturedTabId) {
    chrome.tabs.sendMessage(capturedTabId, { type: "PLAY_ORIGINAL_MEDIA" }, () => {
      void chrome.runtime.lastError;
    });
  } else {
    sendMessageToActiveTab({ type: "PLAY_ORIGINAL_MEDIA" });
  }
}

// Robustly restart the captured track from 0:00 and ensure it actually plays.
// Unlike seek(0)+play(), this clicks YT Music's Play button when the track has
// ENDED (MSE buffer torn down), which is the only way to get an ended YT Music
// track to replay — a raw el.play() is rejected and leaves the timeline frozen
// at the end. Used for the silent processing loops and the playback handoff so
// the page timeline keeps matching what is heard.
// --- DO NOT EDIT casually — isolation invariant (see AGENTS.md "Fragile code"). ---
function restartAndPlayActiveTabFromZero() {
  if (capturedTabId) {
    chrome.tabs.sendMessage(capturedTabId, { type: "RESTART_AND_PLAY_FROM_ZERO" }, () => {
      void chrome.runtime.lastError;
    });
  } else {
    sendMessageToActiveTab({ type: "RESTART_AND_PLAY_FROM_ZERO" });
  }
}

async function restartActiveTabFromZero(options = {}) {
  const {
    attempts = 4,
    toleranceSeconds = 1.25,
    requirePlaying = true,
    settleMs = 220
  } = options;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const restartResponse = await requestCapturedTabMessage({ type: "RESTART_CURRENT_TRACK" });
    if (!restartResponse?.success) {
      seekActiveTabMediaToTime(0, { forceAtZero: true });
    } else if (Number.isFinite(restartResponse.currentTime) && Number(restartResponse.currentTime) <= toleranceSeconds) {
      if (requirePlaying) {
        playActiveTabMedia();
        await new Promise(resolve => setTimeout(resolve, settleMs));
        const verifyState = await getActiveTabMediaState();
        const verifiedNearZero = Boolean(verifyState?.success) && Number(verifyState.currentTime) <= toleranceSeconds;
        const verifiedPlaying = Boolean(verifyState?.success) && !verifyState.paused;
        if (verifiedNearZero && verifiedPlaying) {
          return true;
        }
      } else {
        return true;
      }
    }

    if (requirePlaying) {
      playActiveTabMedia();
    }

    await new Promise(resolve => setTimeout(resolve, settleMs));

    const mediaState = await getActiveTabMediaState();
    if (!mediaState?.success) {
      continue;
    }

    const nearZero = Number(mediaState.currentTime) <= toleranceSeconds;
    const playingOk = !requirePlaying || !mediaState.paused;
    if (nearZero && playingOk) {
      return true;
    }

    if (Number(mediaState.currentTime) > toleranceSeconds && attempt < attempts - 1) {
      seekActiveTabMediaToTime(0);
      if (requirePlaying) {
        playActiveTabMedia();
      }

      await new Promise(resolve => setTimeout(resolve, Math.max(150, Math.round(settleMs / 2))));

      const fallbackState = await getActiveTabMediaState();
      if (fallbackState?.success) {
        const fallbackNearZero = Number(fallbackState.currentTime) <= toleranceSeconds;
        const fallbackPlayingOk = !requirePlaying || !fallbackState.paused;
        if (fallbackNearZero && fallbackPlayingOk) {
          return true;
        }
      }
    }
  }

  return false;
}

async function seekCapturedMediaBy(deltaSeconds) {
  if (!stream) {
    setStatus("Start capture to control source timeline");
    return;
  }

  const mediaState = await getActiveTabMediaState();
  if (!mediaState?.success) {
    setStatus("No active media found for timeline skip");
    return;
  }

  const current = Number(mediaState.currentTime) || 0;
  const maxDuration = Number.isFinite(mediaState.duration) && mediaState.duration > 0
    ? mediaState.duration
    : Number.POSITIVE_INFINITY;
  const target = Math.max(0, Math.min(maxDuration, current + deltaSeconds));
  seekActiveTabMediaToTime(target);
  setStatus(`Capture source seeked to ${target.toFixed(1)}s`);
}

async function restartCapturedMediaTimeline() {
  if (!stream) {
    setStatus("Start capture to restart source timeline");
    return;
  }

  const response = await requestCapturedTabMessage({ type: "RESTART_CURRENT_TRACK" });
  if (!response?.success) {
    // Fallback for pages that do not implement the restart command.
    seekActiveTabMediaToTime(0);
  }

  setStatus("Capture source timeline restarted");
}

async function skipCapturedMediaToPreviousTrack() {
  if (!stream) {
    setStatus("Start capture to go to previous song");
    return;
  }

  const response = await requestCapturedTabMessage({ type: "SKIP_TO_PREVIOUS_TRACK" });
  if (!response?.success) {
    setStatus("Couldn't go to previous song on this tab");
    return;
  }

  setStatus("Skipped to previous song");
}

async function skipCapturedMediaToNextTrack() {
  if (!stream) {
    setStatus("Start capture to skip to next song");
    return;
  }

  const response = await requestCapturedTabMessage({ type: "SKIP_TO_NEXT_TRACK" });
  if (!response?.success) {
    setStatus("Couldn't skip to next song on this tab");
    return;
  }

  setStatus("Skipped to next song");
}

function connectOutputDestination() {
  if (!outputGainNode || !audioContext || outputDestinationConnected) {
    return;
  }

  outputGainNode.connect(audioContext.destination);
  outputDestinationConnected = true;
}

function disconnectOutputDestination() {
  if (!outputGainNode || !audioContext || !outputDestinationConnected) {
    return;
  }

  try {
    outputGainNode.disconnect(audioContext.destination);
  } catch (_error) {
    // ignore
  }
  outputDestinationConnected = false;
}

function getPreparedInstrumentalCacheKey(mediaState) {
  // Normalize title to strip site-appended suffixes that change during buffering.
  // YT Music sets document.title to "Song - Artist - YouTube Music" normally, but
  // briefly shows "YouTube Music" or "Song - Artist - YouTube Music (loading)" etc.
  // Stripping the common suffix makes the key stable across those transitions.
  let title = String(mediaState?.title || "untitled-track").trim().toLowerCase();
  // Strip trailing " - youtube music" (with regular hyphen or em-dash)
  title = title.replace(/\s*[\-\u2013\u2014]\s*youtube music\s*$/, "").trim();
  // If stripping left nothing meaningful (e.g. the title WAS just "YouTube Music"),
  // fall back to a placeholder so we don't cache under an empty key.
  if (!title) title = "untitled-track";
  const durationBucket = Math.round(Math.max(0, Number(mediaState?.duration) || 0) * 10) / 10;
  return `${title}|${durationBucket}`;
}

function clearPreparedInstrumentalSyncTimer() {
  if (preparedInstrumentalSyncTimer) {
    clearTimeout(preparedInstrumentalSyncTimer);
    preparedInstrumentalSyncTimer = null;
  }
}

function clearPreparedInstrumentalHardLoopEnforcer() {
  if (preparedInstrumentalHardLoopTimer) {
    clearInterval(preparedInstrumentalHardLoopTimer);
    preparedInstrumentalHardLoopTimer = null;
  }
  preparedInstrumentalHardLoopBusy = false;
}

function startPreparedInstrumentalHardLoopEnforcer(sessionId, expectedDurationSeconds) {
  clearPreparedInstrumentalHardLoopEnforcer();
  preparedInstrumentalHardLoopTimer = setInterval(() => {
    if (preparedInstrumentalHardLoopBusy) {
      return;
    }
    preparedInstrumentalHardLoopBusy = true;
    void (async () => {
      try {
        if (!isPreparedInstrumentalSessionCurrent(sessionId)) {
          return;
        }
        // Run during BOTH the muted processing phase AND active playback so the PAGE
        // keeps visually looping the captured song (seek-to-0 at the real song
        // boundary). This actor only ever touches the PAGE element (seek + play) —
        // never the instrumental AudioBufferSourceNode — so it cannot cause the
        // page-clock buffer reseat ("first second on repeat") bug the sync loop warns
        // about. The buffer loops on its own Web Audio clock independently.
        if (!preparedInstrumentalPreparing && !preparedInstrumentalActive) {
          return;
        }

        const state = await getActiveTabMediaState();
        if (!state?.success) {
          return;
        }

        // Use the CAPTURED song length, never the live state.duration. YT Music plays
        // the whole queue gaplessly on one <video> element and extends the live
        // duration to the queue length (e.g. 36s -> 180s) at ~ct=26, mid-song. Keying
        // the boundary off that would push the restart to ~179s and the song would run
        // straight into the next track instead of looping.
        const expectedDuration = Number(expectedDurationSeconds)
          || Number(preparedInstrumentalSongDurationSeconds) || 0;
        const duration = expectedDuration > 0 ? expectedDuration : (Number(state.duration) || 0);
        const SAFE_LOOP_MARGIN_SECONDS = 2.5;

        if (preparedInstrumentalRepeatOneEngaged) {
          // YouTube's OWN Repeat One owns the loop and re-plays the same MSE track at
          // its true end natively. The enforcer must NOT seek near the end (that would
          // cut YT's loop ~2.5s early) — it stands down entirely. Only if the track
          // actually reports `ended` (YT's native repeat somehow missed the boundary)
          // do we nudge it, and then via the PLAY-BUTTON restart: a raw seek(0)+play()
          // cannot resume an ended MSE track and would freeze the page at 0 (the
          // "loops to 0 then never moves" symptom). No pre-end seek here.
          if (state.ended) {
            restartAndPlayActiveTabFromZero();
            console.log("[Prepared Instrumental][HardLoop] Repeat-One ended-nudge (Play button)");
          }
          return;
        }

        // Fallback (Repeat One unavailable): seek back to 0 BEFORE the true end so the
        // page never crosses into the next gapless track. 2.5s comfortably beats YT's
        // ~2s pre-commit of the next track, so the worst case is "loops slightly early",
        // never "jumps to the next track" (the old 0.6s margin lost that race).
        const timeNearEnd = duration > 0 && state.currentTime >= duration - SAFE_LOOP_MARGIN_SECONDS;
        const stuckNearEnd = duration > 0 && state.paused && state.currentTime >= duration - SAFE_LOOP_MARGIN_SECONDS;
        if (!state.ended && !timeNearEnd && !stuckNearEnd) {
          return;
        }

        // Use the PLAY-BUTTON restart (RESTART_AND_PLAY_FROM_ZERO): it seeks to 0 and,
        // if the track already ended/paused, clicks YT's Play button to force a real
        // replay (a raw play() cannot resume an ended MSE track). Never gate on a
        // "page confirmed playing" check — at the boundary YT's play/pause state is
        // volatile and such a gate would stall the loop.
        restartAndPlayActiveTabFromZero();

        console.log(`[Prepared Instrumental][HardLoop] restart enforced at ${Number(state.currentTime || 0).toFixed(2)}s`);
      } finally {
        preparedInstrumentalHardLoopBusy = false;
      }
    })();
  }, 320);
}

// --- DO NOT EDIT casually — isolation invariant (see AGENTS.md "Fragile code"). ---
function schedulePreparedInstrumentalAction(sessionId, delayMs, action) {
  return setTimeout(() => {
    if (!isPreparedInstrumentalSessionCurrent(sessionId)) {
      return;
    }
    action();
  }, Math.max(0, Number(delayMs) || 0));
}

function stopPreparedInstrumentalSource() {
  if (!preparedInstrumentalSource) {
    preparedInstrumentalPlaybackActive = false;
    preparedInstrumentalPlaybackStartTime = null;
    preparedInstrumentalPlaybackStartOffset = 0;
    preparedInstrumentalPlaybackRate = 1;
    return;
  }

  try {
    preparedInstrumentalSource.onended = null;
    preparedInstrumentalSource.stop();
    preparedInstrumentalSource.disconnect();
  } catch (_error) {
    // ignore
  }

  preparedInstrumentalSource = null;
  preparedInstrumentalPlaybackActive = false;
  preparedInstrumentalPlaybackStartTime = null;
  preparedInstrumentalPlaybackStartOffset = 0;
  preparedInstrumentalPlaybackRate = 1;
}

function stopPreparedInstrumentalMode(options = {}) {
  const { preserveBuffer = false, keepMuted = false, keepStatus = false } = options;

  preparedInstrumentalSessionId += 1;
  preparedInstrumentalState = PREPARED_INSTRUMENTAL_STATE.ENDED;
  preparedInstrumentalPreparing = false;
  preparedInstrumentalActive = false;
  clearPreparedInstrumentalSyncTimer();
  clearPreparedInstrumentalSyncWatchdog();
  clearPreparedInstrumentalHardLoopEnforcer();
  stopPreparedInstrumentalSource();
  connectOutputDestination();

  // Restore the user's original repeat mode if we engaged Repeat One for looping.
  // Fire-and-forget (this function is synchronous); the content-script no-ops if it
  // never took a repeat hold.
  if (preparedInstrumentalRepeatOneEngaged) {
    sendMessageToActiveTab({ type: "SET_REPEAT_ONE", payload: { enabled: false } });
    preparedInstrumentalRepeatOneEngaged = false;
  }

  if (!preserveBuffer) {
    preparedInstrumentalBuffer = null;
    preparedInstrumentalTrackKey = "";
    preparedInstrumentalTrackTitle = "";
    preparedInstrumentalCaptureMediaTimeOffset = 0;
  }

  if (!keepMuted && !userPausedBrowserAudio) {
    // Remove Chrome-level mute (safety: may have been left set if stopped mid-capture)
    // then release the content-script el.volume=0 lock.
    // restoreMediaElementVolume() is async (sends a message to content script) but
    // stopPreparedInstrumentalMode is synchronous. Fire-and-forget is intentional here;
    // the startup recovery scan on next popup open is the backstop if this is interrupted.
    unmuteTabChromeLevel();
    void restoreMediaElementVolume();
  }

  // Restore direct routing so normal capture/effects mode works after this mode ends.
  if (inputSourceNode && inputMixNode) {
    try { inputSourceNode.disconnect(inputMixNode); } catch (_e) {}
    inputSourceNode.connect(inputMixNode);
  }

  if (!keepStatus) {
    clearInstrumentalPreparationUi();
  }

  clearPreparedInstrumentalState();
}

async function resetVoiceIsolationRoutingForPreparedInstrumental() {
  stopLiveCompanionIsolation();

  if (voiceIsolationProcessor) {
    try {
      if (inputSourceNode && voiceIsolationProcessor.getInputNode()) {
        inputSourceNode.disconnect(voiceIsolationProcessor.getInputNode());
      }
    } catch (_error) {
      // ignore
    }
    try {
      voiceIsolationProcessor.disconnect();
    } catch (_error) {
      // ignore
    }
    await voiceIsolationProcessor.cleanup();
    voiceIsolationProcessor = null;
  }

  // Leave inputSourceNode disconnected from inputMixNode for the duration of the
  // prepared mode. Only the instrumental AudioBufferSourceNode should feed the mix
  // during both passes, regardless of whether Chrome's tab mute affects tabCapture.
  // stopPreparedInstrumentalMode() reconnects when the mode ends.
  if (inputSourceNode && inputMixNode) {
    try {
      inputSourceNode.disconnect(inputMixNode);
    } catch (_error) {
      // ignore — already disconnected
    }
  }
}

async function startPreparedInstrumentalSourceAt(offsetSeconds, playbackRate = 1, sessionId = preparedInstrumentalSessionId) {
  if (!isPreparedInstrumentalSessionCurrent(sessionId)) {
    return false;
  }

  if (!preparedInstrumentalBuffer || !audioContext || !inputMixNode) {
    return false;
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  connectOutputDestination();
  stopPreparedInstrumentalSource();

  const safeOffset = Math.max(0, Math.min(preparedInstrumentalBuffer.duration - 0.01, Number(offsetSeconds) || 0));
  const safeRate = Math.max(0.1, Number(playbackRate) || 1);
  const source = audioContext.createBufferSource();
  source.buffer = preparedInstrumentalBuffer;
  source.playbackRate.value = safeRate;
  // Native perpetual loop. The Web Audio engine replays the captured song body
  // [captureOffset → buffer end] gaplessly and forever, on its own clock. This is
  // the loop owner. The page timeline is NOT a usable clock during prepared mode —
  // YouTube Music parks a phantom <video> (no duration, currentTime frozen at 0),
  // so any page-synced restart would yank the buffer back to 0 every tick (the
  // "first second on repeat" bug). loopStart skips the pre-song pipeline fill-in.
  const loopStartPoint = Math.max(0, Math.min(
    preparedInstrumentalCaptureMediaTimeOffset,
    preparedInstrumentalBuffer.duration - 0.05
  ));
  source.loop = true;
  source.loopStart = loopStartPoint;
  source.loopEnd = preparedInstrumentalBuffer.duration;
  source.connect(inputMixNode);
  source.onended = () => {
    if (preparedInstrumentalSource !== source) {
      return;
    }
    preparedInstrumentalSource = null;
    preparedInstrumentalPlaybackActive = false;
  };

  preparedInstrumentalSource = source;
  preparedInstrumentalPlaybackStartTime = audioContext.currentTime;
  preparedInstrumentalPlaybackStartOffset = safeOffset;
  preparedInstrumentalPlaybackRate = safeRate;
  preparedInstrumentalPlaybackActive = true;
  setPreparedInstrumentalState(PREPARED_INSTRUMENTAL_STATE.PLAYBACK_ACTIVE, sessionId);
  source.start(0, safeOffset);
  return true;
}

let preparedInstrumentalSyncStartTime = 0;
let preparedInstrumentalSyncTickCount = 0;
let preparedInstrumentalLastSyncTickEpochMs = 0;

function clearPreparedInstrumentalSyncWatchdog() {
  if (preparedInstrumentalSyncWatchdogTimer) {
    clearInterval(preparedInstrumentalSyncWatchdogTimer);
    preparedInstrumentalSyncWatchdogTimer = null;
  }
}

function startPreparedInstrumentalSyncWatchdog(sessionId) {
  clearPreparedInstrumentalSyncWatchdog();
  preparedInstrumentalLastSyncTickEpochMs = Date.now();
  preparedInstrumentalSyncWatchdogTimer = setInterval(() => {
    if (!preparedInstrumentalActive || !isPreparedInstrumentalSessionCurrent(sessionId)) {
      return;
    }
    const now = Date.now();
    const sinceTickMs = now - preparedInstrumentalLastSyncTickEpochMs;
    if (sinceTickMs > 1800) {
      console.warn(`[Prepared Instrumental][Sync] watchdog kick after ${sinceTickMs}ms without tick`);
      schedulePreparedInstrumentalSync(sessionId, 0);
    }
  }, 700);
}

function schedulePreparedInstrumentalSync(sessionId, delayMs = 0) {
  clearPreparedInstrumentalSyncTimer();
  console.log(`[Prepared Instrumental][Sync] schedule session=${sessionId} delayMs=${delayMs}`);
  preparedInstrumentalSyncTimer = setTimeout(() => {
    void syncPreparedInstrumentalPlayback(sessionId);
  }, delayMs);
}

// --- DO NOT EDIT casually — isolation invariant (see AGENTS.md "Fragile code"). ---
// Its body MUST NOT contain a deferred-timer call (voice-lock enforces this).
async function syncPreparedInstrumentalPlayback(sessionId) {
  preparedInstrumentalLastSyncTickEpochMs = Date.now();
  preparedInstrumentalSyncTickCount += 1;
  if (preparedInstrumentalSyncTickCount <= 5 || preparedInstrumentalSyncTickCount % 10 === 0) {
    console.log(`[Prepared Instrumental][Sync] tick=${preparedInstrumentalSyncTickCount} session=${sessionId} active=${preparedInstrumentalActive} preparing=${preparedInstrumentalPreparing} state=${preparedInstrumentalState}`);
  }
  if (!preparedInstrumentalActive || !isPreparedInstrumentalSessionCurrent(sessionId) || preparedInstrumentalState === PREPARED_INSTRUMENTAL_STATE.ENDED) {
    console.warn(`[Prepared Instrumental][Sync] early-exit active=${preparedInstrumentalActive} sessionCurrent=${isPreparedInstrumentalSessionCurrent(sessionId)} state=${preparedInstrumentalState}`);
    return;
  }

  const mediaState = await getActiveTabMediaState();
  if (!preparedInstrumentalActive || sessionId !== preparedInstrumentalSessionId) {
    return;
  }

  if (!mediaState?.success) {
    setVoiceIsolationStatus("waiting for page timeline...");
    schedulePreparedInstrumentalSync(sessionId, 500);
    return;
  }

  // DIAGNOSTIC: dump the raw page media state + buffer clock every logged tick so we can
  // see exactly why the near-end / paused branches are (not) firing.
  {
    const _be = (preparedInstrumentalSource && preparedInstrumentalPlaybackStartTime != null && audioContext)
      ? (audioContext.currentTime - preparedInstrumentalPlaybackStartTime) * (preparedInstrumentalPlaybackRate || 1)
      : 0;
    const _bp = preparedInstrumentalPlaybackStartOffset + _be;
    // The Web Audio source loops natively (loop=true). _bp grows linearly forever,
    // so derive the loop-relative position + completed-loop count to make the
    // perpetual loop observable (loopN increments once per full cycle).
    const _dur = preparedInstrumentalBuffer ? preparedInstrumentalBuffer.duration : 0;
    const _loopStart = Math.max(0, Math.min(preparedInstrumentalCaptureMediaTimeOffset, Math.max(0, _dur - 0.05)));
    const _loopLen = Math.max(0.01, _dur - _loopStart);
    const _loopPos = _loopStart + ((_bp - _loopStart) % _loopLen);
    const _loopN = Math.floor((_bp - _loopStart) / _loopLen);
    console.log(`[Prepared Instrumental][Diag] cs=${mediaState.csVersion || "OLD"} ct=${Number(mediaState.currentTime).toFixed(2)} dur=${Number(mediaState.duration).toFixed(2)} paused=${mediaState.paused} ended=${mediaState.ended} rate=${mediaState.playbackRate} loopPos=${_loopPos.toFixed(2)}/${_dur.toFixed(2)} loopN=${_loopN} bufPos=${_bp.toFixed(2)} capOff=${preparedInstrumentalCaptureMediaTimeOffset.toFixed(2)} srcActive=${preparedInstrumentalPlaybackActive} els=[${mediaState.elInfo || ""}]`);
  }

  // NOTE: The continuity gate (G10_SYNC_LOOP_HEALTH) was removed here. It was a
  // post-working-version regression: when controlReady never settled true, the
  // sync loop spun forever on "waiting for continuity state" (visible as the
  // repeating delayMs=500 schedule) and the actual loop/restart logic below was
  // never reached. The loop owner must run unconditionally once playback is active.

  // Detect a real track change by duration shift only — never by document.title.
  // YT Music mutates document.title mid-playback (artist suffix appears/disappears)
  // which previously caused false-positive teardowns on the same song.
  const capturedDuration = preparedInstrumentalBuffer ? preparedInstrumentalBuffer.duration : 0;
  const currentDuration = Number(mediaState?.duration) || 0;
  const _songDur = Number(preparedInstrumentalSongDurationSeconds) || capturedDuration;
  // YT Music gapless playback GROWS the live duration to the whole-queue length
  // (e.g. 36s -> 180s) at ~ct=26 — that is preload pollution, NOT a track change.
  // Only a live duration that drops well BELOW the captured song indicates a
  // genuinely different (shorter) track. Treating growth as a change tore the
  // instrumental down mid-song at ~ct=26 (the "no instrumental audio" regression).
  const durationChangedSignificantly = _songDur > 0 && currentDuration > 0 &&
    currentDuration < _songDur - 5;
  if (durationChangedSignificantly) {
    // Before tearing down, check if our buffer is near its end via the Web Audio clock.
    // YouTube Music auto-advances to the next song ~2 s before the last audio frame plays,
    // causing currentDuration to jump to the new song's length. If our buffer is almost
    // finished, this is the natural song end — let the buffer play out and loop cleanly
    // rather than tearing down immediately.
    const _bufElapsed = (preparedInstrumentalSource && preparedInstrumentalPlaybackStartTime != null && audioContext)
      ? (audioContext.currentTime - preparedInstrumentalPlaybackStartTime) * (preparedInstrumentalPlaybackRate || 1)
      : 0;
    const _bufPos = preparedInstrumentalPlaybackStartOffset + _bufElapsed;
    const _bufNearEnd = preparedInstrumentalBuffer != null &&
      _bufPos >= preparedInstrumentalBuffer.duration - 4;
    if (_bufNearEnd) {
      const _bufDone = preparedInstrumentalBuffer != null &&
        _bufPos >= preparedInstrumentalBuffer.duration - 0.1;
      if (_bufDone) {
        // Buffer has reached its natural end — trigger the loop now.
        const captureOff = preparedInstrumentalCaptureMediaTimeOffset;
        setPreparedInstrumentalState(PREPARED_INSTRUMENTAL_STATE.LOOPING, sessionId);
        seekActiveTabMediaToTime(0, { forceAtZero: true });
        schedulePreparedInstrumentalAction(sessionId, 120, () => {
          if (preparedInstrumentalActive) {
            playActiveTabMedia();
          }
        });
        await startPreparedInstrumentalSourceAt(captureOff, preparedInstrumentalPlaybackRate || 1, sessionId);
        setVoiceIsolationStatus("prepared instrumental — looping (disable to stop)");
        schedulePreparedInstrumentalSync(sessionId, 500);
      } else {
        // Buffer still has content — wait for it rather than tearing down.
        schedulePreparedInstrumentalSync(sessionId, 150);
      }
      return;
    }
    // Genuine track change — tear down.
    stopPreparedInstrumentalMode({ preserveBuffer: false, keepStatus: true });
    voiceIsolationEnabled = false;
    if (enableVoiceIsolationInput) {
      enableVoiceIsolationInput.checked = false;
    }
    setVoiceIsolationStatus("prepared track ended or changed");
    clearInstrumentalPreparationUi();
    return;
  }

  // ── Native-loop ownership ────────────────────────────────────────────────
  // The instrumental AudioBufferSourceNode is configured with loop=true
  // (loopStart=captureOffset, loopEnd=buffer end) in startPreparedInstrumentalSourceAt,
  // so the Web Audio engine replays the captured song body gaplessly and forever.
  // We must NOT restart/reseat the buffer from the page clock: YouTube Music parks a
  // phantom <video> during prepared mode (no duration, currentTime frozen at 0), and
  // page-synced drift correction endlessly yanked the buffer back to 0 — that was the
  // "first second on repeat, timeline stuck at 35s" bug. Here we only keep the looping
  // source alive and the original track muted. The user ends the loop by toggling
  // voice isolation off.
  if (!preparedInstrumentalSource || !preparedInstrumentalPlaybackActive) {
    // The looping source ended or was never (re)started — restart it from the
    // capture offset. With loop=true this should essentially never be needed.
    await startPreparedInstrumentalSourceAt(
      preparedInstrumentalCaptureMediaTimeOffset,
      preparedInstrumentalPlaybackRate || 1,
      sessionId
    );
    console.log("[Prepared Instrumental] Re-armed looping source (was inactive)");
  }

  if (preparedInstrumentalState !== PREPARED_INSTRUMENTAL_STATE.LOOPING) {
    setPreparedInstrumentalState(PREPARED_INSTRUMENTAL_STATE.LOOPING, sessionId);
  }
  setVoiceIsolationStatus("prepared instrumental — looping (disable to stop)");
  setInstrumentalPreparationUi({
    visible: true,
    phase: "playback",
    headline: preparedInstrumentalTrackTitle || "Prepared instrumental ready",
    detail: "The original track stays muted while the prepared instrumental loops continuously. Disable voice isolation to stop.",
    progress: 100,
    progressText: "Looping"
  });
  schedulePreparedInstrumentalSync(sessionId, 1000);
}

// --- DO NOT EDIT casually — isolation invariant (see AGENTS.md "Fragile code"). ---
async function capturePreparedInstrumentalPass(sessionId, mediaState) {
  if (!rawCaptureDestination) {
    throw new Error("Raw track capture is not available");
  }

  const mimeType = getPreferredRecordingMimeType();
  // Capture at a high bitrate so the lossy intermediate fed to Demucs keeps as much
  // fidelity as possible. A low-bitrate source produces fuzzier separation with more
  // vocal bleed in the instrumental stem.
  const recorderOptions = mimeType
    ? { mimeType, audioBitsPerSecond: 256000 }
    : { audioBitsPerSecond: 256000 };

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let recorder;
    let settled = false;
    let stopScheduled = false; // true once stopAfterTail has been called
    let hardTimeoutId = null;

    const captureStartedAtMs = Date.now();
    let lastStateSuccessAtMs = captureStartedAtMs;
    let lastProgressAdvanceAtMs = captureStartedAtMs;
    let lastLivenessWarnAtMs = 0;
    // Largest NON-polluted live duration observed during capture. YT Music gapless-
    // extends the live duration to the whole queue (e.g. 36 -> 180) at ~ct=26 mid-song;
    // we ignore anything more than 5s from the snapshot so this settles on the true
    // track length (e.g. 36.16). Used as the near-end capture stop reference so we grab
    // the entire song rather than stopping short against a stale 36.0 snapshot.
    let maxRealDurationSeconds = Number.isFinite(mediaState.duration) && mediaState.duration > 0
      ? mediaState.duration : 0;

    const CAPTURE_ABSOLUTE_TIMEOUT_MS = Math.max(
      45000,
      mediaState.duration > 0 ? Math.round((mediaState.duration + 30) * 1000) : 45000
    );
    const CAPTURE_NO_STATE_TIMEOUT_MS = 12000;
    const CAPTURE_NO_PROGRESS_TIMEOUT_MS = mediaState.duration > 0
      ? Math.min(30000, Math.max(14000, Math.round(mediaState.duration * 1000 * 0.6)))
      : 18000;
    const CAPTURE_WARN_INTERVAL_MS = 5000;
    const PROGRESS_EPSILON_SECONDS = 0.04;
    const CAPTURE_PRE_END_STOP_SECONDS = 0.85;
    const CAPTURE_TRACK_MATCH_DELTA_SECONDS = 3;

    const finalizeReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(hardTimeoutId);
      try {
        if (recorder && recorder.state !== "inactive") {
          recorder.stop();
        }
      } catch (_error) {
        // ignore
      }
      reject(error);
    };

    try {
      recorder = new MediaRecorder(rawCaptureDestination.stream, recorderOptions);
    } catch (error) {
      reject(error);
      return;
    }

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      finalizeReject(event.error || new Error("Track preparation recording failed"));
    };

    // stopMediaTime is the YT page position (seconds) at the moment we decided
    // to stop recording. Used to compute captureOffset = buffer.duration - stopMediaTime
    // in the caller. This is accurate regardless of when the stop actually happened.
    let stopMediaTime = 0;

    const terminateCapturePass = ({
      reasonCode,
      knownMediaTime = mediaState.duration,
      lockPauseFirst = true
    }) => {
      if (settled || stopScheduled) {
        return false;
      }

      stopScheduled = true;
      stopMediaTime = maxRealDurationSeconds > 0
        ? maxRealDurationSeconds
        : (Number.isFinite(mediaState.duration) && mediaState.duration > 0
          ? mediaState.duration
          : Math.max(0, Number(knownMediaTime) || 0));

      console.log(`[Capture] terminateCapturePass reason=${reasonCode} stopMediaTime=${stopMediaTime.toFixed(2)}`);

      if (lockPauseFirst) {
        sendMessageToActiveTab({ type: "PAUSE_ORIGINAL_MEDIA" });
      }

      seekActiveTabMediaToTime(0);

      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      return true;
    };

    recorder.onstop = async () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(hardTimeoutId);

      if (!chunks.length) {
        reject(new Error("No audio captured during the preparation pass"));
        return;
      }

      // Baseline behaviour: just hand the recorded audio back and let the caller
      // resume the muted track and loop it at 0:00 while Demucs processes. We must
      // NOT gate capture success on the page confirming "playing" here — YT pauses
      // an ended track, so a verify-and-retry restart stalls and throws
      // CAPTURE_FAIL_LOOP_RESTART, leaving the song paused and never producing the
      // instrumental.
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      console.log(`[Capture] recorder.onstop — chunks=${chunks.length} blobSize=${blob.size} stopMediaTime=${stopMediaTime.toFixed(2)}`);
      resolve({
        blob,
        stopMediaTime,
        realDurationSeconds: maxRealDurationSeconds
      });
    };

    // Start recording immediately. The buffer will contain a brief pre-song
    // pipeline fill-in. captureOffset = buffer.duration - stopMediaTime is computed
    // by the caller after decoding, and applied as: desiredOffset = currentTime + captureOffset.
    recorder.start(1000);

    // Hard timeout — if capture hasn't resolved within song duration + 15s,
    // the track must have changed or stalled. Reject rather than record into Song 2.
    if (mediaState.duration > 0) {
      hardTimeoutId = setTimeout(() => {
        finalizeReject(new Error("CAPTURE_FAIL_ABSOLUTE_TIMEOUT: Capture timed out — the track may have ended or changed"));
      }, (mediaState.duration + 15) * 1000);
    }

    seekActiveTabMediaToTime(0);
    schedulePreparedInstrumentalAction(sessionId, 120, () => {
      playActiveTabMedia();
    });

    // Track the last observed currentTime to detect backward seeks.
    let lastSeenCurrentTime = -1;
    // We deliberately seek the page to 0:00 at capture start. Until that seek is
    // observed (currentTime drops near 0), ignore the stale pre-seek tail position.
    // Otherwise a song sitting near its end (e.g. 35s) is misread on the first polls
    // as either an immediate "near end" stop or a backward-jump "track changed"
    // abort — before any audio is captured. (Bug: enabling isolation while the song
    // sat at its end produced CAPTURE_FAIL_TRACK_CHANGED with lastSeen=35.67.)
    let sawSeekToZero = false;
    const SEEK_ZERO_CONFIRM_SECONDS = 2.0;

    const poll = async () => {
      if (settled) {
        return;
      }
      if (sessionId !== preparedInstrumentalSessionId || !preparedInstrumentalPreparing) {
        finalizeReject(new Error("CAPTURE_FAIL_CANCELLED: Instrumental preparation cancelled"));
        return;
      }

      const now = Date.now();
      const elapsedMs = now - captureStartedAtMs;
      if (elapsedMs > CAPTURE_ABSOLUTE_TIMEOUT_MS) {
        finalizeReject(new Error(`CAPTURE_FAIL_ABSOLUTE_TIMEOUT: Capture exceeded ${Math.round(CAPTURE_ABSOLUTE_TIMEOUT_MS / 1000)}s timeout`));
        return;
      }

      const state = await getActiveTabMediaState();
      if (state?.success) {
        lastStateSuccessAtMs = now;

        if (Number.isFinite(state.duration) && state.duration > 0 && mediaState.duration > 0
          && Math.abs(state.duration - mediaState.duration) <= 5
          && state.duration > maxRealDurationSeconds) {
          maxRealDurationSeconds = state.duration;
        }

        // Gate: wait for our seek-to-0 to land before running any end/backward
        // detection. Re-issue the seek while the page is still on the pre-seek tail.
        if (!sawSeekToZero) {
          if (Number(state.currentTime) <= SEEK_ZERO_CONFIRM_SECONDS) {
            sawSeekToZero = true;
            lastSeenCurrentTime = state.currentTime;
            lastProgressAdvanceAtMs = now;
          } else {
            seekActiveTabMediaToTime(0);
            schedulePreparedInstrumentalAction(sessionId, 150, () => {
              void poll();
            });
            return;
          }
        }

        if (lastSeenCurrentTime < 0 || state.currentTime > lastSeenCurrentTime + PROGRESS_EPSILON_SECONDS) {
          lastProgressAdvanceAtMs = now;
        }

        const nearEndProgressWindow = mediaState.duration > 0 &&
          (lastSeenCurrentTime >= mediaState.duration - 8 || state.currentTime >= mediaState.duration - 8);
        if (!nearEndProgressWindow) {
          const noProgressMs = now - lastProgressAdvanceAtMs;
          if (noProgressMs > CAPTURE_NO_PROGRESS_TIMEOUT_MS) {
            finalizeReject(new Error(`CAPTURE_FAIL_NO_PROGRESS: Timeline stalled for ${(noProgressMs / 1000).toFixed(1)}s during capture`));
            return;
          }
        }

        // Check if we're near the natural end BEFORE evaluating backward jumps.
        // YT Music can reset currentTime to ~0 slightly early; if that reset happens
        // after we've already captured most of the song, treat it as natural end.
        const nearEnd = mediaState.duration > 0 && (
          lastSeenCurrentTime >= mediaState.duration - 2.5 ||
          // Guard against coarse polling missing the final 2.5s window.
          (lastSeenCurrentTime >= mediaState.duration - 6 && state.currentTime < 1.5) ||
          // Fractional fallback for songs whose timeline updates are jittery near end.
          (lastSeenCurrentTime >= mediaState.duration * 0.94 && state.currentTime < 1.5)
        );

        // Helper: stop recording after a short drain delay so the audio pipeline
        // flushes the last few seconds into the recorder before we close it.
        // seekActiveTabMediaToTime(0) is called AFTER the delay so YT's next-song
        // audio does not contaminate the recording tail.
        const stopAfterTail = (knownMediaTime) => {
          if (settled || stopScheduled) return;
          stopScheduled = true;
          const tailMs = Math.max(300, Math.min(4000,
            (mediaState.duration - knownMediaTime) * 1000 + 500
          ));
          stopMediaTime = mediaState.duration;
          console.log(`[Capture] stopAfterTail scheduled: knownMediaTime=${knownMediaTime.toFixed(2)} songDuration=${mediaState.duration.toFixed(2)} tailMs=${tailMs}`);
          setTimeout(() => {
            if (!settled) {
              console.log('[Capture] stopAfterTail timer fired — stopping recorder');
              stopScheduled = false;
              terminateCapturePass({
                reasonCode: "CAPTURE_STOP_NEAR_END",
                knownMediaTime,
                lockPauseFirst: true
              });
            }
          }, tailMs);
        };

        // YT Music sets video.ended = true up to ~2 s before the last audio frame
        // plays (it pre-renders the next song). Stopping immediately on ended loses
        // those final seconds. If we haven't yet seen the full duration, wait for
        // the audio tail to drain before stopping.
        if (state.ended) {
          const knownTime = lastSeenCurrentTime > 0 ? lastSeenCurrentTime : state.currentTime;
          // With Repeat One engaged there is no next track being pre-rendered, yet YT can
          // still flag `ended` up to ~2s before the final audio frame plays. Honoring it
          // would truncate the last seconds of the capture (the "audio cuts at 0:35 of
          // 0:37" symptom). Ignore an early ended and keep recording — the audio keeps
          // playing to the true end, and the pre-end / loop-back guards below stop us
          // there. Only honor ended once currentTime is genuinely at the true end.
          if (preparedInstrumentalRepeatOneEngaged && mediaState.duration > 0
            && knownTime < mediaState.duration - 1.0 && state.currentTime < mediaState.duration - 1.0) {
            console.log(`[Capture] ignoring early ended (Repeat One) knownTime=${knownTime.toFixed(2)} songDuration=${mediaState.duration.toFixed(2)}`);
          } else {
            console.log(`[Capture] state.ended=true knownTime=${knownTime.toFixed(2)} songDuration=${mediaState.duration.toFixed(2)}`);
            terminateCapturePass({
              reasonCode: "CAPTURE_STOP_ENDED",
              knownMediaTime: knownTime,
              lockPauseFirst: true
            });
            return;
          }
        }

        // Stop just before the natural end (currentTime reached the end).
        // Keep this close to the end so capture does not visibly freeze early. With
        // Repeat One engaged we can safely capture almost the entire song (no next
        // gapless track to contaminate the tail), so use a much tighter margin — the
        // 0.85s default was clipping the last ~1s of the looped instrumental.
        // With Repeat One engaged there is no next gapless track to protect against,
        // so capture right up to the true end (against the real, non-polluted duration)
        // to grab the whole song. YT loops by tearing the element down (`emptied`) and
        // reloading from 0 at ~the true end, so the backward-jump guard below is the
        // backstop if this tight margin is overshot.
        const effectiveEndSeconds = maxRealDurationSeconds > 0 ? maxRealDurationSeconds : mediaState.duration;
        const preEndStopSeconds = preparedInstrumentalRepeatOneEngaged ? 0.05 : CAPTURE_PRE_END_STOP_SECONDS;
        if (effectiveEndSeconds > 0 && state.currentTime >= effectiveEndSeconds - preEndStopSeconds) {
          console.log(`[Capture] currentTime near end: currentTime=${state.currentTime.toFixed(2)} songDuration=${effectiveEndSeconds.toFixed(2)}`);
          terminateCapturePass({
            reasonCode: "CAPTURE_STOP_NEAR_END",
            knownMediaTime: state.currentTime,
            lockPauseFirst: true
          });
          return;
        }

        // A backward jump of >2s means either a track change OR a natural song end
        // where we missed the guard above. Do NOT check document.title — YT Music
        // mutates it mid-playback (artist format changes) and causes false aborts.
        const backwardJump = lastSeenCurrentTime >= 0 && state.currentTime < lastSeenCurrentTime - 2.0;

        if (backwardJump) {
          console.log(`[Capture] backwardJump: lastSeen=${lastSeenCurrentTime.toFixed(2)} currentTime=${state.currentTime.toFixed(2)} nearEnd=${nearEnd}`);
          if (nearEnd) {
            terminateCapturePass({
              reasonCode: "CAPTURE_STOP_BACKWARD_NEAR_END",
              knownMediaTime: lastSeenCurrentTime,
              lockPauseFirst: true
            });
          } else {
            finalizeReject(new Error("CAPTURE_FAIL_TRACK_CHANGED: Track changed during the silent preparation pass"));
          }
          return;
        }

        lastSeenCurrentTime = state.currentTime;

        const progress = mediaState.duration > 0
          ? Math.min(96, (state.currentTime / mediaState.duration) * 100)
          : null;
        setInstrumentalPreparationUi({
          visible: true,
          phase: "capture",
          headline: preparedInstrumentalTrackTitle || "Scrubbing silently through this track",
          detail: "First pass of 2. We mute the page and scrub from the start so the full song can be captured before processing.",
          progress,
          progressText: mediaState.duration > 0
            ? `${formatDurationMs(state.currentTime * 1000)} / ${formatDurationMs(mediaState.duration * 1000)}`
            : "Capturing..."
        });
      } else {
        const noStateMs = now - lastStateSuccessAtMs;
        if (noStateMs > CAPTURE_NO_STATE_TIMEOUT_MS) {
          finalizeReject(new Error(`CAPTURE_FAIL_NO_STATE: No media state updates for ${(noStateMs / 1000).toFixed(1)}s`));
          return;
        }
        if (now - lastLivenessWarnAtMs >= CAPTURE_WARN_INTERVAL_MS) {
          lastLivenessWarnAtMs = now;
          console.warn(`[Capture] liveness warn: media state unavailable for ${(noStateMs / 1000).toFixed(1)}s`);
        }
      }

      // Only reschedule if the recorder is still running. The end-detection
      // branches above all `return` out of the if(state?.success) block but
      // fall through to here — check both `settled` and `stopScheduled` to
      // prevent re-polling once a deferred stop has been queued.
      if (settled || stopScheduled) {
        return;
      }

      // Poll every 100ms in the last 8 seconds so the end-guard fires before
      // YT Music auto-advances to the next song between polls.
      const nearSongEnd = mediaState.duration > 0 && state?.success &&
        lastSeenCurrentTime >= mediaState.duration - 8;
      schedulePreparedInstrumentalAction(sessionId, nearSongEnd ? 100 : 500, () => {
        void poll();
      });
    };

    void poll();
  });
}

// --- DO NOT EDIT casually — THE prepared isolation flow (see AGENTS.md "Fragile code"). ---
// Contains keepSongLooping, the hard-loop enforcer, and the sync watchdog.
// After changes: node --check + verify_voice_isolation_lock.sh + test BOTH modes in Chrome.
async function startPreparedInstrumentalMode() {
  console.log("[Prepared Instrumental] Function called - checking prerequisites...");

  // Which stem this prepared full-track session isolates. Both dropdown options
  // (voice-only and instrumental-only) run through this same order-of-operations;
  // only the requested stem differs. Captured once here so a mid-session dropdown
  // change (which stops + restarts this flow) can't swap the stem underneath us.
  preparedInstrumentalStemName = voiceIsolationMode === "instrumental" ? "instrumental" : "vocals";
  const preparedStemName = preparedInstrumentalStemName;

  if (!stream || !audioContext || !inputSourceNode || !inputMixNode) {
    console.error("[Prepared Instrumental] Missing audio context:", { stream: !!stream, audioContext: !!audioContext, inputSourceNode: !!inputSourceNode, inputMixNode: !!inputMixNode });
    setVoiceIsolationStatus("off - start capture first");
    return false;
  }

  const available = companionEngineAvailable || await checkCompanionEngine({ silent: true });
  if (!available) {
    console.error("[Prepared Instrumental] Companion engine not available");
    setVoiceIsolationStatus(`Pro engine unavailable for ${preparedStemName} preparation`);
    return false;
  }
  
  console.log("[Prepared Instrumental] Prerequisites OK - starting capture process...");

  stopPreparedInstrumentalMode({ preserveBuffer: false, keepMuted: true, keepStatus: true });
  const sessionId = preparedInstrumentalSessionId;

  preparedInstrumentalPreparing = true;
  preparedInstrumentalActive = false;

  // Declared outside the try so the catch block can clear it on failure.
  let processingLoopTimer = null;

  try {
    await resetVoiceIsolationRoutingForPreparedInstrumental();
    setPreparedInstrumentalState(PREPARED_INSTRUMENTAL_STATE.CAPTURING, sessionId);

    const mediaState = await getActiveTabMediaState();
    if (!mediaState?.success || !Number.isFinite(mediaState.duration) || mediaState.duration < 5) {
      throw new Error("Could not read the current track timeline from the page");
    }

    // Include the stem in the cache key so voice-only and instrumental-only of the
    // SAME song don't collide (a cached instrumental must never be served as vocals).
    preparedInstrumentalTrackKey = `${getPreparedInstrumentalCacheKey(mediaState)}|${preparedStemName}`;
    preparedInstrumentalTrackTitle = mediaState.title || "Current track";
    // Snapshot the TRUE song length now, while the page timeline is still clean.
    // After playback passes ~ct=26 YouTube Music gapless-extends the live duration
    // to the whole queue (e.g. 36s -> 180s); every loop boundary uses this snapshot
    // instead of the polluted live duration. Refined from the captured buffer below.
    preparedInstrumentalSongDurationSeconds = mediaState.duration;

    // Engage YouTube's OWN "Repeat One" so YT loops THIS track natively at its true
    // end — no gapless boundary race, no early cut, and it clicks the button for the
    // user so the experience stays automatic. If the repeat control can't be driven
    // (`engaged: false`), the hard-loop enforcer's safe seek-loop fallback takes over.
    // Restored to the user's original repeat mode on stop / failure.
    try {
      const repeatResult = await requestCapturedTabMessage({ type: "SET_REPEAT_ONE", payload: { enabled: true } });
      preparedInstrumentalRepeatOneEngaged = Boolean(repeatResult && repeatResult.engaged);
      console.log(`[Prepared Instrumental] Repeat-One ${preparedInstrumentalRepeatOneEngaged
        ? "engaged — YouTube owns the loop at the true track end"
        : "unavailable — using the safe seek-loop fallback"}`);
    } catch (_repeatErr) {
      preparedInstrumentalRepeatOneEngaged = false;
    }

    if (preparedInstrumentalCache.has(preparedInstrumentalTrackKey)) {
      const cached = preparedInstrumentalCache.get(preparedInstrumentalTrackKey);
      preparedInstrumentalBuffer = cached.buffer;
      preparedInstrumentalCaptureMediaTimeOffset = cached.captureOffset;
      preparedInstrumentalPreparing = false;
      preparedInstrumentalActive = true;
      setPreparedInstrumentalState(PREPARED_INSTRUMENTAL_STATE.PLAYBACK_READY, sessionId);
      // Silence via content script (MutationObserver will re-enforce el.volume=0).
      await silenceMediaElementsOnly();
      connectOutputDestination();
      seekActiveTabMediaToTime(0);
      playActiveTabMedia();
      await startPreparedInstrumentalSourceAt(preparedInstrumentalCaptureMediaTimeOffset, 1, sessionId);
      preparedInstrumentalSyncStartTime = Date.now();
      preparedInstrumentalSyncTickCount = 0;
      startPreparedInstrumentalSyncWatchdog(sessionId);
      startPreparedInstrumentalHardLoopEnforcer(sessionId, mediaState.duration);
      schedulePreparedInstrumentalSync(sessionId, 1000);
      return true;
    }

    disconnectOutputDestination();
    // Use Chrome-level tab mute for the capture pass. Chrome-level mute is applied
    // in the browser process AFTER the tabCapture tap, so rawCaptureDestination
    // still receives the full audio signal. el.volume=0 (content script) is applied
    // in the renderer process BEFORE the tabCapture tap and would cause the recorder
    // to capture silence. Chrome-level mute also silences the Web Audio
    // context.destination, but that is already disconnected above so it doesn't
    // matter here. We switch to el.volume=0 lock right before playback starts.
    console.log("[Prepared Instrumental] Muting tab (Chrome-level) for silent capture...");
    muteTabChromeLevel();
    setPreparedInstrumentalState(PREPARED_INSTRUMENTAL_STATE.CAPTURING, sessionId);
    setVoiceIsolationStatus(`preparing full-track ${preparedStemName}`);
    setInstrumentalPreparationUi({
      visible: true,
      phase: "capture",
      headline: preparedInstrumentalTrackTitle,
      detail: `First pass of 2. The track will restart silently so the extension can capture the full song before processing it into ${preparedStemName}-only audio.`,
      progress: 0,
      progressText: "Seeking to start..."
    });

    // Seek to t=0 and wait for the audio pipeline to stabilise before starting
    // the MediaRecorder. Without this, capture begins from wherever the song
    // currently is, so only the remaining portion is recorded and processed.
    console.log("[Prepared Instrumental] Seeking to 0:00 and starting playback (muted)...");
    seekActiveTabMediaToTime(0);
    playActiveTabMedia(); // defensive: some players pause briefly on seek
    await new Promise(resolve => setTimeout(resolve, 800));
    if (sessionId !== preparedInstrumentalSessionId || !preparedInstrumentalPreparing) {
      return false;
    }

    // Verify the seek actually landed near 0 before recording. If the song sat at
    // its end when isolation was enabled, the first seek can be dropped (YT ignores
    // seeks on an ended element), so capture would start from the wrong position and
    // the end-of-song reset is misread as a track change. Re-seek until stable.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (sessionId !== preparedInstrumentalSessionId || !preparedInstrumentalPreparing) {
        return false;
      }
      const seekState = await getActiveTabMediaState();
      if (seekState?.success && Number(seekState.currentTime) <= 2.0) {
        break;
      }
      console.log(`[Prepared Instrumental] Seek-to-0 not settled (ct=${Number(seekState?.currentTime || 0).toFixed(2)}); re-seeking (${attempt + 1}/6)`);
      seekActiveTabMediaToTime(0);
      playActiveTabMedia();
      await new Promise(resolve => setTimeout(resolve, 400));
    }

    const { blob: rawBlob, stopMediaTime: captureStopMediaTime, realDurationSeconds: captureRealDuration } = await capturePreparedInstrumentalPass(sessionId, mediaState);
    if (sessionId !== preparedInstrumentalSessionId || !preparedInstrumentalPreparing) {
      return false;
    }

    // Capture is complete (first full muted loop recorded). Clear the transient
    // pause lock applied during recorder stop, then loop the captured song
    // silently at 0:00 (still Chrome-level muted) while Demucs processes. This is
    // the proven baseline behaviour: the muted track keeps playing FULL loops
    // (2nd, 3rd, ...) until the instrumental is ready, then we hand off to the AI
    // buffer at 0:00. A simple seek+play loop is far more reliable than the
    // verify-and-retry restart gauntlet, which stalled when YT pauses an ended
    // track and parked the song near its end.
    sendMessageToActiveTab({ type: "RESUME_ORIGINAL_MEDIA" });
    const WRONG_SONG_DURATION_DELTA_SECONDS = 15;
    const isWrongSongDuration = (durationSeconds) => mediaState.duration > 5 && Number(durationSeconds) > 0
      && Math.abs(Number(durationSeconds) - mediaState.duration) > WRONG_SONG_DURATION_DELTA_SECONDS;
    // Kick off the second silent loop immediately: restart from 0:00 and replay.
    // restartAndPlayActiveTabFromZero clicks YT's Play button when the track has
    // ended, so an ended track actually replays (a raw play() would not) and the
    // page timeline visibly returns to 0:00 for the next muted loop.
    restartAndPlayActiveTabFromZero();

    setInstrumentalPreparationUi({
      visible: true,
      phase: "process",
      headline: preparedInstrumentalTrackTitle,
      detail: `Processing... this track is looping silently while the ${preparedStemName} version is being prepared.`,
      progress: 98,
      progressText: `Processing ${preparedStemName}...`
    });

    // Loop-guardian (baseline behaviour): every 2.5 s, if the silent song has
    // reached its end, seek back to 0:00 and replay so it keeps looping in FULL
    // throughout Demucs processing (2nd, 3rd, ... muted loops). A plain seek+play
    // is far more reliable than a verify-and-retry restart, which stalls when YT
    // pauses an ended track and leaves the song parked near the end.
    let guardianRecoveryExhausted = false;
    const keepSongLooping = async () => {
      if (sessionId !== preparedInstrumentalSessionId || !preparedInstrumentalPreparing) return;
      try {
        const loopState = await getActiveTabMediaState();
        if (loopState?.success && sessionId === preparedInstrumentalSessionId && preparedInstrumentalPreparing) {
          console.log(`[ProcLoop][Diag] ct=${Number(loopState.currentTime || 0).toFixed(2)} dur=${Number(loopState.duration || 0).toFixed(2)} paused=${loopState.paused} ended=${loopState.ended} cs=${loopState.csVersion || "?"} els=[${loopState.elInfo || ""}]`);
          // During processing the muted track must ALWAYS be playing a silent
          // loop. Restart from 0:00 when it has ended, reached the end, OR is
          // simply paused/parked. The paused case is essential: when YT Music
          // tears down the ended track's MSE buffer it parks the page on a
          // phantom element (duration 0, currentTime 0, ended=false) — neither
          // the ended nor the near-end clause fires, so without the paused
          // check the guardian would give up and the song stays stopped at the
          // end instead of looping. restartAndPlayActiveTabFromZero clicks YT's
          // Play button to force a real replay, and is a no-op when the track
          // is already playing, so re-issuing it every cycle is safe.
          // Near-end looping is owned by the 320ms hard-loop enforcer, which seeks
          // right at the true song boundary. The guardian's 2500ms poll is too coarse
          // for a tight boundary and previously fired ~3s early (cutting the song
          // short at ~34s); here it only recovers the ended/paused/parked cases.
          if (loopState.ended || loopState.paused) {
            // Restart from 0:00. When the track has ENDED this clicks YT's Play
            // button (a raw play() cannot resume an ended MSE track), so the page
            // timeline actually loops back to 0:00 for the next muted pass.
            restartAndPlayActiveTabFromZero();
          }
        }
      } catch (_e) { /* ignore */ }
      if (sessionId === preparedInstrumentalSessionId && preparedInstrumentalPreparing) {
        processingLoopTimer = setTimeout(keepSongLooping, 2500);
      }
    };
    processingLoopTimer = setTimeout(keepSongLooping, 2500);

    // Start the ticking ETA timer now that Demucs is about to begin.
    startProcessingProgressTimer(mediaState.duration);

    console.log("[Prepared Instrumental] Starting Demucs processing - this will take 1-2 minutes...");
    const rawAudioBuffer = await decodeBlobToAudioBuffer(rawBlob);
    console.log("[Prepared Instrumental] Audio decoded, sending to Demucs...");
    const stems = await requestCompanionStems(rawAudioBuffer, [preparedStemName]);
    console.log("[Prepared Instrumental] Demucs processing complete!");
    stopProcessingProgressTimer();
    clearTimeout(processingLoopTimer);
    processingLoopTimer = null;
    setPreparedInstrumentalState(PREPARED_INSTRUMENTAL_STATE.PROCESSING, sessionId);

    // If the server fell back to CPU, surface that information so the user isn't confused.
    if (stems._deviceUsed === "cpu") {
      console.warn("[Audio Mixer] Demucs ran on CPU (MPS OOM fallback) — processing was slower than expected");
      setVoiceIsolationStatus(`${preparedStemName} ready (processed on CPU — close tabs to restore MPS speed)`);
    }
    if (sessionId !== preparedInstrumentalSessionId || !preparedInstrumentalPreparing) {
      return false;
    }
    if (guardianRecoveryExhausted) {
      throw new Error("TRACK_RECOVERY_EXHAUSTED: Could not return to captured song during processing");
    }

    // Verify the track hasn't changed while Demucs was processing. With the
    // immediate seek-to-0 capture gate and the silent loop above, the page stays
    // pinned to the captured song, so this should always match. Warn but never
    // abort — a false positive here is worse than continuing with a slightly
    // mismatched track.
    const postProcessState = await getActiveTabMediaState();
    if (postProcessState?.success && postProcessState.duration > 5 && mediaState.duration > 0) {
      if (isWrongSongDuration(postProcessState.duration)) {
        console.warn(`[Audio Mixer] Post-process track duration mismatch: captured=${mediaState.duration}s current=${postProcessState.duration}s — continuing anyway`);
      }
    }
    if (sessionId !== preparedInstrumentalSessionId || !preparedInstrumentalPreparing) {
      return false;
    }

    preparedInstrumentalBuffer = stems[preparedStemName];
    console.log(`[Capture] rawAudioBuffer.duration=${rawAudioBuffer.duration.toFixed(2)} stems.${preparedStemName}.duration=${stems[preparedStemName].duration.toFixed(2)} mediaState.duration=${mediaState.duration.toFixed(2)} realDuration=${(captureRealDuration || 0).toFixed(2)} captureStopMediaTime=${captureStopMediaTime.toFixed(2)}`);
    // captureOffset = how much pre-song fill-in is at the start of the buffer.
    // The recording starts right at seek-to-0, so the buffer contains a short
    // pre-song pipeline fill followed by the full song. captureOffset is therefore
    // approximately (buffer.duration - song_duration).
    //
    // We use the real track duration (max non-polluted live duration observed during
    // capture, e.g. 36.16) rather than captureStopMediaTime here. captureStopMediaTime
    // is set from lastSeenCurrentTime (the previous poll's position, typically 100–500 ms
    // behind) and can lag the true stop point by ~2 s when YT auto-advances via the
    // backward-jump path. If we use that stale value, captureOffset ends up ~2 s too
    // large, making bufferAlmostDone fire 2 s before the actual end of the song. We fall
    // back to the snapshot mediaState.duration if the real duration wasn't observed.
    const effectiveSongDuration = captureRealDuration > 0 ? captureRealDuration : mediaState.duration;
    preparedInstrumentalCaptureMediaTimeOffset = Math.max(0,
      preparedInstrumentalBuffer.duration - effectiveSongDuration
    );
    // Store buffer AND captureOffset together so cache hits use the correct offset.
    preparedInstrumentalCache.set(preparedInstrumentalTrackKey, {
      buffer: preparedInstrumentalBuffer,
      captureOffset: preparedInstrumentalCaptureMediaTimeOffset
    });
    // Keep the cache bounded (oldest-first eviction; Map preserves insertion order).
    if (preparedInstrumentalCache.size > 3) {
      preparedInstrumentalCache.delete(preparedInstrumentalCache.keys().next().value);
    }
    preparedInstrumentalPreparing = false;
    preparedInstrumentalActive = true;
    setPreparedInstrumentalState(PREPARED_INSTRUMENTAL_STATE.PLAYBACK_READY, sessionId);

    console.log("[Prepared Instrumental] Transitioning from capture mute to playback mode...");
    // Transition from Chrome-level mute (capture) to el.volume=0 lock (playback).
    // Order matters:
    // 1. silenceMediaElementsOnly: locks el.volume=0 in the content script
    // 2. RESUME_ORIGINAL_MEDIA: clears isPausedForIsolation so playActiveTabMedia works
    // 3. unmuteTabChromeLevel: removes Chrome-level mute so Web Audio output is heard
    // 4. seek + play: starts the YT player at 0 (keeps the sync clock alive)
    // 5. startPreparedInstrumentalSourceAt: starts the AI buffer through the graph
    await silenceMediaElementsOnly();
    sendMessageToActiveTab({ type: "RESUME_ORIGINAL_MEDIA" });
    unmuteTabChromeLevel();
    connectOutputDestination();
    // Baseline handoff: restart the now-silenced page track from 0:00 so the
    // page timeline matches the instrumental playback. restartAndPlayActiveTabFromZero
    // clicks YT's Play button when the track has ended (a raw play() cannot resume
    // an ended MSE track and would leave the timeline frozen at the end), then we
    // start the instrumental buffer through the graph.
    restartAndPlayActiveTabFromZero();
    console.log("[Prepared Instrumental] Starting instrumental buffer playback...");
    // Only Web Audio (the instrumental buffer) reaches the speakers now.
    setPreparedInstrumentalState(PREPARED_INSTRUMENTAL_STATE.PLAYBACK_ACTIVE, sessionId);
    await startPreparedInstrumentalSourceAt(preparedInstrumentalCaptureMediaTimeOffset, 1, sessionId);
    // Give YT Music a moment to settle its duration after seek+play before the
    // first sync check runs.
    preparedInstrumentalSyncStartTime = Date.now();
    preparedInstrumentalSyncTickCount = 0;
    startPreparedInstrumentalSyncWatchdog(sessionId);
    startPreparedInstrumentalHardLoopEnforcer(sessionId, mediaState.duration);
    schedulePreparedInstrumentalSync(sessionId, 1000);
    console.log("[Prepared Instrumental] ✅ Setup complete - instrumental should now be playing!");
    return true;
  } catch (error) {
    const abortContinuityState = await getActiveTabMediaState();
    if (!continuityGatePass(abortContinuityState, "G11_ABORT_CLEANUP_INTEGRITY", { requireControlReady: false })) {
      console.warn("[Prepared Instrumental][G11_ABORT_CLEANUP_INTEGRITY] Continuity metadata unavailable during cleanup");
    }
    clearTimeout(processingLoopTimer);
    stopProcessingProgressTimer();
    // Remove Chrome-level mute applied during capture, and release content-script lock.
    unmuteTabChromeLevel();
    connectOutputDestination();
    if (!userPausedBrowserAudio) {
      try {
        await restoreMediaElementVolume();
      } catch (restoreError) {
        console.warn("[Audio Mixer] Failed to restore media element volume after preparation failure:", restoreError);
      }
    }
    preparedInstrumentalPreparing = false;
    preparedInstrumentalActive = false;
    clearPreparedInstrumentalSyncTimer();
    clearPreparedInstrumentalSyncWatchdog();
    clearPreparedInstrumentalHardLoopEnforcer();
    // Restore the user's original repeat mode if we engaged Repeat One before failing.
    if (preparedInstrumentalRepeatOneEngaged) {
      sendMessageToActiveTab({ type: "SET_REPEAT_ONE", payload: { enabled: false } });
      preparedInstrumentalRepeatOneEngaged = false;
    }
    // Restore direct routing on error so the audio graph isn't left with inputSourceNode
    // disconnected from inputMixNode.
    if (inputSourceNode && inputMixNode) {
      try { inputSourceNode.disconnect(inputMixNode); } catch (_e) {}
      inputSourceNode.connect(inputMixNode);
    }
    clearInstrumentalPreparationUi();
    setVoiceIsolationStatus(`⚠️ ${preparedStemName} preparation failed: ${error.message || error}`);
    if (enableVoiceIsolationInput) {
      enableVoiceIsolationInput.checked = false;
    }
    voiceIsolationEnabled = false;
    return false;
  }
}

function clearMuteSafetyTimer() {
  if (muteSafetyTimer) {
    clearTimeout(muteSafetyTimer);
    muteSafetyTimer = null;
  }
}

function sampleAnalyserRms(analyserNode) {
  if (!analyserNode) {
    return 0;
  }

  const buffer = new Float32Array(analyserNode.fftSize);
  analyserNode.getFloatTimeDomainData(buffer);

  let energy = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i];
    energy += sample * sample;
  }

  return Math.sqrt(energy / buffer.length);
}

function getAudioBufferRms(buffer) {
  if (!buffer || !buffer.numberOfChannels || !buffer.length) {
    return 0;
  }

  let energy = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i += 1) {
      const sample = data[i];
      energy += sample * sample;
    }
  }

  return Math.sqrt(energy / (buffer.length * buffer.numberOfChannels));
}

function isUsableCompanionFirstChunk(buffer) {
  if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration < 0.35) {
    return false;
  }

  return getAudioBufferRms(buffer) > 1.0e-5;
}

function applySafeOriginalMute() {
  // Only auto-mute source media when isolation is explicitly enabled.
  // For plain capture/effects mode, keep source audio fail-open to avoid accidental silence.
  if (!voiceIsolationEnabled) {
    clearMuteSafetyTimer();
    unmuteOriginalTabMedia();
    return;
  }

  clearMuteSafetyTimer();
  muteSafetyAttempts = 0;
  let readyChecks = 0;

  // Fail-open first: keep source audible until processed output is clearly stable.
  unmuteOriginalTabMedia();

  const tryMute = () => {
    muteSafetyTimer = null;

    if (!stream) {
      return;
    }

    const inputRms = sampleAnalyserRms(inputLevelAnalyserNode);
    const outputRms = sampleAnalyserRms(outputLevelAnalyserNode);
    const hasInputSignal = inputRms > 0.0025;
    const outputToInputRatio = outputRms / Math.max(inputRms, 1e-6);
    const currentOutputGain = Number(volumeInput?.value ?? 1);

    // Require a stronger, sustained output signal before muting the source tab.
    const hasStableOutput =
      currentOutputGain > 0.05 &&
      outputRms > 0.0012 &&
      outputToInputRatio > 0.08;

    if (hasInputSignal && hasStableOutput) {
      readyChecks += 1;
    } else {
      readyChecks = 0;
    }

    if (readyChecks >= 3) {
      muteOriginalTabMedia();
      return;
    }

    if (muteSafetyAttempts < MUTE_SAFETY_MAX_ATTEMPTS) {
      muteSafetyAttempts += 1;
      muteSafetyTimer = setTimeout(tryMute, MUTE_SAFETY_RETRY_MS);
      return;
    }

    // Timed out waiting for stable processed output: keep original tab audio on.
    unmuteOriginalTabMedia();
    setStatus("Capture running (processed output not stable yet - keeping original tab audio on)");
    console.warn("[Audio Mixer] Skipped source mute because processed output was not stable.");
  };

  // Give the graph a short warm-up, then keep retrying until signal is detected.
  muteSafetyTimer = setTimeout(tryMute, 600);
}

function toggleLiveStemRouting() {
  const pitchTargetNode = pitchShifterNode || bassNode;
  if (!pitchTargetNode || !liveStemMixerNode || !inputMixNode) {
    return;
  }

  console.log("[Live Stem] Toggling routing, enabled:", liveStemMixingEnabled);

  try {
    // Disconnect existing direct routing to target node.
    inputMixNode.disconnect(pitchTargetNode);
  } catch (e) {
    // May not be connected
  }

  try {
    // Disconnect stem mixer from target node.
    liveStemMixerNode.disconnect(pitchTargetNode);
  } catch (e) {
    // May not be connected
  }

  if (liveStemMixingEnabled) {
    // Route through stem splitter: inputMixNode -> filters -> mixer -> pitch target.
    liveStemMixerNode.connect(pitchTargetNode);
    console.log("[Live Stem] Enabled stem mixing routing");
  } else {
    // Bypass stem splitter: inputMixNode -> pitch target directly.
    inputMixNode.connect(pitchTargetNode);
    console.log("[Live Stem] Bypassed stem mixing routing");
  }

  // Update stem gain values from controls
  updateLiveStemGains();
}

function updateLiveStemGains() {
  if (!liveStemLowGainNode || !liveStemMidGainNode || !liveStemHighGainNode) {
    return;
  }

  const lowGain = stemLowMuteInput.checked ? 0 : parseFloat(stemLowGainInput.value);
  const midGain = stemMidMuteInput.checked ? 0 : parseFloat(stemMidGainInput.value);
  const highGain = stemHighMuteInput.checked ? 0 : parseFloat(stemHighGainInput.value);

  liveStemLowGainNode.gain.value = lowGain;
  liveStemMidGainNode.gain.value = midGain;
  liveStemHighGainNode.gain.value = highGain;

  console.log("[Live Stem] Updated gains - Low:", lowGain, "Mid:", midGain, "High:", highGain);
}

async function buildAudioGraph(capturedStream) {
  audioContext = new AudioContext();

  if (audioContext.state === "suspended") {
    audioContext.resume().catch((err) => {
      console.error("[Audio Mixer] Failed to resume AudioContext:", err);
      setStatus("Warning: AudioContext suspended - click in page to activate");
    });
  }

  const fx = createFxGraph(audioContext);

  inputMixNode = fx.inputMixNode;
  bassNode = fx.bassNode;
  preGainNode = fx.preGainNode;
  dryGainNode = fx.dryGainNode;
  wetGainNode = fx.wetGainNode;
  distortionNode = fx.distortionNode;
  convolverNode = fx.convolverNode;
  reverbGainNode = fx.reverbGainNode;
  chorusDelayNode = fx.chorusDelayNode;
  chorusWetGainNode = fx.chorusWetGainNode;
  chorusLfoNode = fx.chorusLfoNode;
  chorusLfoGainNode = fx.chorusLfoGainNode;
  delayNode = fx.delayNode;
  delayFeedbackNode = fx.delayFeedbackNode;
  delayFilterNode = fx.delayFilterNode;
  delayWetGainNode = fx.delayWetGainNode;
  pitchShifterNode = fx.pitchShifterNode;
  ringModCarrierNode = fx.ringModCarrierNode;
  ringModGainNode = fx.ringModGainNode;
  outputGainNode = fx.outputGainNode;
  liveStemLowFilterNode = fx.liveStemLowFilterNode;
  liveStemMidLowFilterNode = fx.liveStemMidLowFilterNode;
  liveStemMidHighFilterNode = fx.liveStemMidHighFilterNode;
  liveStemHighFilterNode = fx.liveStemHighFilterNode;
  liveStemLowGainNode = fx.liveStemLowGainNode;
  liveStemMidGainNode = fx.liveStemMidGainNode;
  liveStemHighGainNode = fx.liveStemHighGainNode;
  liveStemMixerNode = fx.liveStemMixerNode;

  // Asynchronously wire Signalsmith Stretch between inputMixNode and bassNode/dryGainNode.
  // Graph starts in direct-bypass mode; pitch becomes active once the WASM node is ready.
  createSignalsmithNode(audioContext).then(node => {
    if (!node || audioContext.state === "closed") return;
    stretchNode = node;
    pitchShifterNode = node;
    // Remove direct bypass connections
    try { inputMixNode.disconnect(bassNode); } catch {}
    try { inputMixNode.disconnect(dryGainNode); } catch {}
    // Insert stretch node
    inputMixNode.connect(stretchNode);
    stretchNode.connect(bassNode);
    stretchNode.connect(dryGainNode);
    // Re-establish stem routing with the new pitch node as target
    toggleLiveStemRouting();
    // Apply the current pitch slider value
    updatePitchShifterNode();
    console.log("[Pitch] Signalsmith Stretch node ready.");
  });

  recordingDestination = audioContext.createMediaStreamDestination();
  outputGainNode.connect(audioContext.destination);
  outputGainNode.connect(recordingDestination);
  outputDestinationConnected = true;

  inputSourceNode = audioContext.createMediaStreamSource(capturedStream);
  rawCaptureDestination = audioContext.createMediaStreamDestination();
  inputSourceNode.connect(rawCaptureDestination);

  // Meter input/output levels so capture start can fail open instead of muting all audio.
  inputLevelAnalyserNode = audioContext.createAnalyser();
  inputLevelAnalyserNode.fftSize = 2048;
  inputSourceNode.connect(inputLevelAnalyserNode);

  outputLevelAnalyserNode = audioContext.createAnalyser();
  outputLevelAnalyserNode.fftSize = 2048;
  outputGainNode.connect(outputLevelAnalyserNode);
  
  // Route through voice isolation if enabled, otherwise direct to inputMixNode.
  if (voiceIsolationEnabled && liveCompanionIsolationActive) {
    console.log("[Audio Graph] Voice isolation via companion delayed mode");
    // No direct connection here; processed chunks are injected into inputMixNode.
  } else if (voiceIsolationEnabled && voiceIsolationProcessor && voiceIsolationProcessor.isInitialized) {
    console.log("[Audio Graph] Routing through voice isolation processor");
    inputSourceNode.connect(voiceIsolationProcessor.getInputNode());
    voiceIsolationProcessor.connect(inputMixNode);
    voiceIsolationProcessor.updateMode(voiceIsolationMode);
    voiceIsolationProcessor.updateStrength(voiceIsolationStrength);
  } else {
    console.log("[Audio Graph] Direct routing (voice isolation off)");
    inputSourceNode.connect(inputMixNode);
  }

  // Set up routing based on liveStemMixingEnabled
  toggleLiveStemRouting();

  if (activeFilterPreset) {
    applyFilterPresetAtStrength();
  } else {
    applyFilterValues();
  }

  updatePitchShifterNode();
}

function tearDownAudioGraph() {
  clearMuteSafetyTimer();
  stopPreparedInstrumentalMode({ preserveBuffer: false, keepStatus: false });
  stopLiveCompanionIsolation();

  if (inputSourceNode) {
    inputSourceNode.disconnect();
    inputSourceNode = null;
  }

  if (filePlaybackSource) {
    try {
      filePlaybackSource.stop();
    } catch {
      // Ignore already-stopped source.
    }
    filePlaybackSource = null;
  }

  if (chorusLfoNode) {
    try {
      chorusLfoNode.stop();
    } catch {
      // Ignore already-stopped oscillator.
    }
  }

  if (ringModCarrierNode) {
    try {
      ringModCarrierNode.stop();
    } catch {
      // Ignore already-stopped oscillator.
    }
  }

  inputMixNode = null;
  bassNode = null;
  preGainNode = null;
  dryGainNode = null;
  wetGainNode = null;
  distortionNode = null;
  convolverNode = null;
  reverbGainNode = null;
  chorusDelayNode = null;
  chorusWetGainNode = null;
  chorusLfoNode = null;
  chorusLfoGainNode = null;
  delayNode = null;
  delayFeedbackNode = null;
  delayFilterNode = null;
  delayWetGainNode = null;
  ringModCarrierNode = null;
  ringModGainNode = null;
  outputGainNode = null;
  reverbImpulseCacheKey = "";
  stretchNode = null;
  pitchShifterNode = null;
  liveStemLowFilterNode = null;
  liveStemMidLowFilterNode = null;
  liveStemMidHighFilterNode = null;
  liveStemHighFilterNode = null;
  liveStemLowGainNode = null;
  liveStemMidGainNode = null;
  liveStemHighGainNode = null;
  liveStemMixerNode = null;
  inputLevelAnalyserNode = null;
  outputLevelAnalyserNode = null;
  recordingDestination = null;
  rawCaptureDestination = null;
  outputDestinationConnected = false;

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

function invalidateStemMixCache() {
  cachedStemMixBuffer = null;
  cachedStemMixKey = "";
  cachedProcessedStemBuffers.clear();
}

function getDefaultCleanupSettings() {
  return {
    enabled: false,
    highpassHz: 80,
    lowpassHz: 18000,
    gateThreshold: 0,
    transientReduction: 0
  };
}

function ensureStemCleanupSettings(stemName) {
  if (!stemCleanupState[stemName]) {
    stemCleanupState[stemName] = getDefaultCleanupSettings();
    return stemCleanupState[stemName];
  }

  stemCleanupState[stemName] = {
    ...getDefaultCleanupSettings(),
    ...stemCleanupState[stemName]
  };
  return stemCleanupState[stemName];
}

function updateCleanupUiValues() {
  if (!cleanupHighpassInput || !cleanupLowpassInput || !cleanupGateInput || !cleanupTransientReductionInput) {
    return;
  }

  if (cleanupHighpassValueEl) {
    cleanupHighpassValueEl.textContent = `${Math.round(Number(cleanupHighpassInput.value))} Hz`;
  }
  if (cleanupLowpassValueEl) {
    cleanupLowpassValueEl.textContent = `${Math.round(Number(cleanupLowpassInput.value))} Hz`;
  }
  if (cleanupGateValueEl) {
    cleanupGateValueEl.textContent = Number(cleanupGateInput.value).toFixed(3);
  }
  if (cleanupTransientReductionValueEl) {
    cleanupTransientReductionValueEl.textContent = `${Math.round(Number(cleanupTransientReductionInput.value) * 100)}%`;
  }
  if (autoVocalCleanupStrengthInput && autoVocalCleanupStrengthValueEl) {
    autoVocalCleanupStrengthValueEl.textContent = `${Math.round(Number(autoVocalCleanupStrengthInput.value) * 100)}%`;
  }
}

function getAutoVocalCleanupPreset(strength = autoVocalCleanupStrength) {
  const s = Math.max(0, Math.min(1, Number(strength)));
  return {
    enabled: true,
    // Keep ranges conservative by default to avoid pitchy artifacts.
    highpassHz: Math.round(85 + 70 * s),
    lowpassHz: Math.round(12000 - 3500 * s),
    gateThreshold: Number((0.004 + 0.012 * s).toFixed(3)),
    transientReduction: Number((0.12 + 0.26 * s).toFixed(2))
  };
}

function applyAutoVocalCleanupPreset(options = {}) {
  const { quiet = false, strengthOverride = null } = options;
  if (!sourceStemBuffers) {
    return;
  }

  const stemNames = getOrderedSourceStemNames(sourceStemBuffers);
  const vocalsStem = stemNames.find((name) => name.toLowerCase() === "vocals");
  if (!vocalsStem) {
    if (!quiet) {
      setSourceStemStatus("auto vocal cleanup skipped: no vocals stem found");
    }
    return;
  }

  const resolvedStrength = strengthOverride == null
    ? autoVocalCleanupStrength
    : Math.max(0, Math.min(1, Number(strengthOverride)));

  stemCleanupState[vocalsStem] = getAutoVocalCleanupPreset(resolvedStrength);
  if (!selectedCleanupStem || !sourceStemBuffers[selectedCleanupStem]) {
    selectedCleanupStem = vocalsStem;
  }
  invalidateStemMixCache();
  refreshCleanupStemControls();

  if (recordedAudioIsPlaying && useStemMixPlaybackInput.checked && sourceStemBuffers) {
    startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds });
  }

  saveSettings();
  if (!quiet) {
    const effectiveStrength = strengthOverride == null ? autoVocalCleanupStrength : Math.max(0, Math.min(1, Number(strengthOverride)));
    setSourceStemStatus(`auto vocal cleanup applied (${Math.round(effectiveStrength * 100)}%)`);
  }
}

function refreshCleanupStemControls() {
  const hasStems = Boolean(sourceStemBuffers);
  const stemNames = hasStems ? getOrderedSourceStemNames(sourceStemBuffers) : [];
  const currentSelectValue = cleanupStemSelect?.value || "";

  if (cleanupStemSelect) {
    cleanupStemSelect.innerHTML = "";
    if (!stemNames.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No stems loaded";
      cleanupStemSelect.appendChild(option);
      selectedCleanupStem = "";
    } else {
      const preferredStem = stemNames.includes(currentSelectValue)
        ? currentSelectValue
        : selectedCleanupStem;
      selectedCleanupStem = stemNames.includes(preferredStem) ? preferredStem : stemNames[0];
      for (const name of stemNames) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        cleanupStemSelect.appendChild(option);
      }
      cleanupStemSelect.value = selectedCleanupStem;
    }
  }

  const controlsEnabled = stemNames.length > 0;
  const settings = controlsEnabled && selectedCleanupStem
    ? ensureStemCleanupSettings(selectedCleanupStem)
    : getDefaultCleanupSettings();

  if (cleanupEnabledInput) {
    cleanupEnabledInput.checked = Boolean(settings.enabled);
    cleanupEnabledInput.disabled = !controlsEnabled;
  }
  if (cleanupHighpassInput) {
    cleanupHighpassInput.value = String(settings.highpassHz);
    cleanupHighpassInput.disabled = !controlsEnabled;
  }
  if (cleanupLowpassInput) {
    cleanupLowpassInput.value = String(settings.lowpassHz);
    cleanupLowpassInput.disabled = !controlsEnabled;
  }
  if (cleanupGateInput) {
    cleanupGateInput.value = String(settings.gateThreshold);
    cleanupGateInput.disabled = !controlsEnabled;
  }
  if (cleanupTransientReductionInput) {
    cleanupTransientReductionInput.value = String(settings.transientReduction);
    cleanupTransientReductionInput.disabled = !controlsEnabled;
  }

  if (applyVocalCleanupPresetBtn) {
    applyVocalCleanupPresetBtn.disabled = !controlsEnabled;
  }
  if (applyAutoVocalCleanupBtn) {
    applyAutoVocalCleanupBtn.disabled = !controlsEnabled;
  }
  if (applyAutoVocalCleanupStrongBtn) {
    applyAutoVocalCleanupStrongBtn.disabled = !controlsEnabled;
  }
  if (resetCleanupForStemBtn) {
    resetCleanupForStemBtn.disabled = !controlsEnabled;
  }

  if (autoVocalCleanupEnabledInput) {
    autoVocalCleanupEnabledInput.checked = Boolean(autoVocalCleanupEnabled);
  }
  if (autoVocalCleanupStrengthInput) {
    autoVocalCleanupStrengthInput.value = String(autoVocalCleanupStrength);
  }

  updateCleanupUiValues();
}

function updateCurrentStemCleanupSetting(changes) {
  if (!selectedCleanupStem || !sourceStemBuffers || !sourceStemBuffers[selectedCleanupStem]) {
    return;
  }

  const next = {
    ...ensureStemCleanupSettings(selectedCleanupStem),
    ...changes
  };

  next.highpassHz = Math.max(20, Math.min(2000, Number(next.highpassHz)));
  next.lowpassHz = Math.max(1000, Math.min(20000, Number(next.lowpassHz)));
  if (next.highpassHz >= next.lowpassHz) {
    next.lowpassHz = Math.min(20000, next.highpassHz + 100);
  }
  next.gateThreshold = Math.max(0, Math.min(0.08, Number(next.gateThreshold)));
  next.transientReduction = Math.max(0, Math.min(1, Number(next.transientReduction)));

  stemCleanupState[selectedCleanupStem] = next;

  invalidateStemMixCache();
  refreshCleanupStemControls();

  if (recordedAudioIsPlaying && useStemMixPlaybackInput.checked && sourceStemBuffers) {
    startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds });
  }

  saveSettings();
}

function applyVocalCleanupPreset() {
  updateCurrentStemCleanupSetting({
    enabled: true,
    highpassHz: 120,
    lowpassHz: 9500,
    gateThreshold: 0.012,
    transientReduction: 0.42
  });
  if (selectedCleanupStem) {
    setSourceStemStatus(`cleanup preset applied to ${selectedCleanupStem}`);
  }
}

function resetCleanupForCurrentStem() {
  if (!selectedCleanupStem) {
    return;
  }

  stemCleanupState[selectedCleanupStem] = getDefaultCleanupSettings();
  invalidateStemMixCache();
  refreshCleanupStemControls();

  if (recordedAudioIsPlaying && useStemMixPlaybackInput.checked && sourceStemBuffers) {
    startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds });
  }

  saveSettings();
  setSourceStemStatus(`cleanup reset for ${selectedCleanupStem}`);
}

function ensureNoPlaybackActive() {
  if (recordedAudioIsPlaying || recordedAudioIsPaused || filePlaybackSource) {
    stopLoadedAudio({ silent: true });
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function stopCapture({ manual = true } = {}) {
  if (manual) {
    wantsCapture = false;
  }

  clearReconnectTimer();
  stopSpeedEnforcer();
  stopRecording();
  clearMuteSafetyTimer();

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  tearDownAudioGraph();
  unmuteOriginalTabMedia();
  userPausedBrowserAudio = false;
  browserAudioPausedForIsolation = false;
  refreshPauseBrowserAudioButton();
  capturedTabId = null;
  extensionMutedTabId = null;
  extensionMutedTabPreviousState = null;

  if (!wantsCapture) {
    reconnectAttempts = 0;
    setButtons(false);
    setStatus("Idle");
  }

  updateRecordingButtons();
  updateLoadedAudioButtons();
}

function scheduleReconnect() {
  if (!wantsCapture) {
    return;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    wantsCapture = false;
    setButtons(false);
    setStatus("Capture ended and reconnect attempts were exhausted");
    return;
  }

  reconnectAttempts += 1;
  setStatus(`Capture ended. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  clearReconnectTimer();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startCapture({ isReconnect: true });
  }, RECONNECT_DELAY_MS);
}

function isUncapturableTabUrl(url) {
  if (!url || typeof url !== "string") {
    return true;
  }

  return /^(chrome|chrome-extension|chrome-devtools|devtools|about|edge|view-source):/i.test(url);
}

function isNonRetriableCaptureError(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("extension has not been invoked for the current page") ||
    text.includes("cannot be captured") ||
    text.includes("permission denied") ||
    text.includes("not allowed");
}

function startCapture({ isReconnect = false } = {}) {
  console.log("[Popup] startCapture called with isReconnect:", isReconnect);
  
  if (stream) {
    console.log("[Popup] Stream already exists, skipping");
    setStatus("Already capturing tab audio");
    return;
  }

  if (!isReconnect) {
    wantsCapture = true;
    reconnectAttempts = 0;
    console.log("[Popup] Set wantsCapture to true");
  }

  console.log("[Popup] Calling setButtons(true)");
  setButtons(true);
  setStatus(isReconnect ? "Retrying tab audio capture..." : "Requesting tab audio capture...");

  console.log("[Popup] Calling chrome.tabCapture.capture()");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0] ?? null;
    capturedTabId = activeTab?.id ?? null;
    const activeUrl = String(activeTab?.url || "");

    if (isUncapturableTabUrl(activeUrl)) {
      wantsCapture = false;
      clearReconnectTimer();
      setButtons(false);
      setStatus("Capture blocked on browser/system pages. Open a media tab and retry.");
      return;
    }

    chrome.tabCapture.capture({ audio: true, video: false }, async (capturedStream) => {
    console.log("[Popup] Capture callback fired, stream:", capturedStream ? "exists" : "null", "error:", chrome.runtime.lastError);

    if (chrome.runtime.lastError) {
      const errorMsg = `Capture failed: ${chrome.runtime.lastError.message}`;
      console.error("[Popup]", errorMsg);
      setStatus(errorMsg);
      setButtons(false);

      if (isNonRetriableCaptureError(chrome.runtime.lastError.message)) {
        wantsCapture = false;
        clearReconnectTimer();
        setStatus("Capture permission blocked. Open a media tab, click the extension there, then retry.");
        return;
      }

      scheduleReconnect();
      return;
    }

    if (!capturedStream) {
      console.error("[Popup] Capture failed: no stream returned");
      setStatus("Capture failed: no stream returned");
      setButtons(false);
      scheduleReconnect();
      return;
    }
    reconnectAttempts = 0;
    stream = capturedStream;
    
    try {
      await buildAudioGraph(stream);
      console.log("[Popup] Audio graph built successfully");
          requirePlaying = true,
          settleMs = 220
    } catch (error) {
      console.error("[Popup] Error building audio graph:", error);
      setStatus(`Error building audio graph: ${error.message}`);
      setButtons(false);
      scheduleReconnect();
      return;
    }
    
    try {
      console.log("[Popup] Calling applySpeedToActiveTab()");
      applySpeedToActiveTab();
      console.log("[Popup] applySpeedToActiveTab() complete");
      
      console.log("[Popup] Calling startSpeedEnforcer()");
      startSpeedEnforcer();
      console.log("[Popup] startSpeedEnforcer() complete");
    } catch (error) {
      console.error("[Popup] Error during initialization:", error);
      setStatus(`Error during init: ${error.message}`);
      setButtons(false);
      scheduleReconnect();
      return;
    }
    
    console.log("[Popup] All initialization complete, setting buttons and status");
    if (voiceIsolationEnabled) {
      applySafeOriginalMute();
    } else {
      unmuteOriginalTabMedia();
    }
    setButtons(true);
    setStatus("Capturing and processing tab audio");
    updateRecordingButtons();

    console.log("[Popup] Adding ended listener to audio track");
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      console.log("[Popup] Audio track ended");
      // If live isolation is active, delay teardown so any AI audio that was
      // already scheduled past the track-end boundary can finish playing.
      // The remaining scheduled duration is liveCompanionNextPlaybackTime -
      // audioContext.currentTime, capped at 30s to avoid hanging indefinitely.
      if (liveCompanionIsolationActive && audioContext) {
        const remainingMs = Math.max(
          0,
          Math.min(30000, (liveCompanionNextPlaybackTime - audioContext.currentTime) * 1000)
        );
        console.log(`[Popup] Live isolation active — delaying teardown by ${Math.round(remainingMs)}ms`);
        setTimeout(() => {
          stopCapture({ manual: false });
          scheduleReconnect();
        }, remainingMs + 800); // +800ms margin for flush chunk processing
      } else {
        stopCapture({ manual: false });
        scheduleReconnect();
      }
    });
    
    console.log("[Popup] startCapture completed successfully");
  });
  
  console.log("[Popup] startCapture function returning");
  });
}

function startRecording() {
  if (!stream || !recordingDestination) {
    setRecordingStatus("start capture first");
    return;
  }

  if (mediaRecorder?.state === "recording") {
    return;
  }

  // Stop any active playback to prevent audio collision
  ensureNoPlaybackActive();

  const mimeType = getPreferredRecordingMimeType();
  const recorderOptions = mimeType ? { mimeType } : undefined;

  try {
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(recordingDestination.stream, recorderOptions);
  } catch (error) {
    setRecordingStatus("failed to start recorder");
    console.error("[Audio Mixer] MediaRecorder init failed", error);
    updateRecordingButtons();
    return;
  }

  recordingStartedAt = Date.now();

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordingChunks.push(event.data);
    }
  };

  mediaRecorder.onerror = (event) => {
    setRecordingStatus("error while recording");
    console.error("[Audio Mixer] Recorder error", event.error);
    updateRecordingButtons();
  };

  mediaRecorder.onstop = () => {
    const durationMs = recordingStartedAt ? Date.now() - recordingStartedAt : 0;
    recordingStartedAt = null;

    if (!recordingChunks.length) {
      setRecordingStatus("no audio captured");
      updateRecordingButtons();
      return;
    }

    const outputType = mediaRecorder?.mimeType || mimeType || "audio/webm";
    lastRecordingBlob = new Blob(recordingChunks, { type: outputType });
    lastRecordingAudioBuffer = null;

    if (lastRecordingObjectUrl) {
      URL.revokeObjectURL(lastRecordingObjectUrl);
    }
    lastRecordingObjectUrl = URL.createObjectURL(lastRecordingBlob);
    void saveLastRecordingBlob();

    setRecordingStatus(`saved ${formatDurationMs(durationMs)} clip`);
    updateRecordingButtons();
  };

  mediaRecorder.start(1000);
  setRecordingStatus("recording...");
  updateRecordingButtons();
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return;
  }

  mediaRecorder.stop();
}

function sanitizeFileSegment(value) {
  return String(value || "audio-mixer-recording")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "") || "audio-mixer-recording";
}

async function triggerOffscreenBlobDownload(blob, filename) {
  const ready = await ensureOffscreenExists();
  if (!ready) {
    await saveDownloadTrace("offscreen-unavailable", { filename });
    return false;
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const CHUNK_BYTES = 16 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));

    const beginResp = await sendToOffscreen({
      type: "DOWNLOAD_BEGIN",
      filename,
      totalChunks
    });
    if (!beginResp?.success) {
      await saveDownloadTrace("offscreen-begin-failed", { filename, totalChunks });
      return false;
    }

    for (let i = 0; i < totalChunks; i += 1) {
      const slice = bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      const chunkResp = await sendToOffscreen({
        type: "DOWNLOAD_CHUNK",
        index: i,
        buffer: slice.buffer
      });
      if (!chunkResp?.success) {
        await saveDownloadTrace("offscreen-chunk-failed", { filename, index: i, totalChunks });
        return false;
      }
    }

    const finalResp = await sendToOffscreen({ type: "DOWNLOAD_FINALIZE" });
    if (finalResp?.success) {
      await saveDownloadTrace("success-offscreen", { filename, totalChunks });
      console.log("[Download] success via offscreen fallback", { filename, totalChunks });
      return true;
    }

    await saveDownloadTrace("offscreen-finalize-failed", { filename, totalChunks });
  } catch (err) {
    await saveDownloadTrace("offscreen-error", { filename, error: String(err?.message || err) });
    console.warn("[Download] offscreen fallback error:", err);
  }

  return false;
}

async function triggerExtensionContextDownload(blob, filename) {
  let objectUrl = "";
  try {
    objectUrl = URL.createObjectURL(blob);
    const resp = await new Promise((resolve) => {
      chrome.downloads.download(
        { url: objectUrl, filename, saveAs: false },
        (downloadId) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ success: false, error: err.message || String(err) });
            return;
          }
          resolve({ success: true, downloadId: downloadId ?? null });
        }
      );
    });

    if (resp?.success) {
      await saveDownloadTrace("success-extension-context", { filename, downloadId: resp.downloadId ?? null });
      console.log("[Download] success via extension-context fallback", { filename, downloadId: resp.downloadId ?? null });
      return true;
    }

    await saveDownloadTrace("extension-context-failed", { filename, error: String(resp?.error || "unknown") });
  } catch (err) {
    await saveDownloadTrace("extension-context-error", { filename, error: String(err?.message || err) });
    console.warn("[Download] extension-context fallback error:", err);
  } finally {
    if (objectUrl) {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    }
  }

  return false;
}

async function persistSessionStateBeforeDownload() {
  // Popup may be closed by browser download behavior. Persist state first.
  const results = await Promise.allSettled([
    saveLastRecordingBlob(),
    persistSessionCacheToIndexedDbNow()
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("[Popup] Pre-download state persistence failed:", result.reason);
    }
  }
}

async function triggerBlobDownload(blob, extension, baseName = "audio-mixer-recording") {
  await persistSessionStateBeforeDownload();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${sanitizeFileSegment(baseName)}-${stamp}.${extension}`;
  await saveDownloadTrace("begin", { filename, bytes: blob.size, strategy: DOWNLOAD_STRATEGY_VERSION });
  console.log("[Download] begin", {
    strategy: DOWNLOAD_STRATEGY_VERSION,
    filename,
    bytes: blob.size
  });

  // ── Strategy 1a: content-script data URL (files ≤20 MB) ──────────────────
  // The content script triggers <a download> in the *page* renderer context.
  // Page-initiated downloads bypass Chrome's extension focus lifecycle, so the
  // popup is never closed. This is the only reliably safe download path.
  const SMALL_LIMIT = 20 * 1024 * 1024;
  if (blob.size <= SMALL_LIMIT) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });
      const resp = await Promise.race([
        requestActiveTabMessage({ type: "DOWNLOAD_DATA_URL", payload: { url: dataUrl, filename } }),
        new Promise(resolve => setTimeout(() => resolve({ success: false, timeout: true }), 3000))
      ]);
      if (resp?.success) {
        await saveDownloadTrace("success-data-url", { filename });
        console.log("[Download] success via content-script data-URL", { filename });
        return true;
      }
      await saveDownloadTrace("data-url-failed", { filename });
      console.warn("[Download] content-script data-URL not successful, trying chunked path", resp);
    } catch (err) {
      await saveDownloadTrace("data-url-error", { filename, error: String(err?.message || err) });
      console.warn("[Download] content-script data-URL error, trying chunked path:", err);
    }
  }

  // ── Strategy 1b: content-script chunked ArrayBuffer (all sizes) ──────────
  // Large data URLs exceed Chrome IPC limits (base64 string → UTF-16 doubles
  // effective size, silently breaking the 64 MB structured-clone ceiling).
  // Send raw ArrayBuffer in 16 MB chunks; the content script assembles a Blob
  // and downloads via ObjectURL — still page-initiated, popup stays open.
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const CHUNK_BYTES = 16 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    const beginResp = await requestActiveTabMessage({
      type: "DOWNLOAD_BUFFER_BEGIN",
      payload: { filename, mimeType: blob.type || "audio/wav", totalChunks }
    });
    if (beginResp?.success) {
      for (let i = 0; i < totalChunks; i++) {
        const slice = bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        await requestActiveTabMessage({
          type: "DOWNLOAD_BUFFER_CHUNK",
          payload: { index: i, buffer: slice.buffer }
        });
      }
      const finalResp = await requestActiveTabMessage({ type: "DOWNLOAD_BUFFER_FINALIZE", payload: {} });
      if (finalResp?.success) {
        await saveDownloadTrace("success-chunked", { filename, totalChunks });
        console.log("[Download] success via content-script chunked-buffer", { filename });
        return true;
      }
      await saveDownloadTrace("chunked-finalize-failed", { filename, totalChunks });
      console.warn("[Download] content-script chunked-buffer finalize issue", finalResp);
    } else {
      await saveDownloadTrace("chunked-begin-failed", { filename, totalChunks });
      console.warn("[Download] content-script chunked-buffer begin failed", beginResp);
    }
  } catch (err) {
    await saveDownloadTrace("chunked-error", { filename, error: String(err?.message || err) });
    console.warn("[Download] content-script chunked-buffer error:", err);
  }

  if (await triggerOffscreenBlobDownload(blob, filename)) {
    return true;
  }

  if (await triggerExtensionContextDownload(blob, filename)) {
    return true;
  }

  // On normal web pages (e.g. YouTube), forcing extension-context download
  // fallbacks can close the popup. Fail safe here to preserve extension state.
  if (await activeTabIsWebPage()) {
    await saveDownloadTrace("aborted-to-avoid-popup-close", { filename });
    setStatus("Download failed: page bridge unavailable (popup-safe fallback only)");
    return false;
  }

  // For non-web pages (e.g. chrome://), don't risk extension-context downloads
  // that can dismiss popup UI and reset session state.
  await saveDownloadTrace("aborted-non-web-tab", { filename });
  setStatus("Download failed: active tab does not allow popup-safe download");
  return false;
}

async function decodeBlobToAudioBuffer(blob) {
  const decodeContext = new AudioContext();
  try {
    const raw = await blob.arrayBuffer();
    return await decodeContext.decodeAudioData(raw.slice(0));
  } finally {
    await decodeContext.close();
  }
}

async function decodeLiveCompanionChunk(blob) {
  try {
    return await decodeBlobToAudioBuffer(blob);
  } catch (primaryError) {
    // Some timesliced MediaRecorder chunks do not include full init metadata.
    // Retry by prepending the first chunk as a bootstrap segment.
    if (liveCompanionInitChunkBlob && liveCompanionInitChunkBlob !== blob) {
      try {
        const stitched = new Blob([liveCompanionInitChunkBlob, blob], {
          type: blob.type || liveCompanionInitChunkBlob.type || "audio/webm"
        });
        return await decodeBlobToAudioBuffer(stitched);
      } catch (_stitchedError) {
        // Fall through to the original error for accurate diagnostics.
      }
    }
    throw primaryError;
  }
}

function base64ToUint8Array(base64Text) {
  const raw = atob(base64Text);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}

async function decodeCompanionStemPayload(stemPayload) {
  if (!stemPayload) {
    throw new Error("Invalid companion stem payload");
  }

  if (typeof stemPayload === "string") {
    if (stemPayload.startsWith("data:audio/")) {
      const response = await fetch(stemPayload);
      return decodeBlobToAudioBuffer(await response.blob());
    }
    const mimeType = "audio/wav";
    return decodeBlobToAudioBuffer(new Blob([base64ToUint8Array(stemPayload)], { type: mimeType }));
  }

  if (typeof stemPayload === "object") {
    const base64 = stemPayload.dataBase64 || stemPayload.base64 || stemPayload.data;
    if (!base64 || typeof base64 !== "string") {
      throw new Error("Companion stem payload missing base64 data");
    }
    const mimeType = stemPayload.mimeType || "audio/wav";
    return decodeBlobToAudioBuffer(new Blob([base64ToUint8Array(base64)], { type: mimeType }));
  }

  throw new Error("Unsupported companion stem payload type");
}

async function requestCompanionStems(sourceBuffer, requestedStems = ["vocals", "drums", "bass", "other"], { signal } = {}) {
  const available = companionEngineAvailable || await checkCompanionEngine({ silent: true });
  if (!available) {
    throw new Error("Pro engine not available. Install and start the companion app.");
  }

  const normalizedRequested = Array.from(new Set(
    (Array.isArray(requestedStems) ? requestedStems : [])
      .map((stem) => String(stem || "").trim().toLowerCase())
      .filter(Boolean)
  ));
  if (!normalizedRequested.length) {
    throw new Error("No stems requested for companion split");
  }

  const wavBlob = audioBufferToWavBlob(sourceBuffer);
  let response;
  try {
    response = await fetchWithTimeout(`${COMPANION_API_BASE_URL}/v1/stems/split`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Requested-Stems": normalizedRequested.join(",")
      },
      body: wavBlob
    }, COMPANION_SPLIT_TIMEOUT_MS, signal || null);
  } catch (error) {
    if (error?.name === "AbortError") {
      // Re-throw without rewrapping so the caller can distinguish user-cancel from timeout.
      throw error;
    }
    throw error;
  }

  if (!response.ok) {
    let details = "";
    try {
      const errorPayload = await response.json();
      details = String(errorPayload?.detail || "").trim();
    } catch (_error) {
      details = "";
    }
    const suffix = details ? `: ${details}` : "";
    throw new Error(`Pro engine split failed (${response.status})${suffix}`);
  }

  const payload = await response.json();
  const stems = payload?.stems;
  if (!stems || typeof stems !== "object") {
    throw new Error("Pro engine returned no stems");
  }

  const parsedStems = {};
  const stemNames = Object.keys(stems);
  for (const stemName of stemNames) {
    const decoded = await decodeCompanionStemPayload(stems[stemName]);
    parsedStems[stemName] = decoded.sampleRate === sourceBuffer.sampleRate
      ? decoded
      : await resampleAudioBuffer(decoded, sourceBuffer.sampleRate);
  }

  // Pass through device_used so callers can detect CPU fallback.
  if (payload.device_used) {
    parsedStems._deviceUsed = payload.device_used;
  }

  return parsedStems;
}

async function requestCompanionIsolationStem(sourceBuffer, mode = "vocals") {
  const available = companionEngineAvailable || await checkCompanionEngine({ silent: true });
  if (!available) {
    throw new Error("Pro engine not available. Install and start the companion app.");
  }

  const requestedStem = mode === "instrumental" ? "instrumental" : "vocals";
  const wavBlob = audioBufferToWavBlob(sourceBuffer);

  let response;
  try {
    // Live CPU separation can exceed 15s depending on load/model.
    // Use a realistic timeout to avoid false aborts that leak raw source audio.
    const liveTimeout = liveCompanionIsolationActive
      ? Math.max(45000, LIVE_COMPANION_CHUNK_MS * 3)
      : LIVE_COMPANION_REQUEST_TIMEOUT_MS;
    
    response = await fetchWithTimeout(`${COMPANION_API_BASE_URL}/v1/stems/split`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Requested-Stems": requestedStem
      },
      body: wavBlob
    }, liveTimeout);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Companion live isolation request timed out");
    }
    throw error;
  }

  if (!response.ok) {
    let details = "";
    try {
      const payload = await response.json();
      details = String(payload?.detail || "").trim();
    } catch (_error) {
      details = "";
    }
    const suffix = details ? `: ${details}` : "";
    throw new Error(`Companion live isolation failed (${response.status})${suffix}`);
  }

  const payload = await response.json();
  const stems = payload?.stems;
  if (!stems || typeof stems !== "object") {
    throw new Error("Companion live isolation returned no stems");
  }

  const stemPayload = stems[requestedStem];
  if (!stemPayload) {
    throw new Error(`Companion live isolation missing stem: ${requestedStem}`);
  }

  const decoded = await decodeCompanionStemPayload(stemPayload);
  return decoded.sampleRate === sourceBuffer.sampleRate
    ? decoded
    : await resampleAudioBuffer(decoded, sourceBuffer.sampleRate);
}

function clearLiveCompanionPcmState() {
  liveCompanionPcmBlocks = [];
  liveCompanionQueuedSamples = 0;
  liveCompanionTrailingSilenceSamples = 0;
}

function enqueueLiveCompanionPcmBlock(inputBuffer) {
  const channels = [];
  const srcChannels = Math.max(1, Math.min(inputBuffer.numberOfChannels || 1, liveCompanionCaptureChannelCount));

  for (let ch = 0; ch < liveCompanionCaptureChannelCount; ch += 1) {
    const srcCh = Math.min(ch, srcChannels - 1);
    channels.push(new Float32Array(inputBuffer.getChannelData(srcCh)));
  }

  const length = inputBuffer.length;
  if (length <= 0) {
    return;
  }

  // Quick RMS check — sample at most 64 evenly-spaced points on ch0 to stay cheap.
  // Used to detect when the source audio has gone silent (song ended) so we can
  // flush whatever partial chunk remains in the buffer instead of losing it.
  const ch0 = channels[0];
  const step = Math.max(1, Math.floor(ch0.length / 64));
  let sumSq = 0;
  for (let i = 0; i < ch0.length; i += step) sumSq += ch0[i] * ch0[i];
  if (Math.sqrt(sumSq / Math.ceil(ch0.length / step)) > 1e-6) {
    liveCompanionLastRealAudioTime = Date.now();
    liveCompanionTrailingSilenceSamples = 0; // reset on real audio
  } else {
    liveCompanionTrailingSilenceSamples += length;
  }

  liveCompanionPcmBlocks.push({ channels, length, offset: 0 });
  liveCompanionQueuedSamples += length;
}

function pullLiveCompanionPcmChunk(targetSamples, sampleRate, { forceFlush = false } = {}) {
  if (!audioContext || liveCompanionQueuedSamples === 0) return null;
  if (!forceFlush && liveCompanionQueuedSamples < targetSamples) return null;

  // For flush: only drain real audio content. liveCompanionTrailingSilenceSamples tracks
  // how many silence samples accumulated AFTER the last real audio block (i.e. while
  // waiting for Demucs to finish the last chunk). Excluding those ensures the flush
  // buffer is only real music content, not a 9-second block of silence that would be
  // scheduled on the playback timeline and cause an apparent early cutoff.
  const flushable = forceFlush
    ? Math.max(0, liveCompanionQueuedSamples - liveCompanionTrailingSilenceSamples)
    : liveCompanionQueuedSamples;
  const actualSamples = forceFlush
    ? Math.min(targetSamples, flushable)
    : targetSamples;

  if (actualSamples === 0) return null;

  const bufferFrames = forceFlush ? actualSamples : targetSamples;
  const out = audioContext.createBuffer(liveCompanionCaptureChannelCount, bufferFrames, sampleRate);
  let written = 0;

  while (written < actualSamples && liveCompanionPcmBlocks.length > 0) {
    const block = liveCompanionPcmBlocks[0];
    const available = block.length - block.offset;
    const take = Math.min(available, actualSamples - written);

    for (let ch = 0; ch < liveCompanionCaptureChannelCount; ch += 1) {
      const dst = out.getChannelData(ch);
      dst.set(block.channels[ch].subarray(block.offset, block.offset + take), written);
    }

    block.offset += take;
    written += take;
    liveCompanionQueuedSamples -= take;

    if (block.offset >= block.length) {
      liveCompanionPcmBlocks.shift();
    }
  }

  return out;
}

function stopLiveCompanionIsolation() {
  liveCompanionIsolationActive = false;
  liveCompanionBusy = false;
  setLiveCompanionPlaybackPaused(false);
  liveCompanionProcessingQueue = false;
  liveCompanionSessionId += 1;
  liveCompanionNextPlaybackTime = 0;
  liveCompanionChunksProcessed = 0;
  liveCompanionChunkQueue = []; // Clear any remaining queued chunks
  liveCompanionInitChunkBlob = null;
  liveCompanionConsecutiveDecodeFailures = 0;
  liveCompanionConsecutiveProcessFailures = 0;
  liveCompanionDisconnectedDuringWarmup = false;
  liveCompanionWarmupStartedAt = 0;
  liveCompanionTimelineRewindApplied = false;
  liveCompanionCaptureStartMediaTime = -1;
  liveCompanionPendingPlaybackBuffers = [];
  liveCompanionLastRealAudioTime = 0;
  liveCompanionTrailingSilenceSamples = 0;
  browserAudioPausedForIsolation = false;

  // Clear gap detection timer
  if (liveCompanionGapDetectionTimer) {
    clearTimeout(liveCompanionGapDetectionTimer);
    liveCompanionGapDetectionTimer = null;
  }

  if (liveCompanionFirstChunkTimeoutTimer) {
    clearTimeout(liveCompanionFirstChunkTimeoutTimer);
    liveCompanionFirstChunkTimeoutTimer = null;
  }

  if (liveCompanionCaptureTimer) {
    clearInterval(liveCompanionCaptureTimer);
    liveCompanionCaptureTimer = null;
  }

  if (liveCompanionCaptureNode) {
    try {
      liveCompanionCaptureNode.disconnect();
    } catch (_error) {
      // ignore
    }
    liveCompanionCaptureNode.onaudioprocess = null;
    liveCompanionCaptureNode = null;
  }

  if (liveCompanionCaptureSinkNode) {
    try {
      liveCompanionCaptureSinkNode.disconnect();
    } catch (_error) {
      // ignore
    }
    liveCompanionCaptureSinkNode = null;
  }

  clearLiveCompanionPcmState();

  // If companion had taken over routing, restore the original audio path.
  if (liveCompanionTookoverRouting || liveCompanionDisconnectedDuringWarmup) {
    liveCompanionTookoverRouting = false;
    liveCompanionDisconnectedDuringWarmup = false;
    try {
      if (inputSourceNode && inputMixNode) {
        inputSourceNode.connect(inputMixNode);
      }
    } catch (_error) {
      // ignore
    }
    resumeOriginalTabMediaForIsolation();
  }

  if (!preparedInstrumentalPreparing && !preparedInstrumentalActive) {
    clearInstrumentalPreparationUi();
  }

  liveCompanionRecorder = null;

  for (const source of liveCompanionQueuedSources) {
    try {
      source.stop();
      source.disconnect();
    } catch (_error) {
      // ignore
    }
  }
  liveCompanionQueuedSources.clear();
}

function scheduleLiveCompanionBufferPlayback(buffer, sessionId) {
  if (!audioContext || !inputMixNode || !liveCompanionIsolationActive || sessionId !== liveCompanionSessionId) {
    return;
  }

  liveCompanionLastChunkTime = Date.now();
  liveCompanionChunksProcessed += 1;
  liveCompanionPendingPlaybackBuffers.push(buffer);

  // First successful chunk: take over from original audio.
  if (!liveCompanionTookoverRouting) {
    if (liveCompanionPendingPlaybackBuffers.length < LIVE_COMPANION_STARTUP_PREFETCH_CHUNKS) {
      setVoiceIsolationStatus(`⏳ Prefetching AI audio (${liveCompanionPendingPlaybackBuffers.length}/${LIVE_COMPANION_STARTUP_PREFETCH_CHUNKS})`);
      return;
    }

    if (liveCompanionFirstChunkTimeoutTimer) {
      clearTimeout(liveCompanionFirstChunkTimeoutTimer);
      liveCompanionFirstChunkTimeoutTimer = null;
    }

    liveCompanionTookoverRouting = true;
    try {
      if (inputSourceNode && inputMixNode) {
        inputSourceNode.disconnect(inputMixNode);
      }
    } catch (_error) {
      // May already be disconnected (e.g. DSP worklet path was active before companion)
    }
    browserAudioPausedForIsolation = false;

    // Re-align once to the captured start point with small latency compensation.
    if (!liveCompanionTimelineRewindApplied && Number.isFinite(liveCompanionCaptureStartMediaTime) && liveCompanionCaptureStartMediaTime >= 0) {
      liveCompanionTimelineRewindApplied = true;
      const alignmentTime = Math.max(0, liveCompanionCaptureStartMediaTime - LIVE_COMPANION_ALIGNMENT_OFFSET_SECONDS);
      seekActiveTabMediaToTime(alignmentTime);
      console.log(`[Voice Isolation] Re-aligned media to ${alignmentTime.toFixed(2)}s (captured ${liveCompanionCaptureStartMediaTime.toFixed(2)}s)`);
    }

    console.log("[Voice Isolation] Companion first stable chunk ready — original audio replaced.");
    const warmupElapsedSec = liveCompanionWarmupStartedAt > 0
      ? Math.max(0, Math.round((Date.now() - liveCompanionWarmupStartedAt) / 1000))
      : 0;
    setInstrumentalPreparationUi({
      visible: true,
      phase: "live-active",
      headline: `Live AI ${getVoiceIsolationModeLabel()} active`,
      detail: "AI audio has taken over from dry playback.",
      progress: 100,
      progressText: warmupElapsedSec > 0
        ? `Warmup complete in ${warmupElapsedSec}s`
        : "Warmup complete"
    });
  }

  const buffersToSchedule = liveCompanionPendingPlaybackBuffers.splice(0, liveCompanionPendingPlaybackBuffers.length);
  for (const pendingBuffer of buffersToSchedule) {
    const source = audioContext.createBufferSource();
    source.buffer = pendingBuffer;
    source.connect(inputMixNode);

    const now = audioContext.currentTime;
    let startAt;

    if (liveCompanionNextPlaybackTime <= 0 || liveCompanionQueuedSources.size === 0) {
      // Use ALIGNMENT_OFFSET as the scheduling lead so it matches the seek-back amount.
      // This eliminates the perceptible silence gap at start and at end-of-song flush.
      startAt = now + LIVE_COMPANION_ALIGNMENT_OFFSET_SECONDS;
    } else {
      // Slight 10ms overlap avoids tiny cracks between chunks.
      startAt = Math.max(now + 0.02, liveCompanionNextPlaybackTime - 0.01);
    }

    source.start(startAt);
    liveCompanionNextPlaybackTime = startAt + pendingBuffer.duration;

    liveCompanionQueuedSources.add(source);
    source.onended = () => {
      liveCompanionQueuedSources.delete(source);
      try {
        source.disconnect();
      } catch (_error) {
        // ignore
      }
      // Safety net: once all scheduled AI audio has finished playing, if nothing
      // new arrives within 600ms, restore the original audio path completely —
      // reconnect inputSourceNode AND unmute the tab so the song's final seconds
      // play through. Without unmuteOriginalTabMedia() the tab stays Chrome-muted
      // and users hear silence even though the graph is reconnected.
      if (liveCompanionIsolationActive && sessionId === liveCompanionSessionId) {
        const snapSession = sessionId;
        // Capture the media position the AI audio was aligned to, so we can seek
        // YT back to the right spot when handing back to original audio.
        const snapMediaStartTime = liveCompanionCaptureStartMediaTime;
        const snapAiStartedAt = audioContext ? audioContext.currentTime - (liveCompanionNextPlaybackTime - (startAt + pendingBuffer.duration)) : 0;
        setTimeout(() => {
          if (!liveCompanionIsolationActive || snapSession !== liveCompanionSessionId) return;
          if (liveCompanionQueuedSources.size > 0) return; // more AI audio arrived
          // Reconnect original audio path. Live isolation only disconnects
          // inputSourceNode from inputMixNode — the tab is not Chrome-muted or
          // content-script-muted in this code path, so reconnecting is sufficient.
          try {
            if (inputSourceNode && inputMixNode) {
              inputSourceNode.connect(inputMixNode);
            }
          } catch (_) {}
          console.log("[Voice Isolation] All AI audio complete — restored original audio for song end");
        }, 600);
      }
    };
  }

  // Monitor for processing gaps (if next chunk doesn't arrive in time)
  const bufferDurationMs = buffer.duration * 1000;
  // Avoid false positives: processing each chunk can take ~10-15s on CPU.
  // Warn only if we miss more than one expected chunk interval.
  const gapThresholdMs = Math.max(12000, LIVE_COMPANION_CHUNK_MS * 1.25);
  
  if (liveCompanionGapDetectionTimer) {
    clearTimeout(liveCompanionGapDetectionTimer);
  }
  
  liveCompanionGapDetectionTimer = setTimeout(() => {
    const timeSinceLastChunk = Date.now() - liveCompanionLastChunkTime;
    if (liveCompanionIsolationActive && timeSinceLastChunk > gapThresholdMs) {
      console.warn(`[Voice Isolation] Potential processing gap detected (${Math.round(timeSinceLastChunk / 1000)}s without chunk)`);
      setVoiceIsolationStatus(`⚠️ Processing stalled — fallback audio may be active`);
    }
  }, gapThresholdMs);
}

// OPTIMIZATION: Process queued chunks sequentially to prevent audio cutoffs
async function processLiveCompanionQueue(sessionId) {
  if (liveCompanionProcessingQueue || !liveCompanionIsolationActive || sessionId !== liveCompanionSessionId) {
    return;
  }

  liveCompanionProcessingQueue = true;
  const warmupLabel = getVoiceIsolationModeLabel();

  try {
    while (liveCompanionChunkQueue.length > 0 && liveCompanionIsolationActive && sessionId === liveCompanionSessionId) {
      const { audioBuffer, enqueued } = liveCompanionChunkQueue.shift();
      
      // Track queue wait time for debugging
      const waitTimeMs = Date.now() - enqueued;
      if (waitTimeMs > 2000) {
        console.warn(`[Voice Isolation] Chunk waited ${Math.round(waitTimeMs / 1000)}s in queue`);
      }

      try {
        const chunkForGraph = audioBuffer.sampleRate === audioContext.sampleRate
          ? audioBuffer
          : await resampleAudioBuffer(audioBuffer, audioContext.sampleRate);

        const inputRms = getAudioBufferRms(chunkForGraph);
        if (inputRms < 1.0e-6) {
          console.warn("[Voice Isolation] Captured chunk is near-silent; keeping live mode active and waiting for source audio");
          setVoiceIsolationStatus("⚠️ Source chunk near-silent - ensure browser media is playing");
          continue;
        }

        // Send each queued chunk through the companion so playback uses AI output.
        const isolated = await requestCompanionIsolationStem(chunkForGraph, voiceIsolationMode);

        const aiChunkNearSilent = getAudioBufferRms(isolated) < 1.0e-6;
        if (aiChunkNearSilent) {
          console.warn("[Voice Isolation] AI chunk near-silent; using dry fallback for this chunk");
          scheduleLiveCompanionBufferPlayback(chunkForGraph, sessionId);
          setVoiceIsolationStatus("⚠️ AI chunk near-silent - temporary dry fallback");
        } else {
          scheduleLiveCompanionBufferPlayback(isolated, sessionId);
        }

        liveCompanionConsecutiveProcessFailures = 0;
        
        if (liveCompanionTookoverRouting) {
          const queueSizeIndicator = liveCompanionChunkQueue.length > 0 ? ` (queued: ${liveCompanionChunkQueue.length})` : "";
          setVoiceIsolationStatus(`✓ AI ${warmupLabel} live${queueSizeIndicator}`);
        }
      } catch (error) {
        liveCompanionConsecutiveProcessFailures += 1;
        if (liveCompanionConsecutiveProcessFailures >= LIVE_COMPANION_MAX_PROCESS_FAILURES_BEFORE_SHUTDOWN) {
          console.warn("[Voice Isolation] Repeated live processing failures - keeping AI mode active and retrying");
          setVoiceIsolationStatus("⚠️ Repeated processing failures - retrying live chunks");
          liveCompanionConsecutiveProcessFailures = 0;
        }

        console.error("[Voice Isolation] Failed to process queued chunk:", error);
        setVoiceIsolationStatus(`⚠️ Processing failed: ${error.message || error}`);
        
        // If this chunk fails after waiting in queue, try to recover by continuing with next
        // Don't break — keep processing remaining chunks
      }
    }
  } finally {
    liveCompanionProcessingQueue = false;
  }
}

async function startLiveCompanionIsolation() {
  if (!stream || !audioContext || !inputMixNode) {
    console.warn("[Voice Isolation] startLiveCompanionIsolation aborted — capture graph not ready", { hasStream: Boolean(stream), hasAudioContext: Boolean(audioContext), hasInputMixNode: Boolean(inputMixNode) });
    return false;
  }

  // Capture requested media position as early as possible to preserve click timing.
  const requestedStartMediaTime = await getActiveTabMediaCurrentTime();

  const available = companionEngineAvailable || await checkCompanionEngine({ silent: true });
  if (!available) {
    console.warn("[Voice Isolation] startLiveCompanionIsolation aborted — Pro engine not reachable from the popup. Check http://127.0.0.1:48231/v1/health and the companion service.");
    return false;
  }

  stopLiveCompanionIsolation();

  const sessionId = liveCompanionSessionId + 1;
  liveCompanionSessionId = sessionId;
  liveCompanionRecorder = null;
  liveCompanionIsolationActive = true;
  liveCompanionBusy = false;
  liveCompanionChunksProcessed = 0;
  liveCompanionNextPlaybackTime = 0;
  browserAudioPausedForIsolation = false;
  liveCompanionInitChunkBlob = null;
  liveCompanionConsecutiveDecodeFailures = 0;
  liveCompanionConsecutiveProcessFailures = 0;
  liveCompanionDisconnectedDuringWarmup = false;
  liveCompanionWarmupStartedAt = Date.now();
  liveCompanionTimelineRewindApplied = false;
  liveCompanionCaptureStartMediaTime = -1;
  clearLiveCompanionPcmState();

  // Capture the media's current playback position before we pause it,
  // so we can seek back to exactly this point when AI audio is ready.
  liveCompanionCaptureStartMediaTime = requestedStartMediaTime;
  if (!Number.isFinite(liveCompanionCaptureStartMediaTime) || liveCompanionCaptureStartMediaTime < 0) {
    liveCompanionCaptureStartMediaTime = await getActiveTabMediaCurrentTime();
  }
  console.log(`[Voice Isolation] Captured media start time: ${liveCompanionCaptureStartMediaTime}s`);

  // Keep dry audio audible during warmup; takeover happens only when AI chunks
  // are actually ready to play.
  liveCompanionDisconnectedDuringWarmup = false;
  browserAudioPausedForIsolation = false;
  console.log("[Voice Isolation] Warmup started with dry audio passthrough");

  // Capture raw PCM from tab stream directly to avoid MediaRecorder decode instability.
  try {
    liveCompanionCaptureChannelCount = Math.max(1, Math.min(2, inputSourceNode?.channelCount || 2));
    liveCompanionCaptureNode = audioContext.createScriptProcessor(4096, liveCompanionCaptureChannelCount, liveCompanionCaptureChannelCount);
    liveCompanionCaptureSinkNode = audioContext.createGain();
    liveCompanionCaptureSinkNode.gain.value = 0;

    liveCompanionCaptureNode.onaudioprocess = (event) => {
      if (!liveCompanionIsolationActive || sessionId !== liveCompanionSessionId) {
        return;
      }
      enqueueLiveCompanionPcmBlock(event.inputBuffer);
    };

    inputSourceNode.connect(liveCompanionCaptureNode);
    liveCompanionCaptureNode.connect(liveCompanionCaptureSinkNode);
    liveCompanionCaptureSinkNode.connect(audioContext.destination);
  } catch (error) {
    console.warn("[Voice Isolation] PCM capture init failed:", error);
    stopLiveCompanionIsolation();
    return false;
  }

  // Show initialization status with pause note
  const warmupLabel = getVoiceIsolationModeLabel();
  const ESTIMATED_PROCESSING_MS = 11000;
  const warmupTotalMs = LIVE_COMPANION_CHUNK_MS + ESTIMATED_PROCESSING_MS;
  const warmupStartTime = Date.now();

  if (liveCompanionFirstChunkTimeoutTimer) {
    clearTimeout(liveCompanionFirstChunkTimeoutTimer);
    liveCompanionFirstChunkTimeoutTimer = null;
  }

  // Hard fail-safe: if no playable AI chunk arrives in time, restore direct audio.
  const firstChunkTimeoutMs = Math.max(45000, warmupTotalMs + 15000);
  liveCompanionFirstChunkTimeoutTimer = setTimeout(() => {
    if (!liveCompanionIsolationActive || liveCompanionSessionId !== sessionId || liveCompanionTookoverRouting) {
      return;
    }

    console.warn("[Voice Isolation] First AI chunk delayed; switching to local DSP fallback");

    void (async () => {
      if (!liveCompanionIsolationActive || liveCompanionSessionId !== sessionId || liveCompanionTookoverRouting) {
        return;
      }

      stopLiveCompanionIsolation();
      const localOk = await activateLocalVoiceIsolation("companion warmup timeout");

      if (!localOk) {
        voiceIsolationEnabled = false;
        if (enableVoiceIsolationInput) {
          enableVoiceIsolationInput.checked = false;
        }
        setVoiceIsolationStatus("failed: companion timeout and local fallback unavailable");
      }

      saveSettings();
      updateVoiceIsolationControlButtons();
    })();
  }, firstChunkTimeoutMs);
  
  (function tickCountdown() {
    if (!liveCompanionIsolationActive || liveCompanionSessionId !== sessionId) return;
    if (liveCompanionTookoverRouting) return; // first chunk arrived — stop countdown
    
    const elapsed = Date.now() - warmupStartTime;
    const remaining = Math.max(0, warmupTotalMs - elapsed);
    const remainingSec = Math.ceil(remaining / 1000);
    
    if (elapsed < LIVE_COMPANION_CHUNK_MS) {
      setVoiceIsolationStatus(`⏳ Buffering... first ${warmupLabel} in ~${remainingSec}s`);
    } else {
      setVoiceIsolationStatus(`🔄 Processing... ~${remainingSec}s remaining`);
    }

    const progress = Math.min(95, (elapsed / Math.max(1, warmupTotalMs)) * 100);
    const elapsedSec = Math.floor(elapsed / 1000);
    setInstrumentalPreparationUi({
      visible: true,
      phase: "live-warmup",
      headline: `Live AI ${warmupLabel} warmup`,
      detail: "Capturing and processing the first live chunk. Dry audio stays on until AI playback is prefetched.",
      progress,
      progressText: `${elapsedSec}s elapsed · ~${remainingSec}s remaining`
    });

    if (remaining > 0) setTimeout(tickCountdown, 1000);
  })();

  const targetSamples = Math.max(2048, Math.round(audioContext.sampleRate * (LIVE_COMPANION_CHUNK_MS / 1000)));
  liveCompanionCaptureTimer = setInterval(() => {
    if (!liveCompanionIsolationActive || sessionId !== liveCompanionSessionId) {
      return;
    }

    // Normal full-chunk pull.
    let chunk = pullLiveCompanionPcmChunk(targetSamples, audioContext.sampleRate);

    // End-of-song flush: if the source has been silent for 800ms, there is
    // still audio buffered, AND the Demucs queue is fully drained — play the
    // remaining raw audio directly to close the song seamlessly.
    if (!chunk &&
        liveCompanionQueuedSamples > 0 &&
        liveCompanionLastRealAudioTime > 0 &&
        Date.now() - liveCompanionLastRealAudioTime > 800 &&
        liveCompanionChunkQueue.length === 0 &&
        !liveCompanionProcessingQueue) {
      const flushChunk = pullLiveCompanionPcmChunk(targetSamples, audioContext.sampleRate, { forceFlush: true });
      if (flushChunk) {
        console.log(`[Voice Isolation] End-of-song: flushing ${flushChunk.duration.toFixed(2)}s raw tail (silence=${Date.now() - liveCompanionLastRealAudioTime}ms, queued=${liveCompanionQueuedSamples})`);
        liveCompanionLastRealAudioTime = 0;
        scheduleLiveCompanionBufferPlayback(flushChunk, sessionId);
      }
      return;
    }

    if (!chunk) {
      if (liveCompanionLastRealAudioTime > 0 && Date.now() - liveCompanionLastRealAudioTime > 800) {
        // Log why flush didn't fire so we can diagnose in DevTools
        console.log(`[Voice Isolation] Flush blocked: queued=${liveCompanionQueuedSamples} chunkQueue=${liveCompanionChunkQueue.length} processing=${liveCompanionProcessingQueue}`);
      }
      return;
    }

    if (liveCompanionChunkQueue.length >= MAX_COMPANION_QUEUE_SIZE) {
      if (!liveCompanionTookoverRouting) {
        // During warmup keep oldest queued chunks so first AI output stays near click time.
        console.warn(`[Voice Isolation] Queue full (${MAX_COMPANION_QUEUE_SIZE}) during warmup — dropping newest incoming chunk`);
        return;
      }
      liveCompanionChunkQueue.shift();
      console.warn(`[Voice Isolation] Queue full (${MAX_COMPANION_QUEUE_SIZE}) — dropping oldest chunk to maintain flow`);
    }

    liveCompanionChunkQueue.push({
      audioBuffer: chunk,
      enqueued: Date.now()
    });

    processLiveCompanionQueue(sessionId);
  }, 150);

  console.log("[Voice Isolation] Companion delayed mode enabled with PCM chunk capture");
  return true;
}

async function decodeLastRecordingBuffer() {
  if (!lastRecordingBlob) {
    return null;
  }

  if (lastRecordingAudioBuffer) {
    return lastRecordingAudioBuffer;
  }

  const decoded = await decodeBlobToAudioBuffer(lastRecordingBlob);
  lastRecordingAudioBuffer = decoded;
  return decoded;
}

async function renderBandStemFromBuffer(sourceBuffer, band) {
  const context = new OfflineAudioContext(
    sourceBuffer.numberOfChannels,
    sourceBuffer.length,
    sourceBuffer.sampleRate
  );

  try {
    const source = context.createBufferSource();
    source.buffer = sourceBuffer;

    let endNode = source;

    if (band === "low") {
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 250;
      lowpass.Q.value = 0.707;
      endNode.connect(lowpass);
      endNode = lowpass;
    } else if (band === "mid") {
      const highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 250;
      highpass.Q.value = 0.707;
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 4000;
      lowpass.Q.value = 0.707;
      endNode.connect(highpass);
      highpass.connect(lowpass);
      endNode = lowpass;
    } else if (band === "high") {
      const highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 4000;
      highpass.Q.value = 0.707;
      endNode.connect(highpass);
      endNode = highpass;
    }

    endNode.connect(context.destination);
    source.start(0);
    return context.startRendering();
  } finally {
    // Note: OfflineAudioContext is closed automatically after startRendering() completes
  }
}

function getOrderedSourceStemNames(stemsByName) {
  const preferred = ["vocals", "drums", "bass", "other", "accompaniment", "melody"];
  const names = Object.keys(stemsByName || {}).filter((name) => {
    const stem = stemsByName?.[name];
    return Boolean(stem && typeof stem.getChannelData === "function" && Number.isFinite(stem.numberOfChannels));
  });
  return names.sort((a, b) => {
    const ia = preferred.indexOf(a.toLowerCase());
    const ib = preferred.indexOf(b.toLowerCase());
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function setSourceStemBuffers(stemsByName) {
  sourceStemBuffers = stemsByName;
  if (!sourceStemBuffers) {
    sourceStemMixSettings = {};
    selectedCleanupStem = "";
  }

  if (sourceStemBuffers) {
    const validStemNames = new Set(Object.keys(sourceStemBuffers));
    for (const stemName of Object.keys(stemCleanupState)) {
      if (!validStemNames.has(stemName)) {
        delete stemCleanupState[stemName];
      }
    }
  }

  invalidateStemMixCache();
  renderSourceStemControls();
  refreshCleanupStemControls();

  if (sourceStemBuffers && autoVocalCleanupEnabled) {
    applyAutoVocalCleanupPreset({ quiet: true });
  }

  updateLoadedAudioButtons();
  scheduleSessionCacheSync();
}

function applyStemCleanupToBuffer(stemBuffer, cleanup) {
  if (!stemBuffer || !cleanup?.enabled) {
    return stemBuffer;
  }

  const channelCount = stemBuffer.numberOfChannels;
  const frameCount = stemBuffer.length;
  const sampleRate = stemBuffer.sampleRate;
  const cleanedBuffer = new AudioBuffer({ length: frameCount, numberOfChannels: channelCount, sampleRate });

  const highpassHz = Math.max(20, Math.min(2000, Number(cleanup.highpassHz || 80)));
  const lowpassHz = Math.max(highpassHz + 100, Math.min(20000, Number(cleanup.lowpassHz || 18000)));
  const gateThreshold = Math.max(0, Math.min(0.08, Number(cleanup.gateThreshold || 0)));
  const transientReduction = Math.max(0, Math.min(1, Number(cleanup.transientReduction || 0)));

  const hpRc = 1 / (2 * Math.PI * highpassHz);
  const lpRc = 1 / (2 * Math.PI * lowpassHz);
  const dt = 1 / sampleRate;
  const hpAlpha = hpRc / (hpRc + dt);
  const lpAlpha = dt / (lpRc + dt);
  const transientThreshold = 0.008 + gateThreshold * 0.9;

  for (let channel = 0; channel < channelCount; channel += 1) {
    const input = stemBuffer.getChannelData(channel);
    const output = cleanedBuffer.getChannelData(channel);

    let prevInput = 0;
    let prevFiltered = 0;
    let hpY = 0;
    let lpY = 0;
    let transientEnv = 0;

    for (let i = 0; i < frameCount; i += 1) {
      const raw = input[i];
      const sample = raw;

      // Simple high-pass then low-pass chain.
      hpY = hpAlpha * (hpY + sample - prevInput);
      lpY += lpAlpha * (hpY - lpY);

      let cleaned = lpY;

      // Envelope-based transient taming to reduce percussion without warbling pitch.
      if (transientReduction > 0) {
        const delta = Math.abs(cleaned - prevFiltered);
        transientEnv = Math.max(delta, transientEnv * 0.985);
        if (transientEnv > transientThreshold) {
          const over = transientEnv - transientThreshold;
          const ratio = Math.min(1, over / (transientThreshold * 6 + 1e-6));
          const attenuation = 1 - transientReduction * ratio;
          cleaned *= attenuation;
        }
      }

      // Soft gate to avoid abrupt chattering.
      if (gateThreshold > 0) {
        const mag = Math.abs(cleaned);
        if (mag < gateThreshold) {
          cleaned *= mag / (gateThreshold + 1e-6);
        }
      }

      output[i] = Math.max(-1, Math.min(1, cleaned));
      prevInput = sample;
      prevFiltered = cleaned;
    }
  }

  return cleanedBuffer;
}

function getProcessedSourceStemBuffer(stemName, stemBuffer) {
  const cleanup = ensureStemCleanupSettings(stemName);
  if (!cleanup.enabled) {
    return stemBuffer;
  }

  const key = `${stemName}:${stemBuffer.length}:${stemBuffer.sampleRate}:${JSON.stringify(cleanup)}`;
  const cached = cachedProcessedStemBuffers.get(key);
  if (cached) {
    return cached;
  }

  const processed = applyStemCleanupToBuffer(stemBuffer, cleanup);
  cachedProcessedStemBuffers.set(key, processed);
  return processed;
}

async function downloadSourceStem(stemName) {
  if (!sourceStemBuffers || !sourceStemBuffers[stemName]) {
    setSourceStemStatus("none");
    return false;
  }

  const stemBuffer = getProcessedSourceStemBuffer(stemName, sourceStemBuffers[stemName]);
  const cleanupEnabled = Boolean(ensureStemCleanupSettings(stemName).enabled);
  const wavBlob = audioBufferToWavBlob(stemBuffer);
  const success = await triggerBlobDownload(
    wavBlob,
    "wav",
    cleanupEnabled ? `audio-mixer-stem-${stemName}-cleaned` : `audio-mixer-stem-${stemName}`
  );
  if (!success) {
    setSourceStemStatus(`failed to download ${stemName} stem`);
    return false;
  }
  setSourceStemStatus(cleanupEnabled ? `downloaded cleaned ${stemName} stem` : `downloaded ${stemName} stem`);
  return true;
}

async function downloadCurrentSourceStemMix() {
  if (!sourceStemBuffers) {
    setSourceStemStatus("none");
    return false;
  }

  const sourceMix = buildSourceStemMixBuffer();
  if (!sourceMix) {
    setSourceStemStatus("unable to build source stem mix");
    return false;
  }

  const wavBlob = audioBufferToWavBlob(sourceMix);
  const success = await triggerBlobDownload(wavBlob, "wav", "audio-mixer-stem-mix");
  setSourceStemStatus(success ? "downloaded current stem mix" : "failed to download current stem mix");
  return success;
}

async function downloadPreparedInstrumental() {
  if (!preparedInstrumentalBuffer) {
    setVoiceIsolationStatus(`no processed ${preparedInstrumentalStemName} to download`);
    return false;
  }
  const stemName = preparedInstrumentalStemName || "instrumental";
  const safeName = (preparedInstrumentalTrackTitle || stemName)
    .replace(/[^a-z0-9\-_ ]/gi, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 80) || stemName;
  const wavBlob = audioBufferToWavBlob(preparedInstrumentalBuffer);
  const success = await triggerBlobDownload(wavBlob, "wav", `audio-mixer-${stemName}-${safeName}`);
  setVoiceIsolationStatus(success ? `downloading ${stemName} WAV...` : `${stemName} download failed`);
  return success;
}

async function downloadAllSourceStems() {
  if (!sourceStemBuffers) {
    setSourceStemStatus("none");
    return false;
  }

  const stemNames = getOrderedSourceStemNames(sourceStemBuffers);
  if (!stemNames.length) {
    setSourceStemStatus("none");
    return false;
  }

  const failed = [];
  for (const stemName of stemNames) {
    const success = await downloadSourceStem(stemName);
    if (!success) {
      failed.push(stemName);
    }
  }
  if (failed.length) {
    setSourceStemStatus(`failed stems: ${failed.join(", ")}`);
    return false;
  }
  setSourceStemStatus(`downloaded all stems (${stemNames.join(", ")})`);
  return true;
}

function applySourceStemMutePreset(excludedStemNames = []) {
  if (!sourceStemBuffers) {
    setSourceStemStatus("none");
    return;
  }

  const excluded = new Set(excludedStemNames.map((name) => String(name).toLowerCase()));
  const stemNames = getOrderedSourceStemNames(sourceStemBuffers);

  for (const stemName of stemNames) {
    if (!sourceStemMixSettings[stemName]) {
      sourceStemMixSettings[stemName] = { gain: 1, mute: false };
    }
    sourceStemMixSettings[stemName].mute = excluded.has(stemName.toLowerCase());
  }

  invalidateStemMixCache();
  renderSourceStemControls();
  scheduleSessionCacheSync();

  if (recordedAudioIsPlaying && useStemMixPlaybackInput.checked && sourceStemBuffers) {
    startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds });
  }

  saveSettings();

  if (excluded.size === 0) {
    setSourceStemStatus("preset applied: all stems enabled");
  } else {
    setSourceStemStatus(`preset applied: excluding ${Array.from(excluded).join(", ")}`);
  }
}

function renderSourceStemControls() {
  if (!sourceStemControlsEl) {
    return;
  }

  sourceStemControlsEl.innerHTML = "";
  if (!sourceStemBuffers) {
    setSourceStemStatus("none");
    return;
  }

  const stemNames = getOrderedSourceStemNames(sourceStemBuffers);
  for (const stemName of stemNames) {
    if (!sourceStemMixSettings[stemName]) {
      sourceStemMixSettings[stemName] = { gain: 1, mute: false };
    }

    const row = document.createElement("div");
    row.className = "source-stem-row";

    const label = document.createElement("label");
    label.className = "control";
    label.htmlFor = `sourceStemGain-${stemName}`;

    const title = document.createElement("span");
    title.textContent = stemName.charAt(0).toUpperCase() + stemName.slice(1);

    const slider = document.createElement("input");
    slider.id = `sourceStemGain-${stemName}`;
    slider.type = "range";
    slider.min = "0";
    slider.max = "1.5";
    slider.step = "0.01";
    slider.value = String(sourceStemMixSettings[stemName].gain);

    const output = document.createElement("output");
    output.textContent = `${Math.round(sourceStemMixSettings[stemName].gain * 100)}%`;

    slider.addEventListener("input", () => {
      ensureStemMixPlaybackEnabled();
      sourceStemMixSettings[stemName].gain = Number(slider.value);
      output.textContent = `${Math.round(Number(slider.value) * 100)}%`;
      scheduleSessionCacheSync();
      if (recordedAudioIsPlaying && useStemMixPlaybackInput.checked && sourceStemBuffers) {
        startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds });
      }
    });

    label.appendChild(title);
    label.appendChild(slider);
    label.appendChild(output);

    const muteLabel = document.createElement("label");
    muteLabel.className = "stem-mute";
    const mute = document.createElement("input");
    mute.type = "checkbox";
    mute.checked = Boolean(sourceStemMixSettings[stemName].mute);
    mute.addEventListener("change", () => {
      ensureStemMixPlaybackEnabled();
      sourceStemMixSettings[stemName].mute = mute.checked;
      scheduleSessionCacheSync();
      if (recordedAudioIsPlaying && useStemMixPlaybackInput.checked && sourceStemBuffers) {
        startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds });
      }
    });
    muteLabel.appendChild(mute);
    muteLabel.appendChild(document.createTextNode(" Mute"));

    const downloadStemBtn = document.createElement("button");
    downloadStemBtn.type = "button";
    downloadStemBtn.className = "source-stem-download-btn";
    downloadStemBtn.textContent = "Download";
    downloadStemBtn.addEventListener("click", async () => {
      await downloadSourceStem(stemName);
    });

    row.appendChild(label);
    row.appendChild(muteLabel);
    row.appendChild(downloadStemBtn);
    sourceStemControlsEl.appendChild(row);
  }

  setSourceStemStatus(`ready (${stemNames.join(", ")})`);
}

function buildSourceStemMixBuffer() {
  if (!sourceStemBuffers) {
    return null;
  }

  const stemNames = getOrderedSourceStemNames(sourceStemBuffers);
  if (!stemNames.length) {
    return null;
  }

  const channelCount = loadedAudioBuffer.numberOfChannels;
  const frameCount = loadedAudioBuffer.length;
  const sampleRate = loadedAudioBuffer.sampleRate;
  
  // Create a cache key based on stem settings
  const settingsKey = JSON.stringify({ mix: sourceStemMixSettings, cleanup: stemCleanupState });
  const cacheKey = `source_${frameCount}_${channelCount}_${settingsKey}`;
  
  // Return cached buffer if settings haven't changed
  if (cachedStemMixKey === cacheKey && cachedStemMixBuffer) {
    return cachedStemMixBuffer;
  }
  
  const mixed = new AudioBuffer({ length: frameCount, numberOfChannels: channelCount, sampleRate });

  for (let channel = 0; channel < channelCount; channel += 1) {
    const output = mixed.getChannelData(channel);
    for (const stemName of stemNames) {
      const stem = sourceStemBuffers[stemName];
      if (!stem) continue;
      const processedStem = getProcessedSourceStemBuffer(stemName, stem);

      const state = sourceStemMixSettings[stemName] || { gain: 1, mute: false };
      const gain = state.mute ? 0 : Number(state.gain);
      if (!gain) continue;

      const data = processedStem.getChannelData(Math.min(channel, processedStem.numberOfChannels - 1));
      const maxI = Math.min(frameCount, data.length);
      for (let i = 0; i < maxI; i += 1) {
        output[i] += data[i] * gain;
      }
    }

    for (let i = 0; i < frameCount; i += 1) {
      output[i] = Math.max(-1, Math.min(1, output[i]));
    }
  }
  
  // Cache the result
  cachedStemMixBuffer = mixed;
  cachedStemMixKey = cacheKey;
  
  return mixed;
}

function buildStemMixBuffer() {
  const sourceMix = buildSourceStemMixBuffer();
  if (sourceMix) {
    return sourceMix;
  }

  if (!splitStemBuffers) {
    return loadedAudioBuffer;
  }

  const { low, mid, high } = splitStemBuffers;
  const channelCount = loadedAudioBuffer.numberOfChannels;
  const frameCount = loadedAudioBuffer.length;
  const sampleRate = loadedAudioBuffer.sampleRate;

  // Create a cache key based on band gains/mutes
  const lowGain = stemLowMuteInput.checked ? 0 : Number(stemLowGainInput.value);
  const midGain = stemMidMuteInput.checked ? 0 : Number(stemMidGainInput.value);
  const highGain = stemHighMuteInput.checked ? 0 : Number(stemHighGainInput.value);
  const cacheKey = `split_${frameCount}_${channelCount}_${lowGain}_${midGain}_${highGain}`;
  
  // Return cached buffer if settings haven't changed
  if (cachedStemMixKey === cacheKey && cachedStemMixBuffer) {
    return cachedStemMixBuffer;
  }
  
  const mixed = new AudioBuffer({ length: frameCount, numberOfChannels: channelCount, sampleRate });

  for (let channel = 0; channel < channelCount; channel += 1) {
    const output = mixed.getChannelData(channel);
    const lowData = low.getChannelData(Math.min(channel, low.numberOfChannels - 1));
    const midData = mid.getChannelData(Math.min(channel, mid.numberOfChannels - 1));
    const highData = high.getChannelData(Math.min(channel, high.numberOfChannels - 1));

    for (let i = 0; i < frameCount; i += 1) {
      const sum = lowData[i] * lowGain + midData[i] * midGain + highData[i] * highGain;
      output[i] = Math.max(-1, Math.min(1, sum));
    }
  }
  
  // Cache the result
  cachedStemMixBuffer = mixed;
  cachedStemMixKey = cacheKey;

  return mixed;
}

function activateStemMixPlayback() {
  if (!splitStemBuffers && !sourceStemBuffers) {
    return;
  }

  useStemMixPlaybackInput.checked = true;
  saveSettings();

  if (recordedAudioIsPlaying) {
    startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds });
  }
}

async function generateBandStems() {
  if (!loadedAudioBuffer) {
    setStemStatus("load audio first");
    return;
  }

  try {
    setStemStatus("splitting into low/mid/high...");
    generateStemsBtn.disabled = true;

    const [low, mid, high] = await Promise.all([
      renderBandStemFromBuffer(loadedAudioBuffer, "low"),
      renderBandStemFromBuffer(loadedAudioBuffer, "mid"),
      renderBandStemFromBuffer(loadedAudioBuffer, "high")
    ]);

    splitStemBuffers = { low, mid, high };
    setSourceStemBuffers(null);
    activateStemMixPlayback();
    setStemStatus("ready (low/mid/high) - playback stem mix enabled");
  } catch (error) {
    console.error("[Audio Mixer] Failed to generate stems", error);
    splitStemBuffers = null;
    setSourceStemBuffers(null);
    setStemStatus("split failed");
  } finally {
    updateLoadedAudioButtons();
  }
}

function supportsWaveformStemInput(inputDims) {
  if (!Array.isArray(inputDims)) return false;
  if (inputDims.length === 2) return true;
  if (inputDims.length === 3) return true;
  return false;
}

function readModelDims(session, inputName) {
  const inputMeta = session.inputMetadata?.[inputName];
  const dims = inputMeta?.dimensions || [];
  return dims.map((d) => {
    if (typeof d === "number" && d > 0) return d;
    if (typeof d === "string") {
      const parsed = Number(d);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  });
}

function isSpectrogramStemShape(inputDims) {
  return Array.isArray(inputDims) && inputDims.length === 4;
}

function dimMatches(actual, expected) {
  return actual == null || actual === expected;
}

function formatDims(inputDims) {
  if (!Array.isArray(inputDims) || !inputDims.length) {
    return "unknown";
  }
  return inputDims.map((d) => (d ?? "?")).join("x");
}

function looksCompatibleKuielabInputDims(inputDims) {
  if (!Array.isArray(inputDims) || inputDims.length === 0) {
    return true;
  }

  if (inputDims.length === 4) {
    return dimMatches(inputDims[1], 4)
      && dimMatches(inputDims[2], KUIELAB_FREQ_BINS)
      && dimMatches(inputDims[3], KUIELAB_CHUNK_FRAMES);
  }

  if (inputDims.length === 3) {
    return dimMatches(inputDims[0], 4)
      && dimMatches(inputDims[1], KUIELAB_FREQ_BINS)
      && dimMatches(inputDims[2], KUIELAB_CHUNK_FRAMES);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Lightweight vocal-only Kuielab runner for live companion vocal mode.
// Loads only kuielab_a_vocals.onnx instead of all four stem models.
// ---------------------------------------------------------------------------

async function ensureKuielabVocalSession() {
  if (kuielabVocalSessionPromise) {
    return kuielabVocalSessionPromise;
  }

  kuielabVocalSessionPromise = (async () => {
    if (typeof ort === "undefined" || !ort?.InferenceSession?.create) {
      throw new Error("ONNX runtime not available");
    }
    ensureOrtConfigured();

    const relPath = "models/kuielab_a_vocals.onnx";
    const url = chrome.runtime.getURL(relPath);

    // Verify the model file is accessible before attempting to load it.
    const headRes = await fetch(url, { method: "HEAD" });
    if (!headRes.ok) {
      throw new Error("kuielab_a_vocals.onnx not found — cannot use vocal isolation AI");
    }

    const session = await ort.InferenceSession.create(url, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      enableCpuMemArena: true,
      enableMemPattern: true
    });

    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const inputDims = readModelDims(session, inputName);

    if (!looksCompatibleKuielabInputDims(inputDims)) {
      throw new Error(`kuielab_a_vocals.onnx has unexpected input shape ${formatDims(inputDims)}`);
    }

    console.log(`[Voice Isolation] Loaded kuielab vocals model — input shape ${formatDims(inputDims)}`);
    return { session, inputName, outputName };
  })().catch((error) => {
    kuielabVocalSessionPromise = null;
    throw error;
  });

  return kuielabVocalSessionPromise;
}

/**
 * Run vocal isolation on sourceBuffer using the Kuielab ONNX vocals model.
 * Returns an AudioBuffer containing the isolated vocals at sourceBuffer's sample rate.
 * Falls back to the Demucs companion server if the model is unavailable.
 */
async function requestKuielabVocalIsolation(sourceBuffer, { onProgress, signal } = {}) {
  let spec;
  try {
    spec = await ensureKuielabVocalSession();
  } catch (error) {
    console.warn("[Voice Isolation] Kuielab vocal model unavailable, falling back to Demucs:", error.message);
    return requestCompanionIsolationStem(sourceBuffer, "vocals");
  }

  // Resample to the rate the Kuielab models expect.
  const workingBuffer = await resampleAudioBuffer(sourceBuffer, KUIELAB_SAMPLE_RATE);

  // Overlap-add accumulation (same windowing as the full Kuielab pipeline).
  const accLeft = new Float32Array(workingBuffer.length);
  const accRight = new Float32Array(workingBuffer.length);
  const accWeight = new Float32Array(workingBuffer.length);

  const totalLength = workingBuffer.length;
  for (let chunkStart = 0; chunkStart < totalLength; chunkStart += KUIELAB_CHUNK_HOP) {
    // Respect cancellation signal between chunks.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const inputTensor = encodeKuielabChunk(workingBuffer, chunkStart);
    const outputs = await spec.session.run({ [spec.inputName]: inputTensor });
    const chunk = decodeKuielabOutput(outputs[spec.outputName]);

    const validLength = Math.max(0, Math.min(KUIELAB_CHUNK_SAMPLES, totalLength - chunkStart));
    const denom = Math.max(1, validLength - 1);
    for (let i = 0; i < validLength; i += 1) {
      const idx = chunkStart + i;
      const w = validLength <= 1 ? 1 : (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom));
      accLeft[idx] += (chunk.left[i] || 0) * w;
      accRight[idx] += (chunk.right[i] || 0) * w;
      accWeight[idx] += w;
    }

    // Report progress after each chunk (capped at 99% until finalize step).
    if (onProgress) {
      onProgress(Math.min(0.99, (chunkStart + KUIELAB_CHUNK_HOP) / totalLength));
    }

    // Yield to the event loop between chunks to avoid long task jank.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Normalise accumulated overlap-add result.
  const offlineCtx = new OfflineAudioContext(2, workingBuffer.length, KUIELAB_SAMPLE_RATE);
  const stemBuffer = offlineCtx.createBuffer(2, workingBuffer.length, KUIELAB_SAMPLE_RATE);
  const leftOut = stemBuffer.getChannelData(0);
  const rightOut = stemBuffer.getChannelData(1);
  for (let i = 0; i < workingBuffer.length; i += 1) {
    const gain = accWeight[i] > 1e-8 ? 1 / accWeight[i] : 1;
    leftOut[i] = clampSample(accLeft[i] * gain);
    rightOut[i] = clampSample(accRight[i] * gain);
  }

  // Resample back to the caller's sample rate if needed.
  return sourceBuffer.sampleRate === KUIELAB_SAMPLE_RATE
    ? stemBuffer
    : resampleAudioBuffer(stemBuffer, sourceBuffer.sampleRate);
}

async function ensureKuielabStemSessions() {
  if (kuielabStemSessionsPromise) {
    return kuielabStemSessionsPromise;
  }

  kuielabStemSessionsPromise = (async () => {
    if (typeof ort === "undefined" || !ort?.InferenceSession?.create) {
      throw new Error("ONNX runtime not available");
    }
    ensureOrtConfigured();

    const variants = [
      {
        id: "a",
        label: "A",
        required: true,
        modelPaths: Object.fromEntries(KUIELAB_STEM_NAMES.map((stem) => [stem, `models/kuielab_a_${stem}.onnx`]))
      },
      {
        id: "b",
        label: "B",
        required: false,
        modelPaths: Object.fromEntries(KUIELAB_STEM_NAMES.map((stem) => [stem, `models/kuielab_b_${stem}.onnx`]))
      }
    ];

    const availableVariants = [];
    for (const variant of variants) {
      const stemPaths = Object.entries(variant.modelPaths);
      const existsResults = await Promise.all(
        stemPaths.map(async ([, relPath]) => {
          const url = chrome.runtime.getURL(relPath);
          try {
            const response = await fetch(url, { method: "HEAD" });
            return response.ok;
          } catch (_error) {
            return false;
          }
        })
      );

      const hasAll = existsResults.every(Boolean);
      if (variant.required && !hasAll) {
        throw new Error(`Missing required Kuielab ${variant.label} models`);
      }

      if (hasAll) {
        availableVariants.push(variant);
      }
    }

    const totalModels = availableVariants.length * KUIELAB_STEM_NAMES.length;
    let loadedCount = 0;
    const variantEntries = [];
    for (const variant of availableVariants) {
      const stemEntries = [];
      for (const stemName of KUIELAB_STEM_NAMES) {
        loadedCount += 1;
        setSourceStemStatus(`loading model ${loadedCount}/${totalModels}: ${stemName} (${variant.label})`);
        setStemStatus(`AI source-stem split preparing... loading ${stemName} ${variant.label} model`);
        setStemProgress((loadedCount / totalModels) * 20, `Loading model ${loadedCount}/${totalModels}: ${stemName} (${variant.label})`);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const relPath = variant.modelPaths[stemName];
        const session = await ort.InferenceSession.create(chrome.runtime.getURL(relPath), {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
          enableCpuMemArena: true,
          enableMemPattern: true
        });
        const inputName = session.inputNames[0];
        const outputName = session.outputNames[0];
        const inputDims = readModelDims(session, inputName);
        const shape = formatDims(inputDims);
        if (!looksCompatibleKuielabInputDims(inputDims)) {
          throw new Error(`${stemName} ${variant.label} model has unexpected shape ${shape}`);
        }
        console.log(`[Stems] Loaded Kuielab ${variant.label} ${stemName} model with input shape ${shape}`);
        stemEntries.push([stemName, { session, inputName, outputName }]);
      }
      variantEntries.push({ id: variant.id, label: variant.label, stems: Object.fromEntries(stemEntries) });
    }

    if (!variantEntries.length) {
      throw new Error("No Kuielab model variants available");
    }

    const labels = variantEntries.map((entry) => entry.label).join("+");
    console.log(`[Stems] Kuielab ensemble active: ${labels}`);
    return { variants: variantEntries };
  })().catch((error) => {
    kuielabStemSessionsPromise = null;
    throw error;
  });

  return kuielabStemSessionsPromise;
}

async function generateKuielabSourceStems(sourceBuffer, options = {}) {
  const studioQuality = Boolean(options.studioQuality);
  const sessions = await ensureKuielabStemSessions();
  const variants = sessions.variants || [];
  const workingBuffer = await resampleAudioBuffer(sourceBuffer, KUIELAB_SAMPLE_RATE);
  const allowReversePass = studioQuality && workingBuffer.duration <= KUIELAB_STUDIO_REVERSE_MAX_SECONDS;

  const forwardPass = await runKuielabInferencePass({
    workingBuffer,
    variants,
    passLabel: "Forward",
    progressStart: 20,
    progressSpan: allowReversePass ? 40 : 80
  });

  let normalized = forwardPass;
  if (allowReversePass) {
    setSourceStemStatus("studio refinement: preparing reverse pass");
    setStemStatus("AI source-stem split studio refinement...");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reversedBuffer = createReversedBuffer(workingBuffer);
    const reversePass = await runKuielabInferencePass({
      workingBuffer: reversedBuffer,
      variants,
      passLabel: "Reverse",
      progressStart: 60,
      progressSpan: 40
    });

    normalized = {};
    const length = workingBuffer.length;
    for (const stemName of KUIELAB_STEM_NAMES) {
      const fw = forwardPass[stemName];
      const rv = reversePass[stemName];
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      for (let i = 0; i < length; i += 1) {
        const j = length - 1 - i;
        const revL = rv?.left?.[j] || 0;
        const revR = rv?.right?.[j] || 0;
        left[i] = clampSample((fw?.left?.[i] || 0) * 0.5 + revL * 0.5);
        right[i] = clampSample((fw?.right?.[i] || 0) * 0.5 + revR * 0.5);
      }
      normalized[stemName] = { left, right };
    }
  } else if (studioQuality) {
    setSourceStemStatus(`studio refinement: reverse pass skipped for clips over ${KUIELAB_STUDIO_REVERSE_MAX_SECONDS}s`);
    setStemStatus("AI source-stem split studio mode: running fast polish path for long clip...");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (studioQuality) {
    applyVocalBleedReduction(normalized);
  }
  applyKuielabMixtureConsistency(normalized, workingBuffer);

  const renderedStems = {};
  for (const stemName of KUIELAB_STEM_NAMES) {
    const tempContext = new OfflineAudioContext(2, workingBuffer.length, KUIELAB_SAMPLE_RATE);
    const stemBuffer = tempContext.createBuffer(2, workingBuffer.length, KUIELAB_SAMPLE_RATE);
    stemBuffer.getChannelData(0).set(normalized[stemName].left);
    stemBuffer.getChannelData(1).set(normalized[stemName].right);
    renderedStems[stemName] = await resampleAudioBuffer(stemBuffer, sourceBuffer.sampleRate);
  }

  const ensembleLabel = variants.map((variant) => variant.label).join("+");
  const qualityLabel = studioQuality ? (allowReversePass ? "studio" : "studio-lite") : "fast";
  setSourceStemStatus(`ready (vocals, drums, bass, other) - ensemble ${ensembleLabel}, ${qualityLabel}`);
  setStemProgress(100, "Source stems ready");
  return renderedStems;
}

async function ensureAiStemSession() {
  if (aiStemSessionPromise) {
    return aiStemSessionPromise;
  }

  aiStemSessionPromise = (async () => {
    if (typeof ort === "undefined" || !ort?.InferenceSession?.create) {
      throw new Error("ONNX runtime not available");
    }
    ensureOrtConfigured();

    const candidates = [
      { path: chrome.runtime.getURL("models/source-stems.onnx"), name: "Source Stems" },
      { path: chrome.runtime.getURL("models/kuielab_a_vocals.onnx"), name: "Kuielab Vocals" },
      { path: chrome.runtime.getURL("models/kuielab_a_drums.onnx"), name: "Kuielab Drums" },
      { path: chrome.runtime.getURL("models/kuielab_a_bass.onnx"), name: "Kuielab Bass" },
      { path: chrome.runtime.getURL("models/kuielab_a_other.onnx"), name: "Kuielab Other" },
      { path: chrome.runtime.getURL("models/stem-vocals.onnx"), name: "Stem Vocals" },
      { path: chrome.runtime.getURL("models/voice-isolation.onnx"), name: "Voice Isolation" },
      { path: chrome.runtime.getURL("models/demucs-vocals.onnx"), name: "Demucs Vocals" }
    ];

    for (const candidate of candidates) {
      try {
        const session = await ort.InferenceSession.create(candidate.path, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
          enableCpuMemArena: true,
          enableMemPattern: true
        });

        const inputName = session.inputNames[0];
        const outputName = session.outputNames[0];
        const inputDims = readModelDims(session, inputName);

        if (!supportsWaveformStemInput(inputDims)) {
          const printableDims = inputDims.map((d) => (d ?? "?")).join("x");
          if (isSpectrogramStemShape(inputDims)) {
            throw new Error(`spectrogram model detected (${printableDims}) - requires STFT/ISTFT backend`);
          }
          throw new Error(`incompatible input shape ${printableDims}`);
        }

        return {
          session,
          name: candidate.name,
          inputName,
          outputName,
          inputDims
        };
      } catch (error) {
        console.warn(`[Stems] Could not load AI model ${candidate.name}:`, error?.message || error);
      }
    }

    throw new Error("No waveform-compatible AI stem model found. Downloaded Kuielab models require a spectrogram STFT/ISTFT backend.");
  })().catch((error) => {
    aiStemSessionPromise = null;
    throw error;
  });

  return aiStemSessionPromise;
}

function createEmptyBufferLike(sourceBuffer) {
  const tempContext = new OfflineAudioContext(
    sourceBuffer.numberOfChannels,
    sourceBuffer.length,
    sourceBuffer.sampleRate
  );
  return tempContext.createBuffer(
    sourceBuffer.numberOfChannels,
    sourceBuffer.length,
    sourceBuffer.sampleRate
  );
}

async function resampleAudioBuffer(sourceBuffer, targetSampleRate) {
  if (sourceBuffer.sampleRate === targetSampleRate) {
    return sourceBuffer;
  }

  const targetLength = Math.max(1, Math.round(sourceBuffer.duration * targetSampleRate));
  const context = new OfflineAudioContext(sourceBuffer.numberOfChannels, targetLength, targetSampleRate);
  const source = context.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(context.destination);
  source.start(0);
  return context.startRendering();
}

function getStereoChannels(buffer) {
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
  return { left, right };
}

function createReversedBuffer(sourceBuffer) {
  const reversed = createEmptyBufferLike(sourceBuffer);
  const length = sourceBuffer.length;
  for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch += 1) {
    const src = sourceBuffer.getChannelData(ch);
    const dst = reversed.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      dst[i] = src[length - 1 - i];
    }
  }
  return reversed;
}

function applyKuielabMixtureConsistency(normalized, sourceBuffer) {
  const sourceChannels = getStereoChannels(sourceBuffer);
  for (let i = 0; i < sourceBuffer.length; i += 1) {
    let sumLeft = 0;
    let sumRight = 0;
    let energyLeft = 0;
    let energyRight = 0;

    for (const stemName of KUIELAB_STEM_NAMES) {
      const stem = normalized[stemName];
      const l = stem.left[i] || 0;
      const r = stem.right[i] || 0;
      sumLeft += l;
      sumRight += r;
      energyLeft += Math.abs(l);
      energyRight += Math.abs(r);
    }

    const residualLeft = sourceChannels.left[i] - sumLeft;
    const residualRight = sourceChannels.right[i] - sumRight;

    for (const stemName of KUIELAB_STEM_NAMES) {
      const stem = normalized[stemName];
      const l = stem.left[i] || 0;
      const r = stem.right[i] || 0;
      const wl = energyLeft > 1e-8 ? Math.abs(l) / energyLeft : 0.25;
      const wr = energyRight > 1e-8 ? Math.abs(r) / energyRight : 0.25;
      stem.left[i] = clampSample(l + residualLeft * wl * KUIELAB_MIXTURE_CONSISTENCY_BLEND);
      stem.right[i] = clampSample(r + residualRight * wr * KUIELAB_MIXTURE_CONSISTENCY_BLEND);
    }
  }
}

function applyVocalBleedReduction(normalized) {
  const vocals = normalized.vocals;
  const drums = normalized.drums;
  const bass = normalized.bass;
  const other = normalized.other;
  if (!vocals || !drums || !bass || !other) {
    return;
  }

  const length = vocals.left.length;
  for (let i = 0; i < length; i += 1) {
    const accompL = (drums.left[i] || 0) + (bass.left[i] || 0) + (other.left[i] || 0);
    const accompR = (drums.right[i] || 0) + (bass.right[i] || 0) + (other.right[i] || 0);

    const vocalMagL = Math.abs(vocals.left[i] || 0);
    const vocalMagR = Math.abs(vocals.right[i] || 0);
    const accompMagL = Math.abs(accompL);
    const accompMagR = Math.abs(accompR);

    const overL = Math.max(0, accompMagL - vocalMagL * VOCAL_BLEED_GATE_RATIO);
    const overR = Math.max(0, accompMagR - vocalMagR * VOCAL_BLEED_GATE_RATIO);
    const gateL = accompMagL > 1e-8 ? Math.min(1, overL / accompMagL) : 0;
    const gateR = accompMagR > 1e-8 ? Math.min(1, overR / accompMagR) : 0;

    const cancelL = accompL * VOCAL_BLEED_CANCEL_STRENGTH * gateL;
    const cancelR = accompR * VOCAL_BLEED_CANCEL_STRENGTH * gateR;
    vocals.left[i] = clampSample((vocals.left[i] || 0) - cancelL);
    vocals.right[i] = clampSample((vocals.right[i] || 0) - cancelR);
  }
}

async function runKuielabInferencePass({
  workingBuffer,
  variants,
  passLabel,
  progressStart,
  progressSpan
}) {
  const variantCount = Math.max(1, variants.length);
  const stemAcc = {};
  for (const stemName of KUIELAB_STEM_NAMES) {
    stemAcc[stemName] = {
      left: new Float32Array(workingBuffer.length),
      right: new Float32Array(workingBuffer.length),
      weight: new Float32Array(workingBuffer.length)
    };
  }

  const totalChunks = Math.max(1, Math.ceil(Math.max(0, workingBuffer.length - 1) / KUIELAB_CHUNK_HOP) + 1);
  const startedAt = performance.now();
  for (let chunkIndex = 0, chunkStart = 0; chunkStart < workingBuffer.length; chunkStart += KUIELAB_CHUNK_HOP, chunkIndex += 1) {
    const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
    const elapsed = (performance.now() - startedAt) / 1000;
    const overall = progressStart + ((chunkIndex + 1) / totalChunks) * progressSpan;
    setSourceStemStatus(`${passLabel} pass chunk ${chunkIndex + 1}/${totalChunks} (${progress}%)`);
    setStemStatus(`AI source-stem split ${passLabel.toLowerCase()} pass... ${progress}% (${elapsed.toFixed(1)}s)`);
    setStemProgress(overall, `(${passLabel}) chunk ${chunkIndex + 1}/${totalChunks}`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inputTensor = encodeKuielabChunk(workingBuffer, chunkStart);
    for (const stemName of KUIELAB_STEM_NAMES) {
      const acc = stemAcc[stemName];
      const validLength = Math.max(0, Math.min(KUIELAB_CHUNK_SAMPLES, workingBuffer.length - chunkStart));
      const denom = Math.max(1, validLength - 1);

      for (const variant of variants) {
        const spec = variant.stems[stemName];
        if (!spec) {
          continue;
        }
        const outputs = await spec.session.run({ [spec.inputName]: inputTensor });
        const chunk = decodeKuielabOutput(outputs[spec.outputName]);

        for (let i = 0; i < validLength; i += 1) {
          const idx = chunkStart + i;
          const w = validLength <= 1 ? 1 : (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom));
          const vw = w / variantCount;
          acc.left[idx] += (chunk.left[i] || 0) * vw;
          acc.right[idx] += (chunk.right[i] || 0) * vw;
          acc.weight[idx] += vw;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const normalized = {};
  for (const [stemName, acc] of Object.entries(stemAcc)) {
    const left = new Float32Array(workingBuffer.length);
    const right = new Float32Array(workingBuffer.length);
    for (let i = 0; i < workingBuffer.length; i += 1) {
      const gain = acc.weight[i] > 1e-8 ? 1 / acc.weight[i] : 1;
      left[i] = clampSample(acc.left[i] * gain);
      right[i] = clampSample(acc.right[i] * gain);
    }
    normalized[stemName] = { left, right };
  }

  return normalized;
}

function encodeKuielabChunk(buffer, chunkStart) {
  const { left, right } = getStereoChannels(buffer);
  const tensorData = new Float32Array(4 * KUIELAB_FREQ_BINS * KUIELAB_CHUNK_FRAMES);
  const realL = new Float32Array(KUIELAB_FFT_SIZE);
  const imagL = new Float32Array(KUIELAB_FFT_SIZE);
  const realR = new Float32Array(KUIELAB_FFT_SIZE);
  const imagR = new Float32Array(KUIELAB_FFT_SIZE);

  for (let frame = 0; frame < KUIELAB_CHUNK_FRAMES; frame += 1) {
    const frameStart = chunkStart + frame * KUIELAB_HOP_SIZE - KUIELAB_FRAME_OFFSET;
    for (let i = 0; i < KUIELAB_FFT_SIZE; i += 1) {
      const sampleIndex = frameStart + i;
      const l = sampleIndex >= 0 && sampleIndex < buffer.length ? left[sampleIndex] : 0;
      const r = sampleIndex >= 0 && sampleIndex < buffer.length ? right[sampleIndex] : 0;
      const w = kuielabWindow[i];
      realL[i] = l * w;
      imagL[i] = 0;
      realR[i] = r * w;
      imagR[i] = 0;
    }

    kuielabFft.transform(realL, imagL, false);
    kuielabFft.transform(realR, imagR, false);

    for (let bin = 0; bin < KUIELAB_FREQ_BINS; bin += 1) {
      tensorData[((0 * KUIELAB_FREQ_BINS + bin) * KUIELAB_CHUNK_FRAMES) + frame] = realL[bin];
      tensorData[((1 * KUIELAB_FREQ_BINS + bin) * KUIELAB_CHUNK_FRAMES) + frame] = imagL[bin];
      tensorData[((2 * KUIELAB_FREQ_BINS + bin) * KUIELAB_CHUNK_FRAMES) + frame] = realR[bin];
      tensorData[((3 * KUIELAB_FREQ_BINS + bin) * KUIELAB_CHUNK_FRAMES) + frame] = imagR[bin];
    }
  }

  return new ort.Tensor("float32", tensorData, [1, 4, KUIELAB_FREQ_BINS, KUIELAB_CHUNK_FRAMES]);
}

function decodeKuielabOutput(outputTensor) {
  const dims = outputTensor?.dims || [];
  const data = outputTensor?.data;
  if (!data || dims.length !== 4) {
    throw new Error(`Unexpected Kuielab output shape (${dims.join("x") || "unknown"})`);
  }

  const reconLength = KUIELAB_CHUNK_SAMPLES + KUIELAB_FFT_SIZE;
  const outLeft = new Float32Array(reconLength);
  const outRight = new Float32Array(reconLength);
  const norm = new Float32Array(reconLength);
  const realL = new Float32Array(KUIELAB_FFT_SIZE);
  const imagL = new Float32Array(KUIELAB_FFT_SIZE);
  const realR = new Float32Array(KUIELAB_FFT_SIZE);
  const imagR = new Float32Array(KUIELAB_FFT_SIZE);

  for (let frame = 0; frame < KUIELAB_CHUNK_FRAMES; frame += 1) {
    realL.fill(0);
    imagL.fill(0);
    realR.fill(0);
    imagR.fill(0);

    for (let bin = 0; bin < KUIELAB_FREQ_BINS; bin += 1) {
      const indexBase = bin * KUIELAB_CHUNK_FRAMES + frame;
      realL[bin] = data[(0 * KUIELAB_FREQ_BINS * KUIELAB_CHUNK_FRAMES) + indexBase] || 0;
      imagL[bin] = data[(1 * KUIELAB_FREQ_BINS * KUIELAB_CHUNK_FRAMES) + indexBase] || 0;
      realR[bin] = data[(2 * KUIELAB_FREQ_BINS * KUIELAB_CHUNK_FRAMES) + indexBase] || 0;
      imagR[bin] = data[(3 * KUIELAB_FREQ_BINS * KUIELAB_CHUNK_FRAMES) + indexBase] || 0;
    }

    for (let bin = 1; bin < KUIELAB_FREQ_BINS; bin += 1) {
      const mirror = KUIELAB_FFT_SIZE - bin;
      realL[mirror] = realL[bin];
      imagL[mirror] = -imagL[bin];
      realR[mirror] = realR[bin];
      imagR[mirror] = -imagR[bin];
    }

    kuielabFft.transform(realL, imagL, true);
    kuielabFft.transform(realR, imagR, true);

    const frameOffset = frame * KUIELAB_HOP_SIZE;
    for (let i = 0; i < KUIELAB_FFT_SIZE; i += 1) {
      const w = kuielabWindow[i];
      const sampleIndex = frameOffset + i;
      outLeft[sampleIndex] += realL[i] * w;
      outRight[sampleIndex] += realR[i] * w;
      norm[sampleIndex] += w * w;
    }
  }

  const chunkLeft = new Float32Array(KUIELAB_CHUNK_SAMPLES);
  const chunkRight = new Float32Array(KUIELAB_CHUNK_SAMPLES);
  for (let i = 0; i < KUIELAB_CHUNK_SAMPLES; i += 1) {
    const sourceIndex = i + KUIELAB_FRAME_OFFSET;
    const gain = norm[sourceIndex] > 1e-8 ? 1 / norm[sourceIndex] : 1;
    chunkLeft[i] = clampSample(outLeft[sourceIndex] * gain);
    chunkRight[i] = clampSample(outRight[sourceIndex] * gain);
  }

  return { left: chunkLeft, right: chunkRight };
}

function buildModelInputChunk(sourceBuffer, start, frameSize, inputDims) {
  const channelCount = sourceBuffer.numberOfChannels;
  const available = Math.max(0, Math.min(frameSize, sourceBuffer.length - start));
  const left = sourceBuffer.getChannelData(0);
  const right = sourceBuffer.getChannelData(Math.min(1, channelCount - 1));

  if (inputDims.length === 2) {
    const mono = new Float32Array(frameSize);
    for (let i = 0; i < available; i += 1) {
      mono[i] = channelCount > 1 ? 0.5 * (left[start + i] + right[start + i]) : left[start + i];
    }
    return {
      tensor: new ort.Tensor("float32", mono, [1, frameSize]),
      validSamples: available,
      channels: 1
    };
  }

  const modelChannels = inputDims[1] || 2;
  const interleaved = new Float32Array(modelChannels * frameSize);
  for (let i = 0; i < available; i += 1) {
    const l = left[start + i];
    const r = right[start + i];
    if (modelChannels === 1) {
      interleaved[i] = channelCount > 1 ? 0.5 * (l + r) : l;
    } else {
      interleaved[i] = l;
      interleaved[frameSize + i] = r;
      for (let ch = 2; ch < modelChannels; ch += 1) {
        interleaved[ch * frameSize + i] = channelCount > 1 ? 0.5 * (l + r) : l;
      }
    }
  }

  return {
    tensor: new ort.Tensor("float32", interleaved, [1, modelChannels, frameSize]),
    validSamples: available,
    channels: modelChannels
  };
}

function getDefaultStemNames(count) {
  const defaults = ["vocals", "drums", "bass", "other", "piano", "guitar", "strings", "brass", "woodwinds", "synth"];
  const names = [];
  for (let i = 0; i < count; i += 1) {
    names.push(defaults[i] || `stem${i + 1}`);
  }
  return names;
}

function decodeModelOutput(outputTensor, frameSize) {
  const dims = outputTensor?.dims || [];
  const data = outputTensor?.data;
  if (!data) {
    throw new Error("AI stem model returned empty output");
  }

  // [batch, stems, channels, samples] => true multi-stem output.
  if (dims.length === 4) {
    const stems = Math.max(1, Number(dims[1]) || 1);
    const channels = Math.max(1, Number(dims[2]) || 1);
    const samples = Math.min(frameSize, Number(dims[3]) || frameSize);
    const names = getDefaultStemNames(stems);
    const stemData = {};
    const stemStride = channels * samples;

    for (let s = 0; s < stems; s += 1) {
      const left = new Float32Array(samples);
      const right = new Float32Array(samples);
      const stemBase = s * stemStride;
      for (let i = 0; i < samples; i += 1) {
        left[i] = data[stemBase + i] || 0;
        right[i] = channels > 1 ? data[stemBase + samples + i] || 0 : left[i];
      }
      stemData[names[s]] = { left, right };
    }

    return { kind: "multi", stemData };
  }

  // [batch, stems, samples] => treat as mono source-stem outputs when stems >= 3.
  if (dims.length === 3 && Number(dims[1]) >= 3) {
    const stems = Math.max(1, Number(dims[1]) || 1);
    const samples = Math.min(frameSize, Number(dims[2]) || frameSize);
    const names = getDefaultStemNames(stems);
    const stemData = {};

    for (let s = 0; s < stems; s += 1) {
      const left = new Float32Array(samples);
      const right = new Float32Array(samples);
      const stemBase = s * samples;
      for (let i = 0; i < samples; i += 1) {
        const v = data[stemBase + i] || 0;
        left[i] = v;
        right[i] = v;
      }
      stemData[names[s]] = { left, right };
    }

    return { kind: "multi", stemData };
  }

  // Single-output fallback: mono/stereo waveform.
  if (dims.length === 2) {
    const samples = Math.min(frameSize, dims[1] || frameSize);
    return {
      kind: "single",
      left: data.slice(0, samples),
      right: data.slice(0, samples)
    };
  }

  if (dims.length === 3) {
    const channels = dims[1] || 1;
    const samples = Math.min(frameSize, dims[2] || frameSize);
    const left = new Float32Array(samples);
    const right = new Float32Array(samples);
    for (let i = 0; i < samples; i += 1) {
      left[i] = data[i] || 0;
      right[i] = channels > 1 ? data[samples + i] || 0 : left[i];
    }
    return { kind: "single", left, right };
  }

  throw new Error(`Unsupported AI stem output shape (${dims.join("x") || "unknown"})`);
}

function clampSample(value) {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

function subtractBuffers(sourceBuffer, subtractBuffer) {
  const result = createEmptyBufferLike(sourceBuffer);
  for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch += 1) {
    const src = sourceBuffer.getChannelData(ch);
    const sub = subtractBuffer.getChannelData(Math.min(ch, subtractBuffer.numberOfChannels - 1));
    const out = result.getChannelData(ch);
    for (let i = 0; i < sourceBuffer.length; i += 1) {
      const subSample = Number.isFinite(sub[i]) ? sub[i] : 0;
      out[i] = clampSample(src[i] - subSample);
    }
  }
  return result;
}

async function generateAiModelStems(sourceBuffer) {
  const model = await ensureAiStemSession();
  const { session, inputName, outputName, inputDims, name } = model;

  const fixedFrameSize = inputDims.length === 3 ? inputDims[2] : inputDims[1];
  const frameSize = fixedFrameSize || 65536;
  const hopSize = fixedFrameSize ? Math.max(1024, Math.floor(frameSize * 0.5)) : frameSize;

  const accLeft = new Float32Array(sourceBuffer.length);
  const accRight = new Float32Array(sourceBuffer.length);
  const accWeight = new Float32Array(sourceBuffer.length);
  const multiStemAcc = {};
  let sawMultiStemOutput = false;

  for (let start = 0; start < sourceBuffer.length; start += hopSize) {
    const { tensor, validSamples } = buildModelInputChunk(sourceBuffer, start, frameSize, inputDims);
    const outputs = await session.run({ [inputName]: tensor });
    const parsed = decodeModelOutput(outputs[outputName], frameSize);
    const denom = Math.max(1, validSamples - 1);

    if (parsed.kind === "multi") {
      sawMultiStemOutput = true;
      for (const [stemName, chunk] of Object.entries(parsed.stemData)) {
        if (!multiStemAcc[stemName]) {
          multiStemAcc[stemName] = {
            left: new Float32Array(sourceBuffer.length),
            right: new Float32Array(sourceBuffer.length),
            weight: new Float32Array(sourceBuffer.length)
          };
        }
        const acc = multiStemAcc[stemName];

        for (let i = 0; i < validSamples; i += 1) {
          const outIndex = start + i;
          if (outIndex >= sourceBuffer.length) break;
          const w = validSamples <= 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
          acc.left[outIndex] += (chunk.left[i] || 0) * w;
          acc.right[outIndex] += (chunk.right[i] || 0) * w;
          acc.weight[outIndex] += w;
        }
      }
      continue;
    }

    for (let i = 0; i < validSamples; i += 1) {
      const outIndex = start + i;
      if (outIndex >= sourceBuffer.length) break;
      const w = validSamples <= 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
      accLeft[outIndex] += (parsed.left[i] || 0) * w;
      accRight[outIndex] += (parsed.right[i] || 0) * w;
      accWeight[outIndex] += w;
    }
  }

  if (sawMultiStemOutput) {
    const stemsByName = {};
    for (const [stemName, acc] of Object.entries(multiStemAcc)) {
      const stemBuffer = createEmptyBufferLike(sourceBuffer);
      const leftOut = stemBuffer.getChannelData(0);
      const rightOut = stemBuffer.getChannelData(Math.min(1, stemBuffer.numberOfChannels - 1));

      for (let i = 0; i < sourceBuffer.length; i += 1) {
        const gain = acc.weight[i] > 1e-6 ? 1 / acc.weight[i] : 1;
        const l = clampSample(acc.left[i] * gain);
        const r = clampSample(acc.right[i] * gain);
        leftOut[i] = l;
        rightOut[i] = r;
      }

      for (let ch = 2; ch < stemBuffer.numberOfChannels; ch += 1) {
        stemBuffer.getChannelData(ch).set(leftOut);
      }

      stemsByName[stemName] = stemBuffer;
    }

    console.log(`[Stems] Multi-stem output detected from model: ${name}`);
    return stemsByName;
  }

  const vocals = createEmptyBufferLike(sourceBuffer);
  for (let i = 0; i < sourceBuffer.length; i += 1) {
    const gain = accWeight[i] > 1e-6 ? 1 / accWeight[i] : 1;
    accLeft[i] = clampSample(accLeft[i] * gain);
    accRight[i] = clampSample(accRight[i] * gain);
  }

  for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch += 1) {
    const out = vocals.getChannelData(ch);
    const src = ch === 0 ? accLeft : accRight;
    out.set(src);
  }

  console.log(`[Stems] Single-output vocals generated with model: ${name}`);
  return { vocals };
}

async function generateAiAssistedStems() {
  const studioQuality = isStudioStemQualityEnabled();
  let kuielabError = null;
  try {
    const kuielabStems = await generateKuielabSourceStems(loadedAudioBuffer, { studioQuality });
    setSourceStemBuffers(kuielabStems);
    const vocals = kuielabStems.vocals || loadedAudioBuffer;
    const instrumental = subtractBuffers(loadedAudioBuffer, vocals);
    const [low, high] = await Promise.all([
      renderBandStemFromBuffer(instrumental, "low"),
      renderBandStemFromBuffer(instrumental, "high")
    ]);
    splitStemBuffers = { low, mid: vocals, high };
    return;
  } catch (error) {
    console.warn("[Stems] Kuielab 4-stem backend unavailable:", error);
    kuielabError = error;
  }

  if (kuielabError) {
    const message = kuielabError?.message || String(kuielabError);
    throw new Error(`Kuielab 4-stem backend failed: ${message}`);
  }

  const stemsByName = await generateAiModelStems(loadedAudioBuffer);

  if (stemsByName.drums || stemsByName.bass || stemsByName.other) {
    setSourceStemBuffers(stemsByName);
    const vocals = stemsByName.vocals || loadedAudioBuffer;
    const instrumental = subtractBuffers(loadedAudioBuffer, vocals);
    const [low, high] = await Promise.all([
      renderBandStemFromBuffer(instrumental, "low"),
      renderBandStemFromBuffer(instrumental, "high")
    ]);
    splitStemBuffers = { low, mid: vocals, high };
    return;
  }

  const vocals = stemsByName.vocals || loadedAudioBuffer;
  const instrumental = subtractBuffers(loadedAudioBuffer, vocals);

  const [low, high] = await Promise.all([
    renderBandStemFromBuffer(instrumental, "low"),
    renderBandStemFromBuffer(instrumental, "high")
  ]);

  // Keep the center stem strongly vocal-focused for easy mute/solo behavior.
  const mid = vocals;
  splitStemBuffers = { low, mid, high };
  setSourceStemBuffers({ vocals, accompaniment: instrumental });
}

async function generateStems() {
  if (!loadedAudioBuffer) {
    setStemStatus("load audio first");
    return;
  }

  const abortController = new AbortController();
  stemGenerationAbortController = abortController;
  const { signal } = abortController;

  try {
    if (!companionEngineAvailable) {
      const connected = await checkCompanionEngine({ silent: false });
      if (!connected) {
        throw new Error("Pro engine not detected. Install and start the companion app, then click Check Pro Engine.");
      }
    }

    setStemBusy(true);
    setStemProgress(0, "Starting stem generation...");
    setStemStatus("Hybrid split in progress (AI vocals + pro drums/bass/other)...");
    setSourceStemStatus("generating vocals with vocal isolation AI + splitting drums/bass/other...");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Track per-task progress and update the combined bar in real time.
    // Kuielab (vocal AI) = first 60% of the bar; companion server = last 40%.
    let kuielabFraction = 0; // 0.0 – 1.0
    let companionDone = false;

    const refreshProgress = () => {
      const combined = kuielabFraction * 60 + (companionDone ? 40 : 0);
      const vocalPct = Math.round(kuielabFraction * 100);
      const instrLabel = companionDone ? "done" : "processing";
      setStemProgress(combined, `Vocals AI: ${vocalPct}% · Instruments: ${instrLabel}`);
    };

    const companionPromise = requestCompanionStems(
      loadedAudioBuffer, ["drums", "bass", "other"], { signal }
    ).then((result) => { companionDone = true; refreshProgress(); return result; });

    const kuielabPromise = requestKuielabVocalIsolation(loadedAudioBuffer, {
      signal,
      onProgress: (fraction) => { kuielabFraction = fraction; refreshProgress(); }
    });

    const [bandStems, isolatedVocals] = await Promise.all([companionPromise, kuielabPromise]);

    setStemProgress(95, "Finalising stems...");
    const stemsByName = {
      ...bandStems,
      vocals: isolatedVocals
    };
    setSourceStemBuffers(stemsByName);

    const vocals = isolatedVocals || loadedAudioBuffer;
    const instrumental = subtractBuffers(loadedAudioBuffer, vocals);
    const [low, high] = await Promise.all([
      renderBandStemFromBuffer(instrumental, "low"),
      renderBandStemFromBuffer(instrumental, "high")
    ]);
    splitStemBuffers = { low, mid: vocals, high };

    activateStemMixPlayback();
    const stemNames = sourceStemBuffers ? Object.keys(sourceStemBuffers) : [];
    const hasCoreFour = ["vocals", "drums", "bass", "other"].every((name) => stemNames.includes(name));
    if (hasCoreFour) {
      setStemStatus("ready: pro-quality source stems available (vocals, drums, bass, other)");
    } else {
      setStemStatus("partial pro result: missing one or more core stems from engine response");
    }
  } catch (error) {
    if (signal.aborted) {
      setStemStatus("stem generation cancelled");
      setSourceStemStatus("cancelled");
    } else {
      console.error("[Stems] Pro engine split failed:", error);
      setSourceStemStatus("failed - companion unavailable or returned an error");
      setStemStatus(String(error?.message || error));
    }
  } finally {
    stemGenerationAbortController = null;
    setStemBusy(false);
    setStemProgress(null, "");
    updateLoadedAudioButtons();
  }
}

function audioBufferToWavBlob(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frameCount = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeAscii(offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < channelCount; c += 1) {
    channels.push(audioBuffer.getChannelData(c));
  }

  let offset = 44;
  for (let i = 0; i < frameCount; i += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

async function downloadWav() {
  if (!lastRecordingBlob) {
    setRecordingStatus("nothing to download yet");
    return;
  }

  try {
    setRecordingStatus("preparing wav...");
    const decodedBuffer = await decodeLastRecordingBuffer();
    if (!decodedBuffer) {
      setRecordingStatus("unable to decode recording");
      return;
    }

    const wavBlob = audioBufferToWavBlob(decodedBuffer);
    const success = await triggerBlobDownload(wavBlob, "wav");
    setRecordingStatus(success ? "downloaded wav recording" : "wav download failed");
  } catch (error) {
    console.error("[Audio Mixer] WAV export failed", error);
    setRecordingStatus("wav export failed");
  }
}

async function downloadMp3() {
  if (!lastRecordingBlob) {
    setRecordingStatus("nothing to download yet");
    return;
  }

  const isMp3 =
    lastRecordingBlob.type.includes("audio/mpeg") ||
    lastRecordingBlob.type.includes("audio/mp3");

  if (isMp3) {
    const success = await triggerBlobDownload(lastRecordingBlob, "mp3");
    setRecordingStatus(success ? "downloaded mp3 recording" : "mp3 download failed");
    return;
  }

  setRecordingStatus("mp3 export unavailable in this browser, use wav");
}

function stopLoadedAudio(options = {}) {
  const { silent = false, preserveSession = false } = options;

  if (!recordedAudioIsPlaying && !recordedAudioIsPaused && !filePlaybackSource) {
    return;
  }

  // Invalidate any in-flight async start request unless caller is replacing source in same session.
  if (!preserveSession) {
    playbackSessionId += 1;
  }

  try {
    if (filePlaybackSource) {
      filePlaybackSource.onended = null;
      filePlaybackSource.stop();
      filePlaybackSource.disconnect();
      filePlaybackSource = null;
    }
    if (filePlaybackDirectMonitorNode) {
      try {
        filePlaybackDirectMonitorNode.disconnect();
      } catch {
        // ignore
      }
      filePlaybackDirectMonitorNode = null;
    }
  } catch (error) {
    console.error("[Popup] Error stopping:", error);
  }

  recordedAudioIsPlaying = false;
  recordedAudioIsPaused = false;
  filePlaybackStartTime = null;
  filePlaybackStartOffsetSeconds = 0;
  filePlaybackRate = 1;
  stopWaveformAnimation();
  updateLoadedAudioButtons();
  if (!silent) {
    setLoadedStatus("stopped");
  }
}

function updateLoadedPlaybackRate() {
  if (!filePlaybackSource || !audioContext) {
    return;
  }

  const targetRate = getLoadedPlaybackRate();
  if (recordedAudioIsPlaying && filePlaybackStartTime !== null) {
    const elapsed = audioContext.currentTime - filePlaybackStartTime;
    const currentPos = filePlaybackStartOffsetSeconds + elapsed * filePlaybackRate;
    filePlaybackStartOffsetSeconds = Math.max(trimStartSeconds, Math.min(trimEndSeconds, currentPos));
    filePlaybackStartTime = audioContext.currentTime;
    filePlaybackRate = targetRate;
  }
  filePlaybackSource.playbackRate.setValueAtTime(targetRate, audioContext.currentTime);
}

async function startLoadedAudioPlayback(options = {}) {
  const { seekTime = null, forceStemMix = null } = options;
  console.log("[Popup] startLoadedAudioPlayback called, buffer exists:", !!loadedAudioBuffer);

  if (!loadedAudioBuffer) {
    setLoadedStatus("load an audio file first");
    return;
  }

  const stemMixRequested = typeof forceStemMix === "boolean"
    ? forceStemMix
    : useStemMixPlaybackInput.checked;
  const stemMixEnabled = stemMixRequested && (Boolean(splitStemBuffers) || Boolean(sourceStemBuffers));
  console.log("[PlaybackDebug] mode-select", {
    seekTime,
    forceStemMix,
    stemMixRequested,
    stemMixEnabled,
    hasSplitStems: Boolean(splitStemBuffers),
    hasSourceStems: Boolean(sourceStemBuffers)
  });

  let playbackBuffer;
  try {
    playbackBuffer = stemMixEnabled ? buildStemMixBuffer() : loadedAudioBuffer;
    console.log("[PlaybackDebug] buffer-selected", {
      duration: playbackBuffer?.duration,
      length: playbackBuffer?.length,
      sampleRate: playbackBuffer?.sampleRate,
      channels: playbackBuffer?.numberOfChannels
    });
  } catch (error) {
    console.error("[Popup] Failed to build playback buffer:", error);
    setLoadedStatus(`playback setup failed: ${error?.message || error}`);
    return;
  }

  // Wavetable/stem audition playback should be neutral by default.
  // This avoids accidental speed/pitch carryover from global transport controls.
  const playbackRateOverride = 1;
  const pitchSemitonesOverride = 0;

  await startAudioBufferPlayback(playbackBuffer, {
    seekTime,
    stemMixEnabled,
    playbackRateOverride,
    pitchSemitonesOverride
  });
}

async function safeStartLoadedAudioPlayback(options = {}, source = "loaded") {
  try {
    await startLoadedAudioPlayback(options);
  } catch (error) {
    console.error("[Popup] Playback failed:", error);
    setLoadedStatus(`playback failed: ${error?.message || error}`);
    if (source === "stem") {
      setSourceStemStatus("stem playback failed (see console)");
    }
    recordedAudioIsPlaying = false;
    recordedAudioIsPaused = false;
    updateLoadedAudioButtons();
  }
}

async function startAudioBufferPlayback(playbackBuffer, options = {}) {
  const {
    seekTime = null,
    stemMixEnabled = false,
    playbackRateOverride = null,
    pitchSemitonesOverride = null
  } = options;
  console.log("[PlaybackDebug] startAudioBufferPlayback-enter", {
    seekTime,
    stemMixEnabled,
    playbackRateOverride,
    pitchSemitonesOverride,
    hasPlaybackBuffer: Boolean(playbackBuffer),
    contextState: audioContext?.state || "none",
    hasInputMixNode: Boolean(inputMixNode),
    hasOutputGainNode: Boolean(outputGainNode)
  });

  if (!playbackBuffer) {
    setLoadedStatus(stemMixEnabled ? "unable to build stem mix" : "load an audio file first");
    return;
  }

  // Defensive trim init: if the waveform section has not initialized trim yet,
  // default to full buffer so Play always starts audible output.
  if (!Number.isFinite(trimEndSeconds) || trimEndSeconds <= 0) {
    trimStartSeconds = 0;
    trimEndSeconds = playbackBuffer.duration;
  }
  if (!Number.isFinite(trimStartSeconds) || trimStartSeconds < 0) {
    trimStartSeconds = 0;
  }
  if (trimStartSeconds >= trimEndSeconds) {
    trimStartSeconds = 0;
    trimEndSeconds = playbackBuffer.duration;
  }

  const currentSessionId = playbackSessionId + 1;
  playbackSessionId = currentSessionId;

  // Initialize/recover audio playback graph if needed.
  // This guards against stale partial graph state after stem processing,
  // capture teardown, or mode transitions.
  const graphMissing = !inputMixNode || !bassNode || !dryGainNode || !outputGainNode;
  if (!audioContext || graphMissing || audioContext.state === "closed") {
    if (audioContext && audioContext.state !== "closed") {
      try {
        await audioContext.close();
      } catch (_error) {
        // ignore close failures and recreate anyway
      }
    }

    console.log("[Popup] Creating new AudioContext");
    audioContext = new AudioContext();
    const fx = createFxGraph(audioContext);
    inputMixNode = fx.inputMixNode;
    bassNode = fx.bassNode;
    preGainNode = fx.preGainNode;
    dryGainNode = fx.dryGainNode;
    wetGainNode = fx.wetGainNode;
    distortionNode = fx.distortionNode;
    convolverNode = fx.convolverNode;
    reverbGainNode = fx.reverbGainNode;
    chorusDelayNode = fx.chorusDelayNode;
    chorusWetGainNode = fx.chorusWetGainNode;
    chorusLfoNode = fx.chorusLfoNode;
    chorusLfoGainNode = fx.chorusLfoGainNode;
    delayNode = fx.delayNode;
    delayFeedbackNode = fx.delayFeedbackNode;
    delayFilterNode = fx.delayFilterNode;
    delayWetGainNode = fx.delayWetGainNode;
    pitchShifterNode = fx.pitchShifterNode;
    stretchNode = null;
    ringModCarrierNode = fx.ringModCarrierNode;
    ringModGainNode = fx.ringModGainNode;
    outputGainNode = fx.outputGainNode;
    outputGainNode.connect(audioContext.destination);
    outputDestinationConnected = true;
    // Keep loaded-audio playback path deterministic and race-free on reopen.
    // Signalsmith Stretch is not inserted asynchronously here.
    console.log("[Popup] AudioContext and graph created");
  }

  if (audioContext.state === "suspended") {
    console.log("[Popup] Resuming suspended AudioContext");
    await audioContext.resume();
  }
  console.log("[PlaybackDebug] context-ready", {
    state: audioContext?.state,
    outputDestinationConnected
  });

  // Recovery guard: other modes (e.g. prepared instrumental pass) can
  // disconnect output destination. Always reconnect before file/stem playback.
  connectOutputDestination();

  if (currentSessionId !== playbackSessionId) {
    return;
  }

  stopLoadedAudio({ silent: true, preserveSession: true });

  // Respect trim boundaries
  const requestedOffset = seekTime ?? trimStartSeconds;
  const offset = Math.max(trimStartSeconds, Math.min(trimEndSeconds - 0.001, requestedOffset));
  const duration = trimEndSeconds - offset;
  console.log("[PlaybackDebug] timing", {
    trimStartSeconds,
    trimEndSeconds,
    requestedOffset,
    offset,
    duration
  });

  if (duration <= 0) {
    setLoadedStatus("invalid trim (start >= end)");
    return;
  }

  if (currentSessionId !== playbackSessionId) {
    return;
  }

  console.log("[Popup] Starting playback - offset:", offset, "duration:", duration);
  const source = audioContext.createBufferSource();
  source.buffer = playbackBuffer;
  const resolvedPlaybackRate = Number.isFinite(playbackRateOverride)
    ? playbackRateOverride
    : getLoadedPlaybackRate();
  filePlaybackRate = resolvedPlaybackRate;
  source.playbackRate.value = filePlaybackRate;
  source.connect(inputMixNode);

  // DO NOT add a direct monitor path for file/stem playback.
  // File playback should ALWAYS go through the effects chain (inputMixNode).
  // The direct monitor fallback is only for live capture routing (inputSourceNode).
  // Having both connections creates double-volume overlap/distortion.
  
  // Clean up any stale direct monitor from previous playback
  if (filePlaybackDirectMonitorNode) {
    try {
      filePlaybackDirectMonitorNode.disconnect();
    } catch {
      // ignore
    }
    filePlaybackDirectMonitorNode = null;
  }

  if (stretchNode) {
    const semitones = Number.isFinite(pitchSemitonesOverride)
      ? pitchSemitonesOverride
      : getEffectivePitchSemitones();
    stretchNode.schedule({ semitones });
  }

  source.onended = () => {
    if (filePlaybackSource !== source) {
      return;
    }

    console.log("[Popup] Playback ended");
    recordedAudioIsPlaying = false;
    recordedAudioIsPaused = false;
    filePlaybackSource = null;
    if (filePlaybackDirectMonitorNode) {
      try {
        filePlaybackDirectMonitorNode.disconnect();
      } catch {
        // ignore
      }
      filePlaybackDirectMonitorNode = null;
    }
    currentPlaybackSeconds = trimEndSeconds;
    updateLoadedAudioButtons();
    setLoadedStatus("playback finished");
    stopWaveformAnimation();
    updateWaveformDisplay();
  };

  filePlaybackSource = source;
  try {
    source.start(0, offset, duration);
    console.log("[PlaybackDebug] source-start-ok", { offset, duration });
  } catch (error) {
    console.error("[PlaybackDebug] source-start-failed", error);
    throw error;
  }
  filePlaybackStartTime = audioContext.currentTime;
  filePlaybackStartOffsetSeconds = offset;
  currentPlaybackSeconds = offset;
  lastLoadedPlaybackUsedStemMix = stemMixEnabled;
  recordedAudioIsPlaying = true;
  recordedAudioIsPaused = false;
  console.log("[Popup] Playback started at audioContext time:", filePlaybackStartTime);
  startWaveformAnimation();
  updateLoadedAudioButtons();
  setLoadedStatus(
    stemMixEnabled
      ? `playing stem mix ${duration.toFixed(2)}s @ ${filePlaybackRate.toFixed(2)}x`
      : `playing ${duration.toFixed(2)}s segment @ ${filePlaybackRate.toFixed(2)}x`
  );
  applyFilterValues();
}

function pauseRecordedAudio() {
  if (!recordedAudioIsPlaying) {
    return;
  }

  try {
    if (filePlaybackSource && typeof filePlaybackSource.pause === 'function') {
      filePlaybackSource.pause();
    } else if (filePlaybackSource) {
      // Fallback: stop the source if pause is not available
      filePlaybackSource.stop();
      filePlaybackSource.disconnect();
      filePlaybackSource = null;
    }
  } catch (error) {
    console.error("[Popup] Error pausing source:", error);
  }

  recordedAudioIsPlaying = false;
  recordedAudioIsPaused = true;
  stopWaveformAnimation();
  updateLoadedAudioButtons();
  setLoadedStatus("paused");
}

function resumeRecordedAudio() {
  if (!recordedAudioIsPaused || !loadedAudioBuffer) return;

  recordedAudioIsPaused = false;
  startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds, forceStemMix: lastLoadedPlaybackUsedStemMix });
}

async function loadBlobAsAudio(blob, label) {
  console.log("[Popup] loadBlobAsAudio called with label:", label, "blob size:", blob.size);
  try {
    stopLoadedAudio({ silent: true });
    loadedAudioBuffer = await decodeBlobToAudioBuffer(blob);
    splitStemBuffers = null;
    setSourceStemBuffers(null);
    setStemStatus("not generated");
    console.log("[Popup] Audio decoded successfully, duration:", loadedAudioBuffer.duration.toFixed(2));
    setLoadedStatus(`${label} (${loadedAudioBuffer.duration.toFixed(1)}s)`);
    showWaveformEditor();
    updateLoadedAudioButtons();
    await persistSessionCacheToIndexedDbNow();
    scheduleSessionCacheSync();
  } catch (error) {
    console.error("[Audio Mixer] Failed to decode loaded audio", error);
    setLoadedStatus("failed to decode audio");
  }
}

async function loadLastRecordingAsAudio() {
  if (!lastRecordingBlob) {
    setLoadedStatus("no recorded clip available");
    return;
  }

  await loadBlobAsAudio(lastRecordingBlob, "last recording loaded");
}

async function downloadProcessedLoadedAudioWav() {
  if (!loadedAudioBuffer) {
    setLoadedStatus("load audio before exporting");
    return;
  }

  try {
    setLoadedStatus("rendering processed wav...");

    const sourceRate = loadedAudioBuffer.sampleRate;
    const sourceChannels = loadedAudioBuffer.numberOfChannels;
    const playbackRate = getCombinedPlaybackRate();
    
    // Calculate trimmed duration and frame count
    const trimmedDuration = Math.max(0, trimEndSeconds - trimStartSeconds);
    if (trimmedDuration <= 0) {
      setLoadedStatus("invalid trim (start >= end)");
      return;
    }
    
    const outputFrameCount = Math.max(1, Math.ceil((trimmedDuration * sourceRate) / playbackRate));
    const offlineContext = new OfflineAudioContext(sourceChannels, outputFrameCount, sourceRate);

    const fx = createFxGraph(offlineContext);
    fx.outputGainNode.connect(offlineContext.destination);

    const filterStrength = Number(effectMixInput.value);
    const interpolated = activeFilterPreset ? getInterpolatedFilterSettings(activeFilterPreset, filterStrength) : null;

    fx.preGainNode.gain.value = 1;
    fx.outputGainNode.gain.value = interpolated ? interpolated.volume : Number(volumeInput.value);
    fx.dryGainNode.gain.value = 0;
    fx.wetGainNode.gain.value = 1;

    const offlineFilterType = interpolated ? interpolated.eqType : currentFilterType;
    fx.bassNode.type = offlineFilterType;
    fx.bassNode.frequency.value = interpolated ? interpolated.eqFrequency : fx.bassNode.frequency.value;
    fx.bassNode.Q.value = interpolated ? interpolated.eqQ : fx.bassNode.Q.value;
    if (offlineFilterType === "lowshelf" || offlineFilterType === "highshelf") {
      fx.bassNode.gain.value = interpolated ? interpolated.bass : Number(bassInput.value);
    } else if (offlineFilterType === "peaking") {
      fx.bassNode.gain.value = interpolated ? interpolated.eqGain : fx.bassNode.gain.value;
    }

    const reverbType = reverbTypeInput.value;
    const reverbSize = Number(reverbSizeInput.value);
    const reverbTone = Number(reverbToneInput.value);
    const reverbProfile = getReverbStyleProfile(reverbType);
    const reverbSeconds = Math.max(0.4, reverbSize);
    const reverbDecay = Math.max(1.2, reverbProfile.decay + reverbSize * 0.35);
    fx.convolverNode.buffer = generateImpulseResponse(offlineContext, reverbSeconds, reverbDecay, reverbTone * reverbProfile.highDamp);

    fx.reverbGainNode.gain.value = reverbEnable.checked ? (interpolated ? interpolated.reverb : Number(reverbInput.value)) : 0;

    const chorusProfiles = {
      classic: { rateMul: 1.0, depthMul: 1.0, baseDelay: 0.015 },
      ensemble: { rateMul: 0.65, depthMul: 1.5, baseDelay: 0.02 },
      vibrato: { rateMul: 1.35, depthMul: 1.2, baseDelay: 0.01 },
      dimension: { rateMul: 0.8, depthMul: 1.8, baseDelay: 0.022 }
    };
    const chorusType = chorusTypeInput.value;
    const chorusProfile = chorusProfiles[chorusType] || chorusProfiles.classic;
    const chorusWidth = Number(chorusWidthInput.value);
    const chorusDepth = interpolated ? interpolated.chorusDepth : Number(chorusDepthInput.value);
    fx.chorusWetGainNode.gain.value = chorusEnable.checked ? (interpolated ? interpolated.chorusMix : Number(chorusMixInput.value)) : 0;
    fx.chorusLfoNode.frequency.value = (interpolated ? interpolated.chorusRate : Number(chorusRateInput.value)) * chorusProfile.rateMul;
    fx.chorusLfoGainNode.gain.value = chorusDepth * chorusProfile.depthMul * (0.25 + chorusWidth * 1.75);
    fx.chorusDelayNode.delayTime.value = chorusProfile.baseDelay;

    const delayProfiles = {
      digital: { feedbackMul: 1.0, lowpassHz: 18000 },
      tape: { feedbackMul: 0.85, lowpassHz: 4200 },
      slap: { feedbackMul: 0.55, lowpassHz: 9500 }
    };
    const delayType = delayTypeInput.value;
    const delayProfile = delayProfiles[delayType] || delayProfiles.digital;
    const delayTime = Number(delayTimeInput.value);
    const delayFeedback = Number(delayFeedbackInput.value);
    fx.delayNode.delayTime.value = delayType === "slap" ? Math.min(delayTime, 0.16) : delayTime;
    fx.delayFeedbackNode.gain.value = Math.min(0.95, delayFeedback * delayProfile.feedbackMul);
    fx.delayFilterNode.frequency.value = delayProfile.lowpassHz;
    fx.delayWetGainNode.gain.value = delayEnable.checked ? Number(delayMixInput.value) : 0;

    fx.ringModCarrierNode.frequency.value = interpolated ? interpolated.ringModFreq : fx.ringModCarrierNode.frequency.value;
    fx.ringModGainNode.gain.value = interpolated ? interpolated.ringModMix : fx.ringModGainNode.gain.value;

    const distAmount = distortionEnable.checked ? (interpolated ? interpolated.distortion : Number(distortionInput.value)) : 0;
    fx.distortionNode.curve = distAmount > 0 ? makeDistortionCurve(distAmount) : null;

    const source = offlineContext.createBufferSource();
    source.buffer = loadedAudioBuffer;
    source.playbackRate.value = playbackRate;
    source.connect(fx.inputMixNode);
    // Start at trimStart offset and only render the trimmed duration
    source.start(0, trimStartSeconds, trimmedDuration);

    const renderedBuffer = await offlineContext.startRendering();
    const wavBlob = audioBufferToWavBlob(renderedBuffer);
    const success = await triggerBlobDownload(wavBlob, "wav");
    setLoadedStatus(success ? "downloaded processed wav" : "processed wav download failed");
  } catch (error) {
    console.error("[Audio Mixer] Processed WAV export failed", error);
    setLoadedStatus("processed wav export failed");
  }
}

// ============= WAVEFORM VISUALIZER & TRIMMING =============

function drawWaveformOnCanvas(targetCanvas) {
  if (!targetCanvas || !loadedAudioBuffer) {
    return;
  }

  const canvasWidth = targetCanvas.offsetWidth;
  const canvasHeight = targetCanvas.offsetHeight;
  if (!canvasWidth || !canvasHeight) {
    // Canvas is in a hidden container - skip silently.
    // applyUiTab schedules a redraw when the section becomes visible again.
    return;
  }

  targetCanvas.width = canvasWidth * window.devicePixelRatio;
  targetCanvas.height = canvasHeight * window.devicePixelRatio;

  const ctx = targetCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const data = loadedAudioBuffer.getChannelData(0);
  const totalDuration = loadedAudioBuffer.duration;
  const amp = canvasHeight / 2;

  // Calculate visible time range based on zoom and scroll
  const visibleDuration = totalDuration / waveformZoom;
  const timeStart = Math.max(0, waveformScrollOffset);
  const timeEnd = Math.min(totalDuration, timeStart + visibleDuration);

  // Draw background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Draw center line
  ctx.strokeStyle = "#e0e0e0";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(0, amp);
  ctx.lineTo(canvasWidth, amp);
  ctx.stroke();
  ctx.setLineDash([]);

  // Calculate samples for visible range
  const sampleStart = Math.floor((timeStart / totalDuration) * data.length);
  const sampleEnd = Math.floor((timeEnd / totalDuration) * data.length);
  const samplesPerPixel = (sampleEnd - sampleStart) / canvasWidth;

  // Draw waveform for visible range
  ctx.strokeStyle = "#1f88e5";
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let i = 0; i < canvasWidth; i++) {
    let min = 1.0;
    let max = -1.0;

    const pixelSampleStart = Math.floor(sampleStart + i * samplesPerPixel);
    const pixelSampleEnd = Math.floor(sampleStart + (i + 1) * samplesPerPixel);

    for (let j = pixelSampleStart; j < pixelSampleEnd && j < data.length; j++) {
      const datum = data[j];
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }

    const yMin = amp + (min * amp);
    const yMax = amp + (max * amp);
    if (i === 0) {
      ctx.moveTo(i, yMin);
    }
    ctx.lineTo(i, yMin);
    ctx.lineTo(i, yMax);
  }
  ctx.stroke();

  // Draw trim boundaries if they're within visible range
  const trimStartX = ((trimStartSeconds - timeStart) / visibleDuration) * canvasWidth;
  const trimEndX = ((trimEndSeconds - timeStart) / visibleDuration) * canvasWidth;

  // Draw dim areas for trimmed-out regions (if visible)
  ctx.fillStyle = "rgba(200, 200, 200, 0.3)";
  if (trimStartX > 0) {
    ctx.fillRect(0, 0, Math.max(0, trimStartX), canvasHeight);
  }
  if (trimEndX < canvasWidth) {
    ctx.fillRect(trimEndX, 0, canvasWidth - trimEndX, canvasHeight);
  }

  // Draw trim boundary lines
  if (trimStartX >= 0 && trimStartX <= canvasWidth) {
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(trimStartX, 0);
    ctx.lineTo(trimStartX, canvasHeight);
    ctx.stroke();
  }

  if (trimEndX >= 0 && trimEndX <= canvasWidth) {
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(trimEndX, 0);
    ctx.lineTo(trimEndX, canvasHeight);
    ctx.stroke();
  }

  // Draw current playback position (always visible and synced to scrubber)
  if (currentPlaybackSeconds >= timeStart && currentPlaybackSeconds <= timeEnd) {
    const playbackX = ((currentPlaybackSeconds - timeStart) / visibleDuration) * canvasWidth;
    ctx.strokeStyle = recordedAudioIsPlaying ? "#0b8f63" : "rgba(11, 143, 99, 0.65)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playbackX, 0);
    ctx.lineTo(playbackX, canvasHeight);
    ctx.stroke();
  }
}

function drawWaveform() {
  if (!loadedAudioBuffer) {
    return;
  }
  drawWaveformOnCanvas(waveformCanvas);
  drawWaveformOnCanvas(stemWaveformCanvas);
}

function updateWaveformDisplay() {
  if (!loadedAudioBuffer) return;

  const totalDuration = loadedAudioBuffer.duration;
  totalDurationEl.textContent = totalDuration.toFixed(2);
  midpointLabel.textContent = `${(totalDuration / 2).toFixed(2)}s`;
  endLabel.textContent = `${totalDuration.toFixed(2)}s`;
  scrubberInput.max = String(totalDuration);
  scrubberInput.value = String(Math.max(0, Math.min(totalDuration, currentPlaybackSeconds || trimStartSeconds)));
  currentPlaybackTimeEl.textContent = (currentPlaybackSeconds || trimStartSeconds).toFixed(2);
  const trimmedDuration = Math.max(0, trimEndSeconds - trimStartSeconds);
  trimmedDurationEl.textContent = `Duration: ${trimmedDuration.toFixed(2)}s`;
  if (stemScrubberInput) {
    stemScrubberInput.max = String(totalDuration);
    stemScrubberInput.value = scrubberInput.value;
  }
  if (stemTotalDurationEl) {
    stemTotalDurationEl.textContent = totalDuration.toFixed(2);
  }
  if (stemCurrentPlaybackTimeEl) {
    stemCurrentPlaybackTimeEl.textContent = currentPlaybackTimeEl.textContent;
  }
  if (stemTrimmedDurationEl) {
    stemTrimmedDurationEl.textContent = `Duration: ${trimmedDuration.toFixed(2)}s`;
  }

  drawWaveform();
}

function getPlaybackStartFromCurrentPosition() {
  const maxStart = Math.max(trimStartSeconds, trimEndSeconds - 0.001);
  const clampedCurrent = Math.max(trimStartSeconds, Math.min(maxStart, currentPlaybackSeconds));

  // If already at the end boundary, restart from trim start.
  if (clampedCurrent >= trimEndSeconds - 0.001) {
    return trimStartSeconds;
  }

  return clampedCurrent;
}

function playLoadedAudioFromCurrentPosition() {
  console.log("[PlaybackDebug] click-main-play", {
    hasLoadedAudio: Boolean(loadedAudioBuffer),
    isPlaying: recordedAudioIsPlaying,
    isPaused: recordedAudioIsPaused,
    hasFileSource: Boolean(filePlaybackSource),
    stemMixToggle: Boolean(useStemMixPlaybackInput?.checked)
  });

  if (recordedAudioIsPlaying && !filePlaybackSource) {
    recordedAudioIsPlaying = false;
  }

  const startAt = getPlaybackStartFromCurrentPosition();
  if (recordedAudioIsPaused) {
    recordedAudioIsPaused = false;
  }
  // Main wavetable play always auditions the raw loaded track.
  safeStartLoadedAudioPlayback({ seekTime: startAt, forceStemMix: false }, "loaded");
}

function playStemMixFromCurrentPosition() {
  console.log("[PlaybackDebug] click-stem-play", {
    hasLoadedAudio: Boolean(loadedAudioBuffer),
    hasSplitStems: Boolean(splitStemBuffers),
    hasSourceStems: Boolean(sourceStemBuffers),
    stemMixToggleBefore: Boolean(useStemMixPlaybackInput?.checked)
  });

  if (!loadedAudioBuffer) {
    setSourceStemStatus("load audio first");
    return;
  }

  if (!splitStemBuffers && !sourceStemBuffers) {
    setSourceStemStatus("generate stems first");
    return;
  }

  ensureStemMixPlaybackEnabled();
  const startAt = getPlaybackStartFromCurrentPosition();
  safeStartLoadedAudioPlayback({ seekTime: startAt, forceStemMix: true }, "stem");
  setSourceStemStatus("auditioning current stem mix");
}

function getClampedPlaybackSeekTime(rawSeekTime) {
  const minStart = Number.isFinite(trimStartSeconds) ? trimStartSeconds : 0;
  const maxEnd = Number.isFinite(trimEndSeconds)
    ? trimEndSeconds
    : (loadedAudioBuffer?.duration || minStart);
  const safeMax = Math.max(minStart, maxEnd - 0.001);
  return Math.max(minStart, Math.min(safeMax, rawSeekTime));
}

function seekLoadedAudioToTime(targetTime, forceStemMix = null) {
  if (!loadedAudioBuffer) {
    return;
  }

  const clamped = getClampedPlaybackSeekTime(Number(targetTime) || 0);
  currentPlaybackSeconds = clamped;
  scrubberInput.value = String(clamped);
  if (stemScrubberInput) {
    stemScrubberInput.value = String(clamped);
  }
  updateWaveformDisplay();
  scheduleSessionCacheSync();

  if (recordedAudioIsPlaying) {
    safeStartLoadedAudioPlayback({ seekTime: clamped, forceStemMix }, "loaded");
    return;
  }

  if (recordedAudioIsPaused) {
    setLoadedStatus(`paused @ ${clamped.toFixed(2)}s`);
  }
}

function skipLoadedAudioBy(deltaSeconds, forceStemMix = null) {
  const base = Number.isFinite(currentPlaybackSeconds) ? currentPlaybackSeconds : trimStartSeconds;
  seekLoadedAudioToTime(base + deltaSeconds, forceStemMix);
}

function replayLoadedAudioFromTrimStart(forceStemMix = null) {
  seekLoadedAudioToTime(trimStartSeconds, forceStemMix);
}

function handleCanvasClick(event, targetCanvas = waveformCanvas) {
  if (!loadedAudioBuffer) return;

  const totalDuration = loadedAudioBuffer.duration;
  const rect = targetCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const ratio = x / rect.width;

  // Account for zoom and scroll offset
  const visibleDuration = totalDuration / waveformZoom;
  const seekTime = waveformScrollOffset + (ratio * visibleDuration);

  // Clamp to trim boundaries
  const clampedTime = Math.max(trimStartSeconds, Math.min(trimEndSeconds, seekTime));

  // Seek and play from clicked position without mutating trim boundaries.
  startLoadedAudioPlayback({ seekTime: clampedTime });

  setLoadedStatus(`scrubbed to ${clampedTime.toFixed(2)}s`);
  updateWaveformDisplay();
}

function handleCanvasScroll(event) {
  if (!loadedAudioBuffer) return;

  event.preventDefault();
  
  const totalDuration = loadedAudioBuffer.duration;
  const visibleDuration = totalDuration / waveformZoom;
  
  // Scroll direction: negative deltaY = scroll up = zoom in
  const zoomSpeed = 0.1;
  const direction = event.deltaY > 0 ? -1 : 1; // Invert for intuitive zoom
  
  const newZoom = Math.max(1, Math.min(16, waveformZoom + direction * zoomSpeed * waveformZoom));
  const zoomRatio = newZoom / waveformZoom;
  
  // Keep center of view in same place when zooming
  const centerTime = waveformScrollOffset + visibleDuration / 2;
  const newVisibleDuration = totalDuration / newZoom;
  waveformScrollOffset = Math.max(0, Math.min(totalDuration - newVisibleDuration, centerTime - newVisibleDuration / 2));
  waveformZoom = newZoom;

  updateWaveformDisplay();
}

function animatePlayback() {
  if (recordedAudioIsPlaying && filePlaybackSource && audioContext) {
    const elapsedTime = audioContext.currentTime - (filePlaybackStartTime || audioContext.currentTime);
    const currentPosition = filePlaybackStartOffsetSeconds + elapsedTime * filePlaybackRate;
    
    // Check if playback has gone past the trim end
    if (currentPosition >= trimEndSeconds) {
      // Playback finished naturally
      console.log("[Popup] Playback position reached trim end");
      recordedAudioIsPlaying = false;
      recordedAudioIsPaused = false;
      filePlaybackSource = null;
      currentPlaybackSeconds = trimEndSeconds;
      updateLoadedAudioButtons();
      setLoadedStatus("playback finished");
      stopWaveformAnimation();
      updateWaveformDisplay();
      return;
    } else {
      currentPlaybackSeconds = currentPosition;
      currentPlaybackTimeEl.textContent = currentPosition.toFixed(2);
      if (stemCurrentPlaybackTimeEl) {
        stemCurrentPlaybackTimeEl.textContent = currentPlaybackTimeEl.textContent;
      }
      if (loadedAudioBuffer) {
        const clamped = Math.max(0, Math.min(loadedAudioBuffer.duration, currentPosition));
        scrubberInput.value = String(clamped);
        if (stemScrubberInput) {
          stemScrubberInput.value = String(clamped);
        }
      }
      drawWaveform();
    }
  }
  animationFrameId = requestAnimationFrame(animatePlayback);
}

function startWaveformAnimation() {
  if (animationFrameId) return;
  animationFrameId = requestAnimationFrame(animatePlayback);
}

function stopWaveformAnimation() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function showWaveformEditor() {
  console.log("[Popup] showWaveformEditor called, loadedAudioBuffer:", loadedAudioBuffer ? `${loadedAudioBuffer.duration.toFixed(2)}s` : "null");
  waveformContainer.style.display = "block";
  if (stemWaveformContainer) {
    stemWaveformContainer.style.display = "block";
  }
  if (loadedAudioBuffer) {
    trimStartSeconds = 0;
    trimEndSeconds = loadedAudioBuffer.duration;
    waveformZoom = 1.0;
    waveformScrollOffset = 0;
    trimStartInput.max = String(loadedAudioBuffer.duration);
    trimEndInput.max = String(loadedAudioBuffer.duration);
    trimStartInput.value = "0";
    trimEndInput.value = String(loadedAudioBuffer.duration);
    
   scrubberInput.max = String(loadedAudioBuffer.duration);
   scrubberInput.value = "0";
    if (stemScrubberInput) {
      stemScrubberInput.max = String(loadedAudioBuffer.duration);
      stemScrubberInput.value = "0";
    }
    // Defer one frame so layout is settled before canvas sizing/draw.
    requestAnimationFrame(() => updateWaveformDisplay());
  }
}

function hideWaveformEditor() {
  waveformContainer.style.display = "none";
  if (stemWaveformContainer) {
    stemWaveformContainer.style.display = "none";
  }
  stopWaveformAnimation();
}

function applyPreset(settings, options = {}) {
  const { persist = true } = options;
  if (settings.bass !== undefined) bassInput.value = String(settings.bass);
  if (settings.volume !== undefined) volumeInput.value = String(settings.volume);
  if (settings.pitch !== undefined) pitchInput.value = String(settings.pitch);
  if (settings.reverb !== undefined) reverbInput.value = String(settings.reverb);
  if (settings.reverbType !== undefined) reverbTypeInput.value = settings.reverbType;
  if (settings.reverbSize !== undefined) reverbSizeInput.value = String(settings.reverbSize);
  if (settings.reverbTone !== undefined) reverbToneInput.value = String(settings.reverbTone);
  if (settings.chorusMix !== undefined) chorusMixInput.value = String(settings.chorusMix);
  if (settings.chorusRate !== undefined) chorusRateInput.value = String(settings.chorusRate);
  if (settings.chorusType !== undefined) chorusTypeInput.value = settings.chorusType;
  if (settings.chorusDepth !== undefined) chorusDepthInput.value = String(settings.chorusDepth);
  if (settings.chorusWidth !== undefined) chorusWidthInput.value = String(settings.chorusWidth);
  if (settings.delayMix !== undefined) delayMixInput.value = String(settings.delayMix);
  if (settings.delayType !== undefined) delayTypeInput.value = settings.delayType;
  if (settings.delayTime !== undefined) delayTimeInput.value = String(settings.delayTime);
  if (settings.delayFeedback !== undefined) delayFeedbackInput.value = String(settings.delayFeedback);
  if (settings.distortion !== undefined) distortionInput.value = String(settings.distortion);
  if (settings.ringModFreq !== undefined && ringModCarrierNode) {
    ringModCarrierNode.frequency.value = settings.ringModFreq;
  }
  if (settings.ringModMix !== undefined && ringModGainNode) {
    ringModGainNode.gain.value = settings.ringModMix;
  }

  updateBassUI();
  updateVolumeUI();
  updatePitchUI();
  updateReverbUI();
  updateReverbSizeUI();
  updateReverbToneUI();
  updateChorusMixUI();
  updateChorusRateUI();
  updateChorusDepthUI();
  updateChorusWidthUI();
  updateDelayMixUI();
  updateDelayTimeUI();
  updateDelayFeedbackUI();
  updateDistortionUI();
  applyFilterValues();
  applySpeedToActiveTab();
  updateLoadedPlaybackRate();
  if (persist) {
    saveSettings();
  }
}

const FILTER_BASELINE = {
  bass: 0,
  output: {
    volume: 1,
    pitch: 0
  },
  eq: {
    type: "lowshelf",
    frequency: 180,
    q: 0.7,
    gain: 0
  },
  reverb: {
    mix: 0,
    type: "hall",
    size: 4.0,
    tone: 0.6
  },
  chorus: {
    mix: 0,
    rate: 1.2,
    depth: 0.008,
    type: "classic",
    width: 0.5
  },
  delay: {
    mix: 0,
    type: "digital",
    time: 0.22,
    feedback: 0.35
  },
  distortion: {
    amount: 0
  },
  ringMod: {
    freq: 0,
    mix: 0
  }
};

const FILTER_PRESETS = {
  oldRadio: {
    eq: { type: "bandpass", frequency: 700, q: 12, gain: 0 },
    output: { volume: 1.15, pitch: 0 },
    reverb: { mix: 0.2, type: "spring", size: 1.8, tone: 0.5 },
    chorus: { mix: 0, rate: 1.2, depth: 0.008, type: "classic", width: 0.3 },
    delay: { mix: 0.12, type: "slap", time: 0.09, feedback: 0.25 },
    distortion: { amount: 28 },
    ringMod: { freq: 0, mix: 0 },
    bass: 0
  },
  lofi: {
    eq: { type: "lowpass", frequency: 2400, q: 2, gain: 0 },
    output: { volume: 0.85, pitch: 0 },
    reverb: { mix: 0.15, type: "plate", size: 2.8, tone: 0.45 },
    chorus: { mix: 0.45, rate: 0.2, depth: 0.035, type: "ensemble", width: 0.7 },
    delay: { mix: 0.18, type: "tape", time: 0.26, feedback: 0.42 },
    distortion: { amount: 16 },
    ringMod: { freq: 0, mix: 0 },
    bass: 0
  },
  distorted: {
    eq: { type: "lowshelf", frequency: 180, q: 0.7, gain: 14 },
    output: { volume: 1.1, pitch: 0 },
    reverb: { mix: 0.3 },
    chorus: { mix: 0.15, rate: 1.2, depth: 0.008 },
    distortion: { amount: 62 },
    ringMod: { freq: 0, mix: 0 },
    bass: 14
  },
  catWah: {
    eq: { type: "peaking", frequency: 2400, q: 25, gain: 28 },
    output: { volume: 1.05, pitch: 0 },
    reverb: { mix: 0.25 },
    chorus: { mix: 0.55, rate: 8.0, depth: 0.045 },
    distortion: { amount: 20 },
    ringMod: { freq: 400, mix: 0.4 },
    bass: 0
  },
  alien: {
    eq: { type: "highpass", frequency: 600, q: 2.5, gain: 0 },
    output: { volume: 1.0, pitch: 0 },
    reverb: { mix: 0.65 },
    chorus: { mix: 0.55, rate: 4.5, depth: 0.04 },
    distortion: { amount: 26 },
    ringMod: { freq: 140, mix: 0.75 },
    bass: 0
  },
  outerSpace: {
    eq: { type: "lowshelf", frequency: 180, q: 0.7, gain: -10 },
    output: { volume: 0.6, pitch: 0 },
    reverb: { mix: 0.98 },
    chorus: { mix: 0.75, rate: 0.25, depth: 0.055 },
    distortion: { amount: 8 },
    ringMod: { freq: 45, mix: 0.5 },
    bass: -10
  },
  cathedral: {
    eq: { type: "lowshelf", frequency: 180, q: 0.7, gain: 3 },
    output: { volume: 0.75, pitch: 0 },
    reverb: { mix: 1.0, type: "cathedral", size: 7.5, tone: 0.65 },
    chorus: { mix: 0.35, rate: 0.6, depth: 0.02, type: "dimension", width: 0.8 },
    delay: { mix: 0.2, type: "digital", time: 0.42, feedback: 0.5 },
    distortion: { amount: 0 },
    ringMod: { freq: 0, mix: 0 },
    bass: 3
  },
  phoneCall: {
    eq: { type: "bandpass", frequency: 900, q: 8, gain: 0 },
    output: { volume: 1.25, pitch: 0 },
    reverb: { mix: 0 },
    chorus: { mix: 0, rate: 1.2, depth: 0.008 },
    distortion: { amount: 32 },
    ringMod: { freq: 0, mix: 0 },
    bass: 0
  }
};

function lerpValue(a, b, t) {
  return a + (b - a) * t;
}

function getInterpolatedFilterSettings(presetName, t) {
  const preset = FILTER_PRESETS[presetName];
  if (!preset) {
    return null;
  }

  return {
    bass: lerpValue(FILTER_BASELINE.bass, preset.bass, t),
    volume: lerpValue(FILTER_BASELINE.output.volume, preset.output.volume, t),
    pitch: lerpValue(FILTER_BASELINE.output.pitch, preset.output.pitch, t),
    reverb: lerpValue(FILTER_BASELINE.reverb.mix, preset.reverb.mix, t),
    reverbType: t <= 0.001 ? FILTER_BASELINE.reverb.type : (preset.reverb.type || FILTER_BASELINE.reverb.type),
    reverbSize: lerpValue(FILTER_BASELINE.reverb.size, preset.reverb.size ?? FILTER_BASELINE.reverb.size, t),
    reverbTone: lerpValue(FILTER_BASELINE.reverb.tone, preset.reverb.tone ?? FILTER_BASELINE.reverb.tone, t),
    chorusMix: lerpValue(FILTER_BASELINE.chorus.mix, preset.chorus.mix, t),
    chorusRate: lerpValue(FILTER_BASELINE.chorus.rate, preset.chorus.rate, t),
    chorusDepth: lerpValue(FILTER_BASELINE.chorus.depth, preset.chorus.depth, t),
    chorusType: t <= 0.001 ? FILTER_BASELINE.chorus.type : (preset.chorus.type || FILTER_BASELINE.chorus.type),
    chorusWidth: lerpValue(FILTER_BASELINE.chorus.width, preset.chorus.width ?? FILTER_BASELINE.chorus.width, t),
    delayMix: lerpValue(FILTER_BASELINE.delay.mix, preset.delay?.mix ?? FILTER_BASELINE.delay.mix, t),
    delayType: t <= 0.001 ? FILTER_BASELINE.delay.type : (preset.delay?.type || FILTER_BASELINE.delay.type),
    delayTime: lerpValue(FILTER_BASELINE.delay.time, preset.delay?.time ?? FILTER_BASELINE.delay.time, t),
    delayFeedback: lerpValue(FILTER_BASELINE.delay.feedback, preset.delay?.feedback ?? FILTER_BASELINE.delay.feedback, t),
    distortion: lerpValue(FILTER_BASELINE.distortion.amount, preset.distortion.amount, t),
    ringModFreq: lerpValue(FILTER_BASELINE.ringMod.freq, preset.ringMod.freq, t),
    ringModMix: lerpValue(FILTER_BASELINE.ringMod.mix, preset.ringMod.mix, t),
    eqType: t <= 0.001 ? FILTER_BASELINE.eq.type : preset.eq.type,
    eqFrequency: lerpValue(FILTER_BASELINE.eq.frequency, preset.eq.frequency, t),
    eqQ: lerpValue(FILTER_BASELINE.eq.q, preset.eq.q, t),
    eqGain: lerpValue(FILTER_BASELINE.eq.gain, preset.eq.gain, t)
  };
}

function applyFilterPresetAtStrength() {
  if (!activeFilterPreset) {
    return;
  }

  const t = Number(effectMixInput.value);
  const settings = getInterpolatedFilterSettings(activeFilterPreset, t);
  if (!settings) {
    return;
  }

  logPresetDebug("applyFilterPresetAtStrength:start", {
    targetPreset: activeFilterPreset,
    strength: t
  });

  bassInput.value = String(Math.round(settings.bass));
  volumeInput.value = String(settings.volume);
  pitchInput.value = String(Math.round(settings.pitch));
  reverbInput.value = String(settings.reverb);
  reverbTypeInput.value = settings.reverbType;
  reverbSizeInput.value = String(settings.reverbSize);
  reverbToneInput.value = String(settings.reverbTone);
  chorusMixInput.value = String(settings.chorusMix);
  chorusRateInput.value = String(settings.chorusRate);
  chorusTypeInput.value = settings.chorusType;
  chorusDepthInput.value = String(settings.chorusDepth);
  chorusWidthInput.value = String(settings.chorusWidth);
  delayMixInput.value = String(settings.delayMix);
  delayTypeInput.value = settings.delayType;
  delayTimeInput.value = String(settings.delayTime);
  delayFeedbackInput.value = String(settings.delayFeedback);
  distortionInput.value = String(Math.round(settings.distortion));

  // Keep preset switching exclusive: old preset effects should not linger.
  reverbEnable.checked = settings.reverb > 0.001;
  chorusEnable.checked = settings.chorusMix > 0.001;
  delayEnable.checked = settings.delayMix > 0.001;
  distortionEnable.checked = settings.distortion > 0.5;

  if (ringModCarrierNode) {
    ringModCarrierNode.frequency.value = settings.ringModFreq;
  }
  if (ringModGainNode) {
    ringModGainNode.gain.value = settings.ringModMix;
  }

  currentFilterType = settings.eqType;

  if (bassNode) {
    bassNode.type = settings.eqType;
    bassNode.frequency.value = settings.eqFrequency;
    bassNode.Q.value = settings.eqQ;
    if (settings.eqType === "lowshelf" || settings.eqType === "highshelf" || settings.eqType === "peaking") {
      bassNode.gain.value = settings.eqGain;
    }
  }

  updateBassUI();
  updateVolumeUI();
  updatePitchUI();
  updateReverbUI();
  updateReverbSizeUI();
  updateReverbToneUI();
  updateChorusMixUI();
  updateChorusRateUI();
  updateChorusDepthUI();
  updateChorusWidthUI();
  updateDelayMixUI();
  updateDelayTimeUI();
  updateDelayFeedbackUI();
  updateDistortionUI();
  applyFilterValues();

  logPresetDebug("applyFilterPresetAtStrength:end", {
    targetPreset: activeFilterPreset,
    eqType: settings.eqType,
    distortion: settings.distortion,
    reverbMix: settings.reverb,
    chorusMix: settings.chorusMix,
    delayMix: settings.delayMix
  });
}

function activateFilterPreset(name) {
  const preset = FILTER_PRESETS[name];
  if (!preset) {
    return;
  }

  logPresetDebug("activateFilterPreset:requested", { requestedPreset: name });
  presetSwitchInProgress = true;
  try {
    logPresetDebug("activateFilterPreset:clear:start", { requestedPreset: name });
    clearAllEffects({ suppressSave: true });
    logPresetDebug("activateFilterPreset:clear:end", { requestedPreset: name });
    activeFilterPreset = name;
    logPresetDebug("activateFilterPreset:apply:start", { requestedPreset: name });
    applyFilterPresetAtStrength();
    logPresetDebug("activateFilterPreset:apply:end", { requestedPreset: name });
  } finally {
    presetSwitchInProgress = false;
    logPresetDebug("activateFilterPreset:done", { requestedPreset: name });
  }
  saveSettings();
}

function clearAllEffects(options = {}) {
  const { suppressSave = false } = options;
  logPresetDebug("clearAllEffects:start", { suppressSave });
  activeFilterPreset = null;
  currentFilterType = "lowshelf";
  reverbEnable.checked = false;
  chorusEnable.checked = false;
  delayEnable.checked = false;
  distortionEnable.checked = false;
  applyPreset({
    bass: 0,
    volume: 1,
    pitch: 0,
    reverb: 0,
    reverbType: "hall",
    reverbSize: 4.0,
    reverbTone: 0.6,
    chorusMix: 0,
    chorusRate: 1.2,
    chorusType: "classic",
    chorusDepth: 0.008,
    chorusWidth: 0.5,
    delayMix: 0,
    delayType: "digital",
    delayTime: 0.22,
    delayFeedback: 0.35,
    distortion: 0,
    ringModFreq: 0,
    ringModMix: 0
  }, { persist: !suppressSave });
  if (bassNode) {
    bassNode.type = "lowshelf";
    bassNode.frequency.value = 180;
    bassNode.gain.value = 0;
  }
  logPresetDebug("clearAllEffects:end", { suppressSave });
}

function resetPlaybackShapingDefaults() {
  activeFilterPreset = null;

  bassInput.value = "0";
  volumeInput.value = "1";
  effectMixInput.value = "1";
  speedInput.value = "1";
  pitchInput.value = "0";

  updateBassUI();
  updateVolumeUI();
  updateEffectMixUI();
  updateSpeedUI();
  updatePitchUI();

  applyFilterValues();
  applySpeedToActiveTab();
  updateLoadedPlaybackRate();
  handlePitchChange();
  saveSettings();
}

function resetAudioEffectsDefaults() {
  activeFilterPreset = null;

  reverbEnable.checked = false;
  reverbInput.value = "0";
  reverbTypeInput.value = "hall";
  reverbSizeInput.value = "4.0";
  reverbToneInput.value = "0.6";

  chorusEnable.checked = false;
  chorusMixInput.value = "0";
  chorusRateInput.value = "1.2";
  chorusTypeInput.value = "classic";
  chorusDepthInput.value = "0.008";
  chorusWidthInput.value = "0.5";

  delayEnable.checked = false;
  delayMixInput.value = "0";
  delayTypeInput.value = "digital";
  delayTimeInput.value = "0.22";
  delayFeedbackInput.value = "0.35";

  distortionEnable.checked = false;
  distortionInput.value = "0";

  updateReverbUI();
  updateReverbSizeUI();
  updateReverbToneUI();
  updateChorusMixUI();
  updateChorusRateUI();
  updateChorusDepthUI();
  updateChorusWidthUI();
  updateDelayMixUI();
  updateDelayTimeUI();
  updateDelayFeedbackUI();
  updateDistortionUI();

  applyFilterValues();
  saveSettings();
}

function presetOldRadio() {
  activateFilterPreset("oldRadio");
}

function presetLoFi() {
  activateFilterPreset("lofi");
}

function presetDistorted() {
  activateFilterPreset("distorted");
}

function presetCatWah() {
  activateFilterPreset("catWah");
}

function presetAlien() {
  activateFilterPreset("alien");
}

function presetOuterSpace() {
  activateFilterPreset("outerSpace");
}

function presetDeepReverb() {
  activateFilterPreset("cathedral");
}

function presetPhoneCall() {
  activateFilterPreset("phoneCall");
}

console.log("[Popup] Script loaded, setting up button listeners...");

startBtn.addEventListener("click", () => startCapture({ isReconnect: false }));
stopBtn.addEventListener("click", () => stopCapture({ manual: true }));

// Pause/resume browser audio for voice isolation to keep video timestamp synced
if (pauseBrowserAudioBtn) {
  pauseBrowserAudioBtn.addEventListener("click", (event) => {
    // Ignore keyboard-triggered synthetic clicks. This button controls global
    // page media state and should require an intentional pointer action.
    if (!event || event.detail === 0) {
      return;
    }

    if (!stream) return;
    if (userPausedBrowserAudio) {
      userPausedBrowserAudio = false;

      if (liveCompanionIsolationActive && liveCompanionTookoverRouting) {
        setLiveCompanionPlaybackPaused(false);
        refreshPauseBrowserAudioButton();
        console.log("[Voice Isolation] AI playback resumed by user");
        return;
      }

      // If isolation currently needs source silence, defer the audible resume.
      if (!browserAudioPausedForIsolation) {
        sendMessageToActiveTab({ type: "RESUME_ORIGINAL_MEDIA" });
        resumeOriginalTabMediaForIsolation();
      }

      refreshPauseBrowserAudioButton();
      console.log("[Voice Isolation] Browser audio resumed by user");
    } else {
      userPausedBrowserAudio = true;

      if (liveCompanionIsolationActive && liveCompanionTookoverRouting) {
        setLiveCompanionPlaybackPaused(true);
        refreshPauseBrowserAudioButton();
        console.log("[Voice Isolation] AI playback paused by user");
        return;
      }

      // True pause plus mute fallback keeps both page audio and captured leakage silent.
      sendMessageToActiveTab({ type: "PAUSE_ORIGINAL_MEDIA" });
      pauseOriginalTabMediaForIsolation();

      refreshPauseBrowserAudioButton();
      console.log("[Voice Isolation] Browser audio paused by user");
    }
  });
}

startRecordingBtn.addEventListener("click", startRecording);
stopRecordingBtn.addEventListener("click", stopRecording);
downloadWavBtn.addEventListener("click", downloadWav);
downloadMp3Btn.addEventListener("click", downloadMp3);

console.log("[Popup] Button listeners attached");

audioFileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  await loadBlobAsAudio(file, `file loaded: ${file.name}`);
});

loadLastRecordingBtn.addEventListener("click", loadLastRecordingAsAudio);
playLoadedAudioBtn.addEventListener("click", playLoadedAudioFromCurrentPosition);
pauseLoadedAudioBtn.addEventListener("click", pauseRecordedAudio);
stopLoadedAudioBtn.addEventListener("click", stopLoadedAudio);
if (skipBackCaptureMediaBtn) {
  skipBackCaptureMediaBtn.addEventListener("click", () => {
    void seekCapturedMediaBy(-5);
  });
}
if (restartCaptureMediaBtn) {
  restartCaptureMediaBtn.addEventListener("click", () => {
    void restartCapturedMediaTimeline();
  });
}
if (prevCaptureMediaTrackBtn) {
  prevCaptureMediaTrackBtn.addEventListener("click", () => {
    void skipCapturedMediaToPreviousTrack();
  });
}
if (nextCaptureMediaTrackBtn) {
  nextCaptureMediaTrackBtn.addEventListener("click", () => {
    void skipCapturedMediaToNextTrack();
  });
}
if (skipForwardCaptureMediaBtn) {
  skipForwardCaptureMediaBtn.addEventListener("click", () => {
    void seekCapturedMediaBy(5);
  });
}
if (skipBackLoadedAudioBtn) {
  skipBackLoadedAudioBtn.addEventListener("click", () => skipLoadedAudioBy(-5, lastLoadedPlaybackUsedStemMix));
}
if (replayLoadedAudioBtn) {
  replayLoadedAudioBtn.addEventListener("click", () => replayLoadedAudioFromTrimStart(lastLoadedPlaybackUsedStemMix));
}
if (skipForwardLoadedAudioBtn) {
  skipForwardLoadedAudioBtn.addEventListener("click", () => skipLoadedAudioBy(5, lastLoadedPlaybackUsedStemMix));
}
if (stemPlayLoadedAudioBtn) {
  stemPlayLoadedAudioBtn.addEventListener("click", playStemMixFromCurrentPosition);
}
if (stemPauseLoadedAudioBtn) {
  stemPauseLoadedAudioBtn.addEventListener("click", pauseRecordedAudio);
}
if (stemStopLoadedAudioBtn) {
  stemStopLoadedAudioBtn.addEventListener("click", stopLoadedAudio);
}
downloadProcessedWavBtn.addEventListener("click", downloadProcessedLoadedAudioWav);
if (downloadStemMixBtn) {
  downloadStemMixBtn.addEventListener("click", downloadCurrentSourceStemMix);
}
if (downloadAllStemsBtn) {
  downloadAllStemsBtn.addEventListener("click", downloadAllSourceStems);
}
if (presetExcludeVocalsBtn) {
  presetExcludeVocalsBtn.addEventListener("click", () => applySourceStemMutePreset(["vocals"]));
}
if (presetExcludeDrumsBtn) {
  presetExcludeDrumsBtn.addEventListener("click", () => applySourceStemMutePreset(["drums"]));
}
if (presetExcludeBassBtn) {
  presetExcludeBassBtn.addEventListener("click", () => applySourceStemMutePreset(["bass"]));
}
if (presetExcludeDrumsBassBtn) {
  presetExcludeDrumsBassBtn.addEventListener("click", () => applySourceStemMutePreset(["drums", "bass"]));
}
if (presetVocalsOnlyBtn) {
  presetVocalsOnlyBtn.addEventListener("click", () => applySourceStemMutePreset(["drums", "bass", "other", "accompaniment"]));
}
if (presetEnableAllStemsBtn) {
  presetEnableAllStemsBtn.addEventListener("click", () => applySourceStemMutePreset([]));
}
if (cleanupStemSelect) {
  cleanupStemSelect.addEventListener("change", () => {
    selectedCleanupStem = cleanupStemSelect.value;
    refreshCleanupStemControls();
  });
}
if (cleanupEnabledInput) {
  cleanupEnabledInput.addEventListener("change", () => {
    updateCurrentStemCleanupSetting({ enabled: cleanupEnabledInput.checked });
  });
}
if (cleanupHighpassInput) {
  cleanupHighpassInput.addEventListener("input", () => {
    updateCurrentStemCleanupSetting({ highpassHz: Number(cleanupHighpassInput.value) });
  });
}
if (cleanupLowpassInput) {
  cleanupLowpassInput.addEventListener("input", () => {
    updateCurrentStemCleanupSetting({ lowpassHz: Number(cleanupLowpassInput.value) });
  });
}
if (cleanupGateInput) {
  cleanupGateInput.addEventListener("input", () => {
    updateCurrentStemCleanupSetting({ gateThreshold: Number(cleanupGateInput.value) });
  });
}
if (cleanupTransientReductionInput) {
  cleanupTransientReductionInput.addEventListener("input", () => {
    updateCurrentStemCleanupSetting({ transientReduction: Number(cleanupTransientReductionInput.value) });
  });
}
if (autoVocalCleanupEnabledInput) {
  autoVocalCleanupEnabledInput.addEventListener("change", () => {
    autoVocalCleanupEnabled = autoVocalCleanupEnabledInput.checked;
    saveSettings();
  });
}
if (autoVocalCleanupStrengthInput) {
  autoVocalCleanupStrengthInput.addEventListener("input", () => {
    autoVocalCleanupStrength = Math.max(0, Math.min(1, Number(autoVocalCleanupStrengthInput.value)));
    updateCleanupUiValues();
    saveSettings();
  });
}
if (applyAutoVocalCleanupBtn) {
  applyAutoVocalCleanupBtn.addEventListener("click", () => applyAutoVocalCleanupPreset({ quiet: false }));
}
if (applyAutoVocalCleanupStrongBtn) {
  applyAutoVocalCleanupStrongBtn.addEventListener("click", () => {
    applyAutoVocalCleanupPreset({ quiet: false, strengthOverride: 0.82 });
  });
}
if (applyVocalCleanupPresetBtn) {
  applyVocalCleanupPresetBtn.addEventListener("click", applyVocalCleanupPreset);
}
if (resetCleanupForStemBtn) {
  resetCleanupForStemBtn.addEventListener("click", resetCleanupForCurrentStem);
}

// Waveform editor controls
trimStartInput.addEventListener("input", () => {
  trimStartSeconds = Math.min(Number(trimStartInput.value), trimEndSeconds - 0.01);
  trimStartInput.value = String(trimStartSeconds);
  updateWaveformDisplay();
  scheduleSessionCacheSync();
});

trimEndInput.addEventListener("input", () => {
  trimEndSeconds = Math.max(Number(trimEndInput.value), trimStartSeconds + 0.01);
  trimEndInput.value = String(trimEndSeconds);
  updateWaveformDisplay();
  scheduleSessionCacheSync();
});

scrubberInput.addEventListener("input", () => {
  if (!loadedAudioBuffer) {
    return;
  }

  const seekTime = Number(scrubberInput.value);
  currentPlaybackSeconds = seekTime;
  currentPlaybackTimeEl.textContent = seekTime.toFixed(2);
  drawWaveform();
  scheduleSessionCacheSync();
});

scrubberInput.addEventListener("change", () => {
  if (!loadedAudioBuffer) {
    return;
  }

  const seekTime = Number(scrubberInput.value);
  currentPlaybackSeconds = seekTime;
  scheduleSessionCacheSync();
  if (recordedAudioIsPlaying || recordedAudioIsPaused) {
    startLoadedAudioPlayback({ seekTime, forceStemMix: lastLoadedPlaybackUsedStemMix });
  } else {
    updateWaveformDisplay();
  }
});

if (stemScrubberInput) {
  stemScrubberInput.addEventListener("input", () => {
    if (!loadedAudioBuffer) {
      return;
    }

    const seekTime = Number(stemScrubberInput.value);
    currentPlaybackSeconds = seekTime;
    currentPlaybackTimeEl.textContent = seekTime.toFixed(2);
    if (stemCurrentPlaybackTimeEl) {
      stemCurrentPlaybackTimeEl.textContent = currentPlaybackTimeEl.textContent;
    }
    scrubberInput.value = stemScrubberInput.value;
    drawWaveform();
    scheduleSessionCacheSync();
  });

  stemScrubberInput.addEventListener("change", () => {
    if (!loadedAudioBuffer) {
      return;
    }

    const seekTime = Number(stemScrubberInput.value);
    currentPlaybackSeconds = seekTime;
    scrubberInput.value = stemScrubberInput.value;
    scheduleSessionCacheSync();
    if (recordedAudioIsPlaying || recordedAudioIsPaused) {
      startLoadedAudioPlayback({ seekTime, forceStemMix: true });
    } else {
      updateWaveformDisplay();
    }
  });
}

waveformCanvas.addEventListener("click", (event) => handleCanvasClick(event, waveformCanvas));
waveformCanvas.addEventListener("wheel", handleCanvasScroll, { passive: false });
if (stemWaveformCanvas) {
  stemWaveformCanvas.addEventListener("click", (event) => handleCanvasClick(event, stemWaveformCanvas));
  stemWaveformCanvas.addEventListener("wheel", handleCanvasScroll, { passive: false });
}
window.addEventListener("resize", () => {
  const mainVisible = waveformContainer && waveformContainer.style.display !== "none";
  const stemVisible = stemWaveformContainer && stemWaveformContainer.style.display !== "none";
  if (loadedAudioBuffer && (mainVisible || stemVisible)) {
    updateWaveformDisplay();
  }
});

generateStemsBtn.addEventListener("click", generateStems);

if (cancelStemGenerationBtn) {
  cancelStemGenerationBtn.addEventListener("click", () => {
    stemGenerationAbortController?.abort();
  });
}

useLiveStemMixingInput.addEventListener("change", () => {
  liveStemMixingEnabled = useLiveStemMixingInput.checked;
  saveSettings();
  if (stream && audioContext) {
    toggleLiveStemRouting();
  }
  console.log("[Live Stem] Live stem mixing enabled:", liveStemMixingEnabled);
});

useStemMixPlaybackInput.addEventListener("change", () => {
  if (!useStemMixPlaybackInput.checked) {
    lastLoadedPlaybackUsedStemMix = false;
  }
  saveSettings();
  if (recordedAudioIsPlaying) {
    startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds, forceStemMix: useStemMixPlaybackInput.checked });
  }
});

if (useStudioStemQualityInput) {
  useStudioStemQualityInput.addEventListener("change", () => {
    saveSettings();
  });
}

if (checkCompanionBtn) {
  checkCompanionBtn.addEventListener("click", async () => {
    await checkCompanionEngine({ silent: false });
  });
}

if (restartCompanionBtn) {
  restartCompanionBtn.addEventListener("click", async () => {
    await restartCompanionEngine();
  });
}

function handleStemMixControlChange() {
  invalidateStemMixCache();
  if (splitStemBuffers || sourceStemBuffers) {
    ensureStemMixPlaybackEnabled();
  }
  updateStemGainUI();
  updateLiveStemGains(); // Also update live stem gains
  saveSettings();
  if (recordedAudioIsPlaying && useStemMixPlaybackInput.checked && (splitStemBuffers || sourceStemBuffers)) {
    startLoadedAudioPlayback({ seekTime: currentPlaybackSeconds });
  }
}

stemLowGainInput.addEventListener("input", handleStemMixControlChange);
stemMidGainInput.addEventListener("input", handleStemMixControlChange);
stemHighGainInput.addEventListener("input", handleStemMixControlChange);
stemLowMuteInput.addEventListener("change", handleStemMixControlChange);
stemMidMuteInput.addEventListener("change", handleStemMixControlChange);
stemHighMuteInput.addEventListener("change", handleStemMixControlChange);

// Voice isolation event listeners
enableVoiceIsolationInput.addEventListener("change", async () => {
  await setVoiceIsolationFromControls(enableVoiceIsolationInput.checked);
});

if (startVoiceIsolationBtn) {
  startVoiceIsolationBtn.addEventListener("click", async () => {
    await setVoiceIsolationFromControls(true);
  });
}

if (stopVoiceIsolationBtn) {
  stopVoiceIsolationBtn.addEventListener("click", async () => {
    await setVoiceIsolationFromControls(false);
  });
}

voiceIsolationStrengthInput.addEventListener("input", () => {
  voiceIsolationStrength = Number(voiceIsolationStrengthInput.value);
  updateVoiceIsolationStrengthUI();
  saveSettings();
  
  // Update live processing strength
  if (voiceIsolationProcessor && voiceIsolationProcessor.isInitialized) {
    voiceIsolationProcessor.updateStrength(voiceIsolationStrength);
  }
});

if (voiceIsolationModeInput) {
  voiceIsolationModeInput.addEventListener("change", async () => {
    await setVoiceIsolationMode(voiceIsolationModeInput.value);
  });
}

if (setVoiceModeVocalsBtn) {
  setVoiceModeVocalsBtn.addEventListener("click", async () => {
    await setVoiceIsolationMode("vocals");
  });
}

if (setVoiceModeInstrumentalBtn) {
  setVoiceModeInstrumentalBtn.addEventListener("click", async () => {
    await setVoiceIsolationMode("instrumental");
  });
}

if (downloadPreparedInstrumentalBtn) {
  downloadPreparedInstrumentalBtn.addEventListener("click", async () => {
    await downloadPreparedInstrumental();
  });
}

if (processingDelayInput) {
  processingDelayInput.addEventListener("input", () => {
    voiceProcessingDelay = Number(processingDelayInput.value);
    updateProcessingDelayUI();
    saveSettings();
    // Note: Processing delay is for future buffer-based processing
  });
}

// Resume AudioContext on user interaction if it was suspended.
document.addEventListener("click", () => {
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume().then(() => {
      setStatus("Audio activated - processing running");
    });
  }
});

themeLightBtn?.addEventListener("click", () => {
  applyUiTheme("light");
});

themeDarkBtn?.addEventListener("click", () => {
  applyUiTheme("dark");
});

tabCaptureBtn?.addEventListener("click", () => {
  applyUiTab("capture");
});

tabFxBtn?.addEventListener("click", () => {
  applyUiTab("fx");
});

tabAiBtn?.addEventListener("click", () => {
  applyUiTab("ai");
});

chrome.storage.onChanged.addListener(syncUiStateFromStorageChanges);

bassInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateBassUI();
  applyFilterValues();
  saveSettings();
});

volumeInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateVolumeUI();
  applyFilterValues();
  saveSettings();
});

effectMixInput.addEventListener("input", () => {
  if (presetSwitchInProgress) {
    return;
  }

  updateEffectMixUI();
  if (activeFilterPreset) {
    applyFilterPresetAtStrength();
  } else {
    applyFilterValues();
  }
  saveSettings();
});

speedInput.addEventListener("input", () => {
  updateSpeedUI();
  applySpeedToActiveTab();
  updateLoadedPlaybackRate();
  saveSettings();
});

if (resetPlaybackShapingBtn) {
  resetPlaybackShapingBtn.addEventListener("click", resetPlaybackShapingDefaults);
}

pitchInput.addEventListener("input", () => {
  updatePitchUI();
  handlePitchChange();
  saveSettings();
});

reverbEnable.addEventListener("change", () => {
  applyFilterValues();
  saveSettings();
});

reverbInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateReverbUI();
  applyFilterValues();
  saveSettings();
});

reverbTypeInput.addEventListener("change", () => {
  activeFilterPreset = null;
  applyFilterValues();
  saveSettings();
});

reverbSizeInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateReverbSizeUI();
  applyFilterValues();
  saveSettings();
});

reverbToneInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateReverbToneUI();
  applyFilterValues();
  saveSettings();
});

chorusEnable.addEventListener("change", () => {
  applyFilterValues();
  saveSettings();
});

chorusMixInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateChorusMixUI();
  applyFilterValues();
  saveSettings();
});

chorusRateInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateChorusRateUI();
  applyFilterValues();
  saveSettings();
});

chorusTypeInput.addEventListener("change", () => {
  activeFilterPreset = null;
  applyFilterValues();
  saveSettings();
});

chorusDepthInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateChorusDepthUI();
  applyFilterValues();
  saveSettings();
});

chorusWidthInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateChorusWidthUI();
  applyFilterValues();
  saveSettings();
});

delayEnable.addEventListener("change", () => {
  applyFilterValues();
  saveSettings();
});

delayMixInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateDelayMixUI();
  applyFilterValues();
  saveSettings();
});

delayTypeInput.addEventListener("change", () => {
  activeFilterPreset = null;
  applyFilterValues();
  saveSettings();
});

delayTimeInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateDelayTimeUI();
  applyFilterValues();
  saveSettings();
});

delayFeedbackInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateDelayFeedbackUI();
  applyFilterValues();
  saveSettings();
});

distortionEnable.addEventListener("change", () => {
  applyFilterValues();
  saveSettings();
});

distortionInput.addEventListener("input", () => {
  activeFilterPreset = null;
  updateDistortionUI();
  applyFilterValues();
  saveSettings();
});

if (resetAudioEffectsBtn) {
  resetAudioEffectsBtn.addEventListener("click", resetAudioEffectsDefaults);
}

presetClearBtn.addEventListener("click", clearAllEffects);
presetOldRadioBtn.addEventListener("click", presetOldRadio);
presetLoFiBtn.addEventListener("click", presetLoFi);
presetDistortedBtn.addEventListener("click", presetDistorted);
presetCatWahBtn.addEventListener("click", presetCatWah);
presetAlienBtn.addEventListener("click", presetAlien);
presetOuterSpaceBtn.addEventListener("click", presetOuterSpace);
presetDeepReverbBtn.addEventListener("click", presetDeepReverb);
presetPhoneCallBtn.addEventListener("click", presetPhoneCall);

window.addEventListener("beforeunload", () => stopCapture({ manual: true }));

// Listen for messages from offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "playbackEnded") {
    recordedAudioIsPlaying = false;
    recordedAudioIsPaused = false;
    updateLoadedAudioButtons();
    setLoadedStatus("playback finished");
    stopWaveformAnimation();
  } else if (message.type === "playbackPaused") {
    recordedAudioIsPlaying = false;
    recordedAudioIsPaused = true;
    updateLoadedAudioButtons();
    setLoadedStatus(`paused at ${message.position.toFixed(2)}s`);
  } else if (message.type === "playbackResumed") {
    recordedAudioIsPlaying = true;
    recordedAudioIsPaused = false;
    updateLoadedAudioButtons();
    setLoadedStatus("resumed");
  } else if (message.type === "playbackStopped") {
    recordedAudioIsPlaying = false;
    recordedAudioIsPaused = false;
    updateLoadedAudioButtons();
    setLoadedStatus("stopped");
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  // --- Emergency recovery: clear any stuck mute state left by a previous popup
  // session that was closed mid-processing or mid-playback.
  //
  // Two cases:
  //  A) Closed during CAPTURE — Chrome-level tab mute is set (tab.mutedInfo.muted).
  //     Scan tabs and clear the Chrome-level mute + el.volume=0 content-script lock.
  //  B) Closed during PLAYBACK — Chrome-level mute was already removed at the
  //     capture→playback transition; only the el.volume=0 content-script lock remains.
  //     tab.mutedInfo.muted is FALSE in this case, so a Chrome-mute scan misses it.
  //
  // Solution: broadcast UNMUTE_ORIGINAL_MEDIA to every tab. The content script now
  // no-ops immediately if no lock attribute is present, so this is safe to send
  // unconditionally without disrupting normal tabs.
  setStemStatus("not generated");
  setButtons(false);
  setStatus(isPopupMode() ? "Idle (popup mode)" : "Idle (side panel mode)");
  setRecordingStatus("not started");
  setLoadedStatus("none");

  try {
    void emergencyStartupUnmuteSweep();
  } catch (_e) {
    // Non-fatal — startup must continue.
  }

  try {
    await withTimeout(refreshPopupBackdropFromActiveTab(), 1800, false);
  } catch (_error) {
    clearPopupBackdropImage();
  }

  try {
    await withTimeout(restoreSettings(), 4000, null);
  } catch (error) {
    console.warn("[Popup] restoreSettings failed during startup:", error);
  }

  try {
    await withTimeout(checkCompanionEngine({ silent: true }), 4500, null);
  } catch (error) {
    console.warn("[Popup] companion check failed during startup:", error);
  }

  let restoredRecording = false;
  try {
    restoredRecording = Boolean(await withTimeout(restoreLastRecordingBlob(), 5000, false));
  } catch (error) {
    console.warn("[Popup] restoreLastRecordingBlob failed during startup:", error);
  }

  let restoredSession = { restoredLoadedAudio: false, restoredStems: false };
  try {
    restoredSession = await withTimeout(
      restoreSessionCacheFromOffscreen(),
      5500,
      { restoredLoadedAudio: false, restoredStems: false }
    );
  } catch (error) {
    console.warn("[Popup] restoreSessionCacheFromOffscreen failed during startup:", error);
  }

  let autoLoadedRecording = false;
  if (!restoredSession.restoredLoadedAudio && restoredRecording) {
    try {
      await withTimeout(loadLastRecordingAsAudio(), 4000, null);
      autoLoadedRecording = true;
    } catch (_e) {
      autoLoadedRecording = false;
    }
  }

  try {
    await withTimeout(restoreDownloadTraceStatus(), 1500, null);
  } catch (_e) {
    // Non-fatal.
  }

  setRecordingStatus(restoredRecording ? "previous recording restored" : "not started");
  if (!autoLoadedRecording && !restoredSession.restoredLoadedAudio) {
    setLoadedStatus("none");
  }
  if (restoredSession.restoredStems) {
    setStemStatus("restored source stems");
  }

  updateStemGainUI();
  refreshCleanupStemControls();
  updateRecordingButtons();
  updateLoadedAudioButtons();
  // Keep popup startup lightweight and stable. Offscreen is created lazily when needed.
});
