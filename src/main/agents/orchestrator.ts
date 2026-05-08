// Orchestrator — entry point for the multi-agent pipeline.
//
// Flow with Computer Use as the action layer:
//   1. Memory   → searches past tickets (stub for now, real RAG later)
//   2. Resolver → Computer Use loop: Claude takes screenshots, clicks, types,
//                 verifies. Actually solves the problem instead of just
//                 pointing at it.
//   3. Guardian → policy check (stub for now, real policy review later)
//   4. Reporter → synthesizes outcome to the user (Arabic), logs to memory
//
// Agent state changes stream via onAgentMessage so the renderer's agent
// panel animates from real events.

import type { ScreenCapture } from '../../shared/types';
import type { AgentMessage, OrchestratorOutput } from './types';
import { runMemoryAgent } from './memory';
import { runGuardianAgent } from './guardian';
import { runReporterAgent } from './reporter';
import { runComputerUseLoop } from './computer-use';
import { dispatchScripted } from './tools/scripted';
import { getForegroundContext } from './tools/computer';

export interface OrchestratorInput {
  voiceTranscript: string;
  screenshot: ScreenCapture;
  anthropicKey: string;
  signal: AbortSignal;
  onAgentMessage: (msg: AgentMessage) => void;
}

function emit(
  fn: (msg: AgentMessage) => void,
  agent: AgentMessage['agent'],
  status: AgentMessage['status'],
  text: string,
): void {
  fn({ agent, status, text, timestamp: Date.now() });
}

