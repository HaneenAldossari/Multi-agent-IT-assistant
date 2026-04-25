# Multi-Agent IT Assistant

> المساعد التقني متعدد الوكلاء — voice-driven, screen-aware IT support, Arabic-first, built for Saudi enterprises.
> Submission for **Agenticthon 2026, Track 2: Multi-Agent Systems.**

The employee holds a hotkey, describes a problem in Arabic, and the assistant captures the screen, reasons about it, and points the cursor at the fix with an Arabic label. Behind the scenes, four specialized agents — Memory, Resolver, Guardian, and Reporter — collaborate to produce the answer.

---

## Status

**Proposal phase.** A single OpenAI gpt-4o vision call returns a real Arabic response and cursor coordinates over a real screenshot, dressed up by a four-agent visualization panel.

**Hackathon phase.** The single call is replaced by the locked stack: four Claude Sonnet agents (Memory, Resolver, Guardian, Reporter) coordinated by a small TypeScript orchestrator, with a ChromaDB / Voyage AI RAG layer over past tickets and policy documents. Both phases share the same UI shell and Electron plumbing.

## How it works

1. Press the configured shortcut (default: `Ctrl + Cmd + X`)
2. Speak in Arabic — describe what's wrong on screen
3. Press the shortcut again to stop recording
4. The agent panel animates while the model reasons about your screenshot
5. A response appears in the streaming panel; a blue cursor flies to the suggested UI element with an Arabic label

## Run locally

```bash
npm install
npm run build
npm start
```

Open the panel from the macOS menu bar tray icon. Configure keys:

- **Ear** tab → Groq API key (required — used for Arabic Whisper transcription)
- **Mind** tab → OpenAI key (proposal demo) or Anthropic key (hackathon phase)
- **Voice** tab → ElevenLabs (optional, for spoken responses)

Keys are stored locally via Electron's `safeStorage` (Keychain / DPAPI / libsecret).

## Project layout

```
src/
├── main/                    Electron main process
│   ├── index.ts             tray, windows, IPC, global shortcuts
│   ├── companion-manager.ts integration boundary — request lifecycle
│   ├── windows.ts           five window factories (panel, overlay, stream,
│   │                        agent-panel, rec-pill, target-cursor)
│   └── services/            transcription, TTS, screen capture, key store
├── renderer/
│   ├── panel.tsx            main settings + chat panel (React)
│   ├── overlay.tsx          fullscreen transparent overlay (cursor)
│   ├── stream.tsx           live response window (React)
│   ├── agent-panel.ts       four-agent collaboration animation (vanilla TS)
│   ├── rec-pill.ts          Wispr-style recording pill (vanilla TS)
│   └── target-cursor.ts     small floating cursor + Arabic label (vanilla TS)
├── preload/index.ts         contextBridge — Main ↔ Renderer IPC
└── shared/types.ts          shared TS types + IPC channel constants

docs/
└── pitch-deck.pptx          Agenticthon proposal deck (generated)

scripts/
└── build_pitch_deck.py      reproducible deck generator (python-pptx)
```

## Pitch deck

The Agenticthon proposal deck lives at `docs/pitch-deck.pptx`. Don't edit it by hand — edit `scripts/build_pitch_deck.py` and re-run:

```bash
pip install python-pptx
python3 scripts/build_pitch_deck.py
```

## Built on Flicky

This project is a fork of [Flicky by Jason Vaught](https://github.com/jvaught01/flicky), MIT-licensed. Flicky itself is an Electron reimagining of [Clicky by Farza](https://github.com/farzaa/clicky). All credit for the original desktop-companion-cursor pattern, the pointing interaction, and the underlying mechanics goes to them. The contribution here is the multi-agent orchestration layer, Arabic-first UX, and Saudi-enterprise context (NCA-compliant audit trail).

## Team

- **Haneen Aldossari** — CS student at PSAU
- **Noura Aldossari** — CS student at PSAU

## License

MIT, inherited from Flicky. See [LICENSE](LICENSE).
