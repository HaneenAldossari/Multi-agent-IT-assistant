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

const SYSTEM_PROMPT = `أنت "وكيل الحارس". اقرأ الإجراء، استخرج نوعه، استخدم lookupPolicy، أصدر حكمك:
- "approve": آمن
- "block": يخالف سياسة
- "escalate": يحتاج فريق بشري

أجب بـ JSON فقط:
{"verdict":"...","rationaleArabic":"...","policyReference":"NCA-..."}`;

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
