#!/usr/bin/env node
/**
 * Standalone Guardian agent test — no Flicky/Electron needed.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node scripts/test-guardian.mjs "تم تحويل الشبكة لـ Office-WiFi"
 *   node scripts/test-guardian.mjs "إعادة تعيين كلمة سر المستخدم"
 *   node scripts/test-guardian.mjs "تثبيت برنامج جديد عبر Homebrew"
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const userPrompt = process.argv.slice(2).join(' ').trim();
if (!userPrompt) {
  console.error('Usage: node scripts/test-guardian.mjs "<proposed action in Arabic>"');
  process.exit(1);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY first.');
  process.exit(1);
}

const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
const { z } = await import('zod');

const policiesPath = join(process.cwd(), 'src/main/agents/data/company-policies.json');
const policies = JSON.parse(readFileSync(policiesPath, 'utf-8'));
console.log(`Loaded ${policies.length} policies from KB.\n`);

const lookupPolicy = tool(
  'lookupPolicy',
  'Look up NCA + company policies for a proposed action',
  { actionType: z.string() },
  async ({ actionType }) => {
    const a = actionType.toLowerCase();
    const matches = policies.filter((p) =>
      p.applies_to_actions.some((act) => act.toLowerCase().includes(a) || a.includes(act.toLowerCase())),
    );
    console.log(`  [tool] lookupPolicy("${actionType}") → ${matches.length} matches`);
    return { content: [{ type: 'text', text: JSON.stringify(matches.length > 0 ? matches : policies) }] };
  },
);

const guardianServer = createSdkMcpServer({
  name: 'guardian-test',
  tools: [lookupPolicy],
});

// Mirrors src/main/agents/guardian.ts SYSTEM_PROMPT exactly so the
// standalone test reflects what runs in Flicky. If the production
// prompt is updated, update this one too.
const SYSTEM_PROMPT = `أنت "وكيل الحارس" في فريق دعم تقني للموظفين السعوديين.

مهمتك:
1. اقرأ ملخّص الإجراء الذي اتخذه (أو يقترحه) وكيل المحلل.
2. استخرج نوع الإجراء (مثل switch_wifi، install_software، reset_password، restart_app).
3. استخدم أداة lookupPolicy للبحث عن السياسات ذات الصلة.
4. أصدر حكمك:
   - "approve": الإجراء آمن ومتوافق مع السياسات.
   - "block": الإجراء يخالف سياسة. **عند الحجب، إذا كانت السياسة تحتوي على suggested_alternative_arabic، يجب تضمين البديل في rationaleArabic.**
   - "escalate": الإجراء خارج صلاحيات الوكيل ويحتاج فريق بشري (مثل إعادة كلمة سر، عتاد).

أجب فقط بصيغة JSON بدون نص قبله أو بعده:

{
  "verdict": "approve" | "block" | "escalate",
  "rationaleArabic": "جملة عربية قصيرة تشرح القرار",
  "policyReference": "NCA-...",
  "suggestedAlternativeArabic": "نص البديل المعتمد إن وُجد، وإلا أهمل الحقل",
  "suggestedSearchQuery": "نص بحث Google باللغة الإنجليزية للبديل، من حقل suggested_search_query في السياسة"
}

قواعد:
- استخدم lookupPolicy مرة واحدة على الأقل.
- اختر السياسة الأكثر صلة كـ policyReference.
- إذا لم تجد سياسة ذات صلة، استخدم "approve" مع policyReference="NCA-DEFAULT".
- عند الحجب لطلب تثبيت برنامج خارجي: ارفض بشدّة واقترح بوابة البرامج المعتمدة.`;

console.log(`▶ Action: ${userPrompt}\n`);

let finalText = '';
for await (const message of query({
  prompt: userPrompt,
  options: {
    model: 'claude-sonnet-4-5',
    maxTurns: 4,
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: { guardian: guardianServer },
    allowedTools: ['mcp__guardian__lookupPolicy'],
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

console.log('\n─── Guardian verdict ───');
const m = finalText.match(/\{[\s\S]*\}/);
if (m) console.log(JSON.stringify(JSON.parse(m[0]), null, 2));
else console.log(finalText);
