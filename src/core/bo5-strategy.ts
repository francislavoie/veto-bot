import type { ChoicePrompt, VetoResult } from "./types";
import type { StartResult, VetoStrategy } from "./strategy";

interface GameResult {
  map: string;
  loserId: string;
}

interface Bo5State {
  players: [string, string];
  remainingMaps: string[];
  bans: Array<{ playerId: string; map: string }>;
  mapOrder: string[];
  gameResults: GameResult[];
  wins: [number, number];
  phase: "bans" | "await_loser" | "await_pick" | "done";
  expectedPicker?: string;
}

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

function formatSeriesSummary(state: Bo5State): string {
  const lines: string[] = [];
  for (let i = 0; i < state.gameResults.length; i++) {
    const { map, loserId } = state.gameResults[i];
    const winnerIdx = state.players[0] === loserId ? 1 : 0;
    const winnerId = state.players[winnerIdx];
    lines.push(`Game ${i + 1}: **${map}** — ${mention(winnerId)} def. ${mention(loserId)}`);
  }
  // Deciding map queued but not yet played (2-2 scenario)
  if (state.mapOrder.length > state.gameResults.length) {
    const decidingMap = state.mapOrder[state.gameResults.length];
    lines.push(`Game ${state.gameResults.length + 1}: **${decidingMap}** — ⚔️ deciding match`);
  }
  return lines.join("\n");
}

function promptForState(channelId: string, state: Bo5State): ChoicePrompt | undefined {
  if (state.phase === "bans") {
    const playerId = state.players[state.bans.length];
    return {
      channelId,
      playerId,
      action: "ban",
      options: [...state.remainingMaps],
      instructions: `🚫 Ban one map. Ban order is AB (${state.bans.length + 1}/2).`
    };
  }

  if (state.phase === "await_pick" && state.expectedPicker) {
    return {
      channelId,
      playerId: state.expectedPicker,
      action: "pick",
      options: [...state.remainingMaps],
      instructions: `✅ You lost the last game — pick the next map (${state.mapOrder.length + 1}/5).`
    };
  }

  return undefined;
}

function randomIndex(length: number, rng: () => number): number {
  return Math.max(0, Math.min(length - 1, Math.floor(rng() * length)));
}

export class Bo5Strategy implements VetoStrategy {
  readonly mode = "bo5" as const;

  start(channelId: string, players: [string, string], mapPool: string[]): StartResult {
    validateMapPool(mapPool);
    const state: Bo5State = {
      players,
      remainingMaps: [...mapPool],
      bans: [],
      mapOrder: [],
      gameResults: [],
      wins: [0, 0],
      phase: "bans"
    };

    return {
      state,
      publicMessages: [
        `🗺️ **BO5 veto started** between ${mention(players[0])} and ${mention(players[1])}.`,
        `📋 **Rules:** Both players ban 1 map each (AB order), then a starting map is 🎲 randomly selected. The loser of each game picks the next map. First to 3 wins takes the series — a 2-2 tie leads to an ⚔️ deciding match.`,
        `🪙 Coin flip: ${mention(players[0])} bans first, then ${mention(players[1])}.`
      ],
      nextPrompt: promptForState(channelId, state),
      completed: false
    };
  }

  getPrompt(channelId: string, rawState: unknown): ChoicePrompt | undefined {
    return promptForState(channelId, rawState as Bo5State);
  }

