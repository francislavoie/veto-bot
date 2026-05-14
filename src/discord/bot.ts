import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  GuildMemberRoleManager,
  Interaction,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel
} from "discord.js";
import type { AnyThreadChannel } from "discord.js";
import { loadMaps } from "../config";
import { VetoService } from "../core/veto-service";
import type { ChoicePrompt, VetoAction, VetoMode } from "../core/types";
import { SQLiteSessionStore } from "../core/storage";
import type { GuildConfigStore } from "../core/storage";

interface PromptTracker {
  prompt: ChoicePrompt;
  messageId: string;
}

interface PendingAdvantagePrompt {
  channelId: string;
  playerOneId: string;
  playerTwoId: string;
  startedById: string;
  mode: "bo5-winnerA-banBA-pickAA-loserspick";
  messageId: string;
}

function normalizeEnv(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("your_")) {
    return undefined;
  }
  return trimmed;
}

function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

const BOT_TOKEN = normalizeEnv(process.env.DISCORD_TOKEN);
const CLIENT_ID = normalizeEnv(process.env.DISCORD_CLIENT_ID);
const RAW_GUILD_ID = normalizeEnv(process.env.DISCORD_GUILD_ID);
const GUILD_ID = RAW_GUILD_ID && isSnowflake(RAW_GUILD_ID) ? RAW_GUILD_ID : undefined;
const SQLITE_PATH = process.env.SQLITE_PATH ?? "./data/veto.db";

if (!BOT_TOKEN || !CLIENT_ID) {
  throw new Error("Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env (replace placeholder values).");
}
if (!isSnowflake(CLIENT_ID)) {
  throw new Error("DISCORD_CLIENT_ID must be a valid Discord application ID (snowflake).");
}
if (RAW_GUILD_ID && !GUILD_ID) {
  console.warn("Ignoring DISCORD_GUILD_ID because it is not a valid snowflake.");
}

const commands = [
  new SlashCommandBuilder()
    .setName("veto")
    .setDescription("Start a map veto between two players.")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("Veto mode")
        .setRequired(true)
        .addChoices(
          { 
            name: "BO3: ABBA bans, AB picks, final map is decider", 
            value: "bo3-banABBA-pickAB",
          },
          {
            name: "BO3 Admin-first: host picks map 1, ABBA bans, loser picks map 2",
            value: "bo3-adminfirst-banABBA-loserspick",
          },
          { 
            name: "BO5: AB bans, random first, loser picks (first to 3)", 
            value: "bo5-banAB-randomfirst-loserspick",
          },
          {
            name: "BO5 Winner A: BA bans, A picks Maps 1-2, then loser picks",
            value: "bo5-winnerA-banBA-pickAA-loserspick",
          },
        )
    )
    .addUserOption((opt) => opt.setName("player1").setDescription("First player").setRequired(true))
    .addUserOption((opt) => opt.setName("player2").setDescription("Second player").setRequired(true)),
  new SlashCommandBuilder()
    .setName("vetonext")
    .setDescription("Record loser and prompt next map selection when required.")
    .addUserOption((opt) => opt.setName("loser").setDescription("Loser of previous map").setRequired(true)),
  new SlashCommandBuilder().setName("vetoundo").setDescription("Undo the last veto action."),
  new SlashCommandBuilder().setName("vetoreset").setDescription("Clear the veto state for this channel."),
  new SlashCommandBuilder()
    .setName("vetooverride")
    .setDescription("Allow a moderator to click the next map button on behalf of the active player."),
  new SlashCommandBuilder()
    .setName("vetosetrole")
    .setDescription("Set the role required to run veto moderator commands.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((opt) =>
      opt.setName("role").setDescription("The moderator role").setRequired(true)
    )
];

function encodeMap(map: string): string {
  return encodeURIComponent(map);
}

function decodeMap(encoded: string): string {
  return decodeURIComponent(encoded);
}

function shortAction(action: VetoAction): string {
  return action === "ban" ? "ban" : "pick";
}

function mention(id: string): string {
  return `<@${id}>`;
}

function isVetoChannel(
  channel: Awaited<ReturnType<Client["channels"]["fetch"]>>
): channel is TextChannel | AnyThreadChannel {
  return Boolean(
    channel &&
      (channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.AnnouncementThread)
  );
}

