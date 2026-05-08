import { app, BrowserWindow, Tray, Menu, globalShortcut, screen, ipcMain, shell, nativeImage } from 'electron';
import path from 'path';
import { CompanionManager } from './companion-manager';
import { createPanelWindow, createOverlayWindow, createStreamWindow, createAgentPanelWindow, createRecPillWindow, createTargetCursorWindow } from './windows';
import { IPC, type StreamVisibility, type StreamWindowBounds } from '../shared/types';
import { AUDIO_IPC } from './services/audio-capture';
import * as chatHistory from './services/chat-history-store';

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let tray: Tray | null = null;
let panelWindow: BrowserWindow | null = null;
let overlayWindows: BrowserWindow[] = [];
let streamWindow: BrowserWindow | null = null;
let agentPanelWindow: BrowserWindow | null = null;
let agentPanelHideTimer: ReturnType<typeof setTimeout> | null = null;
let recPillWindow: BrowserWindow | null = null;
let recPillHideTimer: ReturnType<typeof setTimeout> | null = null;
let targetCursorWindow: BrowserWindow | null = null;
let targetCursorHideTimer: ReturnType<typeof setTimeout> | null = null;
let companion: CompanionManager;
let isAppQuitting = false;
let lastVoiceState = 'idle';

app.on('before-quit', () => { isAppQuitting = true; });

// ── Helpers ────────────────────────────────────────────────────────────

function createTrayIcon(): Electron.NativeImage {
  // Resolve the icon relative to the built JS. In dev that's
  // dist/main/main/ → ../../../assets; in a packaged app the same
  // path resolves inside the asar bundle since assets/** is shipped.
  const assetRoot = path.join(__dirname, '../../../assets');
  const size32 = path.join(assetRoot, 'icons', '32x32.png');
  const size16 = path.join(assetRoot, 'icons', '16x16.png');

  const primary = process.platform === 'darwin' ? size32 : size16;

  try {
    const img = nativeImage.createFromPath(primary);
    if (img.isEmpty()) throw new Error('empty tray icon image');

    // On macOS attach a 2x representation so the tray icon stays
    // crisp on Retina. On Windows/Linux resize to 16 for the tray.
    if (process.platform === 'darwin') {
      const hi = nativeImage.createFromPath(size32);
      if (!hi.isEmpty()) {
        img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
      }
      return img.resize({ width: 16, height: 16 });
    }
    return img.resize({ width: 16, height: 16 });
  } catch (err) {
    console.error('[Flicky] tray icon load failed, using fallback:', err);
    // Generated fallback — cornflower-blue filled circle so the tray
    // entry is still clickable even if the PNGs are missing.
    const size = 32;
    const canvas = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = size / 2, cy = size / 2, r = size / 2 - 2;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        const i = (y * size + x) * 4;
        if (dist <= r) {
          canvas[i] = 100;
          canvas[i + 1] = 149;
          canvas[i + 2] = 237;
          canvas[i + 3] = 255;
        }
      }
    }
    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }
}

function sendToPanel(channel: string, ...args: unknown[]): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send(channel, ...args);
  }
}

