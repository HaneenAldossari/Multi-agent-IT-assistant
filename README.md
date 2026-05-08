# Multi-Agent IT Assistant

> المساعد التقني متعدد الوكلاء — voice-driven, screen-aware IT support agent. Arabic-first. Built for Saudi enterprises.
> Submission for **Agenticthon 2026, Track 2: Multi-Agent Systems.**

The employee holds a hotkey, describes a problem in Arabic, and three AI agents collaborate to actually fix it on the user's screen — no ticket, no waiting.

Built on a fork of [Flicky](https://github.com/jvaught01/flicky) (Electron desktop AI companion, MIT-licensed).

---

## The three agents

```
User speaks problem
       ↓
┌──────────────────────────────────────────────────┐
│ MEMORY (الذاكرة)                                  │
│ Searches past company IT tickets.                 │
│ Recommends a path:                                │
│   • scripted   — fast known fix (~1s)            │
│   • computer_use — agent drives the cursor (~20s)│
│   • escalate   — needs a human                    │
└──────────────────────────────────────────────────┘
       ↓
┌──────────────────────────────────────────────────┐
│ RESOLVER (المُحلِّل)                                │
│ Either runs the scripted tool, OR drives the     │
│ macOS cursor + keyboard via Anthropic Computer   │
│ Use API in a closed loop until the problem is    │
│ verifiably fixed.                                 │
└──────────────────────────────────────────────────┘
       ↓
┌──────────────────────────────────────────────────┐
│ GUARDIAN (الحارس)                                 │
│ Reviews the proposed action against NCA          │
│ cybersecurity policies. Returns:                  │
│   • approve   — action is safe                    │
│   • block     — violates policy + suggests a     │
│                  compliant alternative            │
│   • escalate  — outside agent scope               │
└──────────────────────────────────────────────────┘
       ↓
Final Arabic response to the user
```

Each agent is a separate **Claude Sonnet 4.5** call with its own goal, system prompt, and tools — wired via the official **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). No frameworks beyond the SDK itself.

---

## Quick start — 3 paths depending on your OS and goal

### Path A — Develop and test Memory + Guardian agents (any OS, **no Flicky needed**)

This is what teammates working on agents should do. Pure Node.js, runs on Windows / macOS / Linux. No Electron, no GUI, no Computer Use.

