// Reporter Agent — synthesizes Memory + Resolver + Guardian outputs into the
// final Arabic message shown to the user. Critically, the message must end
// with a [POINT:x,y:label:screen0] tag so Flicky's existing cursor parser
// (element-detector.ts) flies the cursor to the right element.
//
// PHASE 1 (current): templated synthesis — fast, deterministic, looks great.
// PHASE 2: Claude call that takes all three agent outputs as input and
// generates a more nuanced narrative including the past-tickets context.

import type { MemoryResult } from './memory';
import type { GuardianResult } from './guardian';
import type { ResolverResult } from './resolver';

export interface ReporterInput {
  memory: MemoryResult;
  resolver: ResolverResult;
  guardian: GuardianResult;
  /** 0-based index of the screen the screenshot came from (usually 0). */
  screenIndex: number;
}

export interface ReporterResult {
  finalUserMessage: string;
}

export async function runReporterAgent(input: ReporterInput): Promise<ReporterResult> {
  await new Promise((r) => setTimeout(r, 600));

  const { resolver, guardian, screenIndex } = input;
  const { target } = resolver;

  // Final message: root cause → action → policy reference → POINT tag.
  // The POINT tag MUST come last and must match Flicky's regex exactly:
  //   /\[POINT:(\d+),(\d+):([^:]+):screen(\d+)\]/
  // — see src/main/services/element-detector.ts.
  const finalUserMessage =
    `${resolver.rootCauseArabic}. ` +
    `اضغطي ${target.label} لحل المشكلة. ` +
    `(تمت مراجعة الإجراء — متوافق مع ${guardian.policyReference}) ` +
    `[POINT:${Math.round(target.x)},${Math.round(target.y)}:${target.label}:screen${screenIndex}]`;

  return { finalUserMessage };
}
