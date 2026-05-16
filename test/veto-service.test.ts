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
    expect(afterHostPick.publicMessages.join(" ")).toContain("selected **A** as Map 1");
    expect(afterHostPick.publicMessages.join(" ")).toContain("Coin flip");

    // ABBA bans among players.
    service.handleChoice("ch-af", "p1", "B");
    service.handleChoice("ch-af", "p2", "C");
    service.handleChoice("ch-af", "p2", "D");
    const afterBans = service.handleChoice("ch-af", "p1", "E");
    expect(afterBans.publicMessages.join(" ")).toContain("Bans complete");
    expect(afterBans.publicMessages.join(" ")).toContain("Map 1 was picked by the admin: **A**");
    expect(afterBans.publicMessages.join(" ")).toContain("Second map will be loser's pick, from the remaining maps: **F**, **G**");

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

  it("reminds the moderator to report the loser again after undoing /vetonext", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "ch-af-3",
      mode: "bo3-adminfirst-banABBA-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      startedById: "mod1",
      mapPool: MAPS
    });

    service.handleChoice("ch-af-3", "mod1", "A");
    service.handleChoice("ch-af-3", "p1", "B");
    service.handleChoice("ch-af-3", "p2", "C");
    service.handleChoice("ch-af-3", "p2", "D");
    service.handleChoice("ch-af-3", "p1", "E");
    service.recordLoser("ch-af-3", "p2");

    const undone = service.undo("ch-af-3");
    expect(undone.publicMessages.join(" ")).toContain("Awaiting Map 1 loser report");
    expect(undone.nextPrompt).toBeUndefined();
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

describe("VetoService BO5 winner A", () => {
  it("runs BA bans, A picks first two maps, then loser picks remaining maps", () => {
    const service = new VetoService(() => 0.9, randomMid, new InMemorySessionStore());
    const started = service.startVeto({
      channelId: "chw1",
      mode: "bo5-winnerA-banBA-pickAA-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      advantagedPlayerId: "p1",
      mapPool: MAPS
    });

    expect(started.publicMessages.join(" ")).toContain("Advantage set: <@p1> is A");
    expect(started.nextPrompt?.playerId).toBe("p2");
    expect(started.nextPrompt?.action).toBe("ban");

    // BA bans
    service.handleChoice("chw1", "p2", "A");
    const afterSecondBan = service.handleChoice("chw1", "p1", "B");
    expect(afterSecondBan.nextPrompt?.playerId).toBe("p1");
    expect(afterSecondBan.nextPrompt?.action).toBe("pick");

    // A picks first two maps
    const firstPick = service.handleChoice("chw1", "p1", "C");
    expect(firstPick.nextPrompt?.playerId).toBe("p1");
    const secondPick = service.handleChoice("chw1", "p1", "D");
    expect(secondPick.nextPrompt).toBeUndefined();

    // Game 1 loser -> map 2 already set
    const g1 = service.recordLoser("chw1", "p2"); // p1 up 1-0
    expect(g1.publicMessages.join(" ")).toContain("Map 2 is already set: **D**");
    expect(g1.nextPrompt).toBeUndefined();

    // Game 2 loser -> loser picks map 3
    const g2 = service.recordLoser("chw1", "p1"); // 1-1
    expect(g2.nextPrompt?.playerId).toBe("p1");
    const g3Pick = service.handleChoice("chw1", "p1", "E");
    expect(g3Pick.publicMessages.join(" ")).toContain("Remaining maps: **F**, **G**");

    // Game 3 loser -> loser picks map 4
    const g3 = service.recordLoser("chw1", "p1"); // p2 leads 2-1
    expect(g3.nextPrompt?.playerId).toBe("p1");
    service.handleChoice("chw1", "p1", "F");

    // Game 4 loser -> loser picks map 5
    const g4 = service.recordLoser("chw1", "p2"); // 2-2
    expect(g4.nextPrompt?.playerId).toBe("p2");
    service.handleChoice("chw1", "p2", "G");

    // Game 5 result
    const done = service.recordLoser("chw1", "p2"); // p1 wins 3-2
    expect(done.completed).toBe(true);
    expect(done.publicMessages.join(" ")).toContain("3-2");
    expect(done.publicMessages.join(" ")).toContain("won vs");
    expect(done.publicMessages.join(" ")).toContain("Game 5:");
  });

  it("stops early on 3-0", () => {
    const service = new VetoService(() => 0.9, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "chw2",
      mode: "bo5-winnerA-banBA-pickAA-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      advantagedPlayerId: "p1",
      mapPool: MAPS
    });

    service.handleChoice("chw2", "p2", "A");
    service.handleChoice("chw2", "p1", "B");
    service.handleChoice("chw2", "p1", "C");
    service.handleChoice("chw2", "p1", "D");

    // p2 loses games 1,2,3 => p1 wins 3-0
    service.recordLoser("chw2", "p2");
    const g2 = service.recordLoser("chw2", "p2");
    service.handleChoice("chw2", "p2", g2.nextPrompt!.options[0]);
    const done = service.recordLoser("chw2", "p2");

    expect(done.completed).toBe(true);
    expect(done.publicMessages.join(" ")).toContain("3-0");
    expect(done.publicMessages.join(" ")).not.toContain("Game 4:");
  });

  it("allows explicitly setting player2 as advantaged A", () => {
    const service = new VetoService(() => 0.1, randomMid, new InMemorySessionStore());
    const started = service.startVeto({
      channelId: "chw3",
      mode: "bo5-winnerA-banBA-pickAA-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      advantagedPlayerId: "p2",
      mapPool: MAPS
    });

    expect(started.publicMessages.join(" ")).toContain("Advantage set: <@p2> is A");
    expect(started.nextPrompt?.playerId).toBe("p1");
  });

  it("requires advantaged A to be provided in winner-A mode", () => {
    const service = new VetoService(() => 0.1, randomMid, new InMemorySessionStore());
    expect(() =>
      service.startVeto({
        channelId: "chw4",
        mode: "bo5-winnerA-banBA-pickAA-loserspick",
        playerOneId: "p1",
        playerTwoId: "p2",
        mapPool: MAPS
      })
    ).toThrow("Choose which player is advantaged as A");
  });
});

