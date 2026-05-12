import { Bo3Strategy } from "./bo3-strategy";
import { Bo5Strategy } from "./bo5-strategy";
import type { VetoMode, VetoResult, VetoSession } from "./types";
import type { VetoStrategy } from "./strategy";
import { InMemorySessionStore, type SessionStore } from "./storage";

interface StartVetoInput {
  channelId: string;
  mode: VetoMode;
  playerOneId: string;
  playerTwoId: string;
  mapPool: string[];
}

const mention = (id: string): string => `<@${id}>`;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class VetoService {
  private sessions = new Map<string, VetoSession>();
  private strategies: Record<VetoMode, VetoStrategy> = {
    bo3: new Bo3Strategy(),
    bo5: new Bo5Strategy()
  };

  constructor(
    private readonly rngCoin: () => number = Math.random,
    private readonly rngMap: () => number = Math.random,
    private readonly store: SessionStore = new InMemorySessionStore()
  ) {
    const restoredSessions = this.store.loadAll();
    for (const session of restoredSessions) {
      this.sessions.set(session.channelId, session);
    }
  }

  startVeto(input: StartVetoInput): VetoResult {
    const existing = this.sessions.get(input.channelId);
    if (existing && !existing.completed) {
      throw new Error("A veto is already active in this channel.");
    }
    const coinWinnerIsPlayerOne = this.rngCoin() < 0.5;
    const orderedPlayers: [string, string] = coinWinnerIsPlayerOne
      ? [input.playerOneId, input.playerTwoId]
      : [input.playerTwoId, input.playerOneId];
    const strategy = this.strategies[input.mode];
    const start = strategy.start(input.channelId, orderedPlayers, input.mapPool);

    const session: VetoSession = {
      channelId: input.channelId,
      mode: input.mode,
      players: orderedPlayers,
      state: start.state,
      completed: start.completed,
      history: []
    };
    this.sessions.set(input.channelId, session);
    this.store.upsert(session);

    const coinMessage = `Coin flip: ${mention(orderedPlayers[0])} won and goes first.`;

    return {
      publicMessages: [coinMessage, ...start.publicMessages],
      nextPrompt: start.nextPrompt,
      completed: start.completed
    };
  }

  handleChoice(channelId: string, userId: string, map: string): VetoResult {
    const session = this.getRequiredSession(channelId);
    const strategy = this.strategies[session.mode];
    session.history.push({
      state: clone(session.state),
      completed: session.completed
    });
    const { nextState, result } = strategy.applyChoice(channelId, session.state, userId, map, this.rngMap);
    session.state = nextState;
    session.completed = result.completed;
    this.store.upsert(session);
    return result;
  }

  recordLoser(channelId: string, loserId: string): VetoResult {
    const session = this.getRequiredSession(channelId);
    const strategy = this.strategies[session.mode];
    if (!strategy.applyLoser) {
      throw new Error("This veto mode does not support /vetonext.");
    }
    session.history.push({
      state: clone(session.state),
      completed: session.completed
    });
    const { nextState, result } = strategy.applyLoser(channelId, session.state, loserId);
    session.state = nextState;
    session.completed = result.completed;
    this.store.upsert(session);
    return result;
  }

  undo(channelId: string): VetoResult {
    const session = this.getRequiredSession(channelId);
    const strategy = this.strategies[session.mode];
    const previous = session.history.pop();
    if (!previous) {
      throw new Error("Nothing to undo yet.");
    }
    session.state = previous.state;
    session.completed = previous.completed;
    this.store.upsert(session);

    const status = strategy.getStatusSummary(session.state);
    return {
      publicMessages: ["↩️ Last veto action has been undone.\n" + status],
      nextPrompt: strategy.getPrompt(channelId, session.state),
      completed: session.completed
    };
  }

  getCurrentPrompt(channelId: string) {
    const session = this.getRequiredSession(channelId);
    const strategy = this.strategies[session.mode];
    return strategy.getPrompt(channelId, session.state);
  }

  resetVeto(channelId: string): void {
    this.sessions.delete(channelId);
    this.store.delete(channelId);
  }

  getSession(channelId: string): VetoSession | undefined {
    return this.sessions.get(channelId);
  }

  private getRequiredSession(channelId: string): VetoSession {
    const session = this.sessions.get(channelId);
    if (!session) {
      throw new Error("No veto is active in this channel.");
    }
    return session;
  }
}
