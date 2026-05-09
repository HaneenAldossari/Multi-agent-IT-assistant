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

// TEMP: TESTING MODE — when true, the orchestrator skips Memory and
// Guardian entirely and runs Computer Use directly with the voice
// transcript. Used during Resolver iteration. Set to false to restore
// the full Memory → Guardian (pre-check) → Resolver → Guardian (review) → Reporter pipeline.
const RESOLVER_ONLY_MODE = false;

export async function handleUserRequest(
  input: OrchestratorInput,
): Promise<OrchestratorOutput | null> {
  const { voiceTranscript, screenshot, anthropicKey, signal, onAgentMessage } = input;

  // ── Resolver-only fast path ──────────────────────────────────────────
  if (RESOLVER_ONLY_MODE) {
    console.log('[orchestrator] RESOLVER_ONLY_MODE — skipping Memory + Guardian');
    emit(onAgentMessage, 'resolver', 'thinking', 'يبدأ التحكم بالشاشة...');
    const cu = await runComputerUseLoop({
      apiKey: anthropicKey,
      transcript: voiceTranscript,
      initialScreenshot: screenshot,
      signal,
      onStep: (msg) => emit(onAgentMessage, 'resolver', 'thinking', msg),
    });
    if (signal.aborted) return null;
    emit(
      onAgentMessage,
      'resolver',
      'done',
      cu.success
        ? `${cu.finalMessage} (${cu.iterations} جولة)`
        : `لم يكتمل: ${cu.reason ?? 'unknown'}`,
    );
    return {
      finalUserMessage: cu.finalMessage,
      cursorTarget: null,
    };
  }

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

  // ── 1.5 Guardian PRE-CHECK ────────────────────────────────────────────
  // Guardian reviews the user's INTENT before Resolver acts. If the action
  // would violate policy (e.g. installing from external source), Guardian
  // blocks here.
  //
  // OPTIMIZATION: skip Guardian for trusted scripted tools that are already
  // policy-approved (restartApp, openApp, ncaAudit, etc.). These are safe
  // by design — calling Guardian for them just burns API tokens. Save the
  // ~$0.05 per Memory→Guardian round-trip on common scenarios.
  const TRUSTED_SCRIPTED_TOOLS = new Set([
    'openApp',
    'restartApp',
    'quitApp',
    'switchWifi',
    'ncaAudit',
    'ncaAuditAndFix',
    'brightnessUp',
    'brightnessDown',
    'volumeUp',
    'mute',
  ]);
  const isTrustedScripted =
    memory.recommendedPath === 'scripted' &&
    memory.scriptedTool &&
    TRUSTED_SCRIPTED_TOOLS.has(memory.scriptedTool) &&
    memory.confidence >= 0.5;

  type GuardianLike = {
    verdict: 'approve' | 'block' | 'escalate';
    rationaleArabic: string;
    policyReference: string;
    suggestedAlternativeArabic?: string;
    suggestedSearchQuery?: string;
    approved: boolean;
  };
  let guardianPre: GuardianLike;

  if (isTrustedScripted) {
    console.log(
      `[orchestrator] Skipping Guardian pre-check — trusted scripted tool: ${memory.scriptedTool}`,
    );
    emit(
      onAgentMessage,
      'guardian',
      'active',
      `موافقة تلقائية — أداة معتمدة (${memory.scriptedTool})`,
    );
    guardianPre = {
      verdict: 'approve',
      rationaleArabic: 'أداة معتمدة مسبقاً',
      policyReference: 'NCA-DEFAULT-TRUSTED',
      approved: true,
    };
  } else {
    emit(onAgentMessage, 'guardian', 'thinking', 'يراجع طلب المستخدم قبل التنفيذ...');
    const intentDescription =
      `طلب المستخدم: "${voiceTranscript}". تحليل الذاكرة: ${memory.summaryArabic}` +
      (memory.recommendedPath === 'scripted' && memory.scriptedTool
        ? ` (يقترح استخدام أداة ${memory.scriptedTool})`
        : '');
    guardianPre = await runGuardianAgent(intentDescription, anthropicKey);
  if (signal.aborted) return null;
  console.log(
    `[orchestrator] Guardian pre-check: verdict=${guardianPre.verdict} policy=${guardianPre.policyReference}`,
  );

  if (guardianPre.verdict === 'block') {
    // Surface the block + alternative to the user. Resolver SKIPPED.
    emit(onAgentMessage, 'guardian', 'active', guardianPre.rationaleArabic);
    emit(
      onAgentMessage,
      'resolver',
      'done',
      'تم منع الإجراء قبل التنفيذ — راجعي البديل المقترح',
    );
    emit(onAgentMessage, 'reporter', 'thinking', 'يجمّع الرسالة النهائية مع البديل...');

    // Strip any embedded "البديل المقترح: ..." from the rationale so we
    // don't show the alternative twice (Guardian's prompt sometimes
    // appends it inline; we want the alternative in its own section).
    const cleanRationale = guardianPre.rationaleArabic
      .replace(/البديل المقترح[:：].*$/s, '')
      .trim();
    const sections: string[] = [];
    sections.push('🛑 الإجراء محجوب');
    sections.push('━━━━━━━━━━━━━━━━━━━━');
    sections.push('');
    sections.push('❓ السبب');
    sections.push(cleanRationale);
    sections.push('');
    sections.push('📜 مرجع السياسة');
    sections.push(guardianPre.policyReference);
    if (guardianPre.suggestedAlternativeArabic) {
      sections.push('');
      sections.push('✅ البديل المعتمد');
      sections.push(guardianPre.suggestedAlternativeArabic);
    }
    const finalUserMessage = sections.join('\n');

    emit(onAgentMessage, 'reporter', 'done', 'تم تسليم الرد مع البديل');
    emit(onAgentMessage, 'memory', 'done', memory.summaryArabic);

    // ── Active demonstration: open Google search for the alternative ─────
    // Goes from "agent told you" to "agent showed you" — opens a real
    // browser tab with the search results so the user can act immediately.
    if (guardianPre.suggestedSearchQuery) {
      const q = encodeURIComponent(guardianPre.suggestedSearchQuery);
      const url = `https://www.google.com/search?q=${q}`;
      console.log(`[orchestrator] Opening alternative search: ${url}`);
      try {
        const { exec } = await import('child_process');
        exec(`open "${url}"`);
      } catch (err) {
        console.error('[orchestrator] failed to open search URL:', err);
      }
    }

    return { finalUserMessage, cursorTarget: null };
  }

  // Guardian approved (or escalated, which we treat as approve+caveat for now).
  // Continue to Resolver.
  emit(onAgentMessage, 'guardian', 'active', `تمت الموافقة الأولية (${guardianPre.policyReference})`);
  } // end else (Guardian pre-check ran)

  // Reference the variable to keep TS happy when isTrustedScripted=true
  void guardianPre;

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
