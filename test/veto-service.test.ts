import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VetoService } from "../src/core/veto-service";
import { InMemorySessionStore, SQLiteSessionStore } from "../src/core/storage";

const MAPS = ["A", "B", "C", "D", "E", "F", "G"];

const coinHeads = () => 0.1;
const randomMid = () => 0.6;

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles.splice(0, tempFiles.length)) {
    rmSync(file, { force: true });
  }
});

describe("VetoService BO3", () => {
  it("runs ABBA bans then AB picks then final map", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    const started = service.startVeto({
      channelId: "ch1",
      mode: "bo3-banABBA-pickAB",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    expect(started.nextPrompt?.playerId).toBe("p1");
    expect(started.nextPrompt?.action).toBe("ban");

    service.handleChoice("ch1", "p1", "A");
    service.handleChoice("ch1", "p2", "B");
    service.handleChoice("ch1", "p2", "C");
    service.handleChoice("ch1", "p1", "D");
    service.handleChoice("ch1", "p1", "E");
    const final = service.handleChoice("ch1", "p2", "F");

    expect(final.completed).toBe(true);
    expect(final.publicMessages.some((m) => m.includes("BO3 map order"))).toBe(true);
    expect(final.publicMessages.join(" ")).toContain("1. **E**");
    expect(final.publicMessages.join(" ")).toContain("picked by <@p1>");
    expect(final.publicMessages.join(" ")).toContain("picked by <@p2>");
    expect(final.publicMessages.join(" ")).toContain("⚔️ deciding match");
  });

  it("enforces turn order and map availability", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "ch1",
      mode: "bo3-banABBA-pickAB",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });

    expect(() => service.handleChoice("ch1", "p2", "A")).toThrow("NOT_YOUR_TURN");
    expect(() => service.handleChoice("ch1", "p1", "Z")).toThrow("not available");
  });

  it("supports undo", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "ch1",
      mode: "bo3-banABBA-pickAB",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    service.handleChoice("ch1", "p1", "A");
    const undone = service.undo("ch1");

    expect(undone.publicMessages[0]).toContain("undone");
    expect(undone.nextPrompt?.playerId).toBe("p1");
    expect(undone.nextPrompt?.options).toContain("A");
  });

  it("allows self veto sessions for testing", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    const started = service.startVeto({
      channelId: "self-ch",
      mode: "bo3-banABBA-pickAB",
      playerOneId: "p1",
      playerTwoId: "p1",
      mapPool: MAPS
    });

    expect(started.nextPrompt?.playerId).toBe("p1");
    expect(() => service.handleChoice("self-ch", "p1", "A")).not.toThrow();
  });
});

describe("VetoService BO3 admin-first", () => {
  it("runs admin first pick, ABBA bans, loser picks game 2, then final map", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    const started = service.startVeto({
      channelId: "ch-af",
      mode: "bo3-adminfirst-banABBA-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      startedById: "mod1",
      mapPool: MAPS
    });

    expect(started.nextPrompt?.playerId).toBe("mod1");
    expect(started.nextPrompt?.action).toBe("pick");

    // Host picks game 1 map.
    const afterHostPick = service.handleChoice("ch-af", "mod1", "A");
    expect(afterHostPick.publicMessages.join(" ")).toContain("selected **A** as game 1");
    expect(afterHostPick.publicMessages.join(" ")).toContain("Coin flip");

    // ABBA bans among players.
    service.handleChoice("ch-af", "p1", "B");
    service.handleChoice("ch-af", "p2", "C");
    service.handleChoice("ch-af", "p2", "D");
    const afterBans = service.handleChoice("ch-af", "p1", "E");
    expect(afterBans.publicMessages.join(" ")).toContain("Bans complete");
    expect(afterBans.publicMessages.join(" ")).toContain("Game 1 will be played on **A**");

    // Report loser of game 1, loser picks game 2, game 3 is auto final.
    const loserPrompt = service.recordLoser("ch-af", "p2");
    expect(loserPrompt.nextPrompt?.playerId).toBe("p2");
    const done = service.handleChoice("ch-af", "p2", "F");

    expect(done.completed).toBe(true);
    expect(done.publicMessages.join(" ")).toContain("BO3 map order");
    expect(done.publicMessages.join(" ")).toContain("1. **A**");
    expect(done.publicMessages.join(" ")).toContain("2. **F**");
    expect(done.publicMessages.join(" ")).toContain("3. **G**");
  });

  it("does not allow /vetonext before bans finish", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "ch-af-2",
      mode: "bo3-adminfirst-banABBA-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      startedById: "mod1",
      mapPool: MAPS
    });

    expect(() => service.recordLoser("ch-af-2", "p1")).toThrow("Bans are not finished yet");
  });
});