#### Prerequisites
- **Node.js 20+** — download from [nodejs.org](https://nodejs.org)
- **Git** — [git-scm.com](https://git-scm.com)
- **An Anthropic API key** — sign up at [console.anthropic.com](https://console.anthropic.com), add **$5** to your credit balance, create a key, copy it (only shown once).
- A code editor (VS Code recommended)

#### 1. Clone and install
```bash
git clone https://github.com/HaneenAldossari/Multi-agent-IT-assistant
cd Multi-agent-IT-assistant
npm install
```
(`npm install` takes ~3 minutes.)

#### 2. Set your API key in your terminal session

**macOS / Linux (bash/zsh):**
```bash
export ANTHROPIC_API_KEY=sk-ant-...your-key-here...
```

**Windows (PowerShell):**
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-...your-key-here..."
```

**Windows (cmd):**
```cmd
set ANTHROPIC_API_KEY=sk-ant-...your-key-here...
```

Verify it took:
```bash
# macOS/Linux:
echo "key starts with $(echo $ANTHROPIC_API_KEY | cut -c1-12)..."
# Windows PowerShell:
echo "key starts with $($env:ANTHROPIC_API_KEY.Substring(0,12))..."
```
Should print: `key starts with sk-ant-api03...`

#### 3. Test the Memory agent
```bash
node scripts/test-memory.mjs "Outlook ما يفتح"
```

You should see something like:
```
Loaded 12 past tickets from KB.

▶ Task: Outlook ما يفتح

  [tool] searchPastTickets("...") → 3 matches

─── Memory verdict ───
{
  "similarTicketIds": ["INC-2024-1310", "INC-2024-1305", "INC-2024-1298"],
  "recommendedPath": "scripted",
  "scriptedTool": "restartApp",
  "scriptedArgs": { "name": "Microsoft Outlook" },
  "confidence": 0.9,
  "summaryArabic": "تم العثور على 3 حالات مماثلة..."
}
```

If you see this, **everything works.** ✅

#### 4. Test the Guardian agent
```bash
node scripts/test-guardian.mjs "تثبيت برنامج WinRAR من موقع غير معتمد"
```

You should see a verdict like:
```json
{
  "verdict": "block",
  "rationaleArabic": "...",
  "policyReference": "NCA-AAC-3-T4-1",
  "suggestedAlternativeArabic": "استخدم بوابة البرامج المعتمدة..."
}
```

#### 5. Iterate

Edit the JSON files in `src/main/agents/data/`, save, re-run the test scripts. Loop is ~30 seconds per cycle. **No `npm run build` needed for agent work.**

---

### Path B — Run the full Flicky app (**macOS only**)

This is what the team lead does for end-to-end testing. Computer Use requires macOS — Windows/Linux can't run this path.

#### Additional prerequisites
- **macOS** (Sonoma or later)
- **A Groq API key** — for Arabic Whisper voice transcription. Free tier from [console.groq.com](https://console.groq.com).
- **Accessibility permission** for Electron (System Settings → Privacy & Security → Accessibility → enable Electron)
- **Screen Recording permission** for Electron

#### Run
```bash
cd Multi-agent-IT-assistant
npm install
npm run build
npm start
```

#### Configure keys in the tray panel
1. Click the Flicky tray icon in the macOS menu bar
2. **Mind tab** → paste your Anthropic key, set provider to Anthropic, model to Claude Sonnet 4.5
3. **Ear tab** → paste your Groq key, set transcription model to `whisper-large-v3`
4. **General tab** → set Stream visibility to "Always" (so you can see responses)

#### Use it
1. Press `Ctrl + Cmd + X` (the PTT shortcut)
2. Speak in Arabic — describe a problem
3. Press the shortcut again to stop recording
4. Watch the agent panel pulse blue while Computer Use solves it

---

### Path C — Develop agents on Windows, integrate on Mac

Two-machine team workflow — recommended for hackathon teams of 2.

**Person on Mac (team lead):**
- Owns: Resolver, Computer Use, Flicky integration, demo recording
- Workflow: Path B above

**Person on Windows (agent dev):**
- Owns: Memory, Guardian, ticket KB, policy KB, prompts
- Workflow: Path A above
- Cannot run full Flicky, but doesn't need to

**Daily integration:**
- Windows dev pushes their branch every evening: `git push origin agent-dev`
- Mac lead pulls and merges to `main`, runs end-to-end on macOS
- Mac lead pushes any integration fixes back to `main`
- Windows dev pulls `main` next morning

---

## File ownership

To prevent merge conflicts, agree on ownership before starting:

| File / directory | Editable by | Why |
|---|---|---|
| `src/main/agents/data/company-tickets.json` | Agent dev | Memory's knowledge base |
| `src/main/agents/data/company-policies.json` | Agent dev | Guardian's policy KB |
| `src/main/agents/memory.ts` (SYSTEM_PROMPT only) | Agent dev | Memory's reasoning |
| `src/main/agents/guardian.ts` (SYSTEM_PROMPT only) | Agent dev | Guardian's reasoning |
| `src/main/agents/computer-use.ts` | Mac lead | Resolver's Computer Use loop |
| `src/main/agents/tools/computer.ts` | Mac lead | macOS osascript wrappers |
| `src/main/agents/tools/scripted.ts` | Mac lead | Scripted shell command tools |
| `src/main/agents/orchestrator.ts` | Mac lead (touch sparingly) | Wires the agents together |
| `src/main/companion-manager.ts` | Mac lead | Voice/screenshot pipeline |
| `src/renderer/**/*` | Mac lead | UI |

**Rule:** if you need to edit a file in someone else's column, **message them first.**

---

## Project structure

```
src/
├── main/                         Electron main process (Node.js)
│   ├── agents/
│   │   ├── orchestrator.ts       Pipeline: Memory → Resolver → Guardian
│   │   ├── memory.ts             Memory agent (Claude Agent SDK)
│   │   ├── resolver.ts           (legacy stub, not used currently)
│   │   ├── guardian.ts           Guardian agent (Claude Agent SDK)
│   │   ├── reporter.ts           (legacy stub, folded into orchestrator)
│   │   ├── computer-use.ts       Anthropic Computer Use loop (Resolver)
│   │   ├── types.ts              Shared agent types
│   │   ├── data/
│   │   │   ├── company-tickets.json    Memory's knowledge base
│   │   │   └── company-policies.json   Guardian's policy KB
│   │   └── tools/
│   │       ├── computer.ts       osascript wrappers (clickAt, typeText, etc.)
│   │       └── scripted.ts       Fast scripted tools (openApp, restartApp, etc.)
│   ├── services/
│   │   ├── transcription.ts      Groq Whisper Arabic transcription
│   │   ├── screen-capture.ts     macOS desktopCapturer
│   │   ├── claude-api.ts         (legacy single-call vision; not used)
│   │   ├── elevenlabs-tts.ts     Optional Arabic TTS
│   │   └── key-store.ts          safeStorage encrypted key vault
│   ├── companion-manager.ts      Voice → screenshot → orchestrator pipeline
│   ├── windows.ts                Electron BrowserWindow factories
│   └── index.ts                  Tray + global shortcut + IPC
├── renderer/                     UI (React + vanilla TS)
│   ├── panel.tsx                 Settings panel (Mind / Ear / General tabs)
│   ├── stream.tsx                Floating live-response window
│   ├── overlay.tsx               (legacy fullscreen cursor — disabled)
│   ├── agent-panel.{ts,html,css} Top-left "agent working" panel
│   ├── rec-pill.{ts,html,css}    Bottom-center recording indicator
│   └── target-cursor.{ts,html,css}  (legacy floating bubble — disabled)
├── preload/index.ts              contextBridge between main ↔ renderer
└── shared/types.ts               Shared TS types + IPC channel constants

scripts/
├── test-memory.mjs               Standalone Memory test (any OS, no Flicky)
├── test-guardian.mjs             Standalone Guardian test (any OS, no Flicky)
└── test-computer-use.mjs         Standalone Computer Use test (macOS only)

docs/
└── pitch-deck.pptx               Agenticthon proposal deck

design-mockups/
└── scenario-demo.html            HTML demo for voiceover recording
```

---

## The three demo scenarios

The system is currently tuned to handle these three live demo scenarios:

### 1. Outlook won't open — Memory wins
**User says:** "Outlook ما يفتح" / "Outlook is broken"

- Memory finds 3 matching past tickets (INC-2024-1310, 1305, 1298) all resolved by `restartApp`
- Confidence ~0.9 → recommends `scripted: restartApp(Microsoft Outlook)`
- Resolver runs `osascript quit + open` in ~1 second
- Guardian approves under policy NCA-DSP-2-T3-5
- **Total time: ~3 seconds**

### 2. Unauthorized software — Guardian wins
**User says:** "حمّل لي WinRAR من موقع غير معتمد"

- Memory finds no clean match → recommends `computer_use`
- Resolver tries to navigate → Guardian intercepts
- Guardian queries policy NCA-AAC-3-T4-1 → returns `block` + `suggestedAlternativeArabic`
- User sees: "Blocked. Use the company software portal — 7-Zip is the approved alternative to WinRAR."
- **Total time: ~5 seconds**

### 3. Unknown app — Resolver explores
**User says:** "تطبيق المالية الداخلي يعرض شاشة سوداء"

- Memory finds no match, low confidence → recommends `computer_use` freely
- Resolver runs full Computer Use loop, explores via Spotlight + Finder + Activity Monitor
- Guardian approves diagnostic actions
- **Total time: ~20-30 seconds**

---

## Tech stack

| Layer | Tech |
|---|---|
| Desktop shell | Electron 33 + React 19 + TypeScript 5.7 + Vite 6 |
| Voice | Groq Whisper Large v3 (Arabic) |
| Brain (all 3 agents) | Anthropic Claude Sonnet 4.5 via [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| Screen control | Anthropic Computer Use API + macOS `osascript` |
| Memory KB | JSON file + naive keyword matching (production: ChromaDB + Voyage embeddings) |
| Policy KB | JSON file + keyword matching (production: same) |
| Cursor primitives | osascript wrappers, no native deps |

**Frameworks intentionally NOT used:** Mastra, LangGraph, CrewAI, Botpress, VoltAgent. Direct API + the official Anthropic SDK is enough for this scope.

---

## Common errors and fixes

### "ANTHROPIC_API_KEY not set"
Re-export the env var. Note that env vars don't persist across terminal sessions — you have to set it in each new terminal window.

### `rate_limit_error` (HTTP 429)
Tier-1 Anthropic accounts have a 30,000 input tokens/minute limit. Wait 60 seconds and retry. The Computer Use loop has automatic retry-with-backoff built in.

### "fetch failed" from Groq
Groq's free tier sometimes drops requests. Retry the PTT press, or check your Groq key.

### Memory returns wrong path
Check `src/main/agents/data/company-tickets.json`:
- Does at least one ticket actually match the user's query (by keyword)?
- Is its `resolution_method` field set to the path you want?
- Is `scripted_tool` filled in if `resolution_method` is `scripted`?

If yes to all and Memory still picks wrong path, tighten the SYSTEM_PROMPT in `memory.ts`.

### "Cannot find application named X" when running scripted `openApp`
The app isn't installed under that exact name. Check `/Applications/` on macOS for the real name.

### Computer Use opens Spotlight but doesn't type
macOS Accessibility permission missing. Grant Electron access in System Settings → Privacy & Security → Accessibility.

### "App threw an error during load" with `ERR_REQUIRE_ESM`
You're on a stale build. Run `npm run build` and restart Flicky.

---

## Built on Flicky

This project is a fork of [Flicky by Jason Vaught](https://github.com/jvaught01/flicky), MIT-licensed. Flicky itself is an Electron reimagining of [Clicky by Farza](https://github.com/farzaa/clicky). Credit for the underlying desktop-companion-cursor pattern goes to them. Our contribution: the multi-agent architecture, Arabic-first UX, and Saudi-enterprise NCA-compliance angle.

---

## Team

- **Haneen Aldossari** — software engineering, Resolver + Computer Use, Flicky integration, demo recording (PSAU CS)
- **Noura Aldossari** — AI engineering, Memory + Guardian agents, knowledge bases (PSAU CS)

---

## License

MIT, inherited from Flicky. See [LICENSE](LICENSE).
