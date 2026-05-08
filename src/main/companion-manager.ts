import { app, screen, systemPreferences } from 'electron';
import { ClaudeAPI } from './services/claude-api';
import { OpenAIAPI } from './services/openai-api';
import { ElevenLabsTTS } from './services/elevenlabs-tts';
import { createTranscriptionProvider, type TranscriptionProvider } from './services/transcription';
import { captureAllDisplays } from './services/screen-capture';
import { parsePointTags } from './services/element-detector';
import { ContextManager } from './services/context-manager';
import * as settingsStore from './services/settings-store';
import * as keyStore from './services/key-store';
import * as chatHistory from './services/chat-history-store';
import * as analytics from './services/analytics';
import { handleUserRequest } from './agents/orchestrator';
import type { AgentMessage } from './agents/types';
import type {
  VoiceState,
  FlickySettings,
  ClaudeModel,
  OpenAIModel,
  MindProvider,
  GroqTranscriptionModel,
  TranscriptionResult,
  DetectedElement,
  ScreenCapture,
  ApiKeyName,
  ReasoningDepth,
  ReplyTone,
  MemoryStats,
  ChatEntry,
  StreamVisibility,
  StreamWindowBounds,
} from '../shared/types';

// ── Multi-Agent IT Assistant proposal-phase OpenAI vision call ─────────────────────
//
// PROPOSAL PHASE ONLY. Per docs/02-FLICKY-INTEGRATION-SPEC.md the locked
// stack is Claude Sonnet + 4 specialized agents + RAG + ChromaDB. For the
// proposal demo we make a single gpt-4o vision call and dress it up with
// the visual agent panel — restored to the locked stack during hackathon
// implementation.

const SYSTEM_PROMPT = `أنت مساعد دعم تقني للموظفين السعوديين. مهمتك:

1. تحليل لقطة الشاشة المُرفقة لفهم التطبيق المفتوح والمشكلة الظاهرة
2. الاستماع لسؤال المستخدم بالعربية
3. تقديم حل عملي مختصر بالعربية الفصحى مع المصطلحات التقنية بالإنجليزية كما يستخدمها الموظف السعودي طبيعياً
4. تحديد إحداثيات الزر أو العنصر الذي يجب الضغط عليه لحل المشكلة

أجب دائماً بصيغة JSON بهذا الشكل بالضبط، بدون أي نص إضافي قبله أو بعده:

{
  "response_arabic": "الرد العربي للمستخدم في 1-3 جمل قصيرة",
  "cursor_x": <رقم صحيح>,
  "cursor_y": <رقم صحيح>,
  "cursor_label": "نص عربي قصير (3-6 كلمات) يصف ما يفعله هذا الزر"
}

قواعد صارمة:
- الرد يجب أن يكون موجهاً مباشرة للمستخدم بصيغة المخاطب (أنت/اضغط/تأكد)
- لا تذكر أبداً كلمات: "وكلاء"، "ذكاء اصطناعي"، "نموذج"، "AI"، "system"
- اقترح حلاً واحداً فقط، الأبسط والأسرع
- إحداثيات المؤشر يجب أن تكون داخل أبعاد الصورة المُرفقة بالضبط
- إذا لم تستطع تحديد زر محدد، استخدم منتصف منطقة الحل الأقرب
- المصطلحات التقنية (VPN, password, Send/Receive, Settings) تبقى بالإنجليزية
- استخدم ال (التعريف) لربط الكلمات الإنجليزية: "الـ VPN"، "الـ password"

مثال على رد صحيح:
{
  "response_arabic": "اضغط على زر Send/Receive في الشريط العلوي لتحديث الإيميل. إذا استمرت المشكلة، تأكد من اتصال الإنترنت.",
  "cursor_x": 245,
  "cursor_y": 89,
  "cursor_label": "زر Send/Receive لتحديث الإيميل"
}`;

interface VisionResult {
  response_arabic: string;
  cursor_x: number;
  cursor_y: number;
  cursor_label: string;
}