describe("VetoService BO5", () => {
  it("runs full 3-2 series: bans, random first map, loser picks, deciding map on tie", () => {
    const service = new VetoService(() => 0.8, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "ch2",
      mode: "bo5-banAB-randomfirst-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });

    // Bans
    service.handleChoice("ch2", "p2", "A");
    const afterBan = service.handleChoice("ch2", "p1", "B");
    expect(afterBan.nextPrompt).toBeUndefined();
    expect(afterBan.publicMessages.join(" ")).toContain("Randomly selected starting map");

    // Game 1: p1 loses → picks map 2
    const step1 = service.recordLoser("ch2", "p1");
    expect(step1.nextPrompt?.playerId).toBe("p1");
    expect(step1.publicMessages.join(" ")).toContain("1–0");
    service.handleChoice("ch2", "p1", step1.nextPrompt!.options[0]);

    // Game 2: p2 loses → picks map 3
    const step2 = service.recordLoser("ch2", "p2");
    expect(step2.publicMessages.join(" ")).toContain("1–1");
    service.handleChoice("ch2", "p2", step2.nextPrompt!.options[0]);

    // Game 3: p1 loses → picks map 4
    const step3 = service.recordLoser("ch2", "p1");
    expect(step3.publicMessages.join(" ")).toContain("2–1");
    service.handleChoice("ch2", "p1", step3.nextPrompt!.options[0]);

    // Game 4: p2 loses → tied 2-2, only one map left → deciding map announced
    const tied = service.recordLoser("ch2", "p2");
    expect(tied.completed).toBe(false);
    expect(tied.publicMessages.join(" ")).toContain("2-2");
    expect(tied.publicMessages.join(" ")).toContain("Deciding map");

    // Game 5: p1 loses → p2 wins 3-2
    const done = service.recordLoser("ch2", "p1");
    expect(done.completed).toBe(true);
    expect(done.publicMessages.join(" ")).toContain("3-2");
    expect(done.publicMessages.join(" ")).toContain("Game 1:");
    expect(done.publicMessages.join(" ")).toContain("Game 5:");
  });

  it("stops early on 3-0", () => {
    const service = new VetoService(() => 0.8, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "ch2b",
      mode: "bo5-banAB-randomfirst-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });

    service.handleChoice("ch2b", "p2", "A");
    service.handleChoice("ch2b", "p1", "B");

    // p2 loses all 3 games → p1 wins 3-0
    const step1 = service.recordLoser("ch2b", "p2");
    service.handleChoice("ch2b", "p2", step1.nextPrompt!.options[0]);
    const step2 = service.recordLoser("ch2b", "p2");
    service.handleChoice("ch2b", "p2", step2.nextPrompt!.options[0]);
    const done = service.recordLoser("ch2b", "p2");

    expect(done.completed).toBe(true);
    expect(done.publicMessages.join(" ")).toContain("3-0");
    expect(done.publicMessages.join(" ")).toContain("Game 3:");
    expect(done.publicMessages.join(" ")).not.toContain("Game 4:");
  });

  it("stops early on 3-1", () => {
    const service = new VetoService(() => 0.8, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "ch2c",
      mode: "bo5-banAB-randomfirst-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });

    service.handleChoice("ch2c", "p2", "A");
    service.handleChoice("ch2c", "p1", "B");

    // p1 loses game 1, then p2 loses games 2-4
    const step1 = service.recordLoser("ch2c", "p1");
    service.handleChoice("ch2c", "p1", step1.nextPrompt!.options[0]);
    const step2 = service.recordLoser("ch2c", "p2");
    service.handleChoice("ch2c", "p2", step2.nextPrompt!.options[0]);
    const step3 = service.recordLoser("ch2c", "p2");
    service.handleChoice("ch2c", "p2", step3.nextPrompt!.options[0]);
    const done = service.recordLoser("ch2c", "p2");

    expect(done.completed).toBe(true);
    expect(done.publicMessages.join(" ")).toContain("3-1");
    expect(done.publicMessages.join(" ")).toContain("Game 4:");
    expect(done.publicMessages.join(" ")).not.toContain("Game 5:");
  });

  it("requires /vetonext in bo5 and rejects it in bo3", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "ch3",
      mode: "bo3-banABBA-pickAB",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    expect(() => service.recordLoser("ch3", "p1")).toThrow("/vetonext");
  });
});

describe("VetoService persistence", () => {
  it("restores sessions from sqlite after restart", () => {
    const dbPath = join(tmpdir(), `veto-bot-test-${crypto.randomUUID()}.sqlite`);
    tempFiles.push(dbPath);

    const store1 = new SQLiteSessionStore(dbPath);
    const service1 = new VetoService(coinHeads, randomMid, store1);
    service1.startVeto({
      channelId: "persist-channel",
      mode: "bo3-banABBA-pickAB",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    service1.handleChoice("persist-channel", "p1", "A");

    const store2 = new SQLiteSessionStore(dbPath);
    const service2 = new VetoService(coinHeads, randomMid, store2);
    const prompt = service2.getCurrentPrompt("persist-channel");

    expect(prompt?.playerId).toBe("p2");
    expect(prompt?.options).not.toContain("A");
  });
});
