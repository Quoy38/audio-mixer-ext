/**
 * Real-Time Vocal Isolation – Center-Subtraction Processor
 *
 * Instrumental mode (karaoke / vocal removal):
 *   outL = L - strength * mid
 *   outR = R - strength * mid
 *   Subtracts the center-panned signal from each channel so vocals
 *   (and any other center-panned content) are reduced.
 *
 * Vocals mode (center isolation):
 *   outL = mid + side*(1 - strength)
 *   outR = mid - side*(1 - strength)
 *   Keeps the center channel and attenuates stereo spread.
 *
 * A 15% dry floor is always mixed in so that even for purely mono sources
 * (where mid = L = R and center subtraction would give exactly 0) the output
 * is never completely silent.
 *
 * Zero latency – processes sample-by-sample in the audio thread.
 */

class VoiceIsolationWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode     = 'vocals'; // 'vocals' | 'instrumental'
    this.strength = 1.0;      // 0–1
    this.port.onmessage = (event) => {
      const { type, mode, strength } = event.data;
      if (type === 'update-mode') {
        this.mode = mode === 'instrumental' ? 'instrumental' : 'vocals';
      } else if (type === 'update-strength') {
        this.strength = Math.max(0, Math.min(1, Number(strength) || 0));
      }
    };
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];

    if (!input || !input[0] || !output || !output[0]) {
      return true;
    }

    const L    = input[0];
    const R    = (input[1] && input[1].length === L.length) ? input[1] : null;
    // When Chrome up-mixes a mono capture to 2-ch, input[1] equals input[0] (L === R).
    // The formula handles that naturally via the DRY_FLOOR – no special passthrough needed.
    const outL = output[0];
    const outR = output[1] || output[0];

    const strength       = this.strength;
    const isInstrumental = this.mode === 'instrumental';
    // 15% dry floor: guarantees audible output even for mono sources where
    // center subtraction at full strength would otherwise yield zero.
    const DRY_FLOOR = 0.15;

    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      const r = R ? R[i] : l; // treat mono input (no R channel) as L === R

      const mid  = (l + r) * 0.5;
      const side = (l - r) * 0.5;

      let procL, procR;
      if (isInstrumental) {
        // Center-subtraction: remove mid from each channel independently.
        // Unlike zeroing outMid then decoding (which gives L=-R, out-of-phase),
        // this preserves correct channel polarity and avoids downstream cancellation.
        procL = l - strength * mid;
        procR = r - strength * mid;
      } else {
        // Center isolation: keep mid, attenuate stereo spread.
        procL = mid + side * (1 - strength);
        procR = mid - side * (1 - strength);
      }

      // Blend: (1 - DRY_FLOOR) * processed + DRY_FLOOR * dry.
      // At strength=1 with mono (l === r): procL = 0, outL = 0.15 * l — not silent.
      outL[i] = (1 - DRY_FLOOR) * procL + DRY_FLOOR * l;
      outR[i] = (1 - DRY_FLOOR) * procR + DRY_FLOOR * r;
    }

    return true;
  }
}

registerProcessor('voice-isolation-processor', VoiceIsolationWorkletProcessor);
