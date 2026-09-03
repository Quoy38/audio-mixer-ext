# Companion Pro Engine

Local pro-quality stem splitter service for the Chrome extension.

## What It Does

- Runs a local HTTP API on `127.0.0.1:48231`
- Splits audio into `vocals`, `drums`, `bass`, `other` using Demucs
- Returns stems as base64 audio payloads compatible with the extension

## Endpoints

- `GET /v1/health`
- `POST /v1/stems/split` (raw WAV body)

## Setup

### Easiest (one click on macOS)

Double-click `Install Companion.command` from the project root.

That launcher runs the full installer, creates/uses `.venv`, installs pinned dependencies, loads the LaunchAgent, and checks health.

If you see `-bash: pip: command not found`, that is OK on many macOS setups. This project no longer requires a global `pip` command.

### Terminal fallback

From the project root:

```bash
bash companion_app/install-macos-service.sh
```

Do not run `pip install -r requirements.txt` manually unless you are intentionally doing custom dependency work. The installer uses `python -m pip` inside `.venv` and prefers `requirements.lock` to prevent environment drift.

### Start server manually (optional)

If you want to run in a foreground terminal instead of launchd:

```bash
cd /Users/user/Developer/audio-mixer-ext
bash companion_app/run.sh
```

If the companion is already running, `run.sh` now exits cleanly and keeps the
existing process. To force a restart:

```bash
cd /Users/user/Developer/audio-mixer-ext
bash companion_app/run.sh --restart
```

### Confirm health

```bash
curl http://127.0.0.1:48231/v1/health
```

## Notes

- First split can be slower while model weights initialize.
- Requires enough RAM/CPU for Demucs.
- Keep this service running while using stem generation in the extension.
- Default model is `mdx_q` for faster turnaround. Set `AUDIO_MIXER_DEMUCS_MODEL=htdemucs` if you want maximum quality and can accept longer processing times.

## Environment Variables

- `AUDIO_MIXER_ENGINE_HOST` (default `127.0.0.1`)
- `AUDIO_MIXER_ENGINE_PORT` (default `48231`)
- `AUDIO_MIXER_DEMUCS_MODEL` (default `mdx_q`)
- `AUDIO_MIXER_DEMUCS_DEVICE` (default auto: `mps` on Apple Silicon if available, else `cpu`)
- `AUDIO_MIXER_DEMUCS_SEGMENT_SECONDS` (optional, e.g. `8` to reduce memory usage)
- `AUDIO_MIXER_MAX_UPLOAD_BYTES` (default `524288000`)
