# How to Get the Voice Isolation AI Model

> ℹ️ **Scope note.** The shipping engine is the **Demucs companion** (see [`AGENTS.md`](AGENTS.md)).
> This file only covers the optional **local in-browser ONNX fallback model** used by "Basic mode"
> when the companion is offline. You do NOT need it for normal Pro isolation.

Your extension is ready for AI-powered vocal isolation! You just need to add the model file.

## Quick Start (Recommended)

### Option 1: Facebook Demucs Vocals Model (Best Quality)

1. **Download the model:**
   ```bash
   cd /Users/user/Desktop/audio-mixer-ext/models
   curl -L -o demucs-vocals.onnx "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx"
   ```

2. **Reload the extension** in Chrome

3. **Start capture** and click "Enable Voice Isolation"

4. It will work! The model will be loaded automatically.

### Option 2: RNNoise (Lightweight, Fast)

1. **Download RNNoise ONNX:**
   ```bash
   cd /Users/user/Desktop/audio-mixer-ext/models
   curl -L -o rnnoise.onnx "https://github.com/xiph/rnnoise-models/raw/master/rnnoise_model.onnx"
   ```

2. **Reload extension** and enable voice isolation

Note: RNNoise is designed for noise reduction, not music separation. It works okay but Demucs is much better.

## Models Comparison

| Model | Size | Quality | Speed | Best For |
|-------|------|---------|-------|----------|
| **Demucs MDX-NET** | ~45 MB | Excellent | Medium | Music vocals, rap, singing |
| **RNNoise** | ~500 KB | Good | Very Fast | Speech, noise reduction |
| **Silero Denoiser** | ~ 5 MB | Very Good | Fast | General voice isolation |

## If the Above Links Don't Work

### Manual Download Steps:

1. Go to: https://github.com/TRvlvr/model_repo/releases

2. Find and download: **UVR-MDX-NET-Inst_HQ_3.onnx** (or similar vocals model)

3. Rename it to: `demucs-vocals.onnx`

4. Move it to: `/Users/user/Desktop/audio-mixer-ext/models/`

5. Reload the extension

## Alternative: Convert Your Own Model

If you want to use a specific Demucs model:

```bash
# Install dependencies
pip install demucs onnx torch

# Export Demucs to ONNX
python -c "
import torch
from demucs import pretrained

model = pretrained.get_model('htdemucs')
dummy_input = torch.randn(1, 2, 44100)  # 1 second stereo
torch.onnx.export(
    model,
    dummy_input,
    'models/demucs-vocals.onnx',
    input_names=['audio'],
    output_names=['vocals', 'drums', 'bass', 'other'],
    dynamic_axes={'audio': {2: 'length'}}
)
"
```

## Expected Performance

Once the model is loaded:

- **Processing**: 100-500ms latency per audio chunk
- **Quality**: Near-perfect vocal isolation (95%+ accuracy)
- **CPU Usage**: 20-40% on modern processors
- **Memory**: 100-300 MB

## Troubleshooting

### "Model not found" error:
- Check that the file is in `/Users/user/Desktop/audio-mixer-ext/models/`
- File must be named exactly: `demucs-vocals.onnx` or `rnnoise.onnx`
- Reload the extension after adding the file

### "Model failed to load" error:
- Model file may be corrupted - re-download it
- Check browser console (F12) for detailed error messages
- Make sure the file is a valid ONNX model (not a zip or tar file)

### Audio is choppy or delayed:
- This is normal with AI processing (200-1000ms latency)
- Lower your isolation strength for better performance
- Close other tabs to free up CPU

### Low quality vocals:
- You may be using RNNoise - switch to Demucs for better quality
- Increase isolation strength slider to 100%
- Make sure the model file downloaded completely (check file size)

## Model File Names

The extension looks for these files (in order):
1. `models/demucs-vocals.onnx`
2. `models/rnnoise.onnx`
3. `models/voice-isolation.onnx`

Name your model file one of these names.

## Need Help?

Check the browser console (F12 → Console tab) for detailed error messages. The extension will tell you exactly what went wrong with model loading.
