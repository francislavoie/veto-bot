import type { ChoicePrompt, VetoResult } from "./types";
import type { StartResult, VetoStrategy } from "./strategy";

interface Bo3AdminFirstState {
  players: [string, string];
  startedById: string;
  remainingMaps: string[];
  firstMap?: string;
  bans: Array<{ playerId: string; map: string }>;
  firstGameLoserId?: string;
  secondMapPickerId?: string;
  mapOrder: string[];
  phase: "await_admin_first_pick" | "bans" | "await_loser" | "await_pick" | "done";
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

function promptForState(channelId: string, state: Bo3AdminFirstState): ChoicePrompt | undefined {
  if (state.phase === "await_admin_first_pick") {
    return {
      channelId,
      playerId: state.startedById,
      action: "pick",
      options: [...state.remainingMaps],
      instructions: "✅ As host, pick the starting map for game 1 before player coin-flip bans begin."
    };
  }

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
      instructions: "✅ You lost game 1 — pick the map for game 2."
    };
  }

  return undefined;
}

export class Bo3AdminFirstBanABBALosersPickStrategy implements VetoStrategy {
  readonly mode = "bo3-adminfirst-banABBA-loserspick" as const;

  start(channelId: string, players: [string, string], mapPool: string[], startedById?: string): StartResult {
    validateMapPool(mapPool);
    if (!startedById) {
      throw new Error("Could not identify who started this veto.");
    }

    const state: Bo3AdminFirstState = {
      players,
      startedById,
      remainingMaps: [...mapPool],
      bans: [],
      mapOrder: [],
      phase: "await_admin_first_pick"
    };

    return {
      state,
      publicMessages: [
        `🗺️ **BO3 veto started** between ${mention(players[0])} and ${mention(players[1])}.`,
        `📋 **Rules:** Host picks game 1 first. Then players ban 4 maps in ABBA order. Two maps remain; game 1 stays fixed, game 1 loser picks game 2, and the last map is the ⚔️ deciding match.`
      ],
      nextPrompt: promptForState(channelId, state),
      completed: false
    };
  }

  getPrompt(channelId: string, rawState: unknown): ChoicePrompt | undefined {
    return promptForState(channelId, rawState as Bo3AdminFirstState);
  }

  getStatusSummary(rawState: unknown): string {
    const state = rawState as Bo3AdminFirstState;
    const lines: string[] = [];

    if (state.firstMap) {
      lines.push(`🎯 Game 1 map: **${state.firstMap}**`);
    }
    if (state.bans.length > 0) {
      lines.push(`🚫 Bans: ${state.bans.map((b) => `**${b.map}** by ${mention(b.playerId)}`).join(", ")}`);
    }
    if (state.firstGameLoserId) {
      lines.push(`💀 Game 1 loser: ${mention(state.firstGameLoserId)}`);
    }
    if (state.mapOrder.length === 3) {
      lines.push(
        `✅ BO3 map order:\n` +
          `1. **${state.mapOrder[0]}** — host-selected game 1\n` +
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
    _rng: () => number
  ): { nextState: unknown; result: VetoResult } {
    const state = rawState as Bo3AdminFirstState;
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

    if (state.phase === "await_admin_first_pick") {
      state.firstMap = map;
      state.mapOrder.push(map);
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
      state.phase = "bans";
      publicMessages.push(`✅ ${mention(userId)} selected **${map}** as game 1.`);
      publicMessages.push(`🪙 Coin flip: ${mention(state.players[0])} bans first, then ${mention(state.players[1])}. Ban order is ABBA.`);
    } else if (state.phase === "bans") {
      state.bans.push({ playerId: userId, map });
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
      publicMessages.push(`🚫 ${mention(userId)} banned **${map}**.`);
      if (state.bans.length === 4) {
        state.phase = "await_loser";
        publicMessages.push(
          `🗺️ Bans complete. Remaining maps: **${state.remainingMaps[0]}** and **${state.remainingMaps[1]}**.\n\n` +
            `🎮 Game 1 will be played on **${state.mapOrder[0]}**.\n` +
            `Moderator: report game 1 loser with \`/vetonext loser:@player\`.`
        );
      }
    } else {
      state.secondMapPickerId = userId;
      state.mapOrder.push(map);
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
      publicMessages.push(`✅ ${mention(userId)} picked **${map}** as game 2.`);

      if (state.remainingMaps.length !== 1) {
        throw new Error("Expected exactly one deciding map remaining.");
      }

      const decidingMap = state.remainingMaps[0];
      state.mapOrder.push(decidingMap);
      state.remainingMaps = [];
      state.phase = "done";
      state.expectedPicker = undefined;
      completed = true;

      publicMessages.push(`⚔️ Deciding map (game 3): **${decidingMap}**.`);
      publicMessages.push(
        `✅ **BO3 map order:**\n` +
          `1. **${state.mapOrder[0]}** — host-selected game 1\n` +
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
    const state = rawState as Bo3AdminFirstState;
    if (!state.players.includes(loserId)) {
      throw new Error("Reported loser is not one of the veto players.");
    }

    if (state.phase === "await_admin_first_pick" || state.phase === "bans") {
      throw new Error("Bans are not finished yet. Complete admin first pick and ABBA bans first.");
    }
    if (state.phase === "await_pick") {
      throw new Error("Still waiting for the currently reported loser to pick game 2.");
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
        publicMessages: [`💀 ${mention(loserId)} lost game 1 on **${state.mapOrder[0]}**.`],
        nextPrompt: promptForState(channelId, state),
        completed: false
      }
    };
  }
}
