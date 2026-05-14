import type { ChoicePrompt, VetoResult } from "./types";
import type { StartResult, VetoStrategy } from "./strategy";

interface GameResult {
  map: string;
  loserId: string;
}

interface Bo5WinnerAState {
  players: [string, string]; // [A, B]
  remainingMaps: string[];
  bans: Array<{ playerId: string; map: string }>;
  mapOrder: string[];
  gameResults: GameResult[];
  wins: [number, number];
  phase: "bans" | "initial_picks" | "await_loser" | "await_pick" | "done";
  expectedPicker?: string;
}

const BAN_ORDER: [number, number] = [1, 0]; // B then A
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

function formatSeriesSummary(state: Bo5WinnerAState): string {
  const lines: string[] = [];
  for (let i = 0; i < state.gameResults.length; i++) {
    const { map, loserId } = state.gameResults[i];
    const winnerIdx = state.players[0] === loserId ? 1 : 0;
    const winnerId = state.players[winnerIdx];
    lines.push(`Game ${i + 1}: **${map}** — ${mention(winnerId)} won vs ${mention(loserId)}`);
  }
  return lines.join("\n");
}

function promptForState(channelId: string, state: Bo5WinnerAState): ChoicePrompt | undefined {
  if (state.phase === "bans") {
    const playerId = state.players[BAN_ORDER[state.bans.length]];
    const label = state.bans.length === 0 ? "B" : "A";
    return {
      channelId,
      playerId,
      action: "ban",
      options: [...state.remainingMaps],
      instructions: `🚫 Ban one map. Ban order is BA (${state.bans.length + 1}/2). This is Player ${label}'s ban.`
    };
  }

  if (state.phase === "initial_picks") {
    const nextMap = state.mapOrder.length + 1;
    return {
      channelId,
      playerId: state.players[0],
      action: "pick",
      options: [...state.remainingMaps],
      instructions: `✅ Player A picks Map ${nextMap}. Pick order is AA for Maps 1 and 2.`
    };
  }

  if (state.phase === "await_pick" && state.expectedPicker) {
    return {
      channelId,
      playerId: state.expectedPicker,
      action: "pick",
      options: [...state.remainingMaps],
      instructions: `✅ You lost the last map — pick the next map (${state.mapOrder.length + 1}/5).`
    };
  }

  return undefined;
}

export class Bo5WinnerABanBAPickAALosersPickStrategy implements VetoStrategy {
  readonly mode = "bo5-winnerA-banBA-pickAA-loserspick" as const;

