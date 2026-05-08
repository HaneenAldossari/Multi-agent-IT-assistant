// Scripted tool implementations. Each tool is a deterministic shell command
// — fast (≤1s), 100% reliable for known scenarios, no model reasoning needed.
//
// When Memory recommends "scripted" + names a specific tool, the orchestrator
// dispatches here directly, bypassing the Computer Use loop entirely. Drops
// the response time from 15-30s to ~1s for known patterns.

import { exec } from 'child_process';
import { promisify } from 'util';
import { runNcaAudit } from './nca-audit';
import { runNcaAuditAndFix } from './nca-fix';
const execAsync = promisify(exec);

export interface ScriptedResult {
  ok: boolean;
  message: string;
  script: string;
}

/** Open an app via macOS `open -a`. Works for any installed application.
 * If the app isn't installed, returns a clear Arabic message identifying
 * the missing app so the user (and the upstream agents) can react. */
export async function openApp(name: string): Promise<ScriptedResult> {
  const safe = name.replace(/"/g, '');
  try {
    await execAsync(`open -a "${safe}"`);
    return { ok: true, message: `تم فتح ${safe}`, script: `open -a "${safe}"` };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // macOS `open -a` returns "Unable to find application named" if the
    // app isn't installed. Surface that case explicitly.
    const isMissing = /unable to find application|application.*not found|-10810/i.test(errMsg);
    return {
      ok: false,
      message: isMissing
        ? `التطبيق "${safe}" غير مثبَّت على الجهاز. تحقّقي من الاسم أو ثبّتي التطبيق أولاً.`
        : `تعذّر فتح ${safe}: ${errMsg.slice(0, 120)}`,
      script: `open -a "${safe}" → ${errMsg}`,
    };
  }
}

/** Quit an app via AppleScript. */
export async function quitApp(name: string): Promise<ScriptedResult> {
  const safe = name.replace(/"/g, '');
  try {
    await execAsync(`osascript -e 'tell application "${safe}" to quit'`);
    return { ok: true, message: `تم إغلاق ${safe}`, script: `quit ${safe}` };
  } catch (err) {
    return {
      ok: false,
      message: `تعذّر إغلاق ${safe}`,
      script: `quit ${safe} → ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Restart an app: quit then reopen. */
export async function restartApp(name: string): Promise<ScriptedResult> {
  const q = await quitApp(name);
  if (!q.ok) return q;
  await new Promise((r) => setTimeout(r, 800));
  const o = await openApp(name);
  return o.ok
    ? { ok: true, message: `تم إعادة تشغيل ${name}`, script: `restart ${name}` }
    : o;
}

/** Switch macOS Wi-Fi to a named SSID. Password from Keychain if previously joined. */
export async function switchWifi(ssid: string, password?: string): Promise<ScriptedResult> {
  const safe = ssid.replace(/"/g, '');
  const cmd = password
    ? `networksetup -setairportnetwork en0 "${safe}" "${password}"`
    : `networksetup -setairportnetwork en0 "${safe}"`;
  try {
    const { stdout, stderr } = await execAsync(cmd);
    const out = (stdout + stderr).trim();
    if (/error|could not|failed/i.test(out)) {
      return { ok: false, message: out, script: cmd };
    }
    return { ok: true, message: `تم التحويل إلى ${safe}`, script: cmd };
  } catch (err) {
    return {
      ok: false,
      message: `تعذّر التحويل إلى ${safe}`,
      script: `${cmd} → ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Run NCA-ECC compliance audit on the device. */
export async function ncaAudit(): Promise<ScriptedResult> {
  try {
    const report = await runNcaAudit();
    return {
      ok: true,
      message: report.summaryArabic,
      script: 'NCA-ECC compliance audit (5 checks)',
    };
  } catch (err) {
    return {
      ok: false,
      message: 'تعذّر إجراء التدقيق الأمني',
      script: `nca-audit → ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Run NCA audit and auto-remediate failures where safe. */
export async function ncaAuditAndFix(onStep?: (text: string) => Promise<void> | void): Promise<ScriptedResult> {
  try {
    const result = await runNcaAuditAndFix(onStep);
    return {
      ok: result.afterReport.passCount > result.beforeReport.passCount,
      message: result.summaryArabic,
      script: 'NCA-ECC audit + auto-remediation',
    };
  } catch (err) {
    return {
      ok: false,
      message: 'تعذّر إجراء التدقيق والمعالجة',
      script: `nca-fix → ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Dispatch by tool name. Returns null if unknown tool.
 * The optional onStep callback lets long-running tools (like NCA audit-
 * and-fix) emit per-step updates so the agent panel stays alive and
 * narrates the work instead of going dark for several seconds. */
export async function dispatchScripted(
  tool: string,
  args: Record<string, string>,
  onStep?: (text: string) => Promise<void> | void,
): Promise<ScriptedResult | null> {
  switch (tool) {
    case 'openApp':
    case 'open_app':
      return openApp(args.name ?? args.app ?? '');
    case 'quitApp':
    case 'quit_app':
      return quitApp(args.name ?? args.app ?? '');
    case 'restartApp':
    case 'restart_app':
      return restartApp(args.name ?? args.app ?? '');
    case 'switchWifi':
    case 'switch_wifi':
      return switchWifi(args.ssid ?? args.network ?? '', args.password);
    case 'ncaAudit':
    case 'nca_audit':
    case 'securityAudit':
      return ncaAudit();
    case 'ncaAuditAndFix':
    case 'nca_audit_fix':
    case 'fixCompliance':
      return ncaAuditAndFix(onStep);
    default:
      return null;
  }
}
