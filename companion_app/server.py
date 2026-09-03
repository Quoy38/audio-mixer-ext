import asyncio
import base64
import os
import tempfile
import threading
import wave
from pathlib import Path
from typing import Dict

import numpy as np

# Ensure stable MPS behavior even when server.py is launched directly without run.sh/plist.
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

# Ensure HTTPS downloads (Demucs model weights) can validate certificates even in
# stripped launchd environments where cert paths are not inherited.
if not os.getenv("SSL_CERT_FILE"):
    try:
        import certifi  # type: ignore

        ca_bundle = certifi.where()
        if ca_bundle:
            os.environ.setdefault("SSL_CERT_FILE", ca_bundle)
            os.environ.setdefault("REQUESTS_CA_BUNDLE", ca_bundle)
            os.environ.setdefault("CURL_CA_BUNDLE", ca_bundle)
    except Exception:
        pass

from fastapi import FastAPI, Header, HTTPException, Request, Response

try:
    import demucs  # type: ignore
    DEMUCS_VERSION = getattr(demucs, "__version__", "unknown")
except Exception:
    demucs = None
    DEMUCS_VERSION = "unavailable"

try:
    import torch  # type: ignore
except Exception:
    torch = None

try:
    import torchaudio  # type: ignore
except Exception:
    torchaudio = None

try:
    from demucs.apply import apply_model  # type: ignore
    from demucs.audio import convert_audio  # type: ignore
    from demucs.pretrained import get_model  # type: ignore
except Exception:
    apply_model = None
    convert_audio = None
    get_model = None