function sendToOverlays(channel: string, ...args: unknown[]): void {
  for (const win of overlayWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

function sendToStream(channel: string, ...args: unknown[]): void {
  if (streamWindow && !streamWindow.isDestroyed()) {
    streamWindow.webContents.send(channel, ...args);
  }
}

function sendToAll(channel: string, ...args: unknown[]): void {
  sendToPanel(channel, ...args);
  sendToOverlays(channel, ...args);
  sendToStream(channel, ...args);
}

// ── App Lifecycle ──────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Initialize companion manager
  companion = new CompanionManager({
    onVoiceStateChanged: (state) => {
      lastVoiceState = state;
      sendToAll(IPC.VOICE_STATE_CHANGED, state);
      updateStreamForVoiceState(state);
      updateRecPillForVoiceState(state);
    },
    onTranscriptUpdate: (result) => sendToAll(IPC.TRANSCRIPT_UPDATE, result),
    onAiResponseChunk: (chunk) => {
      sendToPanel(IPC.AI_RESPONSE_CHUNK, chunk);
      sendToStream(IPC.AI_RESPONSE_CHUNK, chunk);
    },
    onAiResponseComplete: (text) => {
      sendToPanel(IPC.AI_RESPONSE_COMPLETE, text);
      sendToStream(IPC.AI_RESPONSE_COMPLETE, text);
    },
    onElementDetected: (el) => {
      // The Multi-Agent target-cursor window is the canonical click-target
      // indicator. The legacy fullscreen overlay path is intentionally NOT
      // notified here — sending to both produced two visible cursors at the
      // same coordinates.
      updateTargetCursor(el);
    },
    onSettingsChanged: (s) => sendToPanel(IPC.SETTINGS_CHANGED, s),
    onMemoryStatsChanged: (stats) => sendToPanel(IPC.MEMORY_STATS, stats),
    onChatEntryAdded: (entry) => sendToPanel(IPC.CHAT_ENTRY_ADDED, entry),
    onStartAudioCapture: () => sendToOverlays(AUDIO_IPC.START_CAPTURE),
    onStopAudioCapture: () => sendToOverlays(AUDIO_IPC.STOP_CAPTURE),
    onPlayAudio: (buf) => sendToOverlays('play-audio', buf),
    onCursorVisibilityChanged: (enabled) => applyOverlayVisibility(enabled),
    onStreamVisibilityChanged: (v) => applyStreamVisibility(v),
    onAgentPanelShow: () => showAgentPanel(),
    onAgentMessage: (msg) => {
      if (agentPanelWindow && !agentPanelWindow.isDestroyed()) {
        agentPanelWindow.webContents.send(IPC.AGENT_MESSAGE, msg);
      }
    },
  });

  // Create tray
  tray = new Tray(createTrayIcon());
  tray.setToolTip('IT Assistant');

  console.log('[Flicky] Tray created, registering click handler...');

  tray.on('click', () => togglePanel());
  tray.on('double-click', () => togglePanel());

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Panel', click: () => { console.log('[Flicky] Show Panel menu clicked'); togglePanel(); } },
      { type: 'separator' },
      { label: 'Quit Flicky', click: () => app.quit() },
    ]),
  );

  // Create overlay windows for each display
  rebuildOverlays();
  screen.on('display-added', rebuildOverlays);
  screen.on('display-removed', rebuildOverlays);

  // Diagnostic only — pipes overlay renderer console.log to main stdout so
  // we can see what the cursor receives during a live PTT flow.
  for (const win of overlayWindows) {
    win.webContents.on('console-message', (_e, level, message) => {
      console.log(`[overlay-console L${level}] ${message}`);
    });
  }


  // Create the transparent stream window (hidden until the user opts in).
  {
    const settings = companion.getSettings();
    streamWindow = createStreamWindow(settings.streamWindowBounds);
    streamWindow.on('close', (e) => {
      // Don't let the user actually close the stream — just hide it and
      // flip the setting off so the toggle in General reflects reality.
      if (!isAppQuitting) {
        e.preventDefault();
        streamWindow?.hide();
        companion.setStreamVisibility('off');
      }
    });
    streamWindow.on('moved', persistStreamBounds);
    streamWindow.on('resized', persistStreamBounds);
    applyStreamVisibility(settings.streamVisibility);
  }

  // Multi-Agent IT Assistant — Agent Collaboration Panel.
  // Created hidden; surfaced each time companion.onAgentPanelShow fires.
  agentPanelWindow = createAgentPanelWindow();
  agentPanelWindow.on('close', (e) => {
    if (!isAppQuitting) {
      e.preventDefault();
      agentPanelWindow?.hide();
    }
  });

  // Multi-Agent IT Assistant — Wispr-style recording pill. Created hidden; surfaced
  // when voiceState transitions to 'listening'. Audio-level frames flow
  // through here from overlay → main → pill renderer.
  recPillWindow = createRecPillWindow();
  recPillWindow.on('close', (e) => {
    if (!isAppQuitting) {
      e.preventDefault();
      recPillWindow?.hide();
    }
  });
  ipcMain.on('audio-level', (_e, level: number) => {
    if (recPillWindow && !recPillWindow.isDestroyed() && recPillWindow.isVisible()) {
      recPillWindow.webContents.send(IPC.REC_PILL_AUDIO_LEVEL, level);
    }
  });

  // Multi-Agent IT Assistant — Target cursor window. Stays mapped between requests;
  // we only move + show/hide it in updateTargetCursor.
  targetCursorWindow = createTargetCursorWindow();
  targetCursorWindow.on('close', (e) => {
    if (!isAppQuitting) {
      e.preventDefault();
      targetCursorWindow?.hide();
    }
  });



  // Sync the OS login-item state with our stored preference. Handles
  // the case where the user disables the login item externally (e.g.
  // via System Settings) — next launch reconciles the two.
  try {
    app.setLoginItemSettings({ openAtLogin: companion.getSettings().launchAtLogin });
  } catch (err) {
    console.error('[Flicky] initial setLoginItemSettings failed:', err);
  }

  // Multi-Agent IT Assistant — toggle-mode push-to-talk.
  //
  // Flicky's original handler relied on Electron's globalShortcut firing
  // repeatedly while the hotkey is held, then debounced "no repeat for
  // 250ms" as the key-up signal. That doesn't work on macOS — Electron's
  // globalShortcut fires once per press, ignoring key-repeat — so the
  // debounce timer always expires ~250ms after press and stops the
  // recording before the user has said anything.
  //
  // Switch to a toggle: first press starts recording, second press
  // stops and processes. Better demo UX (no need to hold 3 keys while
  // looking at the camera) and works identically across platforms.
  // 30s auto-stop guards against a forgotten "still recording".
  let pttIsRecording = false;
  let pttSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  let currentShortcut = '';

  const pttHandler = () => {
    console.log(`[Multi-Agent] PTT shortcut fired, isRecording=${pttIsRecording}`);
    if (!pttIsRecording) {
      pttIsRecording = true;
      companion.startPushToTalk();
      if (pttSafetyTimer) clearTimeout(pttSafetyTimer);
      pttSafetyTimer = setTimeout(() => {
        if (pttIsRecording) {
          console.log('[Multi-Agent] PTT auto-stop after 30s');
          pttIsRecording = false;
          companion.stopPushToTalk();
        }
        pttSafetyTimer = null;
      }, 30_000);
    } else {
      pttIsRecording = false;
      if (pttSafetyTimer) {
        clearTimeout(pttSafetyTimer);
        pttSafetyTimer = null;
      }
      companion.stopPushToTalk();
    }
  };

  function registerPttShortcut(accelerator: string): boolean {
    const previous = currentShortcut;
    try {
      if (previous) globalShortcut.unregister(previous);
      const ok = globalShortcut.register(accelerator, pttHandler);
      if (ok) {
        currentShortcut = accelerator;
        return true;
      }
    } catch (err) {
      console.error('[Flicky] shortcut register failed:', err);
    }
    // Failure path: always try to restore the last-known-good binding so
    // the user isn't left without any shortcut at all, even when the
    // failing register call used the same accelerator as before.
    if (previous) {
      try {
        globalShortcut.register(previous, pttHandler);
        currentShortcut = previous;
      } catch (err) {
        console.error('[Flicky] shortcut rollback failed:', err);
        currentShortcut = '';
      }
    }
    return false;
  }

  registerPttShortcut(companion.getSettings().pushToTalkShortcut);
  companion.setShortcutReRegister(registerPttShortcut);

  // Escape interrupts whatever the agent is doing — transcription, Memory
  // search, Computer Use loop. Returns the system to idle so the user can
  // press PTT and retry without restarting the app. Note that this DOES
  // intercept Escape globally (other apps won't see it) — that's the cost
  // of giving the user a one-keystroke abort.
  globalShortcut.register('Escape', () => {
    const aborted = companion.abortCurrentTurn();
    if (aborted) {
      // Hide the agent panel and any other UI overlays
      if (agentPanelWindow && !agentPanelWindow.isDestroyed()) {
        agentPanelWindow.hide();
      }
      if (recPillWindow && !recPillWindow.isDestroyed()) {
        recPillWindow.hide();
      }
      console.log('[Multi-Agent] Escape pressed — turn aborted, UI cleared');
    }
  });

  function suspendPttShortcut(): void {
    if (currentShortcut) {
      try { globalShortcut.unregister(currentShortcut); } catch { /* no-op */ }
    }
  }
  function resumePttShortcut(): void {
    const desired = companion.getSettings().pushToTalkShortcut;
    registerPttShortcut(desired);
  }
  ipcMain.on(IPC.SUSPEND_PUSH_TO_TALK_SHORTCUT, () => suspendPttShortcut());
  ipcMain.on(IPC.RESUME_PUSH_TO_TALK_SHORTCUT, () => resumePttShortcut());

  // ── IPC Handlers ───────────────────────────────────────────────────

  ipcMain.handle(IPC.GET_SETTINGS, () => companion.getSettings());
  ipcMain.handle(IPC.GET_PERMISSIONS, () => companion.getPermissions());

  ipcMain.on(IPC.SET_MODEL, (_e, model) => companion.setModel(model));
  ipcMain.on(IPC.SET_OPENAI_MODEL, (_e, model) => companion.setOpenAIModel(model));
  ipcMain.on(IPC.SET_MIND_PROVIDER, (_e, provider) => companion.setMindProvider(provider));
  ipcMain.on(IPC.SET_REASONING_DEPTH, (_e, depth) => companion.setReasoningDepth(depth));
  ipcMain.on(IPC.SET_REPLY_TONE, (_e, tone) => companion.setReplyTone(tone));
  ipcMain.on(IPC.SET_VOICE_ID, (_e, id) => companion.setVoiceId(id));
  ipcMain.on(IPC.SET_VOICE_SPEED, (_e, speed) => companion.setVoiceSpeed(speed));
  ipcMain.on(IPC.SET_VOICE_STABILITY, (_e, stab) => companion.setVoiceStability(stab));
  ipcMain.on(IPC.SET_SPEAK_REPLIES, (_e, enabled) => companion.setSpeakReplies(enabled));
  ipcMain.on(IPC.TOGGLE_CURSOR, (_e, enabled) => companion.toggleCursor(enabled));
  ipcMain.on(IPC.SET_LAUNCH_AT_LOGIN, (_e, enabled) => companion.setLaunchAtLogin(enabled));
  ipcMain.on(IPC.SET_PUSH_TO_TALK_SHORTCUT, (_e, accel: string) => companion.setPushToTalkShortcut(accel));
  ipcMain.on(IPC.SET_STREAM_VISIBILITY, (_e, v: StreamVisibility) => companion.setStreamVisibility(v));
  ipcMain.on(IPC.SET_STREAM_WINDOW_BOUNDS, (_e, b: StreamWindowBounds) => companion.setStreamWindowBounds(b));
  ipcMain.on(IPC.CLEAR_STREAM, () => sendToStream(IPC.CLEAR_STREAM));
  ipcMain.on(IPC.REQUEST_PERMISSION, (_e, kind) => companion.requestPermission(kind));
  ipcMain.on(IPC.OPEN_EXTERNAL, (_e, url) => shell.openExternal(url));
  ipcMain.on(IPC.QUIT_APP, () => app.quit());
  ipcMain.on(IPC.REPLAY_ONBOARDING, () => companion.replayOnboarding());
  ipcMain.on(IPC.COMPLETE_ONBOARDING, () => companion.completeOnboarding());
  ipcMain.on(IPC.SET_GROQ_MODEL, (_e, model) => companion.setGroqModel(model));
  ipcMain.on(IPC.CLEAR_CONTEXT, () => companion.clearContext());
  ipcMain.handle(IPC.COMPACT_CONTEXT, () => companion.compactContext());
  ipcMain.on(IPC.PLAY_VOICE_PREVIEW, (_e, voiceId) => { void companion.playVoicePreview(voiceId); });
  ipcMain.handle(IPC.GET_MEMORY_STATS, () => companion.getMemoryStats());
  ipcMain.handle(IPC.GET_CHAT_HISTORY, () => companion.getChatHistory());
  ipcMain.on(IPC.CLEAR_CHAT_HISTORY, () => companion.clearChatHistory());

  // API Key Management
  ipcMain.on(IPC.SET_API_KEY, (_e, name, value) => companion.setApiKey(name, value));
  ipcMain.on(IPC.DELETE_API_KEY, (_e, name) => companion.deleteApiKey(name));
  ipcMain.handle(IPC.GET_API_KEY_STATUS, () => companion.getApiKeyStatus());

  // Audio capture: relay chunks from overlay renderer to companion
  ipcMain.on(AUDIO_IPC.AUDIO_CHUNK, (_e, buffer: Buffer) => {
    companion.handleAudioChunk(buffer);
  });

  // Track cursor position for overlay rendering
  setInterval(() => {
    const pos = screen.getCursorScreenPoint();
    sendToOverlays(IPC.CURSOR_POSITION, pos);
  }, 16); // ~60fps

  // Poll permissions
  setInterval(async () => {
    const perms = await companion.getPermissions();
    sendToPanel(IPC.PERMISSION_STATUS, perms);
  }, 1500);

  // Open the main window on first launch.
  togglePanel();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Drain any pending chat-history writes before exit.
  chatHistory.flushSync();
});

