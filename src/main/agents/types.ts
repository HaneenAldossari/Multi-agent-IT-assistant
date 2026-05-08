// Shared types for the 4-agent orchestrator. AgentMessage is the unit that
// streams from the orchestrator to the renderer's agent-panel as each agent
// thinks/finishes. Mirrors the visual states defined in agent-panel.css.

export type AgentName = 'memory' | 'resolver' | 'guardian' | 'reporter';

export type AgentStatus = 'thinking' | 'active' | 'done';

export interface AgentMessage {
  agent: AgentName;
  status: AgentStatus;
  text: string;
  timestamp: number;
}

export interface CursorTarget {
  x: number;
  y: number;
  label: string;
  screenIndex: number;
}

export interface OrchestratorOutput {
  finalUserMessage: string;
  cursorTarget: CursorTarget | null;
}