APP_HOST = os.getenv("AUDIO_MIXER_ENGINE_HOST", "127.0.0.1")
APP_PORT = int(os.getenv("AUDIO_MIXER_ENGINE_PORT", "48231"))
# htdemucs (single-pass hybrid transformer) is the default because it is ~4x
# faster than htdemucs_ft and can keep up with real-time live voice isolation
# (each 20 s live chunk must finish in well under 20 s). It downloads ~80 MB of
# weights on first use. htdemucs_ft is ~4x slower (4 model passes) but gives
# slightly cleaner separation with less vocal bleed — set
# AUDIO_MIXER_DEMUCS_MODEL=htdemucs_ft for that offline-quality path, or mdx_q
# for the older fast/low-quality path.
DEMUCS_MODEL = os.getenv("AUDIO_MIXER_DEMUCS_MODEL", "htdemucs")
MAX_UPLOAD_BYTES = int(os.getenv("AUDIO_MIXER_MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))
# 30 s segments keep MPS memory bounded per chunk (~160 MB each vs 646 MB for 120 s).
# With PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0 set in the environment (see run.sh / plist),
# MPS won't hit its artificial cap. Override with AUDIO_MIXER_DEMUCS_SEGMENT_SECONDS=0
# to disable segmentation.
DEMUCS_SEGMENT_SECONDS = os.getenv("AUDIO_MIXER_DEMUCS_SEGMENT_SECONDS", "30")

# 0 = fastest (1 pass). 1 = 2x slower but slightly better. Default: 0.
DEMUCS_SHIFTS = int(os.getenv("AUDIO_MIXER_DEMUCS_SHIFTS", "0"))

# split=True enables segmented processing (required for DEMUCS_SEGMENT_SECONDS to take
# effect). Enabled by default so MPS memory stays bounded on long songs.
DEMUCS_SPLIT = os.getenv("AUDIO_MIXER_DEMUCS_SPLIT", "1") == "1"
# For short tracks, segmented overlap can dominate runtime. Enable an adaptive
# fast path that tries split=False first, while still falling back to split=True
# (and then CPU if needed) to preserve reliability.
DEMUCS_FAST_SHORT_CLIPS = os.getenv("AUDIO_MIXER_DEMUCS_FAST_SHORT_CLIPS", "0") == "1"
DEMUCS_FAST_SHORT_MAX_SECONDS = float(os.getenv("AUDIO_MIXER_DEMUCS_FAST_SHORT_MAX_SECONDS", "75"))
DEMUCS_FAST_MEDIUM_CLIPS = os.getenv("AUDIO_MIXER_DEMUCS_FAST_MEDIUM_CLIPS", "1") == "1"
DEMUCS_FAST_MEDIUM_MAX_SECONDS = float(os.getenv("AUDIO_MIXER_DEMUCS_FAST_MEDIUM_MAX_SECONDS", "180"))
DEMUCS_FAST_MEDIUM_SEGMENT_SECONDS = float(os.getenv("AUDIO_MIXER_DEMUCS_FAST_MEDIUM_SEGMENT_SECONDS", "30"))
# Use the smoother default overlap for long-track instrumental rendering.
# The value can still be overridden from the launch script or environment.
DEMUCS_OVERLAP = float(os.getenv("AUDIO_MIXER_DEMUCS_OVERLAP", "0.25"))

# Request timeout in seconds. Default: 10 minutes.
DEMUCS_TIMEOUT_SECONDS = int(os.getenv("AUDIO_MIXER_DEMUCS_TIMEOUT", str(10 * 60)))

PRELOAD_MODEL_ON_STARTUP = os.getenv("AUDIO_MIXER_PRELOAD_MODEL", "1") == "1"


def _default_demucs_device() -> str:
    if torch is None:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    # Prefer MPS on Apple Silicon. The in-place tensor issues seen with split=False
    # (full-song single-pass) are avoided by the default split=True + 30 s segments.
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


DEMUCS_DEVICE = os.getenv("AUDIO_MIXER_DEMUCS_DEVICE", _default_demucs_device())

app = FastAPI(title="Audio Mixer Pro Engine", version="1.0.0")


# ---------------------------------------------------------------------------
# Private Network Access (PNA) / CORS preflight — ADDITIVE. DO NOT WIDEN.
#
# Chrome is rolling out Private Network Access. A fetch from a
# chrome-extension:// page (a less-private context) to THIS loopback engine
# (a more-private/private network) triggers a CORS *preflight* that MUST be
# answered with `Access-Control-Allow-Private-Network: true`. If that header
# is missing, a FUTURE Chrome silently fails the fetch
# (TypeError: Failed to fetch / kPrivateNetworkAccessPermissionDenied) and the
# working engine drops back to local DSP with zero code changes on our side.
#
# This handler answers ONLY the OPTIONS preflight. It does not read the body,
# run Demucs, or alter /v1/health, /v1/stems/split, or /v1/restart in any way.
# The origin is reflected only for the chrome-extension:// scheme; at store
# publish time (Phase E) tighten this to the specific published extension id.
# ---------------------------------------------------------------------------
def _preflight_headers(origin: str | None) -> dict:
    allow_origin = origin if (origin and origin.startswith("chrome-extension://")) else "null"
    return {
        "Access-Control-Allow-Origin": allow_origin,
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-Stems",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
    }


@app.options("/{rest_of_path:path}")
async def cors_preflight(rest_of_path: str, request: Request) -> Response:
    return Response(status_code=204, headers=_preflight_headers(request.headers.get("origin")))


_demucs_model = None
_demucs_model_lock = threading.Lock()
_requests_served = 0
_requests_lock = threading.Lock()


def _ensure_demucs_available() -> None:
    if demucs is None or torch is None or torchaudio is None or apply_model is None or convert_audio is None or get_model is None:
        raise HTTPException(
            status_code=503,
            detail="demucs/torch/torchaudio runtime is not fully installed in this environment",
        )


def _parse_segment_seconds() -> float | None:
    if not DEMUCS_SEGMENT_SECONDS:
        return None
    try:
        value = float(DEMUCS_SEGMENT_SECONDS)
        if value <= 0:
            # Explicit 0 means "disable segmentation" (single-pass fast path).
            return None
        return value
    except Exception:
        return None


def _load_demucs_model():
    global _demucs_model
    if _demucs_model is not None:
        return _demucs_model

    with _demucs_model_lock:
        if _demucs_model is not None:
            return _demucs_model

        model = get_model(DEMUCS_MODEL)
        model.eval()
        try:
            model.to(DEMUCS_DEVICE)
        except Exception as error:
            # Fallback to CPU if requested device fails.
            if DEMUCS_DEVICE != "cpu":
                print(f"[demucs] Device '{DEMUCS_DEVICE}' failed ({error}), falling back to cpu", flush=True)
                model.to("cpu")
            else:
                raise

        _demucs_model = model
        print(f"[demucs] Model loaded in-process: {DEMUCS_MODEL} on {DEMUCS_DEVICE}", flush=True)
        return _demucs_model


def _sanitize_requested_stems(header_value: str | None) -> list[str]:
    default = ["vocals", "drums", "bass", "other"]
    if not header_value:
        return default

    requested = [item.strip().lower() for item in header_value.split(",") if item.strip()]
    if not requested:
        return default

    # Keep ordering stable and filter to supported stems only.
    # 'instrumental' is a synthetic output we build from drums+bass+other.
    supported = {"vocals", "drums", "bass", "other", "instrumental"}
    normalized = [stem for stem in requested if stem in supported]
    return normalized or default


def _encode_tensor_to_wav_base64(stem_tensor, sample_rate: int) -> str:
    with tempfile.NamedTemporaryFile(prefix="audio-mixer-stem-", suffix=".wav", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        tensor_cpu = stem_tensor.detach().cpu()
        try:
            torchaudio.save(
                str(tmp_path),
                tensor_cpu,
                sample_rate,
                format="wav",
                encoding="PCM_S",
                bits_per_sample=16,
            )
        except Exception:
            # Fallback for environments where torchaudio backends are unavailable.
            data = tensor_cpu.numpy()
            if data.ndim == 1:
                data = data[None, :]
            data = np.clip(data, -1.0, 1.0)
            pcm16 = (data * 32767.0).astype(np.int16)
            interleaved = np.ascontiguousarray(pcm16.T)
            with wave.open(str(tmp_path), "wb") as wav_file:
                wav_file.setnchannels(int(interleaved.shape[1]))
                wav_file.setsampwidth(2)
                wav_file.setframerate(int(sample_rate))
                wav_file.writeframes(interleaved.tobytes())
        return base64.b64encode(tmp_path.read_bytes()).decode("ascii")
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def _load_input_wav(path: Path):
    """Load a WAV file to [channels, samples] float32 tensor and sample rate."""
    try:
        return torchaudio.load(str(path))
    except Exception:
        # Fallback for environments where torchaudio lacks a usable backend.
        with wave.open(str(path), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_rate = wav_file.getframerate()
            sample_width = wav_file.getsampwidth()
            frame_count = wav_file.getnframes()
            frames = wav_file.readframes(frame_count)

        if sample_width == 2:
            array = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        elif sample_width == 4:
            array = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            raise RuntimeError(f"Unsupported WAV sample width: {sample_width} bytes")

        if channels > 1:
            array = array.reshape(-1, channels).T
        else:
            array = array.reshape(1, -1)

        return torch.from_numpy(array), int(sample_rate)


def _model_max_segment_seconds(model) -> float | None:
    """Largest segment (in seconds) the model can safely process in one chunk.

    htdemucs / htdemucs_ft are hybrid-transformer models whose transformer is
    trained on a FIXED 7.8 s window (model.segment == 39/5). Passing a larger
    `segment=` to apply_model overrides that limit and makes the transformer
    reshape fail ("shape '[1, 4, -1, 343980]' is invalid ...") on CPU, or blow
    past the Metal buffer cap ("Invalid buffer size: N GB") on MPS. We therefore
    clamp any configured segment to the smallest sub-model segment so the model
    always runs within its trained window. Returns None when no limit is known
    (older waveform-only Demucs models accept arbitrary segments).
    """
    submodels = getattr(model, "models", None) or [model]
    limits: list[float] = []
    for sub in submodels:
        seg = getattr(sub, "segment", None)
        try:
            if seg is not None and float(seg) > 0:
                limits.append(float(seg))
        except (TypeError, ValueError):
            continue
    return min(limits) if limits else None


def _run_demucs_in_process(raw_audio: bytes, requested_stems: list[str]) -> Dict[str, object]:
    global _demucs_model
    model = _load_demucs_model()
    with tempfile.TemporaryDirectory(prefix="audio-mixer-engine-") as temp_root:
        root = Path(temp_root)
        input_path = root / "track.wav"
        input_path.write_bytes(raw_audio)

        mix, source_sr = _load_input_wav(input_path)
        if mix.ndim != 2 or mix.shape[1] == 0:
            raise RuntimeError("Invalid or empty audio input")

        # Match Demucs expected sample rate/channels.
        mix = convert_audio(mix, source_sr, model.samplerate, model.audio_channels)

        # Same normalization strategy used by demucs.separate.
        ref = mix.mean(0)
        ref_mean = ref.mean()
        ref_std = ref.std()
        if torch.isnan(ref_std) or ref_std <= 1e-8:
            ref_std = torch.tensor(1.0, dtype=mix.dtype, device=mix.device)

        normalized = (mix - ref_mean) / ref_std

        segment_seconds = _parse_segment_seconds()
        device_used = DEMUCS_DEVICE
        moved_to_cpu = False
        clip_duration_seconds = float(normalized.shape[-1]) / float(model.samplerate)
        use_split = DEMUCS_SPLIT

        if DEMUCS_FAST_SHORT_CLIPS and DEMUCS_SPLIT and clip_duration_seconds <= DEMUCS_FAST_SHORT_MAX_SECONDS:
            use_split = False
            print(
                f"[demucs] Fast short-clip path: duration={clip_duration_seconds:.1f}s "
                "-> split=False first attempt",
                flush=True,
            )
        elif (
            DEMUCS_FAST_MEDIUM_CLIPS
            and DEMUCS_SPLIT
            and segment_seconds is not None
            and clip_duration_seconds <= DEMUCS_FAST_MEDIUM_MAX_SECONDS
            and DEMUCS_FAST_MEDIUM_SEGMENT_SECONDS < segment_seconds
        ):
            segment_seconds = DEMUCS_FAST_MEDIUM_SEGMENT_SECONDS
            print(
                f"[demucs] Fast medium-clip path: duration={clip_duration_seconds:.1f}s "
                f"-> segment={segment_seconds:.0f}s",
                flush=True,
            )

        # Clamp the segment to the model's trained window. htdemucs/htdemucs_ft
        # cannot process segments longer than 7.8 s (their transformer is fixed at
        # model.segment == 39/5); a larger override is what caused the recurring
        # "Invalid buffer size" (MPS) / reshape (CPU) 500s. This keeps the verified
        # htdemucs_ft instrumental separation working without changing the model.
        max_segment_seconds = _model_max_segment_seconds(model)
        if max_segment_seconds is not None:
            if segment_seconds is None or segment_seconds > max_segment_seconds:
                if segment_seconds is not None:
                    print(
                        f"[demucs] Clamping segment {segment_seconds:.1f}s -> "
                        f"{max_segment_seconds:.2f}s (model transformer limit)",
                        flush=True,
                    )
                segment_seconds = max_segment_seconds
            # A full-song single pass (split=False) also exceeds the transformer
            # window for anything longer than the limit, so force segmented mode.
            if not use_split and clip_duration_seconds > max_segment_seconds:
                use_split = True

        def _oom(exc: Exception) -> bool:
            # Treat all MPS/accelerator allocation failures as OOM-class so the
            # existing smaller-segment + CPU fallback path engages instead of
            # surfacing a hard 500. On Apple Silicon the allocator does NOT always
            # say "out of memory"; after long uptime / sleep cycles it commonly
            # throws "Invalid buffer size: N GB" or similar for the *same* input
            # that worked on a fresh boot. Classifying only the literal
            # "out of memory" string let those failures bypass the fallback and
            # return 500 (the recurring prepared-instrumental regression).
            message = str(exc).lower()
            allocation_markers = (
                "out of memory",
                "invalid buffer size",
                "buffer is not large enough",
                "buffer size",
                "cannot allocate",
                "can't allocate",
                "failed to allocate",
                "mps backend out of memory",
                "placeholder",
            )
            return any(marker in message for marker in allocation_markers)

        def _is_hard_buffer_cap(exc: Exception) -> bool:
            # MPS Metal *hard* buffer-size cap (and similar). Unlike a soft OOM,
            # shrinking the segment does NOT help, and retrying on the same — now
            # poisoned — accelerator context tends to cascade into unrelated errors
            # (e.g. a bogus tensor-reshape failure). For these, skip on-device retry
            # and go straight to the reliable CPU fallback.
            message = str(exc).lower()
            return (
                "invalid buffer size" in message
                or "buffer is not large enough" in message
            )

        def _apply_on_cpu() -> object:
            """Last-resort CPU fallback: move model to CPU and re-run with split=True."""
            nonlocal device_used, moved_to_cpu
            print("[demucs] Falling back to CPU — moving model off accelerator", flush=True)
            device_used = "cpu"
            moved_to_cpu = True
            try:
                model.to("cpu")
            except Exception as move_err:
                print(f"[demucs] model.to('cpu') failed ({move_err}); trying anyway", flush=True)
            with torch.no_grad():
                return apply_model(
                    model,
                    normalized[None].cpu(),
                    shifts=DEMUCS_SHIFTS,
                    split=True,
                    overlap=DEMUCS_OVERLAP,
                    progress=False,
                    device="cpu",
                    segment=segment_seconds,
                )

        def _retry_split_on_device_after_oom(cause: Exception) -> object | None:
            """Try progressively smaller split segments on the same device before CPU fallback."""
            nonlocal segment_seconds
            if DEMUCS_DEVICE == "cpu" or segment_seconds is None:
                return None

            # A hard Metal buffer-size cap is not a soft OOM: smaller segments won't
            # help and the accelerator context is already poisoned. Bail out so the
            # caller falls back to CPU directly.
            if _is_hard_buffer_cap(cause):
                return None

            current = float(segment_seconds)
            candidates: list[float] = []
            while current > 20.0:
                next_segment = max(20.0, round(current * 0.75, 1))
                if next_segment >= current:
                    break
                candidates.append(next_segment)
                current = next_segment

            if not candidates or candidates[-1] != 20.0:
                candidates.append(20.0)

            for candidate in candidates[:2]:
                print(
                    f"[demucs] split OOM on '{DEMUCS_DEVICE}' ({cause}); "
                    f"retrying on-device with segment={candidate:.1f}s",
                    flush=True,
                )
                try:
                    with torch.no_grad():
                        estimates_local = apply_model(
                            model,
                            normalized[None],
                            shifts=DEMUCS_SHIFTS,
                            split=True,
                            overlap=DEMUCS_OVERLAP,
                            progress=False,
                            device=DEMUCS_DEVICE,
                            segment=candidate,
                        )
                    segment_seconds = candidate
                    return estimates_local
                except Exception as retry_error:
                    # On a degraded/poisoned accelerator context the retry can surface
                    # unrelated errors (e.g. a reshape failure from corrupted MPS state).
                    # Never let that escape as a 500 — abandon the on-device retry so the
                    # caller proceeds to the reliable CPU fallback.
                    print(
                        f"[demucs] on-device retry failed ({retry_error}); abandoning "
                        f"'{DEMUCS_DEVICE}' for this request, falling back to CPU",
                        flush=True,
                    )
                    return None
            return None

        try:
            with torch.no_grad():
                estimates = apply_model(
                    model,
                    normalized[None],
                    shifts=DEMUCS_SHIFTS,
                    split=use_split,
                    overlap=DEMUCS_OVERLAP,
                    progress=False,
                    device=DEMUCS_DEVICE,
                    segment=segment_seconds,
                )
        except RuntimeError as error:
            if not use_split:
                # Fast path (split=False) failed. Retry with split=True on same device first.
                print(f"[demucs] Fast path failed ({error}), retrying with split=True", flush=True)
                try:
                    with torch.no_grad():
                        estimates = apply_model(
                            model,
                            normalized[None],
                            shifts=DEMUCS_SHIFTS,
                            split=True,
                            overlap=DEMUCS_OVERLAP,
                            progress=False,
                            device=DEMUCS_DEVICE,
                            segment=segment_seconds,
                        )
                except RuntimeError as split_error:
                    # split=True on the original device also failed.
                    # If it's an OOM on a non-CPU device (e.g. MPS), fall back to CPU.
                    if _oom(split_error) and DEMUCS_DEVICE != "cpu":
                        retried = _retry_split_on_device_after_oom(split_error)
                        if retried is not None:
                            estimates = retried
                        else:
                            print(
                                f"[demucs] split=True OOM on '{DEMUCS_DEVICE}' ({split_error}); "
                                "retrying on cpu",
                                flush=True,
                            )
                            estimates = _apply_on_cpu()
                    else:
                        raise
            elif _oom(error) and DEMUCS_DEVICE != "cpu":
                retried = _retry_split_on_device_after_oom(error)
                if retried is not None:
                    estimates = retried
                else:
                    print(
                        f"[demucs] split=True OOM on '{DEMUCS_DEVICE}' ({error}); retrying on cpu",
                        flush=True,
                    )
                    estimates = _apply_on_cpu()
            else:
                raise

        estimates = estimates * ref_std + ref_mean
        estimates = estimates[0]  # [num_sources, channels, samples]

        sources = list(getattr(model, "sources", []))
        if not sources:
            raise RuntimeError("Demucs model did not report any sources")

        stem_index = {name: idx for idx, name in enumerate(sources)}
        stems_payload: Dict[str, Dict[str, str]] = {}
        missing_stems: list[str] = []

        for stem_name in requested_stems:
            if stem_name == "instrumental":
                required = ["drums", "bass", "other"]
                if not all(name in stem_index for name in required):
                    missing_stems.append(stem_name)
                    continue

                stem_tensor = (
                    estimates[stem_index["drums"]]
                    + estimates[stem_index["bass"]]
                    + estimates[stem_index["other"]]
                )
            else:
                idx = stem_index.get(stem_name)
                if idx is None:
                    missing_stems.append(stem_name)
                    continue
                stem_tensor = estimates[idx]

            stems_payload[stem_name] = {
                "mimeType": "audio/wav",
                "dataBase64": _encode_tensor_to_wav_base64(stem_tensor, int(model.samplerate)),
            }

        if missing_stems:
            raise RuntimeError(f"Missing stems in model output: {', '.join(missing_stems)}")

        if moved_to_cpu and DEMUCS_DEVICE != "cpu":
            try:
                model.to(DEMUCS_DEVICE)
                print(f"[demucs] Restored model back to {DEMUCS_DEVICE} after CPU fallback", flush=True)
            except Exception as restore_error:
                print(f"[demucs] Failed to restore model to {DEMUCS_DEVICE}: {restore_error}", flush=True)
                # Avoid silently stranding future requests on CPU. Dropping the cached
                # model forces a clean reload on the next request.
                with _demucs_model_lock:
                    if _demucs_model is model:
                        _demucs_model = None

        return {
            "engine": "demucs",
            "version": DEMUCS_VERSION,
            "model": DEMUCS_MODEL,
            "device_used": device_used,
            "segment_used": segment_seconds,
            "split_used": use_split,
            "stems": stems_payload,
        }


def _background_mps_flush() -> None:
    """Periodically flush MPS cache to prevent slow accumulation across long sessions."""
    import time as _time
    while True:
        _time.sleep(90)
        if DEMUCS_DEVICE == "mps" and getattr(torch, "mps", None):
            try:
                import gc as _gc
                _gc.collect()
                torch.mps.empty_cache()
            except Exception:
                pass


@app.on_event("startup")
async def _startup_preload_model() -> None:
    if DEMUCS_DEVICE == "mps":
        # Start background MPS flush thread — runs independently of request success/failure
        # as a belt-and-suspenders complement to the per-request finally-block cleanup.
        t = threading.Thread(target=_background_mps_flush, daemon=True, name="mps-flush")
        t.start()

    if not PRELOAD_MODEL_ON_STARTUP:
        return
    try:
        await asyncio.to_thread(_load_demucs_model)
    except Exception as error:
        print(f"[demucs] Model preload skipped: {error}", flush=True)


@app.get("/v1/health")
def health() -> Dict[str, object]:
    warmed = _demucs_model is not None
    return {
        "ok": demucs is not None,
        "engine": "demucs",
        "version": DEMUCS_VERSION,
        "model": DEMUCS_MODEL,
        "device": DEMUCS_DEVICE,
        "shifts": DEMUCS_SHIFTS,
        "split": DEMUCS_SPLIT,
        "fast_short_clips": DEMUCS_FAST_SHORT_CLIPS,
        "fast_short_max_seconds": DEMUCS_FAST_SHORT_MAX_SECONDS,
        "fast_medium_clips": DEMUCS_FAST_MEDIUM_CLIPS,
        "fast_medium_max_seconds": DEMUCS_FAST_MEDIUM_MAX_SECONDS,
        "fast_medium_segment_seconds": DEMUCS_FAST_MEDIUM_SEGMENT_SECONDS,
        "overlap": DEMUCS_OVERLAP,
        "warmed": warmed,
        "requests_served": _requests_served,
    }


@app.post("/v1/restart")
def restart() -> Dict[str, object]:
    """Self-heal restart. Exits the process with a NON-ZERO code so the LaunchAgent
    (KeepAlive -> SuccessfulExit=false) relaunches a fresh instance. The relaunch
    re-reads the environment and reloads the model, which clears profile drift or a
    wedged MPS state WITHOUT the user needing a Terminal.

    The response is returned first, then the exit is scheduled on a short timer so the
    HTTP 200 reaches the caller before the process dies. launchd waits ThrottleInterval
    (~10 s) and then the port-guard-protected relaunch binds a clean process; callers
    should poll /v1/health until it reports warmed again.

    Localhost-only exposure, identical to every other endpoint on this service."""

    def _exit_for_relaunch() -> None:
        # os._exit (not sys.exit / SystemExit) terminates the whole process from this
        # timer thread. A non-zero code is REQUIRED: KeepAlive.SuccessfulExit=false only
        # relaunches on non-zero exits (a clean exit 0 is how the port guard stops loops).
        os._exit(42)

    threading.Timer(0.5, _exit_for_relaunch).start()
    print(
        "[companion] Restart requested via /v1/restart — exiting non-zero for launchd relaunch.",
        flush=True,
    )
    return {"ok": True, "restarting": True, "relaunch_via": "launchd", "throttle_seconds": 10}


@app.post("/v1/stems/split")
async def split_stems(
    request: Request,
    x_requested_stems: str | None = Header(default=None),
) -> Dict[str, object]:
    _ensure_demucs_available()

    raw_audio = await request.body()
    if not raw_audio:
        raise HTTPException(status_code=400, detail="Empty request body")
    if len(raw_audio) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Input too large")

    requested_stems = _sanitize_requested_stems(x_requested_stems)

    import time as _time
    _t0 = _time.monotonic()

    result = None
    global _requests_served
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(_run_demucs_in_process, raw_audio, requested_stems),
            timeout=DEMUCS_TIMEOUT_SECONDS,
        )
        _elapsed = _time.monotonic() - _t0
        _kb = len(raw_audio) // 1024
        _device_used = str(result.get("device_used", DEMUCS_DEVICE)) if isinstance(result, dict) else DEMUCS_DEVICE
        with _requests_lock:
            _requests_served += 1
        print(f"[demucs] Finished OK — {_elapsed:.1f}s for {_kb} KB ({_device_used}) [req #{_requests_served}]", flush=True)
        return result
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=(
                f"Demucs timed out after {DEMUCS_TIMEOUT_SECONDS}s. "
                "Try a shorter clip or increase AUDIO_MIXER_DEMUCS_TIMEOUT."
            ),
        )
    except HTTPException:
        raise
    except Exception as error:
        print(f"[demucs] FAILED (in-process): {error}", flush=True)
        raise HTTPException(status_code=500, detail=f"Demucs separation failed: {str(error)[:1500]}") from error
    finally:
        # Free dead MPS allocations AFTER the inference thread has returned,
        # whether the request succeeded or failed.  gc.collect() drops the last
        # Python refs to the inference tensors so empty_cache() can actually
        # reclaim the GPU memory.  Crucially, this must NOT be called INSIDE
        # _run_demucs_in_process while local tensor vars are still live —
        # doing so caused MPS command-queue corruption and audio buzzing.
        # Running in finally means dirty MPS state is always cleaned up,
        # preventing quality degradation across subsequent requests.
        if DEMUCS_DEVICE == "mps" and getattr(torch, "mps", None):
            try:
                import gc as _gc
                _gc.collect()
                torch.mps.empty_cache()
            except Exception:
                pass


if __name__ == "__main__":
    import socket
    import uvicorn

    # Guard against the LaunchAgent restart loop that occurs when run.sh is called
    # while the service is already running: check if port is already bound before
    # loading the model or starting uvicorn. This prevents redundant model loads and
    # MPS memory waste. launchd will retry after ThrottleInterval (10s) regardless;
    # this just makes each failed attempt cheap (fast exit, no model allocated).
    _probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    _probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        _probe.bind((APP_HOST, APP_PORT))
        _probe.close()
    except OSError:
        _probe.close()
        print(
            f"[companion] Port {APP_PORT} is already in use — another instance is running. Exiting.",
            flush=True,
        )
        raise SystemExit(0)

    uvicorn.run(app, host=APP_HOST, port=APP_PORT)
