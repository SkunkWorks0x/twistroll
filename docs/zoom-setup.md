# Zoom audio capture — TWiST Sentinel setup

System Audio mode routes any Mac audio source — including a Zoom call — into TWiST Sentinel's Deepgram pipeline. macOS doesn't expose "capture system audio" by default; BlackHole is a free virtual audio driver that creates one.

## One-time setup (5 minutes)

### 1. Install BlackHole 2ch

Free, open source: https://github.com/ExistentialAudio/BlackHole

Either the installer or `brew install blackhole-2ch`.

### 2. Create a Multi-Output Device

Open **Audio MIDI Setup** (in `/Applications/Utilities/`).

1. Bottom-left `+` button → **Create Multi-Output Device**
2. Check **BlackHole 2ch** AND your normal speakers/headphones
3. Right-click the new device → **Use this device for sound output**

Audio now plays through your ears AND BlackHole simultaneously.

### 3. Route Zoom output

Zoom → **Settings → Audio → Speaker** → choose the Multi-Output Device.

(Leave mic settings unchanged — Sentinel captures only the speaker side.)

### 4. Start a TWiST Sentinel session

In the dashboard:
1. Click the **System Audio** toggle in the session bar
2. Click **Start**

The server runs `ffmpeg -f avfoundation -i ":BlackHole 2ch"` and feeds the audio to Deepgram. Zoom audio → BlackHole → ffmpeg → Deepgram → claims appear in the sidebar.

## Verifying

- Server log shows the system-audio path starting against device `BlackHole 2ch`
- Transcript pane fills as Zoom participants speak
- If silence: confirm the Multi-Output Device is still selected as Mac output AND Zoom's speaker output is set to it

## Overriding the device name

If BlackHole is renamed or you want a different input device:

```
AUDIO_DEVICE='Your Device Name' npm run dev
```

The System Audio start handler resolves device in this order:
1. Explicit `body.source` in the start request (not normally used by the dashboard)
2. `AUDIO_DEVICE` environment variable
3. Default `'BlackHole 2ch'`

## Notes

- Both Sentinel and Zoom run on the same Mac. Multi-Output captures playback, not the network stream.
- BlackHole adds <10ms latency. Total Zoom-to-claim-card stays inside the standard 5-7s pipeline budget.
- Only the playback (speaker) side is captured. Your own mic is not routed through BlackHole unless you separately wire it.
