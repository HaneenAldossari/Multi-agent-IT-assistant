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

// Lazy-load Electron's `dialog` so unit tests / standalone scripts can
// import this module without an Electron context. Returns null when not
// running inside Electron (the caller falls back to the no-confirm path).
type ShowMessageBoxOptions = Electron.MessageBoxOptions;
type ShowMessageBoxReturn = Electron.MessageBoxReturnValue;
function tryGetDialog():
  | { showMessageBox: (opts: ShowMessageBoxOptions) => Promise<ShowMessageBoxReturn> }
  | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    return electron?.dialog ?? null;
  } catch {
    return null;
  }
}

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
  // We gate the privileged osascript behind an Electron confirmation
  // dialog so the user always sees an explanation BEFORE the macOS
  // password prompt steals focus. Without this gate the system password
  // dialog appears asynchronously the moment osascript runs and the
  // panel's heads-up text never has a chance to render.
  const dialog = tryGetDialog();
  if (dialog) {
    const confirm = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['تفعيل (سيُطلب كلمة السر)', 'تخطّي'],
      defaultId: 0,
      cancelId: 1,
      title: 'تفعيل جدار الحماية — NCA-ECC-2-T5-1',
      message: 'يحتاج وكيل الأمان إلى تفعيل جدار الحماية',
      detail:
        'بعد الضغط على "تفعيل" سيظهر طلب كلمة سر المسؤول من macOS مرّة واحدة فقط لتشغيل جدار الحماية وفق ضابط NCA-ECC-2-T5-1.\n\nاضغطي "تخطّي" لفتح إعدادات الأمان يدوياً بدلاً من ذلك.',
    });
    if (confirm.response !== 0) {
      // User chose to skip — open Settings so they can review manually.
      try {
        await execAsync('open "x-apple.systempreferences:com.apple.preference.security?Firewall"');
        return {
          id: 'firewall',
          titleArabic: 'جدار الحماية',
          result: 'opened_settings',
          detailsArabic: 'تخطّيتِ التفعيل التلقائي — فتحت لكِ إعدادات جدار الحماية',
        };
      } catch {
        return {
          id: 'firewall',
          titleArabic: 'جدار الحماية',
          result: 'skipped',
          detailsArabic: 'تخطّيتِ التفعيل التلقائي',
        };
      }
    }
  }

  // User confirmed (or no Electron context — e.g. standalone test).
  try {
    await execAsync(
      `osascript -e 'do shell script "/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on" with administrator privileges with prompt "تفعيل جدار الحماية (NCA-ECC-2-T5-1)"'`,
    );
    return {
      id: 'firewall',
      titleArabic: 'جدار الحماية',
      result: 'fixed',
      detailsArabic: 'تم تفعيل جدار الحماية بنجاح',
    };
  } catch {
    // osascript errored (user cancelled the password dialog, or admin
    // command unavailable) — open the Settings pane as a fallback.
    try {
      await execAsync('open "x-apple.systempreferences:com.apple.preference.security?Firewall"');
      return {
        id: 'firewall',
        titleArabic: 'جدار الحماية',
        result: 'opened_settings',
        detailsArabic: 'لم يتم التفعيل — فتحت لكِ الإعدادات لإكمالها يدوياً',
      };
    } catch {
      return {
        id: 'firewall',
        titleArabic: 'جدار الحماية',
        result: 'skipped',
        detailsArabic: 'تعذّر تفعيل جدار الحماية تلقائياً',
      };
    }
  }
}

