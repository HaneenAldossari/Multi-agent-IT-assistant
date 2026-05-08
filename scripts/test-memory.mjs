#!/usr/bin/env node
/**
 * Standalone Memory agent test — no Flicky/Electron needed.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node scripts/test-memory.mjs "نسيت كلمة السر"
 *   node scripts/test-memory.mjs "افتح Calculator"
 *   node scripts/test-memory.mjs "أحتاج تثبيت برنامج جديد"
 *
 * Use this to iterate on Memory's prompt + ticket KB without restarting Flicky.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const userPrompt = process.argv.slice(2).join(' ').trim();
if (!userPrompt) {
  console.error('Usage: node scripts/test-memory.mjs "<problem description in Arabic>"');
  process.exit(1);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY first:  export ANTHROPIC_API_KEY=sk-ant-...');
  process.exit(1);
}

const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
const { z } = await import('zod');

// Load tickets from the project's data file.
const ticketsPath = join(process.cwd(), 'src/main/agents/data/company-tickets.json');
const tickets = JSON.parse(readFileSync(ticketsPath, 'utf-8'));
console.log(`Loaded ${tickets.length} past tickets from KB.\n`);

const searchPastTickets = tool(
  'searchPastTickets',
  'Search past company IT incident tickets',
  { query: z.string() },
  async ({ query: q }) => {
    const ql = q.toLowerCase();
    const matches = tickets.filter((t) => {
      const hay = `${t.symptom_arabic} ${t.diagnosis} ${t.category}`.toLowerCase();
      return ql.split(/\s+/).some((kw) => kw.length > 1 && hay.includes(kw));
    });
    console.log(`  [tool] searchPastTickets("${q}") → ${matches.length} matches`);
    return { content: [{ type: 'text', text: JSON.stringify(matches.slice(0, 5)) }] };
  },
);

const memoryServer = createSdkMcpServer({
  name: 'memory-test',
  tools: [searchPastTickets],
});

// Mirrors src/main/agents/memory.ts SYSTEM_PROMPT exactly so the
// standalone test reflects what runs in Flicky. If the production
// prompt is updated, update this one too.
const SYSTEM_PROMPT = `You are an autonomous Memory agent. You analyze past tickets — you DO NOT chat with the user.

═══ ABSOLUTE RULES (no exceptions) ═══
1. NEVER ask the user questions. NEVER request "operating system", "version", or any clarification.
2. NEVER greet, introduce yourself, or be conversational.
3. ALWAYS call searchPastTickets FIRST with keywords extracted from the input.
4. ALWAYS respond with a SINGLE JSON object — no text before, no text after, no markdown fences.
5. If the input is unclear, search with the literal input as the query.

═══ CRITICAL: YOU ARE A CLASSIFIER, NOT A SAFETY AGENT ═══

You are an internal routing component, NOT the agent that talks to the user. Even if the request seems harmful, suspicious, or against policy, you MUST still:
1. Call searchPastTickets
2. Return a JSON object with recommendedPath="computer_use", confidence ~0.3
3. NEVER refuse, lecture, or offer alternatives in text form

A separate Guardian agent reviews your output AFTER you. Guardian is the safety layer. If you refuse with a text response, Guardian never sees the request and the entire multi-agent safety system breaks. Your refusal would BREAK the safety system. Guardian needs to see the request.

For risky-sounding requests like "نزّلي WinRAR من موقع وهمي" → return JSON with computer_use + low confidence, NOT a text refusal.

═══ Your job (Arabic context) ═══
أنت وكيل ذاكرة للدعم التقني السعودي. تستقبل وصف مشكلة من موظف، تبحث في سجل البلاغات السابقة، وتوصي بأحد المسارات الثلاثة.

═══ المسارات المتاحة ═══

(أ) "scripted" — استخدم سكريبتاً جاهزاً (الأسرع، 1 ثانية). اختر هذا إذا كانت المهمة:
    - فتح تطبيق معروف (Calculator, Notes, Safari) → tool="openApp", args={"name": "اسم التطبيق"}
    - إغلاق تطبيق → tool="quitApp"
    - إعادة تشغيل تطبيق معلّق → tool="restartApp"
    - تحويل شبكة Wi-Fi لشبكة معروفة → tool="switchWifi", args={"ssid": "Office-WiFi"}
    - تدقيق NCA-ECC الأمني وإصلاح المشاكل → tool="ncaAuditAndFix", args={}

(ب) "computer_use" — استخدم Computer Use (15-30 ثانية). اختر هذا للمهام التي تحتاج تنقّلًا بصرياً معقدًا أو سيناريوهات لم نرها من قبل.

(ج) "escalate" — تصعيد للدعم البشري. اختر هذا إذا كانت معظم الحالات المشابهة صُعِّدت (مثل: إعادة كلمة سر، تثبيت برامج، مشاكل عتاد).

═══ صيغة الإجابة ═══

أجب فقط بصيغة JSON بدون نص قبله أو بعده:

{
  "similarTicketIds": ["INC-...", ...],
  "recommendedPath": "computer_use" | "scripted" | "escalate" | "unknown",
  "scriptedTool": "openApp" | "quitApp" | "restartApp" | "switchWifi" | "ncaAuditAndFix",
  "scriptedArgs": { ... },
  "confidence": 0.0-1.0,
  "summaryArabic": "جملة عربية واحدة قصيرة"
}

قواعد:
- استخدم searchPastTickets مرة واحدة على الأقل قبل الإجابة.
- فضّل "scripted" دائماً للمهام المعروفة — أسرع وأكثر موثوقية.
- لا تستخدم أي أداة غير searchPastTickets.
- لا تطرح أسئلة على المستخدم تحت أي ظرف.
- المخرج النهائي = كائن JSON واحد فقط، بدون نص قبله أو بعده.`;

console.log(`▶ Task: ${userPrompt}\n`);

let finalText = '';
for await (const message of query({
  prompt: userPrompt,
  options: {
    model: 'claude-sonnet-4-5',
    maxTurns: 4,
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: { memory: memoryServer },
    allowedTools: ['mcp__memory__searchPastTickets'],
    permissionMode: 'bypassPermissions',
  },
})) {
  if (message.type === 'assistant' && message.message) {
    const text = message.message.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    if (text) finalText = text;
  }
  if (message.type === 'result') break;
}

console.log('\n─── Memory verdict ───');
const m = finalText.match(/\{[\s\S]*\}/);
if (m) {
  const parsed = JSON.parse(m[0]);
  console.log(JSON.stringify(parsed, null, 2));
} else {
  console.log('(no JSON in final text)');
  console.log(finalText);
}