async function runOpenAIVision(
  apiKey: string,
  transcript: string,
  screenshot: ScreenCapture,
  signal: AbortSignal,
): Promise<VisionResult | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: transcript },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${screenshot.dataBase64}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 700,
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      console.error('[Multi-Agent] OpenAI vision call failed:', res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error('[Multi-Agent] OpenAI returned no content');
      return null;
    }

    const parsed = JSON.parse(content) as Partial<VisionResult>;
    if (
      typeof parsed.response_arabic !== 'string' ||
      typeof parsed.cursor_x !== 'number' ||
      typeof parsed.cursor_y !== 'number' ||
      typeof parsed.cursor_label !== 'string'
    ) {
      console.error('[Multi-Agent] OpenAI returned malformed JSON:', parsed);
      return null;
    }
    return parsed as VisionResult;
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || signal.aborted)) {
      return null;
    }
    console.error('[Multi-Agent] OpenAI vision call threw:', err);
    return null;
  }
}

// Anthropic Claude vision call — same contract as runOpenAIVision but uses the
// Anthropic Messages API. Forces JSON output by prefilling the assistant turn
// with `{` (Anthropic doesn't have a native json_object response_format).
async function runAnthropicVision(
  apiKey: string,
  transcript: string,
  screenshot: ScreenCapture,
  signal: AbortSignal,
): Promise<VisionResult | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 700,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: screenshot.dataBase64,
                },
              },
              { type: 'text', text: transcript },
            ],
          },
          { role: 'assistant', content: '{' },
        ],
      }),
    });

    if (!res.ok) {
      console.error('[Multi-Agent] Anthropic vision call failed:', res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (!text) {
      console.error('[Multi-Agent] Anthropic returned no text content');
      return null;
    }

    let jsonStr = '{' + text;
    const lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace !== -1) jsonStr = jsonStr.slice(0, lastBrace + 1);

    const parsed = JSON.parse(jsonStr) as Partial<VisionResult>;
    if (
      typeof parsed.response_arabic !== 'string' ||
      typeof parsed.cursor_x !== 'number' ||
      typeof parsed.cursor_y !== 'number' ||
      typeof parsed.cursor_label !== 'string'
    ) {
      console.error('[Multi-Agent] Anthropic returned malformed JSON:', parsed);
      return null;
    }
    return parsed as VisionResult;
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || signal.aborted)) {
      return null;
    }
    console.error('[Multi-Agent] Anthropic vision call threw:', err);
    return null;
  }
}

export interface CompanionCallbacks {
  onVoiceStateChanged: (state: VoiceState) => void;
  onTranscriptUpdate: (result: TranscriptionResult) => void;
  onAiResponseChunk: (chunk: string) => void;
  onAiResponseComplete: (fullText: string) => void;
  onElementDetected: (element: DetectedElement | null) => void;
  onSettingsChanged: (settings: FlickySettings) => void;
  onMemoryStatsChanged: (stats: MemoryStats) => void;
  onChatEntryAdded: (entry: ChatEntry) => void;
  onStartAudioCapture: () => void;
  onStopAudioCapture: () => void;
  onPlayAudio: (audioBuffer: Buffer) => void;
  onCursorVisibilityChanged: (enabled: boolean) => void;
  onStreamVisibilityChanged: (v: StreamVisibility) => void;
  /**
   * Multi-Agent IT Assistant — fired at the start of every request so the agent
   * collaboration panel restarts its animation. The orchestrator follows up
   * with onAgentMessage events that drive the panel from real state.
   */
  onAgentPanelShow: () => void;
  /**
   * Multi-Agent IT Assistant — per-agent state update. Streams from the
   * orchestrator each time an agent transitions (thinking → active → done).
   */
  onAgentMessage: (msg: AgentMessage) => void;
}

export class CompanionManager {
  private callbacks: CompanionCallbacks;

