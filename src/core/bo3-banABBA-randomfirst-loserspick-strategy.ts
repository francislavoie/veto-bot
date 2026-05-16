import type { ChoicePrompt, VetoResult } from "./types";
import type { StartResult, VetoStrategy } from "./strategy";

interface Bo3RandomFirstState {
  players: [string, string];
  remainingMaps: string[];
  bans: Array<{ playerId: string; map: string }>;
  mapOrder: string[];
  firstGameLoserId?: string;
  secondMapPickerId?: string;
  phase: "bans" | "await_loser" | "await_pick" | "done";
  expectedPicker?: string;
}

const BO3_BAN_ORDER: [number, number, number, number] = [0, 1, 1, 0];
const mention = (id: string): string => `<@${id}>`;

function validateMapPool(mapPool: string[]): void {
  if (mapPool.length !== 7) {
    throw new Error("Map pool must contain exactly 7 maps.");
  }
  const unique = new Set(mapPool);
  if (unique.size !== mapPool.length) {
    throw new Error("Map pool contains duplicate map names.");
  }
}

function randomIndex(length: number, rng: () => number): number {
  return Math.max(0, Math.min(length - 1, Math.floor(rng() * length)));
}

function promptForState(channelId: string, state: Bo3RandomFirstState): ChoicePrompt | undefined {
  if (state.phase === "bans") {
    const playerId = state.players[BO3_BAN_ORDER[state.bans.length]];
    return {
      channelId,
      playerId,
      action: "ban",
      options: [...state.remainingMaps],
      instructions: `🚫 Ban one map. Ban order is ABBA (${state.bans.length + 1}/4).`
    };
  }

  if (state.phase === "await_pick" && state.expectedPicker) {
    return {
      channelId,
      playerId: state.expectedPicker,
      action: "pick",
      options: [...state.remainingMaps],
      instructions: "✅ You lost Map 1 — pick Map 2."
    };
  }

  return undefined;
}

export class Bo3BanABBARandomFirstLosersPickStrategy implements VetoStrategy {
  readonly mode = "bo3-banABBA-randomfirst-loserspick" as const;

  start(channelId: string, players: [string, string], mapPool: string[], _startedById?: string): StartResult {
    validateMapPool(mapPool);
    const state: Bo3RandomFirstState = {
      players,
      remainingMaps: [...mapPool],
      bans: [],
      mapOrder: [],
      phase: "bans"
    };

    return {
      state,
      publicMessages: [
        `🗺️ **BO3 veto started** between ${mention(players[0])} and ${mention(players[1])}.`,
        `📋 **Rules:** Both players ban 4 maps in ABBA order, then Map 1 is 🎲 randomly selected from the remaining 3. The loser of Map 1 picks Map 2, and the last map is the ⚔️ deciding match.`,
        `🪙 Coin flip: ${mention(players[0])} is A and bans first. ${mention(players[1])} is B. Ban order is ABBA.`
      ],
      nextPrompt: promptForState(channelId, state),
      completed: false
    };
  }

  getPrompt(channelId: string, rawState: unknown): ChoicePrompt | undefined {
    return promptForState(channelId, rawState as Bo3RandomFirstState);
  }

  getStatusSummary(rawState: unknown): string {
    const state = rawState as Bo3RandomFirstState;
    const lines: string[] = [];
    if (state.bans.length > 0) {
      lines.push(`🚫 Bans: ${state.bans.map((b) => `**${b.map}** by ${mention(b.playerId)}`).join(", ")}`);
    }
    if (state.mapOrder.length > 0) {
      lines.push(`🎲 Map 1 (random): **${state.mapOrder[0]}**`);
    }
    if (state.phase === "await_loser") {
      lines.push(`📝 Awaiting Map 1 loser report. Moderator: use \`/vetonext loser:@player\`.`);
    }
    if (state.firstGameLoserId) {
      lines.push(`💀 Map 1 loser: ${mention(state.firstGameLoserId)}`);
    }
    if (state.mapOrder.length === 3) {
      lines.push(
        `✅ BO3 map order:\n` +
          `1. **${state.mapOrder[0]}** — 🎲 randomly selected\n` +
          `2. **${state.mapOrder[1]}** — picked by ${mention(state.secondMapPickerId!)}\n` +
          `3. **${state.mapOrder[2]}** — ⚔️ deciding match`
      );
    }
    return lines.length ? lines.join("\n") : "Veto just started — no actions yet.";
  }

