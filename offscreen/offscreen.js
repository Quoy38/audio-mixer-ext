// ============= OFFSCREEN AUDIO PLAYBACK MANAGER =============
// Persistent audio context for recorded audio playback
// Survives popup close/reopen

let audioContext = null;
let loadedAudioBuffer = null;
let filePlaybackSource = null;
let filePlaybackStartTime = null;
let filePlaybackTrimStart = 0;
let filePlaybackTrimEnd = 0;
let playbackIsPaused = false;
let playbackPauseTime = 0;

// Audio graph nodes
let inputMixNode = null;
let bassNode = null;
let preGainNode = null;
let dryGainNode = null;
let wetGainNode = null;
let distortionNode = null;
let convolverNode = null;
let reverbGainNode = null;
let chorusDelayNode = null;
let chorusWetGainNode = null;
let chorusLfoNode = null;
let chorusLfoGainNode = null;
let delayNode = null;
let delayFeedbackNode = null;
let delayFilterNode = null;
let delayWetGainNode = null;
let ringModCarrierNode = null;
let ringModGainNode = null;
let outputGainNode = null;

// Cache for reverb impulse responses
let reverbImpulseCacheKey = "";

// Import utility functions from popup
let audioLibFunctions = {};

// Chunked download state — receives blob data in pieces from popup
let _dlChunks = [];
let _dlFilename = "";
let _dlTotalChunks = 0;

// Popup session cache (survives popup close/reopen while offscreen lives)
let _sessionCache = {
  loadedAudioData: null,
  sourceStemAudioDataByName: null,
  updatedAt: 0
};

// Initialize audio context on first use
function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    createAudioGraph();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

function createAudioGraph() {
  const ctx = audioContext;

  // Master nodes
  inputMixNode = ctx.createGain();
  preGainNode = ctx.createGain();
  dryGainNode = ctx.createGain();
  wetGainNode = ctx.createGain();
  outputGainNode = ctx.createGain();

  // EQ node
  bassNode = ctx.createBiquadFilter();
  bassNode.type = "lowshelf";
  bassNode.frequency.value = 180;
  bassNode.Q.value = 0.7;
  bassNode.gain.value = 0;

  // Distortion
  distortionNode = ctx.createWaveShaper();
  distortionNode.curve = null;

  // Reverb (convolver)
  convolverNode = ctx.createConvolver();
  reverbGainNode = ctx.createGain();

  // Chorus
  chorusDelayNode = ctx.createDelay(0.1);
  chorusDelayNode.delayTime.value = 0.015;
  chorusWetGainNode = ctx.createGain();
  chorusLfoNode = ctx.createOscillator();
  chorusLfoNode.frequency.value = 1.2;
  chorusLfoGainNode = ctx.createGain();

  // Delay
  delayNode = ctx.createDelay(1.0);
  delayNode.delayTime.value = 0.22;
  delayFeedbackNode = ctx.createGain();
  delayFeedbackNode.gain.value = 0.35;
  delayFilterNode = ctx.createBiquadFilter();
  delayFilterNode.type = "lowpass";
  delayFilterNode.frequency.value = 18000;
  delayWetGainNode = ctx.createGain();

  // Ring modulator
  ringModCarrierNode = ctx.createOscillator();
  ringModCarrierNode.frequency.value = 0;
  ringModGainNode = ctx.createGain();

  // Wire up the graph: input -> EQ -> distortion -> split dry/wet
  inputMixNode.connect(bassNode);
  bassNode.connect(preGainNode);
  preGainNode.connect(distortionNode);

  // Dry path
  distortionNode.connect(dryGainNode);
  dryGainNode.connect(outputGainNode);

  // Wet path: reverb -> chorus -> delay -> ring-mod
  distortionNode.connect(convolverNode);
  convolverNode.connect(reverbGainNode);
  reverbGainNode.connect(wetGainNode);

  // Chorus in wet path
  wetGainNode.connect(chorusDelayNode);
  chorusDelayNode.connect(chorusWetGainNode);
  chorusWetGainNode.connect(outputGainNode);

  // LFO for chorus
  chorusLfoNode.connect(chorusLfoGainNode);
  chorusLfoGainNode.connect(chorusDelayNode.delayTime);
  chorusLfoNode.start(0);

  // Delay in wet path
  wetGainNode.connect(delayNode);
  delayNode.connect(delayWetGainNode);
  delayWetGainNode.connect(outputGainNode);
  delayNode.connect(delayFeedbackNode);
  delayFeedbackNode.connect(delayFilterNode);
  delayFilterNode.connect(delayNode);

  // Ring mod in wet path
  wetGainNode.connect(ringModCarrierNode);
  ringModCarrierNode.start(0);

  // Output to destination
  outputGainNode.connect(ctx.destination);
}