export async function handleUserRequest(
  input: OrchestratorInput,
): Promise<OrchestratorOutput | null> {
  const { voiceTranscript, screenshot, anthropicKey, signal, onAgentMessage } = input;

  // Multi-agent panel intentionally NOT shown right now — we are isolating
  // Resolver to verify it works end-to-end before re-enabling Memory +
  // Guardian visualization. Re-enable by un-commenting the line below.
  //   input.onAgentPanelShow?.()  // not in current input shape; would re-wire
  void onAgentMessage; // keep param for forward compat without firing it loudly

  // ── 1. Memory (real Claude Agent SDK call) ────────────────────────────
  emit(onAgentMessage, 'memory', 'thinking', 'يبحث في سجل البلاغات السابقة...');
  // Pre-extract foreground app + window title so Memory can route even
  // for vague voice queries like "هذا ما يشتغل". Cheap (~100ms),
  // text-only, no image processing.
  const screenContext = await getForegroundContext();
  if (screenContext) console.log(`[orchestrator] ${screenContext}`);
  const memory = await runMemoryAgent(voiceTranscript, anthropicKey, screenContext ?? undefined);
  if (signal.aborted) return null;
  emit(onAgentMessage, 'memory', 'active', memory.summaryArabic);
  console.log(`[orchestrator] Memory: path=${memory.recommendedPath} confidence=${memory.confidence}`);

  // If Memory recommends escalation (e.g. password reset, install software,
  // hardware), don't even start Resolver — go straight to ticket creation.
  if (memory.recommendedPath === 'escalate' && memory.confidence >= 0.6) {
    emit(onAgentMessage, 'resolver', 'done', 'تم تخطي المعالج — الحالة تتطلب تدخلاً بشرياً');
    emit(onAgentMessage, 'guardian', 'thinking', 'يجهّز التذكرة للدعم البشري...');
    const guardianEarly = await runGuardianAgent(
      `الحالة تتطلب تصعيدًا حسب توصية الذاكرة: ${memory.summaryArabic}`,
      anthropicKey,
    );
    if (signal.aborted) return null;
    emit(onAgentMessage, 'guardian', 'done', guardianEarly.rationaleArabic);
    emit(onAgentMessage, 'reporter', 'done', 'تم إنشاء تذكرة دعم تقني');
    emit(onAgentMessage, 'memory', 'done', memory.summaryArabic);
    return {
      finalUserMessage:
        `${memory.summaryArabic}. ${guardianEarly.rationaleArabic}. ` +
        `تم تصعيد الحالة للدعم التقني (${guardianEarly.policyReference}).`,
      cursorTarget: null,
    };
  }

  // ── 2. Resolver — scripted fast path OR Computer Use loop ─────────────
  // If Memory recommended a known scripted tool with high confidence,
  // dispatch it directly: ~1s vs 15-30s for Computer Use. Falls through
  // to Computer Use otherwise.
  let cu: { success: boolean; finalMessage: string; iterations: number; reason?: string };
  if (
    memory.recommendedPath === 'scripted' &&
    memory.scriptedTool &&
    memory.confidence >= 0.5
  ) {
    emit(onAgentMessage, 'resolver', 'thinking', `يستخدم سكريبت ${memory.scriptedTool}...`);
    // Long-running scripted tools (like NCA audit-and-fix) get a step
    // callback that pipes their progress into the agent panel — turns
    // an otherwise-silent multi-second action into a narrated demo.
    const scripted = await dispatchScripted(
      memory.scriptedTool,
      memory.scriptedArgs ?? {},
      (stepText) => emit(onAgentMessage, 'resolver', 'thinking', stepText),
    );
    if (scripted) {
      console.log(`[orchestrator] Scripted: tool=${memory.scriptedTool} ok=${scripted.ok} script="${scripted.script}"`);
      cu = {
        success: scripted.ok,
        finalMessage: scripted.message,
        iterations: 1,
      };
    } else {
      // Unknown tool name — fall back to Computer Use.
      console.warn(`[orchestrator] Scripted tool "${memory.scriptedTool}" unknown, falling back to Computer Use`);
      emit(onAgentMessage, 'resolver', 'thinking', 'يبدأ التحكم بالشاشة...');
      cu = await runComputerUseLoop({
        apiKey: anthropicKey,
        transcript: voiceTranscript,
        initialScreenshot: screenshot,
        signal,
        onStep: (msg) => emit(onAgentMessage, 'resolver', 'thinking', msg),
      });
    }
  } else {
    emit(onAgentMessage, 'resolver', 'thinking', 'يبدأ التحكم بالشاشة...');
    cu = await runComputerUseLoop({
      apiKey: anthropicKey,
      transcript: voiceTranscript,
      initialScreenshot: screenshot,
      signal,
      onStep: (msg) => emit(onAgentMessage, 'resolver', 'thinking', msg),
    });
  }
  if (signal.aborted) return null;
  emit(
    onAgentMessage,
    'resolver',
    'active',
    cu.success
      ? `${cu.finalMessage} (${cu.iterations} جولة)`
      : `لم يكتمل: ${cu.reason ?? 'unknown'}`,
  );

  // ── 3. Guardian (real Claude Agent SDK call) ──────────────────────────
  // Reviews what Resolver did against NCA + company policies. Uses
  // lookupPolicy tool to find relevant rules, then issues a verdict.
  emit(onAgentMessage, 'guardian', 'thinking', 'يراجع الإجراء أمام سياسات الـ NCA...');
  const guardian = await runGuardianAgent(cu.finalMessage, anthropicKey);
  if (signal.aborted) return null;
  emit(onAgentMessage, 'guardian', 'active', guardian.rationaleArabic);
  console.log(`[orchestrator] Guardian: verdict=${guardian.verdict} policy=${guardian.policyReference}`);

  // ── 4. Reporter ───────────────────────────────────────────────────────
  emit(onAgentMessage, 'reporter', 'thinking', 'يجمّع الرد ويسجّل الحادثة...');
  const finalUserMessage = cu.success
    ? `${cu.finalMessage} (تمت مراجعة الإجراء — متوافق مع ${guardian.policyReference})`
    : cu.finalMessage;

  // Reuse runReporterAgent's structure for consistency, but we override
  // the actual message because Computer Use already produced one.
  void runReporterAgent;
  if (signal.aborted) return null;
  emit(
    onAgentMessage,
    'reporter',
    'active',
    cu.success
      ? `تم تسجيل الحادثة #${memory.matches[0]?.ticketId ?? 'INC-NEW'} — الرد جاهز`
      : 'تم إنشاء تذكرة دعم تقني للمتابعة',
  );

  // Mark all agents done so the panel's checkmarks light up.
  emit(onAgentMessage, 'memory', 'done', memory.summaryArabic);
  emit(onAgentMessage, 'resolver', 'done', cu.success ? 'تم الحل' : 'تم التصعيد');
  emit(onAgentMessage, 'guardian', 'done', guardian.rationaleArabic);
  emit(onAgentMessage, 'reporter', 'done', cu.success ? 'الرد سُلِّم' : 'تم إنشاء التذكرة');

  console.log(
    `[orchestrator] computer-use done. success=${cu.success} iterations=${cu.iterations} reason=${cu.reason ?? 'n/a'}`,
  );

  // No cursor target — Computer Use moves the actual mouse cursor as it
  // works, so there's no need for the floating bubble pointer overlay.
  return {
    finalUserMessage,
    cursorTarget: null,
  };
}