// macOS: don't quit when all windows are closed (tray app)
app.on('window-all-closed', () => {
  // Don't quit — this is a tray app
});

// ── Window Management ──────────────────────────────────────────────────

function togglePanel(): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isVisible() && panelWindow.isFocused()) {
      panelWindow.hide();
      return;
    }
    panelWindow.show();
    panelWindow.focus();
    return;
  }

  panelWindow = createPanelWindow();
  panelWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[Flicky] Panel FAILED to load:', code, desc, url);
  });
  panelWindow.on('close', (e) => {
    // Don't destroy on close — hide so reopening is instant and keeps state.
    if (!isAppQuitting) {
      e.preventDefault();
      panelWindow?.hide();
    }
  });

  panelWindow.show();
  panelWindow.focus();
}

function rebuildOverlays(): void {
  // Destroy existing overlays
  for (const win of overlayWindows) {
    if (!win.isDestroyed()) win.destroy();
  }

  overlayWindows = screen.getAllDisplays().map((display) => createOverlayWindow(display));
  // Respect the persisted "Show cursor" setting — if the user has it
  // turned off, the overlays are created but hidden so we can still
  // route voice-state / element-detected events into their renderers
  // without a visible window on screen.
  applyOverlayVisibility(companion.getSettings().isClickyCursorEnabled);
}

