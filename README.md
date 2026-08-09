# cue for Windows

This repository is a **Windows port and extension of [Blueturboguy07/cue](https://github.com/Blueturboguy07/cue)**, the open-source Cue overlay. The upstream project targets macOS; this fork adapts the application for Windows and adds Windows-specific screen, audio, shortcut, packaging, and provider behavior.

cue for Windows is a small personal Electron overlay. It stays above normal applications and combines three separate inputs:

- the display under the mouse cursor, captured only when a screen-aware feature runs;
- your microphone, labelled `You`;
- Windows system-output loopback audio, labelled `Them`.

Responses stream from the OpenAI, Anthropic, Gemini, or Z.AI model configured in local Settings. There is no cue account, backend, database, telemetry, cloud storage, updater, or public release service. API keys and settings are stored in Electron's local `cue-data.json` file and requests go directly to the selected provider.

> **Capture exclusion is best-effort, not a security boundary.** cue asks Windows to exclude the overlay from capture with Electron's content-protection API. Windows 10 version 2004+ normally maps this to `WDA_EXCLUDEFROMCAPTURE`, but individual screenshot, recording, and meeting applications may behave differently. Test cue with every application you rely on.

## Requirements

- Windows 10 version 2004 or later, or Windows 11
- x64 computer
- Node.js 18 or later (Node.js 20 or 22 LTS is recommended)
- npm
- An API key for at least one supported provider
- An OpenAI, Gemini, or Z.AI key for transcription features

## Run from source

Open PowerShell:

```powershell
git clone https://github.com/papycoda/cue-windows.git
cd cue-windows
npm ci
npm start
```

`npm start` runs the ordinary development build and is not platform-specific.

On first use, open cue Settings, choose OpenAI, Anthropic, Gemini, or Z.AI, and enter the relevant key and model names. Anthropic supports screen and text assistance but does not provide speech-to-text, so listening also needs an OpenAI, Gemini, or Z.AI key.

For Z.AI, cue uses the general API endpoint `https://api.z.ai/api/paas/v4/`. The defaults preserve screen-aware features:

- Fast: `glm-4.6v-flash`
- Smart: `glm-5v-turbo`
- Transcription: `glm-asr-2512`

All three identifiers remain editable in Settings. Z.AI requests go directly from cue to Z.AI using the locally stored key; cue does not use the separate Coding Plan endpoint.

## Build for personal local use

Create an unpacked Windows x64 application:

```powershell
npm run pack:win
```

Output:

```text
dist\win-unpacked\cue.exe
```

Create a portable unsigned x64 executable that does not require installation:

```powershell
npm run dist:win
```

Output:

```text
dist\cue-0.1.0-portable-x64.exe
```

These commands do not publish, sign, or upload anything. Windows may show a warning for a locally built unsigned executable.

Run the syntax checks separately with:

```powershell
npm run check
```

## Windows shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Assist using the current display and recent transcript |
| `Ctrl+H` | Solve the coding problem on the current display |
| `Ctrl+,` | Open cue Settings while cue has keyboard focus |
| `Ctrl+Shift+X` | Quit cue |
| `Enter` | Send typed text |
| `Shift+Enter` | Insert a newline |

Click the microphone **Listen** button in the top toolbar to start listening. While cue is recording and transcribing, the control turns red and reads **Stop**. Click the cue logo to reopen the guide. Drag the window using the top toolbar; empty transparent areas pass mouse input to the application below.

## How capture works

### Screen

cue captures the display nearest the current mouse cursor at that display's scale factor. This supports monitors positioned at negative desktop coordinates and mixed-DPI layouts. It falls back to the primary display, then the first source Electron provides.

### Microphone (`You`)

The renderer uses `getUserMedia()` and converts microphone samples to mono 16-bit PCM for transcription.

### System audio (`Them`)

The renderer requests `getDisplayMedia()`. The Electron main process supplies a desktop video source plus Windows `audio: 'loopback'`. The temporary video track is stopped immediately; the loopback audio remains separate from the microphone and is never connected audibly to the speakers.

When listening stops, cue stops accepting new samples, flushes meaningful audio remaining since the previous periodic transcription, waits defensively for final transcription requests, then clears its buffers.

## Troubleshooting

### Microphone access denied

Open **Settings > Privacy & security > Microphone** and enable microphone access and access for desktop applications. The guide's microphone button opens:

```text
ms-settings:privacy-microphone
```

Restart cue after changing privacy settings if Windows does not apply the change immediately.

### No system audio or `Them` transcript

- Confirm audio is playing through the Windows default output device.
- Start listening once and check the cue status message. It explicitly reports microphone-only or system-audio-only operation.
- Close other applications that may have exclusive access to the output device.
- Try the development build and the unpacked build separately.
- Verify that the OpenAI, Gemini, or Z.AI transcription key and transcription model in Settings are valid.
- Repeated clicks should not open multiple display-media requests. If they do, capture the renderer log and exact steps.

Do not add a virtual audio cable, native driver, or compiled helper unless standard Electron Windows loopback is tested on the target computer and proven inadequate.

### Screen capture failed or captured the wrong monitor

Move the mouse onto the intended display before using Assist or `Ctrl+H`. On mixed-DPI systems, verify the result is readable at the selected monitor's native scaling.

### cue appears in a screenshot or screen share

Content protection is best-effort. Compare behavior with protection disabled:

```powershell
$env:CUE_NO_PROTECT = '1'
npm start
```

Close that PowerShell session or remove the variable before starting cue normally:

```powershell
Remove-Item Env:CUE_NO_PROTECT
npm start
```

Test both modes with Windows Snipping Tool and the exact versions/settings of Zoom, Microsoft Teams, Google Meet, and OBS that you personally use. A failure in one application is an application-specific limitation and does not mean native capture-hiding code should be added automatically.

### Provider or model error

- Confirm the selected chat provider has a key and both Fast and Smart model fields are populated.
- Listening needs a valid OpenAI, Gemini, or Z.AI key even when Anthropic is the chat provider.
- OpenAI, Gemini, and Z.AI transcription model fields are editable in Settings.
- Existing custom model names are preserved. cue only migrates exact model identifiers that were former application defaults and are now retired.

## Manual Windows acceptance checklist

### Window and overlay

- cue launches without a JavaScript error.
- The background is transparent and the toolbar drags the window.
- The overlay remains above normal applications and absent from the taskbar.
- Empty areas pass clicks through while visible controls remain clickable.
- The window does not continually steal focus.

### Shortcuts and screen

- All shortcuts in the table above behave exactly once.
- The display under the cursor is captured in a multi-monitor setup.
- Mixed-DPI screenshots are usable.
- Compare capture protection enabled and disabled with `CUE_NO_PROTECT=1`.

### Audio and AI

- One click produces no more than one system-audio request.
- Microphone speech appears as `You`; computer or meeting output appears as `Them`.
- Mic and system audio remain separate and cue produces no audible echo.
- Stopping does not lose the last meaningful utterance.
- Rapid repeated start/stop leaves no orphaned tracks.
- Capture failures and degraded mic-only/system-only states appear in the UI.
- At least one transcription provider works and an OpenAI screen-aware response streams.
- Provider choices, custom model names, and API settings survive restart.

### Build

- `npm run pack:win` produces a runnable `dist\win-unpacked\cue.exe`.
- `npm run dist:win` produces a runnable `dist\cue-0.1.0-portable-x64.exe`.
- No installer, signing, or publishing is attempted.

## License

[GPL-3.0-or-later](LICENSE)
