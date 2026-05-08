// NCA-ECC Auto-Fixers — agent attempts to remediate failed audit checks.
//
// Risk classification:
//   AUTO   = safe to fix without user intervention (no sudo, reversible)
//   PROMPT = requires admin password OR user confirmation; we OPEN the
//            relevant Settings pane and let the user click through
//   WARN   = high-risk to auto-enable (e.g. FileVault data loss); we
//            never touch — only display guidance + open Settings
//
// The two-phase pattern (audit → fix → re-audit) is what makes this
// agentic: the agent observes state, takes corrective actions, then
// verifies the result.

import { exec } from 'child_process';
import { promisify } from 'util';
import { runNcaAudit, type AuditReport } from './nca-audit';
const execAsync = promisify(exec);

export type FixOutcome =
  | { id: string; titleArabic: string; result: 'fixed'; detailsArabic: string }
  | { id: string; titleArabic: string; result: 'opened_settings'; detailsArabic: string }
  | { id: string; titleArabic: string; result: 'skipped'; detailsArabic: string };

export interface AuditAndFixReport {
  beforeReport: AuditReport;
  fixes: FixOutcome[];
  afterReport: AuditReport;
  summaryArabic: string;
}

// ── Individual fixers ──────────────────────────────────────────────────

async function fixScreenLock(): Promise<FixOutcome> {
  try {
    await execAsync('defaults write com.apple.screensaver askForPassword -bool true');
    await execAsync('defaults write com.apple.screensaver askForPasswordDelay -int 0');
    return {
      id: 'screen_lock',
      titleArabic: 'قفل الشاشة',
      result: 'fixed',
      detailsArabic: 'تم تفعيل طلب كلمة السر فوراً عند إيقاظ الشاشة',
    };
  } catch (err) {
    return {
      id: 'screen_lock',
      titleArabic: 'قفل الشاشة',
      result: 'skipped',
      detailsArabic: `تعذّر التفعيل: ${err instanceof Error ? err.message.slice(0, 80) : 'خطأ'}`,
    };
  }
}

async function openFirewallSettings(): Promise<FixOutcome> {
  try {
    // Opens System Settings → Network → Firewall on Sonoma+
    // (older macOS: opens Security & Privacy → Firewall pane)
    await execAsync('open "x-apple.systempreferences:com.apple.preference.security?Firewall"');
    return {
      id: 'firewall',
      titleArabic: 'جدار الحماية',
      result: 'opened_settings',
      detailsArabic: 'فتحت إعدادات جدار الحماية — اضغطي "تشغيل" لتفعيله (يحتاج كلمة سر المسؤول)',
    };
  } catch {
    return {
      id: 'firewall',
      titleArabic: 'جدار الحماية',
      result: 'skipped',
      detailsArabic: 'تعذّر فتح إعدادات جدار الحماية',
    };
  }
}

async function openSoftwareUpdate(): Promise<FixOutcome> {
  try {
    await execAsync('open "x-apple.systempreferences:com.apple.preferences.softwareupdate"');
    return {
      id: 'os_updates',
      titleArabic: 'تحديثات النظام',
      result: 'opened_settings',
      detailsArabic: 'فتحت Software Update — راجعي التحديثات المتوفرة وثبّتيها لاحقاً',
    };
  } catch {
    return {
      id: 'os_updates',
      titleArabic: 'تحديثات النظام',
      result: 'skipped',
      detailsArabic: 'تعذّر فتح Software Update',
    };
  }
}

async function openFileVaultSettings(): Promise<FixOutcome> {
  try {
    await execAsync('open "x-apple.systempreferences:com.apple.preference.security?FDE"');
    return {
      id: 'filevault',
      titleArabic: 'تشفير القرص (FileVault)',
      result: 'opened_settings',
      detailsArabic:
        '⚠️ FileVault تفعيله يتطلب احتفاظك بمفتاح الاستعادة — لن أفعّله تلقائياً. فتحت لكِ الإعدادات لتراجعيها بنفسك.',
    };
  } catch {
    return {
      id: 'filevault',
      titleArabic: 'تشفير القرص',
      result: 'skipped',
      detailsArabic: 'تعذّر فتح إعدادات FileVault',
    };
  }
}

