// Resolver Agent — looks at the user's screen and figures out the root
// cause + the UI element they need to interact with.
//
// This is the only agent in Phase 1 that does real model inference.
// It calls Claude Sonnet vision with the screenshot + transcript and
// expects JSON back: { response_arabic, cursor_x, cursor_y, cursor_label }.
//
// Returns null if the call failed; the orchestrator decides whether to
// fall through to the hardcoded scenario or surface the error.

import type { ScreenCapture } from '../../shared/types';

// Flicky's screen-capture service already resizes to 1280px max. That's
// well under Anthropic's 1568px auto-resize threshold, so Claude sees the
// image at exactly the dimensions we report — we anchor its coordinate
// frame by passing those dimensions explicitly in the prompt.

function buildResolverPrompt(imageWidth: number, imageHeight: number): string {
  return `أنت "وكيل المحلل" في فريق دعم تقني للموظفين السعوديين.

مهمتك:
1. تحليل لقطة الشاشة المُرفقة لفهم التطبيق المفتوح والمشكلة الظاهرة
2. الاستماع لسؤال المستخدم بالعربية
3. تحديد السبب الجذري للمشكلة في جملة واحدة
4. تحديد إحداثيات الزر/العنصر الذي يجب الضغط عليه

═══ إطار الإحداثيات الإلزامي ═══
الصورة المُرفقة بالضبط: ${imageWidth} × ${imageHeight} بكسل.
الأصل (0,0) في الزاوية العليا اليسرى للصورة.
يجب أن تكون كل إحداثيات الإخراج ضمن النطاق [0, ${imageWidth}] في x و [0, ${imageHeight}] في y.
لا تستخدم نسب مئوية، لا تستخدم أبعاد افتراضية، لا تتجاوز هذه الأبعاد.

طريقة التفكير المطلوبة:
أولاً، صف موقع العنصر بالنسبة للعناصر المجاورة (ليس مجرد إحداثيات).
ثم حدّد إحداثيات مركز العنصر بالبكسل ضمن الصورة الحالية ${imageWidth}×${imageHeight}.

أجب دائماً بصيغة JSON بهذا الشكل بالضبط، بدون أي نص إضافي:

{
  "location_reasoning": "وصف موقع العنصر: مثلاً 'في الزاوية العليا اليمنى من شريط القوائم، يسار الساعة'",
  "root_cause_arabic": "السبب الجذري في جملة عربية واحدة قصيرة",
  "cursor_x": <رقم صحيح ضمن [0, ${imageWidth}]>,
  "cursor_y": <رقم صحيح ضمن [0, ${imageHeight}]>,
  "cursor_label": "نص عربي قصير (3-6 كلمات) يصف ما يفعله هذا الزر"
}

قواعد:
- اختر مركز العنصر القابل للنقر بالضبط، ليس الحافة ولا منطقة مجاورة
- المصطلحات التقنية (WiFi, VPN, password) تبقى بالإنجليزية
- لا تذكر أبداً: "وكلاء"، "AI"، "ذكاء اصطناعي"
- "root_cause_arabic" يصف المشكلة فقط، لا يقدم الحل`;
}

export interface ResolverResult {
  rootCauseArabic: string;
  target: {
    x: number;
    y: number;
    label: string;
  };
}

export async function runResolverAgent(
  apiKey: string,
  transcript: string,
  screenshot: ScreenCapture,
  signal: AbortSignal,
): Promise<ResolverResult | null> {
  // Screen-capture already produces a 1280px-max image. We send it as-is and
  // pin Claude's coordinate frame by stating the dimensions in the prompt.
  const imgW = screenshot.imageWidth;
  const imgH = screenshot.imageHeight;

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
        max_tokens: 600,
        temperature: 0.0, // deterministic coordinates
        system: buildResolverPrompt(imgW, imgH),
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
      console.error('[Resolver] vision call failed:', res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (!text) {
      console.error('[Resolver] returned no text content');
      return null;
    }

    let jsonStr = '{' + text;
    const lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace !== -1) jsonStr = jsonStr.slice(0, lastBrace + 1);

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const rootCause = parsed.root_cause_arabic;
    const cx = parsed.cursor_x;
    const cy = parsed.cursor_y;
    const label = parsed.cursor_label;
    const reasoning = parsed.location_reasoning;

    if (
      typeof rootCause !== 'string' ||
      typeof cx !== 'number' ||
      typeof cy !== 'number' ||
      typeof label !== 'string'
    ) {
      console.error('[Resolver] returned malformed JSON:', parsed);
      return null;
    }

    // Claude's coordinates are already in image-pixel space (we told it the
    // exact dimensions in the prompt). Just clamp to bounds.
    const clampedX = Math.max(0, Math.min(imgW - 1, cx));
    const clampedY = Math.max(0, Math.min(imgH - 1, cy));

    console.log(
      `[Resolver] image_dims=${imgW}x${imgH} ` +
      `claude_returned=(${Math.round(cx)},${Math.round(cy)}) ` +
      `label="${label}" reasoning="${typeof reasoning === 'string' ? reasoning : '(none)'}"`,
    );

    return {
      rootCauseArabic: rootCause,
      target: { x: clampedX, y: clampedY, label },
    };
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || signal.aborted)) {
      return null;
    }
    console.error('[Resolver] threw:', err);
    return null;
  }
}