function playRecordedAudio(trimStart, trimEnd) {
  if (!loadedAudioBuffer) {
    console.error("[Offscreen] No audio buffer loaded");
    return;
  }

  ensureAudioContext();
  stopRecordedAudio();

  const offset = trimStart;
  const duration = trimEnd - trimStart;

  if (duration <= 0) {
    console.error("[Offscreen] Invalid trim");
    return;
  }

  filePlaybackTrimStart = trimStart;
  filePlaybackTrimEnd = trimEnd;
  playbackIsPaused = false;
  playbackPauseTime = 0;

  filePlaybackSource = audioContext.createBufferSource();
  filePlaybackSource.buffer = loadedAudioBuffer;
  filePlaybackSource.connect(inputMixNode);

  filePlaybackSource.onended = () => {
    filePlaybackSource = null;
    filePlaybackStartTime = null;
    chrome.runtime.sendMessage({ type: "playbackEnded" });
  };

  filePlaybackStartTime = audioContext.currentTime - offset;
  filePlaybackSource.start(0, offset, duration);

  console.log(`[Offscreen] Playing audio from ${offset}s to ${trimEnd}s`);
  chrome.runtime.sendMessage({ type: "playbackStarted" });
}

function pauseRecordedAudio() {
  if (!filePlaybackSource) return;

  const currentTime = audioContext.currentTime - (filePlaybackStartTime || 0);
  playbackPauseTime = currentTime;
  playbackIsPaused = true;

  try {
    filePlaybackSource.stop();
    filePlaybackSource.disconnect();
  } catch (e) {
    console.error("[Offscreen] Error stopping source:", e);
  }
  filePlaybackSource = null;

  console.log(`[Offscreen] Paused at ${playbackPauseTime.toFixed(2)}s`);
  chrome.runtime.sendMessage({ type: "playbackPaused", position: playbackPauseTime });
}

function resumeRecordedAudio() {
  if (!loadedAudioBuffer || !playbackIsPaused) return;

  ensureAudioContext();

  const offset = filePlaybackTrimStart + playbackPauseTime;
  const remainingDuration = filePlaybackTrimEnd - offset;

  if (remainingDuration <= 0) {
    stopRecordedAudio();
    return;
  }

  playbackIsPaused = false;
  filePlaybackSource = audioContext.createBufferSource();
  filePlaybackSource.buffer = loadedAudioBuffer;
  filePlaybackSource.connect(inputMixNode);

  filePlaybackSource.onended = () => {
    filePlaybackSource = null;
    filePlaybackStartTime = null;
    chrome.runtime.sendMessage({ type: "playbackEnded" });
  };

  filePlaybackStartTime = audioContext.currentTime - playbackPauseTime;
  filePlaybackSource.start(0, offset, remainingDuration);

  console.log(`[Offscreen] Resumed from ${offset.toFixed(2)}s`);
  chrome.runtime.sendMessage({ type: "playbackResumed" });
}

