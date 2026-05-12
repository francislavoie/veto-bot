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
import { loadMaps } from "../config";
import { VetoService } from "../core/veto-service";
import type { ChoicePrompt, VetoAction, VetoMode } from "../core/types";
import { SQLiteSessionStore } from "../core/storage";
import type { GuildConfigStore } from "../core/storage";

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
        .addChoices({ name: "bo3", value: "bo3" }, { name: "bo5", value: "bo5" })
    )
    .addUserOption((opt) => opt.setName("player1").setDescription("First player").setRequired(true))
    .addUserOption((opt) => opt.setName("player2").setDescription("Second player").setRequired(true)),
  new SlashCommandBuilder()
    .setName("vetonext")
    .setDescription("Record loser for BO5 and prompt them to pick next map.")
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

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: []
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction, vetoService, maps, client, store, overrideChannels);
      return;
    }
    if (interaction.isButton()) {
      await handleButton(interaction, vetoService, client, store, overrideChannels);
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
  overrideChannels: Set<string>
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
      const result = vetoService.startVeto({
        channelId: interaction.channelId,
        mode,
        playerOneId: playerOne.id,
        playerTwoId: playerTwo.id,
        mapPool: maps
      });
      await interaction.editReply(result.publicMessages.join("\n"));
      if (result.nextPrompt) {
        await sendPlayerPrompt(client, result.nextPrompt);
      }
      return;
    }

    if (interaction.commandName === "vetonext") {
      const loser = interaction.options.getUser("loser", true);
      const result = vetoService.recordLoser(interaction.channelId, loser.id);
      await interaction.editReply(result.publicMessages.join("\n"));
      if (result.nextPrompt) {
        await sendPlayerPrompt(client, result.nextPrompt);
      }
      return;
    }

    if (interaction.commandName === "vetoundo") {
      const result = vetoService.undo(interaction.channelId);
      await interaction.editReply(result.publicMessages.join("\n"));
      if (result.nextPrompt) {
        await sendPlayerPrompt(client, result.nextPrompt);
      }
      return;
    }

    if (interaction.commandName === "vetoreset") {
      vetoService.resetVeto(interaction.channelId);
      overrideChannels.delete(interaction.channelId);
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
  client: Client,
  configStore: GuildConfigStore,
  overrideChannels: Set<string>
): Promise<void> {
  if (!interaction.isButton()) {
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
    const overrideNote =
      chooserId !== interaction.user.id
        ? [`🔓 *(Override by <@${interaction.user.id}> on behalf of <@${chooserId}>)*`]
        : [];
    await sendPublicMessages(client, channelId, [...overrideNote, ...result.publicMessages]);
    if (result.nextPrompt) {
      await sendPlayerPrompt(client, result.nextPrompt);
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
  if (!channel || channel.type !== ChannelType.GuildText) {
    return;
  }
  const textChannel = channel as TextChannel;
  await textChannel.send(messages.join("\n"));
}

function buildMapButtons(prompt: ChoicePrompt): Array<ActionRowBuilder<ButtonBuilder>> {
  const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];

  for (let i = 0; i < prompt.options.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const map of prompt.options.slice(i, i + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`veto:${prompt.channelId}:${encodeMap(map)}`)
          .setLabel(map)
          .setStyle(ButtonStyle.Primary)
      );
    }
    rows.push(row);
  }
  return rows;
}

async function sendPlayerPrompt(client: Client, prompt: ChoicePrompt): Promise<void> {
  const channel = await client.channels.fetch(prompt.channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("Could not find a valid text channel for this veto prompt.");
  }
  const textChannel = channel as TextChannel;
  await textChannel.send({
    content: `👉 <@${prompt.playerId}> it's your turn to **${shortAction(prompt.action)}** a map.\n${prompt.instructions}`,
    components: buildMapButtons(prompt)
  });
}
