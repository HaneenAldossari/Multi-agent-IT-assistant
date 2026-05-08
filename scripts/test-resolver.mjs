#!/usr/bin/env node
/**
 * Standalone Resolver pipeline test.
 *
 * Exercises the full path: Memory → (scripted dispatch OR Computer Use)
 * → Guardian. Prints stage-by-stage timing so you can see where time is
 * spent and what the path decision was.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node scripts/test-resolver.mjs "Outlook ما يفتح"
 *   node scripts/test-resolver.mjs "حمّل لي WinRAR"
 *   node scripts/test-resolver.mjs "افتح Calculator"
 *
 * Computer Use requires macOS (uses screencapture + osascript).
 * Memory + Guardian + scripted dispatch work on any OS.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, platform } from 'node:os';

const execP = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IS_MAC = platform() === 'darwin';

// ── Args + setup ──────────────────────────────────────────────────────

const userPrompt = process.argv.slice(2).join(' ').trim();
if (!userPrompt) {
  console.error('Usage: node scripts/test-resolver.mjs "<your request in Arabic>"');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY first.');
  process.exit(1);
}

const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
const { z } = await import('zod');

const tickets = JSON.parse(readFileSync(join(ROOT, 'src/main/agents/data/company-tickets.json'), 'utf-8'));
const policies = JSON.parse(readFileSync(join(ROOT, 'src/main/agents/data/company-policies.json'), 'utf-8'));

console.log(`\n${'═'.repeat(60)}`);
console.log(`▶ TASK: ${userPrompt}`);
console.log(`  KB: ${tickets.length} tickets, ${policies.length} policies`);
console.log(`${'═'.repeat(60)}\n`);

const overallStart = Date.now();

// ── Pre-stage: foreground app context ────────────────────────────────
// Memory uses this to disambiguate vague voice queries.
let screenContext = null;
if (IS_MAC) {
  try {
    const app = execSync(`osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'`).toString().trim();
    let title = '';
    try {
      title = execSync(`osascript -e 'tell application "System Events" to name of front window of (first application process whose frontmost is true)'`).toString().trim();
    } catch { /* not all apps expose this */ }
    if (app) {
      screenContext = title && title !== app
        ? `Foreground app: ${app} — window: ${title}`
        : `Foreground app: ${app}`;
      console.log(`📺 Screen context: ${screenContext}\n`);
    }
  } catch { /* osascript not available */ }
}

// ── Stage 1: Memory ────────────────────────────────────────────────────

console.log('🧠 STAGE 1 — Memory');
const memoryStart = Date.now();

const searchPastTickets = tool(
  'searchPastTickets',
  'Search past company IT tickets',
  { query: z.string() },
  async ({ query: q }) => {
    const ql = q.toLowerCase();
    const matches = tickets.filter((t) => {
      const hay = `${t.symptom_arabic} ${t.diagnosis} ${t.category}`.toLowerCase();
      return ql.split(/\s+/).some((kw) => kw.length > 1 && hay.includes(kw));
    });
    return { content: [{ type: 'text', text: JSON.stringify(matches.slice(0, 5)) }] };
  },
);

const memoryServer = createSdkMcpServer({
  name: 'memory',
  tools: [searchPastTickets],
});

const MEMORY_PROMPT = `You are an autonomous Memory agent. You analyze past tickets — you do NOT chat with the user.

ABSOLUTE RULES (no exceptions):
1. NEVER ask the user questions.
2. NEVER greet the user, introduce yourself, or be conversational.
3. ALWAYS call searchPastTickets FIRST with keywords from the user input.
4. ALWAYS respond with a single JSON object — nothing before, nothing after, no markdown.
5. If you have nothing to search for, search with the literal user input.

WHAT TO DECIDE:
- "scripted" — past tickets show a known scripted fix worked
  Set scriptedTool: "openApp" | "quitApp" | "restartApp" | "switchWifi"
  Set scriptedArgs: e.g. {"name":"Microsoft Outlook"} or {"ssid":"Office-WiFi"}
- "computer_use" — no clean scripted match, needs visual exploration
- "escalate" — past similar tickets all escalated (password reset, install software, hardware)

OUTPUT — exactly this JSON shape, nothing else:
{"similarTicketIds":["INC-..."],"recommendedPath":"scripted|computer_use|escalate","scriptedTool":"...","scriptedArgs":{...},"confidence":0.0-1.0,"summaryArabic":"جملة عربية"}

If recommendedPath is not "scripted", omit scriptedTool and scriptedArgs entirely.`;

let memoryFinal = '';
for await (const m of query({
  prompt: screenContext
    ? `[Voice transcript from employee]: ${userPrompt}\n[Screen context]: ${screenContext}\n\nUse the screen context to disambiguate intent. Respond with JSON only.`
    : `[Voice transcript from employee — analyze and respond with JSON only]: ${userPrompt}`,
  options: {
    model: 'claude-sonnet-4-5',
    maxTurns: 2,
    systemPrompt: MEMORY_PROMPT,
    mcpServers: { memory: memoryServer },
    allowedTools: ['mcp__memory__searchPastTickets'],
    permissionMode: 'bypassPermissions',
  },
})) {
  if (m.type === 'assistant' && m.message) {
    const t = m.message.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (t) memoryFinal = t;
  }
  if (m.type === 'result') break;
}

