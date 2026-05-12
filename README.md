# WarCraft 3 Veto Bot (Discord)

Discord bot for running competitive 1v1 map vetoes with persistent state.

## Commands

### Starting a veto

```
/veto mode:(bo3|bo5) player1:@user player2:@user
```

Starts a map veto in the current channel. Requires the moderator role (if configured).

- Flips a coin to decide who is `A` (goes first).
- Displays a brief summary of the mode's rules before the coin flip.
- **BO3 rules:** ABBA ban order (4 bans total), then AB pick order (2 picks). The one remaining map is the ⚔️ deciding match if the series goes to game 3.
- **BO5 rules:** AB ban order (2 bans total), then a 🎲 randomly selected starting map. The loser of each game picks the next map. First to 3 wins takes the series — a 2-2 tie goes to an ⚔️ deciding match.

Each veto is scoped to a single channel. Create a thread per match.

---

### Recording the loser (BO5 only)

```
/vetonext loser:@user
```

Records who lost the last game and prompts them with map-pick buttons. Requires the moderator role.

- Cannot be used before all bans are complete.
- The bot tracks wins/losses and ends the series early if a player reaches 3 wins (3-0 or 3-1).
- After a 2-2 tie, use `/vetonext` one final time to record the deciding map winner and print the series summary.

---

### Undoing the last action

```
/vetoundo
```

Rolls back the last veto choice or recorded loser. Requires the moderator role. Prints the current veto state after rolling back so you know where things stand.

---

### Overriding a button click

```
/vetooverride
```

Enables a one-time moderator override for the next map-selection button click. Use this when a player has verbally confirmed their choice but is unable to click the button themselves. Requires the moderator role.

- After running this command, any moderator can click a map button in that channel on behalf of the active player.
- The choice is attributed to the expected player (not the moderator).
- The override is consumed after one click and cannot stack.
- A note is posted publicly indicating the override was used.

---

### Resetting a veto

```
/vetoreset
```

Clears all veto state for the current channel (including any pending override). Use if something went badly wrong and you need to start fresh. Requires the moderator role.

---

### Setting the moderator role

```
/vetosetrole role:@Role
```

Restricts all veto commands to members who have the specified role. Requires **Manage Server** permission to run. Once set, users without the role will be rejected when they try to use any veto command.

If no role is configured, all server members can use veto commands.

---

## Features

- Turn prompts are posted publicly in the veto channel and @mention the active player.
- Only the expected player (or a moderator during an override) can click map buttons.
- Public status updates are posted after every choice.
- Final report shows who picked/banned each map, and in BO5 who won/lost each game.
- SQLite-backed session storage so bot restarts preserve active veto state.

## Requirements

- [Bun](https://bun.sh/) 1.x+
- A Discord application + bot token

## Setup

1. Install dependencies:

```bash
bun install
```

2. Configure map pool in `config/maps.json`:
   - Must contain exactly 7 unique maps.

3. Copy the env template and fill in your values:

```bash
cp .env.example .env
```

4. Edit `.env`:

```bash
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_client_id
# Optional: register commands to one guild for faster updates
DISCORD_GUILD_ID=
# Optional: sqlite db path (default: ./data/veto.db)
SQLITE_PATH=./data/veto.db
```

Leave `DISCORD_GUILD_ID` empty (or remove it) for global command registration.

5. Invite bot to your server with these scopes/permissions:
   - OAuth2 scopes: `bot`, `applications.commands`
   - Bot permissions: Send Messages, Use Slash Commands, Read Message History

## Run

```bash
bun run start
```

Environment variables are loaded automatically from `.env` via `dotenv`.

For development:

```bash
bun run dev
```

## Discord configuration (what to configure)

1. In the Discord Developer Portal, create an application and bot user.
2. Under **Bot**, copy the token to `DISCORD_TOKEN`.
3. Under **General Information**, copy **Application ID** to `DISCORD_CLIENT_ID`.
4. (Recommended for testing) copy your server (guild) ID to `DISCORD_GUILD_ID` so slash command updates apply quickly.
5. In **Privileged Gateway Intents**, you do **not** need Message Content intent for this bot.

### Endpoints / webhooks

This bot uses Discord Gateway + slash interactions through `discord.js` and does **not** require:

- Public HTTP endpoints
- Interaction webhooks
- Reverse proxy setup

You only need outbound internet access from your host to Discord.

## Deployment

### Option 1: simple Linux/VPS deployment

1. Install Bun on the server.
2. Clone this repo and configure `.env`:

```bash
git clone <your-repo-url>
cd veto-bot
bun install
cp .env.example .env
# edit .env with real values
```

3. Start once manually:

```bash
bun run start
```

### Option 2: run as a systemd service (recommended)

Create `/etc/systemd/system/veto-bot.service`:

```ini
[Unit]
Description=WarCraft 3 Veto Bot
After=network.target

[Service]
Type=simple
User=your-linux-user
WorkingDirectory=/path/to/veto-bot
ExecStart=/home/your-linux-user/.bun/bin/bun run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable veto-bot
sudo systemctl start veto-bot
sudo systemctl status veto-bot
```

### Persistence and storage

- Session state is stored in SQLite at `SQLITE_PATH` (default `./data/veto.db`).
- Keep this path on persistent disk.
- Back up this file if you want disaster recovery for active sessions.

## Tests

```bash
bun test
```

Includes coverage for BO3/BO5 flows, turn validation, undo, and SQLite restart persistence.
