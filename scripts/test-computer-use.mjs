#!/usr/bin/env node
/**
 * Standalone Computer Use test — no Flicky, no Electron.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/test-computer-use.mjs "افتح Calculator"
 *
 * Or to read the key from Flicky's saved Keychain entry:
 *   node scripts/test-computer-use.mjs "افتح Calculator"
 *
 * Captures the screen via macOS `screencapture`, sends it to Claude with
 * the computer_20250124 tool, executes whatever Claude returns via
 * osascript, loops until Claude is satisfied or 14 iterations pass.
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = 'claude-sonnet-4-5';
const COMPUTER_TOOL_TYPE = 'computer_20250124';
const ANTHROPIC_BETA = 'computer-use-2025-01-24';
const MAX_ITERATIONS = 14;
const SCREENSHOT_MAX_DIM = 768;

const SYSTEM_PROMPT = `You are an IT support agent on macOS. Take ACTIONS to complete the user's task.

CRITICAL RULES — follow these exactly:

1. To open ANY application, always use Spotlight in this exact sequence:
     a. key("cmd+space")     → opens Spotlight search bar
     b. type("AppName")       → types the app name
     c. key("Return")          → launches the app
     d. wait(2)               → wait 2 seconds for the app to appear
     e. screenshot             → verify the app is now visible

2. DO NOT assume an app is already open just because its name appears somewhere. Verify with a screenshot showing the app's actual window.

3. DO NOT click random coordinates hoping they hit the app. Use Spotlight first.

4. After every action that should change the screen, take a fresh screenshot before deciding the next action.

5. Take MINIMUM steps. For "open X", you should be done in ≤6 iterations.

6. When the task is complete, return a plain text message (no tool calls) like "Calculator is open."

NEVER:
- Reset passwords
- Install new software
- Open personal files`;

// ── Args ────────────────────────────────────────────────────────────────
const userPrompt = process.argv.slice(2).join(' ').trim();
if (!userPrompt) {
  console.error('Usage: node scripts/test-computer-use.mjs "<your request>"');
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY || readKeyFromFlicky();
if (!apiKey) {
  console.error('No ANTHROPIC_API_KEY in env, and could not read from Flicky.');
  console.error('Set: export ANTHROPIC_API_KEY=sk-ant-...');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function readKeyFromFlicky() {
  // Flicky stores via Electron safeStorage — we can't decrypt that from
  // outside the Electron process. Fall through if not in env.
  return null;
}

function takeScreenshotBase64() {
  const path = join(tmpdir(), `cu-test-${Date.now()}.jpg`);
  const ret = spawnSync('screencapture', ['-t', 'jpg', '-x', path], { stdio: 'pipe' });
  if (ret.status !== 0 || !existsSync(path)) {
    throw new Error('screencapture failed: ' + (ret.stderr?.toString() ?? ''));
  }
  const buf = readFileSync(path);
  unlinkSync(path);
  return downscaleJpegBase64(buf, SCREENSHOT_MAX_DIM);
}

function downscaleJpegBase64(buf, maxDim) {
  // Use macOS sips (built-in) to resize. Avoids native deps.
  const inPath = join(tmpdir(), `cu-in-${Date.now()}.jpg`);
  const outPath = join(tmpdir(), `cu-out-${Date.now()}.jpg`);
  writeFileSync(inPath, buf);
  spawnSync('sips', ['-Z', String(maxDim), '-s', 'formatOptions', '60', inPath, '--out', outPath], {
    stdio: 'pipe',
  });
  const finalBuf = existsSync(outPath) ? readFileSync(outPath) : buf;
  if (existsSync(inPath)) unlinkSync(inPath);
  if (existsSync(outPath)) unlinkSync(outPath);
  return finalBuf.toString('base64');
}

function getDisplayDims() {
  // Get the main display's logical resolution.
  const out = execSync(
    `osascript -e 'tell application "Finder" to get bounds of window of desktop'`,
  )
    .toString()
    .trim();
  // bounds are like "0, 0, 1440, 900"
  const parts = out.split(',').map((s) => parseInt(s.trim(), 10));
  return { width: parts[2], height: parts[3] };
}

function osa(script) {
  return execSync(`osascript -e ${JSON.stringify(script)}`).toString();
}

function clickAt(x, y) {
  try {
    osa(`tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function typeText(text) {
  const isAscii = /^[\x00-\x7F]*$/.test(text);
  try {
    if (isAscii) {
      osa(`tell application "System Events" to keystroke ${JSON.stringify(text)}`);
    } else {
      osa(`set the clipboard to ${JSON.stringify(text)}`);
      osa(`tell application "System Events" to keystroke "v" using command down`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const KEY_CODES = {
  Return: 36, Enter: 36, Tab: 48, Space: 49, Escape: 53,
  Up: 126, Down: 125, Left: 123, Right: 124, Delete: 51, Backspace: 51,
};

function pressKey(text) {
  const parts = text.split('+');
  const keyName = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  const modMap = { cmd: 'command', ctrl: 'control', alt: 'option', shift: 'shift' };
  const macMods = mods.map((m) => modMap[m] || m);
  const cap = keyName.charAt(0).toUpperCase() + keyName.slice(1).toLowerCase();
  const code = KEY_CODES[cap];
  if (code === undefined) return { ok: false, error: `unknown key: ${cap}` };
  const modClause = macMods.length ? ` using {${macMods.map((m) => `${m} down`).join(', ')}}` : '';
  try {
    osa(`tell application "System Events" to key code ${code}${modClause}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function executeAction(input) {
  const { action, coordinate, text } = input;
  switch (action) {
    case 'screenshot':
      return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: takeScreenshotBase64() } }] };
    case 'left_click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click': {
      if (coordinate) {
        const { width, height } = getDisplayDims();
        // Computer tool sends coords in image space; we sent SCREENSHOT_MAX_DIM-scaled
        // images, so we need to scale back to display space.
        const sx = width / SCREENSHOT_MAX_DIM;
        const sy = (height * (SCREENSHOT_MAX_DIM / Math.max(width, height))) / Math.min(SCREENSHOT_MAX_DIM, height);
        // simpler: assume image is downscaled proportionally; map by ratio
        const scale = width >= height
          ? width / SCREENSHOT_MAX_DIM
          : height / SCREENSHOT_MAX_DIM;
        const dx = coordinate[0] * scale;
        const dy = coordinate[1] * scale;
        clickAt(dx, dy);
      }
      return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: takeScreenshotBase64() } }] };
    }
    case 'mouse_move':
      // Skip — moving without clicking adds noise. Just acknowledge.
      return { content: 'ok' };
    case 'type':
      if (text) typeText(text);
      return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: takeScreenshotBase64() } }] };
    case 'key':
      if (text) pressKey(text);
      return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: takeScreenshotBase64() } }] };
    case 'cursor_position':
      return { content: 'unknown' };
    case 'wait': {
      const seconds = Math.min(Number(input.duration ?? input.text ?? 1), 5);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: takeScreenshotBase64() } }] };
    }
    case 'scroll': {
      // Best-effort: arrow-key scroll instead of trackpad scroll
      const dir = input.scroll_direction ?? input.direction;
      const amount = Math.min(Number(input.scroll_amount ?? 3), 10);
      const keyName = dir === 'up' ? 'Up' : dir === 'left' ? 'Left' : dir === 'right' ? 'Right' : 'Down';
      for (let s = 0; s < amount; s++) pressKey(keyName);
      return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: takeScreenshotBase64() } }] };
    }
    case 'hold_key':
    case 'left_mouse_down':
    case 'left_mouse_up':
      return { content: 'ok' };
    default:
      return { content: `unsupported: ${action}`, is_error: true };
  }
}

function pruneHistory(messages, keepRecent) {
  if (messages.length <= 1) return messages;
  const first = messages[0];
  const rest = messages.slice(1);
  const max = keepRecent * 2;
  return rest.length <= max ? [first, ...rest] : [first, ...rest.slice(rest.length - max)];
}

// ── Main loop ───────────────────────────────────────────────────────────

async function main() {
  console.log(`\n▶ Task: ${userPrompt}\n`);
  console.log('Capturing initial screenshot...');
  const initialScreenshot = takeScreenshotBase64();
  const dims = getDisplayDims();
  console.log(`Display: ${dims.width}×${dims.height}`);

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: initialScreenshot } },
        { type: 'text', text: userPrompt },
      ],
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500));
    process.stdout.write(`\n[iter ${i + 1}/${MAX_ITERATIONS}] thinking... `);

    const requestMessages = pruneHistory(messages, 3);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ANTHROPIC_BETA,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [
          { type: COMPUTER_TOOL_TYPE, name: 'computer', display_width_px: SCREENSHOT_MAX_DIM, display_height_px: Math.round(SCREENSHOT_MAX_DIM * (dims.height / dims.width)), display_number: 1 },
        ],
        messages: requestMessages,
      }),
    });

    if (!res.ok) {
      console.log('FAIL');
      console.error('API error:', res.status, await res.text());
      process.exit(1);
    }
    const data = await res.json();
    const content = data.content ?? [];
    messages.push({ role: 'assistant', content });

    const toolUses = content.filter((b) => b.type === 'tool_use');
    const textBlocks = content.filter((b) => b.type === 'text');

    for (const tb of textBlocks) {
      if (tb.text) console.log(`\n  💬 ${tb.text.trim().slice(0, 200)}`);
    }

    if (toolUses.length === 0) {
      console.log(`\n\n✅ Done after ${i + 1} iterations.`);
      const finalText = textBlocks.map((b) => b.text ?? '').join('\n').trim();
      if (finalText) console.log(`Final: ${finalText}`);
      return;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      const action = tu.input?.action ?? '?';
      const coord = tu.input?.coordinate;
      const text = tu.input?.text;
      const desc = action === 'left_click' && coord ? `click(${coord[0]},${coord[1]})`
        : action === 'type' ? `type("${text?.slice(0, 30)}")`
        : action === 'key' ? `key("${text}")`
        : action;
      console.log(`\n  → ${desc}`);
      const result = await executeAction(tu.input ?? {});
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.content,
        is_error: result.is_error,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  console.log(`\n\n⚠️  Hit iteration limit (${MAX_ITERATIONS}).`);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