describe("VetoService BO3 ABBA random-first loser's pick", () => {
  it("runs full flow: ABBA bans → random map 1 → loser picks map 2 → deciding map", () => {
    // randomMid = 0.6 → with 3 remaining, index = floor(0.6*3) = 1 → second map
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    const started = service.startVeto({
      channelId: "chrf1",
      mode: "bo3-banABBA-randomfirst-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    // Coin says p1 is A, bans first
    expect(started.nextPrompt?.playerId).toBe("p1");
    expect(started.nextPrompt?.action).toBe("ban");

    // ABBA bans: A=p1, B=p2, B=p2, A=p1 → bans A,B,C,D; remaining E,F,G
    service.handleChoice("chrf1", "p1", "A");
    service.handleChoice("chrf1", "p2", "B");
    service.handleChoice("chrf1", "p2", "C");
    const afterBans = service.handleChoice("chrf1", "p1", "D");

    // After 4 bans, phase is await_loser; randomMid on 3 items picks index 1 = F
    expect(afterBans.completed).toBe(false);
    expect(afterBans.nextPrompt).toBeUndefined();
    expect(afterBans.publicMessages.join(" ")).toContain("Randomly selected Map 1: **F**");
    expect(afterBans.publicMessages.join(" ")).toContain("Map 2 will be loser's pick");

    // Mod reports loser of Map 1
    const loserResult = service.recordLoser("chrf1", "p2");
    expect(loserResult.nextPrompt?.playerId).toBe("p2");
    expect(loserResult.nextPrompt?.action).toBe("pick");
    expect(loserResult.nextPrompt?.options).toEqual(expect.arrayContaining(["E", "G"]));
    expect(loserResult.nextPrompt?.options).not.toContain("F");

    // Loser picks map 2
    const done = service.handleChoice("chrf1", "p2", "E");
    expect(done.completed).toBe(true);
    expect(done.publicMessages.join(" ")).toContain("BO3 map order");
    expect(done.publicMessages.join(" ")).toContain("1. **F**");
    expect(done.publicMessages.join(" ")).toContain("2. **E**");
    expect(done.publicMessages.join(" ")).toContain("3. **G**");
    expect(done.publicMessages.join(" ")).toContain("deciding match");
  });

  it("enforces turn order during bans", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "chrf2",
      mode: "bo3-banABBA-randomfirst-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    // p2 cannot ban first — it's p1's turn (A)
    expect(() => service.handleChoice("chrf2", "p2", "A")).toThrow("NOT_YOUR_TURN");
    expect(() => service.handleChoice("chrf2", "p1", "Z")).toThrow("not available");
  });

  it("rejects /vetonext before bans are done", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "chrf3",
      mode: "bo3-banABBA-randomfirst-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    expect(() => service.recordLoser("chrf3", "p1")).toThrow("Bans are not finished");
  });

  it("rejects /vetonext while awaiting loser's pick", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "chrf4",
      mode: "bo3-banABBA-randomfirst-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    service.handleChoice("chrf4", "p1", "A");
    service.handleChoice("chrf4", "p2", "B");
    service.handleChoice("chrf4", "p2", "C");
    service.handleChoice("chrf4", "p1", "D");
    service.recordLoser("chrf4", "p2");
    expect(() => service.recordLoser("chrf4", "p1")).toThrow("Still waiting");
  });

  it("supports undo from loser's pick back to await_loser", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "chrf5",
      mode: "bo3-banABBA-randomfirst-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    service.handleChoice("chrf5", "p1", "A");
    service.handleChoice("chrf5", "p2", "B");
    service.handleChoice("chrf5", "p2", "C");
    service.handleChoice("chrf5", "p1", "D");
    service.recordLoser("chrf5", "p2");
    service.handleChoice("chrf5", "p2", "E"); // loser picks map 2
    const undone = service.undo("chrf5");
    expect(undone.nextPrompt?.playerId).toBe("p2"); // loser's pick prompt restored
    expect(undone.nextPrompt?.action).toBe("pick");
  });

  it("supports undo from await_loser back to bans", () => {
    const service = new VetoService(coinHeads, randomMid, new InMemorySessionStore());
    service.startVeto({
      channelId: "chrf6",
      mode: "bo3-banABBA-randomfirst-loserspick",
      playerOneId: "p1",
      playerTwoId: "p2",
      mapPool: MAPS
    });
    service.handleChoice("chrf6", "p1", "A");
    service.handleChoice("chrf6", "p2", "B");
    service.handleChoice("chrf6", "p2", "C");
    service.handleChoice("chrf6", "p1", "D"); // bans done → await_loser
    const undone = service.undo("chrf6"); // undo 4th ban
    expect(undone.nextPrompt?.playerId).toBe("p1"); // 4th ban was p1's (A)
    expect(undone.nextPrompt?.action).toBe("ban");
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
