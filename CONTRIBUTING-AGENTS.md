# Contributing to Memory and Guardian Agents

This guide is for contributors working **only on the Memory and Guardian agents** — you don't need macOS or Flicky to do this work. Pure Node.js, runs on Windows / macOS / Linux.

If you've never set this up before, follow this guide top to bottom. Should take ~30 minutes the first time, then ~30 seconds per iteration cycle after.

---

## Why this guide exists

The full Multi-Agent IT Assistant requires macOS (because Anthropic's Computer Use API drives the cursor through macOS-only `osascript`). But the **agent reasoning layer** — Memory and Guardian — is pure HTTP calls to the Anthropic API. It works identically on any OS.

So you can fully build, test, and tune Memory and Guardian on Windows or Linux without ever running Flicky.

---

## What you'll be working on

Two agents and their data:

| Agent | What it does | Files you edit |
|---|---|---|
| **Memory** | Searches past IT tickets, recommends a resolution path (scripted / computer_use / escalate) | `src/main/agents/memory.ts` (SYSTEM_PROMPT only) + `src/main/agents/data/company-tickets.json` |
| **Guardian** | Reviews proposed actions against NCA cybersecurity policies, returns approve / block / escalate | `src/main/agents/guardian.ts` (SYSTEM_PROMPT only) + `src/main/agents/data/company-policies.json` |

These four files are yours. **Don't edit anything else without asking the team lead first** — you'll create merge conflicts.

---

## Setup, step by step

### 1. Install Node.js 20+

Download from [nodejs.org](https://nodejs.org/) — pick the LTS version, run the installer, click through.

Verify:
```bash
node --version    # should print v20.x.x or higher
```

### 2. Install Git

- **Windows:** [git-scm.com](https://git-scm.com/) — installer
- **macOS:** comes preinstalled, or `brew install git`
- **Linux:** `apt install git` / equivalent

### 3. Get your own Anthropic API key

**Important:** every team member needs their own key, otherwise you share rate limits and run out fast.

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Sign up with your email
3. **Settings → Billing** → add **$5** to credit balance (one-time, doesn't expire)
4. **API Keys** → **Create Key** → name it something like `agent-dev`
5. **Copy the key immediately** — Anthropic only shows it once. Save it in a password manager.

### 4. Clone the repo

```bash
git clone https://github.com/HaneenAldossari/Multi-agent-IT-assistant
cd Multi-agent-IT-assistant
```

### 5. Install dependencies

```bash
npm install
```

Takes about 3 minutes. Don't worry about warnings — they're not fatal.

### 6. Set your API key in your terminal session

This is per-terminal-window — you'll re-do it each time you open a new terminal.

**macOS / Linux (bash, zsh):**
```bash
export ANTHROPIC_API_KEY=sk-ant-...your-actual-key...
```

**Windows (PowerShell):**
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-...your-actual-key..."
```

**Windows (Command Prompt):**
```cmd
set ANTHROPIC_API_KEY=sk-ant-...your-actual-key...
```

⚠️ **Important:** type the `export` / `$env:` part manually, then paste *only the key string* after the `=`. If you copy-paste the whole line from somewhere, invisible Unicode characters may sneak in and break it.

### 7. Verify the key is set

```bash
# macOS / Linux:
echo "key starts with $(echo $ANTHROPIC_API_KEY | cut -c1-12)..."

# Windows PowerShell:
echo "key starts with $($env:ANTHROPIC_API_KEY.Substring(0,12))..."
```

Should print: `key starts with sk-ant-api03...`

If it says "key starts with ..." with nothing — the key didn't get set. Re-do step 6.

### 8. Create your work branch

Always work on a branch, never directly on `main`:

```bash
git checkout -b agent-dev
```

(Or use a branch name with your initials, like `agents-na`.)

### 9. Run your first test

```bash
node scripts/test-memory.mjs "Outlook ما يفتح"
```

If everything works, you should see something like:

```
Loaded 12 past tickets from KB.

▶ Task: Outlook ما يفتح

  [tool] searchPastTickets("Outlook") → 3 matches

─── Memory verdict ───
{
  "similarTicketIds": ["INC-2024-1310", "INC-2024-1305", "INC-2024-1298"],
  "recommendedPath": "scripted",
  "scriptedTool": "restartApp",
  "scriptedArgs": { "name": "Microsoft Outlook" },
  "confidence": 0.9,
  "summaryArabic": "تم العثور على 3 حالات مماثلة، الحل المعتاد هو إعادة تشغيل Outlook"
}
```

If you see this, **everything works.** ✅ You're ready to develop.

---

## Your development loop

The fast loop is:

1. **Edit** `src/main/agents/data/company-tickets.json` (or any of your 4 files)
2. **Save** the file
3. **Run** `node scripts/test-memory.mjs "your test query in Arabic"`
4. **Read** the JSON verdict — is it the path you wanted?
5. **Adjust** the data or SYSTEM_PROMPT
6. **Repeat**

Each cycle takes ~30 seconds. No `npm run build` needed.

---

## Test scenarios you must support

The demo relies on these three scenarios. Test each one and make sure Memory routes correctly:

### Scenario 1 — Outlook won't open
```bash
node scripts/test-memory.mjs "Outlook ما يفتح"
```
**Expected:**
- `recommendedPath: "scripted"`
- `scriptedTool: "restartApp"`
- `scriptedArgs: { "name": "Microsoft Outlook" }`
- `confidence ≥ 0.7`

### Scenario 2 — Unauthorized software install
```bash
node scripts/test-memory.mjs "حمّل لي WinRAR من موقع غير معتمد"
```
**Expected:**
- `recommendedPath: "computer_use"` OR `"escalate"`
- (Memory deliberately doesn't have a clean match here — Guardian handles it.)

Then test Guardian on the next step:
```bash
node scripts/test-guardian.mjs "تثبيت برنامج WinRAR من موقع خارجي"
```
**Expected:**
- `verdict: "block"`
- `policyReference: "NCA-AAC-3-T4-1"`
- `suggestedAlternativeArabic` is populated with the company portal alternative

### Scenario 3 — Unknown internal app
```bash
node scripts/test-memory.mjs "تطبيق المالية الداخلي يعرض شاشة سوداء"
```
**Expected:**
- `recommendedPath: "computer_use"`
- `confidence ≤ 0.4` (low — no past match)

---

## Adding new tickets to Memory's KB

Open `src/main/agents/data/company-tickets.json`. Each ticket follows this exact format:

```json
{
  "id": "INC-2024-XXXX",
  "date": "2024-11-XX",
  "user_role": "موظف ...",
  "symptom_arabic": "وصف المشكلة بالعربية",
  "diagnosis": "السبب الجذري",
  "resolution_method": "scripted",
  "scripted_tool": "restartApp",
  "scripted_args": { "name": "Microsoft Outlook" },
  "resolution_steps": "ما تم القيام به",
  "outcome": "resolved",
  "resolution_time_seconds": 5,
  "category": "application_crash"
}
```

### Field-by-field

| Field | Allowed values | Notes |
|---|---|---|
| `id` | `INC-2024-XXXX` | Sequential. Pick a unique number. |
| `date` | `2024-MM-DD` | Within the last few months for realism. |
| `user_role` | Any Arabic role | "موظف مالية", "محاسب", "مدير مشاريع", etc. |
| `symptom_arabic` | Free Arabic text | This is the main field Memory matches against. Be specific. |
| `diagnosis` | Free text | Root cause analysis. Mix Arabic + English. |
| `resolution_method` | `scripted` / `computer_use` / `escalated` | Drives Memory's recommendation. |
| `scripted_tool` | `restartApp` / `openApp` / `quitApp` / `switchWifi` | **Only if** `resolution_method` is `scripted`. |
| `scripted_args` | `{ "name": "..." }` or `{ "ssid": "..." }` | **Only if** `resolution_method` is `scripted`. |
| `resolution_steps` | Free Arabic text | Brief explanation. |
| `outcome` | `resolved` / `escalated` | |
| `resolution_time_seconds` | Number | 0 for escalated, ~3-30 for resolved. |
| `category` | One of: `network_connectivity`, `application_crash`, `identity_access`, `performance`, `hardware`, `admin_required` | |

### Categories Memory must cover well

Add 2-3 tickets per category:

- ✅ Outlook crashes (already 3)
- ⚠️ More Outlook variations (different error messages)
- ⚠️ Slack / Teams crashes
- ⚠️ Browser issues (Safari/Chrome won't load specific sites)
- ⚠️ VPN connection failures
- ⚠️ Calendar sync problems
- ⚠️ Excel performance issues
- ⚠️ Password reset requests (escalated)
- ⚠️ Software install requests (escalated)
- ⚠️ Hardware issues (escalated)

Goal: 25-30 tickets total.

---

## Adding new policies to Guardian's KB

Open `src/main/agents/data/company-policies.json`. Format:

```json
{
  "id": "NCA-XXX-X-TX-X",
  "title_arabic": "عنوان السياسة",
  "rule_arabic": "نص القاعدة بالعربية",
  "applies_to_actions": ["action_type_1", "action_type_2"],
  "verdict_default": "approve",
  "blocks_action": false,
  "suggested_alternative_arabic": "النص البديل المقترح إن وُجد"
}
```

### Real NCA reference codes

The NCA Essential Cybersecurity Controls (ECC) framework has these top-level domains:
- **ECC-1** — Cybersecurity Governance
- **ECC-2** — Cybersecurity Defense
- **ECC-3** — Cybersecurity Resilience
- **ECC-4** — Third-Party Cybersecurity

You can search "NCA ECC framework controls" online for actual subdomain codes. For the demo it's enough to use plausible-looking codes (e.g., `NCA-ECC-2-T2-3-1`).

---

## Tuning the SYSTEM_PROMPT

If Memory or Guardian routes wrong despite having the right data, the issue is the SYSTEM_PROMPT.

### memory.ts SYSTEM_PROMPT (around line 115)

This tells Claude how to interpret the search results. If you want Memory to be more aggressive about recommending `scripted`, add stronger language like *"Always prefer scripted when there's a known fix."* If you want it to be more cautious about escalating, weaken the escalation criteria.

### guardian.ts SYSTEM_PROMPT (around line 95)

This tells Claude when to block vs approve. If Guardian is too permissive, tighten the policy criteria. If it blocks too aggressively, loosen.

After every prompt change, re-run all 3 demo scenarios to make sure nothing broke.

---

## Saving and pushing your work

End of each work session:

```bash
git status                      # see what you changed
git add src/main/agents/        # stage your files
git commit -m "Memory: added 8 more tickets covering VPN/Slack/Excel"
git push origin agent-dev       # push to your branch
```

Then message the team lead: "I pushed to `agent-dev`, please pull and test on Mac."

The team lead will:
1. Pull your branch
2. Run Flicky end-to-end with your latest agents
3. Verify the 3 demo scenarios still work
4. Merge to `main`

Next morning, sync your branch:

```bash
git checkout main
git pull
git checkout agent-dev
git rebase main
```

If `git rebase` complains about conflicts, **don't resolve them alone.** Message the team lead.

---

## Common errors and fixes

### "ANTHROPIC_API_KEY not set"
Re-export the env var. Remember it doesn't persist across terminal sessions.

### "rate_limit_error" / HTTP 429
You hit the per-minute token limit on tier-1 Anthropic accounts (30k tokens/min). Wait 60 seconds.

### "Cannot find module @anthropic-ai/claude-agent-sdk"
You forgot `npm install`, or you're in the wrong directory. Run it again from the repo root.

### Memory returns `recommendedPath: "unknown"` even though tickets exist
- Are the tickets being loaded? Check the script output — first line should say `Loaded N past tickets from KB`. If `N = 0`, the JSON is malformed.
- Validate your JSON: paste it into [jsonlint.com](https://jsonlint.com/). Trailing commas and unescaped quotes are the usual culprits.

### Memory routes to wrong path
- Check that at least one ticket actually matches the query keywords (read `symptom_arabic` and see if your test prompt's words appear there).
- Check that the matching tickets have the `resolution_method` field you expect.
- If both are right, tighten the SYSTEM_PROMPT.

### JSON parse fails in the agent's final output
Claude sometimes adds prose before/after the JSON. Tighten the SYSTEM_PROMPT with: *"Respond ONLY with the JSON object. No preamble, no commentary, no markdown fences."*

---

## When you're done

You're done when:
- ✅ All 3 demo scenarios route correctly via Memory
- ✅ Guardian correctly blocks software-install with alternative
- ✅ Guardian correctly approves Wi-Fi switch and app restart
- ✅ You have ≥ 25 tickets and ≥ 12 policies
- ✅ All your work is pushed to your branch
- ✅ Team lead confirms it works end-to-end on Mac

---

## Help

If you're stuck for more than 15 minutes, message the team lead with:
1. The exact command you ran
2. The full terminal output
3. What you expected vs what you got

Don't burn time alone. The point of working in a team is fast unblocking.
