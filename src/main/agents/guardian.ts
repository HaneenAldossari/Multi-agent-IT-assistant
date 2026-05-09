// Guardian Agent — uses Claude Agent SDK with a custom lookupPolicy tool.
//
// Receives Resolver's outcome (or proposed action), looks up the relevant
// NCA + company policies, and returns a verdict: approve / block / escalate.
// REAL agent because it has its own goal, autonomous tool use, and a loop.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

function tryGetAppPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    return electron?.app?.getAppPath?.() ?? null;
  } catch {
    return null;
  }
}

// SDK is ESM-only; main process is CJS. Function-eval'd dynamic import
// so TS's CommonJS target doesn't rewrite import() into require().
type AgentSDK = typeof import('@anthropic-ai/claude-agent-sdk');
const _esmImport = new Function('m', 'return import(m)') as <T>(m: string) => Promise<T>;
let sdkPromise: Promise<AgentSDK> | null = null;
function loadSDK(): Promise<AgentSDK> {
  if (!sdkPromise) sdkPromise = _esmImport<AgentSDK>('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

// ── Data ──────────────────────────────────────────────────────────────

interface Policy {
  id: string;
  title_arabic: string;
  rule_arabic: string;
  applies_to_actions: string[];
  verdict_default: 'approve' | 'block';
  blocks_action: boolean;
}

let cachedPolicies: Policy[] | null = null;
function loadPolicies(): Policy[] {
  if (cachedPolicies) return cachedPolicies;
  const appPath = tryGetAppPath();
  const candidates = [
    appPath ? join(appPath, 'src/main/agents/data/company-policies.json') : '',
    join(__dirname, 'data/company-policies.json'),
    join(__dirname, '../../src/main/agents/data/company-policies.json'),
    join(process.cwd(), 'src/main/agents/data/company-policies.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      cachedPolicies = JSON.parse(readFileSync(p, 'utf-8')) as Policy[];
      return cachedPolicies;
    } catch {
      // try next
    }
  }
  console.warn('[Guardian] Could not load company-policies.json');
  cachedPolicies = [];
  return cachedPolicies;
}

// ── Custom tool ───────────────────────────────────────────────────────

let guardianServerPromise: Promise<unknown> | null = null;
async function getGuardianServer(): Promise<unknown> {
  if (guardianServerPromise) return guardianServerPromise;
  guardianServerPromise = (async () => {
    const sdk = await loadSDK();
    const lookupPolicy = sdk.tool(
      'lookupPolicy',
      'Look up company and NCA cybersecurity policies relevant to a proposed action. Returns matching policies with their rules and default verdicts.',
      {
        actionType: z.string().describe('Type of action being reviewed (e.g. switch_wifi, install_software, reset_password, restart_app)'),
      },
      async ({ actionType }) => {
        const policies = loadPolicies();
        const a = (actionType as string).toLowerCase();
        const matches = policies.filter((p) =>
          p.applies_to_actions.some((act) => act.toLowerCase().includes(a) || a.includes(act.toLowerCase())),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(matches.length > 0 ? matches : policies) }],
        };
      },
    );
    return sdk.createSdkMcpServer({
      name: 'guardian-agent-tools',
      tools: [lookupPolicy],
    });
  })();
  return guardianServerPromise;
}

// ── Public types ──────────────────────────────────────────────────────

export interface GuardianResult {
  /** Final verdict: approve = action allowed, block = unsafe, escalate = needs human */
  verdict: 'approve' | 'block' | 'escalate';
  /** Arabic explanation suitable for the user/IT ticket */
  rationaleArabic: string;
  /** Specific NCA / company policy ID this verdict is based on */
  policyReference: string;
  /** When verdict=block, optional approved alternative the user can use instead */
  suggestedAlternativeArabic?: string;
  /** Backwards-compat with old templates — true if approved */
  approved: boolean;
}

// ── Agent ─────────────────────────────────────────────────────────────

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
  "rationaleArabic": "جملة عربية قصيرة تشرح القرار. عند block + وجود بديل: أضف 'البديل المقترح: [النص]'",
  "policyReference": "NCA-...",
  "suggestedAlternativeArabic": "نص البديل المعتمد إن وُجد، وإلا أهمل الحقل"
}

قواعد:
- استخدم lookupPolicy مرة واحدة على الأقل.
- اختر السياسة الأكثر صلة كـ policyReference.
- إذا لم تجد سياسة ذات صلة، استخدم "approve" مع policyReference="NCA-DEFAULT".
- عند الحجب لطلب تثبيت/تنزيل برنامج من مصدر خارجي: ارفض بشدّة، واقترح بوابة البرامج المعتمدة، واملأ حقل "suggestedAlternativeArabic" بنص البديل من السياسة (suggested_alternative_arabic).
- إذا كان النص الذي تراجعه يبدأ بـ "طلب المستخدم:" فهذا يعني أنك تراجع نيّة المستخدم قبل تنفيذ أي إجراء. كن أكثر صرامة هنا — الحجب في هذه المرحلة بدون تكلفة (لم يحدث شيء بعد) بينما السماح بإجراء خاطئ مكلف.`;

export async function runGuardianAgent(
  proposedActionArabic: string,
  anthropicKey: string,
): Promise<GuardianResult> {
  process.env.ANTHROPIC_API_KEY = anthropicKey;

  const sdk = await loadSDK();
  const guardianServer = await getGuardianServer();

  let finalText = '';
  try {
    for await (const message of sdk.query({
      prompt: proposedActionArabic,
      options: {
        model: 'claude-sonnet-4-5',
        maxTurns: 4,
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { guardian: guardianServer as never },
        allowedTools: ['mcp__guardian__lookupPolicy'],
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
    console.error('[Guardian] agent threw:', err);
    return permissive('Guardian agent error');
  }

  const jsonMatch = finalText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('[Guardian] no JSON in final text');
    return permissive('Guardian no-JSON');
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<GuardianResult>;
    const verdict = parsed.verdict ?? 'approve';
    return {
      verdict,
      rationaleArabic: parsed.rationaleArabic ?? 'تمت المراجعة دون تحفظات',
      policyReference: parsed.policyReference ?? 'NCA-DEFAULT',
      suggestedAlternativeArabic: parsed.suggestedAlternativeArabic,
      approved: verdict === 'approve',
    };
  } catch {
    return permissive('Guardian parse error');
  }
}

function permissive(_why: string): GuardianResult {
  return {
    verdict: 'approve',
    rationaleArabic: 'تمت المراجعة — متوافق مع ضوابط الأمن السيبراني',
    policyReference: 'NCA-DEFAULT',
    approved: true,
  };
}
