export type VetoMode =
  | "bo3-banABBA-pickAB"
  | "bo5-banAB-randomfirst-loserspick"
  | "bo5-winnerA-banBA-pickAA-loserspick"
  | "bo3-adminfirst-banABBA-loserspick"
  | "bo3-banABBA-randomfirst-loserspick"
  // Legacy persisted modes kept for backwards compatibility.
  | "bo3"
  | "bo5";
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
