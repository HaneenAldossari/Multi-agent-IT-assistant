// Computer Use loop — the agentic core. Claude takes screenshots, decides
// what to do, emits tool_use blocks (click/type/key/screenshot), we execute
// them via osascript wrappers in tools/computer.ts, then send the new
// screenshot back as a tool_result. Loop until Claude returns plain text
// (signaling done) or we hit MAX_ITERATIONS.
//
// This replaces the proposal-phase single-call vision approach. Where the
// old code was advisory ("here's where to click"), this is agentic ("I am
// clicking it for you, then I'll verify").

import { nativeImage } from 'electron';
import type { ScreenCapture } from '../../shared/types';
import { captureAllDisplays } from '../services/screen-capture';
import * as computerTools from './tools/computer';

// Downscale screenshots to this max edge before sending to Claude.
// At 1280x800: ~1365 tokens per image. At 768x480: ~492 tokens. The
// agent doesn't need pixel-perfect detail to identify UI elements, so
// the smaller image is plenty and keeps us well under the per-minute
// rate limit on tier-1 Anthropic accounts.
const SCREENSHOT_MAX_DIM_FOR_API = 768;

const SYSTEM_PROMPT = `You are an IT support AGENT on macOS that takes ACTIONS — not an advisor that describes them. You have full computer control via the computer tool.

═══ CORE BEHAVIOR ═══

When the user asks for ANY task — even ones that seem simple — your default is to TAKE ACTION immediately. NEVER reply conversationally without first taking action. NEVER say things like "you can do X by..." — just do X yourself.

If the user says "open Calculator", "افتح Calculator", "افتح الآلة الحاسبة", or similar — your IMMEDIATE next response must be a tool_use block, not text.

═══ HOW TO OPEN APPS (memorize this exactly) ═══

For every "open X" / "افتح X" request, follow this sequence in tool calls:
  1. key("cmd+space")     → Spotlight opens
  2. type("AppName")      → app name typed
  3. key("Return")        → app launches
  4. wait(2)              → 2 second pause
  5. screenshot           → confirm app is foreground
  6. (only NOW respond with text) "تم فتح X."

═══ ARABIC COMMANDS — exact mapping ═══

User says "افتح Calculator" or "افتح الآلة الحاسبة" → open Calculator app
User says "افتح Notes" or "افتح الملاحظات" → open Notes app
User says "افتح Safari" → open Safari
User says "غيّر الشبكة" → click menu-bar Wi-Fi icon, switch network
User says "أعد تشغيل X" → quit app via cmd+q from menu, reopen via Spotlight

User says "افحصي اتصال الإنترنت" / "تأكدي من الإنترنت" / "ping" / "تشخيص الشبكة" → run a ping diagnostic in Terminal:
  1. key("cmd+space")           → Spotlight
  2. type("Terminal")
  3. key("Return")               → Terminal opens
  4. wait(1.5)                   → wait for prompt
  5. type("ping -c 4 google.com")
  6. key("Return")               → run command
  7. wait(5)                     → wait for 4 ping replies (~4 seconds)
  8. screenshot                  → READ the output
  9. Final text in Arabic that quotes the actual measured average latency from the screenshot, e.g. "تم فحص الاتصال — 4 من 4 ردود، متوسط الزمن X ms. الشبكة سليمة."

When reading ping output, look for the line "round-trip min/avg/max/stddev = X.X/Y.Y/..." — Y.Y is the average latency. If you see "Request timeout" or "0 packets received" the connection is broken — report that instead.

═══ ABSOLUTE RULES ═══

- Iteration 1 of EVERY task MUST contain a tool_use call. No exceptions.
- Iteration 1 should be the FIRST action of the task (e.g. "cmd+space"). Do NOT take an initial screenshot — the user already provided one.
- Never assume an app is open. ALWAYS Spotlight first.
- Don't describe what the user could do. Do it.
- Final response (text only, no tool calls) comes ONLY after the task is verifiably complete.
- Final response is one short Arabic sentence: "تم فتح Calculator." or "تم تحويل الشبكة لـ Office-WiFi."

═══ IGNORE THESE UI ELEMENTS ═══

The screenshot may show Flicky's own UI overlays. These are NOT part of the user's task. **Do NOT click them, do NOT press Escape to dismiss them, do NOT interact with them.** They are:

- A blue-tinted floating panel labeled "🤖 الوكيل يتحكّم بالشاشة" with 4 agent rows (Memory, Resolver, Guardian, Reporter) — this is the agent panel
- A small floating capsule at the bottom-center with a waveform — this is the recording pill
- A floating dark panel showing Arabic text — this is the response stream window

Treat these as transparent overlays. Just go straight to the user's task.

═══ NEVER DO ═══

- Reset passwords → reply "هذا يحتاج فريق الدعم البشري"
- Install new software → reply "هذا يحتاج صلاحيات إدارية"
- Open personal files or email content
- Change firewall/security settings`;