function stopRecordedAudio() {
  if (filePlaybackSource) {
    try {
      filePlaybackSource.stop();
      filePlaybackSource.disconnect();
    } catch (e) {
      console.error("[Offscreen] Error stopping:", e);
    }
    filePlaybackSource = null;
  }

  filePlaybackStartTime = null;
  playbackIsPaused = false;
  playbackPauseTime = 0;

  console.log("[Offscreen] Stopped");
  chrome.runtime.sendMessage({ type: "playbackStopped" });
}

function setLoadedAudioBuffer(audioBuffer) {
  loadedAudioBuffer = audioBuffer;
  console.log(`[Offscreen] Audio buffer loaded (${audioBuffer.duration.toFixed(2)}s)`);
}

function decodeAudioDataForTransfer(audioData) {
  if (!audioContext) ensureAudioContext();
  
  const buffer = audioContext.createBuffer(
    audioData.numberOfChannels,
    audioData.length,
    audioData.sampleRate
  );

  for (let i = 0; i < audioData.numberOfChannels; i++) {
    const channelData = buffer.getChannelData(i);
    channelData.set(audioData.channels[i]);
  }

  return buffer;
}

function encodeAudioBufferForTransfer(audioBuffer) {
  if (!audioBuffer || !Number.isFinite(audioBuffer.length) || !Number.isFinite(audioBuffer.sampleRate)) {
    return null;
  }

  const channels = [];
  for (let i = 0; i < audioBuffer.numberOfChannels; i += 1) {
    channels.push(new Float32Array(audioBuffer.getChannelData(i)));
  }

  return {
    sampleRate: audioBuffer.sampleRate,
    length: audioBuffer.length,
    numberOfChannels: audioBuffer.numberOfChannels,
    channels
  };
}

function updatePlaybackRate(rate) {
  if (filePlaybackSource) {
    filePlaybackSource.playbackRate.setValueAtTime(rate, audioContext.currentTime);
  }
}

function getCurrentPlayPosition() {
  if (!filePlaybackSource || !filePlaybackStartTime) return playbackPauseTime;
  return audioContext.currentTime - filePlaybackStartTime;
}

function applyEffectState(state) {
  if (!audioContext) ensureAudioContext();

  // Note: This is a simplified version. For full effect application,
  // we would need to import the plugin system from popup.js
  // For now, just apply basic volume/gain
  outputGainNode.gain.value = state.volume || 1.0;
  preGainNode.gain.value = state.preGain || 1.0;
  dryGainNode.gain.value = state.dryGain || 0;
  wetGainNode.gain.value = state.wetGain || 1;
}

