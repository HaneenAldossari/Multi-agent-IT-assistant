# Demo Scenarios — fixed contract for the Agenticthon submission

This document is the **source of truth** for the three demo scenarios. Memory and Guardian must be tuned so each scenario flows exactly as described below. Resolver and the panel UI are already wired.

If you change a scenario here, both Memory's KB (`data/company-tickets.json`) and Guardian's KB (`data/company-policies.json`) must be updated accordingly. Don't change scenarios silently — they're locked for the demo.

---

## Scenario A — Security Check & Auto-Fix (NCA-aligned)
*"Resolver scripted with multi-step visible work"*

### Voice trigger (Arabic)
The user says one of:
- **"افحصي إعدادات الأمان في جهازي وأصلحي المشاكل"**
- **"تأكدي إن جهازي مطابق لمتطلبات الأمن السيبراني السعودي"**
- **"افحصي أمان جهازي وفق معايير NCA"**

### Polished Arabic phrasing notes
- Use "**فحص الأمان**" (security check) instead of "تدقيق الامتثال" (compliance audit) — cleaner, more natural
- Use "**مطابق / غير مطابق**" instead of "متوافق / غير متوافق" — more accurate Arabic
- Use "**معايير NCA**" instead of "ضوابط NCA" — natural everyday phrasing

### Expected flow

| Step | Agent | What happens | Time |
|---|---|---|---|
| 1 | Memory | Searches KB → finds `INC-2024-1363` (audit+fix playbook) → `recommendedPath: "scripted"`, `scriptedTool: "ncaAuditAndFix"`, `confidence: 0.9` | ~3s |
| 2 | Resolver | Runs `ncaAuditAndFix` with step callbacks → panel narrates each NCA check (5 items) → identifies failures → applies safe fixes → opens Settings panes for sudo-required items → re-audits | ~12s with deliberate pacing |
| 3 | Guardian | Reviews the action → `verdict: approve`, `policyReference: "NCA-ECC-2-T6-2"` (audit is itself a compliance activity) | ~3s |
| 4 | Reporter | Final Arabic summary with before/after score | ~1s |

### Memory ticket required
```json
{
  "id": "INC-2024-1363",
  "symptom_arabic": "افحص جهازي وأصلح مشاكل الامتثال للأمن السيبراني",
  "resolution_method": "scripted",
  "scripted_tool": "ncaAuditAndFix",
  "scripted_args": {},
  "category": "compliance_audit"
}
```
Add 2-3 variations with different phrasings of "audit/fix compliance/NCA" so Memory matches reliably.

