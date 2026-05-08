#!/usr/bin/env node
/**
 * Resolver-ONLY tester. Skips Memory and Guardian entirely.
 *
 * Two modes:
 *   1. SCRIPTED — directly runs one of the scripted tools:
 *        node scripts/test-resolver-only.mjs scripted openApp Calculator
 *        node scripts/test-resolver-only.mjs scripted restartApp Mail
 *        node scripts/test-resolver-only.mjs scripted quitApp Slack
 *        node scripts/test-resolver-only.mjs scripted switchWifi Office-WiFi
 *
 *   2. COMPUTER_USE — runs the real Computer Use loop (Claude actually
 *      moves your cursor and types):
 *        node scripts/test-resolver-only.mjs cu "open Calculator"
 *        node scripts/test-resolver-only.mjs cu "open Mail"
 *
 * For scripted: no API call, runs in ~1 second, just shell exec.
 * For cu: real Computer Use — your cursor will move. Don't touch the
 * mouse/keyboard while it runs.
 */

import { exec, execSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execP = promisify(exec);
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage:');
  console.error('  node scripts/test-resolver-only.mjs scripted openApp Calculator');
  console.error('  node scripts/test-resolver-only.mjs scripted restartApp Mail');
  console.error('  node scripts/test-resolver-only.mjs cu "open Calculator"');
  process.exit(1);
}

const mode = args[0];
const start = Date.now();

// ── SCRIPTED MODE ─────────────────────────────────────────────────────

if (mode === 'scripted') {
  const toolName = args[1];
  const arg1 = args[2] ?? '';
  const arg2 = args[3] ?? '';
  console.log(`\n⚡ Running scripted: ${toolName}(${arg1}${arg2 ? `, ${arg2}` : ''})\n`);

  const result = await runScripted(toolName, arg1, arg2);
  console.log(`\n${result.ok ? '✅ Success' : '❌ Failed'}: ${result.message}`);
  console.log(`⏱  ${Date.now() - start}ms`);
  process.exit(result.ok ? 0 : 1);
}

// ── COMPUTER USE MODE (real cursor control) ───────────────────────────

if (mode === 'cu') {
  const userPrompt = args.slice(1).join(' ');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY first.');
    process.exit(1);
  }

  console.log(`\n🖱  Computer Use: "${userPrompt}"`);
  console.log(`⚠️  Don't touch your mouse/keyboard while this runs.\n`);

  await new Promise((r) => setTimeout(r, 2000)); // 2s grace

  await runComputerUse(userPrompt);
  console.log(`\n⏱  ${Date.now() - start}ms total`);
  process.exit(0);
}

console.error(`Unknown mode: ${mode}. Use "scripted" or "cu".`);
process.exit(1);

// ── Implementations ────────────────────────────────────────────────────

