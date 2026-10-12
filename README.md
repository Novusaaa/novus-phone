<p align="right">
  <a href="README.zh_CN.md">简体中文</a> · <strong>English</strong>
</p>

# novus Phone Companion (Web Bluetooth)

The browser side of the novus voice assistant: **the phone is the network**.
The device stays a pure BLE peripheral; this page connects to it and does
everything else — device configuration and the ASR → LLM → TTS pipeline.

## What it does

| Tab | Function |
| --- | --- |
| Connect | Scan for the device (NUS service UUID, optional name prefix), pair, show battery / firmware / protocol from the `hello` event |
| Settings | Read and write device config: volume, mic gain (dB), brightness, screen timeout, device speech, character animation; reset pairing |
| Chat | Hold-to-talk (or act via the device's OK key), live transcript, typed questions, provider settings |

## Running it

Any static file server works — the page needs a secure context (`https://` or
`localhost`) for Web Bluetooth:

```bash
cd tools/novus-phone-webapp
python3 -m http.server 8000     # then open http://localhost:8000/ on the phone's browser
```

Or host the folder anywhere (GitHub Pages, an intranet server, ...).

- **Android Chrome / Edge**: full support (Web Bluetooth + WebCodecs).
- **iOS**: Safari does not implement Web Bluetooth; use the Bluefy browser.
- **Desktop Chrome** (Windows/macOS/Linux) also works for development.
- Add `?sim=1` for the simulation harness: a fake device exercises the entire
  page (protocol, turn flow, providers) without BLE hardware — useful for
  offline development and for trying the pipeline from a desktop browser.

## Providers (BYO keys, stored in your browser only)

All three stages are configurable OpenAI-compatible endpoints and are called
**directly from the browser** (CORS verified for the defaults). Keys are kept
in `localStorage` on the phone and are never sent to the device.

| Stage | Default | Notes |
| --- | --- | --- |
| ASR | `https://api.siliconflow.cn/v1`, `FunAudioLLM/SenseVoiceSmall` | WAV upload via `/audio/transcriptions`; a free SiliconFlow account works |
| LLM | `https://api.deepseek.com`, `deepseek-chat` | `/chat/completions`; any OpenAI-compatible base URL works |
| TTS | `https://api.siliconflow.cn/v1`, `FunAudioLLM/CosyVoice2-0.5B` | `/audio/speech`, `response_format: wav`, re-encoded to 16 k Opus 60 ms frames for the device |

If you would rather not use cloud TTS at all, uncheck the device-side speech
(the "phone speech" switch) — the phone then reads replies aloud with its
built-in `speechSynthesis` and nothing is downloaded. The device still shows
the reply text and mirrors the speaking animation (`speak_state` control).

## Protocol tests

The wire protocol (framing, resync, control messages, config validation) is
shared with the device and covered by node tests:

```bash
node test/protocol.test.js     # 20 tests, no browser needed
```

The page and the device follow the frozen protocol in `main/nov_protocol.h`;
when changing one side, change both and keep these tests green.
