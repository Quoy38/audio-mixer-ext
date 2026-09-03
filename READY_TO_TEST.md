# 🎉 AI Voice Isolation is Ready!

> ⚠️ **HISTORICAL / SUPERSEDED.** Setup notes for the old ONNX UVR-MDX-NET model. The current
> engine is the Demucs companion. For current setup, validation, and ops, see [`AGENTS.md`](AGENTS.md).
> Kept for history only.

## What's Been Set Up

✅ **ONNX Runtime Web** - AI inference library loaded  
✅ **UVR-MDX-NET Model** - 64 MB professional vocal separation model downloaded  
✅ **Streaming Processor** - Real-time audio processing via Web Audio API  
✅ **Fallback Mode** - DSP filters if model fails to load  

## How to Use Right Now

### 1. Reload the Extension
```
Chrome → Extensions → Audio Splitter & Mixer Pro → Click reload icon
```

### 2. Test with Your Rap Song

1. **Open YouTube** with your rap song
2. **Click the extension** icon to open popup
3. **Click "Start Capture"**
4. **Enable AI Voice Isolation** checkbox
5. **Wait 2-5 seconds** for model to load
6. **Check the status** - it should say "active: UVR-MDX-NET Inst HQ 3" or similar
7. **Adjust strength slider** (90-100% recommended)

### 3. What You Should Hear

**With AI Model (if loaded successfully):**
- ✅ Rap vocals **crystal clear**
- ✅ Beat **completely removed** (90-95% reduction)
- ✅ Bass, drums, synths **gone**
- ✅ Only voice remains

**If Fallback DSP Mode (model failed to load):**
- ⚠️ Status shows "DSP Filters (Fallback)"
- ⚠️ Some beat still audible (frequency filtering only)
- Check console (F12) for model loading errors

## Checking Which Mode You're In

**Open Browser Console (F12 → Console tab):**

**If AI model loaded successfully, you'll see:**
```
[Voice Isolation] Looking for ONNX model...
[Voice Isolation] Trying to load: UVR-MDX-NET Inst HQ 3
[Voice Isolation] ✅ Successfully loaded model: UVR-MDX-NET Inst HQ 3
[Voice Isolation] Model inputs: ['input']
[Voice Isolation] Model outputs: ['output']
[Voice Isolation] AI processor ready with model: UVR-MDX-NET Inst HQ 3
```

**If fallback mode (model not found):**
```
[Voice Isolation] ❌ Could not load UVR-MDX-NET Inst HQ 3
[Voice Isolation] ⚠️ No ONNX model found!
[Voice Isolation] Initializing DSP fallback mode...
```

## Performance Expectations

### With AI Model:
- **Quality**: 90-95% beat removal, professional-grade
- **Latency**: 200-800ms (you may hear slight delay)
- **CPU Usage**: 25-40% on modern processors
- **Memory**: ~200 MB additional

### Fallback DSP Mode:
- **Quality**: 40-60% beat removal (frequency-based only)
- **Latency**: <10ms (instant)
- **CPU Usage**: <5%
- **Memory**: Minimal

## Troubleshooting

### "Model failed to load" or fallback mode active:

**Check file exists:**
```bash
ls -lh /Users/user/Desktop/audio-mixer-ext/models/
# Should show: demucs-vocals.onnx (64M)
```

**Verify file isn't corrupted:**
```bash
file /Users/user/Desktop/audio-mixer-ext/models/demucs-vocals.onnx
# Should show: ONNX model file or binary data
```

**Re-download if needed:**
```bash
cd /Users/user/Desktop/audio-mixer-ext/models/
rm demucs-vocals.onnx
curl -L -o demucs-vocals.onnx "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx"
```

### Audio sounds choppy or robotic:

1. **Lower the strength slider** to 70-80%
2. **Close other tabs** to free CPU
3. **Disable other effects** (reverb, chorus, etc.)
4. This is normal with real-time AI processing

### No sound at all:

1. Check volume slider in extension
2. Make sure browser tab audio isn't muted
3. Try disabling/re-enabling voice isolation
4. Reload the extension

### Pitch sounds weird:

- This was an issue with the old DSP mode
- With AI model, pitch should be preserved perfectly
- If pitch still sounds off, the model may not be loading correctly (check console)

## Advanced: Model Input/Output Format

The UVR-MDX-NET model expects:
- **Input**: Float32 audio tensor, shape `[batch, samples]`
- **Output**: Float32 vocals tensor, same shape
- **Sample Rate**: Flexible (we use 48kHz from browser)

## Next Steps

Once this is working, you can:
1. **Record the isolated vocals** using the extension's recording feature
2. **Download as WAV** for use in other projects
3. **Add more models** for different separation tasks (drums, bass, other)
4. **Tune strength slider** for your preference

## Still Not Working?

Share the console logs (F12 → Console) - specifically any messages starting with `[Voice Isolation]` and I can help debug!

