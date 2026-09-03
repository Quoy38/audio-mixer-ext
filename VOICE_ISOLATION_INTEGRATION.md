# Voice Isolation Integration Guide

> ⚠️ **HISTORICAL / SUPERSEDED.** Early integration notes for the ONNX placeholder approach.
> Current isolation runs through the Demucs companion prepared full-track flow — see
> [`AGENTS.md`](AGENTS.md). Kept for history only.

## Current Status

✅ **UI Complete** - Voice isolation controls fully integrated  
✅ **Architecture Ready** - Processor class and routing prepared  
⏳ **AI Model Pending** - Placeholder implementation active  

## What's Been Implemented

### 1. User Interface
- **Enable Voice Isolation** toggle (orange highlighted)
- **Isolation Strength** slider (0-100%)
- **Processing Delay** slider (0-3 seconds for video sync)
- Status indicator showing current state
- Integrated into popup.html with clear explanations

### 2. Code Architecture
- `VoiceIsolationProcessor` class in popup.js
- Settings persistence (saves user preferences)
- Event handlers for all controls
- Audio graph routing preparation
- Buffer management infrastructure

### 3. Settings Storage
All voice isolation settings are saved:
- Enabled/disabled state
- Isolation strength
- Processing delay preference

## Next Steps: Adding the AI Model

### Option 1: ONNX Runtime Web (Recommended)

**What you need:**
1. Add ONNX Runtime Web library
2. Get a voice isolation model (see options below)
3. Integrate into `VoiceIsolationProcessor`

**Implementation:**

#### Step 1: Add ONNX Runtime to manifest.json
```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

#### Step 2: Download ONNX Runtime Web
```bash
cd popup
npm init -y
npm install onnxruntime-web
```

Or use CDN in popup.html:
```html
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js"></script>
```

#### Step 3: Get a Voice Isolation Model

**Recommended Models:**

**Facebook Denoiser (Best Quality)**
- Download: https://github.com/facebookresearch/denoiser
- Size: ~6 MB
- Quality: Excellent for voice isolation
- Processing: 50-200ms per chunk

**RNNoise (Lightest)**
- Download: https://github.com/xiph/rnnoise
- Size: ~500 KB
- Quality: Good for noise removal, okay for music
- Processing: 10-50ms per chunk

**Silero VAD + Denoiser (Balanced)**
- Download: https://github.com/snakers4/silero-vad
- Size: ~2-5 MB
- Quality: Very good for speech
- Processing: 30-100ms per chunk

#### Step 4: Update VoiceIsolationProcessor

Replace the placeholder in `popup.js`:

```javascript
class VoiceIsolationProcessor {
  constructor() {
    this.isInitialized = false;
    this.model = null;
    this.session = null;
    this.bufferSize = 480; // 10ms at 48kHz
    this.sampleRate = 48000;
  }

  async initialize(context) {
    console.log("[Voice Isolation] Initializing with ONNX...");
    
    try {
      this.sampleRate = context.sampleRate;
      
      // Load ONNX Runtime session
      const modelPath = chrome.runtime.getURL('models/denoiser.onnx');
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'], // Use WebAssembly
        graphOptimizationLevel: 'all'
      });
      
      console.log("[Voice Isolation] Model loaded successfully");
      this.isInitialized = true;
      return true;
      
    } catch (error) {
      console.error("[Voice Isolation] Model load failed:", error);
      return false;
    }
  }

  async processAudio(inputBuffer, strength = 0.8) {
    if (!this.isInitialized || !this.session) {
      return inputBuffer;
    }

    try {
      const audioData = inputBuffer.getChannelData(0);
      
      // Prepare input tensor (depends on model requirements)
      const inputTensor = new ort.Tensor('float32', audioData, [1, audioData.length]);
      
      // Run inference
      const outputs = await this.session.run({ input: inputTensor });
      
      // Extract denoised audio
      const denoisedData = outputs.output.data;
      
      // Mix denoised with original based on strength
      const outputBuffer = inputBuffer.getContext().createBuffer(
        inputBuffer.numberOfChannels,
        inputBuffer.length,
        inputBuffer.sampleRate
      );
      
      const outputData = outputBuffer.getChannelData(0);
      for (let i = 0; i < audioData.length; i++) {
        outputData[i] = audioData[i] * (1 - strength) + denoisedData[i] * strength;
      }
      
      return outputBuffer;
      
    } catch (error) {
      console.error("[Voice Isolation] Processing error:", error);
      return inputBuffer;
    }
  }

  async cleanup() {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.isInitialized = false;
  }
}
```

#### Step 5: Add Model to Extension

1. Create `models/` folder in extension root
2. Download your chosen model (e.g., `denoiser.onnx`)
3. Update `manifest.json`:

```json
{
  "web_accessible_resources": [{
    "resources": ["models/*.onnx"],
    "matches": ["<all_urls>"]
  }]
}
```

#### Step 6: Integrate with Audio Graph

In `buildAudioGraph()`, add buffer processing:

```javascript
// Create ScriptProcessor or AudioWorklet for streaming
const processorNode = audioContext.createScriptProcessor(4096, 1, 1);