### What judges see
- Agent panel pulses blue for ~15 seconds
- Resolver row updates **every ~700ms** showing each check name + result icon
- Two System Settings windows visibly pop open (Firewall, Software Update)
- Final score: **2/5 → 3/5** (or whatever your test Mac's baseline is)
- Narrator: "*The agent ran 5 NCA controls, fixed what's safe to fix, opened settings for what needs admin authorization, refused to auto-enable FileVault because of data-loss risk. That's not just automation — that's judgment.*"

---

## Scenario B — Memory + Guardian Collaboration
*"The system blocks an unsafe action and offers a compliant alternative"*

### Voice trigger (Arabic)
- **"حمّل لي WinRAR من موقع غير معتمد"**
- **"ثبّت لي برنامج فك الضغط من الإنترنت"**
- **"اعمل لي download لـ WinRAR من أول رابط في Google"**

### Expected flow (Guardian intercepts BEFORE Resolver acts)

| Step | Agent | What happens | Time |
|---|---|---|---|
| 1 | Memory | Searches KB → no clean scripted match → `recommendedPath: "computer_use"`, low confidence (~0.4) | ~3s |
| 2 | Guardian (PRE-CHECK) | Receives intent: voice transcript + Memory analysis. Queries `lookupPolicy("install_software")` → finds `NCA-AAC-3-T4-1` → returns `verdict: "block"` + `suggestedAlternativeArabic` | ~4s |
| 3 | Resolver | **SKIPPED** — never runs. Panel shows "تم منع الإجراء قبل التنفيذ" | 0s |
| 4 | Reporter | Surfaces Guardian's block + alternative to the user in stream window | ~1s |

**This is the key change vs the old flow:** Guardian runs BEFORE Resolver. The harmful action never lands. The pitch line "*a single agent would have downloaded the file. Watch what multi-agent does — Guardian intercepts before any action lands and offers the compliant alternative*" is now literally true.

### Memory ticket required (NEGATIVE — to NOT match strongly)
Memory should NOT have a high-confidence scripted match for "install software". The closest tickets should be `INC-2024-1180` (escalated for admin install). Memory should route to `computer_use` with low confidence so Guardian gets to intervene.

### Guardian policy required
```json
{
  "id": "NCA-AAC-3-T4-1",
  "title_arabic": "تثبيت البرامج الجديدة من مصادر خارجية",
  "rule_arabic": "تثبيت أي برنامج من مصدر خارجي ممنوع منعاً باتاً...",
  "applies_to_actions": ["install_software", "install_app", "download_executable", "install_from_url"],
  "verdict_default": "block",
  "blocks_action": true,
  "suggested_alternative_arabic": "استخدم بوابة البرامج المعتمدة في الشركة — 7-Zip بدلاً من WinRAR"
}
```

### What judges see
- Memory pulses, then says "no clean match — let Resolver explore"
- Resolver pulses briefly, starts Computer Use
- Guardian intervenes mid-execution → red glow → BLOCK + alternative
- Reporter delivers the message: "تم الحجب. البديل: 7-Zip من بوابة الشركة"
- Narrator: "*A single-agent system would have downloaded the file. Watch what multi-agent does — Guardian intercepts before any action lands and offers the compliant alternative. The agents negotiate. The user gets what they need, safely.*"

---

## Scenario C — Network Diagnostic via Terminal (Computer Use)
*"Resolver autonomously runs a real IT troubleshooting workflow"*

### Voice trigger (Arabic)
- **"افحصي اتصال الإنترنت عبر ping"**
- **"شغّلي ping على google من Terminal"**
- **"اعمل تشخيص شبكة عبر ping"**

### What it solves
The single most common first step of any IT support call: "is your internet working — try pinging something." This is **what an IT technician does manually** when an employee complains of network issues. The agent does it autonomously and reports results in Arabic.

### Expected flow

| Step | Agent | What happens | Time |
|---|---|---|---|
| 1 | Memory | Searches KB → no exact match for "ping diagnostic" → `recommendedPath: "computer_use"`, `confidence: 0.4`, summary "لم أجد سيناريو سابقاً مطابقاً — أوصي بالتحكم البصري لتشخيص الشبكة" | ~3s |
| 2 | Resolver | Enters Computer Use loop: cmd+space → "Terminal" → Return → types `ping -c 4 google.com` → Return → reads output | ~20-25s |
| 3 | Guardian | Reviews each step → all approved (running diagnostic commands in Terminal is policy-compliant) | ~3s |
| 4 | Reporter | Reports the diagnostic result in Arabic, e.g. "الاتصال سليم — متوسط زمن الاستجابة 12ms" | ~1s |

### Memory ticket required (DELIBERATELY ABSENT)
Memory should **not** have a strong scripted match for "ping" / "network diagnostic". The point is to show novel-problem exploration. Memory should return:
- `recommendedPath: "computer_use"` (NOT scripted, NOT escalate)
- `confidence: ~0.3-0.5` (low — admitting it doesn't have a playbook)
- `summaryArabic`: something like "لم أجد سيناريو سابقاً مطابقاً، يحتاج تحكّم بصري"

### Guardian policy required
```json
{
  "id": "NCA-OPN-1-T1-3",
  "title_arabic": "فتح التطبيقات عبر Spotlight",
  "rule_arabic": "يُسمح بفتح أي تطبيق مثبَّت مسبقاً عبر Spotlight دون موافقة إضافية",
  "applies_to_actions": ["open_app", "launch_app", "spotlight_search"],
  "verdict_default": "approve"
}
```

### What judges see
- Memory pulses → "no past match, recommending Computer Use"
- Resolver enters Computer Use → cursor visibly opens Spotlight
- Terminal launches in a visible window
- Command `ping -c 4 google.com` types out character-by-character
- Return pressed → ping output appears live (4 reply lines + average time)
- Final Arabic report includes the actual measured latency
- **Narrator:** "*This is the first thing every IT technician does — open Terminal, ping a known host, check response time. The agent did it without a script — just like a human IT engineer would. No pre-programmed recipe, real agentic problem-solving.*"

### Voice trigger refinement for Memory matching
Add 2-3 negative tickets so Memory routes vague network queries to Computer Use rather than escalating:

```json
{
  "id": "INC-2024-1370",
  "symptom_arabic": "تشخيص شبكة عبر terminal",
  "resolution_method": "computer_use",
  "category": "network_diagnostic",
  "playbook_notes": "no scripted playbook — Resolver explores via Terminal+ping"
}
```

---

## Demo lineup (90-second video)

Run in this exact order for narrative impact:

1. **Scenario A** *(NCA audit + fix)* — opens with the Saudi-enterprise hook
2. **Scenario C** *(Calculator via Computer Use)* — proves novel-problem capability
3. **Scenario B** *(WinRAR block)* — the multi-agent moment, leaves judges with the safety message

Total: ~50 seconds of execution + narration = under 2 minutes.

---

## Contract for Memory development (Noura)

Your Memory agent + ticket KB MUST satisfy:

| Voice trigger | Expected Memory output |
|---|---|
| "افحص جهازي وأصلح مشاكل الامتثال" | `{ recommendedPath: "scripted", scriptedTool: "ncaAuditAndFix", confidence: ≥0.7 }` |
| "حمّل لي WinRAR من موقع غير معتمد" | `{ recommendedPath: "computer_use", confidence: ≤0.5 }` (NOT scripted, NOT escalate — leave the door open for Guardian to intervene) |
| "افتح Calculator" | `{ recommendedPath: "computer_use", confidence: ≤0.4 }` |
| "Mail ما يفتح" | `{ recommendedPath: "scripted", scriptedTool: "restartApp", scriptedArgs: { name: "Mail" }, confidence: ≥0.7 }` (legacy, still supported) |
| "نسيت كلمة السر" | `{ recommendedPath: "escalate", confidence: ≥0.8 }` |

Test each via `node scripts/test-memory.mjs "<trigger>"`. If any of these don't return the expected output, the demo will fail — your prompt or KB needs adjustment.

---

## Contract for Guardian development (Noura)

Your Guardian agent + policies KB MUST satisfy:

| Action description | Expected Guardian output |
|---|---|
| "تثبيت برنامج WinRAR من موقع غير معتمد" | `{ verdict: "block", policyReference: "NCA-AAC-3-T4-1", suggestedAlternativeArabic: <portal alternative> }` |
| "إعادة تشغيل Mail" | `{ verdict: "approve", policyReference: "NCA-DSP-2-T3-5" }` |
| "تشغيل تدقيق NCA-ECC" | `{ verdict: "approve", policyReference: "NCA-ECC-2-T6-2" }` |
| "تحويل الشبكة لـ Office-WiFi" | `{ verdict: "approve", policyReference: "NCA-ECC-2-T2-3-1" }` |
| "إعادة تعيين كلمة المرور" | `{ verdict: "escalate" }` |

Test each via `node scripts/test-guardian.mjs "<action>"`.
