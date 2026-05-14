import type { ChoicePrompt, VetoResult } from "./types";
import type { StartResult, VetoStrategy } from "./strategy";

interface Bo3State {
  players: [string, string];
  remainingMaps: string[];
  bans: Array<{ playerId: string; map: string }>;
  picks: Array<{ playerId: string; map: string }>;
  mapOrder: string[];
}

const BO3_BAN_ORDER: [number, number, number, number] = [0, 1, 1, 0];
const BO3_PICK_ORDER: [number, number] = [0, 1];

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

function nextPrompt(channelId: string, state: Bo3State): ChoicePrompt | undefined {
  if (state.bans.length < 4) {
    const playerId = state.players[BO3_BAN_ORDER[state.bans.length]];
    return {
      channelId,
      playerId,
      action: "ban",
      options: [...state.remainingMaps],
      instructions: `🚫 Ban one map. Ban order is ABBA (${state.bans.length + 1}/4).`
    };
  }

  if (state.picks.length < 2) {
    const playerId = state.players[BO3_PICK_ORDER[state.picks.length]];
    return {
      channelId,
      playerId,
      action: "pick",
      options: [...state.remainingMaps],
      instructions: `✅ Pick one map. Pick order is AB (${state.picks.length + 1}/2), the last remaining map is map 3.`
    };
  }

  return undefined;
}

export class Bo3Strategy implements VetoStrategy {
  readonly mode = "bo3-banABBA-pickAB" as const;

  start(channelId: string, players: [string, string], mapPool: string[], _startedById?: string): StartResult {
    validateMapPool(mapPool);
    const state: Bo3State = {
      players,
      remainingMaps: [...mapPool],
      bans: [],
      picks: [],
      mapOrder: []
    };
    const prompt = nextPrompt(channelId, state);
    return {
      state,
      publicMessages: [
        `🗺️ **BO3 veto started** between ${mention(players[0])} and ${mention(players[1])}.`,
        `📋 **Rules:** Both players ban 4 maps in ABBA order, then each picks 1 map (AB order). The last remaining map is the ⚔️ deciding match if the series goes to game 3.`,
        `🪙 Coin flip: ${mention(players[0])} is A and bans first. ${mention(players[1])} is B. Ban order is ABBA.`
      ],
      nextPrompt: prompt,
      completed: false
    };
  }

  getPrompt(channelId: string, rawState: unknown): ChoicePrompt | undefined {
    return nextPrompt(channelId, rawState as Bo3State);
  }

  getStatusSummary(rawState: unknown): string {
    const state = rawState as Bo3State;
    const lines: string[] = [];
    if (state.bans.length > 0) {
      lines.push(`🚫 Bans: ${state.bans.map((b) => `**${b.map}** by ${mention(b.playerId)}`).join(", ")}`);
    }
    if (state.picks.length > 0) {
      lines.push(`✅ Picks: ${state.picks.map((p) => `**${p.map}** by ${mention(p.playerId)}`).join(", ")}`);
    }
    if (state.mapOrder.length === 3) {
      lines.push(`⚔️ Deciding map: **${state.mapOrder[2]}**`);
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
    const state = rawState as Bo3State;
    const prompt = nextPrompt(channelId, state);
    if (!prompt) {
      throw new Error("This veto is already complete.");
    }
    if (prompt.playerId !== userId) {
      throw new Error(`NOT_YOUR_TURN:${prompt.playerId}:${prompt.action}`);
    }
    if (!state.remainingMaps.includes(map)) {
      throw new Error(`Map "${map}" is not available.`);
    }

    const publicMessages: string[] = [];

    if (prompt.action === "ban") {
      state.bans.push({ playerId: userId, map });
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
      publicMessages.push(`🚫 ${mention(userId)} banned **${map}**.`);
    } else {
      state.picks.push({ playerId: userId, map });
      state.mapOrder.push(map);
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
      publicMessages.push(`✅ ${mention(userId)} picked **${map}**.`);
    }

    let completed = false;
    let followUpPrompt = nextPrompt(channelId, state);
    if (!followUpPrompt && state.remainingMaps.length === 1 && state.mapOrder.length === 2) {
      const finalMap = state.remainingMaps[0];
      state.mapOrder.push(finalMap);
      state.remainingMaps = [];
      completed = true;
      publicMessages.push(`🗺️ Final remaining map is **${finalMap}**.`);
      publicMessages.push(
        `✅ **BO3 map order:**\n` +
        `1. **${state.mapOrder[0]}** — picked by ${mention(state.picks[0].playerId)}\n` +
        `2. **${state.mapOrder[1]}** — picked by ${mention(state.picks[1].playerId)}\n` +
        `3. **${state.mapOrder[2]}** — ⚔️ deciding match`
      );
    } else if (!followUpPrompt && state.remainingMaps.length === 0) {
      completed = true;
    }

    return {
      nextState: state,
      result: {
        publicMessages,
        nextPrompt: completed ? undefined : followUpPrompt,
        completed
      }
    };
  }
}