processorNode.onaudioprocess = async (event) => {
  if (!voiceIsolationEnabled) {
    // Passthrough
    event.outputBuffer.getChannelData(0).set(
      event.inputBuffer.getChannelData(0)
    );
    return;
  }

  // Process through voice isolation
  const processed = await voiceIsolationProcessor.processAudio(
    event.inputBuffer,
    voiceIsolationStrength
  );
  
  event.outputBuffer.getChannelData(0).set(
    processed.getChannelData(0)
  );
};

// Wire into graph: inputSource → processor → bassNode
inputSourceNode.connect(processorNode);
processorNode.connect(bassNode);
```

### Option 2: Cloud API (Simpler But Costs Money)

Use a service like:
- **Krisp.ai API** - Real-time noise cancellation
- **Dolby.io API** - Voice isolation
- **AssemblyAI** - Real-time transcription + isolation

**Example with custom backend:**

```javascript
async function processAudio(audioChunk) {
  const formData = new FormData();
  formData.append('audio', audioChunk);
  
  const response = await fetch('https://your-backend.com/isolate', {
    method: 'POST',
    body: formData
  });
  
  return await response.blob(); // Isolated audio
}
```

### Option 3: Local Python Server (Best Quality, Free)

Run a local server using Demucs or Spleeter:

```python
# server.py
from demucs import pretrained
from demucs.apply import apply_model
import asyncio
import websockets

model = pretrained.get_model('htdemucs')

async def process_audio(websocket, path):
    async for message in websocket:
        # Process audio chunk
        isolated = apply_model(model, audio_data, device='cpu')
        await websocket.send(isolated['vocals'])

asyncio.get_event_loop().run_until_complete(
    websockets.serve(process_audio, 'localhost', 8765)
)
```

Then in extension:
```javascript
const ws = new WebSocket('ws://localhost:8765');
ws.send(audioChunk);
ws.onmessage = (event) => {
  // Play isolated audio
};
```

## Testing the Current Implementation

1. Load the extension
2. Start capture on a YouTube video
3. Click "Enable Voice Isolation"
4. Check console logs - you'll see placeholder messages
5. UI controls are fully functional
6. Settings persist across sessions

## Performance Considerations

- **ONNX models**: 50-200ms latency per chunk
- **Buffer size**: Use 4096 samples (85ms at 48kHz)
- **Processing delay**: 1-2 seconds total (acceptable for video watching)
- **CPU usage**: 10-30% on modern processors
- **Memory**: 50-200 MB for model + buffers

## Debugging

Enable verbose logging:
```javascript
console.log("[Voice Isolation] Enabled:", voiceIsolationEnabled);
console.log("[Voice Isolation] Strength:", voiceIsolationStrength);
console.log("[Voice Isolation] Delay:", voiceProcessingDelay);
```

Check if model loaded:
```javascript
if (voiceIsolationProcessor.isInitialized) {
  console.log("Model ready!");
}
```

## Future Enhancements

1. **Multiple model options** - Let users choose quality vs speed
2. **GPU acceleration** - Use WebGL/WebGPU for faster processing
3. **Real-time preview** - Visual indicator of isolation quality
4. **Auto-sync** - Automatic video delay compensation
5. **Preset modes** - "Movie Dialogue", "Music Vocals", "Podcast"

## Resources

- ONNX Runtime Web: https://onnxruntime.ai/docs/get-started/with-javascript.html
- Facebook Denoiser: https://github.com/facebookresearch/denoiser
- RNNoise: https://github.com/xiph/rnnoise
- Silero Models: https://github.com/snakers4/silero-models
- Web Audio API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API

## Support

The architecture is ready - you just need to drop in the AI model. Start with RNNoise (smallest, easiest) and upgrade to Facebook Denoiser for better quality once it works.