function applyOverlayVisibility(enabled: boolean): void {
  for (const win of overlayWindows) {
    if (win.isDestroyed()) continue;
    if (enabled) {
      win.showInactive();
    } else {
      win.hide();
    }
  }
}

/**
 * Show or hide the stream window based on the current visibility
 * setting. 'responses' mode is refined further by updateStreamForVoiceState
 * which flicks it on when Flicky is thinking / speaking.
 */
function applyStreamVisibility(v: StreamVisibility): void {
  if (!streamWindow || streamWindow.isDestroyed()) return;
  if (v === 'always') {
    streamWindow.showInactive();
  } else if (v === 'off') {
    streamWindow.hide();
  } else {
    // 'responses' — reconcile with whatever Flicky is currently doing
    // so switching *into* this mode immediately reflects the real state
    // (hide if idle, show if mid-turn) instead of waiting for the next
    // voice state transition.
    updateStreamForVoiceState(lastVoiceState);
  }
}

function updateStreamForVoiceState(state: string): void {
  if (!streamWindow || streamWindow.isDestroyed()) return;
  const v = companion.getSettings().streamVisibility;
  if (v !== 'responses') return;
  const active = state === 'listening' || state === 'processing' || state === 'responding';
  if (active) {
    streamWindow.showInactive();
  } else if (state === 'idle') {
    streamWindow.hide();
  }
}

