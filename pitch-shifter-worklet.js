class PitchShifterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // 4 evenly-staggered heads: sum of normalized Hann windows = 1.0 at every sample,
    // so there is zero amplitude modulation (no vibrato / pitch-bending artifact).
    this.NUM_HEADS  = 4;
    this.bufferSize = 65536;
    // W=8192: resets every ~170ms at 48kHz (rare enough to avoid splice artifacts).
    // step = W/N = 2048 samples (42ms) — head spacing is sub-audible for comb filtering.
    // latency=16384: closest head (k=3) starts 10240 samples behind write pointer.
    //   Safety margin at r=2 (+12st): 10240 - W*(r-1) = 10240 - 8192 = 2048 > 0 ✓
    //   No head can ever overtake the write pointer within a phase cycle at any ratio ≤ 2.
    this.windowSize = 8192;
    this.latency    = 16384;
    this.matchLength = 128;
    this.searchRadius = 384;
    this.levelSmoothing = 0.0025;

    this.targetRatio  = 1.0;
    this.currentRatio = 1.0;
    this.channelState = [];

    this.port.onmessage = ({ data = {} }) => {
      if (data.type === "setPitchSemitones") {
        this.targetRatio = Math.pow(2, Number(data.semitones) / 12);
      }
    };
  }

  ensureChannelState(n) {
    const { bufferSize: bs, windowSize: W, latency: lat, NUM_HEADS: N } = this;
    const step = Math.floor(W / N);
    while (this.channelState.length < n) {
      const heads = [];
      for (let k = 0; k < N; k++) {
        heads.push({
          readPos: (bs - lat + k * step) % bs,
          phase:   k / N
        });
      }
      this.channelState.push({
        buffer:   new Float32Array(bs),
        writeIdx: 0,
        heads,
        // 1-pole IIR lowpass state for anti-alias pre-filtering (one per channel)
        lpState:  0,
        inputEnergy: 1e-4,
        outputEnergy: 1e-4,
        lastOut:  0
      });
    }
  }

  // 4-point Catmull-Rom Hermite — preserves high frequencies that linear interp smears
  hermite(buf, pos) {
    const bs = this.bufferSize;
    const i1 = ((Math.floor(pos) % bs) + bs) % bs;
    const i0 = (i1 - 1 + bs) % bs;
    const i2 = (i1 + 1) % bs;
    const i3 = (i1 + 2) % bs;
    const f  = pos - Math.floor(pos);
    const p0 = buf[i0], p1 = buf[i1], p2 = buf[i2], p3 = buf[i3];
    const m1 = 0.5 * (p2 - p0);
    const m2 = 0.5 * (p3 - p1);
    const f2 = f * f, f3 = f2 * f;
    return (2*f3 - 3*f2 + 1)*p1 + (f3 - 2*f2 + f)*m1 + (-2*f3 + 3*f2)*p2 + (f3 - f2)*m2;
  }

  findBestResetPosition(buf, referencePos, targetPos) {
    const bs = this.bufferSize;
    const refStart = ((Math.floor(referencePos) % bs) + bs) % bs;
    const targetStart = ((Math.floor(targetPos) % bs) + bs) % bs;
    const frac = referencePos - Math.floor(referencePos);
    let bestPos = targetStart;
    let bestScore = -Infinity;

    for (let offset = -this.searchRadius; offset <= this.searchRadius; offset += 1) {
      const candidateStart = (targetStart + offset + bs) % bs;
      let dot = 0;
      let energyRef = 1e-9;
      let energyCandidate = 1e-9;

      for (let sample = 0; sample < this.matchLength; sample += 1) {
        const ref = buf[(refStart + sample) % bs];
        const candidate = buf[(candidateStart + sample) % bs];
        dot += ref * candidate;
        energyRef += ref * ref;
        energyCandidate += candidate * candidate;
      }

      const score = dot / Math.sqrt(energyRef * energyCandidate);
      if (score > bestScore) {
        bestScore = score;
        bestPos = candidateStart;
      }
    }

    return (bestPos + frac + bs) % bs;
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !output || !output.length) return true;

    const nCh = Math.min(input.length || 1, output.length);
    this.ensureChannelState(nCh);

    this.currentRatio += (this.targetRatio - this.currentRatio) * 0.015;

    const ratio  = this.currentRatio;
    const bypass = Math.abs(ratio - 1) < 5e-4;
    const { bufferSize: bs, windowSize: W, latency: lat, NUM_HEADS: N } = this;
    const invW = 1 / W;
    const invN = 1 / N;
    const step = Math.floor(W * invN);

    // Anti-alias pre-filter coefficient.
    // When shifting up, the read pointer skips samples, effectively lowering the
    // Nyquist limit. We attenuate above (sampleRate/2 / ratio) before writing to
    // the buffer so those frequencies can't alias back in as distortion.
    // The cutoff tracks the ratio: higher upshift = more aggressive filtering.
    // For downshifts (ratio < 1) no pre-filtering is needed.
    const lpCutoff = ratio > 1 ? Math.min(0.475 / Math.sqrt(ratio), 0.48) : 0.48;
    // 1-pole IIR coefficient: c = 1 - exp(-2π·fc).  At fc=0.48 this is nearly 1 (flat).
    const lpCoeff  = 1 - Math.exp(-2 * Math.PI * lpCutoff);

    for (let ch = 0; ch < nCh; ch++) {
      const inCh  = input[ch] || input[0];
      const outCh = output[ch];
      const st    = this.channelState[ch];
      if (!inCh || !outCh) continue;

      for (let i = 0; i < outCh.length; i++) {
        const drySample = inCh[i] || 0;
        // 1-pole lowpass anti-alias filter on input before writing to delay buffer
        st.lpState += lpCoeff * (drySample - st.lpState);
        st.buffer[st.writeIdx] = st.lpState;

        if (bypass) {
          outCh[i] = drySample;
          st.inputEnergy += this.levelSmoothing * ((drySample * drySample) - st.inputEnergy);
          st.outputEnergy += this.levelSmoothing * ((drySample * drySample) - st.outputEnergy);
        } else {
          let y = 0;
          let weightSum = 0;
          for (let k = 0; k < N; k++) {
            const head = st.heads[k];

            // Normalized Hann weight — N evenly-spaced heads always sum to exactly 1.0
            const w = (1 - Math.cos(2 * Math.PI * head.phase)) * invN;
            weightSum += w;
            y += w * this.hermite(st.buffer, head.readPos);

            head.readPos = (head.readPos + ratio + bs) % bs;
            head.phase  += invW;

            if (head.phase >= 1) {
              head.phase  -= 1;
              // Match the new grain to the outgoing one so resets do not sound like stutters.
              const targetPos = (st.writeIdx - lat + k * step + bs) % bs;
              head.readPos = this.findBestResetPosition(st.buffer, head.readPos, targetPos);
            }
          }

          if (weightSum > 1e-6) {
            y /= weightSum;
          }

          st.inputEnergy += this.levelSmoothing * ((drySample * drySample) - st.inputEnergy);
          st.outputEnergy += this.levelSmoothing * ((y * y) - st.outputEnergy);

          const loudnessMatch = Math.sqrt((st.inputEnergy + 1e-6) / (st.outputEnergy + 1e-6));
          const makeupGain = Math.max(0.95, Math.min(1.3, loudnessMatch));
          y *= makeupGain;

          outCh[i]   = Number.isFinite(y) ? y : st.lastOut;
          st.lastOut = outCh[i];
        }

        st.writeIdx = (st.writeIdx + 1) % bs;
      }
    }

    return true;
  }
}

registerProcessor("pitch-shifter-processor", PitchShifterProcessor);
