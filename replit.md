# Drednot bot

## Run

The Replit workflow runs the dashboard from the project root:

```sh
npm run build && npm start
```

For Render:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Port:** use Render's `$PORT` environment variable; the server already binds to `0.0.0.0`.

The `postinstall` script downloads Puppeteer's Chrome browser during the Render
build, so the service does not depend on a manually configured browser path.

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