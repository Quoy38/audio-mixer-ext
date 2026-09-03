#!/usr/bin/env python3
"""Output-parity / drift harness for the Demucs companion engine.

Purely additive preservation tool (see AGENTS.md prime directive + DISTRIBUTION_MEGA_PLAN
§0.5). It does NOT import or modify any project code. It talks to the running companion
over the same HTTP contract the extension uses (POST /v1/stems/split, raw WAV body +
X-Requested-Stems header) and asserts the engine's output has not silently drifted.

What it guards:
  * A deterministic synthetic fixture (pure math + a fixed-seed generator) is separated by
    the local engine. Per-stem spectral fingerprints + RMS are compared against a saved
    golden baseline within tolerance -> catches SILENT output drift across code/dep/model
    versions (drift vectors #1/#2 in AGENTS.md).
  * The structural invariant instrumental == drums + bass + other is verified every run via
    SI-SDR, independent of any golden -> catches a broken synthesis path immediately.

Modes:
  --mode baseline   Separate the fixture and WRITE the golden file for the engine's model.
  --mode check      Separate the fixture and COMPARE against the golden (non-zero exit on drift).

The golden is per-model (golden/<model>_<samplerate>.json), so the sanctioned htdemucs <-> 
htdemucs_ft swap is handled by simply capturing a new baseline, never by weakening the check.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import urllib.request
import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 44100
DURATION_S = 6.0
FIXTURE_SEED = 20260805
SPECTRUM_BINS = 128
HARNESS_VERSION = 1

# Tolerances (calibrated so MPS floating-point non-determinism passes with margin while
# a real model/dep/profile change fails). Overridable via CLI for future tuning.
DEFAULT_RMS_REL_TOL = 0.06
DEFAULT_SPECTRUM_RMSE_TOL = 0.05
DEFAULT_SI_SDR_MIN_DB = 30.0

GOLDEN_STEMS = ["vocals", "drums", "bass", "other"]
REQUEST_STEMS = "vocals,drums,bass,other,instrumental"


def generate_fixture_wav_bytes() -> bytes:
    """Deterministic stereo 16-bit WAV simulating a simple mix (bass + melody + drum hits)."""
    n = int(SAMPLE_RATE * DURATION_S)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    bass = 0.30 * np.sin(2.0 * np.pi * 82.41 * t)  # ~E2
    melody = 0.25 * np.sin(2.0 * np.pi * 440.0 * t) * (0.5 + 0.5 * np.sin(2.0 * np.pi * 0.5 * t))

    rng = np.random.default_rng(FIXTURE_SEED)  # PCG64 stream is stable across numpy versions
    noise = rng.standard_normal(n)
    beat = int(SAMPLE_RATE * 0.5)
    decay = np.exp(-np.arange(beat) / (SAMPLE_RATE * 0.05))
    env = np.zeros(n)
    for start in range(0, n, beat):
        end = min(start + beat, n)
        env[start:end] = decay[: end - start]
    drums = 0.30 * noise * env

    left = bass + melody + drums
    right = 0.9 * bass + melody * (0.6 + 0.4 * np.sin(2.0 * np.pi * 0.25 * t)) + 0.8 * drums

    stereo = np.stack([left, right], axis=0)
    peak = float(np.max(np.abs(stereo)))
    if peak > 0:
        stereo = stereo / peak * 0.95

    pcm16 = (np.clip(stereo, -1.0, 1.0) * 32767.0).astype(np.int16)
    interleaved = np.ascontiguousarray(pcm16.T)  # [samples, channels]

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(interleaved.tobytes())
    return buf.getvalue()


def post_split(wav_bytes: bytes, host: str, port: int, timeout: float) -> dict:
    url = f"http://{host}:{port}/v1/stems/split"
    req = urllib.request.Request(
        url,
        data=wav_bytes,
        method="POST",
        headers={
            "Content-Type": "application/octet-stream",
            "X-Requested-Stems": REQUEST_STEMS,
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def decode_wav_base64(b64: str) -> tuple[np.ndarray, int]:
    raw = base64.b64decode(b64)
    with wave.open(io.BytesIO(raw), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        width = wav.getsampwidth()
        frames = wav.readframes(wav.getnframes())
    if width != 2:
        raise RuntimeError(f"expected PCM16 stems, got sample width {width} bytes")
    data = np.frombuffer(frames, dtype=np.int16).astype(np.float64) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).T
    else:
        data = data.reshape(1, -1)
    return data, sample_rate


def _mono(sig: np.ndarray) -> np.ndarray:
    return sig.mean(axis=0) if sig.ndim > 1 else sig


def _bin_average(vec: np.ndarray, k: int) -> np.ndarray:
    n = len(vec)
    if n <= k:
        out = np.zeros(k)
        out[:n] = vec
        return out
    edges = np.linspace(0, n, k + 1).astype(int)
    return np.array([
        vec[edges[i]:edges[i + 1]].mean() if edges[i + 1] > edges[i] else 0.0
        for i in range(k)
    ])


def fingerprint(sig: np.ndarray) -> dict:
    mono = _mono(sig)
    rms = float(np.sqrt(np.mean(mono ** 2))) if mono.size else 0.0
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    spec = np.abs(np.fft.rfft(mono)) if mono.size else np.zeros(1)
    binned = np.log1p(_bin_average(spec, SPECTRUM_BINS))
    norm = float(np.sqrt(np.sum(binned ** 2))) or 1.0
    return {
        "rms": rms,
        "peak": peak,
        "n_samples": int(mono.size),
        "spectrum": (binned / norm).tolist(),
    }


def si_sdr_db(est: np.ndarray, ref: np.ndarray) -> float:
    est = _mono(est)
    ref = _mono(ref)
    m = min(est.size, ref.size)
    est, ref = est[:m], ref[:m]
    ref_energy = float(np.dot(ref, ref)) + 1e-12
    alpha = float(np.dot(est, ref)) / ref_energy
    proj = alpha * ref
    noise = est - proj
    return 10.0 * np.log10((float(np.dot(proj, proj)) + 1e-12) / (float(np.dot(noise, noise)) + 1e-12))


def spectrum_rmse(a: list[float], b: list[float]) -> float:
    av, bv = np.array(a), np.array(b)
    m = min(av.size, bv.size)
    return float(np.sqrt(np.mean((av[:m] - bv[:m]) ** 2)))


def get_health(host: str, port: int, timeout: float = 5.0) -> dict:
    with urllib.request.urlopen(f"http://{host}:{port}/v1/health", timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def golden_path(base: Path, model: str, sample_rate: int) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in model)
    return base / "golden" / f"{safe}_{sample_rate}.json"


def separate_fixture(args) -> tuple[dict, dict]:
    wav = generate_fixture_wav_bytes()
    response = post_split(wav, args.host, args.port, args.timeout)
    stems = response.get("stems", {})
    decoded = {}
    for name, payload in stems.items():
        sig, sr = decode_wav_base64(payload["dataBase64"])
        decoded[name] = {"signal": sig, "sample_rate": sr}
    return response, decoded


def check_invariant(decoded: dict, min_db: float) -> tuple[bool, float]:
    if not all(k in decoded for k in ("instrumental", "drums", "bass", "other")):
        return False, float("nan")
    synth = decoded["drums"]["signal"] + decoded["bass"]["signal"] + decoded["other"]["signal"]
    db = si_sdr_db(decoded["instrumental"]["signal"], synth)
    return db >= min_db, db


def cmd_baseline(args) -> int:
    health = get_health(args.host, args.port)
    model = str(health.get("model", "unknown"))
    response, decoded = separate_fixture(args)
    sample_rate = next(iter(decoded.values()))["sample_rate"] if decoded else SAMPLE_RATE

    ok_inv, db = check_invariant(decoded, args.si_sdr_min_db)
    if not ok_inv:
        print(f"[parity] REFUSING baseline: instrumental invariant failed (SI-SDR={db:.1f} dB)")
        return 2

    golden = {
        "harness_version": HARNESS_VERSION,
        "model": model,
        "engine_version": response.get("version"),
        "sample_rate": sample_rate,
        "overlap": health.get("overlap"),
        "device_used": response.get("device_used"),
        "tolerances": {
            "rms_rel_tol": args.rms_rel_tol,
            "spectrum_rmse_tol": args.spectrum_rmse_tol,
            "si_sdr_min_db": args.si_sdr_min_db,
        },
        "stems": {name: fingerprint(decoded[name]["signal"]) for name in GOLDEN_STEMS if name in decoded},
    }

    out = golden_path(args.dir, model, sample_rate)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(golden, indent=2) + "\n")
    print(f"[parity] wrote golden baseline: {out}")
    print(f"[parity] model={model} sr={sample_rate} overlap={health.get('overlap')} invariant SI-SDR={db:.1f} dB")
    return 0


def cmd_check(args) -> int:
    health = get_health(args.host, args.port)
    model = str(health.get("model", "unknown"))

    response, decoded = separate_fixture(args)
    sample_rate = next(iter(decoded.values()))["sample_rate"] if decoded else SAMPLE_RATE
    golden_file = golden_path(args.dir, model, sample_rate)

    failures: list[str] = []

    ok_inv, db = check_invariant(decoded, args.si_sdr_min_db)
    print(f"[parity] instrumental == drums+bass+other  SI-SDR = {db:.1f} dB (min {args.si_sdr_min_db})")
    if not ok_inv:
        failures.append(f"instrumental synthesis invariant broken (SI-SDR {db:.1f} dB)")

    if not golden_file.exists():
        print(f"[parity] NO GOLDEN for model '{model}' at {golden_file}")
        print("[parity] run with --mode baseline to capture one for this model.")
        return 3

    golden = json.loads(golden_file.read_text())
    tol = golden.get("tolerances", {})
    rms_tol = tol.get("rms_rel_tol", args.rms_rel_tol)
    spec_tol = tol.get("spectrum_rmse_tol", args.spectrum_rmse_tol)

    if golden.get("sample_rate") != sample_rate:
        failures.append(f"sample_rate drift: golden {golden.get('sample_rate')} vs now {sample_rate}")
    if health.get("overlap") != golden.get("overlap"):
        failures.append(f"overlap drift: golden {golden.get('overlap')} vs now {health.get('overlap')}")

    for name in GOLDEN_STEMS:
        if name not in decoded:
            failures.append(f"missing stem in response: {name}")
            continue
        if name not in golden.get("stems", {}):
            continue
        cur = fingerprint(decoded[name]["signal"])
        g = golden["stems"][name]
        rms_rel = abs(cur["rms"] - g["rms"]) / (g["rms"] + 1e-9)
        rmse = spectrum_rmse(cur["spectrum"], g["spectrum"])
        flag = "OK" if (rms_rel <= rms_tol and rmse <= spec_tol) else "DRIFT"
        print(f"[parity]   {name:11s} rms_rel={rms_rel:.4f} (<= {rms_tol})  spectrum_rmse={rmse:.4f} (<= {spec_tol})  {flag}")
        if rms_rel > rms_tol:
            failures.append(f"{name}: RMS drift {rms_rel:.4f} > {rms_tol}")
        if rmse > spec_tol:
            failures.append(f"{name}: spectrum drift {rmse:.4f} > {spec_tol}")

    if failures:
        print("[parity] FAIL:")
        for f in failures:
            print(f"[parity]   - {f}")
        return 1

    print(f"[parity] PASS: engine output matches golden (model={model}, sr={sample_rate}).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Demucs companion output-parity/drift harness")
    parser.add_argument("--mode", choices=["baseline", "check"], default="check")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=48231)
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--dir", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--rms-rel-tol", dest="rms_rel_tol", type=float, default=DEFAULT_RMS_REL_TOL)
    parser.add_argument("--spectrum-rmse-tol", dest="spectrum_rmse_tol", type=float, default=DEFAULT_SPECTRUM_RMSE_TOL)
    parser.add_argument("--si-sdr-min-db", dest="si_sdr_min_db", type=float, default=DEFAULT_SI_SDR_MIN_DB)
    args = parser.parse_args()

    if args.mode == "baseline":
        return cmd_baseline(args)
    return cmd_check(args)


if __name__ == "__main__":
    sys.exit(main())
