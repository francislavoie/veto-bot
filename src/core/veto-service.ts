import { Bo3Strategy } from "./bo3-banABBA-pickAB-strategy";
import { Bo5Strategy } from "./bo5-banAB-randomfirst-loserspick-strategy";
import { Bo5WinnerABanBAPickAALosersPickStrategy } from "./bo5-winnerA-banBA-pickAA-loserspick-strategy";
import { Bo3AdminFirstBanABBALosersPickStrategy } from "./bo3-adminfirst-banABBA-loserspick-strategy";
import { Bo3BanABBARandomFirstLosersPickStrategy } from "./bo3-banABBA-randomfirst-loserspick-strategy";
import type { VetoMode, VetoResult, VetoSession } from "./types";
import type { VetoStrategy } from "./strategy";
import { InMemorySessionStore, type SessionStore } from "./storage";

interface StartVetoInput {
  channelId: string;
  mode: VetoMode;
  playerOneId: string;
  playerTwoId: string;
  advantagedPlayerId?: string;
  startedById?: string;
  mapPool: string[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class VetoService {
  private sessions = new Map<string, VetoSession>();
  private strategies: Record<string, VetoStrategy> = {
    "bo3-banABBA-pickAB": new Bo3Strategy(),
    "bo5-banAB-randomfirst-loserspick": new Bo5Strategy(),
    "bo5-winnerA-banBA-pickAA-loserspick": new Bo5WinnerABanBAPickAALosersPickStrategy(),
    "bo3-adminfirst-banABBA-loserspick": new Bo3AdminFirstBanABBALosersPickStrategy(),
    "bo3-banABBA-randomfirst-loserspick": new Bo3BanABBARandomFirstLosersPickStrategy(),
    // Legacy aliases for persisted sessions.
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
    const orderedPlayers: [string, string] = input.mode === "bo5-winnerA-banBA-pickAA-loserspick"
      ? (() => {
          if (!input.advantagedPlayerId) {
            throw new Error("Choose which player is advantaged as A for this mode.");
          }
          if (input.advantagedPlayerId === input.playerOneId) {
            return [input.playerOneId, input.playerTwoId];
          }
          if (input.advantagedPlayerId === input.playerTwoId) {
            return [input.playerTwoId, input.playerOneId];
          }
          throw new Error("Advantaged player must be one of the two veto players.");
        })()
      : this.rngCoin() < 0.5
        ? [input.playerOneId, input.playerTwoId]
        : [input.playerTwoId, input.playerOneId];
    const strategy = this.strategies[input.mode];
    if (!strategy) {
      throw new Error(`Unsupported veto mode "${input.mode}".`);
    }
    const start = strategy.start(input.channelId, orderedPlayers, input.mapPool, input.startedById);

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

    return {
      publicMessages: start.publicMessages,
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
