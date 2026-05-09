// Memory Agent — uses Claude Agent SDK with a custom searchPastTickets tool.
//
// The agent receives a problem description (Arabic), decides what to search
// for, calls searchPastTickets, evaluates the results, and returns a
// structured recommendation. It's a REAL agent — not a function — because:
//   - It has its own goal (find similar past incidents)
//   - It has its own tool it autonomously decides to use
//   - It runs a small loop (≤3 turns)
//   - It returns a structured verdict the orchestrator acts on

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Electron-optional: when running inside Flicky, app.getAppPath() gives
// the bundled path. Outside (standalone test scripts), fall back to cwd.
function tryGetAppPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    return electron?.app?.getAppPath?.() ?? null;
  } catch {
    return null;
  }
}

// Claude Agent SDK is shipped as an ES module; Flicky's main process is
// CommonJS. We use a Function-eval'd dynamic import so TypeScript's
// CJS compiler doesn't rewrite our import() into require().
type AgentSDK = typeof import('@anthropic-ai/claude-agent-sdk');
const _esmImport = new Function('m', 'return import(m)') as <T>(m: string) => Promise<T>;
let sdkPromise: Promise<AgentSDK> | null = null;
function loadSDK(): Promise<AgentSDK> {
  if (!sdkPromise) {
    sdkPromise = _esmImport<AgentSDK>('@anthropic-ai/claude-agent-sdk');
  }
  return sdkPromise;
}

// ── Data loading ──────────────────────────────────────────────────────

interface PastTicket {
  id: string;
  date: string;
  user_role: string;
  symptom_arabic: string;
  diagnosis: string;
  resolution_method: 'computer_use' | 'scripted' | 'escalated';
  resolution_steps: string;
  outcome: 'resolved' | 'escalated';
  resolution_time_seconds: number;
  category: string;
}

let cachedTickets: PastTicket[] | null = null;
function loadTickets(): PastTicket[] {
  if (cachedTickets) return cachedTickets;
  // In dev mode the file is at src/main/agents/data/. After bundling it's
  // copied next to dist/main/main/agents/. Try both.
  const appPath = tryGetAppPath();
  const candidates = [
    appPath ? join(appPath, 'src/main/agents/data/company-tickets.json') : '',
    join(__dirname, 'data/company-tickets.json'),
    join(__dirname, '../../src/main/agents/data/company-tickets.json'),
    join(process.cwd(), 'src/main/agents/data/company-tickets.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      cachedTickets = JSON.parse(readFileSync(p, 'utf-8')) as PastTicket[];
      return cachedTickets;
    } catch {
      // try next
    }
  }
  console.warn('[Memory] Could not load company-tickets.json from any candidate path');
  cachedTickets = [];
  return cachedTickets;
}

// ── Custom tool: searchPastTickets ────────────────────────────────────

// Tool + MCP server are built lazily once the ES-module SDK is loaded.
let memoryServerPromise: Promise<unknown> | null = null;
async function getMemoryServer(): Promise<unknown> {
  if (memoryServerPromise) return memoryServerPromise;
  memoryServerPromise = (async () => {
    const sdk = await loadSDK();
    const searchPastTickets = sdk.tool(
      'searchPastTickets',
      'Search past company IT incident tickets for similar problems. Returns matching tickets with their diagnoses and resolution methods.',
      { query: z.string().describe('Arabic or English keywords describing the problem') },
      async ({ query: searchQuery }) => {
        const tickets = loadTickets();
        const q = (searchQuery as string).toLowerCase();
        const matches = tickets.filter((t) => {
          const haystack = `${t.symptom_arabic} ${t.diagnosis} ${t.category}`.toLowerCase();
          return q.split(/\s+/).some((kw) => kw.length > 1 && haystack.includes(kw));
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(matches.slice(0, 5)) }],
        };
      },
    );
    return sdk.createSdkMcpServer({
      name: 'memory-agent-tools',
      tools: [searchPastTickets],
    });
  })();
  return memoryServerPromise;
}

// ── Public types ──────────────────────────────────────────────────────