const memoryMatch = memoryFinal.match(/\{[\s\S]*\}/);
const memoryResult = memoryMatch ? JSON.parse(memoryMatch[0]) : null;
const memoryMs = Date.now() - memoryStart;

if (!memoryResult) {
  console.log(`  ❌ Memory returned no JSON. Output:\n${memoryFinal.slice(0, 200)}`);
  process.exit(1);
}
console.log(`  ✓ ${memoryMs}ms`);
console.log(`  path=${memoryResult.recommendedPath} confidence=${memoryResult.confidence}`);
console.log(`  summary: ${memoryResult.summaryArabic}`);
if (memoryResult.scriptedTool) console.log(`  scriptedTool=${memoryResult.scriptedTool} args=${JSON.stringify(memoryResult.scriptedArgs)}`);

// ── Early-exit: escalate path ─────────────────────────────────────────

if (memoryResult.recommendedPath === 'escalate' && memoryResult.confidence >= 0.6) {
  console.log('\n⚡ Memory recommends ESCALATE — Resolver bypassed.\n');
  await runGuardianStage(`الحالة تتطلب تصعيدًا حسب الذاكرة: ${memoryResult.summaryArabic}`);
  reportTotal();
  process.exit(0);
}

// ── Stage 2: Resolver — scripted OR Computer Use ──────────────────────

let resolverResult;
const resolverStart = Date.now();

if (memoryResult.recommendedPath === 'scripted' && memoryResult.scriptedTool && memoryResult.confidence >= 0.5) {
  console.log(`\n⚡ STAGE 2 — Resolver (SCRIPTED PATH)`);
  resolverResult = await runScriptedTool(memoryResult.scriptedTool, memoryResult.scriptedArgs ?? {});
} else if (IS_MAC) {
  console.log(`\n🖱  STAGE 2 — Resolver (COMPUTER USE)`);
  resolverResult = await runComputerUse(userPrompt);
} else {
  console.log(`\n⏭  STAGE 2 — Resolver (SKIPPED — Computer Use needs macOS)`);
  resolverResult = { ok: false, message: 'Skipped on non-macOS — only Memory + Guardian tested.' };
}

const resolverMs = Date.now() - resolverStart;
console.log(`  ✓ ${resolverMs}ms — ${resolverResult.ok ? 'success' : 'failed'}`);
console.log(`  result: ${resolverResult.message}`);

// ── Stage 3: Guardian ──────────────────────────────────────────────────

await runGuardianStage(resolverResult.message);
reportTotal();

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

async function runScriptedTool(toolName, args) {
  switch (toolName) {
    case 'openApp':
      return safeExec(`open -a "${(args.name || args.app || '').replace(/"/g, '')}"`, `تم فتح ${args.name}`, `تعذّر فتح ${args.name}`);
    case 'quitApp':
      return safeExec(`osascript -e 'tell application "${(args.name || args.app || '').replace(/"/g, '')}" to quit'`, `تم إغلاق ${args.name}`, `تعذّر إغلاق ${args.name}`);
    case 'restartApp': {
      const name = (args.name || args.app || '').replace(/"/g, '');
      const q = await safeExec(`osascript -e 'tell application "${name}" to quit'`, '', '');
      if (!q.ok) return q;
      await new Promise((r) => setTimeout(r, 800));
      return safeExec(`open -a "${name}"`, `تم إعادة تشغيل ${args.name}`, `تعذّر إعادة تشغيل ${args.name}`);
    }
    case 'switchWifi': {
      const ssid = (args.ssid || args.network || '').replace(/"/g, '');
      const cmd = args.password
        ? `networksetup -setairportnetwork en0 "${ssid}" "${args.password.replace(/"/g, '')}"`
        : `networksetup -setairportnetwork en0 "${ssid}"`;
      return safeExec(cmd, `تم التحويل إلى ${ssid}`, `تعذّر التحويل إلى ${ssid}`);
    }
    default:
      return { ok: false, message: `سكريبت غير معروف: ${toolName}` };
  }
}

async function safeExec(cmd, okMsg, failPrefix) {
  try {
    const { stdout, stderr } = await execP(cmd);
    const out = (stdout + stderr).trim();
    if (/error|could not|failed|unable to find/i.test(out)) {
      return { ok: false, message: `${failPrefix} → ${out}` };
    }
    return { ok: true, message: okMsg };
  } catch (err) {
    const msg = err.message ?? String(err);
    // Detect "app not installed" specifically and surface a clear Arabic error
    if (/unable to find application|application.*not found|-10810/i.test(msg)) {
      const appMatch = msg.match(/'([^']+)'/);
      const appName = appMatch ? appMatch[1] : 'التطبيق';
      return { ok: false, message: `❌ التطبيق "${appName}" غير مثبَّت على هذا الجهاز. يجب تثبيته أولاً، أو اختيار تطبيق بديل.` };
    }
    return { ok: false, message: `${failPrefix} → ${msg}` };
  }
}

async function runComputerUse(transcript) {
  const screenshot = takeScreenshot();
  if (!screenshot) return { ok: false, message: 'تعذّر التقاط الشاشة' };

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot } },
        { type: 'text', text: transcript },
      ],
    },
  ];
  const SYS = `You are an IT support agent. Use Spotlight (cmd+space → type → Return → wait → screenshot) to open apps. Take MINIMUM steps. Final response is one short Arabic sentence.`;

  let final = '';
  let iters = 0;
  for (let i = 0; i < 10; i++) {
    iters++;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'computer-use-2025-01-24',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: SYS,
        tools: [{ type: 'computer_20250124', name: 'computer', display_width_px: 768, display_height_px: 480, display_number: 1 }],
        messages,
      }),
    });
    if (!res.ok) return { ok: false, message: `API error ${res.status}: ${(await res.text()).slice(0, 100)}` };
    const data = await res.json();
    messages.push({ role: 'assistant', content: data.content });
    const tools = data.content.filter((c) => c.type === 'tool_use');
    if (tools.length === 0) {
      const text = data.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      return { ok: true, message: text || 'تم.', iterations: iters };
    }
    process.stdout.write(`    iter ${i + 1}: ${tools.map((t) => t.input?.action).join(', ')}\n`);
    // Just acknowledge tool calls — don't actually execute. This script
    // tests the decision flow, not the execution. Use Flicky for real CU.
    const acks = tools.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: 'simulated ok' }));
    messages.push({ role: 'user', content: acks });
  }
  return { ok: false, message: `Computer Use hit iteration limit (${iters})`, iterations: iters };
}