const MAX_ITERATIONS = 14;
const MODEL = 'claude-sonnet-4-5';
// Tool type pinned to the version compatible with Sonnet 4.5+ models.
const COMPUTER_TOOL_TYPE = 'computer_20250124';
const ANTHROPIC_BETA = 'computer-use-2025-01-24';

// Cap on how many recent assistant/tool_result turns we keep in the
// conversation. The original user message (with the first screenshot) is
// always kept. Older turns are dropped to stay under the per-minute
// input-token rate limit on entry-tier Anthropic accounts (~30k tokens/min).
// At 1280x800 screenshots ≈ 1365 tokens each, keeping 3 turns ≈ 4-5k tokens
// of images per request — well under the budget.
const KEEP_RECENT_TURNS = 3;

export interface ComputerUseInput {
  apiKey: string;
  transcript: string;
  initialScreenshot: ScreenCapture;
  signal: AbortSignal;
  onStep?: (msg: string) => void;
}

export interface ComputerUseResult {
  success: boolean;
  finalMessage: string;
  iterations: number;
  reason?: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export async function runComputerUseLoop(input: ComputerUseInput): Promise<ComputerUseResult> {
  const { apiKey, transcript, initialScreenshot, signal, onStep } = input;

  // Pre-flight: confirm Accessibility permission. Without it, click/type
  // are no-ops and Claude will get confused by silent action failures.
  const hasAccessibility = await computerTools.checkAccessibilityPermission();
  if (!hasAccessibility) {
    return {
      success: false,
      iterations: 0,
      finalMessage: 'يحتاج التطبيق إذن Accessibility من إعدادات النظام لتشغيل وضع الوكيل.',
      reason: 'accessibility_permission_missing',
    };
  }

  // Conversation history that grows each iteration. Initial screenshot
  // is downscaled to keep token count under the per-minute rate limit.
  const initialDownscaled = downscaleBase64(initialScreenshot.dataBase64, SCREENSHOT_MAX_DIM_FOR_API);
  const messages: Array<{ role: string; content: unknown }> = [
    {
      role: 'user',
      content: [
        imageBlock(initialDownscaled),
        { type: 'text', text: transcript },
      ],
    },
  ];

  // Track display dimensions so the same screenshot reference frame is
  // used for every coordinate transform across iterations.
  const imgW = initialScreenshot.imageWidth;
  const imgH = initialScreenshot.imageHeight;
  const dispBounds = initialScreenshot.displayBounds;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) {
      return { success: false, iterations: i, finalMessage: 'تم الإلغاء.', reason: 'aborted' };
    }
    // Tiny inter-iteration delay so a long task (12+ iterations) doesn't
    // burst past the 30k tokens/min rate limit on tier-1 accounts.
    // Abort-aware so Escape doesn't have to wait through it.
    if (i > 0) {
      const wasAborted = await abortAwareSleep(1500, signal);
      if (wasAborted) {
        return { success: false, iterations: i, finalMessage: 'تم الإلغاء.', reason: 'aborted' };
      }
    }
    onStep?.(`الجولة ${i + 1}: يفكّر...`);

    // Prune older turns to stay under the per-minute input-token limit.
    // We always keep the first user message, then the most recent N pairs.
    const requestMessages = pruneHistory(messages, KEEP_RECENT_TURNS);