  private claude: ClaudeAPI;
  private openai: OpenAIAPI;
  private tts: ElevenLabsTTS;
  private context: ContextManager;
  private transcriptionProvider: TranscriptionProvider | null = null;

  private voiceState: VoiceState = 'idle';
  private lastScreenshots: ScreenCapture[] = [];
  private isRecording = false;
  /**
   * True from the moment we begin transcribing a captured turn until the
   * agent pipeline (transcribe → screenshot → orchestrator → final reply)
   * fully resolves. While true, any new PTT press is ignored — the user
   * cannot start another turn until the previous one finishes. Without
   * this lock, rapid PTT presses race and corrupt the agent panel state.
   */
  private isProcessingTurn = false;
  private reRegisterShortcut: ((accel: string) => boolean) | null = null;
  /**
   * Monotonic turn counter. A new PTT press bumps this; any still-running
   * LLM callbacks from the previous turn check if their captured id still
   * matches before they're allowed to mutate shared state.
   */
  private turnId = 0;
  private currentAbort: AbortController | null = null;
  /**
   * If startRecording is in flight, other callers (typically a quick-release
   * stopPushToTalk) await this before deciding whether to stop. Without it,
   * stop can fire before `isRecording` has been flipped true, bail, and
   * leave the mic running forever.
   */
  private pendingStart: Promise<void> | null = null;

  constructor(callbacks: CompanionCallbacks) {
    this.callbacks = callbacks;
    this.claude = new ClaudeAPI();
    this.openai = new OpenAIAPI();
    this.tts = new ElevenLabsTTS();
    this.context = new ContextManager();

    analytics.initAnalytics('', 'https://us.i.posthog.com');
    analytics.trackAppOpened();
  }

  // ── Settings ─────────────────────────────────────────────────────────

  getSettings(): FlickySettings {
    const stored = settingsStore.getAll();
    return {
      ...stored,
      apiKeyStatus: keyStore.getKeyStatus(),
    };
  }

  setModel(model: ClaudeModel): void {
    settingsStore.set('selectedModel', model);
    this.emitSettings();
  }

  setOpenAIModel(model: OpenAIModel): void {
    settingsStore.set('selectedOpenAIModel', model);
    this.emitSettings();
  }

  setMindProvider(provider: MindProvider): void {
    settingsStore.set('mindProvider', provider);
    this.emitSettings();
  }

  setReasoningDepth(depth: ReasoningDepth): void {
    settingsStore.set('reasoningDepth', depth);
    this.emitSettings();
  }

  setReplyTone(tone: ReplyTone): void {
    settingsStore.set('replyTone', tone);
    this.emitSettings();
  }

  setVoiceId(id: string): void {
    settingsStore.set('voiceId', id);
    this.emitSettings();
  }

  setVoiceSpeed(speed: number): void {
    settingsStore.set('voiceSpeed', speed);
    this.emitSettings();
  }

  setVoiceStability(stability: number): void {
    settingsStore.set('voiceStability', stability);
    this.emitSettings();
  }

  setSpeakReplies(enabled: boolean): void {
    settingsStore.set('speakReplies', enabled);
    this.emitSettings();
  }

  setGroqModel(model: GroqTranscriptionModel): void {
    settingsStore.set('groqTranscriptionModel', model);
    this.emitSettings();
  }

  toggleCursor(enabled: boolean): void {
    settingsStore.set('isClickyCursorEnabled', enabled);
    this.callbacks.onCursorVisibilityChanged(enabled);
    this.emitSettings();
  }

  setStreamVisibility(v: StreamVisibility): void {
    settingsStore.set('streamVisibility', v);
    this.callbacks.onStreamVisibilityChanged(v);
    this.emitSettings();
  }

  setStreamWindowBounds(b: StreamWindowBounds): void {
    settingsStore.set('streamWindowBounds', b);
    this.emitSettings();
  }

  setShortcutReRegister(fn: (accel: string) => boolean): void {
    this.reRegisterShortcut = fn;
  }