  applyChoice(
    channelId: string,
    rawState: unknown,
    userId: string,
    map: string,
    rng: () => number
  ): { nextState: unknown; result: VetoResult } {
    const state = rawState as Bo3RandomFirstState;
    const prompt = promptForState(channelId, state);
    if (!prompt) {
      throw new Error("This veto is not currently waiting for a map choice.");
    }
    if (prompt.playerId !== userId) {
      throw new Error(`NOT_YOUR_TURN:${prompt.playerId}:${prompt.action}`);
    }
    if (!state.remainingMaps.includes(map)) {
      throw new Error(`Map "${map}" is not available.`);
    }

    const publicMessages: string[] = [];
    let completed = false;

    if (state.phase === "bans") {
      state.bans.push({ playerId: userId, map });
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
      publicMessages.push(`🚫 ${mention(userId)} banned **${map}**.`);
      if (state.bans.length === 4) {
        const startingIdx = randomIndex(state.remainingMaps.length, rng);
        const startingMap = state.remainingMaps[startingIdx];
        state.remainingMaps = state.remainingMaps.filter((m) => m !== startingMap);
        state.mapOrder.push(startingMap);
        state.phase = "await_loser";
        publicMessages.push(
          `🗺️ Bans complete. Remaining maps: **${startingMap}**, **${state.remainingMaps[0]}**, **${state.remainingMaps[1]}**.\n\n` +
            `🎲 Randomly selected Map 1: **${startingMap}**.\n\n` +
            `💀 Map 2 will be loser's pick, from: **${state.remainingMaps[0]}**, **${state.remainingMaps[1]}**.\n` +
            `Moderator: report Map 1 loser with \`/vetonext loser:@player\`.`
        );
      }
    } else {
      // await_pick: loser picks map 2
      state.secondMapPickerId = userId;
      state.mapOrder.push(map);
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
      publicMessages.push(`✅ ${mention(userId)} picked **${map}** as Map 2.`);

      if (state.remainingMaps.length !== 1) {
        throw new Error("Expected exactly one deciding map remaining.");
      }
      const decidingMap = state.remainingMaps[0];
      state.mapOrder.push(decidingMap);
      state.remainingMaps = [];
      state.phase = "done";
      state.expectedPicker = undefined;
      completed = true;

      publicMessages.push(`⚔️ Deciding map (Map 3): **${decidingMap}**.`);
      publicMessages.push(
        `🚫 **Bans:** ${state.bans.map((b) => `**${b.map}** by ${mention(b.playerId)}`).join(", ")}\n\n` +
        `✅ **BO3 map order:**\n` +
          `1. **${state.mapOrder[0]}** — 🎲 randomly selected\n` +
          `2. **${state.mapOrder[1]}** — picked by ${mention(state.secondMapPickerId)}\n` +
          `3. **${state.mapOrder[2]}** — ⚔️ deciding match`
      );
    }

    return {
      nextState: state,
      result: {
        publicMessages,
        nextPrompt: completed ? undefined : promptForState(channelId, state),
        completed
      }
    };
  }

  applyLoser(
    channelId: string,
    rawState: unknown,
    loserId: string
  ): { nextState: unknown; result: VetoResult } {
    const state = rawState as Bo3RandomFirstState;
    if (!state.players.includes(loserId)) {
      throw new Error("Reported loser is not one of the veto players.");
    }
    if (state.phase === "bans") {
      throw new Error("Bans are not finished yet. All four ABBA bans must be completed first.");
    }
    if (state.phase === "await_pick") {
      throw new Error("Still waiting for the currently reported loser to pick Map 2.");
    }
    if (state.phase === "done") {
      throw new Error("This BO3 veto is already complete.");
    }

    state.firstGameLoserId = loserId;
    state.phase = "await_pick";
    state.expectedPicker = loserId;

    return {
      nextState: state,
      result: {
        publicMessages: [`💀 ${mention(loserId)} lost Map 1 on **${state.mapOrder[0]}**.`],
        nextPrompt: promptForState(channelId, state),
        completed: false
      }
    };
  }
}
