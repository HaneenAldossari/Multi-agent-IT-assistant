// NCA Security Check — runs five real checks against the macOS
// device and reports whether each meets Saudi NCA Essential
// Cybersecurity Controls (ECC). Produces a bilingual Arabic+English
// summary suitable for showing to the user.
//
// Each check is a single shell command. Total runtime: ~3-5 seconds.

import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

export interface AuditCheck {
  id: string;
  ncaRef: string;
  titleArabic: string;
  status: 'pass' | 'fail' | 'warn' | 'unknown';
  detailsArabic: string;
  detailsEnglish: string;
}

export interface AuditReport {
  passCount: number;
  failCount: number;
  warnCount: number;
  totalChecks: number;
  checks: AuditCheck[];
  /** Bilingual ready-to-display summary */
  summaryArabic: string;
  summaryEnglish: string;
  /** Overall verdict for the device */
  overallStatus: 'compliant' | 'partial' | 'non_compliant';
}

// ── Individual checks ──────────────────────────────────────────────────

export async function checkFileVault(): Promise<AuditCheck> {
  try {
    const { stdout } = await execAsync('fdesetup status');
    const isOn = /FileVault is On/i.test(stdout);
    return {
      id: 'filevault',
      ncaRef: 'NCA-ECC-2-T4-1',
      titleArabic: 'تشفير القرص (FileVault)',
      status: isOn ? 'pass' : 'fail',
      detailsArabic: isOn
        ? 'تشفير القرص مُفعّل — بياناتك محمية لو فُقد الجهاز'
        : 'تشفير القرص مُعطّل — يحتاج تفعيل من إعدادات النظام',
      detailsEnglish: isOn ? 'FileVault is enabled' : 'FileVault is disabled',
    };
  } catch {
    return unknownCheck('filevault', 'NCA-ECC-2-T4-1', 'تشفير القرص (FileVault)');
  }
}

export async function checkScreenLock(): Promise<AuditCheck> {
  try {
    const { stdout: askForPwd } = await execAsync(
      'defaults read com.apple.screensaver askForPassword 2>/dev/null || echo 0',
    );
    const requiresPassword = askForPwd.trim() === '1';
    return {
      id: 'screen_lock',
      ncaRef: 'NCA-ECC-2-T2-3',
      titleArabic: 'قفل الشاشة التلقائي',
      status: requiresPassword ? 'pass' : 'fail',
      detailsArabic: requiresPassword
        ? 'يُطلب كلمة السر عند العودة من الشاشة المؤمَّنة — مطابق لمعايير NCA'
        : 'لا يُطلب كلمة سر عند العودة من الشاشة المؤمَّنة — يحتاج تفعيل',
      detailsEnglish: requiresPassword
        ? 'Password required after screen lock'
        : 'No password required after screen lock — must be enabled',
    };
  } catch {
    return unknownCheck('screen_lock', 'NCA-ECC-2-T2-3', 'قفل الشاشة التلقائي');
  }
}

export async function checkFirewall(): Promise<AuditCheck> {
  try {
    const { stdout } = await execAsync(
      'defaults read /Library/Preferences/com.apple.alf globalstate 2>/dev/null || echo 0',
    );
    const state = parseInt(stdout.trim(), 10);
    // 0 = off, 1 = on (for specific services), 2 = block all
    const isOn = state >= 1;
    return {
      id: 'firewall',
      ncaRef: 'NCA-ECC-2-T5-1',
      titleArabic: 'جدار الحماية (Firewall)',
      status: isOn ? 'pass' : 'fail',
      detailsArabic: isOn
        ? `جدار الحماية مُفعّل (المستوى ${state}) — يحجب الاتصالات غير المصرّح بها`
        : 'جدار الحماية مُعطّل — يحتاج تفعيل من إعدادات الشبكة',
      detailsEnglish: isOn ? `Firewall ON (level ${state})` : 'Firewall OFF',
    };
  } catch {
    return unknownCheck('firewall', 'NCA-ECC-2-T5-1', 'جدار الحماية');
  }
}

