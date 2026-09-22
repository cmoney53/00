const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { DrednotBot, formatDuration } = require("./bot");
const { startDiscordBot } = require("./discord-bot");

const PORT = parseInt(process.env.PORT || "5000", 10);
const BOT_NAME = process.env.DREDNOT_BOT_NAME || "DrednotBot";
const MAX_BUFFER = 200;

const TARGET_PRESETS = {
  "demo://local": { label: "Local demo (safe)", key: "demo" },
  "https://drednot.io/": { label: "drednot.io", key: null },
};
if (process.env.DREDNOT_ANON_KEY) {
  TARGET_PRESETS["https://drednot.io/"] = {
    label: "drednot.io (operator configured)",
    key: process.env.DREDNOT_ANON_KEY,
  };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "Public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ---------------- Bot registry ----------------
/** @type {Map<string, BotEntry>} */
const bots = new Map();

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function pushBuffer(buf, item) {
  buf.push(item);
  if (buf.length > MAX_BUFFER) buf.shift();
}

function summary(entry) {
  const b = entry.bot;
  const k = b.anonymousKey || "";
  return {
    id: entry.id,
    label: entry.label,
    target: entry.target,
    botName: BOT_NAME,
    commandPrefix: b.commandPrefix,
    status: b.status,
    startedAt: b.startedAt,
    commandStats: b.commandStats,
    anonymousKeyTail: k ? k.slice(-6) : "",
    inventory: b.getInventory(),
    afkEnabled: b._afkEnabled,
    currentShip: b.currentShip,
    autoJoin: b._autoJoin || b._rejoinUrl || null,
  };
}

function fullSummary(entry) {
  return {
    ...summary(entry),
    logs: entry.logs,
    chat: entry.chat,
    msgCount: entry.msgCount,
  };
}

function createBot({ label, target, anonymousKey, autoJoin, afkEnabled = true }) {
  const id = crypto.randomBytes(4).toString("hex");
  const preset = TARGET_PRESETS[target] || {};
  const key = anonymousKey || preset.key;
  if (!target) throw new Error("target required");
  if (!TARGET_PRESETS[target]) {
    throw new Error("unsupported target; use the local demo or an operator-configured target");
  }
  if (!key) throw new Error("anonymousKey required");

  const bot = new DrednotBot({
    anonymousKey: key,
    botName: BOT_NAME,
    target,
    autoJoin: autoJoin || null,
    afkEnabled,
  });

  /** @typedef {{ id: string, label: string, target: string, bot: DrednotBot, logs: any[], chat: any[], msgCount: number }} BotEntry */
  const entry = {
    id,
    label: label || preset.label || target,
    target,
    bot,
    logs: [],
    chat: [],
    msgCount: 0,
  };

  bot.on("log", (e) => {
    pushBuffer(entry.logs, e);
    broadcast("log", { botId: id, ...e });
  });
  bot.on("chat", (msg) => {
    const item = { ts: Date.now(), ...msg };
    pushBuffer(entry.chat, item);
    entry.msgCount++;
    broadcast("chat", { botId: id, ...item });
  });
  bot.on("status", (status) => {
    broadcast("status", { botId: id, status, startedAt: bot.startedAt });
  });
  bot.on("heartbeat", (data) => {
    broadcast("heartbeat", {
      botId: id,
      uptimeMs: data.uptime,
      uptime: formatDuration(data.uptime),
      commandStats: bot.commandStats,
    });
  });

  bots.set(id, entry);
  broadcast("bot-created", fullSummary(entry));

  startBotWithRetry(entry);

  return entry;
}

function splitConfigList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function configuredFleet() {
  const invites = splitConfigList(process.env.DREDNOT_SHIPS || process.env.DREDNOT_AUTO_JOIN);
  const keys = splitConfigList(process.env.DREDNOT_ANON_KEYS || process.env.DREDNOT_ANON_KEY);
  return invites.map((invite, index) => ({
    invite,
    key: keys[index] || null,
    label: `Ship ${index + 1}`,
  }));
}

async function startBotWithRetry(entry, attempt = 1) {
  if (bots.get(entry.id) !== entry || entry.bot.shouldStop) return;
  try {
    await entry.bot.start();
  } catch (e) {
    entry.bot.log("error", `start attempt ${attempt} failed: ${e.message}`);
    try {
      await entry.bot.stop();
    } catch (_) {}

    if (bots.get(entry.id) !== entry || attempt >= 5) {
      entry.bot.log("error", "start retries exhausted");
      return;
    }

    const delayMs = Math.min(30000, attempt * 5000);
    // stop() intentionally marks the bot as stopped; clear that state before
    // scheduling an automatic retry. Manual removal still prevents retries
    // because the entry is removed from the registry above.
    entry.bot.shouldStop = false;
    entry.bot.log("warn", `retrying Drednot startup in ${delayMs / 1000}s`);
    setTimeout(() => startBotWithRetry(entry, attempt + 1), delayMs);
  }
}

async function removeBot(id) {
  const entry = bots.get(id);
  if (!entry) return false;
  bots.delete(id);
  try {
    await entry.bot.stop();
  } catch (_) {}
  broadcast("bot-removed", { id });
  return true;
}

// ---------------- WebSocket ----------------
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "init",
      data: {
        bots: Array.from(bots.values()).map(fullSummary),
      },
    }),
  );
});