    // Retry on 429 with exponential backoff. Per-minute rate limit on
    // tier-1 accounts is 30k input tokens; a heavy run can hit it for ~30s
    // before the window slides forward.
    let res: Response | null = null;
    let attempt = 0;
    const MAX_RETRIES = 3;
    while (attempt <= MAX_RETRIES) {
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': ANTHROPIC_BETA,
          },
          signal,
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            tools: [
              {
                type: COMPUTER_TOOL_TYPE,
                name: 'computer',
                display_width_px: imgW,
                display_height_px: imgH,
                display_number: 1,
              },
            ],
            messages: requestMessages,
          }),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || signal.aborted)) {
          return { success: false, iterations: i, finalMessage: 'تم الإلغاء.', reason: 'aborted' };
        }
        return {
          success: false,
          iterations: i,
          finalMessage: 'تعذّر الاتصال بـ Claude.',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      if (res.status !== 429) break;

      // 429 — back off and retry. Anthropic sends retry-after in seconds.
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 0;
      const waitSec = Math.max(retryAfter, 15 * Math.pow(2, attempt));
      console.warn(`[ComputerUse] 429 rate limit, attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${waitSec}s`);
      onStep?.(`الجولة ${i + 1}: حد المعدل — انتظار ${waitSec}ث...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      if (signal.aborted) {
        return { success: false, iterations: i, finalMessage: 'تم الإلغاء.', reason: 'aborted' };
      }
      attempt++;
    }

    if (!res || !res.ok) {
      const errText = res ? await res.text() : 'no response';
      const status = res?.status ?? 0;
      console.error('[ComputerUse] API error:', status, errText);
      let userFacing: string;
      if (status === 429) {
        userFacing = 'تجاوزنا حد الاستخدام. حاولي بعد دقيقة.';
      } else if (/credit balance is too low/i.test(errText)) {
        userFacing = '⚠️ رصيد Anthropic منتهٍ. أضيفي رصيداً من console.anthropic.com → Billing.';
      } else if (status === 401) {
        userFacing = 'مفتاح Anthropic غير صالح. تحقّقي من تبويب Mind.';
      } else {
        userFacing = 'تعذّر الاتصال بنموذج Claude.';
      }
      return {
        success: false,
        iterations: i,
        finalMessage: userFacing,
        reason: `API ${status}: ${errText.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as { content?: AnthropicContentBlock[]; stop_reason?: string };
    const content = data.content ?? [];

    // Persist assistant turn into the history so subsequent calls have full context.
    messages.push({ role: 'assistant', content });

    const toolUses = content.filter((b) => b.type === 'tool_use');
    const textBlocks = content.filter((b) => b.type === 'text');

    // No tool calls → Claude is finished.
    if (toolUses.length === 0) {
      const finalText = textBlocks
        .map((b) => b.text ?? '')
        .join('\n')
        .trim();
      console.log(`[ComputerUse] iter ${i + 1}: NO TOOL USE — final text: "${finalText.slice(0, 200)}"`);
      onStep?.('انتهى.');
      return {
        success: true,
        iterations: i + 1,
        finalMessage: finalText || 'تم.',
      };
    }

    // Log what Claude is doing each iteration so we can debug behavior.
    for (const tu of toolUses) {
      const action = (tu.input?.action ?? '?') as string;
      const coord = (tu.input?.coordinate as [number, number] | undefined);
      const text = (tu.input?.text as string | undefined);
      console.log(
        `[ComputerUse] iter ${i + 1}: ${action}${coord ? ` @ (${coord[0]},${coord[1]})` : ''}${text ? ` "${text.slice(0, 30)}"` : ''}`,
      );
    }

    // Execute every tool call sequentially and collect tool_results.
    const toolResults: unknown[] = [];
    for (const tu of toolUses) {
      if (signal.aborted) {
        return { success: false, iterations: i, finalMessage: 'تم الإلغاء.', reason: 'aborted' };
      }
      const action = (tu.input?.action ?? '') as string;
      const desc = describeAction(action, tu.input ?? {});
      onStep?.(desc);
      console.log(`[ComputerUse] iter ${i + 1}: ${desc}`);

      let resultBlock: { content: unknown; is_error?: boolean };
      try {
        resultBlock = await executeAction(tu.input ?? {}, { imgW, imgH, dispBounds }, signal);
      } catch (err) {
        resultBlock = {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultBlock.content,
        is_error: resultBlock.is_error,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return {
    success: false,
    iterations: MAX_ITERATIONS,
    finalMessage: `لم أتمكن من حلّ المشكلة بعد ${MAX_ITERATIONS} محاولات. سيتم تصعيدها لفريق الدعم التقني.`,
    reason: 'iteration_limit',
  };
}

// ── Action execution ──────────────────────────────────────────────────

interface DisplayContext {
  imgW: number;
  imgH: number;
  dispBounds: { x: number; y: number; width: number; height: number };
}

async function abortAwareSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  // Polls every 100ms so Escape interrupts long waits instead of forcing
  // the user to wait the full duration before the abort takes effect.
  const ticks = Math.ceil(ms / 100);
  for (let i = 0; i < ticks; i++) {
    if (signal.aborted) return true;
    await new Promise((r) => setTimeout(r, Math.min(100, ms - i * 100)));
  }
  return signal.aborted;
}

async function executeAction(
  input: Record<string, unknown>,
  ctx: DisplayContext,
  signal: AbortSignal,
): Promise<{ content: unknown; is_error?: boolean }> {
  const action = (input.action ?? '') as string;
  const coord = input.coordinate as [number, number] | undefined;
  const text = input.text as string | undefined;

  // Coordinate transform: image-pixel space → display-pixel space.
  const toDisplay = (c: [number, number]): [number, number] => {
    const sx = ctx.dispBounds.width / ctx.imgW;
    const sy = ctx.dispBounds.height / ctx.imgH;
    return [
      Math.round(ctx.dispBounds.x + c[0] * sx),
      Math.round(ctx.dispBounds.y + c[1] * sy),
    ];
  };

  switch (action) {
    case 'screenshot': {
      const cap = (await captureAllDisplays())[0];
      return cap
        ? { content: [imageBlock(downscaleBase64(cap.dataBase64, SCREENSHOT_MAX_DIM_FOR_API))] }
        : { content: 'screenshot failed', is_error: true };
    }

    case 'left_click': {
      if (coord) {
        const [dx, dy] = toDisplay(coord);
        const r = await computerTools.clickAt(dx, dy);
        if (!r.ok) return { content: r.error, is_error: true };
      }
      // Always send a fresh screenshot back so Claude can see the result.
      const cap = (await captureAllDisplays())[0];
      return cap
        ? { content: [imageBlock(downscaleBase64(cap.dataBase64, SCREENSHOT_MAX_DIM_FOR_API))] }
        : { content: 'click ok, screenshot failed', is_error: false };
    }

    case 'mouse_move': {
      if (coord) {
        const [dx, dy] = toDisplay(coord);
        await computerTools.moveCursorTo(dx, dy);
      }
      return { content: 'ok' };
    }

    case 'type': {
      if (text) {
        const r = await computerTools.typeText(text);
        if (!r.ok) return { content: r.error, is_error: true };
      }
      const cap = (await captureAllDisplays())[0];
      return cap ? { content: [imageBlock(downscaleBase64(cap.dataBase64, SCREENSHOT_MAX_DIM_FOR_API))] } : { content: 'typed' };
    }

    case 'key': {
      if (text) {
        // Format like "Return", "Tab", "cmd+s", "ctrl+c"
        const parts = text.split('+');
        const keyName = capitalize(parts[parts.length - 1]);
        const macMods = parts.slice(0, -1).map((m) => mapMod(m));
        const r = await computerTools.pressKey(keyName, macMods);
        if (!r.ok) return { content: r.error, is_error: true };
      }
      const cap = (await captureAllDisplays())[0];
      return cap ? { content: [imageBlock(cap.dataBase64)] } : { content: 'key sent' };
    }

    case 'cursor_position':
      // We don't track cursor position explicitly; return a placeholder
      // so Claude knows the call succeeded but doesn't have real data.
      return { content: 'cursor position not tracked' };

    case 'wait': {
      // The computer_20250124 tool exposes a `wait` action; it expects the
      // executor to actually pause. Wait abort-aware so Escape interrupts.
      const dur = Number((input.duration as number | undefined) ?? (text ? Number(text) : 1));
      const seconds = Number.isFinite(dur) ? Math.min(Math.max(dur, 0.5), 5) : 1.5;
      const wasAborted = await abortAwareSleep(seconds * 1000, signal);
      if (wasAborted) return { content: 'aborted', is_error: true };
      const cap = (await captureAllDisplays())[0];
      return cap
        ? { content: [imageBlock(downscaleBase64(cap.dataBase64, SCREENSHOT_MAX_DIM_FOR_API))] }
        : { content: 'waited' };
    }

    case 'scroll': {
      // Best-effort: translate to arrow keys
      const dir = (input.scroll_direction as string | undefined) ?? 'down';
      const amount = Math.min(Number((input.scroll_amount as number | undefined) ?? 3), 10);
      const keyName = dir === 'up' ? 'Up' : dir === 'left' ? 'Left' : dir === 'right' ? 'Right' : 'Down';
      for (let s = 0; s < amount; s++) {
        await computerTools.pressKey(keyName, []);
      }
      const cap = (await captureAllDisplays())[0];
      return cap
        ? { content: [imageBlock(downscaleBase64(cap.dataBase64, SCREENSHOT_MAX_DIM_FOR_API))] }
        : { content: 'scrolled' };
    }

    case 'hold_key':
    case 'left_mouse_down':
    case 'left_mouse_up':
      return { content: 'ok' };

    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
      // Treat as left click for now — most flows don't need these.
      if (coord) {
        const [dx, dy] = toDisplay(coord);
        await computerTools.clickAt(dx, dy);
      }
      return { content: 'ok' };

    default:
      return { content: `Unsupported action: ${action}`, is_error: true };
  }
}

// Drop older turns so the request stays under the per-minute token budget.
// Always preserves the first message (the user's original request + initial
// screenshot) so Claude has the original context. Then keeps the most
// recent `keepRecentTurns` × 2 messages (each turn is one assistant +
// one user/tool_result pair).
function pruneHistory(
  messages: Array<{ role: string; content: unknown }>,
  keepRecentTurns: number,
): Array<{ role: string; content: unknown }> {
  if (messages.length <= 1) return messages;
  // The first message is the user's original request; always keep it.
  const first = messages[0];
  const rest = messages.slice(1);
  const maxTail = keepRecentTurns * 2; // assistant + tool_result per turn
  if (rest.length <= maxTail) {
    return [first, ...rest];
  }
  return [first, ...rest.slice(rest.length - maxTail)];
}

function imageBlock(base64: string): { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } } {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
  };
}

/**
 * Resize a base64 JPEG so its longest edge is at most maxDim pixels.
 * Returns the resized base64 (or the original if it was already small).
 * Heavy lifting is done by Electron's nativeImage.
 */
function downscaleBase64(base64: string, maxDim: number): string {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    const size = img.getSize();
    const longest = Math.max(size.width, size.height);
    if (longest <= maxDim) return base64;
    const ratio = maxDim / longest;
    const resized = img.resize({
      width: Math.round(size.width * ratio),
      height: Math.round(size.height * ratio),
    });
    return resized.toJPEG(75).toString('base64');
  } catch {
    return base64; // best-effort — fall back to original on any error
  }
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function mapMod(m: string): string {
  const lower = m.toLowerCase();
  switch (lower) {
    case 'cmd':
    case 'command':
      return 'command';
    case 'ctrl':
    case 'control':
      return 'control';
    case 'alt':
    case 'option':
      return 'option';
    case 'shift':
      return 'shift';
    default:
      return lower;
  }
}

function describeAction(action: string, input: Record<string, unknown>): string {
  const coord = input.coordinate as [number, number] | undefined;
  const text = input.text as string | undefined;
  switch (action) {
    case 'screenshot':
      return 'يلتقط لقطة شاشة...';
    case 'left_click':
      return coord ? `ينقر عند (${coord[0]}, ${coord[1]})...` : 'ينقر...';
    case 'double_click':
      return coord ? `ينقر مرتين عند (${coord[0]}, ${coord[1]})...` : 'ينقر مرتين...';
    case 'right_click':
      return coord ? `ينقر بالزر الأيمن عند (${coord[0]}, ${coord[1]})...` : 'ينقر بالأيمن...';
    case 'mouse_move':
      return coord ? `يحرّك المؤشر إلى (${coord[0]}, ${coord[1]})...` : 'يحرّك المؤشر...';
    case 'type':
      return text ? `يكتب: ${text.slice(0, 32)}${text.length > 32 ? '...' : ''}` : 'يكتب...';
    case 'key':
      return text ? `يضغط ${text}...` : 'يضغط مفتاحاً...';
    default:
      return `${action}...`;
  }
}
