# Checkpoint: Prepared Instrumental — VERIFIED WORKING (2026-06-20)

Archive: `audio-mixer-checkpoint-20260620-221152.tar.gz`
Checksum: `audio-mixer-checkpoint-20260620-221152.sha256`

User-confirmed working: the full prepared-instrumental flow now behaves exactly
as intended, with the page timeline matching what is heard at every stage.

## Confirmed flow
1. Press Start Isolation → song mutes + jumps to 0:00.
2. Plays one full muted loop (0:00 → end).
3. Loops back to 0:00 → second muted loop.
4. Third muted loop if processing isn't done yet.
5. Processing finishes → jump to 0:00, unmute → fully processed instrumental
   plays in sync with the page timeline.

## Root cause that was fixed
YouTube Music streams via MSE and **tears down the source buffer when a track
ENDS**. A raw `el.currentTime = 0` + `el.play()` therefore cannot resume an
ended track — `play()` is rejected and the page timeline freezes at the end
position (e.g. 0:34), even though the Web Audio instrumental buffer (independent
of the page) keeps playing. Both the prior April-15 checkpoint (raw seek+play)
and the later over-engineered verify-restart relied on raw `play()`, so neither
could replay an ended YT Music track.

## The fix
- `content/content.js` — `restartAndPlayFromZero()` + `getPlayPauseButton()`:
  force-seek to 0, clear pause lock, call `play()` (smooth loop when still
  playing / paused mid-track), and **if the track had ended/paused, click YT
  Music's Play button** to force a real replay. Message: `RESTART_AND_PLAY_FROM_ZERO`.
  (Do NOT use the Previous button to restart after seeking to 0 — at ct≈0 it
  jumps to the previous song instead of replaying.)
- `popup/popup.js` — `restartAndPlayActiveTabFromZero()` wired into the three
  restart points: 2nd-loop kickoff after capture, the `keepSongLooping` guardian,
  and the playback handoff.
- `companion_app/server.py` — DEMUCS_MODEL = `htdemucs_ft` (cleanest separation).

## Restore
```sh
cd /Users/user/Desktop/audio-mixer-ext
shasum -a 256 -c checkpoints/audio-mixer-checkpoint-20260620-221152.sha256
tar -xzf checkpoints/audio-mixer-checkpoint-20260620-221152.tar.gz
```
Archive excludes `models/`, `libs/`, `.git/`, and prior checkpoint tarballs.
