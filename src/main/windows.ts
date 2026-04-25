import { app, BrowserWindow, Display, screen } from 'electron';
import path from 'path';
import type { StreamWindowBounds } from '../shared/types';

const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER === '1';

function getPreloadPath(): string {
  return path.join(__dirname, '../preload/index.js');
}

function loadPage(win: BrowserWindow, page: string): void {
  if (isDev) {
    const url = `http://localhost:5173/${page}.html`;
    console.log(`[Flicky] Loading ${page} from dev server: ${url}`);
    win.loadURL(url);
  } else {
    const filePath = path.join(__dirname, '../../renderer', `${page}.html`);
    console.log(`[Flicky] Loading ${page} from file: ${filePath}`);
    win.loadFile(filePath);
  }
}

/** The main Flicky app window (settings + status). */
export function createPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 820,
    minHeight: 560,
    show: false,
    frame: true,
    titleBarStyle: 'default',
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    transparent: false,
    backgroundColor: '#0f0f11',
    title: 'Flicky',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  loadPage(win, 'panel');
  return win;
}

/** A transparent, click-through overlay covering one display. */
export function createOverlayWindow(display: Display): BrowserWindow {
  const { x, y, width, height } = display.bounds;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Click-through. forward:true (Flicky's original) hands mouse events to
  // the underlying window — but on macOS Sonoma+ this combination of
  // transparent+fullscreen+forwarded-mouse causes the window server to
  // skip compositing the overlay against non-Electron focused apps. Using
  // forward:false keeps the click-through behavior (we never read mouse
  // events here anyway — main polls screen.getCursorScreenPoint) AND
  // preserves correct painting.
  win.setIgnoreMouseEvents(true, { forward: false });

  // Keep overlay above everything
  win.setAlwaysOnTop(true, 'screen-saver');

  // Visible on all workspaces / virtual desktops
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadPage(win, 'overlay');

  // Pass display info to overlay so it knows its coordinate space
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('display-info', {
      id: display.id,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    });
  });

  return win;
}

/**
 * The transparent, draggable "stream" window that mirrors the live Q/A
 * so the user can read, scroll, and copy. It's a frameless BrowserWindow
 * with a CSS-drag region in the header; mouse events are enabled so
 * scrolling and text selection work normally.
 */
export function createStreamWindow(
  storedBounds: StreamWindowBounds | null,
): BrowserWindow {
  const bounds = storedBounds ?? defaultStreamBounds();

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 280,
    minHeight: 180,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    title: 'Flicky Stream',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadPage(win, 'stream');
  return win;
}

/**
 * Multi-Agent IT Assistant — the four-agent collaboration panel. Top-left of the
 * primary display, transparent + frameless + always-on-top, never steals
 * focus. Created hidden; main process calls .showInactive() each time a
 * request begins, then sends SHOW_AGENT_PANEL so the renderer restarts
 * its hard-coded animation timeline.
 */
export function createAgentPanelWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const { workArea } = primary;
  const width = 380;
  const height = 480;
  const gutter = 24;

  const win = new BrowserWindow({
    x: workArea.x + gutter,
    y: workArea.y + gutter,
    width,
    height,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    title: 'Multi-Agent Panel',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 'screen-saver' is the highest always-on-top level — keeps the panel
  // visible over fullscreen Terminal/Chrome the way Flicky's cursor
  // overlay stays above everything.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadPage(win, 'agent-panel');
  return win;
}

/**
 * Multi-Agent IT Assistant — Target-cursor window. A small transparent capsule
 * that flies to a screen position and holds, with a labelled bubble.
 * Replaces the original fullscreen-transparent overlay path because
 * macOS Sonoma+ refuses to composite fullscreen-transparent windows
 * over non-Electron focused apps. Small windows composite reliably.
 */
export function createTargetCursorWindow(): BrowserWindow {
  const width = 380;
  const height = 90;

  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    title: 'Multi-Agent Pointer',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setIgnoreMouseEvents(true, { forward: false });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadPage(win, 'target-cursor');
  return win;
}

/**
 * Multi-Agent IT Assistant — Wispr-style recording pill. A small floating capsule
 * anchored to the bottom-center of the primary display. Created hidden;
 * shown when voiceState transitions to 'listening', hidden otherwise.
 *
 * Independent of the overlay window so the cursor-toggle setting can't
 * accidentally hide it.
 */
export function createRecPillWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const { workArea } = primary;
  const width = 320;
  const height = 64;
  const bottomGutter = 36;

  const win = new BrowserWindow({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - bottomGutter),
    width,
    height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    title: 'Multi-Agent Mic',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setIgnoreMouseEvents(true, { forward: false });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadPage(win, 'rec-pill');
  return win;
}

function defaultStreamBounds(): StreamWindowBounds {
  const primary = screen.getPrimaryDisplay();
  const { workArea } = primary;
  const width = 380;
  const height = 320;
  // Anchor to the bottom-right corner of the primary work area with a
  // small gutter, so on first launch users can find it easily.
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + workArea.height - height - 24,
  };
}