  start(channelId: string, players: [string, string], mapPool: string[], _startedById?: string): StartResult {
    validateMapPool(mapPool);
    const state: Bo5WinnerAState = {
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
        `📋 **Rules:** ${mention(players[0])} is Player A (winner-side advantage), ${mention(players[1])} is Player B. Bans are BA, then A picks Maps 1 and 2. Loser picks Maps 3-5. First to 3 wins.`,
        `🏅 Advantage set: ${mention(players[0])} is A. ${mention(players[1])} is B. Ban order is BA.`
      ],
      nextPrompt: promptForState(channelId, state),
      completed: false
    };
  }

  getPrompt(channelId: string, rawState: unknown): ChoicePrompt | undefined {
    return promptForState(channelId, rawState as Bo5WinnerAState);
  }

  getStatusSummary(rawState: unknown): string {
    const state = rawState as Bo5WinnerAState;
    const lines: string[] = [];
    if (state.bans.length > 0) {
      lines.push(`🚫 Bans: ${state.bans.map((b) => `**${b.map}** by ${mention(b.playerId)}`).join(", ")}`);
    }
    if (state.mapOrder.length > state.gameResults.length) {
      lines.push(`🎮 Next map: **${state.mapOrder[state.gameResults.length]}**`);
    }
    if (state.gameResults.length > 0) {
      const [w0, w1] = state.wins;
      lines.push(`📊 Score: ${mention(state.players[0])} **${w0}** – **${w1}** ${mention(state.players[1])}`);
      for (let i = 0; i < state.gameResults.length; i++) {
        const { map, loserId } = state.gameResults[i];
        const winnerIdx = state.players[0] === loserId ? 1 : 0;
        lines.push(`  Game ${i + 1}: **${map}** — ${mention(state.players[winnerIdx])} won vs ${mention(loserId)}`);
      }
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
    const state = rawState as Bo5WinnerAState;
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
        state.phase = "initial_picks";
        publicMessages.push(`✅ Bans complete. ${mention(state.players[0])} (Player A) now picks Maps 1 and 2.`);
      }
    } else {
      state.mapOrder.push(map);
      state.remainingMaps = state.remainingMaps.filter((m) => m !== map);

      if (state.phase === "initial_picks") {
        if (state.mapOrder.length === 1) {
          publicMessages.push(`✅ ${mention(userId)} picked **${map}** as Map 1.`);
        } else {
          state.phase = "await_loser";
          publicMessages.push(`✅ ${mention(userId)} picked **${map}** as Map 2.`);
          publicMessages.push(
            `🗺️ Opening maps set:\n1. **${state.mapOrder[0]}**\n2. **${state.mapOrder[1]}**\nModerator: report each map loser with \`/vetonext loser:@player\`.`
          );
        }
      } else {
        publicMessages.push(`✅ ${mention(userId)} picked **${map}** (map ${state.mapOrder.length}/5).`);
        if (state.remainingMaps.length > 0) {
          publicMessages.push(`🗺️ Remaining maps: ${state.remainingMaps.map((m) => `**${m}**`).join(", ")}`);
        }
        state.phase = "await_loser";
        state.expectedPicker = undefined;
      }
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
    const state = rawState as Bo5WinnerAState;
    if (!state.players.includes(loserId)) {
      throw new Error("Reported loser is not one of the veto players.");
    }
    if (state.phase === "bans" || state.phase === "initial_picks") {
      throw new Error("Opening bans/picks are not finished yet.");
    }
    if (state.phase === "await_pick") {
      throw new Error("Still waiting for the currently reported loser to pick.");
    }
    if (state.phase === "done") {
      throw new Error("This BO5 veto is already complete.");
    }

    const currentMap = state.mapOrder[state.gameResults.length];
    if (!currentMap) {
      throw new Error("No map is currently set to record a loser for.");
    }

    state.gameResults.push({ map: currentMap, loserId });
    const loserIdx = state.players[0] === loserId ? 0 : 1;
    const winnerIdx = 1 - loserIdx as 0 | 1;
    state.wins[winnerIdx]++;

    const [w0, w1] = state.wins;
    const scoreStr = `${mention(state.players[0])} ${w0}–${w1} ${mention(state.players[1])}`;
    const publicMessages: string[] = [
      `💀 ${mention(loserId)} lost game ${state.gameResults.length}. Score: ${scoreStr}`
    ];

    if (state.wins[winnerIdx] >= 3) {
      state.phase = "done";
      const winner = state.players[winnerIdx];
      const score = `${Math.max(w0, w1)}-${Math.min(w0, w1)}`;
      publicMessages.push(`🏆 ${mention(winner)} wins the series ${score}!\n\n${formatSeriesSummary(state)}`);
      return { nextState: state, result: { publicMessages, completed: true } };
    }

    // Map 2 is pre-set by A, so no loser pick after game 1.
    if (state.gameResults.length === 1 && state.mapOrder.length >= 2) {
      state.phase = "await_loser";
      publicMessages.push(`🎮 Map 2 is already set: **${state.mapOrder[1]}**.`);
      publicMessages.push(`Moderator: report the next loser with \`/vetonext loser:@player\`.`);
      return { nextState: state, result: { publicMessages, completed: false } };
    }

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

