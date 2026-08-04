# Text-to-Speech (Piper) — install & setup

BasecaBot can speak messages aloud through an OBS Browser Source using
[Piper](https://github.com/rhasspy/piper), an offline neural TTS engine. This
guide covers installing Piper **on the server** (the Dockerized deployment) and,
as an appendix, on a local Mac for development.

> **How it works.** `ctx.tts.speak(text)` (or the dashboard's Test box) spawns the
> `piper` binary, synthesizes a `.wav` in memory, and pushes it to the **TTS audio
> overlay** over the WebSocket hub; the overlay plays it. Nothing is written to
> disk permanently (the temp wav is deleted immediately; clips live in a small
> in-memory cache). See `src/services/tts.ts`.

BasecaBot calls the **classic Piper CLI** — underscore flags (`--model`,
`--length_scale`, `--noise_scale`, `--noise_w`, `--sentence_silence`, `--speaker`,
`--output_file`) with the text piped on **stdin**. That's the `rhasspy/piper` C++
binary release (and `piper-tts==1.2.0` on pip). A newer `piper1-gpl` build changed
some flags — if you use one, adjust `synthesize()` in `src/services/tts.ts`.

Two env vars drive it (see `.env.example`):

| Var | Meaning |
|-----|---------|
| `PIPER_BIN` | Path to the `piper` executable (or bare `piper` if on `PATH`). |
| `PIPER_MODEL` | Absolute path to a voice `.onnx`. **TTS is disabled until this is set.** |

---

## Server install (Docker)

The bot runs as a `node:22-slim` (Debian) container behind the edge Caddy
(see [DEPLOYMENT.md](DEPLOYMENT.md)). Piper must live **inside** the container, so
the binary matches the container's OS. Recommended split: **bake the binary into
the image**, **mount the voice files from a host directory** (voices are large and
easy to swap without an image rebuild).

### 1. Add the Piper binary to the image

In `Dockerfile`, in the **runtime stage** (after the `openssl` install), add:

```dockerfile
# ── Text-to-Speech (Piper) ───────────────────────────────────────────────────
# Prebuilt Piper binary; it bundles its shared libs + espeak-ng-data, so
# PIPER_BIN points straight at the extracted executable. Pin the version; check
# https://github.com/rhasspy/piper/releases for the latest and the right arch
# (piper_linux_x86_64.tar.gz for amd64, piper_linux_aarch64.tar.gz for ARM).
ARG PIPER_VERSION=2023.11.14-2
RUN apt-get update -y && apt-get install -y curl \
 && mkdir -p /opt/piper && cd /opt/piper \
 && curl -L -o piper.tar.gz "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
 && tar -xzf piper.tar.gz && rm piper.tar.gz \
 && apt-get purge -y curl && rm -rf /var/lib/apt/lists/*
```

This extracts the executable to **`/opt/piper/piper/piper`**.

### 2. Download a voice onto the host

Every voice is two files that must sit **side by side**: `<voice>.onnx` and its
`<voice>.onnx.json` config. Put them in a host directory next to the compose file:

```bash
mkdir -p piper-voices && cd piper-voices
# en_US-lessac-medium — a solid single-speaker default
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
```

> For a **multi-speaker** voice (the dashboard shows a Speaker dropdown), use
> `.../en/en_US/libritts/high/en_US-libritts-high.onnx` (+ `.json`) instead — it's
> a larger download.

### 3. Mount the voices into the container

In `docker-compose.yml`, add the voices directory as a read-only bind mount:

```yaml
    volumes:
      - botdata:/data
      - bottokens:/app/.tokens
      - ./piper-voices:/voices:ro      # ← add this
```

### 4. Configure `.env`

```bash
PIPER_BIN=/opt/piper/piper/piper
PIPER_MODEL=/voices/en_US-lessac-medium.onnx
```

### 5. Rebuild and verify

```bash
docker compose up -d --build

# Confirm piper runs inside the container and can synthesize:
docker compose exec bot sh -c \
  "echo 'BasecaBot online. Testing one two three.' \
   | /opt/piper/piper/piper --model /voices/en_US-lessac-medium.onnx --output_file /tmp/t.wav \
   && ls -l /tmp/t.wav"
```

A non-empty `/tmp/t.wav` means Piper is working. Then:

1. Open the dashboard → **Admin → TTS** — it should show the mute toggle + voice
   sliders (and a Speaker dropdown for multi-speaker voices) instead of the
   "not configured" notice.
2. **Admin → Overlays** → copy the **TTS — audio source** URL → add it as a
   Browser Source in OBS.
3. Use the **Test** box under **Admin → TTS** to hear a line.

Mute state and voice-knob settings persist in the SQLite `Setting` table (on the
`botdata` volume), so they survive restarts.

---

## Voice tuning & caching (reference)

- **Voice knobs** (Admin → TTS): Speed (`--length_scale`, higher = slower),
  Expressiveness (`--noise_scale`), Cadence variation (`--noise_w`), Sentence
  pause (`--sentence_silence`), a Speaker dropdown for multi-speaker models, and
  Volume (applied client-side on the overlay). Save / Reset-to-defaults per card.
- **Cache:** generated clips are held in an in-memory LRU keyed by text + voice
  params, capped at **20** clips (`CACHE_MAX` in `src/services/tts.ts`). No
  time-based expiry — a clip is evicted only when a 21st distinct clip is made, or
  on bot restart. Repeated phrases don't re-synthesize. The audio route sends
  `Cache-Control: no-store`, so the browser never caches it.

---

## Troubleshooting

- **"not configured" in Admin → TTS** — `PIPER_MODEL` isn't set or the path isn't
  visible inside the container. Check the bind mount and that the path is the
  in-container path (`/voices/...`, not the host path).
- **Synthesis fails / Test box errors** — run the Step 5 `exec` command to see
  piper's stderr. Usual causes: the `.onnx.json` sidecar is missing or misnamed
  (must be exactly `<model>.onnx.json` next to the `.onnx`), or the tarball arch
  doesn't match the container (`x86_64` vs `aarch64`).
- **`piper: not found` / exec format error** — wrong architecture tarball, or
  `PIPER_BIN` is a bare `piper` not on the container's `PATH`. Use the absolute
  `/opt/piper/piper/piper`.
- **Missing shared library** — the tarball bundles its libs, but if the container
  complains, `apt-get install -y libstdc++6` in the runtime stage (usually already
  present in `node:22-slim`).

---

## Appendix — local dev (macOS, Apple Silicon)

Prebuilt macOS-arm64 binaries are unreliable, so use pip in a throwaway venv.
Note: this can fail to build `piper-phonemize` on Apple Silicon — if so, do your
real testing against the server, where the Docker binary just works.

```bash
python3 -m venv ~/piper/venv
~/piper/venv/bin/pip install --upgrade pip
~/piper/venv/bin/pip install "piper-tts==1.2.0"

# Download a voice (same HF files as the server)
mkdir -p ~/piper/voices && cd ~/piper/voices
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

# Smoke test (Node's spawn does NOT expand ~, so use absolute paths in .env)
echo 'Testing one two three.' | ~/piper/venv/bin/piper \
  --model ~/piper/voices/en_US-lessac-medium.onnx --output_file /tmp/t.wav
afplay /tmp/t.wav
```

Then in your local `.env`:

```bash
PIPER_BIN=/Users/ebures/piper/venv/bin/piper
PIPER_MODEL=/Users/ebures/piper/voices/en_US-lessac-medium.onnx
```