/**
 * Show the agent panel and (re)start its 12-second animation timeline.
 * Re-firing this while the panel is already visible is a feature: the
 * renderer treats each SHOW_AGENT_PANEL event as a hard restart, mirroring
 * Flicky's "new turn supersedes old turn" behavior elsewhere.
 */
function showAgentPanel(): void {
  if (!agentPanelWindow || agentPanelWindow.isDestroyed()) return;
  agentPanelWindow.showInactive();
  agentPanelWindow.webContents.send(IPC.SHOW_AGENT_PANEL);
  if (agentPanelHideTimer) clearTimeout(agentPanelHideTimer);
  // 12s timeline + small tail for the fade-out.
  agentPanelHideTimer = setTimeout(() => {
    if (agentPanelWindow && !agentPanelWindow.isDestroyed()) {
      agentPanelWindow.hide();
    }
    agentPanelHideTimer = null;
  }, 12500);
}

/**
 * Move + show / hide the dedicated target-cursor window. A non-null
 * element positions the window so the triangle's tip lands on the target
 * coordinate, then animates the cursor in. A null element hides it.
 *
 * The original fullscreen overlay still receives the same event (for
 * mouse-following and Flicky's existing animations); this path is purely
 * additive and is what actually shows up in real screen recordings on
 * macOS Sonoma+.
 */
