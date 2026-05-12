import type { ChoicePrompt, VetoResult } from "./types";
import type { VetoMode } from "./types";

export interface StartResult {
  state: unknown;
  publicMessages: string[];
  nextPrompt?: ChoicePrompt;
  completed: boolean;
}

export interface VetoStrategy {
  readonly mode: VetoMode;
  start(channelId: string, players: [string, string], mapPool: string[], startedById?: string): StartResult;
  getPrompt(channelId: string, state: unknown): ChoicePrompt | undefined;
  getStatusSummary(state: unknown): string;
  applyChoice(
    channelId: string,
    state: unknown,
    userId: string,
    map: string,
    rng: () => number
  ): { nextState: unknown; result: VetoResult };
  applyLoser?(
    channelId: string,
    state: unknown,
    loserId: string
  ): { nextState: unknown; result: VetoResult };
}