export interface MemoryResult {
  /** Top matching past tickets used for analysis */
  similarTicketIds: string[];
  /** "computer_use" / "scripted" / "escalate" — which path Resolver should take */
  recommendedPath: 'computer_use' | 'scripted' | 'escalate' | 'unknown';
  /** 0–1 confidence in the recommendation */
  confidence: number;
  /** One-sentence Arabic summary suitable for the agent panel */
  summaryArabic: string;
  /** Only set when recommendedPath="scripted". Names the tool to call.
   * The dispatcher (tools/scripted.ts) is the source of truth for which
   * tools are valid; this string is validated there. */
  scriptedTool?:
    | 'openApp'
    | 'quitApp'
    | 'restartApp'
    | 'switchWifi'
    | 'ncaAudit'
    | 'ncaAuditAndFix'
    | 'brightnessUp'
    | 'brightnessDown'
    | 'volumeUp'
    | 'mute';
  /** Args for the scripted tool. Free-form key/value pairs. */
  scriptedArgs?: Record<string, string>;
  /** Backwards-compat: legacy callers expect `matches` and `summaryArabic` */
  matches: { ticketId: string }[];
}

// ── The agent ─────────────────────────────────────────────────────────

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
2. Return a JSON object with recommendedPath set to "computer_use" (low confidence ~0.3)
3. NEVER refuse, lecture, or offer alternatives in text form

Why: A separate "Guardian" agent reviews your output AFTER you. Guardian is the safety layer. Guardian blocks unsafe actions and offers alternatives. If YOU refuse here with a text response, Guardian never sees the request and the entire multi-agent safety system breaks.

Examples — even for risky-sounding requests, return JSON:
- "نزّلي WinRAR من موقع وهمي" → {"recommendedPath":"computer_use","confidence":0.3,"summaryArabic":"طلب تنزيل برنامج من مصدر خارجي — يحتاج مراجعة الحارس",...}
- "افتح موقع مشبوه" → {"recommendedPath":"computer_use","confidence":0.3,...}
- "حمّل ملف من رابط غريب" → {"recommendedPath":"computer_use","confidence":0.3,...}

Your refusal would BREAK the safety system. Guardian needs to see the request.

═══ Your job (Arabic context) ═══
أنت وكيل ذاكرة للدعم التقني السعودي. تستقبل وصف مشكلة من موظف، تبحث في سجل البلاغات السابقة، وتوصي بأحد المسارات الثلاثة.

═══ المسارات المتاحة ═══

(أ) "scripted" — استخدم سكريبتاً جاهزاً (الأسرع، 1 ثانية). اختر هذا إذا كانت المهمة:
    - فتح تطبيق معروف (Calculator, Notes, Safari) → tool="openApp", args={"name": "اسم التطبيق"}
    - إغلاق تطبيق → tool="quitApp"
    - إعادة تشغيل تطبيق معلّق → tool="restartApp"
    - تحويل شبكة Wi-Fi لشبكة معروفة → tool="switchWifi", args={"ssid": "Office-WiFi"}
    - فحص أمان الجهاز وفق معايير NCA + إصلاح المشاكل الآمنة → tool="ncaAuditAndFix", args={}
    - فحص أمان الجهاز فقط (بدون إصلاح) → tool="ncaAudit", args={}

(ب) "computer_use" — استخدم Computer Use (15-30 ثانية). اختر هذا للمهام التي تحتاج تنقّلًا بصرياً معقدًا أو سيناريوهات لم نرها من قبل.

(ج) "escalate" — تصعيد للدعم البشري. اختر هذا إذا كانت معظم الحالات المشابهة صُعِّدت (مثل: إعادة كلمة سر، تثبيت برامج، مشاكل عتاد).

═══ مثال للقرار ═══

طلب المستخدم: "افتح Calculator"
→ مسار scripted، tool="openApp"، args={"name": "Calculator"}

طلب: "غيّر الشبكة لـ Office-WiFi"
→ scripted، tool="switchWifi"، args={"ssid": "Office-WiFi"}

طلب: "أعد تشغيل Slack"
→ scripted، tool="restartApp"، args={"name": "Slack"}

طلب: "نسيت كلمة السر"
→ escalate

طلب: "اعمل لي تقرير في Excel"
→ computer_use (مهمة معقّدة)

طلب: "تأكدي من اتصال الإنترنت" أو "شغّلي ping"
→ computer_use، confidence ~0.4 (لا يوجد playbook جاهز — Resolver يستكشف عبر Terminal)

