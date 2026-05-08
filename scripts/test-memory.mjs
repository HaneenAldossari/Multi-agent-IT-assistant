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

const SYSTEM_PROMPT = `أنت "وكيل الذاكرة". ابحث في سجل البلاغات السابقة، حلّل النتائج، وأوصِ بمسار:
- "scripted" مع scriptedTool ("openApp"|"quitApp"|"restartApp"|"switchWifi") و scriptedArgs للمهام السهلة
- "computer_use" للمهام المعقّدة
- "escalate" للحالات التي صُعِّدت سابقاً (مثل إعادة كلمة سر، تثبيت برامج، عتاد)

أجب بـ JSON فقط:
{"similarTicketIds":[...],"recommendedPath":"...","scriptedTool":"...","scriptedArgs":{...},"confidence":0.0-1.0,"summaryArabic":"..."}`;

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