function updateTargetCursor(el: { x: number; y: number; label: string } | null): void {
  if (!targetCursorWindow || targetCursorWindow.isDestroyed()) return;
  if (el) {
    if (targetCursorHideTimer) {
      clearTimeout(targetCursorHideTimer);
      targetCursorHideTimer = null;
    }
    const [w, h] = targetCursorWindow.getSize();
    // Anchor the window so the triangle's visual tip lands on (el.x, el.y).
    // The polygon's pointing tip is at SVG (4,4) inside a 56×56 triangle
    // displayed at scale 56/48. With margin-top: 6px on the triangle, the
    // tip's pixel offset inside the window is approximately (5, 11). We
    // require the cursor capsule to use LTR layout (see .tc-root in
    // target-cursor.css) so the triangle is always the leftmost child.
    const x = Math.round(el.x - 5);
    const y = Math.round(el.y - 11);
    // Clamp to the display we're on so the bubble doesn't fall offscreen.
    const display = screen.getDisplayNearestPoint({ x: el.x, y: el.y });
    const maxX = display.bounds.x + display.bounds.width - w - 8;
    const maxY = display.bounds.y + display.bounds.height - h - 8;
    targetCursorWindow.setBounds({
      x: Math.max(display.bounds.x + 8, Math.min(maxX, x)),
      y: Math.max(display.bounds.y + 8, Math.min(maxY, y)),
      width: w,
      height: h,
    });
    targetCursorWindow.showInactive();
    targetCursorWindow.webContents.send(IPC.SHOW_TARGET_CURSOR, el.label);
  } else {
    targetCursorWindow.webContents.send(IPC.HIDE_TARGET_CURSOR);
    if (targetCursorHideTimer) clearTimeout(targetCursorHideTimer);
    targetCursorHideTimer = setTimeout(() => {
      if (targetCursorWindow && !targetCursorWindow.isDestroyed()) targetCursorWindow.hide();
      targetCursorHideTimer = null;
    }, 320);
  }
}

/**
 * Show / hide the recording pill in lockstep with the voice state. The
 * pill window stays mapped between requests; we just toggle its
 * visibility (and let the renderer animate the fade in/out).
 */
function updateRecPillForVoiceState(state: string): void {
  if (!recPillWindow || recPillWindow.isDestroyed()) return;
  if (state === 'listening') {
    if (recPillHideTimer) {
      clearTimeout(recPillHideTimer);
      recPillHideTimer = null;
    }
    recPillWindow.showInactive();
    recPillWindow.webContents.send(IPC.SHOW_REC_PILL);
  } else {
    if (!recPillWindow.isVisible()) return;
    recPillWindow.webContents.send(IPC.HIDE_REC_PILL);
    if (recPillHideTimer) clearTimeout(recPillHideTimer);
    // Match the renderer's fade-out CSS transition (~220ms) plus a small
    // tail so we don't yank the window mid-fade.
    recPillHideTimer = setTimeout(() => {
      if (recPillWindow && !recPillWindow.isDestroyed()) recPillWindow.hide();
      recPillHideTimer = null;
    }, 280);
  }
}

function persistStreamBounds(): void {
  if (!streamWindow || streamWindow.isDestroyed()) return;
  const [x, y] = streamWindow.getPosition();
  const [width, height] = streamWindow.getSize();
  companion.setStreamWindowBounds({ x, y, width, height });
}