function takeScreenshot() {
  if (!IS_MAC) return null;
  const path = join(tmpdir(), `tr-${Date.now()}.jpg`);
  spawnSync('screencapture', ['-t', 'jpg', '-x', path], { stdio: 'pipe' });
  if (!existsSync(path)) return null;
  // Downscale via sips
  const small = path.replace('.jpg', '-s.jpg');
  spawnSync('sips', ['-Z', '768', path, '--out', small], { stdio: 'pipe' });
  const b = readFileSync(existsSync(small) ? small : path).toString('base64');
  if (existsSync(path)) unlinkSync(path);
  if (existsSync(small)) unlinkSync(small);
  return b;
}

async function runGuardianStage(action) {
  console.log('\n🛡  STAGE 3 — Guardian');
  const start = Date.now();

  const lookupPolicy = tool(
    'lookupPolicy',
    'Look up NCA + company policies',
    { actionType: z.string() },
    async ({ actionType }) => {
      const a = actionType.toLowerCase();
      const matches = policies.filter((p) => p.applies_to_actions.some((act) => act.toLowerCase().includes(a) || a.includes(act.toLowerCase())));
      return { content: [{ type: 'text', text: JSON.stringify(matches.length > 0 ? matches : policies) }] };
    },
  );

  const guardianServer = createSdkMcpServer({ name: 'guardian', tools: [lookupPolicy] });

  const GUARD_PROMPT = `أنت "وكيل الحارس". استخدم lookupPolicy، أصدر حكماً (approve/block/escalate). أجب بـ JSON فقط:
{"verdict":"...","rationaleArabic":"...","policyReference":"NCA-...","suggestedAlternativeArabic":"..."}`;

  let final = '';
  for await (const m of query({
    prompt: action,
    options: {
      model: 'claude-sonnet-4-5',
      maxTurns: 2,
      systemPrompt: GUARD_PROMPT,
      mcpServers: { guardian: guardianServer },
      allowedTools: ['mcp__guardian__lookupPolicy'],
      permissionMode: 'bypassPermissions',
    },
  })) {
    if (m.type === 'assistant' && m.message) {
      const t = m.message.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      if (t) final = t;
    }
    if (m.type === 'result') break;
  }

  const ms = Date.now() - start;
  const match = final.match(/\{[\s\S]*\}/);
  if (match) {
    const parsed = JSON.parse(match[0]);
    console.log(`  ✓ ${ms}ms`);
    console.log(`  verdict=${parsed.verdict} policy=${parsed.policyReference}`);
    console.log(`  rationale: ${parsed.rationaleArabic}`);
    if (parsed.suggestedAlternativeArabic) console.log(`  suggested: ${parsed.suggestedAlternativeArabic}`);
  } else {
    console.log(`  ❌ no JSON: ${final.slice(0, 150)}`);
  }
}

function reportTotal() {
  const total = Date.now() - overallStart;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`⏱  TOTAL: ${total}ms (${(total / 1000).toFixed(1)}s)`);
  console.log(`${'─'.repeat(60)}\n`);
}