export async function checkUpdates(): Promise<AuditCheck> {
  // Use last-successful-update date instead of `softwareupdate --list`.
  // The latter contacts Apple's servers (~30s); the former is a local
  // plist read (~50ms). For NCA compliance we only need to know that
  // updates are being applied regularly — past 30 days = compliant.
  try {
    const { stdout } = await execAsync(
      'defaults read /Library/Preferences/com.apple.SoftwareUpdate LastSuccessfulDate 2>/dev/null',
    );
    const lastUpdate = new Date(stdout.trim());
    if (Number.isNaN(lastUpdate.getTime())) {
      return {
        id: 'os_updates',
        ncaRef: 'NCA-ECC-2-T6-2',
        titleArabic: 'تحديثات نظام التشغيل',
        status: 'warn',
        detailsArabic: 'تعذّر التحقق من تاريخ آخر تحديث',
        detailsEnglish: 'Could not parse last update date',
      };
    }
    const daysSince = Math.floor((Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24));
    const isRecent = daysSince <= 30;
    return {
      id: 'os_updates',
      ncaRef: 'NCA-ECC-2-T6-2',
      titleArabic: 'تحديثات نظام التشغيل',
      status: isRecent ? 'pass' : 'warn',
      detailsArabic: isRecent
        ? `آخر تحديث قبل ${daysSince} يوم — ضمن النطاق المقبول (≤30 يوم)`
        : `آخر تحديث قبل ${daysSince} يوم — تحتاجين تطبيق التحديثات الأمنية`,
      detailsEnglish: isRecent
        ? `Last update ${daysSince}d ago (within policy)`
        : `Last update ${daysSince}d ago — needs updates`,
    };
  } catch {
    return unknownCheck('os_updates', 'NCA-ECC-2-T6-2', 'تحديثات النظام');
  }
}

export async function checkPasswordPolicy(): Promise<AuditCheck> {
  // Check if a login password is required at all (most basic policy check)
  // Full pwpolicy requires admin and varies — we keep this simple and reliable.
  try {
    const { stdout } = await execAsync('dscl . -read /Users/$(whoami) Password 2>/dev/null || echo unknown');
    // If user has a password hash entry, password is set
    const hasPassword = stdout.includes('Password:') && !stdout.includes('Password: \n');
    return {
      id: 'password_policy',
      ncaRef: 'NCA-ECC-2-T2-1',
      titleArabic: 'سياسة كلمة المرور',
      status: hasPassword ? 'pass' : 'warn',
      detailsArabic: hasPassword
        ? 'حساب المستخدم محمي بكلمة سر'
        : 'تعذّر التحقق من سياسة كلمة المرور',
      detailsEnglish: hasPassword
        ? 'User account password-protected'
        : 'Could not verify password policy',
    };
  } catch {
    return unknownCheck('password_policy', 'NCA-ECC-2-T2-1', 'سياسة كلمة المرور');
  }
}

function unknownCheck(id: string, ref: string, title: string): AuditCheck {
  return {
    id,
    ncaRef: ref,
    titleArabic: title,
    status: 'unknown',
    detailsArabic: 'تعذّر التحقق',
    detailsEnglish: 'Could not verify',
  };
}

// ── Public entry point ────────────────────────────────────────────────

/** Build a full AuditReport from a list of pre-run checks. Exposed so
 * callers (like the verbose narrated audit in nca-fix.ts) can run the
 * checks sequentially with their own pacing and still produce the same
 * report shape. */
export function buildAuditReport(checks: AuditCheck[]): AuditReport {
  const passCount = checks.filter((c) => c.status === 'pass').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn' || c.status === 'unknown').length;

  let overallStatus: 'compliant' | 'partial' | 'non_compliant';
  if (failCount === 0 && warnCount === 0) overallStatus = 'compliant';
  else if (failCount === 0) overallStatus = 'partial';
  else overallStatus = 'non_compliant';

  // Build the bilingual summary
  const lines: string[] = [];
  lines.push('═══ تقرير فحص الأمان (وفق معايير NCA) ═══');
  lines.push('');
  for (const c of checks) {
    const icon = c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⚠️';
    lines.push(`${icon} ${c.titleArabic} (${c.ncaRef})`);
    lines.push(`   ${c.detailsArabic}`);
    lines.push('');
  }
  lines.push('───────────────────────────────────────');
  lines.push(`النتيجة: ${passCount} ✅ / ${failCount} ❌ / ${warnCount} ⚠️`);
  lines.push(
    overallStatus === 'compliant'
      ? '✅ الجهاز مطابق بالكامل لمعايير الأمن السيبراني'
      : overallStatus === 'partial'
      ? '⚠️ الجهاز مطابق جزئياً — راجعي التنبيهات أعلاه'
      : '❌ الجهاز يحتاج معالجة لرفع مستوى الأمان',
  );
  const summaryArabic = lines.join('\n');

  const summaryEnglish = checks
    .map((c) => `${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '!'} ${c.id} (${c.ncaRef}): ${c.detailsEnglish}`)
    .join('\n');

  return { passCount, failCount, warnCount, totalChecks: checks.length, checks, summaryArabic, summaryEnglish, overallStatus };
}

/** Fast parallel audit (all 5 checks at once). Used for re-audit after
 * fixes. The verbose, narrated, sequential version lives in nca-fix.ts. */
export async function runNcaAudit(): Promise<AuditReport> {
  const [fv, sl, fw, up, pw] = await Promise.all([
    checkFileVault(),
    checkScreenLock(),
    checkFirewall(),
    checkUpdates(),
    checkPasswordPolicy(),
  ]);
  return buildAuditReport([fv, sl, fw, up, pw]);
}