async function openSoftwareUpdate(): Promise<FixOutcome> {
  try {
    await execAsync('open "x-apple.systempreferences:com.apple.preferences.softwareupdate"');
    return {
      id: 'os_updates',
      titleArabic: 'تحديثات النظام',
      result: 'opened_settings',
      detailsArabic:
        'افتحت Software Update — اضغطي زر "Update Now" أو "Install" لكل تحديث متوفّر',
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
        'افتحت إعدادات FileVault — راجعي الإعدادات لكن لا تضغطي "Turn On" قبل حفظ مفتاح الاسترجاع في مكان آمن',
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

const STEP_PAUSE_MS = 250; // human-readable pacing between updates
const POST_OPEN_SETTINGS_MS = 2500; // extra pause after opening a Settings pane so user can read the instruction

async function pause(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export type SayCallback = (chunk: string) => void;

export async function runNcaAuditAndFix(
  onStep?: StepCallback,
  onSay?: SayCallback,
): Promise<AuditAndFixReport> {
  // Phase 1: audit (announce each check as it runs)
  if (onStep) {
    await onStep('🔍 المرحلة 1: فحص الأمان (5 ضوابط NCA-ECC)');
    await pause(STEP_PAUSE_MS);
  }
  const beforeReport = await runNcaAudit();
  if (onStep) {
    for (const c of beforeReport.checks) {
      const icon = c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⚠️';
      await onStep(`${icon} ${c.titleArabic} (${c.ncaRef})`);
      await pause(STEP_PAUSE_MS);
    }
    await onStep(`📊 النتيجة الأولية: ${beforeReport.passCount}/${beforeReport.totalChecks}`);
    await pause(STEP_PAUSE_MS);
  }

  // Phase 2: apply remediations
  const fixes: FixOutcome[] = [];
  const issuesCount = beforeReport.failCount + beforeReport.warnCount;

  // Conversational summary of what we found, before we start fixing.
  if (onSay) {
    if (issuesCount === 0) {
      onSay(`الفحص اكتمل: ${beforeReport.passCount}/${beforeReport.totalChecks} ✅ — جهازك مطابق بالكامل.\n\n`);
    } else {
      onSay(
        `انتهيتُ من الفحص: ${beforeReport.passCount}/${beforeReport.totalChecks}. وجدتُ ${issuesCount} ${issuesCount === 1 ? 'مشكلة' : 'مشاكل'} — سأبدأ المعالجة:\n\n`,
      );
    }
  }

  if (onStep && issuesCount > 0) {
    await onStep(`🔧 المرحلة 2: معالجة ${issuesCount} مشكلة`);
    await pause(STEP_PAUSE_MS);
  }
  for (const check of beforeReport.checks) {
    if (check.status === 'pass') continue;
    let outcome: FixOutcome;

    // Narrate what's about to happen so the user isn't surprised by
    // password dialogs / window pop-ups. Some actions (firewall) trigger
    // a blocking system dialog the moment we call them, so we use longer
    // pauses on those to give the user time to read.
    if (onStep) {
      const beforeMsg: Record<string, { lines: string[]; pause: number }> = {
        screen_lock: {
          lines: ['🔧 الخطوة التالية: تفعيل قفل الشاشة الفوري'],
          pause: STEP_PAUSE_MS,
        },
        firewall: {
          lines: [
            '🔧 الخطوة التالية: تفعيل جدار الحماية (NCA-ECC-2-T5-1)',
            '⏳ سيظهر مربّع تأكيد — اضغطي "تفعيل" ثم أدخلي كلمة السر',
          ],
          // Short pause — the Electron confirmation dialog is the
          // actual gate, so we don't need a long pre-pause here.
          pause: 600,
        },
        os_updates: {
          lines: [
            '🔧 الخطوة التالية: فتح Software Update',
            'سأفتح لكِ النافذة لتراجعي التحديثات المتوفرة وتثبّتيها',
          ],
          pause: 1500,
        },
        filevault: {
          lines: [
            '⚠️ الخطوة التالية: مراجعة FileVault',
            'لن يُفعَّل تلقائياً (خطر فقد البيانات إن لم تُحفظ مفاتيح الاسترجاع)',
          ],
          pause: 1500,
        },
      };
      const msg = beforeMsg[check.id];
      if (msg) {
        for (const line of msg.lines) {
          await onStep(line);
          await pause(STEP_PAUSE_MS);
        }
        await pause(msg.pause);
      }
    }

    // Conversational announcement of which fix is starting — appears in
    // the IT Assistant chat alongside the technical narration in the
    // agents panel.
    if (onSay) {
      const sayBefore: Record<string, string> = {
        screen_lock: `• قفل الشاشة الفوري — أفعّله الآن.\n`,
        firewall: `• جدار الحماية — سيظهر مربّع تأكيد ثم طلب كلمة سر المسؤول.\n`,
        os_updates: `• تحديثات النظام — سأفتح Software Update لكِ.\n`,
        filevault: `• تشفير القرص (FileVault) — سأفتح الإعدادات للمراجعة فقط (لن يُفعَّل تلقائياً).\n`,
      };
      const text = sayBefore[check.id];
      if (text) onSay(text);
    }

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

    // Narrate the result. When we open a Settings pane the user actually
    // needs time to look at it, so use a longer pause for that case so
    // the instruction text doesn't get overwritten by the next step.
    if (onStep) {
      const icon = outcome.result === 'fixed' ? '✅' : outcome.result === 'opened_settings' ? '⚙️' : '⚠️';
      await onStep(`${icon} ${outcome.titleArabic}: ${outcome.detailsArabic}`);
      await pause(outcome.result === 'opened_settings' ? POST_OPEN_SETTINGS_MS : STEP_PAUSE_MS);
    }

    // Conversational outcome line for the chat — same content the user
    // sees in the panel but rendered as a normal sentence so the chat
    // reads like a real assistant.
    if (onSay) {
      const icon =
        outcome.result === 'fixed' ? '✅' : outcome.result === 'opened_settings' ? '⚙️' : '⚠️';
      onSay(`  ${icon} ${outcome.detailsArabic}\n\n`);
    }
  }

  // Small pause to let `defaults write` propagate before re-checking
  await pause(400);

  // Phase 3: re-audit
  if (onStep) {
    await onStep('🔁 المرحلة 3: إعادة الفحص للتحقق');
    await pause(STEP_PAUSE_MS);
  }
  const afterReport = await runNcaAudit();
  if (onStep) {
    await onStep(`📊 النتيجة النهائية: ${afterReport.passCount}/${afterReport.totalChecks}`);
    await pause(STEP_PAUSE_MS);
  }

  // Build a bilingual summary of what changed
  const lines: string[] = [];
  lines.push('═══ فحص الأمان مع الإصلاح التلقائي ═══');
  lines.push('');
  lines.push(`النتيجة قبل الإصلاح: ${beforeReport.passCount}/${beforeReport.totalChecks}`);
  lines.push('');
  lines.push('ما قام به الوكيل:');
  if (fixes.length === 0) {
    lines.push('  لا توجد مشاكل تحتاج إصلاح 🎉');
  } else {
    for (const f of fixes) {
      const icon =
        f.result === 'fixed' ? '✅' : f.result === 'opened_settings' ? '⚙️' : '⚠️';
      lines.push(`  ${icon} ${f.titleArabic}`);
      lines.push(`     ${f.detailsArabic}`);
    }
  }
  lines.push('');
  lines.push(`النتيجة بعد الإصلاح: ${afterReport.passCount}/${afterReport.totalChecks}`);
  const improvement = afterReport.passCount - beforeReport.passCount;
  if (improvement > 0) {
    lines.push(`📈 تحسّن بمقدار ${improvement} نقطة`);
  } else if (afterReport.failCount > 0) {
    const remaining = afterReport.failCount + afterReport.warnCount;
    lines.push(
      `⚠️ بقي ${remaining} عنصر يحتاج تدخّلك (فُتحت لكِ الإعدادات اللازمة)`,
    );
  }
  const summaryArabic = lines.join('\n');

  return { beforeReport, fixes, afterReport, summaryArabic };
}