  setPushToTalkShortcut(accelerator: string): void {
    const previous = settingsStore.get('pushToTalkShortcut');
    if (!this.reRegisterShortcut) {
      settingsStore.set('pushToTalkShortcut', accelerator);
      this.emitSettings();
      return;
    }
    const ok = this.reRegisterShortcut(accelerator);
    if (ok) {
      settingsStore.set('pushToTalkShortcut', accelerator);
    } else {
      console.warn('[Flicky] Failed to register shortcut', accelerator, '— reverting to', previous);
      this.reRegisterShortcut(previous);
    }
    this.emitSettings();
  }

  setLaunchAtLogin(enabled: boolean): void {
    settingsStore.set('launchAtLogin', enabled);
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } catch (err) {
      console.error('[Flicky] setLoginItemSettings failed:', err);
    }
    this.emitSettings();
  }

  completeOnboarding(): void {
    settingsStore.set('onboardingComplete', true);
    this.emitSettings();
  }

  replayOnboarding(): void {
    settingsStore.set('onboardingComplete', false);
    analytics.trackOnboardingReplayed();
    this.emitSettings();
  }

  // ── Context / Memory ─────────────────────────────────────────────────

  clearContext(): void {
    this.context.clear();
    this.emitMemoryStats();
  }

  async compactContext(): Promise<{ ok: boolean; error?: string }> {
    if (!this.context.canCompact()) {
      return { ok: false, error: 'Need at least two exchanges before compacting.' };
    }
    try {
      await this.context.compact(true);
      this.emitMemoryStats();
      return { ok: true };
    } catch (err) {
      this.emitMemoryStats();
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getMemoryStats(): MemoryStats {
    return this.context.getStats();
  }

  // ── Chat history ─────────────────────────────────────────────────────

  getChatHistory(): ChatEntry[] {
    return chatHistory.getAll();
  }

  clearChatHistory(): void {
    chatHistory.clear();
  }

  // ── API Keys ─────────────────────────────────────────────────────────

  setApiKey(name: ApiKeyName, value: string): void {
    keyStore.setApiKey(name, value);
    this.emitSettings();
  }

  deleteApiKey(name: ApiKeyName): void {
    keyStore.deleteApiKey(name);
    this.emitSettings();
  }

  getApiKeyStatus(): Record<ApiKeyName, boolean> {
    return keyStore.getKeyStatus();
  }

  // ── TTS preview ──────────────────────────────────────────────────────

  async playVoicePreview(voiceId: string): Promise<void> {
    try {
      const buf = await this.tts.synthesize(
        "hi, i'm flicky. i'll be using this voice to talk with you.",
        {
          voiceId,
          speed: settingsStore.get('voiceSpeed'),
          stability: settingsStore.get('voiceStability'),
        },
      );
      this.callbacks.onPlayAudio(buf);
    } catch (err) {
      console.error('[Flicky] voice preview failed:', err);
    }
  }

  // ── Permissions ──────────────────────────────────────────────────────

  async getPermissions(): Promise<Record<string, boolean>> {
    const perms: Record<string, boolean> = { microphone: false, screen: false };
    if (process.platform === 'darwin') {
      perms.microphone = systemPreferences.getMediaAccessStatus('microphone') === 'granted';
      perms.screen = systemPreferences.getMediaAccessStatus('screen') === 'granted';
    } else {
      perms.microphone = true;
      perms.screen = true;
    }
    return perms;
  }

  async requestPermission(kind: string): Promise<void> {
    if (process.platform === 'darwin' && kind === 'microphone') {
      await systemPreferences.askForMediaAccess('microphone');
    }
  }

  // ── Push-to-Talk Pipeline ────────────────────────────────────────────

  async handlePushToTalk(): Promise<void> {
    // While a turn is being processed (transcription → agents → response),
    // ignore new PTT presses entirely. This prevents the user from kicking
    // off a second turn that races with the first one mid-Computer-Use.
    if (this.isProcessingTurn) {
      console.log('[Multi-Agent] PTT ignored — previous turn still processing');
      return;
    }
    if (this.isRecording) await this.stopRecordingAndProcess();
    else await this.startRecording();
  }

  async startPushToTalk(): Promise<void> {
    if (this.isProcessingTurn) {
      console.log('[Multi-Agent] startPushToTalk ignored — turn in progress');
      return;
    }
    if (this.isRecording || this.pendingStart) return;
    const p = this.startRecording();
    this.pendingStart = p;
    try {
      await p;
    } finally {
      if (this.pendingStart === p) this.pendingStart = null;
    }
  }

  /**
   * User-requested abort. Cancels any in-flight transcription / agent
   * pipeline / Computer Use loop. The next PTT press starts fresh.
   * Called from the global Escape shortcut.
   */
  abortCurrentTurn(): boolean {
    if (!this.isProcessingTurn && !this.isRecording) {
      return false; // nothing to abort
    }
    console.log('[Multi-Agent] User pressed Escape — aborting current turn');
    if (this.currentAbort) this.currentAbort.abort();
    this.isRecording = false;
    this.isProcessingTurn = false;
    this.callbacks.onStopAudioCapture();
    this.setVoiceState('idle');
    // Notify the user's stream window
    this.callbacks.onAiResponseComplete('تم إلغاء الجلسة. اضغطي على PTT لتجربة طلب آخر.');
    return true;
  }

  async stopPushToTalk(): Promise<void> {
    // If a start is still in flight, let it finish so isRecording flips
    // true before we decide whether to stop. Otherwise a quick press/release
    // can race past the start and leak a live mic.
    if (this.pendingStart) {
      try { await this.pendingStart; } catch { /* surfaced inside startRecording */ }
    }
    if (!this.isRecording) return;
    await this.stopRecordingAndProcess();
  }

  private async startRecording(): Promise<void> {
    // Bump the turn and abort any in-flight work from the previous one
    // so the user's new message supersedes whatever Flicky was doing.
    this.turnId += 1;
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }

    this.isRecording = true;
    this.setVoiceState('listening');
    analytics.trackPushToTalkStarted();

    const provider = settingsStore.get('transcriptionProvider');
    this.transcriptionProvider = createTranscriptionProvider(provider);

    this.transcriptionProvider.onPartialTranscript = (text) => {
      this.callbacks.onTranscriptUpdate({ text, isFinal: false });
    };

    try {
      await this.transcriptionProvider.start();
      this.callbacks.onStartAudioCapture();
    } catch (err) {
      console.error('Failed to start transcription:', err);
      this.setVoiceState('idle');
      this.isRecording = false;
    }
  }

  private async stopRecordingAndProcess(): Promise<void> {
    this.isRecording = false;
    this.isProcessingTurn = true;       // lock — no new PTT until done
    this.callbacks.onStopAudioCapture();
    analytics.trackPushToTalkReleased();

    if (!this.transcriptionProvider) {
      this.isProcessingTurn = false;
      this.setVoiceState('idle');
      return;
    }
    try {

    const result = await this.transcriptionProvider.stop();
    this.transcriptionProvider = null;

    if (!result.text.trim()) {
      this.setVoiceState('idle');
      return;
    }

    this.callbacks.onTranscriptUpdate(result);
    analytics.trackUserMessageSent(result.text);

    console.log(`[Multi-Agent] transcript ok, length=${result.text.length}`);
    this.setVoiceState('processing');
    try {
      this.lastScreenshots = await captureAllDisplays();
      console.log(`[Multi-Agent] captured ${this.lastScreenshots.length} screen(s)`);
    } catch (err) {
      console.error('[Multi-Agent] Screen capture failed:', err);
      this.lastScreenshots = [];
    }

    const settings = settingsStore.getAll();
    const myTurnId = this.turnId;
    const abort = new AbortController();
    this.currentAbort = abort;
    // Stay in 'processing' until TTS audio is ready to play (or the
    // reply completes without TTS). The UI shows its spinner during
    // this state, so this keeps the spinner visible for the full
    // think + stream + synthesize span instead of flashing for a
    // few ms during screenshot capture only.

    // Every side effect below is gated on the turn id. If the user has
    // already started a new PTT by the time an async callback resolves,
    // we drop the callback on the floor — no stale UI mutations, no
    // stale chat entries, no TTS we'd have to kill on arrival.
    const isCurrent = () => this.turnId === myTurnId;

    const mindCallbacks = {
      onChunk: (chunk: string) => {
        if (!isCurrent()) return;
        this.callbacks.onAiResponseChunk(chunk);
      },
      onComplete: async (
        fullText: string,
        usage?: { inputTokens: number; outputTokens: number },
      ) => {
        if (!isCurrent()) return;
        analytics.trackAiResponseReceived(fullText);

        const cleanText = fullText.replace(/\[POINT:[^\]]+\]/g, '').trim();
        this.callbacks.onAiResponseComplete(cleanText);

        await this.context.recordExchange(result.text, cleanText, {
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
        });
        if (!isCurrent()) return;
        this.emitMemoryStats();

        const entry = chatHistory.append({
          userText: result.text,
          assistantText: cleanText,
        });
        this.callbacks.onChatEntryAdded(entry);

        const element = parsePointTags(fullText, this.lastScreenshots);
        if (element) {
          this.callbacks.onElementDetected(element);
          analytics.trackElementPointed(element.label);
        }

        if (settings.speakReplies && keyStore.getKeyStatus().elevenlabs) {
          try {
            const audioBuffer = await this.tts.synthesize(cleanText, {
              voiceId: settings.voiceId,
              speed: settings.voiceSpeed,
              stability: settings.voiceStability,
            });
            // User may have started a new turn while TTS was synthesizing;
            // don't play an answer they no longer want to hear.
            if (!isCurrent()) return;
            this.setVoiceState('responding');
            this.callbacks.onPlayAudio(audioBuffer);
          } catch (err) {
            console.error('TTS error:', err);
            analytics.trackTtsError(String(err));
          }
        }

        if (!isCurrent()) return;
        this.setVoiceState('idle');
        setTimeout(() => {
          if (isCurrent()) this.callbacks.onElementDetected(null);
        }, 6000);
      },
      onError: (err: Error) => {
        if (!isCurrent()) return;
        console.error('Mind provider error:', err);
        analytics.trackResponseError(err.message);
        this.setVoiceState('idle');
      },
    };

    const mindOptions = {
      reasoningDepth: settings.reasoningDepth,
      replyTone: settings.replyTone,
      signal: abort.signal,
    };

    // ── Multi-Agent IT Assistant integration boundary (Phase 1 / Day-1 stub) ──────
    // Hard-coded VPN-scenario response for the proposal-phase demo video.
    // Real handleUserRequest() with 4 agents replaces this in Phase 2 per
    // Integration Spec §5.1.
    //
    // Sequence per demo script:
    //   1. Open the agent-collaboration panel — runs its own ~12s timeline
    //   2. Wait for the panel to complete its animation
    //   3. Stream the hard-coded Arabic Reporter message into the existing
    //      Flicky panel/stream UI via mindCallbacks.onComplete
    //   4. Fire the cursor target directly via callbacks.onElementDetected,
    //      bypassing parsePointTags so the cursor flies regardless of
    //      whether macOS Screen Recording permission was granted (i.e. even
    //      if this.lastScreenshots is empty)
    //
    // Honors abort + turnId so a new PTT press cleanly cancels mid-stub.
    void mindOptions;  // unused in stub; real orchestrator (Phase 2) consumes it

    // Open the agent collaboration panel. The renderer runs a hardcoded
    // animation only as a fallback — once real onAgentMessage events start
    // arriving from the orchestrator, the panel switches to driving its
    // visuals from those events.
    console.log(`[Multi-Agent] orchestrator: opening agent panel, turnId=${myTurnId}`);
    // The agent panel is the canonical "🛑 agent is working — don't touch"
    // indicator. It pulses blue during Computer Use so the user knows the
    // cursor is being controlled by the agent. Without this, users would
    // grab the mouse mid-action and break the run.
    this.callbacks.onAgentPanelShow();

    const anthropicKey = keyStore.getApiKey('anthropic');
    const visionScreenshot = this.lastScreenshots[0];

    if (!anthropicKey || !visionScreenshot) {
      // Degraded path. Surface a clear hardcoded message rather than nothing
      // so the demo never silently fails when keys aren't configured.
      const finalMessage = !anthropicKey
        ? 'مفتاح Anthropic غير مُعرّف. أضفه من تبويب Mind لتفعيل الوكلاء.'
        : 'تعذّر التقاط الشاشة. تحقق من صلاحية تسجيل الشاشة.';
      const primary = screen.getPrimaryDisplay();
      const cursorTarget = {
        x: primary.bounds.x + Math.floor(primary.bounds.width / 2),
        y: primary.bounds.y + Math.floor(primary.bounds.height / 2),
        label: 'تحقق من الإعدادات',
        screenIndex: 0,
      };
      console.log('[Multi-Agent] orchestrator: degraded path — missing key or screenshot');
      if (isCurrent()) {
        mindCallbacks.onChunk(finalMessage);
        await mindCallbacks.onComplete(finalMessage);
        this.callbacks.onElementDetected(cursorTarget);
      }
    } else {
      // Real path. Call the 4-agent orchestrator with the same abort/turnId
      // semantics Flicky uses for its single-call path. Each agent emits
      // onAgentMessage events that drive the visual panel.
      console.log('[Multi-Agent] orchestrator: dispatching 4-agent pipeline');
      const output = await handleUserRequest({
        voiceTranscript: result.text,
        screenshot: visionScreenshot,
        anthropicKey,
        signal: abort.signal,
        onAgentMessage: (msg) => {
          if (!isCurrent()) return;
          this.callbacks.onAgentMessage(msg);
        },
      });

      if (!isCurrent()) {
        console.log('[Multi-Agent] orchestrator: turn preempted, dropping output');
      } else if (!output) {
        // Orchestrator returned null — likely Resolver failed mid-flight.
        // Surface a generic Arabic fallback so the user gets *something*.
        const fallbackMessage = 'تعذّر إكمال التحليل. حاولي مرة ثانية.';
        mindCallbacks.onChunk(fallbackMessage);
        await mindCallbacks.onComplete(fallbackMessage);
        console.log('[Multi-Agent] orchestrator: returned null, emitted fallback message');
      } else {
        mindCallbacks.onChunk(output.finalUserMessage);
        await mindCallbacks.onComplete(output.finalUserMessage);
        if (output.cursorTarget && isCurrent()) {
          console.log(
            `[Multi-Agent] orchestrator: firing cursor at ${output.cursorTarget.x},${output.cursorTarget.y}`,
          );
          this.callbacks.onElementDetected(output.cursorTarget);
        }
      }
    }
    // ── end Multi-Agent IT Assistant integration boundary ─────────────────────────

    if (this.currentAbort === abort) this.currentAbort = null;
    } finally {
      // Always release the PTT lock — even on errors — so the user isn't
      // stuck unable to record again.
      this.isProcessingTurn = false;
    }
  }

  handleAudioChunk(buffer: Buffer): void {
    this.transcriptionProvider?.sendAudio(buffer);
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private setVoiceState(state: VoiceState): void {
    this.voiceState = state;
    this.callbacks.onVoiceStateChanged(state);
  }

  private emitSettings(): void {
    this.callbacks.onSettingsChanged(this.getSettings());
  }

  private emitMemoryStats(): void {
    this.callbacks.onMemoryStatsChanged(this.context.getStats());
  }
}
