# Device tests — phase 1

Automated tests cover the state machine, backoff, schema, and crash recovery
(`npm test`). These are the parts that only a real device can prove. Run them on
a physical iPhone via a dev build (`npx expo run:ios --device`); the simulator
cannot validate audio capture.

## 1. Invariant #1 — crash mid-recording preserves audio

1. Start a recording. Wait until the screen shows at least 3 segments saved.
2. Force-quit from the app switcher.
3. Relaunch.

Expected: the meeting appears in the list as "on phone only", with a duration
equal to the committed segments (the in-flight sub-minute is lost by design).
Every segment plays from the detail screen.

## 2. Crash during a rotation

Repeat test 1, force-quitting exactly as the segment counter increments.

Expected: no row points at a missing file, and no file in the recording's
directory is missing from the list — a segment moved but not yet recorded in the
database is adopted with "length unknown".

## 3. Rotation is inaudible

Record 5 minutes of continuous speech, then play the segments back in order.

Expected: the boundary between segments loses at most a syllable. If a rotation
is clearly audible, the fix is to start the next recorder before stopping the
current one in `RecordingSession.rotate` (accepting a brief overlap instead of a
brief gap).

## 4. Screen lock and backgrounding

Start a recording, lock the screen, wait 2 minutes, return.

Expected: recording continued and segments kept accumulating (iOS `audio`
background mode, set in `app.json`).

## 5. Long recording

Record 30 minutes. Expected: ~30 segments, roughly 14 MB total, no memory growth
that ends the process.

## 6. Sync — connectivity drop mid-upload

Set `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_DEVICE_TOKEN`, record ~5 minutes, then
put the phone in airplane mode while the meetings list shows it uploading.

Expected: the recording returns to "waiting to upload" with an error recorded,
and no crash. On restoring connectivity it resumes and reaches "uploaded"
without re-sending the segments that already landed — check the worker logs for
the segment count.

## 7. Sync — WiFi-only default

Record on cellular only. Expected: the recording stays "waiting to upload" and
nothing is sent. It uploads once WiFi is available.

## 8. Sync — app restart mid-upload

Force-quit during an upload, relaunch. Expected: the pass resumes from the first
unconfirmed segment; already-uploaded segments are not re-sent.
