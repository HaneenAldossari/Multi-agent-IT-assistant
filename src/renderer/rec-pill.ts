// Multi-Agent IT Assistant — Wispr-style recording pill renderer.
// Vanilla TS. Subscribes to show/hide + live audio-level IPC events
// from main and animates a waveform in real time.

import './styles/design-system.css';
import './styles/rec-pill.css';

const BAR_COUNT = 16;
const PEAK_DECAY = 0.06;          // how fast a bar's peak relaxes per tick
const FRAME_INTERVAL_MS = 33;     // ~30fps repaint independent of IPC rate

const pill = document.getElementById('pill') as HTMLDivElement;
const wave = document.getElementById('wave') as HTMLDivElement;

// Build the bars once.
const bars: HTMLDivElement[] = [];
for (let i = 0; i < BAR_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'bar';
  wave.appendChild(b);
  bars.push(b);
}

// Rolling buffer of recent levels (newest at the END). Keeps BAR_COUNT
// values so the visual reads as "history scrolling left → right".
const levels: number[] = new Array(BAR_COUNT).fill(0);

let latestLevel = 0;

function pushLevel(level: number): void {
  // Mild non-linear shaping so quiet voices still register and clipping
  // doesn't pin all bars to max.
  const shaped = Math.min(1, Math.pow(Math.max(0, level), 0.6) * 1.4);
  latestLevel = Math.max(latestLevel * (1 - PEAK_DECAY), shaped);
  levels.shift();
  levels.push(latestLevel);
}

let rafActive = false;
function paint(): void {
  // Decay the rolling window slightly each frame so old activity fades
  // gracefully when the user goes silent mid-recording.
  for (let i = 0; i < BAR_COUNT; i++) {
    const decayed = Math.max(0, levels[i] - PEAK_DECAY * 0.4);
    levels[i] = decayed;
    const h = 3 + Math.round(decayed * 22);  // 3..25 px
    bars[i].style.height = `${h}px`;
  }
  if (rafActive) setTimeout(paint, FRAME_INTERVAL_MS);
}

function startPaintLoop(): void {
  if (rafActive) return;
  rafActive = true;
  paint();
}
function stopPaintLoop(): void {
  rafActive = false;
}

// ── IPC bridge ─────────────────────────────────────────────────────────
const flickyApi = (window as unknown as { flicky?: typeof window.flicky }).flicky;
if (flickyApi) {
  flickyApi.onShowRecPill?.(() => {
    pill.classList.add('is-visible');
    startPaintLoop();
  });
  flickyApi.onHideRecPill?.(() => {
    pill.classList.remove('is-visible');
    // Let bars decay to zero over the fade-out window so the visual
    // doesn't freeze mid-spike when the user releases PTT.
    setTimeout(stopPaintLoop, 260);
  });
  flickyApi.onRecPillAudioLevel?.((lvl: number) => {
    pushLevel(lvl);
  });
} else {
  // Standalone-preview path (open rec-pill.html directly in a browser).
  pill.classList.add('is-visible');
  startPaintLoop();
  setInterval(() => pushLevel(Math.random() * 0.8), 80);
}