function hasModPermission(interaction: ChatInputCommandInteraction, configStore: GuildConfigStore): boolean {
  const guildId = interaction.guildId;
  if (!guildId) return true;
  const requiredRoleId = configStore.getModRole(guildId);
  if (!requiredRoleId) return true; // No role configured — allow everyone.
  const roles = interaction.member?.roles;
  if (roles instanceof GuildMemberRoleManager) return roles.cache.has(requiredRoleId);
  if (Array.isArray(roles)) return roles.includes(requiredRoleId);
  return false;
}

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  const body = commands.map((cmd) => cmd.toJSON());
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    return;
  }
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
}

export async function startBot(): Promise<void> {
  await registerCommands();
  const maps = loadMaps();
  const store = new SQLiteSessionStore(SQLITE_PATH);
  const vetoService = new VetoService(Math.random, Math.random, store);
  // Channels where a moderator override is pending for the next button click.
  const overrideChannels = new Set<string>();
  // Latest visible prompt message per channel so stale buttons can be disabled.
  const promptMessages = new Map<string, PromptTracker>();
  // Channels waiting for moderator choice of advantaged Player A in winner-A mode.
  const pendingAdvantagePrompts = new Map<string, PendingAdvantagePrompt>();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: []
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(
        interaction,
        vetoService,
        maps,
        client,
        store,
        overrideChannels,
        promptMessages,
        pendingAdvantagePrompts
      );
      return;
    }
    if (interaction.isButton()) {
      await handleButton(
        interaction,
        vetoService,
        maps,
        client,
        store,
        overrideChannels,
        promptMessages,
        pendingAdvantagePrompts
      );
    }
  });

  await client.login(BOT_TOKEN);
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  vetoService: VetoService,
  maps: string[],
  client: Client,
  configStore: GuildConfigStore,
  overrideChannels: Set<string>,
  promptMessages: Map<string, PromptTracker>,
  pendingAdvantagePrompts: Map<string, PendingAdvantagePrompt>
): Promise<void> {
  if (!interaction.channelId) {
    await interaction.reply({ content: "This command must be used in a channel.", flags: MessageFlags.Ephemeral });
    return;
  }

  // /vetosetrole is handled before deferring — it's fast and needs no async work.
  if (interaction.commandName === "vetosetrole") {
    const role = interaction.options.getRole("role", true);
    configStore.setModRole(interaction.guildId!, role.id);
    await interaction.reply({
      content: `✅ Moderator role set to <@&${role.id}>. Only members with this role can run veto commands.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // All remaining commands require the moderator role (if configured).
  if (!hasModPermission(interaction, configStore)) {
    await interaction.reply({ content: "❌ You don't have permission to use veto commands.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Acknowledge immediately — all commands do async work after this point.
  await interaction.deferReply();

  try {
    if (interaction.commandName === "veto") {
      const mode = interaction.options.getString("mode", true) as VetoMode;
      const playerOne = interaction.options.getUser("player1", true);
      const playerTwo = interaction.options.getUser("player2", true);
      const previousPending = pendingAdvantagePrompts.get(interaction.channelId);
      if (previousPending) {
        await deleteMessageById(client, previousPending.channelId, previousPending.messageId);
        pendingAdvantagePrompts.delete(interaction.channelId);
      }

      if (mode === "bo5-winnerA-banBA-pickAA-loserspick") {
        const existing = vetoService.getSession(interaction.channelId);
        if (existing && !existing.completed) {
          throw new Error("A veto is already active in this channel.");
        }
        const response = await interaction.editReply({
          content:
            `🏅 Select advantaged Player A for this veto:\n` +
            `• ${mention(playerOne.id)}\n` +
            `• ${mention(playerTwo.id)}\n` +
            `Only the moderator who started this veto can make this choice.`,
          components: buildAdvantageButtons(
            interaction.channelId,
            playerOne.id,
            playerTwo.id,
            `@${playerOne.username}`,
            `@${playerTwo.username}`
          )
        });
        if (!("id" in response)) {
          throw new Error("Could not create advantaged-player selection prompt.");
        }
        pendingAdvantagePrompts.set(interaction.channelId, {
          channelId: interaction.channelId,
          playerOneId: playerOne.id,
          playerTwoId: playerTwo.id,
          startedById: interaction.user.id,
          mode,
          messageId: response.id
        });
        return;
      }

      const result = vetoService.startVeto({
        channelId: interaction.channelId,
        mode,
        playerOneId: playerOne.id,
        playerTwoId: playerTwo.id,
        startedById: interaction.user.id,
        mapPool: maps
      });
      await interaction.editReply(result.publicMessages.join("\n"));
      if (result.nextPrompt) {
        await sendPlayerPrompt(client, result.nextPrompt, promptMessages);
      }
      return;
    }

    if (interaction.commandName === "vetonext") {
      const loser = interaction.options.getUser("loser", true);
      const result = vetoService.recordLoser(interaction.channelId, loser.id);
      await interaction.editReply(result.publicMessages.join("\n"));
      if (result.nextPrompt) {
        await sendPlayerPrompt(client, result.nextPrompt, promptMessages);
      }
      return;
    }

    if (interaction.commandName === "vetoundo") {
      const result = vetoService.undo(interaction.channelId);
      await interaction.editReply(result.publicMessages.join("\n"));
      if (result.nextPrompt) {
        await sendPlayerPrompt(client, result.nextPrompt, promptMessages);
      }
      return;
    }

    if (interaction.commandName === "vetoreset") {
      vetoService.resetVeto(interaction.channelId);
      overrideChannels.delete(interaction.channelId);
      await disableTrackedPrompt(client, promptMessages.get(interaction.channelId));
      promptMessages.delete(interaction.channelId);
      const pendingAdvantage = pendingAdvantagePrompts.get(interaction.channelId);
      if (pendingAdvantage) {
        await deleteMessageById(client, pendingAdvantage.channelId, pendingAdvantage.messageId);
        pendingAdvantagePrompts.delete(interaction.channelId);
      }
      await interaction.editReply("🗑️ Veto state for this channel has been reset.");
    }

    if (interaction.commandName === "vetooverride") {
      const prompt = vetoService.getSession(interaction.channelId)
        ? vetoService.getCurrentPrompt(interaction.channelId)
        : undefined;
      if (!prompt) {
        await interaction.editReply("❌ No active veto prompt in this channel — nothing to override.");
        return;
      }
      overrideChannels.add(interaction.channelId);
      await interaction.editReply(
        `🔓 Override enabled: the next button click in this channel will be accepted from any moderator on behalf of <@${prompt.playerId}> (**${shortAction(prompt.action)}**).`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    await interaction.editReply({ content: message });
  }
}

async function handleButton(
  interaction: Interaction,
  vetoService: VetoService,
  maps: string[],
  client: Client,
  configStore: GuildConfigStore,
  overrideChannels: Set<string>,
  promptMessages: Map<string, PromptTracker>,
  pendingAdvantagePrompts: Map<string, PendingAdvantagePrompt>
): Promise<void> {
  if (!interaction.isButton()) {
    return;
  }
  if (interaction.customId.startsWith("vetoa:")) {
    const [, channelId, advantagedPlayerId] = interaction.customId.split(":");
    const pending = pendingAdvantagePrompts.get(channelId);
    if (!pending) {
      await interaction.reply({
        content: "No pending advantaged-player selection exists for this channel.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (interaction.user.id !== pending.startedById) {
      await interaction.reply({
        content: `❌ Only <@${pending.startedById}> can choose advantaged Player A for this veto.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (advantagedPlayerId !== pending.playerOneId && advantagedPlayerId !== pending.playerTwoId) {
      await interaction.reply({ content: "Invalid advantaged-player selection.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    try {
      const result = vetoService.startVeto({
        channelId: pending.channelId,
        mode: pending.mode,
        playerOneId: pending.playerOneId,
        playerTwoId: pending.playerTwoId,
        advantagedPlayerId,
        startedById: pending.startedById,
        mapPool: maps
      });
      pendingAdvantagePrompts.delete(channelId);
      await interaction.deleteReply();
      await sendPublicMessages(client, channelId, result.publicMessages);
      if (result.nextPrompt) {
        await sendPlayerPrompt(client, result.nextPrompt, promptMessages);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (!interaction.customId.startsWith("veto:")) {
    return;
  }

  const [, channelId, encodedMap] = interaction.customId.split(":");
  const map = decodeMap(encodedMap);

  // Check turn ownership before deferring so we can reply ephemerally on wrong-turn clicks.
  const prompt = vetoService.getSession(channelId)
    ? vetoService.getCurrentPrompt(channelId)
    : undefined;

  const isOverrideActive = overrideChannels.has(channelId);
  const isMod = hasModPermission(interaction as unknown as ChatInputCommandInteraction, configStore);

  if (prompt && prompt.playerId !== interaction.user.id) {
    // Allow if a mod override is pending and the clicker is a moderator.
    if (isOverrideActive && isMod) {
      // Consume the override and proceed — attribution will use prompt.playerId below.
    } else {
      await interaction.reply({
        content: `❌ Not your turn. It's <@${prompt.playerId}>'s turn to **${prompt.action}**.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  }

  // Acknowledge immediately so Discord doesn't time out.
  await interaction.deferUpdate();

  // When override is active, record the choice as the expected player (not the mod).
  const chooserId = isOverrideActive && isMod && prompt ? prompt.playerId : interaction.user.id;
  if (isOverrideActive) {
    overrideChannels.delete(channelId);
  }

  try {
    const result = vetoService.handleChoice(channelId, chooserId, map);
    await interaction.deleteReply();
    await disableTrackedPrompt(client, promptMessages.get(channelId));
    promptMessages.delete(channelId);
    const overrideNote =
      chooserId !== interaction.user.id
        ? [`🔓 *(Override by <@${interaction.user.id}> on behalf of <@${chooserId}>)*`]
        : [];
    await sendPublicMessages(client, channelId, [...overrideNote, ...result.publicMessages]);
    if (result.nextPrompt) {
      await sendPlayerPrompt(client, result.nextPrompt, promptMessages);
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : "Unexpected error.";
    const notYourTurn = raw.match(/^NOT_YOUR_TURN:(\w+):(\w+)$/);
    const message = notYourTurn
      ? `❌ Not your turn. It's <@${notYourTurn[1]}>'s turn to **${notYourTurn[2]}**.`
      : raw;
    await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
  }
}

async function sendPublicMessages(client: Client, channelId: string, messages: string[]): Promise<void> {
  if (!messages.length) {
    return;
  }
  const channel = await client.channels.fetch(channelId);
  if (!isVetoChannel(channel)) {
    return;
  }
  await channel.send(messages.join("\n"));
}

function buildMapButtons(prompt: ChoicePrompt, disabled = false): Array<ActionRowBuilder<ButtonBuilder>> {
  const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];

  for (let i = 0; i < prompt.options.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const map of prompt.options.slice(i, i + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`veto:${prompt.channelId}:${encodeMap(map)}`)
          .setLabel(map)
          .setDisabled(disabled)
          .setStyle(ButtonStyle.Primary)
      );
    }
    rows.push(row);
  }
  return rows;
}

function buildAdvantageButtons(
  channelId: string,
  playerOneId: string,
  playerTwoId: string,
  playerOneLabel: string,
  playerTwoLabel: string
): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`vetoa:${channelId}:${playerOneId}`)
        .setLabel(`${playerOneLabel} as A`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`vetoa:${channelId}:${playerTwoId}`)
        .setLabel(`${playerTwoLabel} as A`)
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function deleteMessageById(client: Client, channelId: string, messageId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!isVetoChannel(channel)) {
    return;
  }
  try {
    const message = await channel.messages.fetch(messageId);
    await message.delete();
  } catch (error) {
    console.warn(`Could not delete message ${messageId} in ${channelId}:`, error);
  }
}

async function disableTrackedPrompt(client: Client, tracker?: PromptTracker): Promise<void> {
  if (!tracker) {
    return;
  }
  await deleteMessageById(client, tracker.prompt.channelId, tracker.messageId);
}

async function sendPlayerPrompt(
  client: Client,
  prompt: ChoicePrompt,
  promptMessages: Map<string, PromptTracker>
): Promise<void> {
  const existing = promptMessages.get(prompt.channelId);
  await disableTrackedPrompt(client, existing);
  const channel = await client.channels.fetch(prompt.channelId);
  if (!isVetoChannel(channel)) {
    throw new Error("Could not find a valid text channel or thread for this veto prompt.");
  }
  const message = await channel.send({
    content: `👉 <@${prompt.playerId}> it's your turn to **${shortAction(prompt.action)}** a map.\n${prompt.instructions}`,
    components: buildMapButtons(prompt)
  });
  promptMessages.set(prompt.channelId, { prompt, messageId: message.id });
}