  getStatusSummary(rawState: unknown): string {
    const state = rawState as Bo5State;
    const lines: string[] = [];
    if (state.bans.length > 0) {
      lines.push(`🚫 Bans: ${state.bans.map((b) => `**${b.map}** by ${mention(b.playerId)}`).join(", ")}`);
    }
    if (state.gameResults.length > 0) {
      const [w0, w1] = state.wins;
      lines.push(`📊 Score: ${mention(state.players[0])} **${w0}** – **${w1}** ${mention(state.players[1])}`);
      for (let i = 0; i < state.gameResults.length; i++) {
        const { map, loserId } = state.gameResults[i];
        const winnerIdx = state.players[0] === loserId ? 1 : 0;
        lines.push(`  Game ${i + 1}: **${map}** — ${mention(state.players[winnerIdx])} def. ${mention(loserId)}`);
      }
    } else if (state.mapOrder.length > 0) {
      lines.push(`🎲 Starting map: **${state.mapOrder[0]}**`);
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
    const state = rawState as Bo5State;
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

    if (prompt.action === "ban") {
      state.bans.push({ playerId: userId, map });
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
      publicMessages.push(`🚫 ${mention(userId)} banned **${map}**.`);
      if (state.bans.length === 2) {
        const startingIdx = randomIndex(state.remainingMaps.length, rng);
        const startingMap = state.remainingMaps[startingIdx];
        state.remainingMaps = state.remainingMaps.filter((m) => m !== startingMap);
        state.mapOrder.push(startingMap);
        state.phase = "await_loser";
        publicMessages.push(`🎲 Randomly selected starting map: **${startingMap}**.`);
        publicMessages.push(`Moderator: report each game loser with \`/vetonext loser:@player\`.`);
      }
    } else {
      state.mapOrder.push(map);
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
      publicMessages.push(`✅ ${mention(userId)} picked **${map}** (map ${state.mapOrder.length}/5).`);
      state.phase = "await_loser";
      state.expectedPicker = undefined;
    }

    return {
      nextState: state,
      result: {
        publicMessages,
        nextPrompt: promptForState(channelId, state),
        completed: false
      }
    };
  }

  applyLoser(
    channelId: string,
    rawState: unknown,
    loserId: string
  ): { nextState: unknown; result: VetoResult } {
    const state = rawState as Bo5State;
    if (!state.players.includes(loserId)) {
      throw new Error("Reported loser is not one of the veto players.");
    }
    if (state.phase === "bans") {
      throw new Error("Bans are not finished yet. Both players must ban a map first.");
    }
    if (state.phase === "await_pick") {
      throw new Error("Still waiting for the currently reported loser to pick.");
    }
    if (state.phase === "done") {
      throw new Error("This BO5 veto is already complete.");
    }

    // Record result for the map currently being played.
    const currentMap = state.mapOrder[state.gameResults.length];
    state.gameResults.push({ map: currentMap, loserId });

    const loserIdx = state.players[0] === loserId ? 0 : 1;
    const winnerIdx = 1 - loserIdx as 0 | 1;
    state.wins[winnerIdx]++;

    const [w0, w1] = state.wins;
    const scoreStr = `${mention(state.players[0])} ${w0}–${w1} ${mention(state.players[1])}`;
    const publicMessages: string[] = [
      `💀 ${mention(loserId)} lost game ${state.gameResults.length}. Score: ${scoreStr}`
    ];

    // Series decided (3 wins).
    if (state.wins[winnerIdx] >= 3) {
      state.phase = "done";
      const winner = state.players[winnerIdx];
      const score = `${Math.max(w0, w1)}-${Math.min(w0, w1)}`;
      publicMessages.push(`🏆 ${mention(winner)} wins the series ${score}!\n\n${formatSeriesSummary(state)}`);
      return { nextState: state, result: { publicMessages, completed: true } };
    }

    // Tied 2-2 with only one map remaining — auto-select the deciding map, then await final result.
    if (state.remainingMaps.length === 1) {
      const decidingMap = state.remainingMaps[0];
      state.mapOrder.push(decidingMap);
      state.remainingMaps = [];
      state.phase = "await_loser";
      publicMessages.push(`⚔️ Series tied 2-2! Deciding map: **${decidingMap}**. Use \`/vetonext\` to report the winner.`);
      return { nextState: state, result: { publicMessages, completed: false } };
    }

    // Series continues — loser picks next map.
    state.phase = "await_pick";
    state.expectedPicker = loserId;

    return {
      nextState: state,
      result: {
        publicMessages,
        nextPrompt: promptForState(channelId, state),
        completed: false
      }
    };
  }
}
