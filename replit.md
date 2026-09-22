# Drednot bot

## Run

The Replit workflow runs the dashboard from this directory:

```sh
cd drednot && npm start
```

Open the dashboard in Preview and use **Start a ship fleet**. Add one Drednot
invite URL or invite code per line and one anonymous account key per line in
the same order. Each ship uses its own browser session and AFK keep-alive is
enabled by default.

For unattended startup, configure:

- `DREDNOT_SHIPS`: comma- or newline-separated invite URLs/codes
- `DREDNOT_ANON_KEYS`: comma- or newline-separated anonymous keys in the same order
- `DREDNOT_BOT_NAME`: optional display name

Multiple live ships require separate Drednot account keys. Reusing one key can
cause the game to disconnect one of the sessions.