async function runScripted(toolName, a1, a2) {
  const safe = (s) => s.replace(/"/g, '');
  switch (toolName) {
    case 'brightnessUp': {
      // F2 = key code 144 on macOS (brightness up). Press multiple times.
      const presses = parseInt(a1, 10) || 8;
      for (let i = 0; i < presses; i++) {
        execSync(`osascript -e 'tell application "System Events" to key code 144'`);
        await new Promise((r) => setTimeout(r, 60));
      }
      return { ok: true, message: `تمت زيادة سطوع الشاشة (${presses} مستويات)` };
    }
    case 'brightnessDown': {
      const presses = parseInt(a1, 10) || 8;
      for (let i = 0; i < presses; i++) {
        execSync(`osascript -e 'tell application "System Events" to key code 145'`);
        await new Promise((r) => setTimeout(r, 60));
      }
      return { ok: true, message: `تمت خفض سطوع الشاشة (${presses} مستويات)` };
    }
    case 'volumeUp': {
      const presses = parseInt(a1, 10) || 5;
      for (let i = 0; i < presses; i++) {
        execSync(`osascript -e 'tell application "System Events" to key code 72'`);
        await new Promise((r) => setTimeout(r, 60));
      }
      return { ok: true, message: `تمت زيادة الصوت (${presses} مستويات)` };
    }
    case 'mute':
      execSync(`osascript -e 'tell application "System Events" to key code 74'`);
      return { ok: true, message: 'تم كتم الصوت' };
    case 'ncaAuditAndFix':
    case 'fixCompliance': {
      console.log('🛡️  Running NCA-ECC audit + auto-remediation...\n');

      // Phase 1: audit (same checks as ncaAudit case)
      const before = await Promise.all([
        runCheck('FileVault encryption', 'NCA-ECC-2-T4-1', `fdesetup status`, /FileVault is On/i),
        runCheck('Screen lock password', 'NCA-ECC-2-T2-3', `defaults read com.apple.screensaver askForPassword 2>/dev/null || echo 0`, /^1$/m),
        runCheck('Firewall', 'NCA-ECC-2-T5-1', `defaults read /Library/Preferences/com.apple.alf globalstate 2>/dev/null || echo 0`, /^[12]$/m),
        runCheck('System updates', 'NCA-ECC-2-T6-2', `softwareupdate --list 2>&1`, /No new software available/i),
        runCheck('Login password set', 'NCA-ECC-2-T2-1', `dscl . -read /Users/$(whoami) Password 2>/dev/null || echo unknown`, /Password:.+\S/),
      ]);
      const beforePass = before.filter((c) => c.ok).length;

      console.log('قبل المعالجة:');
      for (const c of before) console.log(`  ${c.ok ? '✅' : '❌'} ${c.title} (${c.ref})`);
      console.log(`\nالنتيجة قبل: ${beforePass} / ${before.length}\n`);

      // Phase 2: apply remediations for failed checks
      console.log('الإجراءات التي اتخذها الوكيل:');
      const fixActions = [];
      for (const c of before) {
        if (c.ok) continue;
        if (c.title.includes('Screen lock')) {
          try {
            await execP('defaults write com.apple.screensaver askForPassword -bool true');
            await execP('defaults write com.apple.screensaver askForPasswordDelay -int 0');
            fixActions.push({ title: c.title, action: 'fixed', detail: 'تم تفعيل قفل الشاشة الفوري' });
          } catch (e) { fixActions.push({ title: c.title, action: 'skipped', detail: 'فشل التفعيل' }); }
        } else if (c.title.includes('Firewall')) {
          try {
            await execP('open "x-apple.systempreferences:com.apple.preference.security?Firewall"');
            fixActions.push({ title: c.title, action: 'opened', detail: 'فُتحت إعدادات جدار الحماية للتفعيل اليدوي' });
          } catch (e) { fixActions.push({ title: c.title, action: 'skipped', detail: 'تعذّر فتح الإعدادات' }); }
        } else if (c.title.includes('updates')) {
          try {
            await execP('open "x-apple.systempreferences:com.apple.preferences.softwareupdate"');
            fixActions.push({ title: c.title, action: 'opened', detail: 'فُتحت Software Update للمراجعة' });
          } catch (e) { fixActions.push({ title: c.title, action: 'skipped', detail: 'تعذّر فتح Software Update' }); }
        } else if (c.title.includes('FileVault')) {
          try {
            await execP('open "x-apple.systempreferences:com.apple.preference.security?FDE"');
            fixActions.push({ title: c.title, action: 'opened', detail: '⚠️ FileVault لن يُفعّل تلقائياً (خطر فقد البيانات)؛ فُتحت الإعدادات' });
          } catch (e) { fixActions.push({ title: c.title, action: 'skipped', detail: 'تعذّر فتح إعدادات FileVault' }); }
        }
      }

      for (const fa of fixActions) {
        const icon = fa.action === 'fixed' ? '✅' : fa.action === 'opened' ? '⚙️' : '⚠️';
        console.log(`  ${icon} ${fa.title}`);
        console.log(`     ${fa.detail}`);
      }

      // Phase 3: re-audit
      await new Promise((r) => setTimeout(r, 800));
      const after = await Promise.all([
        runCheck('FileVault encryption', 'NCA-ECC-2-T4-1', `fdesetup status`, /FileVault is On/i),
        runCheck('Screen lock password', 'NCA-ECC-2-T2-3', `defaults read com.apple.screensaver askForPassword 2>/dev/null || echo 0`, /^1$/m),
        runCheck('Firewall', 'NCA-ECC-2-T5-1', `defaults read /Library/Preferences/com.apple.alf globalstate 2>/dev/null || echo 0`, /^[12]$/m),
        runCheck('System updates', 'NCA-ECC-2-T6-2', `softwareupdate --list 2>&1`, /No new software available/i),
        runCheck('Login password set', 'NCA-ECC-2-T2-1', `dscl . -read /Users/$(whoami) Password 2>/dev/null || echo unknown`, /Password:.+\S/),
      ]);
      const afterPass = after.filter((c) => c.ok).length;

      console.log(`\nبعد المعالجة:`);
      for (const c of after) console.log(`  ${c.ok ? '✅' : '❌'} ${c.title}`);
      console.log(`\nالنتيجة بعد: ${afterPass} / ${after.length}`);
      const delta = afterPass - beforePass;
      const summary = delta > 0
        ? `\n📈 تحسّن: ${beforePass} → ${afterPass} (+${delta})`
        : `\nبقيت بعض العناصر تتطلب موافقة إدارية`;
      console.log(summary);

      return { ok: afterPass > beforePass, message: `${afterPass}/${after.length}` };
    }
    case 'ncaAudit':
    case 'securityAudit': {
      // Inline NCA audit (matches src/main/agents/tools/nca-audit.ts behaviour)
      console.log('🛡️  Running NCA-ECC compliance audit...\n');
      const checks = await Promise.all([
        runCheck('FileVault encryption', 'NCA-ECC-2-T4-1', `fdesetup status`, /FileVault is On/i),
        runCheck('Screen lock password', 'NCA-ECC-2-T2-3', `defaults read com.apple.screensaver askForPassword 2>/dev/null || echo 0`, /^1$/m),
        runCheck('Firewall', 'NCA-ECC-2-T5-1', `defaults read /Library/Preferences/com.apple.alf globalstate 2>/dev/null || echo 0`, /^[12]$/m),
        runCheck('System updates', 'NCA-ECC-2-T6-2', `softwareupdate --list 2>&1`, /No new software available/i),
        runCheck('Login password set', 'NCA-ECC-2-T2-1', `dscl . -read /Users/$(whoami) Password 2>/dev/null || echo unknown`, /Password:.+\S/),
      ]);
      const passes = checks.filter((c) => c.ok).length;
      const lines = checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.title} (${c.ref})`);
      const summary = `\n${lines.join('\n')}\n\nنتيجة الامتثال: ${passes} / ${checks.length}`;
      return { ok: passes === checks.length, message: summary };
    }
    case 'openApp':
      return safeExec(`open -a "${safe(a1)}"`, `تم فتح ${a1}`, a1);
    case 'quitApp':
      return safeExec(`osascript -e 'tell application "${safe(a1)}" to quit'`, `تم إغلاق ${a1}`, a1);
    case 'restartApp': {
      const q = await safeExec(`osascript -e 'tell application "${safe(a1)}" to quit'`, '', a1);
      // restartApp ignores quit errors (app might not be running) and
      // proceeds to open. The open is the real test.
      await new Promise((r) => setTimeout(r, 800));
      return safeExec(`open -a "${safe(a1)}"`, `تم إعادة تشغيل ${a1}`, a1);
    }
    case 'switchWifi': {
      const cmd = a2
        ? `networksetup -setairportnetwork en0 "${safe(a1)}" "${safe(a2)}"`
        : `networksetup -setairportnetwork en0 "${safe(a1)}"`;
      return safeExec(cmd, `تم التحويل إلى ${a1}`, a1);
    }
    default:
      return { ok: false, message: `Unknown tool: ${toolName}` };
  }
}

async function runCheck(title, ref, cmd, passRegex) {
  try {
    const { stdout } = await execP(cmd);
    return { title, ref, ok: passRegex.test(stdout) };
  } catch {
    return { title, ref, ok: false };
  }
}

async function safeExec(cmd, okMsg, hint) {
  try {
    const { stdout, stderr } = await execP(cmd);
    const out = (stdout + stderr).trim();
    if (/error|could not|failed|unable to find/i.test(out)) {
      return { ok: false, message: friendlyError(out, hint) };
    }
    return { ok: true, message: okMsg };
  } catch (err) {
    const msg = err.message ?? String(err);
    return { ok: false, message: friendlyError(msg, hint) };
  }
}

function friendlyError(rawError, hint) {
  // App not installed
  if (/unable to find application|-10810/i.test(rawError)) {
    return `❌ التطبيق "${hint}" غير مثبَّت على هذا الجهاز`;
  }
  // Wi-Fi: failed to join (-3900). Usually means: password not in
  // Keychain, network out of range, or wrong encryption.
  if (/-3900|failed to join network/i.test(rawError)) {
    return `❌ تعذّر الاتصال بشبكة "${hint}". الأسباب المحتملة: كلمة السر غير محفوظة، الشبكة خارج النطاق، أو طريقة التشفير تغيّرت. تأكدي من الاتصال يدوياً مرة واحدة لحفظ بيانات الاعتماد.`;
  }
  // Wi-Fi: network not found
  if (/could not find network/i.test(rawError)) {
    return `❌ الشبكة "${hint}" غير متوفرة في النطاق الحالي`;
  }
  // Wi-Fi: airport disabled
  if (/wifi.*disabled|airport.*off/i.test(rawError)) {
    return `❌ الـ Wi-Fi مُعطّل على الجهاز. يجب تشغيله أولاً.`;
  }
  return `Operation failed: ${rawError.slice(0, 150)}`;
}

async function runComputerUse(userPrompt) {
  const screenshot = takeScreenshot();
  if (!screenshot) {
    console.error('Could not capture screen.');
    return;
  }

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot } },
        { type: 'text', text: userPrompt },
      ],
    },
  ];
  const SYS = `You are an IT support agent on macOS. Drive the cursor and keyboard to complete the task.

═══ APP TASKS ═══
To open an app, use Spotlight:
  key("cmd+space") → type("AppName") → key("Return") → wait(2) → screenshot

═══ Wi-Fi SWITCHING ═══
On macOS Sonoma+, the Wi-Fi control is in CONTROL CENTER, not as a standalone menu bar icon.

To switch Wi-Fi:
  1. screenshot — find the Control Center icon in the menu bar
     (it's the icon with two stacked toggle switches, top-right of menu bar)
  2. left_click on that Control Center icon
  3. wait(1) → screenshot
  4. left_click on the Wi-Fi tile (top-left of Control Center, shows the network name)
  5. wait(1) → screenshot — see the list of available networks
  6. left_click on the target network name
  7. wait(3) → screenshot — verify connection
  8. Final message: "تم التحويل إلى <network>."

If Control Center isn't found, try clicking the Wi-Fi icon directly in the menu bar (older macOS layout, top-right).

═══ GENERAL RULES ═══
- Take screenshots frequently to verify state
- Don't click random coordinates — always look at a screenshot first
- Final response: ONE short Arabic sentence (no tool calls)`;

  for (let i = 0; i < 12; i++) {
    process.stdout.write(`  [iter ${i + 1}] `);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'computer-use-2025-01-24',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: SYS,
        tools: [{ type: 'computer_20250124', name: 'computer', display_width_px: 768, display_height_px: 480, display_number: 1 }],
        messages,
      }),
    });
    if (!res.ok) {
      console.log(`API error ${res.status}`);
      return;
    }
    const data = await res.json();
    messages.push({ role: 'assistant', content: data.content });
    const tools = data.content.filter((c) => c.type === 'tool_use');
    if (tools.length === 0) {
      const text = data.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      console.log(`done`);
      console.log(`  💬 ${text}`);
      return;
    }
    const acks = [];
    for (const t of tools) {
      const desc = t.input?.action === 'left_click' && t.input?.coordinate
        ? `click(${t.input.coordinate[0]},${t.input.coordinate[1]})`
        : t.input?.action === 'type' ? `type("${t.input.text?.slice(0, 30)}")`
        : t.input?.action === 'key' ? `key("${t.input.text}")`
        : t.input?.action;
      process.stdout.write(`${desc} `);
      const result = await executeAction(t.input ?? {});
      acks.push({
        type: 'tool_result',
        tool_use_id: t.id,
        content: result.image
          ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: result.image } }]
          : result.error || 'ok',
        is_error: !!result.error,
      });
    }
    console.log('');
    messages.push({ role: 'user', content: acks });
    await new Promise((r) => setTimeout(r, 1500)); // pace under rate limit
  }
  console.log('  ⚠️  hit iteration limit');
}

async function executeAction(input) {
  const { action, coordinate, text } = input;
  const dispW = parseInt(execSync(`osascript -e 'tell application "Finder" to get bounds of window of desktop'`).toString().split(',')[2].trim());
  const scale = dispW / 768;

  switch (action) {
    case 'screenshot':
      return { image: takeScreenshot() };
    case 'left_click':
    case 'double_click':
    case 'right_click':
      if (coordinate) {
        const dx = Math.round(coordinate[0] * scale);
        const dy = Math.round(coordinate[1] * scale);
        try {
          // osascript click is reliable — System Events already has the
          // permissions it needs in most user environments. The cursor
          // teleports (visible jump) and the click fires.
          execSync(`osascript -e 'tell application "System Events" to click at {${dx}, ${dy}}'`);
        } catch (e) { return { error: e.message }; }
      }
      await new Promise((r) => setTimeout(r, 400));
      return { image: takeScreenshot() };
    case 'type':
      if (text) {
        const isAscii = /^[\x00-\x7F]*$/.test(text);
        try {
          if (isAscii) {
            execSync(`osascript -e 'tell application "System Events" to keystroke ${JSON.stringify(text)}'`);
          } else {
            execSync(`osascript -e 'set the clipboard to ${JSON.stringify(text)}'`);
            execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
          }
        } catch (e) { return { error: e.message }; }
      }
      return { image: takeScreenshot() };
    case 'key':
      if (text) {
        const codes = { Return: 36, Enter: 36, Tab: 48, Space: 49, Escape: 53, Down: 125, Up: 126, Left: 123, Right: 124 };
        const parts = text.split('+');
        const keyName = parts[parts.length - 1];
        const cap = keyName.charAt(0).toUpperCase() + keyName.slice(1).toLowerCase();
        const code = codes[cap];
        if (code === undefined) return { error: `unknown key: ${text}` };
        const modMap = { cmd: 'command', ctrl: 'control', alt: 'option', shift: 'shift' };
        const mods = parts.slice(0, -1).map((m) => modMap[m.toLowerCase()] || m.toLowerCase());
        const modClause = mods.length ? ` using {${mods.map((m) => `${m} down`).join(', ')}}` : '';
        try {
          execSync(`osascript -e 'tell application "System Events" to key code ${code}${modClause}'`);
        } catch (e) { return { error: e.message }; }
      }
      return { image: takeScreenshot() };
    case 'wait': {
      const dur = Math.min(Number(input.duration ?? 1), 5);
      await new Promise((r) => setTimeout(r, dur * 1000));
      return { image: takeScreenshot() };
    }
    case 'mouse_move':
      return { ok: true };
    default:
      return { error: `unsupported: ${action}` };
  }
}

function takeScreenshot() {
  const path = join(tmpdir(), `r-${Date.now()}.jpg`);
  spawnSync('screencapture', ['-t', 'jpg', '-x', path], { stdio: 'pipe' });
  if (!existsSync(path)) return null;
  const small = path.replace('.jpg', '-s.jpg');
  spawnSync('sips', ['-Z', '768', path, '--out', small], { stdio: 'pipe' });
  const b = readFileSync(existsSync(small) ? small : path).toString('base64');
  if (existsSync(path)) unlinkSync(path);
  if (existsSync(small)) unlinkSync(small);
  return b;
}

/**
 * Smoothly animate the cursor from its current position to (x, y) over
 * ~400ms, then click. Uses Quartz CGEventPost via macOS-bundled Python 3.
 * Without this, osascript "click at" teleports the cursor instantly so
 * the user (and the demo audience) never sees it move. With this, the
 * cursor visibly slides across the screen — the agentic moment.
 */
function smoothClickViaPython(x, y) {
  const py = [
    'import Quartz, time',
    'm = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))',
    `sx, sy = m.x, m.y`,
    `ex, ey = ${x}, ${y}`,
    `steps = 28`,
    `for i in range(steps + 1):`,
    `    t = i / steps`,
    `    e = t * t * (3 - 2 * t)`,
    `    cx = sx + (ex - sx) * e`,
    `    cy = sy + (ey - sy) * e`,
    `    ev = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (cx, cy), Quartz.kCGMouseButtonLeft)`,
    `    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)`,
    `    time.sleep(0.013)`,
    `time.sleep(0.08)`,
    `down = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, (ex, ey), Quartz.kCGMouseButtonLeft)`,
    `up = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, (ex, ey), Quartz.kCGMouseButtonLeft)`,
    `Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)`,
    `Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)`,
  ].join('\n');
  spawnSync('/usr/bin/python3', ['-c', py], { stdio: 'pipe' });
}
