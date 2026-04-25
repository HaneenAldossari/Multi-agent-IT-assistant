// Multi-Agent IT Assistant — Target-cursor renderer.
// Vanilla TS. Listens for SHOW_TARGET_CURSOR / HIDE_TARGET_CURSOR from main
// and animates the triangle + bubble in/out. Main process owns positioning
// (it moves the BrowserWindow itself to the target screen coordinates) and
// the auto-hide timer.

import './styles/design-system.css';
import './styles/target-cursor.css';

const root = document.getElementById('root') as HTMLDivElement;
const bubble = document.getElementById('bubble') as HTMLDivElement;

function show(label: string): void {
  bubble.textContent = label;
  // Force reflow so the transition replays cleanly when re-triggered
  // while the window is already showing (back-to-back PTT presses).
  root.classList.remove('is-active');
  void root.offsetWidth;
  root.classList.add('is-active');
}

function hide(): void {
  root.classList.remove('is-active');
}

const flickyApi = (window as unknown as { flicky?: typeof window.flicky }).flicky;
if (flickyApi?.onShowTargetCursor) {
  flickyApi.onShowTargetCursor((label: string) => show(label));
  flickyApi.onHideTargetCursor?.(() => hide());
} else {
  // Standalone preview path.
  show('اضغط هنا لإعادة المصادقة');
}