═══ صيغة الإجابة ═══

أجب فقط بصيغة JSON بدون نص قبله أو بعده:

{
  "similarTicketIds": ["INC-...", ...],
  "recommendedPath": "computer_use" | "scripted" | "escalate" | "unknown",
  "scriptedTool": "openApp" | "quitApp" | "restartApp" | "switchWifi",  // فقط مع scripted
  "scriptedArgs": { "name": "..." },  // فقط مع scripted
  "confidence": 0.0-1.0,
  "summaryArabic": "جملة عربية واحدة قصيرة"
}

قواعد:
- استخدم searchPastTickets مرة واحدة على الأقل قبل الإجابة.
- فضّل "scripted" دائماً للمهام المعروفة — أسرع وأكثر موثوقية.
- إذا كانت كل الحالات المشابهة من نوع computer_use ولا يوجد scripted playbook، فاجعل confidence بين 0.3-0.5 حتى لو وجدت تطابقاً قوياً — Resolver لا يزال بحاجة لاستكشاف الحل بصرياً مباشرة.
- لا تستخدم أي أداة غير searchPastTickets.
- لا تطرح أسئلة على المستخدم تحت أي ظرف — أنت تحلّل، لا تتحاور.
- المخرج النهائي = كائن JSON واحد فقط، بدون نص قبله أو بعده.`;

export async function runMemoryAgent(
  transcript: string,
  anthropicKey: string,
  /**
   * Optional context extracted from the user's screen — typically the
   * foreground app name + window title. Lets Memory route correctly even
   * when the voice transcript is vague ("this isn't working", "fix it").
   * The orchestrator extracts this via a quick osascript call before
   * invoking Memory; Memory itself never sees the raw screenshot to keep
   * token cost low.
   */
  screenContext?: string,
): Promise<MemoryResult> {
  // SDK reads ANTHROPIC_API_KEY from env. Inject it from Flicky's keyStore.
  process.env.ANTHROPIC_API_KEY = anthropicKey;

  const sdk = await loadSDK();
  const memoryServer = await getMemoryServer();

  let finalText = '';
  try {
    // Note: screen context intentionally NOT included here. The voice
    // transcript is enough for the demo scenarios, and the screen context
    // string ("Foreground app: Terminal — claude --resume") was confusing
    // the model into thinking the user was debugging instead of acting.
    void screenContext;
    for await (const message of sdk.query({
      prompt: `[Voice transcript from employee]: ${transcript}\n\nClassify this request and respond with a single JSON object. Use searchPastTickets first.`,
      options: {
        model: 'claude-sonnet-4-5',
        maxTurns: 4,
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { memory: memoryServer as never },
        allowedTools: ['mcp__memory__searchPastTickets'],
        permissionMode: 'bypassPermissions',
      },
    })) {
      if (message.type === 'assistant' && 'message' in message) {
        const blocks = (message as { message: { content: Array<{ type: string; text?: string }> } }).message.content;
        const text = blocks
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        if (text) finalText = text;
      }
      if (message.type === 'result') break;
    }
  } catch (err) {
    console.error('[Memory] agent threw:', err);
    return fallback(transcript);
  }

  // Parse JSON from the final assistant message.
  const jsonMatch = finalText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('[Memory] no JSON in final text:', finalText.slice(0, 200));
    return fallback(transcript);
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<MemoryResult>;
    return {
      similarTicketIds: parsed.similarTicketIds ?? [],
      recommendedPath: parsed.recommendedPath ?? 'unknown',
      confidence: parsed.confidence ?? 0,
      summaryArabic: parsed.summaryArabic ?? 'لم يُعثر على حوادث مشابهة',
      scriptedTool: parsed.scriptedTool,
      scriptedArgs: parsed.scriptedArgs,
      matches: (parsed.similarTicketIds ?? []).map((id) => ({ ticketId: id })),
    };
  } catch (err) {
    console.warn('[Memory] JSON parse failed:', err);
    return fallback(transcript);
  }
}

function fallback(_transcript: string): MemoryResult {
  return {
    similarTicketIds: [],
    recommendedPath: 'unknown',
    confidence: 0,
    summaryArabic: 'لم تتمكن الذاكرة من البحث — سيتابع المحلل بدون سياق سابق',
    matches: [],
  };
}