// ---------------- Bot management endpoints ----------------
app.get("/api/bots", (req, res) => {
  res.json(Array.from(bots.values()).map(summary));
});

app.post("/api/bots", (req, res) => {
  const { label, target, anonymousKey, autoJoin, afkEnabled } = req.body || {};
  try {
    const entry = createBot({ label, target, anonymousKey, autoJoin, afkEnabled });
    res.json(fullSummary(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/fleet", (req, res) => {
  const body = req.body || {};
  const invites = splitConfigList(body.invites || body.ships);
  const keys = splitConfigList(body.anonymousKeys || body.keys);
  const target = body.target || "https://drednot.io/";
  if (!invites.length) return res.status(400).json({ error: "at least one ship invite is required" });
  if (invites.length > 12) return res.status(400).json({ error: "fleet is limited to 12 ships" });
  if (target !== "demo://local" && keys.length < invites.length) {
    return res.status(400).json({ error: "one anonymous key per ship is required for live Drednot ships" });
  }
  try {
    const entries = invites.map((invite, index) => createBot({
      label: `Ship ${index + 1}`,
      target,
      anonymousKey: keys[index] || keys[0],
      autoJoin: invite,
      afkEnabled: body.afkEnabled !== false,
    }));
    res.json({ ok: true, bots: entries.map(fullSummary) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/bots/:id", async (req, res) => {
  const ok = await removeBot(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// Account creation is intentionally disabled. Use the local demo target or
// provide an operator-configured key through the environment.
app.post("/api/accounts/new-key", async (req, res) => {
  res.status(403).json({
    error: "Creating anonymous accounts is disabled. Use the local demo bot or provide an operator-configured key.",
  });
});

// ---------------- Per-bot endpoints ----------------
function withBot(req, res, fn) {
  const entry = bots.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "bot not found" });
  return fn(entry).catch((e) => res.status(500).json({ error: e.message }));
}

app.get("/api/bots/:id/status", (req, res) =>
  withBot(req, res, async (entry) => {
    const s = summary(entry);
    res.json({
      ...s,
      uptimeMs: s.startedAt ? Date.now() - s.startedAt : 0,
    });
  }),
);

app.get("/api/bots/:id/inventory", (req, res) =>
  withBot(req, res, async (entry) => {
    res.json({
      target: entry.target,
      localDemo: entry.target === "demo://local",
      inventory: entry.bot.getInventory(),
    });
  }),
);

app.post("/api/bots/:id/inventory/grant", (req, res) =>
  withBot(req, res, async (entry) => {
    if (entry.target !== "demo://local") {
      return res.status(403).json({
        error: "Inventory grants are available only in the local demo target.",
      });
    }
    const item = String(req.body?.item || "").trim().toLowerCase();
    const quantity = Number(req.body?.quantity);
    if (item !== "iron" || quantity !== 16) {
      return res.status(400).json({
        error: "The demo grant is fixed to exactly 16 iron.",
      });
    }
    const inventory = entry.bot.grantInventory(item, quantity);
    broadcast("inventory", { botId: entry.id, inventory });
    res.json({ ok: true, item, granted: quantity, inventory });
  }),
);

app.post("/api/bots/:id/say", (req, res) =>
  withBot(req, res, async (entry) => {
    const text = (req.body && req.body.text) || "";
    if (!text) return res.status(400).json({ error: "text required" });
    await entry.bot.send(text);
    res.json({ ok: true });
  }),
);

app.get("/api/bots/:id/canvas.jpg", (req, res) =>
  withBot(req, res, async (entry) => {
    const buf = await entry.bot.captureCanvas(60);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.end(buf);
  }),
);

// MJPEG stream — browsers render this <img src=…> as a continuous live feed.
app.get("/api/bots/:id/canvas.mjpg", (req, res) => {
  const entry = bots.get(req.params.id);
  if (!entry) return res.status(404).end();
  const targetFps = Math.max(2, Math.min(30, Number(req.query.fps) || 15));
  const quality = Math.max(20, Math.min(90, Number(req.query.q) || 55));
  const frameMs = Math.floor(1000 / targetFps);

  const boundary = "drednotframe";
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Connection: "close",
    "X-Accel-Buffering": "no",
  });

  let closed = false;
  const onClose = () => {
    closed = true;
  };
  req.on("close", onClose);
  res.on("close", onClose);
  res.on("error", onClose);

  (async () => {
    while (!closed) {
      const t0 = Date.now();
      try {
        const buf = await entry.bot.captureCanvas(quality);
        if (closed) break;
        res.write(`--${boundary}\r\n`);
        res.write(`Content-Type: image/jpeg\r\n`);
        res.write(`Content-Length: ${buf.length}\r\n\r\n`);
        res.write(buf);
        res.write("\r\n");
      } catch (e) {
        // Bot may be loading or signing-in — back off briefly and retry.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const elapsed = Date.now() - t0;
      const wait = Math.max(0, frameMs - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    try { res.end(); } catch {}
  })();
});

app.get("/api/bots/:id/player-position", (req, res) =>
  withBot(req, res, async (entry) => {
    const pos = await entry.bot.getPlayerPosition();
    const debug =
      req.query && (req.query.debug === "1" || req.query.debug === "true");
    if (debug) {
      const candidates = await entry.bot.getPlayerPositionCandidates();
      res.json({ position: pos, candidates });
    } else {
      res.json(pos || { position: null });
    }
  }),
);

app.get("/api/bots/:id/ship-info", (req, res) =>
  withBot(req, res, async (entry) => {
    const info = await entry.bot.captureShipInfo();
    res.json(info);
  }),
);

// ---- Ship-position scraper -----------------------------------------------
// Detect drednot's binary entity-position layout by anchoring on the
// player's known coordinates (passive — never sends extra packets).
app.post("/api/bots/:id/positions/scan", express.json({ limit: "8kb" }), (req, res) =>
  withBot(req, res, async (entry) => {
    const opts = req.body || {};
    const r = await entry.bot.scanShipPositionFormat({
      dwellMs: Number(opts.dwellMs) || 700,
      tol: Number(opts.tol) || 1.5,
    });
    res.json(r);
  }),
);

// Decode all entity positions in the most recent matching recv frame
// using the cached format. Returns { ships, format, player } where
// each ship has absolute (x, y) plus (dx, dy, dist) relative to the bot.
app.get("/api/bots/:id/positions", (req, res) =>
  withBot(req, res, async (entry) => {
    const r = await entry.bot.getShipPositions();
    res.json(r);
  }),
);

// Forget the cached format so the next scan starts fresh.
app.post("/api/bots/:id/positions/clear", (req, res) =>
  withBot(req, res, async (entry) => {
    res.json(await entry.bot.clearShipPositionFormat());
  }),
);

// Diagnostic: walk every puppeteer frame and report __wsBin / __shipFormat
// state per frame. Localhost-only. Used to debug "scan finds 0 frames"
// situations where the WS hook lives in an inner browsing context.
app.get("/api/bots/:id/positions/diag", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const page = entry.bot.page;
    if (!page) return res.json({ error: "not connected" });
    const px = Number(req.query.px), py = Number(req.query.py);
    const tol = Number(req.query.tol) || 0.05;
    const out = [];
    for (const f of page.frames()) {
      try {
        const info = await f.evaluate(
          (px, py, tol) => {
            const stats = window.__wsBinStats ? window.__wsBinStats() : null;
            let ws = null;
            try {
              if (window.__lastWS) ws = { ready: window.__lastWS.readyState, url: window.__lastWS.url };
            } catch {}
            let hits = null;
            if (Number.isFinite(px) && Number.isFinite(py) && window.__wsFindFloat) {
              const r = window.__wsFindFloat(px, py, { tol, maxHits: 30 });
              hits = r && r.hits ? r.hits.slice(0, 30) : [];
            }
            return {
              url: location.href, hookInstalled: !!window.__wsHookInstalled,
              binStats: stats, ws, shipFormat: window.__shipFormat || null, hits,
            };
          },
          Number.isFinite(px) ? px : null,
          Number.isFinite(py) ? py : null,
          tol,
        );
        out.push(info);
      } catch (e) { out.push({ error: String(e && e.message || e) }); }
    }
    res.json({ frames: out });
  }),
);

app.post("/api/bots/:id/join", (req, res) =>
  withBot(req, res, async (entry) => {
    const target =
      (req.body && (req.body.invite || req.body.url || req.body.code)) || "";
    if (!target) return res.status(400).json({ error: "invite required" });
    await entry.bot.joinShip(target);
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/afk", (req, res) =>
  withBot(req, res, async (entry) => {
    const enabled = entry.bot.setAfkEnabled(req.body?.enabled !== false);
    res.json({ ok: true, enabled });
  }),
);

app.post("/api/bots/:id/key", (req, res) =>
  withBot(req, res, async (entry) => {
    const { key, action } = req.body || {};
    if (!key || !["down", "up", "tap"].includes(action))
      return res
        .status(400)
        .json({ error: "key + action(down|up|tap) required" });
    if (action === "down") await entry.bot.keyDown(key);
    else if (action === "up") await entry.bot.keyUp(key);
    else await entry.bot.keyTap(key);
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/click", (req, res) =>
  withBot(req, res, async (entry) => {
    const { nx, ny, holdMs } = req.body || {};
    const x = Number.isFinite(Number(nx)) ? Number(nx) : 0.5;
    const y = Number.isFinite(Number(ny)) ? Number(ny) : 0.5;
    const hold = Number.isFinite(Number(holdMs)) ? Number(holdMs) : 0;
    await entry.bot.clickCanvas(x, y, hold);
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/double-click", (req, res) =>
  withBot(req, res, async (entry) => {
    const { nx, ny, gapMs } = req.body || {};
    const x = Number.isFinite(Number(nx)) ? Number(nx) : 0.5;
    const y = Number.isFinite(Number(ny)) ? Number(ny) : 0.5;
    const gap = Number.isFinite(Number(gapMs)) ? Number(gapMs) : 80;
    await entry.bot.doubleClickCanvas(x, y, gap);
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/drag", (req, res) =>
  withBot(req, res, async (entry) => {
    const { nx1, ny1, nx2, ny2, holdBeforeMs, durationMs } = req.body || {};
    if (![nx1, ny1, nx2, ny2].every((v) => Number.isFinite(Number(v))))
      return res
        .status(400)
        .json({ error: "nx1, ny1, nx2, ny2 (0..1) required" });
    await entry.bot.dragCanvas(
      Number(nx1),
      Number(ny1),
      Number(nx2),
      Number(ny2),
      Number(holdBeforeMs) || 200,
      Number(durationMs) || 1200,
    );
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/drag-start", (req, res) =>
  withBot(req, res, async (entry) => {
    const { nx, ny, holdBeforeMs } = req.body || {};
    if (![nx, ny].every((v) => Number.isFinite(Number(v))))
      return res.status(400).json({ error: "nx, ny (0..1) required" });
    const r = await entry.bot.dragStart(
      Number(nx),
      Number(ny),
      Number(holdBeforeMs) || 200,
    );
    res.json(r);
  }),
);

app.post("/api/bots/:id/drag-end", (req, res) =>
  withBot(req, res, async (entry) => {
    const { nx, ny, durationMs, steps, settleMs } = req.body || {};
    if (![nx, ny].every((v) => Number.isFinite(Number(v))))
      return res.status(400).json({ error: "nx, ny (0..1) required" });
    const r = await entry.bot.dragEnd(
      Number(nx),
      Number(ny),
      Number(durationMs) || 1200,
      Number(steps) || 40,
      Number(settleMs) || 200,
    );
    res.json(r);
  }),
);

app.post("/api/bots/:id/mouse-down", (req, res) =>
  withBot(req, res, async (entry) => {
    const { nx, ny } = req.body || {};
    if (![nx, ny].every((v) => Number.isFinite(Number(v))))
      return res.status(400).json({ error: "nx, ny (0..1) required" });
    await entry.bot.mouseDownAt(Number(nx), Number(ny));
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/mouse-move", (req, res) =>
  withBot(req, res, async (entry) => {
    const { nx, ny } = req.body || {};
    if (![nx, ny].every((v) => Number.isFinite(Number(v))))
      return res.status(400).json({ error: "nx, ny (0..1) required" });
    // Coalesced (latest-target-wins) — fire and forget so the dashboard
    // doesn't have to wait for puppeteer to finish before queueing the
    // next mousemove. The bot's worker drains pending targets, dropping
    // intermediate ones to keep the cursor in sync without backlog.
    entry.bot.mouseMoveCoalesced(Number(nx), Number(ny));
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/mouse-up", (req, res) =>
  withBot(req, res, async (entry) => {
    await entry.bot.mouseUpHere();
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/drag-cancel", (req, res) =>
  withBot(req, res, async (entry) => {
    await entry.bot.dragCancel();
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/hold-space", (req, res) =>
  withBot(req, res, async (entry) => {
    const { enabled, holdMs, releaseMs } = req.body || {};
    await entry.bot.setSpaceHoldCycle({ enabled, holdMs, releaseMs });
    res.json({ ok: true, ...entry.bot.getInputState() });
  }),
);

app.post("/api/bots/:id/hold-mouse", (req, res) =>
  withBot(req, res, async (entry) => {
    const { enabled, nx, ny } = req.body || {};
    await entry.bot.setMouseHoldCenter(enabled, nx, ny);
    res.json({ ok: true, ...entry.bot.getInputState() });
  }),
);

app.post("/api/bots/:id/hold-mouse-move", express.json(), (req, res) =>
  withBot(req, res, async (entry) => {
    const { nx, ny } = req.body || {};
    await entry.bot.moveMouseHold(nx, ny);
    res.json({ ok: true, ...entry.bot.getInputState() });
  }),
);

app.post("/api/bots/:id/release-all", (req, res) =>
  withBot(req, res, async (entry) => {
    entry.bot.setSpaceHoldCycle({ enabled: false });
    await entry.bot.setMouseHoldCenter(false);
    await entry.bot.releaseAllKeys();
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/restart", (req, res) =>
  withBot(req, res, async (entry) => {
    await entry.bot.stop();
    setTimeout(() => startBotWithRetry(entry), 500);
    res.json({ ok: true });
  }),
);

app.post("/api/bots/:id/sandbox", (req, res) =>
  withBot(req, res, async (entry) => {
    const result = await entry.bot.enableSandbox();
    res.json({ ok: true, ...result });
  }),
);

// Localhost-only debug helper: evaluate an arbitrary expression in the
// bot's page context. Used by the agent to probe drednot's DOM (e.g.
// where the color picker overlay lives). NOT exposed to the public
// dashboard — guarded by a same-host check.
app.post("/api/bots/:id/eval-debug", express.json({ limit: "256kb" }), (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const { expr } = req.body || {};
    if (typeof expr !== "string")
      return res.status(400).json({ error: "expr (string) required" });
    try {
      const value = await entry.bot.page.evaluate(
        // eslint-disable-next-line no-new-func
        new Function(`return (async () => { ${expr} })();`),
      );
      res.json({ ok: true, value });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Read recent WebSocket frames captured by bot.js's evaluateOnNewDocument
// hook. Used to reverse-engineer drednot's protocol — e.g. capture the
// "set color" packet by holding R + clicking F0, then replay it to switch
// colors without the menu interaction. Localhost only.
app.get("/api/bots/:id/ws-log", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const n = Math.max(1, Math.min(2000, parseInt(req.query.n, 10) || 50));
    const dir = req.query.dir || null; // "send" | "recv" | "open" | "close" | "error" | null
    const frameFilter = req.query.frame || null; // substring match on frame URL
    try {
      const page = entry.bot.page;
      const allFrames = page.frames();
      const perFrame = await Promise.all(
        allFrames.map(async (f) => {
          const url = f.url();
          if (frameFilter && !url.includes(frameFilter)) return [];
          try {
            return await f.evaluate(() => {
              const log = window.__wsLog || [];
              const sockets = window.__wsList || [];
              const urls = sockets.map((s) => {
                try { return s && s.url; } catch (_) { return null; }
              });
              return log.map((e) => ({ ...e, wsUrl: urls[e.id] || null }));
            }).then((entries) => entries.map((e) => ({ ...e, frameUrl: url })));
          } catch (_) {
            return [];
          }
        }),
      );
      const merged = perFrame.flat();
      const filteredByDir = dir ? merged.filter((e) => e.dir === dir) : merged;
      filteredByDir.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const out = filteredByDir.slice(-n);
      res.json({
        ok: true,
        frames: out,
        count: out.length,
        framesScanned: allFrames.length,
        frameUrls: allFrames.map((f) => f.url()),
      });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Send a raw payload through the captured WebSocket — used to experiment
// with replaying packets (e.g. "set color FF0F"). Localhost only.
app.post("/api/bots/:id/ws-send", express.json({ limit: "256kb" }), (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const { payload, frame: frameFilter, wsUrl } = req.body || {};
    if (payload == null)
      return res.status(400).json({ error: "payload (string|number[]) required" });
    try {
      const page = entry.bot.page;
      const allFrames = page.frames();
      // Pick the target frame:
      //  - if `frame` substring matches a frame URL, use that
      //  - otherwise, find the frame whose __lastWS is OPEN (readyState===1),
      //    optionally matching wsUrl substring, preferring non-top frames
      //    (the lobby socket lives on the top frame and closes after handshake).
      let target = null;
      if (frameFilter) {
        target = allFrames.find((f) => f.url().includes(frameFilter)) || null;
      }
      if (!target) {
        const probes = await Promise.all(
          allFrames.map(async (f) => {
            try {
              const info = await f.evaluate((wantUrl) => {
                const ws = window.__lastWS;
                if (!ws) return { has: false };
                const u = (() => { try { return ws.url; } catch (_) { return null; } })();
                if (wantUrl && (!u || !u.includes(wantUrl))) return { has: false };
                return { has: true, readyState: ws.readyState, url: u };
              }, wsUrl || null);
              return { f, ...info };
            } catch (_) {
              return { f, has: false };
            }
          }),
        );
        const open = probes.filter((p) => p.has && p.readyState === 1);
        // Prefer iframes (non-main) since the game socket lives there.
        const main = page.mainFrame();
        open.sort((a, b) => (a.f === main ? 1 : 0) - (b.f === main ? 1 : 0));
        target = open[0] && open[0].f;
      }
      if (!target)
        return res.status(404).json({ error: "no open WebSocket found in any frame" });
      const result = await target.evaluate(
        (p) => (window.__wsSendRaw ? window.__wsSendRaw(p) : { ok: false, err: "hook not installed" }),
        payload,
      );
      res.json({ ...result, frameUrl: target.url() });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Wipe the WebSocket capture log across every frame. Use immediately before
// triggering an in-game action whose packet you want to capture cleanly.
// Localhost only.
app.post("/api/bots/:id/ws-clear", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    try {
      const page = entry.bot.page;
      const allFrames = page.frames();
      const results = await Promise.all(
        allFrames.map(async (f) => {
          try {
            const r = await f.evaluate(() =>
              window.__wsClear ? window.__wsClear() : { ok: false, err: "no hook" });
            return { url: f.url(), ...r };
          } catch (e) {
            return { url: f.url(), ok: false, err: String(e && e.message || e) };
          }
        }),
      );
      res.json({ ok: true, frames: results });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Deep introspection of the game iframe(s): WebSocket state, captured WASM
// modules and their export samples, captured input listeners, and a scan of
// global variables for anything matching color/palette/equip/menu/picker.
// Used to figure out whether drednot exposes a JS-side function for
// switching equipped color (vs. having to replay the WS "set color" packet).
// Localhost only.
app.get("/api/bots/:id/inspect-game-frame", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const frameFilter = req.query.frame || null;
    const needle = req.query.q || "color|palette|equip|menu|picker|paint|wedge|item";
    try {
      const page = entry.bot.page;
      const allFrames = page.frames();
      const targets = frameFilter
        ? allFrames.filter((f) => f.url().includes(frameFilter))
        : allFrames;
      const reports = await Promise.all(
        targets.map(async (f) => {
          try {
            const r = await f.evaluate((rxStr) => {
              const out = { hookInstalled: !!window.__wsHookInstalled };
              // Sockets
              try {
                out.sockets = (window.__wsList || []).map((s) => ({
                  url: s && s.url,
                  readyState: s && s.readyState,
                  protocol: s && s.protocol,
                  bufferedAmount: s && s.bufferedAmount,
                }));
              } catch (e) { out.socketsErr = String(e); }
              // WASM
              try {
                out.wasm = (window.__wasmInstances || []).map((w) => ({
                  source: w.source,
                  exportCount: w.exportCount,
                  hasMemory: w.hasMemory,
                  memoryBytes: w.memoryBytes,
                  exportSample: w.exportSample,
                }));
              } catch (e) { out.wasmErr = String(e); }
              // Listeners
              try {
                const ls = window.__listeners || [];
                out.listenerCount = ls.length;
                const byType = {};
                for (const l of ls) {
                  const k = l.type + "@" + l.target;
                  byType[k] = (byType[k] || 0) + 1;
                }
                out.listenerSummary = byType;
                // Sample one source per (type,target) for inspection
                const seen = new Set();
                out.listenerSamples = [];
                for (const l of ls) {
                  const k = l.type + "@" + l.target;
                  if (seen.has(k)) continue;
                  seen.add(k);
                  out.listenerSamples.push({
                    type: l.type, target: l.target, source: l.source,
                  });
                }
              } catch (e) { out.listenersErr = String(e); }
              // Global name scan
              try {
                const rx = new RegExp(rxStr, "i");
                const hits = [];
                const skip = new Set([
                  "__wsLog", "__wsList", "__listeners", "__wasmInstances",
                ]);
                for (const k of Object.getOwnPropertyNames(window)) {
                  if (skip.has(k)) continue;
                  if (!rx.test(k)) continue;
                  let kind = "?";
                  let preview = null;
                  try {
                    const v = window[k];
                    kind = typeof v;
                    if (v == null) preview = String(v);
                    else if (kind === "function") preview = String(v).slice(0, 200);
                    else if (kind === "object") {
                      const keys = Object.keys(v).slice(0, 20);
                      preview = "{ " + keys.join(", ") + (keys.length === 20 ? " ..." : "") + " }";
                    } else preview = String(v).slice(0, 200);
                  } catch (e) { preview = "<getter threw: " + String(e) + ">"; }
                  hits.push({ name: k, kind, preview });
                  if (hits.length >= 200) break;
                }
                out.globalHits = hits;
              } catch (e) { out.globalErr = String(e); }
              // iframe count inside this frame
              try {
                out.childIframes = Array.from(document.querySelectorAll("iframe")).map((i) => i.src);
              } catch (e) { out.childIframesErr = String(e); }
              // Canvas presence (hint about input target)
              try {
                const cans = Array.from(document.querySelectorAll("canvas"));
                out.canvases = cans.map((c) => ({
                  id: c.id, w: c.width, h: c.height, cls: c.className,
                }));
              } catch (e) { out.canvasErr = String(e); }
              return out;
            }, needle);
            return { frameUrl: f.url(), ...r };
          } catch (e) {
            return { frameUrl: f.url(), err: String(e && e.message || e) };
          }
        }),
      );
      res.json({ ok: true, frames: reports, totalFrames: allFrames.length });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Return the full source of every captured input listener in a chosen frame.
// Use after /inspect-game-frame identifies an interesting (type,target) pair —
// this returns the entire stringified function, not just the 400-char preview,
// so we can read what it does (e.g. is the R-keydown handler dispatching into
// a JS function we could call directly?). Localhost only.
app.get("/api/bots/:id/listeners", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const frameFilter = req.query.frame || null;
    const typeFilter = req.query.type || null;
    const targetFilter = req.query.target || null;
    try {
      const page = entry.bot.page;
      const allFrames = page.frames();
      const targets = frameFilter
        ? allFrames.filter((f) => f.url().includes(frameFilter))
        : allFrames;
      const all = await Promise.all(
        targets.map(async (f) => {
          try {
            const list = await f.evaluate((tf, tgf) => {
              const ls = window.__listeners || [];
              return ls
                .filter((l) => (!tf || l.type === tf) && (!tgf || (l.target || "").includes(tgf)))
                .map((l) => ({
                  ts: l.ts,
                  type: l.type,
                  target: l.target,
                  targetKind: l.targetKind,
                  fullSource: String(l.listener),
                  opts: l.opts,
                }));
            }, typeFilter, targetFilter);
            return list.map((x) => ({ ...x, frameUrl: f.url() }));
          } catch (e) {
            return [{ frameUrl: f.url(), err: String(e && e.message || e) }];
          }
        }),
      );
      res.json({ ok: true, listeners: all.flat() });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// ---------------- Color packet replay ----------------
// Learn / replay the WebSocket "set color" packet so the paint loop can
// switch colors instantly without holding R + clicking the radial menu.
// All localhost-only.

// Manually store a captured packet for `code`. Body:
//   { code: "F0", entry: { kind: "text"|"binary", data: "..." | [bytes] } }
app.post("/api/bots/:id/color-learn", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const { code, entry: packet } = req.body || {};
    if (!code || !packet)
      return res.status(400).json({ error: "code and entry {kind,data} required" });
    try {
      const r = await entry.bot.learnColor(code, packet);
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Auto-learn one color: drives the menu the slow way to actually pick the
// color, captures the resulting outbound WS frame, and stores it as the
// packet for that code. Body: { code, paintMenu? }
app.post("/api/bots/:id/color-learn-auto", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const { code, paintMenu, captureWindowMs } = req.body || {};
    if (!code) return res.status(400).json({ error: "code required" });
    try {
      // Force the slow menu path so we actually generate (and capture) the
      // real WS packet, regardless of whether one is already learned.
      const pm = { ...(paintMenu || {}), fastPath: false };
      const r = await entry.bot.learnColorAuto(code, pm, { captureWindowMs });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Auto-learn a list of colors back-to-back. Body:
//   { codes: ["F0","00",...], paintMenu?, perCellDelayMs?, stopOnError? }
// Returns per-code result and a summary.
app.post("/api/bots/:id/color-learn-batch", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const { codes, paintMenu, perCellDelayMs, stopOnError } = req.body || {};
    if (!Array.isArray(codes) || !codes.length)
      return res.status(400).json({ error: "codes (string[]) required" });
    const pm = { ...(paintMenu || {}), fastPath: false };
    const results = [];
    let learned = 0;
    let failed = 0;
    for (const c of codes) {
      try {
        const r = await entry.bot.learnColorAuto(c, pm, {});
        results.push({ code: c, ...r });
        if (r.ok) learned++; else failed++;
        if (!r.ok && stopOnError) break;
      } catch (e) {
        results.push({ code: c, ok: false, err: (e && e.message) || String(e) });
        failed++;
        if (stopOnError) break;
      }
      if (perCellDelayMs > 0) {
        await new Promise((r) => setTimeout(r, perCellDelayMs));
      }
    }
    res.json({ ok: true, learned, failed, total: codes.length, results });
  }),
);

// Replay the learned packet for `code`. Body: { code }
app.post("/api/bots/:id/color-set", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "code required" });
    try {
      const r = await entry.bot.setColorViaPacket(code);
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// List learned codes (and the kind/length of each stored packet).
app.get("/api/bots/:id/color-map", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    try {
      const m = await entry.bot.getLearnedColors();
      res.json({ ok: true, count: Object.keys(m).length, map: m });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Forget a learned code (or all of them with code: "*").
app.post("/api/bots/:id/color-forget", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "code required (or '*' for all)" });
    try {
      const r = await entry.bot.forgetColor(code);
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// ---------------- WASM probing ----------------
// Drednot's gameplay client is wasm-bindgen-compiled Rust. The exports have
// readable names (immui_set_paint_color, worldmap_set_color, etc.) so the
// theoretical fastest path to "switch color" is to call the export directly
// with the right Rust struct pointer. These endpoints expose the captured
// WASM instance for that experimentation. Localhost only.

// List wasm exports filtered by `q` (regex). Returns name + argc + kind so
// you can pick a target before calling.
app.get("/api/bots/:id/wasm-exports", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const q = req.query.q || "";
    try {
      const page = entry.bot.page;
      const allFrames = page.frames();
      const results = await Promise.all(
        allFrames.map(async (f) => {
          try {
            const list = await f.evaluate((rx) =>
              window.__wasmExports ? window.__wasmExports(rx) : [], q);
            return { frameUrl: f.url(), exports: list };
          } catch (_) {
            return { frameUrl: f.url(), exports: [] };
          }
        }),
      );
      res.json({ ok: true, frames: results.filter((r) => r.exports.length > 0) });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Call a wasm export by name with an args array. Body:
//   { name: "immui_set_paint_color", args: [123456, 240], frame? }
// Numbers go through as-is. Returns { ok, result } or { ok:false, err }.
app.post("/api/bots/:id/wasm-call", express.json({ limit: "64kb" }), (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const { name, args, frame: frameFilter } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    try {
      const page = entry.bot.page;
      const allFrames = page.frames();
      const targets = frameFilter
        ? allFrames.filter((f) => f.url().includes(frameFilter))
        : allFrames;
      // Try frames in order, pick the first one that has the named export.
      let lastErr = null;
      for (const f of targets) {
        try {
          const r = await f.evaluate(
            (n, a) => window.__wasmCall ? window.__wasmCall(n, a) : { ok: false, err: "no hook" },
            name, args || [],
          );
          if (r.ok || (r.err && !/no export named|no wasm instance/.test(r.err))) {
            return res.json({ frameUrl: f.url(), ...r });
          }
          lastErr = r;
        } catch (e) {
          lastErr = { ok: false, err: String(e && e.message || e) };
        }
      }
      res.json({ ok: false, err: "no frame had a callable WASM with that export", lastErr });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

// Read the WASM-import call log (calls into the JS-side wasm-bindgen runtime
// from the WASM, filtered by name patterns we set in bot.js). Useful for
// observing what pointers / values flow when a real color pick happens.
app.get("/api/bots/:id/wasm-call-log", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    const n = Math.max(1, Math.min(1000, parseInt(req.query.n, 10) || 100));
    const fnFilter = req.query.fn || null;
    try {
      const page = entry.bot.page;
      const allFrames = page.frames();
      const all = await Promise.all(
        allFrames.map(async (f) => {
          try {
            const list = await f.evaluate((cnt, ff) =>
              window.__wasmCallLogRecent ? window.__wasmCallLogRecent(cnt, ff) : [],
              n, fnFilter);
            return list.map((x) => ({ ...x, frameUrl: f.url() }));
          } catch (_) {
            return [];
          }
        }),
      );
      const merged = all.flat().sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-n);
      res.json({ ok: true, count: merged.length, calls: merged });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

app.post("/api/bots/:id/wasm-call-log-clear", (req, res) =>
  withBot(req, res, async (entry) => {
    const ip = (req.ip || "").replace("::ffff:", "");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost")
      return res.status(403).json({ error: "localhost only" });
    try {
      const page = entry.bot.page;
      const allFrames = page.frames();
      const out = await Promise.all(
        allFrames.map(async (f) => {
          try {
            const r = await f.evaluate(() =>
              window.__wasmCallLogClear ? window.__wasmCallLogClear() : { ok: false });
            return { url: f.url(), ...r };
          } catch (e) {
            return { url: f.url(), ok: false, err: String(e && e.message || e) };
          }
        }),
      );
      res.json({ ok: true, frames: out });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  }),
);

app.post("/api/bots/:id/search-equip", (req, res) =>
  withBot(req, res, async (entry) => {
    const { query } = req.body || {};
    if (!query || typeof query !== "string")
      return res.status(400).json({ error: "query (string) required" });
    try {
      const result = await entry.bot.searchAndEquip(query);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  }),
);

// ---------------- Auto-paint job ----------------
// Bigger payload limit so the dashboard can POST a 78x78 plan (~6KB JSON)
// — well under express.json's 100KB default, but be generous in case of
// future inline base64.
app.post("/api/bots/:id/paint-job/start", express.json({ limit: "1mb" }), (req, res) =>
  withBot(req, res, async (entry) => {
    const { plan, anchor, paintMenu, options } = req.body || {};
    if (!Array.isArray(plan) || !plan.length) {
      return res.status(400).json({ error: "plan (2D array) required" });
    }
    let useAnchor = anchor;
    if (!useAnchor || !Number.isFinite(Number(useAnchor.x)) || !Number.isFinite(Number(useAnchor.y))) {
      // Default anchor to the bot's current world position so the painting
      // starts at the bot's feet and grows right/up.
      const pos = await entry.bot.getPlayerPosition();
      if (!pos) return res.status(400).json({ error: "no anchor and no player position" });
      useAnchor = { x: pos.x, y: pos.y };
    } else {
      useAnchor = { x: Number(useAnchor.x), y: Number(useAnchor.y) };
    }
    // Run the job asynchronously — the HTTP call returns immediately with
    // the initial status so the UI can poll /paint-job for progress.
    entry.bot.runPaintJob({ plan, anchor: useAnchor, paintMenu, options }).catch((e) => {
      entry.bot.log("error", "paint job crashed: " + (e && e.message));
    });
    res.json({ ok: true, status: entry.bot.paintJobStatus() });
  }),
);

app.post("/api/bots/:id/color-learn-batch", express.json({ limit: "1mb" }), (req, res) =>
  withBot(req, res, async (entry) => {
    const { codes, paintMenu, perCellDelayMs, stopOnError } = req.body || {};
    if (!Array.isArray(codes) || !codes.length) {
      return res.status(400).json({ error: "codes (non-empty array) required" });
    }
    try {
      const result = await entry.bot.learnAllColors(codes, paintMenu, {
        perCellDelayMs,
        stopOnError,
      });
      res.json({ ok: true, ...result, colorMap: await entry.bot.getLearnedColors() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }),
);

app.post("/api/bots/:id/paint-job/stop", (req, res) =>
  withBot(req, res, async (entry) => {
    const cancelled = entry.bot.cancelPaintJob();
    res.json({ ok: true, cancelled, status: entry.bot.paintJobStatus() });
  }),
);

app.get("/api/bots/:id/paint-job", (req, res) =>
  withBot(req, res, async (entry) => {
    res.json(entry.bot.paintJobStatus() || { state: "idle" });
  }),
);

// ---------------- Game-chat poll endpoint ----------------
app.get("/api/game-chat", (req, res) => {
  const since = parseInt(req.query.since || "0", 10);
  const msgs = [];
  for (const entry of bots.values()) {
    for (const msg of entry.chat) {
      // chat events have fields `name` and `body` (not `author`/`text`)
      const author = msg.author || msg.name || null;
      const text   = (msg.text  || msg.body || "").trim();
      // Require text; author may be null for system messages
      if (msg.ts > since && text) {
        msgs.push({ botId: entry.id, ts: msg.ts, author: author || "?", text });
      }
    }
  }
  msgs.sort((a, b) => a.ts - b.ts);
  res.json({ messages: msgs, serverTs: Date.now() });
});

// ---------------- MOTD data from Discord bot ----------------
app.post("/api/bots/:id/motd-data", express.json(), (req, res) =>
  withBot(req, res, async (entry) => {
    entry.bot.setMotdData(req.body || {});
    res.json({ ok: true });
  }),
);

// ---------------- Boot ----------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] dashboard listening on http://0.0.0.0:${PORT}`);

  const fleet = configuredFleet();
  if (fleet.length) {
    for (const ship of fleet) {
      if (!ship.key) {
        console.error(`[fleet] missing anonymous key for ${ship.invite}; skipping`);
        continue;
      }
      createBot({
        label: ship.label,
        target: "https://drednot.io/",
        anonymousKey: ship.key,
        autoJoin: ship.invite,
      });
    }
  } else {
    console.log("[fleet] no ships configured; add invite/key pairs in the dashboard or set DREDNOT_SHIPS and DREDNOT_ANON_KEYS");
  }
  startDiscordBot().catch((error) => {
    console.error(`[discord] startup failed: ${error.message}`);
  });
});

async function shutdown() {
  console.log("[server] shutting down");
  await Promise.all(
    Array.from(bots.values()).map((e) => e.bot.stop().catch(() => {})),
  );
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
