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
import {
  runNcaAudit,
  buildAuditReport,
  checkFileVault,
  checkScreenLock,
  checkFirewall,
  checkUpdates,
  checkPasswordPolicy,
  type AuditReport,
  type AuditCheck,
} from './nca-audit';
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

/** Open Network settings then attempt to click the "Firewall" row via UI
 * scripting. Falls through silently if the click fails (user just sees
 * the Network pane with the instruction in the chat). The "agent acts"
 * principle: don't just dump them at Settings, navigate them in. */
async function navigateToFirewallSection(): Promise<void> {
  await execAsync('open "x-apple.systempreferences:com.apple.Network-Settings.extension"');
  // Give Settings a moment to launch and render before sending UI events.
  await new Promise((r) => setTimeout(r, 1200));
  // Best-effort: look for a button or row whose name contains "Firewall"
  // and click it. macOS 14/15 System Settings uses SwiftUI so the AX
  // hierarchy is unstable across versions — wrap each access in `try`.
  const navScript = `
    tell application "System Events"
      tell process "System Settings"
        try
          set frontmost to true
          delay 0.3
          -- Try button form first (most common)
          try
            click (first button of window 1 whose name contains "Firewall")
            return "clicked-button"
          end try
          -- Fall back to row in a table/outline
          try
            click (first row of (first outline of (first scroll area of window 1)) whose name contains "Firewall")
            return "clicked-row"
          end try
        end try
      end tell
    end tell
    return "skipped"
  `;
  try {
    await execAsync(`osascript -e ${JSON.stringify(navScript)}`);
  } catch {
    // UI scripting permission not granted, or hierarchy changed — that's
    // fine, the user still sees Network with our chat instruction.
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
        await navigateToFirewallSection();
        return {
          id: 'firewall',
          titleArabic: 'جدار الحماية',
          result: 'opened_settings',
          detailsArabic:
            '👉 اتبعي الخطوات:\n   1) في System Settings → Network → Firewall\n   2) اضغطي على زر "Firewall" (toggle) لتفعيله\n   3) سيتغيّر اللون إلى أخضر = مفعَّل ✓',
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
      await navigateToFirewallSection();
      return {
        id: 'firewall',
        titleArabic: 'جدار الحماية',
        result: 'opened_settings',
        detailsArabic:
          '👉 اتبعي الخطوات:\n   1) في System Settings → Network → Firewall\n   2) اضغطي على زر "Firewall" (toggle) لتفعيله\n   3) سيتغيّر اللون إلى أخضر = مفعَّل ✓',
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
  // Modern macOS (Sonoma/Sequoia) URL — old `com.apple.preferences.softwareupdate`
  // anchor still works but the new extension URL is more reliable.
  try {
    await execAsync(
      'open "x-apple.systempreferences:com.apple.Software-Update-Settings.extension"',
    );
    return {
      id: 'os_updates',
      titleArabic: 'تحديثات النظام',
      result: 'opened_settings',
      detailsArabic:
        '👉 اتبعي الخطوات:\n   1) إذا ظهر زر "Update Now" → اضغطيه\n   2) أو اضغطي "More info..." → اختاري التحديثات → "Install Now"\n   3) أعيدي تشغيل الجهاز عند الطلب',
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

async function openPasswordSettings(): Promise<FixOutcome> {
  // Modern macOS: Touch ID & Password is the canonical pane for managing
  // the login password. Older versions used Users & Groups. Try the new
  // URL first, fall back to the older one.
  const urls = [
    'open "x-apple.systempreferences:com.apple.Touch-ID-Password-Settings.extension"',
    'open "x-apple.systempreferences:com.apple.preferences.password"',
    'open "x-apple.systempreferences:com.apple.preferences.users"',
  ];
  for (const url of urls) {
    try {
      await execAsync(url);
      return {
        id: 'password_policy',
        titleArabic: 'سياسة كلمة المرور',
        result: 'opened_settings',
        detailsArabic:
          '👉 اتبعي الخطوات:\n   1) اضغطي "Change Password..."\n   2) أدخلي كلمة سر قوية: 8+ أحرف، تتضمن أرقاماً ورموزاً\n   3) لا تستخدمي كلمة سر سابقة',
      };
    } catch {
      continue;
    }
  }
  return {
    id: 'password_policy',
    titleArabic: 'سياسة كلمة المرور',
    result: 'skipped',
    detailsArabic: 'تعذّر فتح إعدادات كلمة المرور',
  };
}

async function openFileVaultSettings(): Promise<FixOutcome> {
  try {
    await execAsync(
      'open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_FDE"',
    );
    return {
      id: 'filevault',
      titleArabic: 'تشفير القرص (FileVault)',
      result: 'opened_settings',
      detailsArabic:
        '👉 اتبعي الخطوات:\n   1) انزلي إلى قسم "Security"\n   2) اضغطي "FileVault" → "Turn On..."\n   3) ⚠️ احفظي مفتاح الاسترجاع (Recovery Key) في مكان آمن قبل التأكيد',
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

const STEP_PAUSE_MS = 150; // human-readable pacing between updates
// When we open a Settings pane, the user has to actually click something
// (toggle Firewall, click Update Now, etc). The panel must keep narrating
// long enough for the user to read AND act, otherwise the panel goes
// silent and they don't know what to do.
const POST_OPEN_SETTINGS_MS = 8000;
const POST_FIX_NARRATION_MS = 1200; // pause after a successful auto-fix

async function pause(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export type SayCallback = (chunk: string) => void;

export async function runNcaAuditAndFix(
  onStep?: StepCallback,
  onSay?: SayCallback,
): Promise<AuditAndFixReport> {
  // Phase 1: SEQUENTIAL audit with verbose narration. Each check is run
  // one at a time so the user can see the agent working through each
  // requirement individually — not a black-box "5/5" summary. The
  // commands and ncaRefs are spoken aloud so it's clear the system is
  // really inspecting macOS state, not playing back a memorized result.
  const stages: Array<{
    label: string;
    ref: string;
    cmd: string;
    fn: () => Promise<AuditCheck>;
  }> = [
    {
      label: 'تشفير القرص (FileVault)',
      ref: 'NCA-ECC-2-T4-1',
      cmd: 'fdesetup status',
      fn: checkFileVault,
    },
    {
      label: 'قفل الشاشة التلقائي',
      ref: 'NCA-ECC-2-T2-3',
      cmd: 'defaults read com.apple.screensaver askForPassword',
      fn: checkScreenLock,
    },
    {
      label: 'جدار الحماية (Firewall)',
      ref: 'NCA-ECC-2-T5-1',
      cmd: 'defaults read /Library/Preferences/com.apple.alf globalstate',
      fn: checkFirewall,
    },
    {
      label: 'تحديثات نظام التشغيل',
      ref: 'NCA-ECC-2-T6-2',
      cmd: 'defaults read /Library/Preferences/com.apple.SoftwareUpdate LastSuccessfulDate',
      fn: checkUpdates,
    },
    {
      label: 'سياسة كلمة المرور',
      ref: 'NCA-ECC-2-T2-1',
      cmd: 'dscl . -read /Users/$(whoami) Password',
      fn: checkPasswordPolicy,
    },
  ];

  if (onStep) {
    await onStep('🔍 المرحلة 1: فحص الأمان — 5 ضوابط NCA-ECC');
    await pause(900);
  }
  if (onSay) {
    onSay('بدأتُ الفحص — أتحقّق من خمسة ضوابط NCA-ECC أساسية، واحداً تلو الآخر:\n\n');
  }

  const checkResults: AuditCheck[] = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const stepHeader = `الفحص ${i + 1}/5`;
    if (onStep) {
      await onStep(`🔎 ${stepHeader}: ${stage.label}`);
      await pause(700);
      await onStep(`   $ ${stage.cmd}`);
      await pause(900);
    }
    // Actually run the underlying check
    const result = await stage.fn();
    const icon = result.status === 'pass' ? '✅'
      : result.status === 'fail' ? '❌' : '⚠️';
    if (onStep) {
      await onStep(`   ${icon} ${result.detailsArabic} (${stage.ref})`);
      await pause(800);
    }
    if (onSay) {
      onSay(`  ${icon} **${stage.label}** — ${result.detailsArabic}\n`);
    }
    checkResults.push(result);
  }

  const beforeReport = buildAuditReport(checkResults);
  if (onStep) {
    await pause(500);
    await onStep(
      `📊 النتيجة الأولية: ${beforeReport.passCount}/${beforeReport.totalChecks} مطابق`,
    );
    await pause(700);
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
  // Build a list of just the failing checks so we can announce
  // "Step N of M" — much clearer than silent loop iteration.
  const toFix = beforeReport.checks.filter((c) => c.status !== 'pass');

  for (let i = 0; i < toFix.length; i++) {
    const check = toFix[i];
    let outcome: FixOutcome;
    const stepHeader = `الخطوة ${i + 1} من ${toFix.length}`;

    // Narrate what's about to happen so the user isn't surprised by
    // password dialogs / window pop-ups. Multi-line, paced narration so
    // the panel keeps speaking instead of going silent and the user
    // always knows what's expected of them.
    if (onStep) {
      const beforeMsg: Record<string, { lines: string[]; finalPause: number }> = {
        screen_lock: {
          lines: [
            `🔧 ${stepHeader}: قفل الشاشة الفوري`,
            'لا يحتاج تدخّلك — أفعّله تلقائياً عبر defaults write',
          ],
          finalPause: 600,
        },
        firewall: {
          lines: [
            `🔧 ${stepHeader}: تفعيل جدار الحماية (NCA-ECC-2-T5-1)`,
            'سأطلب صلاحية المسؤول لتفعيله — مرّة واحدة فقط',
            '⏳ سيظهر مربّع تأكيد بعد ثوانٍ — اضغطي "تفعيل"',
          ],
          finalPause: 800,
        },
        os_updates: {
          lines: [
            `🔧 ${stepHeader}: تحديثات النظام`,
            'سأفتح Software Update لكِ — انتظري قليلاً',
          ],
          finalPause: 1200,
        },
        filevault: {
          lines: [
            `⚠️ ${stepHeader}: مراجعة FileVault`,
            'لن يُفعَّل تلقائياً — خطر فقد البيانات إن لم تُحفظ مفاتيح الاسترجاع',
            'سأفتح الإعدادات للمراجعة فقط',
          ],
          finalPause: 1200,
        },
        password_policy: {
          lines: [
            `🔧 ${stepHeader}: سياسة كلمة المرور`,
            'سأفتح Touch ID & Password لتحديث كلمة سر قويّة',
            'كلمة السر الجديدة: 8+ أحرف، أرقام، رموز',
          ],
          finalPause: 1200,
        },
      };
      const msg = beforeMsg[check.id];
      if (msg) {
        for (const line of msg.lines) {
          await onStep(line);
          await pause(700); // slow enough to actually read
        }
        await pause(msg.finalPause);
      }
    }

    // Conversational announcement of which fix is starting — appears in
    // the IT Assistant chat alongside the technical narration in the
    // agents panel. Each line includes WHERE it will open and (when
    // relevant) what to click, so the user isn't dropped into Settings
    // without context.
    if (onSay) {
      const sayBefore: Record<string, string> = {
        screen_lock: `🔧 **قفل الشاشة الفوري** — أفعّله الآن تلقائياً (لا تدخّل منكِ).\n`,
        firewall: `🔧 **جدار الحماية (NCA-ECC-2-T5-1)** — سيظهر مربّع تأكيد، اضغطي "تفعيل" ثم أدخلي كلمة السر مرّة واحدة.\n`,
        os_updates:
          `🔧 **تحديثات النظام** — سأفتح Software Update.\n  ▸ خطوة 1: اضغطي "Update Now" إذا ظهر\n  ▸ خطوة 2: أو "More info..." → اختاري التحديثات → "Install Now"\n`,
        filevault:
          `🔧 **تشفير القرص (FileVault)** — سأفتح Privacy & Security.\n  ⚠️ احفظي مفتاح الاسترجاع قبل التفعيل (خطر فقد البيانات).\n  ▸ خطوة 1: انزلي إلى قسم Security\n  ▸ خطوة 2: اضغطي FileVault → Turn On\n`,
        password_policy:
          `🔧 **سياسة كلمة المرور (NCA-ECC-2-T2-1)** — سأفتح Touch ID & Password.\n  ▸ خطوة 1: اضغطي "Change Password..."\n  ▸ خطوة 2: كلمة سر قوية: 8+ أحرف، أرقام، رموز\n`,
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
      case 'password_policy':
        outcome = await openPasswordSettings();
        break;
      default:
        continue;
    }
    fixes.push(outcome);

    // Narrate the result on the agent panel. For instant fixes show
    // the success line briefly. For opened_settings, ROTATE through a
    // sequence of nudges so the panel keeps talking while the user
    // actually performs the click — the panel never goes silent and
    // the instructions stay on screen for the full POST_OPEN_SETTINGS_MS.
    const isLastFix = i === toFix.length - 1;
    if (onStep) {
      const icon =
        outcome.result === 'fixed' ? '✅' :
        outcome.result === 'opened_settings' ? '⚙️' : '⚠️';

      if (outcome.result === 'fixed') {
        await onStep(`${icon} ${outcome.titleArabic}: ${outcome.detailsArabic}`);
        await pause(POST_FIX_NARRATION_MS);
        if (!isLastFix) {
          await onStep(`✓ تم. ننتقل للخطوة التالية...`);
          await pause(700);
        }
      } else if (outcome.result === 'opened_settings') {
        // Cycle through several nudge messages so the panel doesn't go
        // silent while the user is acting in System Settings. Total time
        // is POST_OPEN_SETTINGS_MS (8 s).
        const nudges: Record<string, string[]> = {
          firewall: [
            `${icon} ${outcome.titleArabic}: ${outcome.detailsArabic}`,
            '👉 اضغطي على زر Firewall toggle لتفعيله',
            '⏳ بانتظارك... خذي وقتك في تفعيل جدار الحماية',
            'سيتغيّر اللون إلى أخضر = مفعَّل ✓',
          ],
          os_updates: [
            `${icon} ${outcome.titleArabic}: ${outcome.detailsArabic}`,
            '👉 اضغطي "Update Now" أو "More info..." لرؤية التحديثات',
            '⏳ بانتظارك... راجعي التحديثات وابدئي التثبيت',
            'يمكنك إكمال التثبيت لاحقاً — سأنتقل لو وافقتِ',
          ],
          filevault: [
            `${icon} ${outcome.titleArabic}: ${outcome.detailsArabic}`,
            '⚠️ FileVault خطير — لا تفعّليه قبل حفظ مفتاح الاسترجاع',
            '👉 راجعي الإعدادات فقط لهذه الخطوة',
            'هذه خطوة اختيارية تتطلب قرارك',
          ],
          password_policy: [
            `${icon} ${outcome.titleArabic}: ${outcome.detailsArabic}`,
            '👉 اضغطي "Change Password..." لتحديث كلمة السر',
            '⏳ بانتظارك... كلمة سر قوية: 8+ أحرف + أرقام + رموز',
            'لا تستخدمي كلمة سر سبق استخدامها',
          ],
        };
        const seq = nudges[check.id] ?? [`${icon} ${outcome.titleArabic}: ${outcome.detailsArabic}`];
        const stepInterval = Math.max(800, Math.floor(POST_OPEN_SETTINGS_MS / seq.length));
        for (const nudge of seq) {
          await onStep(nudge);
          await pause(stepInterval);
        }
        if (!isLastFix) {
          await onStep('✓ تم. ننتقل للخطوة التالية...');
          await pause(700);
        }
      } else {
        // skipped
        await onStep(`${icon} ${outcome.titleArabic}: ${outcome.detailsArabic}`);
        await pause(POST_FIX_NARRATION_MS);
      }
    }

    // Conversational outcome line for the chat. For "fixed" we add a
    // chatty bridge to the next step. For "opened_settings" we say what
    // the user should be doing in their newly-opened window.
    if (onSay) {
      const icon =
        outcome.result === 'fixed' ? '✅' :
        outcome.result === 'opened_settings' ? '⚙️' : '⚠️';
      onSay(`  ${icon} ${outcome.detailsArabic}\n`);
      if (outcome.result === 'fixed' && !isLastFix) {
        onSay(`  ▸ ممتاز! ننتقل الآن للخطوة التالية...\n\n`);
      } else if (outcome.result === 'opened_settings' && !isLastFix) {
        onSay(`  ▸ خذي وقتك في إنجاز هذه الخطوة، ثم سأنتقل للتالية...\n\n`);
      } else {
        onSay('\n');
      }
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
