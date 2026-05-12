export type VetoMode = "bo3" | "bo5";
export type VetoAction = "ban" | "pick";

export interface ChoicePrompt {
  channelId: string;
  playerId: string;
  action: VetoAction;
  options: string[];
  instructions: string;
}

export interface VetoResult {
  publicMessages: string[];
  nextPrompt?: ChoicePrompt;
  completed: boolean;
}

export interface VetoSession {
  channelId: string;
  mode: VetoMode;
  players: [string, string];
  state: unknown;
  completed: boolean;
  history: SessionSnapshot[];
}

export interface SessionSnapshot {
  state: unknown;
  completed: boolean;
}