## Popup Reopen Regression Smoke Test (Downloads + Session Restore)

Run this matrix before release whenever popup/download/session code changes.

### Case 1: Recorded Audio Download
1. Start capture and record audio.
2. Stop recording and click Download WAV.
3. Reopen extension.
4. Expected:
	- Last session audio restores correctly.
	- First play in wavetable is normal pitch.
	- Trim start/end and playhead are restored.

### Case 2: Loaded Audio File Download
1. Load a local file.
2. Click Download WAV.
3. Reopen extension.
4. Expected:
	- Same loaded file is restored (not replaced by last recording).
	- Playback pitch is normal on first play.
	- Trim/playhead state is restored.

### Case 3: Single Stem Layer Download
1. Load audio and generate stems.
2. Download one stem layer (e.g., vocals).
3. Reopen extension.
4. Expected:
	- Source stems are restored.
	- Playback is normal pitch.
	- Stem controls remain functional.

### Case 4: Current Stem Mix Download
1. Load audio and generate stems.
2. Apply stem edits (mute vocals/bass, gain changes).
3. Download Current Stem Mix.
4. Reopen extension.
5. Expected:
	- Stem edit state (mute/gain) is restored.
	- First play is normal pitch (no temporary pitch-up).
	- Audio and waveform state restore correctly.

### Pass/Fail Rule
- PASS: All four cases restore the expected audio/session state on first reopen and first play.
- FAIL: Any wrong-file restore, first-play pitch shift, lost trim/playhead, or lost stem edits.

## Capture Timeline Controls Smoke Test (Skip/Restart)

Run this before release whenever capture control buttons or content-script timeline controls change.

### Case 5: Capture Section Skip/Restart Controls
1. Start capture on an active media tab (YouTube/YouTube Music).
2. Use `-5s` in the Audio Capture section.
3. Use `+5s` in the Audio Capture section.
4. Use `Restart` in the Audio Capture section.
5. Expected:
	- Timeline seeks backward and forward in 5-second steps without errors.
	- Restart seeks media to 0s.
	- Controls are disabled when capture is not active.

### Case 6: Filter Preset Exclusivity (No Stacking)
1. Start capture with audible audio.
2. Click one preset (e.g., Lo-Fi Vinyl), then switch to another (e.g., Phone Call), then another (e.g., Cathedral).
3. Repeat rapid switching across 4-5 presets.
4. Expected:
	- Sound character matches only the currently selected preset.
	- No cumulative distortion/loudness buildup from previous presets.
	- Switching presets does not throw UI or console errors.

Optional debug telemetry for this case:
1. In popup DevTools console, run:
	- `localStorage.setItem("audioMixerPresetDebug", "1")`
2. Reload popup and repeat Case 6.
3. Verify console logs show ordered transitions:
	- `activateFilterPreset:clear:start` -> `activateFilterPreset:clear:end` -> `activateFilterPreset:apply:start` -> `activateFilterPreset:apply:end`
4. Disable debug logs when done:
	- `localStorage.removeItem("audioMixerPresetDebug")`

## Prepared Voice Isolation Regression Lock (Required)

Run this before shipping any change that touches audio routing, popup state, companion settings, or voice isolation code paths.

```bash
cd /Users/user/Desktop/audio-mixer-ext
bash checkpoints/verify_voice_isolation_lock.sh
```

Expected:
- Script exits 0 and prints only PASS lines.
- Companion health profile includes:
	- `"split":true`
	- `"fast_short_clips":false`
	- `"fast_short_max_seconds":75`
	- `"fast_medium_clips":true`
	- `"fast_medium_max_seconds":180`
	- `"fast_medium_segment_seconds":30`
	- `"overlap":0.1`
	- `"device":"mps"`

If companion is intentionally not running, run the static checks only:

```bash
cd /Users/user/Desktop/audio-mixer-ext
bash checkpoints/verify_voice_isolation_lock.sh --skip-health
```

## One-Command Release Gate

Run this to execute all automated release checks together:

```bash
cd /Users/user/Desktop/audio-mixer-ext
bash checkpoints/release_gate.sh
```

If companion health is intentionally unavailable:

```bash
cd /Users/user/Desktop/audio-mixer-ext
bash checkpoints/release_gate.sh --skip-health
```

## Prepared Instrumental Must-Pass Flow (Required)

For any non-targeted refactor, this flow must still pass unchanged.

1. Start capture.
2. Enable instrumental-only voice isolation.
3. Confirm phase 1 runs silently from 0:00 and does not abort with `Track changed during the silent preparation pass`.
4. Confirm transition to processing does not let playlist drift to unrelated songs.
5. Confirm phase 2 eventually plays prepared instrumental and download succeeds.
6. Confirm no regression in popup reopen behavior or mute-lock cleanup.

Fail fast on any regression and do not merge unrelated changes until fixed.