// ============= MESSAGE HANDLERS =============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message.type) {
      case "playRecordedAudio":
        playRecordedAudio(message.trimStart || 0, message.trimEnd || 0);
        sendResponse({ success: true });
        break;

      case "pauseRecordedAudio":
        pauseRecordedAudio();
        sendResponse({ success: true });
        break;

      case "resumeRecordedAudio":
        resumeRecordedAudio();
        sendResponse({ success: true });
        break;

      case "stopRecordedAudio":
        stopRecordedAudio();
        sendResponse({ success: true });
        break;

      case "setLoadedAudioBuffer":
        if (message.audioData) {
          const decoded = decodeAudioDataForTransfer(message.audioData);
          setLoadedAudioBuffer(decoded);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "No audioData provided" });
        }
        break;

      case "updatePlaybackRate":
        updatePlaybackRate(message.rate);
        sendResponse({ success: true });
        break;

      case "applyEffectState":
        applyEffectState(message.state);
        sendResponse({ success: true });
        break;

      case "getPlaybackState":
        sendResponse({
          isPlaying: filePlaybackSource !== null,
          isPaused: playbackIsPaused,
          position: getCurrentPlayPosition(),
          audioBufferLoaded: loadedAudioBuffer !== null
        });
        break;

      case "CACHE_SESSION_STATE": {
        const payload = message.sessionState || {};
        _sessionCache = {
          loadedAudioData: payload.loadedAudioData || null,
          sourceStemAudioDataByName: payload.sourceStemAudioDataByName || null,
          waveformSessionState: payload.waveformSessionState || null,
          sourceStemMixSettings: payload.sourceStemMixSettings || null,
          updatedAt: Date.now()
        };
        sendResponse({ success: true, cached: true, updatedAt: _sessionCache.updatedAt });
        break;
      }

      case "GET_SESSION_STATE": {
        sendResponse({
          success: true,
          sessionState: {
            loadedAudioData: _sessionCache.loadedAudioData || null,
            sourceStemAudioDataByName: _sessionCache.sourceStemAudioDataByName || null,
            waveformSessionState: _sessionCache.waveformSessionState || null,
            sourceStemMixSettings: _sessionCache.sourceStemMixSettings || null,
            updatedAt: _sessionCache.updatedAt || 0
          }
        });
        break;
      }

      case "CACHE_CURRENT_LOADED_AUDIO": {
        _sessionCache.loadedAudioData = encodeAudioBufferForTransfer(loadedAudioBuffer);
        _sessionCache.updatedAt = Date.now();
        sendResponse({ success: true, cached: Boolean(_sessionCache.loadedAudioData) });
        break;
      }

      case "DOWNLOAD_BEGIN":
        // Start of a chunked download transfer from the popup.
        _dlChunks = new Array(message.totalChunks);
        _dlFilename = message.filename || "audio-mixer-download";
        _dlTotalChunks = message.totalChunks;
        sendResponse({ success: true });
        break;

      case "DOWNLOAD_CHUNK":
        // One 16 MB slice of the blob payload.
        if (_dlChunks && message.index < _dlTotalChunks) {
          _dlChunks[message.index] = new Uint8Array(message.buffer);
        }
        sendResponse({ success: true });
        break;

      case "DOWNLOAD_FINALIZE": {
        // Guard: if DOWNLOAD_BEGIN was never received (e.g. offscreen wasn't
        // ready when it was sent), _dlTotalChunks is 0 and _dlChunks is empty.
        // Triggering chrome.downloads with a 0-byte blob would fire the download
        // shelf and close the popup with nothing saved — bail out instead.
        const totalBytes = (_dlChunks || []).reduce((s, c) => s + (c ? c.length : 0), 0);
        if (_dlTotalChunks === 0 || totalBytes === 0) {
          console.warn("[Offscreen] DOWNLOAD_FINALIZE with no data — ignoring (transfer not started)");
          sendResponse({ success: false, error: "No transfer in progress" });
          break;
        }
        const merged = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of _dlChunks) {
          if (chunk) { merged.set(chunk, offset); offset += chunk.length; }
        }
        _dlChunks = [];
        const dlBlob = new Blob([merged], { type: "audio/wav" });
        // Call chrome.downloads.download() directly from the offscreen context.
        // Offscreen docs are extension pages with full API access. Triggering
        // the download here (not via background) keeps it invisible to the popup's
        // focus lifecycle — background-initiated downloads can still cause Chrome
        // to briefly focus the browser window and close the popup.
        // Blob URLs from the offscreen context aren't accessible to the downloads
        // manager, so we convert to a self-contained data URL first.
        const dlReader = new FileReader();
        dlReader.onload = () => {
          chrome.downloads.download(
            { url: dlReader.result, filename: _dlFilename, saveAs: false },
            (downloadId) => {
              void chrome.runtime.lastError;
              sendResponse({ success: true, downloadId: downloadId ?? null });
            }
          );
        };
        dlReader.readAsDataURL(dlBlob);
        return true; // keep channel open for async sendResponse
      }

      default:
        console.warn("[Offscreen] Unknown message type:", message.type);
        sendResponse({ success: false, error: "Unknown message type" });
    }
  } catch (error) {
    console.error("[Offscreen] Error handling message:", error);
    sendResponse({ success: false, error: error.message });
  }
});

console.log("[Offscreen] Audio playback manager initialized");
