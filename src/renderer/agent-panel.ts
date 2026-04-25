// Multi-Agent IT Assistant — Agent Collaboration Panel renderer.
// Pure visual demo: hard-coded Arabic message timeline triggered by an
// IPC event from the main process. No React, no real agent data.
// Each `show-agent-panel` event resets state and restarts the timeline.

import './styles/design-system.css';
import './styles/agent-panel.css';

type AgentId = 'memory' | 'resolver' | 'guardian' | 'reporter';

interface Step {
  /** Milliseconds from the start of the timeline. */
  at: number;
  run: () => void;
}

const root = document.getElementById('root') as HTMLDivElement;
const footer = document.getElementById('footer') as HTMLDivElement;

const rows: Record<AgentId, HTMLLIElement> = {
  memory:   document.querySelector<HTMLLIElement>('.ap-row[data-agent="memory"]')!,
  resolver: document.querySelector<HTMLLIElement>('.ap-row[data-agent="resolver"]')!,
  guardian: document.querySelector<HTMLLIElement>('.ap-row[data-agent="guardian"]')!,
  reporter: document.querySelector<HTMLLIElement>('.ap-row[data-agent="reporter"]')!,
};

function setStatus(agent: AgentId, text: string): void {
  const status = rows[agent].querySelector<HTMLDivElement>('.ap-status');
  if (status) status.textContent = text;
}

function startThinking(agent: AgentId): void {
  rows[agent].classList.remove('is-active');
  rows[agent].classList.add('is-thinking');
}

function setMessage(agent: AgentId, text: string): void {
  rows[agent].classList.remove('is-thinking');
  rows[agent].classList.add('is-active');
  setStatus(agent, text);
}

function resetAll(): void {
  for (const id of Object.keys(rows) as AgentId[]) {
    rows[id].classList.remove('is-thinking', 'is-active');
    setStatus(id, 'في الانتظار...');
  }
  footer.classList.remove('is-shown');
  footer.innerHTML = '';
  root.classList.remove('is-visible');
}

// Status-only labels (no in-character chat). Each agent has a "pulsing"
// label while thinking and the same label with a check mark when done —
// reads like a CI pipeline / antivirus scan, not a dialogue.
const LABEL = {
  memory:   'البحث في السجل...',
  resolver: 'تحليل الشاشة...',
  guardian: 'مراجعة السياسات...',
  reporter: 'تجهيز الرد...',
} as const;
const DONE = ' ✓'; // non-breaking space + check

const TIMELINE: Step[] = [
  { at:    50, run: () => root.classList.add('is-visible') },
  { at:   500, run: () => { startThinking('memory');   setStatus('memory',   LABEL.memory); } },
  { at:  2500, run: () => setMessage('memory',   LABEL.memory   + DONE) },
  { at:  3000, run: () => { startThinking('resolver'); setStatus('resolver', LABEL.resolver); } },
  { at:  5000, run: () => setMessage('resolver', LABEL.resolver + DONE) },
  { at:  5500, run: () => { startThinking('guardian'); setStatus('guardian', LABEL.guardian); } },
  { at:  6500, run: () => setMessage('guardian', LABEL.guardian + DONE) },
  { at:  7000, run: () => { startThinking('reporter'); setStatus('reporter', LABEL.reporter); } },
  { at:  9000, run: () => setMessage('reporter', LABEL.reporter + DONE) },
  { at: 11000, run: () => {
      footer.innerHTML = 'اكتمل<span class="check"></span>';
      footer.classList.add('is-shown');
    } },
  { at: 12000, run: () => root.classList.remove('is-visible') },
];

let activeTimers: ReturnType<typeof setTimeout>[] = [];

function clearTimers(): void {
  for (const t of activeTimers) clearTimeout(t);
  activeTimers = [];
}

function startTimeline(): void {
  clearTimers();
  resetAll();
  // Force a reflow so the .is-visible CSS transition replays cleanly when
  // re-triggered while the panel is already on screen. Without it the
  // browser can collapse the consecutive "remove → add" into a no-op.
  void root.offsetWidth;
  for (const step of TIMELINE) {
    activeTimers.push(setTimeout(step.run, step.at));
  }
}

// Trigger comes from main via the preload bridge (window.flicky.onAgentPanelShow).
// The Window.flicky global is declared in src/renderer/types.d.ts; we only
// guard against the standalone-browser-preview case (no preload attached).
const flickyApi = (window as unknown as { flicky?: typeof window.flicky }).flicky;
if (flickyApi?.onAgentPanelShow) {
  flickyApi.onAgentPanelShow(() => startTimeline());
} else {
  // Standalone preview path — useful when opening agent-panel.html directly.
  startTimeline();
}
