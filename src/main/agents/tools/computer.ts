// Computer-control primitives used by the Computer Use loop. macOS-only
// for now. Uses osascript (built into macOS) so no third-party install
// is required — `cliclick` and `robotjs` would be alternatives if we
// ever wanted finer control or cross-platform support.
//
// Each function returns a result the Computer Use loop sends back to
// Claude as the tool_result of a `computer` tool call, so Claude can
// observe what happened and decide the next step.

import { exec } from 'child_process';
import { promisify } from 'util';
import { captureAllDisplays } from '../../services/screen-capture';
import type { ScreenCapture } from '../../../shared/types';

const execAsync = promisify(exec);

// ── AppleScript helpers ────────────────────────────────────────────────

/**
 * Run a one-line AppleScript. Returns stdout (whitespace-trimmed).
 * Throws if the script fails.
 */
async function osa(script: string): Promise<string> {
  const { stdout } = await execAsync(`osascript -e ${JSON.stringify(script)}`);
  return stdout.trim();
}

// ── Public tools ───────────────────────────────────────────────────────

/**
 * Move the mouse and click at the given coordinates (display pixels).
 * Uses System Events. Falls back gracefully if Accessibility permission
 * is not granted — caller should pre-flight permission with
 * checkAccessibilityPermission() before invoking.
 */
export async function clickAt(x: number, y: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Visibly move the cursor to the target first so the user can SEE
    // where the agent is about to click. Without this the click appears
    // instantly with no visual trail, making the demo feel like a glitch.
    await moveCursorTo(x, y);
    await new Promise((r) => setTimeout(r, 200));
    await osa(`tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Move the cursor to the given screen coordinates without clicking.
 */
export async function moveCursorTo(x: number, y: number): Promise<void> {
  // System Events doesn't have a "move only" verb, so we use a tiny
  // Cocoa script via osascript. CGEventCreateMouseEvent with no button.
  const script =
    `do shell script "/usr/bin/python3 -c \\\"import Quartz; ` +
    `Quartz.CGEventPost(0, Quartz.CGEventCreateMouseEvent(None, ` +
    `Quartz.kCGEventMouseMoved, (${Math.round(x)}, ${Math.round(y)}), 0))\\\""`;
  try {
    await osa(script);
  } catch {
    // Non-fatal — clicks can still happen even if move-only fails.
  }
}

/**
 * Type text at the current focus. Uses keystroke for ASCII; falls back
 * to clipboard paste for anything containing non-ASCII (Arabic, etc.)
 * because keystroke can't render non-Latin glyphs reliably.
 */
export async function typeText(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const isAscii = /^[\x00-\x7F]*$/.test(text);
  try {
    if (isAscii) {
      await osa(`tell application "System Events" to keystroke ${JSON.stringify(text)}`);
    } else {
      // Set clipboard and paste with Cmd+V to support Arabic input.
      await osa(`set the clipboard to ${JSON.stringify(text)}`);
      await osa(`tell application "System Events" to keystroke "v" using command down`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Press a special key by macOS key code or name. Examples:
 * - 'Return' / 'Enter' → key code 36
 * - 'Tab' → key code 48
 * - 'Escape' → key code 53
 * - 'Down' → key code 125
 */
const KEY_CODES: Record<string, number> = {
  Return: 36, Enter: 36, Tab: 48, Space: 49, Escape: 53,
  Up: 126, Down: 125, Left: 123, Right: 124,
  Delete: 51, Backspace: 51,
};

export async function pressKey(key: string, modifiers: string[] = []): Promise<{ ok: true } | { ok: false; error: string }> {
  const code = KEY_CODES[key];
  if (code === undefined) return { ok: false, error: `unknown key: ${key}` };
  const modClause = modifiers.length
    ? ` using {${modifiers.map((m) => `${m} down`).join(', ')}}`
    : '';
  try {
    await osa(`tell application "System Events" to key code ${code}${modClause}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Capture the cursor's current screen. Returns the same ScreenCapture
 * shape the rest of Flicky uses, so the result drops into the Computer
 * Use loop's next message without any extra transform.
 */
export async function takeScreenshot(): Promise<ScreenCapture | null> {
  const captures = await captureAllDisplays();
  return captures[0] ?? null;
}

/**
 * Switch the Wi-Fi network. Used as a "scripted tool" path for the
 * hotspot scenario when Memory has high-confidence past matches —
 * faster + more reliable than asking Computer Use to navigate the menu.
 *
 * Note: this requires the password to already be in the Keychain or to
 * be passed explicitly. macOS will prompt the user otherwise.
 */
export async function switchWifi(ssid: string, password?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const cmd = password
    ? `networksetup -setairportnetwork en0 ${JSON.stringify(ssid)} ${JSON.stringify(password)}`
    : `networksetup -setairportnetwork en0 ${JSON.stringify(ssid)}`;
  try {
    const { stdout, stderr } = await execAsync(cmd);
    const out = (stdout + stderr).trim();
    if (out.toLowerCase().includes('error') || out.toLowerCase().includes('could not')) {
      return { ok: false, error: out };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Quick context extraction: returns the name + window title of the
 * frontmost macOS app. Called by the orchestrator before invoking Memory
 * so Memory can route correctly even when the user's voice is vague.
 *
 * Cheap (~100ms), text-only, no image processing.
 */
export async function getForegroundContext(): Promise<string | null> {
  try {
    const appName = (
      await osa(
        `tell application "System Events" to name of first application process whose frontmost is true`,
      )
    ).trim();
    let windowTitle = '';
    try {
      windowTitle = (
        await osa(
          `tell application "System Events" to name of front window of (first application process whose frontmost is true)`,
        )
      ).trim();
    } catch {
      // Some apps don't expose window titles; that's fine.
    }
    if (!appName) return null;
    return windowTitle && windowTitle !== appName
      ? `Foreground app: ${appName} — window: ${windowTitle}`
      : `Foreground app: ${appName}`;
  } catch {
    return null;
  }
}

/**
 * Check whether the app has macOS Accessibility permission. Without it,
 * clickAt/typeText/pressKey will silently no-op. The Computer Use loop
 * should call this once at startup and surface a clear error if it
 * fails, instead of confusing Claude with silent action failures.
 */
export async function checkAccessibilityPermission(): Promise<boolean> {
  try {
    // The simplest probe: ask System Events for a trivial property.
    // If Accessibility permission is missing, this throws.
    await osa(`tell application "System Events" to get name of first process`);
    return true;
  } catch {
    return false;
  }
}