// ── Main entry point ──────────────────────────────────────────────────

/**
 * Optional per-step callback so the agent panel can display each check
 * and fix as it happens — turning the otherwise-instant 3-second audit
 * into a visible, narrated 12-15 second demo.
 */
export type StepCallback = (text: string) => Promise<void> | void;

const STEP_PAUSE_MS = 700; // human-readable pacing between updates

async function pause(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function runNcaAuditAndFix(onStep?: StepCallback): Promise<AuditAndFixReport> {
  // Phase 1: audit (announce each check as it runs)
  if (onStep) {
    await onStep('بدء التدقيق الأمني وفق NCA-ECC...');
    await pause(STEP_PAUSE_MS);
  }
  const beforeReport = await runNcaAudit();
  if (onStep) {
    for (const c of beforeReport.checks) {
      const icon = c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⚠️';
      await onStep(`${icon} ${c.titleArabic} (${c.ncaRef})`);
      await pause(STEP_PAUSE_MS);
    }
    await onStep(`النتيجة قبل المعالجة: ${beforeReport.passCount}/${beforeReport.totalChecks}`);
    await pause(STEP_PAUSE_MS);
  }

  // Phase 2: apply remediations
  const fixes: FixOutcome[] = [];
  if (onStep && beforeReport.failCount + beforeReport.warnCount > 0) {
    await onStep('بدء المعالجة التلقائية للعناصر الآمنة...');
    await pause(STEP_PAUSE_MS);
  }
  for (const check of beforeReport.checks) {
    if (check.status === 'pass') continue;
    let outcome: FixOutcome;
    switch (check.id) {
      case 'screen_lock':
        outcome = await fixScreenLock();
        break;
      case 'firewall':
        outcome = await openFirewallSettings();
        break;
      case 'os_updates':
        outcome = await openSoftwareUpdate();
        break;
      case 'filevault':
        outcome = await openFileVaultSettings();
        break;
      default:
        continue;
    }
    fixes.push(outcome);
    if (onStep) {
      const icon = outcome.result === 'fixed' ? '✅' : outcome.result === 'opened_settings' ? '⚙️' : '⚠️';
      await onStep(`${icon} ${outcome.titleArabic}: ${outcome.detailsArabic}`);
      await pause(STEP_PAUSE_MS);
    }
  }

  // Small pause to let `defaults write` propagate before re-checking
  await pause(800);

  // Phase 3: re-audit
  if (onStep) {
    await onStep('إعادة التدقيق للتحقق من النتائج...');
    await pause(STEP_PAUSE_MS);
  }
  const afterReport = await runNcaAudit();

  // Build a bilingual summary of what changed
  const lines: string[] = [];
  lines.push('═══ تدقيق NCA-ECC مع المعالجة التلقائية ═══');
  lines.push('');
  lines.push(`النتيجة قبل المعالجة: ${beforeReport.passCount}/${beforeReport.totalChecks}`);
  lines.push('');
  lines.push('الإجراءات التي اتخذها الوكيل:');
  if (fixes.length === 0) {
    lines.push('  لا توجد مشاكل تتطلب معالجة 🎉');
  } else {
    for (const f of fixes) {
      const icon =
        f.result === 'fixed' ? '✅' : f.result === 'opened_settings' ? '⚙️' : '⚠️';
      lines.push(`  ${icon} ${f.titleArabic}`);
      lines.push(`     ${f.detailsArabic}`);
    }
  }
  lines.push('');
  lines.push(`النتيجة بعد المعالجة: ${afterReport.passCount}/${afterReport.totalChecks}`);
  const improvement = afterReport.passCount - beforeReport.passCount;
  if (improvement > 0) {
    lines.push(`📈 تحسّنت بمقدار ${improvement} نقطة`);
  } else if (afterReport.failCount > 0) {
    const remaining = afterReport.failCount + afterReport.warnCount;
    lines.push(
      `⚠️ تبقّى ${remaining} عنصر يتطلّب تدخّلك (فُتحت لكِ الإعدادات اللازمة)`,
    );
  }
  const summaryArabic = lines.join('\n');

  return { beforeReport, fixes, afterReport, summaryArabic };
}
