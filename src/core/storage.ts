import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { VetoSession } from "./types";

export interface GuildConfigStore {
  getModRole(guildId: string): string | null;
  setModRole(guildId: string, roleId: string): void;
}

export interface SessionStore {
  loadAll(): VetoSession[];
  upsert(session: VetoSession): void;
  delete(channelId: string): void;
}

export class InMemoryGuildConfigStore implements GuildConfigStore {
  private roles = new Map<string, string>();
  getModRole(guildId: string): string | null {
    return this.roles.get(guildId) ?? null;
  }
  setModRole(guildId: string, roleId: string): void {
    this.roles.set(guildId, roleId);
  }
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, VetoSession>();

  loadAll(): VetoSession[] {
    return Array.from(this.sessions.values()).map((session) => structuredClone(session));
  }

  upsert(session: VetoSession): void {
    this.sessions.set(session.channelId, structuredClone(session));
  }

  delete(channelId: string): void {
    this.sessions.delete(channelId);
  }
}

export class SQLiteSessionStore implements SessionStore, GuildConfigStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS veto_sessions (
        channel_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        players_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        completed INTEGER NOT NULL,
        history_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        mod_role_id TEXT NOT NULL
      )
    `);
  }

  loadAll(): VetoSession[] {
    const rows = this.db
      .query(
        "SELECT channel_id, mode, players_json, state_json, completed, history_json FROM veto_sessions"
      )
      .all() as Array<{
      channel_id: string;
      mode: "bo3" | "bo5";
      players_json: string;
      state_json: string;
      completed: 0 | 1;
      history_json: string;
    }>;

    return rows.map((row) => ({
      channelId: row.channel_id,
      mode: row.mode,
      players: JSON.parse(row.players_json) as [string, string],
      state: JSON.parse(row.state_json) as unknown,
      completed: row.completed === 1,
      history: JSON.parse(row.history_json) as VetoSession["history"]
    }));
  }

  upsert(session: VetoSession): void {
    this.db
      .query(
        `INSERT INTO veto_sessions
        (channel_id, mode, players_json, state_json, completed, history_json, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(channel_id) DO UPDATE SET
          mode = excluded.mode,
          players_json = excluded.players_json,
          state_json = excluded.state_json,
          completed = excluded.completed,
          history_json = excluded.history_json,
          updated_at = excluded.updated_at`
      )
      .run(
        session.channelId,
        session.mode,
        JSON.stringify(session.players),
        JSON.stringify(session.state),
        session.completed ? 1 : 0,
        JSON.stringify(session.history),
        Date.now()
      );
  }

  delete(channelId: string): void {
    this.db.query("DELETE FROM veto_sessions WHERE channel_id = ?1").run(channelId);
  }

  getModRole(guildId: string): string | null {
    const row = this.db
      .query("SELECT mod_role_id FROM guild_config WHERE guild_id = ?1")
      .get(guildId) as { mod_role_id: string } | null;
    return row?.mod_role_id ?? null;
  }

  setModRole(guildId: string, roleId: string): void {
    this.db
      .query(
        `INSERT INTO guild_config (guild_id, mod_role_id) VALUES (?1, ?2)
         ON CONFLICT(guild_id) DO UPDATE SET mod_role_id = excluded.mod_role_id`
      )
      .run(guildId, roleId);
  }
}
