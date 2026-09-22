// Use Puppeteer's core client directly. The stealth plugin hooks Chromium's
// target-created event and, with the hosted Chromium build, can run before a
// new page has a main frame. That causes the browser to disconnect during
// startup with "Requesting main frame too early!" before the bot can navigate.
const puppeteer = require("puppeteer-core");
const EventEmitter = require("events");
const zlib = require("zlib");
const path = require("path");
const os = require("os");

// Palette RGB lookup (decimal code → [r, g, b]) loaded once at startup.
// Keys are the 2-char hex codes the paint plan uses (e.g. "0A", "FF").
const PALETTE_RGB = (() => {
  try {
    return require(path.join(__dirname, "Public", "color-palettes.json")).RGB || {};
  } catch (_) { return {}; }
})();

async function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  // Prefer the host-provided Chromium when available. Its Nix wrapper carries
  // the shared-library runtime needed by Chromium in hosted workflows.
  const { execSync } = require("child_process");
  try {
    const system = execSync("command -v chromium 2>/dev/null || true", {
      encoding: "utf8",
    }).trim();
    if (system) return system;
  } catch {}
  // Fall back to Puppeteer's downloaded browser when the host does not
  // provide Chromium (for example, on a plain Node installation).
  try {
    const bundled = require("puppeteer").executablePath();
    const fs = require("fs");
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {}
  try {
    const p = execSync("find /nix/store -maxdepth 3 -type f -name chromium -perm -111 2>/dev/null | head -1", { encoding: "utf8" }).trim();
    if (p) return p;
  } catch {}
  return "/usr/bin/chromium";
}

class DrednotBot extends EventEmitter {
  constructor(options = {}) {
    super();
    this.anonymousKey = options.anonymousKey || null;
    this._savedCookies = null;
    this.botName = options.botName || "DrednotBot";
    this.commandPrefix = options.commandPrefix || "!";
    this.target = options.target || "https://drednot.io/";
    try {
      const u = new URL(this.target);
      this.targetHost = u.hostname; // e.g. "test.drednot.io"
    } catch {
      this.targetHost = "drednot.io";
    }
    this.browser = null;
    this.page = null;
    this.status = "idle";
    this.startedAt = null;
    this.seenMessageIds = new Set();
    this.lastSeenIndex = 0;
    this.shouldStop = false;
    this.commandStats = { total: 0, commands: {} };
    this.currentShip = { name: null, id: null };
    this._spaceTimer = null;
    this._spaceHeld = false;
    this._spaceHoldEnabled = false;
    this._mouseHeld = false;
    this._mouseHoldNx = 0.5;
    this._mouseHoldNy = 0.5;
    this._heldKeys = new Set();
    this._spamClickEnabled = false;
    this._spamClickNx = 0.5;
    this._spamClickNy = 0.5;
    this._spamClickIntervalMs = 100;
    this._spamClickTimer = null;
    this._spamQEnabled = false;
    this._spamQIntervalMs = 100;
    this._spamQTimer = null;
    this.whitelist = [];
    this.kosList = [];
    this._inventory = {};
    this._motdData = null;
    this._motdUpdateLock = false;
    this._motdTimer = null;
    this._pingTimer = null;
    this._pingInFlight = false;
    this._recentWelcomes = new Map();
    this._pendingWelcomeNames = [];
    this._recentChat = [];
    this._rejoinUrl = options.autoJoin || process.env.DREDNOT_REJOIN_URL || "https://drednot.io/invite/c8tVDgle3lXjEyvCefLlmsbt";
    this._autoJoin = options.autoJoin || process.env.DREDNOT_AUTO_JOIN || null;
    this._afkEnabled = options.afkEnabled !== false;
    this._lastMotdContent = null;
    // Initial chat history is emitted when the observer is installed. Do not
    // welcome old join messages when the bot connects or reconnects.
    this._welcomeReady = false;
  }

  getInventory() {
    return { ...this._inventory };
  }

  grantInventory(item, quantity) {
    this._inventory[item] = (this._inventory[item] || 0) + quantity;
    return this.getInventory();
  }

  _normalizeForSearch(name) {
    return String(name).replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  findUserMatch(list, query) {
    const norm = this._normalizeForSearch(query);
    if (!norm) return [];
    return list.filter((entry) => this._normalizeForSearch(entry).includes(norm));
  }

  log(level, message) {
    const entry = {
      ts: Date.now(),
      level,
      message,
    };
    this.emit("log", entry);
    const ts = new Date(entry.ts).toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}] ${message}`);
  }

  setStatus(status) {
    this.status = status;
    this.emit("status", status);
    this.log("info", `status: ${status}`);
    if (status === "online") {
      this._startAutomation();
    }
  }

  // ── Automation: MOTD + periodic ping ────────────────────────────────────────

  _startAutomation() {
    // Guard against double-start
    if (this._motdTimer && this._pingTimer) return;

    // MOTD refresh every second (skips if content unchanged)
    if (!this._motdTimer) {
      this._motdTimer = setInterval(() => this.updateMotd().catch(() => {}), 1000);
    }

    // AFK ping every minute; rejoin if not in ship. Each bot owns its own
    // browser session, so a fleet can keep multiple ships occupied at once.
    if (this._afkEnabled && !this._pingTimer) {
      this._pingTimer = setInterval(async () => {
        if (this._pingInFlight) return;
        this._pingInFlight = true;
        try {
          await this.send("🌔!", { priority: true, kind: "ping" });
          this.log("info", "periodic ping sent");
          // Wait 5 s then verify we're still in a ship
          await new Promise((r) => setTimeout(r, 5000));
          const inShip = await this._isInShip();
          if (!inShip) {
            this.log("warn", "not in ship after ping — rejoining");
            await this.joinShip(this._rejoinUrl).catch((e) =>
              this.log("error", `rejoin failed: ${e.message}`)
            );
          }
        } catch (e) {
          this.log("warn", `ping/rejoin error: ${e.message}`);
          await this.joinShip(this._rejoinUrl).catch((e2) =>
            this.log("error", `rejoin failed: ${e2.message}`)
          );
        } finally {
          this._pingInFlight = false;
        }
      }, 1 * 60 * 1000);
    }

    this.log("info", "automation started (MOTD every 1 s, ping every 1 min)");
  }

  setAfkEnabled(enabled) {
    this._afkEnabled = enabled !== false;
    if (this._afkEnabled && this.status === "online") {
      this._startAutomation();
    } else if (!this._afkEnabled && this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    this.log("info", `AFK keep-alive ${this._afkEnabled ? "enabled" : "disabled"}`);
    return this._afkEnabled;
  }

  _stopAutomation() {
    if (this._motdTimer) { clearInterval(this._motdTimer); this._motdTimer = null; }
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    this._lastMotdContent = null;
  }

  // ── MOTD management ─────────────────────────────────────────────────────────

  setMotdData(data) {
    this._motdData = data;
    this._lastMotdContent = null; // force a MOTD refresh
  }

  buildMotdBlock() {
    const d = this._motdData;
    if (!d) return "";
    const lines = [];

    // Strip Discord mentions (<@123>, <@&123>, <@!123>) — drednot doesn't render them.
    // Cleans up leftover " / " separators so e.g. "<@123> / Jdawg" → "Jdawg".
    function stripMentions(str) {
      return (str || "")
        .replace(/<@[!&]?\d+>\s*\/?\s*/g, "")
        .replace(/^\s*\/\s*/, "")
        .trim();
    }

    // Extract leading emoji from a tags string. e.g. "🏛/HL" → "🏛", "🐝" → "🐝"
    function leadingEmoji(tags) {
      if (!tags) return "";
      const m = (tags || "").match(/^[\p{Emoji}\u200D\uFE0F]+/u);
      return m ? m[0] : "";
    }

    function missionCountdown(target) {
      if (!target) return "—";
      const remaining = Math.max(0, Math.floor(Number(target) - Date.now() / 1000));
      const minutes = Math.floor(remaining / 60);
      const seconds = remaining % 60;
      return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    const missions = Array.isArray(d.missions) ? d.missions : [];
    if (missions.length) {
      lines.push("Event tracker:");
      missions.forEach((mission) => {
        const server = mission.server || "Unknown server";
        const status = mission.status || "Checking";
        const name = mission.name || "—";
        lines.push(`${server}: ${status}: ${missionCountdown(mission.target)} — ${name}`);
      });
    }

    const rels = d.relations || {};
    const sections = [
      { key: "ally",      label: "Ally" },
      { key: "neutral",   label: "Neutral" },
      { key: "enemy",     label: "Enemy" },
      { key: "whitelist", label: "WL" },
      { key: "kos",       label: "KOS" },
    ];

    // Collect only non-empty sections
    const activeSections = sections.filter(({ key }) => {
      const entries = rels[key] || [];
      return entries.some((e) => (e.name || e));
    });

    if (activeSections.length) {
      lines.push("Relations:");
      activeSections.forEach(({ key, label }, idx) => {
        lines.push(`${label}:`);
        const entries = (rels[key] || []).filter((e) => e.name || typeof e === "string");
        entries.forEach((e) => {
          const name = stripMentions(e.name || e);
          if (!name) return;
          const emoji = leadingEmoji((e.tags || "").trim());
          lines.push(`• ${name}${emoji ? ` ${emoji}` : ""}`);
        });
        // Separator between relation sections; "==========" before members block
        if (idx < activeSections.length - 1) {
          lines.push("__________");
        }
      });
    }

    // Members — now grouped by role: [{role, members: []}]
    const memberGroups = Array.isArray(d.members) ? d.members : [];
    // Support legacy flat array of strings too
    const isFlat = memberGroups.length > 0 && typeof memberGroups[0] === "string";
    const totalCount = isFlat
      ? memberGroups.length
      : memberGroups.reduce((s, g) => s + (g.members || []).length, 0);

    if (totalCount > 0) {
      lines.push("==========");
      lines.push(`Member list(${totalCount}):`);
      if (isFlat) {
        memberGroups.forEach((m) => lines.push(`• ${m}`));
      } else {
        memberGroups.forEach((group, index) => {
          if (index > 0) lines.push("");
          lines.push(`${group.role}`);
          (group.members || []).forEach((m) => lines.push(`• ${m}`));
        });
      }
    }

    return lines.join("\n");
  }

  async _isInShip() {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        const el = document.querySelector("#chat-input");
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    } catch { return false; }
  }

  async updateMotd() {
    if (this._motdUpdateLock) return;
    if (!this.page || this.status !== "online") return;
    this._motdUpdateLock = true;
    try {
      const block = this.buildMotdBlock();
      if (block === this._lastMotdContent) return; // nothing changed

      // Read the currently-displayed MOTD text
      const currentMotd = await this.page.evaluate(() => {
        const el = document.querySelector("#motd-text");
        return el ? (el.textContent || el.innerText || "") : "";
      });

      // Replace only the section between // markers, preserving the rest.
      // If the closing // was truncated by the 500-char game limit, we still
      // use the opening marker as an anchor so we don't keep appending.
      let newMotd;
      const i1 = currentMotd.indexOf("//");
      const i2 = currentMotd.lastIndexOf("//");
      if (i1 !== -1 && i2 !== -1 && i1 !== i2) {
        // Both markers present — replace content between them
        newMotd = currentMotd.slice(0, i1 + 2) + block + currentMotd.slice(i2);
      } else if (i1 !== -1) {
        // Opening marker found but closing // was eaten by the 500-char truncation —
        // replace everything from the marker onwards with the new block
        newMotd = currentMotd.slice(0, i1 + 2) + block + "//";
      } else {
        // No markers yet — wrap the new block and append
        const base = currentMotd.trim();
        newMotd = (base ? base + "\n" : "") + "//" + block + "//";
      }

      // Cap at 4096 chars (game limit)
      newMotd = newMotd.slice(0, 4096);

      // Open the edit panel
      const editBtn = await this.page.$("#motd-edit-button").catch(() => null);
      if (!editBtn) return;
      await editBtn.click();
      await this.page.waitForSelector("#motd-edit-text", {
        visible: true,
        timeout: 2000,
      });

      // Inject the new text
      await this.page.evaluate((text) => {
        const el = document.querySelector("#motd-edit-text");
        if (!el) throw new Error("motd-edit-text not found");
        const proto = el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, text);
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, newMotd);

      // Click Save
      const saveBtn = await this.page.$("#motd-edit .btn-green").catch(() => null);
      if (saveBtn) {
        await saveBtn.click();
      }

      this._lastMotdContent = block;
      this.log("debug", "MOTD updated");
    } catch (e) {
      this.log("debug", `motd update skipped: ${e.message}`);
    } finally {
      this._motdUpdateLock = false;
    }
  }

  async start() {
    if (this.browser) {
      this.log("warn", "bot already running");
      return;
    }
    this.shouldStop = false;
    this._closing = false;
    this.setStatus("launching");
    const executablePath = await findChromium();
    this.log("info", `launching chromium at ${executablePath}`);

    // The launcher supplies a fresh profile for hosted runs. Keep a unique
    // process-local fallback as well, rather than reusing the repository
    // profile or a generic directory that may contain a stale SingletonLock.
    const userDataDir = process.env.DREDNOT_PROFILE_DIR
      || process.env.CHROME_USER_DATA_DIR
      || path.join(os.tmpdir(), `drednot-chrome-${process.pid}-${Date.now()}`);
    const headless = process.env.DREDNOT_HEADLESS !== "false";
    const hasDisplay = !!process.env.DISPLAY;
    const useDisplay = !headless && hasDisplay;
    this.log("info", `DISPLAY=${process.env.DISPLAY || "(none)"}, headless=${headless}, profile=${userDataDir}`);
    this.browser = await puppeteer.launch({
      executablePath,
      headless,
      userDataDir,
      timeout: 60000,
      protocolTimeout: 120000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1280,800",
        // SwiftShader software WebGL — works with or without a real GPU.
        // These flags make Chrome use ANGLE's SwiftShader backend so
        // canvas.getContext('webgl2') returns a real (software) context
        // instead of null, letting the game's WASM initialise fully.
        "--use-gl=angle",
        "--use-angle=swiftshader-webgl",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--enable-unsafe-swiftshader",
        "--disable-gpu-sandbox",
        ...(useDisplay ? [] : ["--disable-gpu"]),
      ],
      defaultViewport: { width: 1280, height: 800 },
    });

    this.browser.on("disconnected", () => {
      this.log("warn", "browser disconnected");
      this.browser = null;
      this.page = null;
      if (!this.shouldStop) {
        this.setStatus("disconnected");
        // try to restart after a delay
        setTimeout(() => {
          if (!this.shouldStop) {
            this.log("info", "attempting auto-restart");
            this.start().catch((e) =>
              this.log("error", `restart failed: ${e.message}`),
            );
          }
        }, 5000);
      } else {
        this.setStatus("stopped");
      }
    });

    this.page = await this.browser.newPage();

    // Inject the anonymous key into localStorage BEFORE the page scripts run
    // so the game auto-restores the session without showing a sign-in modal.
    if (this.anonymousKey && this.anonymousKey !== "demo") {
      const anonKey = this.anonymousKey;
      await this.page.evaluateOnNewDocument((key) => {
        try { localStorage.setItem("anon_key", key); } catch (_) {}
        try { localStorage.setItem("anonymous_key", key); } catch (_) {}
      }, anonKey);
      this.log("info", `anonymous key pre-injected into localStorage (…${anonKey.slice(-6)})`);
    }

    // Inject a WebGL2 stub BEFORE the page scripts run. Drednot.io is a
    // WebGL/WASM game; if getContext('webgl2') returns null (no GPU in the
    // Replit sandbox) the WASM Gfx.init throws immediately and the game
    // never opens its WebSocket, so the bot account never appears in-ship.
    // The stub returns a Proxy that satisfies every GL call the game makes
    // during initialisation without throwing, letting the networking layer
    // proceed normally even though nothing is actually rendered.
    await this.page.evaluateOnNewDocument(() => {
      if (window.__webglMockInstalled) return;
      window.__webglMockInstalled = true;

      // Use WebGL2RenderingContext.prototype as the Proxy target so that
      // `ctx instanceof WebGL2RenderingContext` returns true — wasm-bindgen
      // generated code checks this and throws if the instanceof fails.
      const _wgl2Proto = (typeof WebGL2RenderingContext !== "undefined")
        ? WebGL2RenderingContext.prototype : null;
      const _wgl1Proto = (typeof WebGLRenderingContext !== "undefined")
        ? WebGLRenderingContext.prototype : null;

      function makeCtx(canvas, wglProto) {
        const mkObj = () => new Proxy(wglProto || {}, handler);
        const handler = {
          get(t, prop) {
            if (prop === Symbol.toPrimitive || prop === "valueOf") return () => 0;
            if (prop === "toString") return () => "[WebGLMock]";
            if (prop === "canvas") return canvas;
            if (prop === "drawingBufferWidth")  return canvas ? canvas.width  || 1280 : 1280;
            if (prop === "drawingBufferHeight") return canvas ? canvas.height || 800  : 800;
            // Satisfy prototype-chain lookups on the underlying proto object
            if (wglProto && prop in wglProto && typeof wglProto[prop] !== "function") {
              return wglProto[prop];
            }
            // All numeric GL constants live on the constructor, copy common ones here
            const CONSTS = {
              VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
              COMPILE_STATUS: 35713, LINK_STATUS: 35714, DELETE_STATUS: 35712,
              VALIDATE_STATUS: 35715, ACTIVE_UNIFORMS: 35718, ACTIVE_ATTRIBUTES: 35721,
              FLOAT: 5126, FLOAT_VEC2: 35664, FLOAT_VEC3: 35665, FLOAT_VEC4: 35666,
              INT: 5124, BOOL: 35670, SAMPLER_2D: 35678, SAMPLER_CUBE: 35680,
              ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, STATIC_DRAW: 35044,
              DYNAMIC_DRAW: 35048, TEXTURE_2D: 3553, TEXTURE0: 33984,
              BLEND: 3042, DEPTH_TEST: 2929, CULL_FACE: 2884, SCISSOR_TEST: 3089,
              COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256, STENCIL_BUFFER_BIT: 1024,
              TRIANGLES: 4, LINES: 1, POINTS: 0, UNSIGNED_SHORT: 5123, UNSIGNED_BYTE: 5121,
              LINEAR: 9729, NEAREST: 9728, CLAMP_TO_EDGE: 33071, REPEAT: 10497,
              TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240,
              TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243,
              RGBA: 6408, RGB: 6407, UNSIGNED_INT: 5125,
              FRAMEBUFFER: 36160, RENDERBUFFER: 36161,
              COLOR_ATTACHMENT0: 36064, DEPTH_ATTACHMENT: 36096,
              FRAMEBUFFER_COMPLETE: 36053, DEPTH24_STENCIL8: 35056,
              MAX_TEXTURE_SIZE: 3379, MAX_VIEWPORT_DIMS: 3386,
              RENDERER: 7937, VENDOR: 7936, VERSION: 7938, SHADING_LANGUAGE_VERSION: 35724,
              RED: 6403, R8: 33321, RGBA8: 32856, RGB8: 32849,
              DEPTH_COMPONENT: 6402, DEPTH_COMPONENT16: 33189, DEPTH_COMPONENT24: 33190,
              UNIFORM_BUFFER: 35345, TRANSFORM_FEEDBACK_BUFFER: 35982,
              DRAW_FRAMEBUFFER: 36009, READ_FRAMEBUFFER: 36008,
              COLOR_ATTACHMENT1: 36065, COLOR_ATTACHMENT2: 36066,
              MAX_COLOR_ATTACHMENTS: 36063, MAX_DRAW_BUFFERS: 34852,
              NONE: 0, FUNC_ADD: 32774, SRC_ALPHA: 770, ONE_MINUS_SRC_ALPHA: 771, ONE: 1,
            };
            if (Object.prototype.hasOwnProperty.call(CONSTS, prop)) return CONSTS[prop];
            return function(...a) {
              switch (prop) {
                case "getShaderParameter":  return true;
                case "getProgramParameter": return true;
                case "getError":            return 0;
                case "checkFramebufferStatus": return 36053;
                case "getAttribLocation":   return 0;
                case "getUniformLocation":  return mkObj();
                case "createShader":        return mkObj();
                case "createProgram":       return mkObj();
                case "createBuffer":        return mkObj();
                case "createTexture":       return mkObj();
                case "createFramebuffer":   return mkObj();
                case "createRenderbuffer":  return mkObj();
                case "createVertexArray":   return mkObj();
                case "createTransformFeedback": return mkObj();
                case "createSampler":       return mkObj();
                case "createQuery":         return mkObj();
                case "fenceSync":           return mkObj();
                case "clientWaitSync":      return 37146;
                case "getParameter":
                  if (a[0] === 3379 || a[0] === 34076) return 8192;
                  if (a[0] === 3386) return new Int32Array([8192, 8192]);
                  if (a[0] === 34852) return 8;
                  if (a[0] === 36063) return 8;
                  if (a[0] === 7937) return "WebGL Mock";
                  if (a[0] === 7936) return "Replit";
                  if (a[0] === 7938) return "WebGL 2.0 (Mock)";
                  if (a[0] === 35724) return "OpenGL ES GLSL 3.00 (Mock)";
                  return 0;
                case "getSupportedExtensions": return [];
                case "getExtension":        return null;
                case "getShaderInfoLog":    return "";
                case "getProgramInfoLog":   return "";
                case "getActiveUniform":    return { name: "u", type: 5126, size: 1 };
                case "getActiveAttrib":     return { name: "a", type: 5126, size: 1 };
                default:                    return null;
              }
            };
          },
          set() { return true; },
          // Ensure instanceof checks against both WebGL2 and WebGL1 pass
          getPrototypeOf(t) { return wglProto || t; },
        };
        return new Proxy(wglProto ? Object.create(wglProto) : {}, handler);
      }

      const _origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...rest) {
        // Try real context first; fall back to mock if unavailable
        let real;
        try { real = _origGetContext.apply(this, [type, ...rest]); } catch (_) {}
        if (real) return real;
        if (type === "webgl2") return makeCtx(this, _wgl2Proto);
        if (type === "webgl" || type === "experimental-webgl") return makeCtx(this, _wgl1Proto);
        return null;
      };
    });

    // Install WebGL view-matrix hook BEFORE the page navigates so it catches
    // every uniformMatrix*fv call from the very first frame. Drednot.io is a
    // WASM game whose camera follows the local player, so the view matrix's
    // translation column is essentially the player's world position. We track
    // every (program, location) combination, then expose a smart picker that
    // returns the candidate most likely to be the camera/view matrix.
    await this.page.evaluateOnNewDocument(() => {
      if (window.__playerPosHookInstalled) return;
      window.__playerPosHookInstalled = true;

      const matrices = (window.__wglMatrices = Object.create(null));
      const locIds = new WeakMap();
      let nextId = 1;

      const wrap = (proto, methodName, n) => {
        if (!proto || typeof proto[methodName] !== "function") return;
        const orig = proto[methodName];
        proto[methodName] = function (location, transpose, value) {
          try {
            if (location && value && typeof value.length === "number" && value.length >= n * n) {
              let id = locIds.get(location);
              if (id == null) {
                id = nextId++;
                locIds.set(location, id);
              }
              const key = methodName + "#" + id;
              const arr = new Array(n * n);
              for (let i = 0; i < n * n; i++) arr[i] = value[i];
              let e = matrices[key];
              if (!e) {
                e = matrices[key] = {
                  kind: methodName,
                  size: n,
                  count: 0,
                  ts: 0,
                  lastChangeTs: 0,
                  data: null,
                };
                matrices[key] = e;
              }
              const prev = e.data;
              e.data = arr;
              e.ts = Date.now();
              e.count++;
              if (!prev) {
                e.lastChangeTs = e.ts;
              } else {
                for (let i = 0; i < arr.length; i++) {
                  if (Math.abs(arr[i] - prev[i]) > 1e-6) {
                    e.lastChangeTs = e.ts;
                    break;
                  }
                }
              }
            }
          } catch (_) {}
          return orig.apply(this, arguments);
        };
      };

      const install = () => {
        if (typeof WebGLRenderingContext !== "undefined") {
          wrap(WebGLRenderingContext.prototype, "uniformMatrix3fv", 3);
          wrap(WebGLRenderingContext.prototype, "uniformMatrix4fv", 4);
        }
        if (typeof WebGL2RenderingContext !== "undefined") {
          wrap(WebGL2RenderingContext.prototype, "uniformMatrix3fv", 3);
          wrap(WebGL2RenderingContext.prototype, "uniformMatrix4fv", 4);
        }
      };
      install();

      // Detect translation + scale in a uniform matrix. Drednot uploads
      // matrices in row-major form (translation at d[3], d[7]) but other
      // engines use column-major (translation at d[12], d[13]). We auto-
      // detect by checking which layout produces a sane affine 2D bottom
      // row of [0, 0, 0, 1].
      const decodeMatrix = (e) => {
        const d = e.data;
        if (!d) return null;
        if (e.size === 4 && d.length >= 16) {
          // Row-major / transposed: bottom row is d[12..15] = [0,0,0,1]
          // and translation is d[3] (m03) and d[7] (m13).
          const rowMajor =
            Math.abs(d[12]) < 1e-6 &&
            Math.abs(d[13]) < 1e-6 &&
            Math.abs(d[14]) < 1e-6 &&
            Math.abs(d[15] - 1) < 1e-6;
          // Column-major: last column is d[12..15] = (tx, ty, tz, 1) and
          // bottom row across columns is d[3], d[7], d[11], d[15] = 0,0,0,1.
          const colMajor =
            Math.abs(d[3]) < 1e-6 &&
            Math.abs(d[7]) < 1e-6 &&
            Math.abs(d[11]) < 1e-6 &&
            Math.abs(d[15] - 1) < 1e-6;

          if (rowMajor && !colMajor) {
            return { layout: "row", tx: d[3], ty: d[7], sx: d[0], sy: d[5] };
          }
          if (colMajor && !rowMajor) {
            return { layout: "col", tx: d[12], ty: d[13], sx: d[0], sy: d[5] };
          }
          if (rowMajor && colMajor) {
            // Ambiguous (e.g. identity or zero translation). Prefer column-
            // major as the more common convention; either gives the same
            // answer for translation == 0.
            return { layout: "col?", tx: d[12], ty: d[13], sx: d[0], sy: d[5] };
          }
          return null;
        }
        if (e.size === 3 && d.length >= 9) {
          // Same idea for mat3 (2D affine).
          const rowMajor =
            Math.abs(d[6]) < 1e-6 &&
            Math.abs(d[7]) < 1e-6 &&
            Math.abs(d[8] - 1) < 1e-6;
          const colMajor =
            Math.abs(d[2]) < 1e-6 &&
            Math.abs(d[5]) < 1e-6 &&
            Math.abs(d[8] - 1) < 1e-6;
          if (rowMajor && !colMajor) {
            return { layout: "row", tx: d[2], ty: d[5], sx: d[0], sy: d[4] };
          }
          if (colMajor && !rowMajor) {
            return { layout: "col", tx: d[6], ty: d[7], sx: d[0], sy: d[4] };
          }
          if (rowMajor && colMajor) {
            return { layout: "col?", tx: d[6], ty: d[7], sx: d[0], sy: d[4] };
          }
          return null;
        }
        return null;
      };

      // Convert a decoded matrix into world coordinates of the camera focus
      // (= the local player). For an orthographic projection*view matrix the
      // translation in clip space is -2*camX/W and the X-scale is 2/W, so
      // camX = -tx / sx (and likewise for Y).
      const worldFromDecoded = (m) => {
        if (!m || !Number.isFinite(m.sx) || !Number.isFinite(m.sy)) return null;
        if (Math.abs(m.sx) < 1e-9 || Math.abs(m.sy) < 1e-9) return null;
        return { x: -m.tx / m.sx, y: -m.ty / m.sy };
      };

      window.__getPlayerPosCandidates = function () {
        const now = Date.now();
        const out = [];
        for (const key of Object.keys(matrices)) {
          const e = matrices[key];
          if (!e || !e.data) continue;
          if (now - e.ts > 2000) continue; // ignore stale uniforms
          const m = decodeMatrix(e);
          if (!m) continue;
          if (!Number.isFinite(m.tx) || !Number.isFinite(m.ty)) continue;
          const w = worldFromDecoded(m);
          out.push({
            key,
            kind: e.kind,
            count: e.count,
            ts: e.ts,
            lastChangeTs: e.lastChangeTs,
            ageMs: now - e.lastChangeTs,
            layout: m.layout,
            tx: m.tx,
            ty: m.ty,
            sx: m.sx,
            sy: m.sy,
            worldX: w ? w.x : null,
            worldY: w ? w.y : null,
            data: e.data.slice(),
          });
        }
        out.sort((a, b) => {
          const score = (c) => {
            let s = c.count;
            if (c.ageMs < 500) s += 1e6; // changed within last 0.5s
            // Prefer matrices with non-trivial translation magnitude — the
            // identity matrix used for the background pass has tx=ty=0.
            if (Math.abs(c.tx) + Math.abs(c.ty) > 1e-4) s += 1e4;
            return s;
          };
          return score(b) - score(a);
        });
        return out;
      };

      window.__getPlayerPos = function () {
        const cs = window.__getPlayerPosCandidates();
        if (!cs.length) return null;
        // Skip identity / fullscreen-quad matrices (translation == 0). If
        // nothing else is available the bot isn't in a ship yet — return
        // null rather than misreporting (0, 0) as the player's position.
        const c = cs.find((x) => Math.abs(x.tx) + Math.abs(x.ty) > 1e-4);
        if (!c || !Number.isFinite(c.worldX) || !Number.isFinite(c.worldY)) {
          return null;
        }
        return {
          x: c.worldX,
          y: c.worldY,
          ndcX: c.tx,
          ndcY: c.ty,
          source: c.key,
          layout: c.layout,
          count: c.count,
          ageMs: c.ageMs,
        };
      };

      // Expose the live camera matrix scale + translation so Node-side code
      // can convert arbitrary world coordinates back to canvas-normalized
      // [0,1] positions (used by the auto-paint job to click on a specific
      // ship block from the bot's current viewpoint).
      window.__getCameraMatrix = function () {
        const cs = window.__getPlayerPosCandidates();
        if (!cs.length) return null;
        const c = cs.find((x) => Math.abs(x.tx) + Math.abs(x.ty) > 1e-4);
        if (!c) return null;
        return {
          sx: c.sx, sy: c.sy, tx: c.tx, ty: c.ty,
          source: c.key, layout: c.layout, ageMs: c.ageMs,
        };
      };

      window.__getCanvasSize = function () {
        const cv = document.querySelector("canvas");
        if (!cv) return null;
        const rect = cv.getBoundingClientRect();
        return {
          cssW: rect.width, cssH: rect.height,
          drawW: cv.width, drawH: cv.height,
          left: rect.left, top: rect.top,
        };
      };

      // ---------------- WebSocket interceptor ----------------
      // Drednot doesn't expose `game` / `client` / `socket` on window — its
      // entire client lives inside an IIFE / WASM module. To eventually drive
      // the painter without holding R, we need to capture the WebSocket(s)
      // the page opens and log their traffic so we can identify the "set
      // color" packet. We patch `WebSocket` here BEFORE the page's own
      // bundle executes so the very first connection is captured.
      if (!window.__wsHookInstalled) {
        window.__wsHookInstalled = true;
        const Original = window.WebSocket;
        const sockets = (window.__wsList = []);
        // Ring buffer of recent frames so eval-debug calls can read them.
        const log = (window.__wsLog = []);
        const MAX_LOG = 200;
        const pushLog = (entry) => {
          entry.ts = Date.now();
          log.push(entry);
          if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
        };
        // Parallel ring buffer of raw recv binary frames. Used by the
        // ship-position scraper to find where coords live in drednot's
        // binary protocol and decode all entities in the current zone.
        // Bounded by both count and total bytes so heavy traffic can't
        // blow up memory.
        const bin = (window.__wsBin = []);
        const MAX_BIN = 80;
        const MAX_BIN_BYTES = 6 * 1024 * 1024; // ~6 MB cap
        let binBytes = 0;
        const pushBin = (id, u8) => {
          // Copy out so we don't hold references into the game's buffers.
          const copy = new Uint8Array(u8.length);
          copy.set(u8);
          bin.push({ ts: Date.now(), id, len: copy.length, data: copy });
          binBytes += copy.length;
          while (bin.length > MAX_BIN || binBytes > MAX_BIN_BYTES) {
            const drop = bin.shift();
            if (drop) binBytes -= drop.len;
            else break;
          }
        };
        window.__wsBinStats = function () {
          return { frames: bin.length, bytes: binBytes, cap: MAX_BIN, byteCap: MAX_BIN_BYTES };
        };
        const summarize = (data) => {
          try {
            if (typeof data === "string") {
              return { kind: "text", len: data.length, head: data.slice(0, 200) };
            }
            if (data instanceof ArrayBuffer) {
              const u = new Uint8Array(data);
              const head = Array.from(u.slice(0, 300))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(" ");
              return { kind: "binary", len: u.length, head };
            }
            if (ArrayBuffer.isView(data)) {
              const u = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
              const head = Array.from(u.slice(0, 300))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(" ");
              return { kind: "view", len: u.length, head };
            }
            if (data && typeof data === "object" && data.byteLength != null) {
              return { kind: "blob", len: data.byteLength };
            }
            return { kind: typeof data, head: String(data).slice(0, 200) };
          } catch (e) {
            return { kind: "err", err: String(e) };
          }
        };
        const Patched = function (url, protocols) {
          const ws = protocols !== undefined
            ? new Original(url, protocols)
            : new Original(url);
          // Force binary messages to arrive as ArrayBuffer, not Blob.
          // Without this, Chromium may deliver them as Blob objects which
          // our recv handler can't read synchronously (Blob.arrayBuffer()
          // is async). The assignment is a no-op on connections that already
          // default to arraybuffer.
          try { ws.binaryType = "arraybuffer"; } catch (_) {}
          const id = sockets.length;
          sockets.push(ws);
          window.__lastWS = ws;
          pushLog({ id, dir: "open", url: String(url) });
          const origSend = ws.send.bind(ws);
          ws.send = function (data) {
            pushLog({ id, dir: "send", ...summarize(data) });
            return origSend(data);
          };
          ws.addEventListener("message", (ev) => {
            pushLog({ id, dir: "recv", ...summarize(ev.data) });
            try {
              const d = ev.data;
              let frame = null;
              if (d instanceof ArrayBuffer) {
                pushBin(id, new Uint8Array(d));
                frame = bin[bin.length - 1];
              } else if (ArrayBuffer.isView(d)) {
                pushBin(id, new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
                frame = bin[bin.length - 1];
              }
              // Once the ship-position format is learned, decode every
              // matching frame as it arrives and append the snapshot to
              // a small in-page history. The mine-vs-ship classifier in
              // __getShipPositions uses this history to label entities
              // that haven't moved across recent frames as mines.
              if (frame && window.__shipFormat
                  && frame.len === window.__shipFormat.frameLen
                  && typeof window.__decodeShipFrame === "function") {
                const snap = window.__decodeShipFrame(frame, window.__shipFormat);
                if (snap) {
                  const hist = window.__shipHistory;
                  hist.push({ ts: frame.ts, snap });
                  while (hist.length > 32) hist.shift();
                }
              }
            } catch (_) {}
          });
          ws.addEventListener("close", (ev) => {
            pushLog({ id, dir: "close", code: ev.code, reason: ev.reason });
          });
          ws.addEventListener("error", () => {
            pushLog({ id, dir: "error" });
          });
          return ws;
        };
        Patched.prototype = Original.prototype;
        Patched.CONNECTING = Original.CONNECTING;
        Patched.OPEN = Original.OPEN;
        Patched.CLOSING = Original.CLOSING;
        Patched.CLOSED = Original.CLOSED;
        try {
          window.WebSocket = Patched;
        } catch (_) {}

        // Convenience helper: snapshot the recent log (optionally filtered
        // by direction) for the eval-debug endpoint.
        window.__wsRecent = function (n, dir) {
          const arr = dir ? log.filter((e) => e.dir === dir) : log;
          return arr.slice(-Math.max(1, n || 50));
        };
        // Send a raw payload through the most recent WebSocket — used to
        // experiment with replaying captured packets (e.g. set-color).
        window.__wsSendRaw = function (payload) {
          const ws = window.__lastWS;
          if (!ws || ws.readyState !== 1) return { ok: false, err: "no open ws" };
          try {
            if (typeof payload === "string") {
              ws.send(payload);
              return { ok: true, kind: "text", len: payload.length };
            }
            if (Array.isArray(payload)) {
              const u = new Uint8Array(payload);
              ws.send(u);
              return { ok: true, kind: "binary", len: u.length };
            }
            return { ok: false, err: "unsupported payload type" };
          } catch (e) {
            return { ok: false, err: String(e) };
          }
        };
        // Wipe the WS log — useful right before triggering an action whose
        // packet you want to capture cleanly.
        window.__wsClear = function () {
          const n = log.length;
          log.length = 0;
          return { ok: true, cleared: n };
        };

        // ---------------- Learned color packets ----------------
        // Map of palette code ("00".."FE") → captured "set color" packet.
        // Populated by openPaintMenuAndSelectColor + capture, then replayed
        // by the paint loop's fast path so we don't have to open the menu.
        // Each entry is { kind: "text"|"binary", data: string|number[] }.
        window.__colors = window.__colors || {};
        window.__colorLearn = function (code, entry) {
          if (!code || typeof code !== "string") return { ok: false, err: "code required" };
          const c = code.toUpperCase();
          if (!entry || (entry.kind !== "text" && entry.kind !== "binary")) {
            return { ok: false, err: "entry {kind, data} required" };
          }
          window.__colors[c] = entry;
          return { ok: true, code: c, kind: entry.kind, len: entry.kind === "text" ? entry.data.length : (entry.data || []).length };
        };
        window.__colorForget = function (code) {
          if (code === "*") {
            const n = Object.keys(window.__colors).length;
            window.__colors = {};
            return { ok: true, cleared: n };
          }
          const c = (code || "").toUpperCase();
          if (window.__colors[c]) {
            delete window.__colors[c];
            return { ok: true, code: c };
          }
          return { ok: false, err: "no entry for " + c };
        };
        window.__colorMap = function () {
          const out = {};
          for (const k of Object.keys(window.__colors)) {
            const e = window.__colors[k];
            out[k] = { kind: e.kind, len: e.kind === "text" ? e.data.length : e.data.length };
          }
          return out;
        };
        window.__colorSet = function (code) {
          const c = (code || "").toUpperCase();
          const e = window.__colors[c];
          if (!e) return { ok: false, err: "no learned packet for " + c };
          const ws = window.__lastWS;
          if (!ws || ws.readyState !== 1) return { ok: false, err: "no open ws" };
          try {
            if (e.kind === "text") {
              ws.send(e.data);
              return { ok: true, code: c, kind: "text", len: e.data.length };
            } else {
              const u = new Uint8Array(e.data);
              ws.send(u);
              return { ok: true, code: c, kind: "binary", len: u.length };
            }
          } catch (err) {
            return { ok: false, err: String(err) };
          }
        };

        // ---------------- Ship-position scraper ----------------
        // Goal: passively read the (x, y) of every ship/entity drednot
        // tells our client about, so the dashboard can render a "ships in
        // current zone" list. We never send any extra packets — drednot
        // can't tell we're listening.
        //
        // Drednot's binary protocol isn't documented, so we auto-detect
        // where coords live in each entity-update packet by anchoring on
        // a value we already know: the local player's world position
        // (captured by the WebGL camera-matrix hook). Wherever the
        // player's (px, py) appears as a Float32 LE pair inside a recv
        // frame, that offset is almost certainly an entity position; the
        // record stride can then be derived by looking for repeated
        // (x, y) pairs at constant byte intervals around it.
        //
        // Once we've learned (frameLen, recordOffset, stride), every
        // recv frame of that length is parsed the same way and yields
        // a ships array.
        window.__shipFormat = window.__shipFormat || null;

        const _isPlausibleCoord = (v) =>
          Number.isFinite(v) && Math.abs(v) < 1e6;

        // Numeric encodings we try when looking for (px, py) inside a
        // recv binary frame. Drednot uses MessagePack which stores floats
        // big-endian, but we also probe LE / Float64 just in case.
        // Each entry = { name, size, read(dv, off) }
        const _ENCODINGS = [
          { name: "f32be", size: 4, read: (dv, o) => dv.getFloat32(o, false) },
          { name: "f32le", size: 4, read: (dv, o) => dv.getFloat32(o, true)  },
          { name: "f64be", size: 8, read: (dv, o) => dv.getFloat64(o, false) },
          { name: "f64le", size: 8, read: (dv, o) => dv.getFloat64(o, true)  },
        ];
        window.__wsEncodings = _ENCODINGS.map((e) => ({ name: e.name, size: e.size }));

        // Scan recent recv binary frames for offsets where (px, py) appear
        // as a numeric pair in any of the encodings above. Returns up to
        // `maxHits` candidates so we can vote across multiple frames.
        // Hits are tagged with `encoding` and `pairLayout` (whether x and
        // y are adjacent — "tight" — or separated by a gap such as the
        // MessagePack 0xca marker between them).
        window.__wsFindFloat = function (px, py, opts) {
          opts = opts || {};
          const tol = Number(opts.tol) || 1.5;
          const maxHits = Number(opts.maxHits) || 600;
          const minLen = Number(opts.minLen) || 12;
          // For MessagePack, x and y are usually each prefixed by a 1-byte
          // type marker (0xca for float32, 0xcb for float64), so the y
          // value sits at xOffset + size + 1, NOT xOffset + size. We try
          // both layouts.
          const gapsToTry = opts.gaps || [0, 1];
          if (!Number.isFinite(px) || !Number.isFinite(py)) {
            return { error: "px/py required and must be finite" };
          }
          const out = [];
          for (let fi = bin.length - 1; fi >= 0 && out.length < maxHits; fi--) {
            const f = bin[fi];
            if (!f || f.len < minLen) continue;
            const dv = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
            for (const enc of _ENCODINGS) {
              for (const gap of gapsToTry) {
                const stride = enc.size + gap; // distance from x-byte to y-byte
                const max = f.len - (enc.size + stride);
                for (let off = 0; off <= max; off++) {
                  const x = enc.read(dv, off);
                  if (Math.abs(x - px) > tol) continue;
                  const y = enc.read(dv, off + stride);
                  if (Math.abs(y - py) > tol) continue;
                  out.push({
                    frameTs: f.ts, frameId: f.id, frameLen: f.len,
                    offset: off, x, y, dx: x - px, dy: y - py,
                    encoding: enc.name, gap,
                  });
                  if (out.length >= maxHits) break;
                }
                if (out.length >= maxHits) break;
              }
              if (out.length >= maxHits) break;
            }
          }
          return { hits: out, framesScanned: bin.length };
        };

        // Given a list of hits from __wsFindFloat, pick the most likely
        // ENTITY-RECORD layout:
        //   - frameLen: byte length of frames containing this record type
        //   - recordOffset: smallest matching offset (start of array)
        //   - stride: bytes per entity record
        // Strategy: group hits by frameLen, then for each group try a
        // set of candidate strides and count how many hit-offsets lie on
        // an evenly-spaced lattice from the smallest matching offset.
        window.__wsLearnShipFormat = function (hits, opts) {
          opts = opts || {};
          const candidates = opts.strides || [
            // Common entity-record sizes for raw float arrays AND for
            // MessagePack-encoded entity maps (which include type markers,
            // names, IDs, velocities, etc., so strides are larger).
            8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128
          ];
          if (!Array.isArray(hits) || !hits.length) {
            return { error: "no hits — call __wsFindFloat first" };
          }
          // Group by (frameLen, encoding, gap) so different formats don't
          // pollute each other's stride vote.
          const byKey = new Map();
          for (const h of hits) {
            const k = h.frameLen + ":" + (h.encoding || "f32le") + ":" + (h.gap || 0);
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(h);
          }
          let best = null;
          for (const [key, list] of byKey) {
            const [frameLenS, encoding, gapS] = key.split(":");
            const frameLen = Number(frameLenS), gap = Number(gapS);
            const offsets = list.map((h) => h.offset).sort((a, b) => a - b);
            const minOff = offsets[0];
            for (const stride of candidates) {
              let aligned = 0;
              for (const o of offsets) if ((o - minOff) % stride === 0) aligned++;
              // Reward more aligned hits but penalize formats with only 1
              // total hit (any random byte sequence can match once).
              const score = aligned * 10000 + Math.min(list.length, 50) * 20 - stride;
              const cand = {
                frameLen, recordOffset: minOff, stride, encoding, gap,
                aligned, totalHits: list.length, score,
              };
              if (!best || cand.score > best.score) best = cand;
            }
          }
          return best || { error: "no candidate" };
        };

        // Decode every entity in the most recent recv frame matching
        // the learned (frameLen, recordOffset, stride, encoding, gap).
        // Filters with a sanity range so a wrong format doesn't return
        // garbage.
        window.__wsDecodeShips = function (fmt, opts) {
          opts = opts || {};
          const sanity = Number(opts.sanity) || 1e6;
          if (!fmt || !Number.isFinite(fmt.frameLen) || !Number.isFinite(fmt.stride)
              || !Number.isFinite(fmt.recordOffset)) {
            return { error: "format required {frameLen, recordOffset, stride}" };
          }
          const enc = _ENCODINGS.find((e) => e.name === (fmt.encoding || "f32le")) || _ENCODINGS[1];
          const gap = Number.isFinite(fmt.gap) ? fmt.gap : 0;
          const yOff = enc.size + gap;
          let frame = null;
          for (let i = bin.length - 1; i >= 0; i--) {
            if (bin[i].len === fmt.frameLen) { frame = bin[i]; break; }
          }
          if (!frame) return { ships: [], frameTs: null, note: "no matching frame" };
          const dv = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
          const ships = [];
          for (let o = fmt.recordOffset; o + yOff + enc.size <= frame.len; o += fmt.stride) {
            const x = enc.read(dv, o);
            const y = enc.read(dv, o + yOff);
            if (!_isPlausibleCoord(x) || !_isPlausibleCoord(y)) continue;
            if (Math.abs(x) > sanity || Math.abs(y) > sanity) continue;
            ships.push({ x, y, offset: o });
          }
          return { ships, frameTs: frame.ts, frameLen: frame.len, count: ships.length };
        };

        // Per-frame ship history used by the mine-vs-ship classifier.
        // Filled by the WS message listener every time a frame matching
        // the learned format arrives — that means we sample at the
        // server's update rate (typically ~30 Hz) instead of the 1 Hz
        // dashboard poll, so even slow-moving ships get correctly
        // classified.
        window.__shipHistory = window.__shipHistory || [];

        // Pure decoder used both by the on-arrival history-builder above
        // and by the on-demand caller. Returns an array of {x, y} or null.
        window.__decodeShipFrame = function (frame, fmt) {
          if (!frame || !fmt || frame.len !== fmt.frameLen) return null;
          const enc = _ENCODINGS.find((e) => e.name === (fmt.encoding || "f32le")) || _ENCODINGS[1];
          const gap = Number.isFinite(fmt.gap) ? fmt.gap : 0;
          const yOff = enc.size + gap;
          const dv = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
          const out = [];
          for (let o = fmt.recordOffset; o + yOff + enc.size <= frame.len; o += fmt.stride) {
            const x = enc.read(dv, o);
            const y = enc.read(dv, o + yOff);
            if (!_isPlausibleCoord(x) || !_isPlausibleCoord(y)) continue;
            if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) continue;
            out.push({ x, y });
          }
          return out;
        };

        // One-shot convenience: read ship positions using the cached
        // format AND classify each entity as "ship" (moving) or "mine"
        // (static across recent frames). Also returns the live camera
        // matrix so the dashboard can plot dots on the map.
        window.__getShipPositions = function () {
          const fmt = window.__shipFormat;
          if (!fmt) return { ships: [], format: null, note: "format not learned — run scan" };
          const cam = window.__getCameraMatrix ? window.__getCameraMatrix() : null;

          const hist = window.__shipHistory;
          // Cold start: format just learned, history empty — fall back to
          // a one-shot decode so the dashboard shows something immediately.
          if (!hist.length) {
            const r = window.__wsDecodeShips(fmt);
            if (r && Array.isArray(r.ships)) {
              r.ships = r.ships.map((s) => ({ x: s.x, y: s.y, kind: "unknown", offset: s.offset }));
            }
            return Object.assign({ format: fmt, cameraMatrix: cam }, r);
          }
          const latest = hist[hist.length - 1];
          // Use the last few historical snapshots for classification.
          // An entity that appears (within STATIC_TOL) in MOST of the
          // recent snapshots is considered static → mine. We require at
          // least MIN_HIST snapshots so a freshly-learned format doesn't
          // immediately misclassify everything as moving ships.
          const STATIC_TOL = 0.25;
          const REQUIRED_FRACTION = 0.75;
          const lookback = Math.min(8, hist.length - 1);
          const oldSnaps = hist.slice(-1 - lookback, -1).map((h) => h.snap);
          const ships = latest.snap.map((p) => {
            if (!oldSnaps.length) {
              return { x: p.x, y: p.y, kind: "unknown", staticMatches: 0, sampledOver: 0 };
            }
            let matches = 0;
            for (const old of oldSnaps) {
              for (let i = 0; i < old.length; i++) {
                if (Math.abs(old[i].x - p.x) <= STATIC_TOL
                    && Math.abs(old[i].y - p.y) <= STATIC_TOL) {
                  matches++;
                  break;
                }
              }
            }
            const ratio = matches / oldSnaps.length;
            return {
              x: p.x, y: p.y,
              kind: ratio >= REQUIRED_FRACTION ? "mine" : "ship",
              staticMatches: matches, sampledOver: oldSnaps.length,
            };
          });
          return {
            format: fmt,
            cameraMatrix: cam,
            ships,
            frameTs: latest.ts,
            frameLen: fmt.frameLen,
            count: ships.length,
            historyLen: hist.length,
          };
        };
      }

      // ---------------- Event listener spy ----------------
      // Drednot's WASM client attaches keyboard/mouse handlers to document
      // and the game canvas. Capturing references to those handlers lets us
      // later inspect their source (looking for color-set logic) and, in
      // some cases, invoke them directly to bypass real input events.
      if (!window.__listenerSpyInstalled) {
        window.__listenerSpyInstalled = true;
        const spy = (window.__listeners = []);
        const targetsOfInterest = new Set([
          "keydown", "keyup", "keypress",
          "mousedown", "mouseup", "mousemove", "click", "contextmenu",
          "wheel", "pointerdown", "pointerup", "pointermove",
        ]);
        const tag = (target) => {
          try {
            if (target === window) return "window";
            if (target === document) return "document";
            if (target && target.tagName) {
              const t = target.tagName.toLowerCase();
              const id = target.id ? "#" + target.id : "";
              const cls = target.className && typeof target.className === "string"
                ? "." + target.className.trim().split(/\s+/).join(".")
                : "";
              return t + id + cls;
            }
            return String(target);
          } catch (_) { return "?"; }
        };
        const wrap = (proto, label) => {
          const orig = proto.addEventListener;
          if (!orig || orig.__spied) return;
          const patched = function (type, listener, opts) {
            if (targetsOfInterest.has(type) && typeof listener === "function") {
              try {
                spy.push({
                  ts: Date.now(),
                  target: tag(this),
                  targetKind: label,
                  type,
                  listener, // hold real reference
                  source: String(listener).slice(0, 400),
                  opts: opts === true ? { capture: true } : opts || null,
                });
                if (spy.length > 500) spy.splice(0, spy.length - 500);
              } catch (_) {}
            }
            return orig.call(this, type, listener, opts);
          };
          patched.__spied = true;
          proto.addEventListener = patched;
        };
        try { wrap(EventTarget.prototype, "EventTarget"); } catch (_) {}
        try { wrap(Window.prototype, "Window"); } catch (_) {}
        try { wrap(Document.prototype, "Document"); } catch (_) {}
        try { wrap(HTMLElement.prototype, "HTMLElement"); } catch (_) {}
      }

      // ---------------- WASM module spy ----------------
      // Drednot's gameplay logic is compiled to WebAssembly via wasm-bindgen.
      // We hook BOTH WebAssembly.instantiate and instantiateStreaming so we
      // capture: (a) the instance (its exports are the Rust API surface,
      // including immui_set_paint_color, worldmap_set_color, etc.); and
      // (b) the imports object — wasm-bindgen passes its JS-side runtime
      // through this object, so by snapshotting and optionally wrapping
      // each import we can record which Rust struct pointers get passed
      // back into JS callbacks (the same pointers we then need to feed
      // back into the exports). Captured calls accumulate in
      // __wasmCallLog for inspection.
      if (!window.__wasmSpyInstalled) {
        window.__wasmSpyInstalled = true;
        const wasms = (window.__wasmInstances = []);
        const callLog = (window.__wasmCallLog = []);
        // Whitelist of import-name patterns we wrap with a logger so we can
        // see what pointers/values flow JS↔WASM. Keep this conservative —
        // wrapping every import inflates the log and slows the game.
        const importInteresting = /paint|color|item|menu|equip|build|wedge|pick|select/i;
        const wrapImports = (importsObj) => {
          if (!importsObj || typeof importsObj !== "object") return importsObj;
          const out = {};
          for (const ns of Object.keys(importsObj)) {
            const val = importsObj[ns];
            if (val && typeof val === "object") {
              const newNs = {};
              for (const fn of Object.keys(val)) {
                const f = val[fn];
                if (typeof f === "function" && importInteresting.test(fn)) {
                  newNs[fn] = function (...args) {
                    try {
                      callLog.push({ ts: Date.now(), dir: "js->wasm-import", ns, fn, args: args.slice(0, 8) });
                      if (callLog.length > 1000) callLog.splice(0, callLog.length - 1000);
                    } catch (_) {}
                    return f.apply(this, args);
                  };
                } else {
                  newNs[fn] = f;
                }
              }
              out[ns] = newNs;
            } else {
              out[ns] = val;
            }
          }
          return out;
        };
        const noteInst = (instance, source, importsObj) => {
          try {
            const exp = (instance && instance.exports) || {};
            const exportNames = Object.keys(exp);
            wasms.push({
              ts: Date.now(),
              source,
              exportCount: exportNames.length,
              exportSample: exportNames.slice(0, 100),
              hasMemory: typeof exp.memory === "object",
              memoryBytes: exp.memory && exp.memory.buffer && exp.memory.buffer.byteLength,
              instance,
              imports: importsObj || null,
            });
            window.__lastWasm = instance;
            window.__lastWasmImports = importsObj || window.__lastWasmImports;
          } catch (_) {}
        };
        try {
          const origInst = WebAssembly.instantiate;
          WebAssembly.instantiate = function (a, imports, ...rest) {
            const wrapped = wrapImports(imports);
            const p = origInst.call(this, a, wrapped, ...rest);
            return Promise.resolve(p).then((res) => {
              try {
                if (res && res.instance) noteInst(res.instance, "instantiate(buf)", imports);
                else if (res && res.exports) noteInst(res, "instantiate(mod)", imports);
              } catch (_) {}
              return res;
            });
          };
        } catch (_) {}
        try {
          const origStream = WebAssembly.instantiateStreaming;
          if (origStream) {
            WebAssembly.instantiateStreaming = function (src, imports, ...rest) {
              const wrapped = wrapImports(imports);
              const p = origStream.call(this, src, wrapped, ...rest);
              return Promise.resolve(p).then((res) => {
                try {
                  if (res && res.instance) noteInst(res.instance, "instantiateStreaming", imports);
                } catch (_) {}
                return res;
              });
            };
          }
        } catch (_) {}

        // Helper exposed to the bot for calling any wasm export by name with
        // an args array (numbers or BigInts). Returns the raw result; throws
        // pass through. Used by /wasm-call to drive immui_set_paint_color
        // and friends directly once we know the right pointer arg.
        window.__wasmCall = function (name, args) {
          const inst = window.__lastWasm;
          if (!inst || !inst.exports) return { ok: false, err: "no wasm instance" };
          const fn = inst.exports[name];
          if (typeof fn !== "function") return { ok: false, err: "no export named " + name };
          const a = Array.isArray(args) ? args : [];
          try {
            const result = fn.apply(null, a);
            return { ok: true, name, argc: fn.length, result: typeof result === "bigint" ? String(result) + "n" : result };
          } catch (e) {
            return { ok: false, name, argc: fn.length, err: String(e && e.message || e) };
          }
        };
        // Filter exports by name regex; returns names + argc.
        window.__wasmExports = function (rxStr) {
          const inst = window.__lastWasm;
          if (!inst || !inst.exports) return [];
          const rx = rxStr ? new RegExp(rxStr, "i") : null;
          return Object.keys(inst.exports)
            .filter((k) => !rx || rx.test(k))
            .map((k) => ({
              name: k,
              kind: typeof inst.exports[k],
              argc: typeof inst.exports[k] === "function" ? inst.exports[k].length : null,
            }));
        };
        window.__wasmCallLogRecent = function (n, fnFilter) {
          const log = callLog;
          const filt = fnFilter ? log.filter((e) => (e.fn || "").toLowerCase().includes(fnFilter.toLowerCase())) : log;
          return filt.slice(-Math.max(1, n || 50));
        };
        window.__wasmCallLogClear = function () {
          const n = callLog.length;
          callLog.length = 0;
          return { ok: true, cleared: n };
        };
      }
    });

    this.page.on("console", (msg) => {
      const t = msg.text();
      if (t && !t.includes("DevTools")) {
        // Uncomment to debug page console:
        // this.log("page", t);
      }
    });
    this.page.on("pageerror", (err) => {
      // Suppress noisy Cloudflare Turnstile background errors — they are non-fatal.
      if (/TurnstileError/i.test(err.message)) return;
      this.log("warn", `page error: ${err.message}`);
    });

    this.setStatus("loading");

    this.log("info", `navigating to ${this.target}`);
    this._cachedBox = null;
    await this._gotoWithRetry(this.target, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }, 3, "initial page");

    // A renderer that is busy during anonymous-key restoration can leave a
    // Puppeteer selector wait unresolved even though the browser process is
    // still alive. Bound the complete sign-in phase so startup can recover
    // through the server's retry path instead of remaining stuck forever.
    await Promise.race([
      this.signIn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("sign-in timed out while waiting for Drednot game UI")), 75000),
      ),
    ]);
    // dismissDialogs can block if Chrome's JS thread is busy with WebGL/WASM.
    // Cap it at 30s so a slow game load doesn't crash the whole startup.
    await Promise.race([
      this.dismissDialogs().catch((e) =>
        this.log("warn", `dismissDialogs skipped: ${e.message}`)
      ),
      new Promise((r) => setTimeout(r, 30000)),
    ]);
    // installChatObserver can block if Chrome's JS thread is busy with WebGL.
    // Run it with a 10s cap — if it times out the observer will be re-installed
    // after joinShip() navigates into the ship anyway.
    await Promise.race([
      this.installChatObserver().catch((e) =>
        this.log("warn", `installChatObserver skipped: ${e.message}`)
      ),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
    this.setStatus("online");
    this.startedAt = Date.now();
    this._lastOnlineAt = Date.now();
    this.log("info", "bot is online and listening");

    // Auto-join configured ship on startup
    if (this._autoJoin) {
      this.log("info", `auto-joining ship: ${this._autoJoin}`);
      await this.joinShip(this._autoJoin).catch((e) =>
        this.log("error", `auto-join failed: ${e.message}`)
      );
    }

    // Periodic health log
    this.healthInterval = setInterval(() => {
      this.emit("heartbeat", { uptime: Date.now() - this.startedAt });
    }, 15000);

    // Watch for the Sign-In modal coming back. Skip checks for the first 60s
    // after going online to let the session fully establish.
    this._signInWatcherBusy = false;
    this.signInWatcher = setInterval(async () => {
      if (this._signInWatcherBusy || this._closing) return;
      if (this._lastOnlineAt && Date.now() - this._lastOnlineAt < 60000) return;
      if (!this.page || this.page.isClosed?.()) return;
      this._signInWatcherBusy = true;
      try {
        const visible = await this._isSignInVisible().catch(() => false);
        if (visible) {
          // Let the dashboard know immediately that we've dropped out of the
          // game — otherwise it keeps showing "online" over a black/frozen
          // canvas until one of the recovery steps below finishes, which
          // looks like the bot is stuck rather than actively recovering.
          this.setStatus("reconnecting");

          // Step 1: if we have a ship URL, try navigating straight back to it.
          // The game often crashes back to the lobby (session still valid) so a
          // simple rejoin is far cheaper than a full browser restart.
          if (this._lastJoinedShip) {
            this.log("warn", "sign-in modal detected — attempting fast rejoin first");
            try {
              await this._gotoWithRetry(this._lastJoinedShip, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
              }, 2, "fast rejoin");
              const backInGame = await this.page
                .waitForSelector("#chat-input", { timeout: 15000, visible: true })
                .then(() => true)
                .catch(() => false);
              if (backInGame) {
                await this.dismissDialogs();
                await this.installChatObserver();
                this.setStatus("online");
                this._lastOnlineAt = Date.now();
                this.log("info", "fast rejoin succeeded — bot is back in ship");
                return;
              }
              this.log("warn", "fast rejoin did not find game UI — falling back to cookie restore");
            } catch (rejoinErr) {
              this.log("warn", `fast rejoin error: ${rejoinErr.message}`);
            }
          }

          // Step 2: cookie restore (reload + wait for session)
          this.log("warn", "attempting cookie restore");
          const restored = await this._restoreFromCookies();
          if (!restored) {
            this.log("warn", "cookie restore failed — restarting browser");
            clearInterval(this.signInWatcher);
            this.signInWatcher = null;
            clearInterval(this.healthInterval);
            this.healthInterval = null;
            if (this.browser) {
              try { await this.browser.close(); } catch {}
              this.browser = null;
              this.page = null;
            }
            this.setStatus("disconnected");
            setTimeout(() => {
              if (!this.shouldStop) {
                this.log("info", "restarting browser after Turnstile failure");
                this.start().catch((e) =>
                  this.log("error", `restart failed: ${e.message}`),
                );
              }
            }, 3000);
            return;
          }
          await this.dismissDialogs();
          await this.installChatObserver();
          this.setStatus("online");
          this._lastOnlineAt = Date.now();
          this.log("info", "recovered: bot is online again");
        }
      } catch (e) {
        this.log("warn", "sign-in watcher error: " + (e?.message || e));
      } finally {
        this._signInWatcherBusy = false;
      }
    }, 12000);
  }

  async _gotoWithRetry(url, options = {}, attempts = 3, label = "page") {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (!this.page || this.page.isClosed?.()) {
        throw new Error(`page unavailable while navigating to ${url}`);
      }
      try {
        return await this.page.goto(url, options);
      } catch (error) {
        lastError = error;
        const message = error?.message || String(error);
        const transient = /socket hang up|ERR_|net::|navigation timeout|timed out|timeout/i.test(message);
        if (!transient || attempt >= attempts) throw error;
        const delayMs = Math.min(10000, attempt * 3000);
        this.log(
          "warn",
          `${label} navigation attempt ${attempt}/${attempts} failed: ${message}; retrying in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  async findClickable(textRegex, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await this.page.evaluate((reSrc) => {
        const re = new RegExp(reSrc, "i");
        const all = Array.from(
          document.querySelectorAll("button, a, [role=button]"),
        );
        const visible = all.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && el.offsetParent !== null;
        });
        const t = visible.find((el) => re.test((el.textContent || "").trim()));
        return !!t;
      }, textRegex.source);
      if (found) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async clickByText(textRegex) {
    return await this.page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, "i");
      const all = Array.from(
        document.querySelectorAll("button, a, [role=button]"),
      );
      const visible = all.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.offsetParent !== null;
      });
      const t = visible.find((el) => re.test((el.textContent || "").trim()));
      if (t) {
        t.click();
        return (t.textContent || "").trim();
      }
      return null;
    }, textRegex.source);
  }

  async signIn() {
    this.setStatus("signing-in");
    this.log("info", "checking sign-in state");

    // Step 1: already in game (ship)?
    const alreadyIn = await this.page
      .waitForSelector("#chat-input", { timeout: 4000, visible: true })
      .then(() => true)
      .catch(() => false);
    if (alreadyIn) {
      this.log("info", "already signed in");
      return;
    }

    // Step 1a: already in the lobby (authenticated but not in a ship yet)?
    // Detect by lobby-specific buttons like "New Ship" or "Join Labs".
    const inLobby = await Promise.race([
      this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, [role=button], a"));
        return btns.some((b) => {
          const t = (b.textContent || "").trim();
          return /^(New Ship|Join Labs)$/i.test(t) && b.getBoundingClientRect().width > 0;
        });
      }).catch(() => false),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
    if (inLobby) {
      this.log("info", "already authenticated — in lobby (no ship yet)");
      return;
    }

    // Step 1b: Accept rules/terms modal if present (shown on first load with
    // an anonymous key before the game is accessible).
    const acceptedRules = await Promise.race([
      this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, [role=button]"));
        const visible = btns.filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && b.offsetParent !== null;
        });
        const accept = visible.find((b) => /^accept$/i.test((b.textContent || "").trim()));
        if (accept) { accept.click(); return true; }
        return false;
      }).catch(() => false),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
    if (acceptedRules) {
      this.log("info", "accepted rules modal — waiting for game to load");
      const inGameAfterAccept = await this.page
        .waitForSelector("#chat-input", { timeout: 15000, visible: true })
        .then(() => true)
        .catch(() => false);
      if (inGameAfterAccept) {
        this.log("info", "game loaded after accepting rules");
        return;
      }
    }

    // Step 2: log visible buttons so we can debug if anything differs.
    await this._logVisibleButtons("modal buttons");

    // Step 2c: anonymous key restore flow.
    // The sign-in modal shows "Play Anonymously" first; clicking it reveals the
    // "Restore Anonymous Key" sub-option. Try that path before falling back to
    // a direct search (in case the sub-menu is already open).
    if (this.anonymousKey && this.anonymousKey !== "demo") {
      this.log("info", "anonymous key available — trying Restore Anonymous Key flow");

      // Check if "Restore Anonymous Key" is already visible before touching anything else.
      // Only click "Play Anonymously" if it isn't — some UI states require opening the sub-menu first.
      let sawRestore = await this.findClickable(/restore anonymous key/i, 2000);
      if (!sawRestore) {
        const sawPlayAnon = await this.findClickable(/play anonymously/i, 5000);
        if (sawPlayAnon) {
          await this.clickByText(/play anonymously/i);
          this.log("info", "clicked Play Anonymously to open sub-menu");
          await new Promise((r) => setTimeout(r, 600));
        }
        sawRestore = await this.findClickable(/restore anonymous key/i, 8000);
      }
      if (sawRestore) {
        await this.clickByText(/restore anonymous key/i);
        this.log("info", "clicked Restore Anonymous Key");

        // Wait for the key input field to appear
        const inputFound = await this.page.waitForFunction(
          () => {
            const inputs = Array.from(document.querySelectorAll("input"));
            return inputs.some(
              (i) => (i.type === "text" || i.type === "password") &&
                i.offsetParent !== null && i.getBoundingClientRect().width > 0,
            );
          },
          { timeout: 15000 },
        ).then(() => true).catch(() => false);

        if (!inputFound) {
          this.log("warn", "key input did not appear — pressing Enter as fallback");
        } else {
          this.log("info", "key input appeared — entering anonymous key");
          await this.page.evaluate((key) => {
            const inputs = Array.from(document.querySelectorAll("input")).filter(
              (i) => (i.type === "text" || i.type === "password") &&
                i.offsetParent !== null && i.getBoundingClientRect().width > 0,
            );
            const el = inputs[0];
            if (!el) return;
            el.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(el, key);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, this.anonymousKey);
          await new Promise((r) => setTimeout(r, 400));
        }

        // Submit — try common button texts then fall back to Enter
        const submitted = await this.clickByText(/^(restore|restore key|submit|confirm|ok|continue|play|sign in)$/i);
        if (!submitted) {
          this.log("info", "no submit button matched — pressing Enter");
          await this.page.keyboard.press("Enter");
        } else {
          this.log("info", `submitted via button: "${submitted}"`);
        }

        this.log("info", "waiting for game to load after key restore (up to 45s)…");
        const restored = await this.page
          .waitForFunction(
            () => {
              if (document.querySelector("#chat-input")) return true;
              const buttons = Array.from(
                document.querySelectorAll("button, [role=button], a"),
              );
              return buttons.some((button) => {
                const text = (button.textContent || "").trim();
                const rect = button.getBoundingClientRect();
                return /^(New Ship|Join Labs)$/i.test(text)
                  && rect.width > 0
                  && rect.height > 0
                  && button.offsetParent !== null;
              });
            },
            { timeout: 45000 },
          )
          .then(() => true)
          .catch(() => false);
        if (!restored) {
          await this._logVisibleButtons("post-restore buttons");
          throw new Error("anonymous key restore did not produce the game UI");
        }
        this.log("info", "authenticated UI loaded after anonymous key restore");
        return;
      }
      this.log("warn", "neither Play Anonymously nor Restore Anonymous Key button found");
    }

    throw new Error("no sign-in method succeeded — anonymous key required");
  }

  async _saveSessionCookies() {
    try {
      const raw = await this.page.cookies();
      // Strip partitionKey — Chrome's newer CDP (Network.setCookies /
      // deleteCookies) expects it as a structured object
      // ({topLevelSite, hasCrossSiteAncestor}), but page.cookies() can
      // return it as a plain string, and re-sending that shape back via
      // setCookie() throws "CBOR: map start expected" and breaks restore.
      // We don't need cross-site partitioning for a same-site login cookie,
      // so just drop the field.
      this._savedCookies = raw.map(({ partitionKey, ...rest }) => rest);
      this.log("info", `session cookies saved (${this._savedCookies.length} cookies)`);
    } catch (e) {
      this.log("warn", `failed to save session cookies: ${e.message}`);
    }
  }

  // ── Cookie restore ──────────────────────────────────────────────────────────

  async _restoreFromCookies() {
    if (!this._savedCookies || !this._savedCookies.length) return false;
    try {
      this.log("info", "restoring session from saved cookies and reloading...");
      await this.page.setCookie(...this._savedCookies);
      this._cachedBox = null;
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      const inGame = await this.page
        .waitForSelector("#chat-input", { timeout: 15000, visible: true })
        .then(() => true)
        .catch(() => false);
      const signInStillVisible = await this._isSignInVisible();
      if (inGame && !signInStillVisible) {
        this.log("info", "session restored from cookies successfully");
        return true;
      }
      this.log("warn", "cookie restore did not clear sign-in modal — will try full login");
      return false;
    } catch (e) {
      this.log("warn", `cookie restore failed: ${e.message}`);
      return false;
    }
  }

  async _isSignInVisible() {
    try {
      return await this.page.evaluate(() => {
        const els = Array.from(
          document.querySelectorAll("button, a, [role=button]"),
        );
        const visible = els.filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && b.offsetParent !== null;
        });
        return visible.some((b) =>
          /sign in with email|sign in with google|play anonymously|restore anonymous key/i.test(
            (b.textContent || "").trim(),
          ),
        );
      });
    } catch {
      return false;
    }
  }

  async _logVisibleButtons(prefix) {
    try {
      const labels = await this.page.evaluate(() => {
        const els = Array.from(
          document.querySelectorAll("button, [role=button], a, input[type=button], input[type=submit]"),
        );
        return els
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && e.offsetParent !== null;
          })
          .map((e) => (e.innerText || e.value || "").trim())
          .filter((t) => t)
          .slice(0, 20);
      });
      this.log("info", `${prefix}: ${JSON.stringify(labels)}`);
    } catch (e) {
      this.log("warn", `${prefix} probe failed: ${e.message}`);
    }
  }

  async dismissDialogs() {
    this.log("info", "waiting for game UI");
    // Wait for chat input (in-ship) OR lobby buttons (authenticated but no ship yet)
    try {
      await this.page.waitForFunction(
        () => {
          if (document.querySelector("#chat-input")) return true;
          const btns = Array.from(document.querySelectorAll("button, [role=button], a"));
          return btns.some((b) => /^(New Ship|Join Labs)$/i.test((b.textContent || "").trim()) && b.getBoundingClientRect().width > 0);
        },
        { timeout: 60000 },
      );
      this.log("info", "game UI ready");
    } catch (e) {
      this.log("warn", "game UI not found within timeout; will keep trying");
    }

    // Try to dismiss any popups (rules, tutorial, etc.)
    for (let i = 0; i < 3; i++) {
      let dismissed = null;
      try {
        dismissed = await Promise.race([
          this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button"));
            const candidates = [
              /^ok$/i,
              /^accept$/i,
              /agree/i,
              /continue/i,
              /close/i,
              /dismiss/i,
              /got it/i,
            ];
            for (const b of buttons) {
              const txt = (b.textContent || "").trim();
              if (b.offsetParent === null) continue;
              if (candidates.some((re) => re.test(txt))) {
                b.click();
                return txt;
              }
            }
            return null;
          }),
          new Promise((r) => setTimeout(() => r(null), 8000)),
        ]);
      } catch (e) {
        this.log("warn", `dismissDialogs evaluate failed: ${e.message}`);
        break;
      }
      if (dismissed) {
        this.log("info", `dismissed dialog: ${dismissed}`);
        await new Promise((r) => setTimeout(r, 500));
      } else {
        break;
      }
    }
  }

  async installChatObserver() {
    // Every observer installation starts by replaying the chat history. Keep
    // welcomes disabled until that replay has finished, including after a
    // reconnect or ship navigation.
    this._welcomeReady = false;
    this._pendingWelcomeNames = [];

    // Expose a function on page that the in-page observer will call.
    // After a navigation, the binding remains on the CDP page, so guard against re-expose.
    if (!this._chatBindingExposed) {
      try {
        await this.page.exposeFunction("__onChatMessage", (msg) => {
          return this.handleChatMessage(msg).catch((e) => {
            this.log("warn", `chat message handling failed: ${e.message}`);
          });
        });
        this._chatBindingExposed = true;
      } catch (e) {
        if (/already exists/i.test(e.message)) {
          this._chatBindingExposed = true;
        } else {
          throw e;
        }
      }
    }

    await this.page.evaluate(() => {
      // Tear down any previous observer if we're re-installing after navigation
      if (window.__chatObserver) {
        try { window.__chatObserver.disconnect(); } catch (e) {}
        window.__chatObserver = null;
      }
    });

    const chatFound = await Promise.race([
      this.page.evaluate(() => {
        const container = document.querySelector("#chat-content");
        if (!container) return false;
        window.__chatSeen = new WeakMap();

        const messageElement = (node) => {
          let element = node instanceof Element ? node : node && node.parentElement;
          if (!element || element === container) return null;
          while (element.parentElement && element.parentElement !== container) {
            element = element.parentElement;
          }
          return element.parentElement === container ? element : null;
        };

        const extract = (node) => {
          if (!(node instanceof HTMLElement)) return null;
          // Read a clone so removing badges does not mutate the live chat DOM
          // and trigger another observer cycle.
          const snapshot = node.cloneNode(true);
          snapshot.querySelectorAll(".user-badge-small").forEach((b) => b.remove());
          // Username is in a <bdi> element; message is the last text node
          const bdi = snapshot.querySelector("bdi");
          const name = bdi ? bdi.textContent.trim() : null;
          const lastNode = snapshot.childNodes[snapshot.childNodes.length - 1];
          const body = lastNode
            ? lastNode.textContent.trim().replace(/^[»:]\s*/, "")
            : "";
          const raw = (snapshot.innerText || snapshot.textContent || "").trim();
          if (!raw) return null;
          return { name, body, raw, signature: `${name || ""}\u0000${body}\u0000${raw}` };
        };

        const emit = (node, historical = false) => {
          const element = messageElement(node);
          const msg = extract(element);
          if (!msg) return;
          if (!historical && window.__chatSeen.get(element) === msg.signature) return;
          window.__chatSeen.set(element, msg.signature);
          delete msg.signature;
          window.__onChatMessage(historical ? { ...msg, historical: true } : msg);
        };

        // Initial messages
        Array.from(container.children).forEach((node) => emit(node, true));

        const obs = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === "characterData") {
              emit(m.target);
              continue;
            }
            for (const n of m.addedNodes) {
              emit(n);
            }
            // A row can be updated in place without added nodes.
            if (!m.addedNodes.length) emit(m.target);
          }
        });
        obs.observe(container, {
          childList: true,
          characterData: true,
          subtree: true,
        });
        window.__chatObserver = obs;
        return true;
      }).catch(() => false),
      new Promise((r) => setTimeout(() => r(null), 10000)),
    ]);

    if (chatFound === true) {
      this.log("info", "chat observer installed on #chat-content");
    } else if (chatFound === false) {
      this.log("warn", "chat observer: #chat-content not found in main frame — messages will not be forwarded");
    } else {
      this.log("warn", "chat observer: page.evaluate timed out (WASM busy) — messages may not be forwarded");
    }
    // The observer's initial history has now been processed. Preserve any
    // live join notices that arrived during observer setup instead of dropping
    // them during the navigation/readiness window.
    this._welcomeReady = chatFound === true;
    if (this._welcomeReady && this._pendingWelcomeNames.length) {
      const pending = this._pendingWelcomeNames.splice(0);
      for (const name of pending) this._sendWelcome(name);
    }
    return this._welcomeReady;
  }

  async _sendWelcome(joinedName) {
    if (!this._shouldWelcome(joinedName)) return;
    this.log("info", `player joined: ${joinedName} — sending welcome`);
    await this.send(`Welcome ${joinedName}!`, {
      priority: true,
      kind: "welcome",
    }).catch((err) =>
      this.log("warn", `welcome message failed: ${err.message}`)
    );
  }

  async handleChatMessage(msg) {
    const historical = Boolean(msg && msg.historical);
    const chatMessage = { ...(msg || {}) };
    delete chatMessage.historical;
    this.emit("chat", chatMessage);
    this._recentChat.push(chatMessage);
    if (this._recentChat.length > 100) this._recentChat.shift();
    // Track ship membership from system messages
    if (msg.raw) {
      const m = msg.raw.match(/Joined ship\s+'([^']+)'\s*\{([^}]+)\}/);
      if (m) {
        this.currentShip = { name: m[1], id: m[2] };
        this.emit("ship", this.currentShip);
        this.log("info", `current ship: ${m[1]} {${m[2]}}`);
      }
    }
    if (!historical) {
      const joinedName = this._joinedPlayerName(chatMessage);
      if (joinedName) {
        if (!this._welcomeReady) {
          this._pendingWelcomeNames.push(joinedName);
        } else {
          // Drednot does not reliably echo the bot's own messages through the
          // chat observer. The send itself validates that the input accepted
          // the message, so echo verification would create false failures.
          await this._sendWelcome(joinedName);
        }
      }
    }
    if (historical || !chatMessage.body) return;
    if (!chatMessage.body.startsWith(this.commandPrefix)) return;
    // Don't respond to our own messages
    if (chatMessage.name && chatMessage.name.toLowerCase() === this.botName.toLowerCase())
      return;

    const argsLine = chatMessage.body.slice(this.commandPrefix.length).trim();
    const [cmd, ...args] = argsLine.split(/\s+/);
    if (!cmd) return;
    this.commandStats.total++;
    this.commandStats.commands[cmd.toLowerCase()] =
      (this.commandStats.commands[cmd.toLowerCase()] || 0) + 1;

    try {
      await this.runCommand(cmd.toLowerCase(), args, chatMessage);
    } catch (err) {
      this.log("error", `command error: ${err.message}`);
    }
  }

  _joinedPlayerName(msg) {
    const raw = String(msg && msg.raw || "").replace(/\s+/g, " ").trim();
    const body = String(msg && msg.body || "").replace(/\s+/g, " ").trim();
    const author = String(msg && msg.name || "").trim();
    const authorName = this._safeWelcomeName(author);
    if (
      (!raw && !body) ||
      /Joined ship\s+'[^']+'\s*\{[^}]+\}/i.test(raw)
    ) return null;

    // Some clients expose the player as the message author and only expose
    // "joined the ship" as the body.
    if (/(?:has\s+)?(?:joined|entered)(?:\s+the)?\s+ship\b/i.test(body)) {
      return authorName;
    }

    // Drednot system messages have appeared in a few forms over time, so
    // accept the common "Name joined the ship" variants while keeping the
    // match anchored to the whole message.
    // The system line can include a chat marker, rank, or "system:" prefix.
    // Normalize those wrappers before matching so the welcome does not depend
    // on the exact DOM text shape used by the current game client.
    const normalizedRaw = raw
      .replace(/^[»>:|\-\s]+/, "")
      .replace(/^system\s*:\s*/i, "")
      .replace(/^player\s+/i, "")
      .trim();
    const match = normalizedRaw.match(
      /^(.+?)\s+(?:has\s+)?(?:joined|entered)(?:\s+the)?\s+ship(?:\s+successfully)?\b/i
    );
    if (!match) return null;

    const name = match[1]
      .replace(/^[»:\-\s]+|[»:\-\s]+$/g, "")
      .replace(/^\[[^\]]+\]\s*/, "")
      .trim();
    // The author is the clean player name; the raw text may include a rank
    // such as "[Captain]" before it.
    return authorName || this._safeWelcomeName(name);
  }

  _safeWelcomeName(name) {
    const clean = String(name || "")
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/^[»:\-\s]+|[»:\-\s]+$/g, "")
      .trim();
    if (
      !clean ||
      clean === "?" ||
      /^you$/i.test(clean) ||
      /^the bot$/i.test(clean) ||
      clean.toLowerCase() === this.botName.toLowerCase()
    ) return null;
    return clean;
  }

  _shouldWelcome(name) {
    const key = String(name).toLowerCase();
    const now = Date.now();
    const last = this._recentWelcomes.get(key) || 0;
    // Chat rows can be rewritten several times while the game updates its
    // join roster. Keep one welcome per player for a minute so those updates
    // cannot flood the send queue.
    if (now - last < 60000) return false;
    this._recentWelcomes.set(key, now);

    // Keep this map small during long-running bot sessions.
    for (const [knownName, timestamp] of this._recentWelcomes) {
      if (now - timestamp > 60000) this._recentWelcomes.delete(knownName);
    }
    return true;
  }

  async runCommand(cmd, args, msg) {
    const who = msg.name || "friend";
    switch (cmd) {
      case "help":
      case "commands": {
        const list = [
          `${this.commandPrefix}help`,
          `${this.commandPrefix}ping`,
          `${this.commandPrefix}roll [max]`,
          `${this.commandPrefix}flip`,
          `${this.commandPrefix}choose a|b|c`,
          `${this.commandPrefix}8ball <q>`,
          `${this.commandPrefix}addwhitelist <name>`,
          `${this.commandPrefix}removewhitelist <partial>`,
          `${this.commandPrefix}whitelist`,
          `${this.commandPrefix}addkos <name>`,
          `${this.commandPrefix}removekos <partial>`,
          `${this.commandPrefix}kos`,
        ];
        await this.send(`Commands: ${list.join(" | ")}`);
        break;
      }
      case "ping":
        await this.send(`pong! @${who}`);
        break;
      case "about":
        await this.send(
          `I'm ${this.botName}, a friendly drednot.io bot. Type ${this.commandPrefix}help for commands.`,
        );
        break;
      case "uptime": {
        const ms = Date.now() - (this.startedAt || Date.now());
        await this.send(`uptime: ${formatDuration(ms)}`);
        break;
      }
      case "roll": {
        const max = Math.max(1, parseInt(args[0] || "100", 10) || 100);
        const n = 1 + Math.floor(Math.random() * max);
        await this.send(`@${who} rolled ${n} (1-${max})`);
        break;
      }
      case "flip":
        await this.send(
          `@${who} ${Math.random() < 0.5 ? "Heads" : "Tails"}`,
        );
        break;
      case "choose":
      case "pick": {
        const opts = args.join(" ").split(/[|,]/).map((s) => s.trim()).filter(Boolean);
        if (opts.length < 2) {
          await this.send(`@${who} give me at least two options separated by | or ,`);
        } else {
          await this.send(`@${who} I pick: ${opts[Math.floor(Math.random() * opts.length)]}`);
        }
        break;
      }
      case "8ball": {
        const replies = [
          "It is certain.",
          "Without a doubt.",
          "Yes, definitely.",
          "You may rely on it.",
          "As I see it, yes.",
          "Most likely.",
          "Outlook good.",
          "Signs point to yes.",
          "Reply hazy, try again.",
          "Ask again later.",
          "Better not tell you now.",
          "Cannot predict now.",
          "Concentrate and ask again.",
          "Don't count on it.",
          "My reply is no.",
          "My sources say no.",
          "Outlook not so good.",
          "Very doubtful.",
        ];
        if (!args.length) {
          await this.send(`@${who} ask a question first.`);
        } else {
          await this.send(
            `@${who} ${replies[Math.floor(Math.random() * replies.length)]}`,
          );
        }
        break;
      }
      case "echo":
        if (args.length) await this.send(args.join(" ").slice(0, 180));
        break;
      case "time":
        await this.send(`server time: ${new Date().toUTCString()}`);
        break;

      case "addwhitelist": {
        const nameToAdd = args.join(" ").trim().replace(/^@/, "");
        if (!nameToAdd) {
          await this.send(`@${who} Usage: ${this.commandPrefix}addwhitelist <username>`);
          break;
        }
        const existingWL = this.findUserMatch(this.whitelist, nameToAdd);
        if (existingWL.length > 0) {
          await this.send(`@${who} ${nameToAdd} is already on the Whitelist.`);
        } else {
          this.whitelist.push(nameToAdd);
          this.emit("whitelist-updated", this.whitelist.slice());
          await this.send(`@${who} Added ${nameToAdd} to the Whitelist. (${this.whitelist.length} total)`);
        }
        break;
      }

      case "removewhitelist": {
        const queryWL = args.join(" ").trim().replace(/^@/, "").replace(/^•\s*/, "");
        if (!queryWL) {
          await this.send(`@${who} Usage: ${this.commandPrefix}removewhitelist <part of username>`);
          break;
        }
        const matchesWL = this.findUserMatch(this.whitelist, queryWL);
        if (matchesWL.length === 0) {
          await this.send(`@${who} No one matching "${queryWL}" found in Whitelist.`);
        } else if (matchesWL.length > 1) {
          await this.send(`@${who} Multiple matches: ${matchesWL.join(", ")} — be more specific.`);
        } else {
          this.whitelist = this.whitelist.filter((e) => e !== matchesWL[0]);
          this.emit("whitelist-updated", this.whitelist.slice());
          await this.send(`@${who} Removed ${matchesWL[0]} from the Whitelist. (${this.whitelist.length} remaining)`);
        }
        break;
      }

      case "whitelist": {
        if (this.whitelist.length === 0) {
          await this.send(`Whitelist is empty.`);
        } else {
          await this.send(`Whitelist (${this.whitelist.length}): ${this.whitelist.join(", ")}`);
        }
        break;
      }

      case "addkos": {
        const nameToKos = args.join(" ").trim().replace(/^@/, "");
        if (!nameToKos) {
          await this.send(`@${who} Usage: ${this.commandPrefix}addkos <username>`);
          break;
        }
        const existingKOS = this.findUserMatch(this.kosList, nameToKos);
        if (existingKOS.length > 0) {
          await this.send(`@${who} ${nameToKos} is already on the KOS list.`);
        } else {
          this.kosList.push(nameToKos);
          this.emit("kos-updated", this.kosList.slice());
          await this.send(`@${who} Added ${nameToKos} to KOS list. (${this.kosList.length} total)`);
        }
        break;
      }

      case "removekos": {
        const queryKOS = args.join(" ").trim().replace(/^@/, "").replace(/^•\s*/, "");
        if (!queryKOS) {
          await this.send(`@${who} Usage: ${this.commandPrefix}removekos <part of username>`);
          break;
        }
        const matchesKOS = this.findUserMatch(this.kosList, queryKOS);
        if (matchesKOS.length === 0) {
          await this.send(`@${who} No one matching "${queryKOS}" found in KOS list.`);
        } else if (matchesKOS.length > 1) {
          await this.send(`@${who} Multiple matches: ${matchesKOS.join(", ")} — be more specific.`);
        } else {
          this.kosList = this.kosList.filter((e) => e !== matchesKOS[0]);
          this.emit("kos-updated", this.kosList.slice());
          await this.send(`@${who} Removed ${matchesKOS[0]} from KOS list. (${this.kosList.length} remaining)`);
        }
        break;
      }

      case "kos": {
        if (this.kosList.length === 0) {
          await this.send(`KOS list is empty.`);
        } else {
          await this.send(`KOS list (${this.kosList.length}): ${this.kosList.join(", ")}`);
        }
        break;
      }

      default:
        // unknown command, stay silent
        break;
    }
  }

  send(text, { priority = false, verify = false, kind = "normal" } = {}) {
    if (!text) return Promise.resolve();
    const safe = String(text).slice(0, 199);
    // Sends are intentionally not queued. The game receives each welcome,
    // command response, and ping immediately from its caller.
    return this._sendNow(safe, { verify });
  }

  async _sendNow(safe, { verify = false } = {}) {
    if (!this.page) throw new Error("not connected");
    const beforeCount = this._recentChat.length;
    this.log("debug", `attempting chat send: ${safe}`);

    // The working userscript sends through #chat-send rather than simulating
    // Enter. Keep the native setter so the game's input state is updated, then
    // use the same button click path.
    const sendResult = await this.page.evaluate((text) => {
      const chatBox = document.querySelector("#chat");
      if (chatBox?.classList.contains("closed")) {
        document.querySelector(".chat-title")?.click();
      }
      const input = document.querySelector("#chat-input");
      const button = document.querySelector("#chat-send");
      if (!input || !button) {
        return {
          populated: input ? input.value : null,
          clicked: false,
        };
      }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      button.click();
      return { populated: input.value, clicked: true };
    }, safe);
    if (!sendResult?.clicked) {
      throw new Error("chat send button is unavailable");
    }
    if (sendResult.populated !== safe && sendResult.populated !== "") {
      throw new Error(
        `chat input did not accept text (got ${JSON.stringify(sendResult.populated)})`,
      );
    }
    if (verify) {
      const deadline = Date.now() + 3500;
      let echoed = false;
      while (Date.now() < deadline) {
        echoed = this._recentChat.slice(beforeCount).some((msg) => {
          const body = String(msg && msg.body || "").trim();
          const raw = String(msg && msg.raw || "").trim();
          return body === safe || raw === safe || raw.endsWith(`: ${safe}`);
        });
        if (echoed) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!echoed) {
        throw new Error("Drednot did not echo the chat message");
      }
    }
    this.log("info", `sent chat message: ${safe}`);
  }

  async captureCanvas(quality = 60) {
    if (!this.page) throw new Error("not connected");
    // Cache the canvas bounding box so we don't re-query the DOM every frame.
    // page.screenshot({clip}) is faster than handle.screenshot() because it
    // skips per-call handle creation/disposal and avoids toDataURL's black-
    // screen problem (WebGL clears preserveDrawingBuffer=false after compose).
    if (!this._canvasBBox) {
      const handle = await this.page.$("#canvas-game");
      if (!handle) throw new Error("game canvas not found");
      const box = await handle.boundingBox();
      await handle.dispose().catch(() => {});
      if (!box || box.width === 0 || box.height === 0) throw new Error("game canvas has no bounding box");
      this._canvasBBox = box;
    }
    try {
      return await this.page.screenshot({
        type: "jpeg",
        quality,
        clip: this._canvasBBox,
        omitBackground: false,
      });
    } catch (e) {
      // Bounding box may be stale after a navigation — clear cache and retry next call.
      this._canvasBBox = null;
      throw e;
    }
  }

  // Capture the game canvas as a lossless PNG buffer. Used by the verify-only
  // pass to read pixel colors for many blocks at once from a single snapshot.
  async captureCanvasPng() {
    if (!this.page) throw new Error("not connected");
    const handle = await this.page.$("#canvas-game");
    if (!handle) throw new Error("game canvas not found");
    try {
      return await handle.screenshot({ type: "png", omitBackground: false });
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  // Full PNG decoder — decompresses the IDAT stream and applies all five
  // PNG row-filter types (None, Sub, Up, Average, Paeth) to reconstruct the
  // original pixel data. Returns {data, width, height, bpp} where `data` is
  // a flat Buffer of raw RGB(A) bytes, or null on failure.
  // Used by the verify-only pass to sample many pixels from one screenshot.
  static _decodePng(buf) {
    try {
      let pos = 8; // skip 8-byte PNG signature
      let width, height, bpp = 3;
      const idatBufs = [];
      while (pos + 12 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.slice(pos + 4, pos + 8).toString("ascii");
        if (type === "IHDR") {
          width      = buf.readUInt32BE(pos + 8);
          height     = buf.readUInt32BE(pos + 12);
          // colorType: 2=RGB 6=RGBA
          bpp = buf[pos + 17] === 6 ? 4 : 3;
        } else if (type === "IDAT") {
          idatBufs.push(buf.slice(pos + 8, pos + 8 + len));
        } else if (type === "IEND") {
          break;
        }
        pos += 4 + 4 + len + 4;
      }
      if (!idatBufs.length || !width) return null;
      const raw = zlib.inflateSync(Buffer.concat(idatBufs));
      const stride = 1 + width * bpp; // filter byte + row pixels
      const out = Buffer.alloc(height * width * bpp);
      // Paeth predictor helper (PNG spec §6.6).
      const paeth = (a, b, c) => {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      };
      for (let y = 0; y < height; y++) {
        const filt = raw[y * stride];
        const ro = y * stride + 1;   // raw row offset (after filter byte)
        const oo = y * width * bpp;  // out row offset
        for (let x = 0; x < width; x++) {
          for (let k = 0; k < bpp; k++) {
            const i = x * bpp + k;
            const raw_b = raw[ro + i];
            const a = x > 0 ? out[oo + i - bpp] : 0;
            const b = y > 0 ? out[oo + i - width * bpp] : 0;
            const c = (x > 0 && y > 0) ? out[oo + i - width * bpp - bpp] : 0;
            let v;
            switch (filt) {
              case 0: v = raw_b; break;
              case 1: v = (raw_b + a) & 0xFF; break;
              case 2: v = (raw_b + b) & 0xFF; break;
              case 3: v = (raw_b + Math.floor((a + b) / 2)) & 0xFF; break;
              case 4: v = (raw_b + paeth(a, b, c)) & 0xFF; break;
              default: v = raw_b;
            }
            out[oo + i] = v;
          }
        }
      }
      return { data: out, width, height, bpp };
    } catch (_) {
      return null;
    }
  }

  // Sample [r, g, b] from a decoded PNG at canvas-local pixel (x, y).
  static _sampleDecodedPng(decoded, x, y) {
    if (!decoded) return null;
    const { data, width, height, bpp } = decoded;
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (y * width + x) * bpp;
    return [data[i], data[i + 1], data[i + 2]];
  }

  // Parse a 1×1 PNG buffer (as returned by page.screenshot with a 1px clip)
  // and return [r, g, b] for that pixel. Returns null on any parse failure.
  // Handles both RGB (colorType 2) and RGBA (colorType 6) PNGs; the alpha
  // channel is ignored. Supports only filter-type 0 (None) scanlines, which
  // is what Chrome's screenshot pipeline always emits for tiny clips.
  static _parsePngPixel(buf) {
    try {
      let pos = 8; // skip 8-byte PNG signature
      let colorType = 2;
      const idatBufs = [];
      while (pos + 12 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.slice(pos + 4, pos + 8).toString("ascii");
        if (type === "IHDR") {
          // IHDR data: width(4) height(4) bitDepth(1) colorType(1) ...
          colorType = buf[pos + 17];
        } else if (type === "IDAT") {
          idatBufs.push(buf.slice(pos + 8, pos + 8 + len));
        } else if (type === "IEND") {
          break;
        }
        pos += 4 + 4 + len + 4; // length + type + data + CRC
      }
      if (!idatBufs.length) return null;
      const raw = zlib.inflateSync(Buffer.concat(idatBufs));
      // 1×1 row: [filterByte(1), R(1), G(1), B(1), A?(1)]
      // filterByte must be 0 (None) for a single-pixel image.
      return [raw[1], raw[2], raw[3]];
    } catch (_) {
      return null;
    }
  }

  // Read the canvas pixel at normalized position (nx, ny) ∈ [0,1].
  // Takes a 1×1 Puppeteer screenshot (uses Chrome CDP, works on WebGL
  // canvases regardless of preserveDrawingBuffer) and parses the PNG.
  // Returns [r, g, b] or null on failure.
  async readCanvasPixel(nx, ny) {
    if (!this.page) return null;
    const box = await this._canvasBoxFast();
    const px = Math.round(box.x + box.width  * Math.max(0, Math.min(1, nx)));
    const py = Math.round(box.y + box.height * Math.max(0, Math.min(1, ny)));
    try {
      const buf = await this.page.screenshot({
        type: "png",
        clip: { x: px, y: py, width: 1, height: 1 },
        omitBackground: false,
      });
      return DrednotBot._parsePngPixel(buf);
    } catch (_) {
      return null;
    }
  }

  // Verify that the block at canvas position (nx, ny) matches `code`'s
  // palette colour. Compares the actual pixel (read via a 1px screenshot)
  // to the expected RGB with a Euclidean-distance tolerance of 80 (about
  // 46 per channel). Returns { match, dist, actual, expected }.
  // If the palette code is unknown or the screenshot fails, match is true
  // (we don't penalise blocks we can't check).
  async verifyBlockColor(nx, ny, code) {
    const expected = PALETTE_RGB[code && code.toUpperCase ? code.toUpperCase() : code];
    if (!expected) return { match: true };
    const actual = await this.readCanvasPixel(nx, ny);
    if (!actual) return { match: true };
    const dist = Math.sqrt(
      (actual[0] - expected[0]) ** 2 +
      (actual[1] - expected[1]) ** 2 +
      (actual[2] - expected[2]) ** 2,
    );
    return { match: dist <= 80, dist, actual, expected };
  }

  // ---------- Input controls ----------
  async _focusGame() {
    if (!this.page) throw new Error("not connected");
    try {
      await this.page.evaluate(() => {
        const a = document.activeElement;
        if (
          a &&
          (a.tagName === "INPUT" ||
            a.tagName === "TEXTAREA" ||
            a.isContentEditable)
        ) {
          a.blur();
        }
      });
    } catch {}
  }

  async _canvasBox() {
    const handle = await this.page.$("#canvas-game");
    if (!handle) throw new Error("game canvas not found");
    try {
      const box = await handle.boundingBox();
      if (!box) throw new Error("game canvas not visible");
      return box;
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  // Cached version — used on the hot path (mouse mirror) so spam-clicks
  // don't re-query the canvas box on every press. Cache lives ~1.5s and
  // is invalidated automatically when the page navigates / reloads.
  async _canvasBoxFast() {
    const now = Date.now();
    if (this._cachedBox && now - this._cachedBoxAt < 1500) return this._cachedBox;
    const box = await this._canvasBox();
    this._cachedBox = box;
    this._cachedBoxAt = now;
    return box;
  }

  // Serialize mouse operations on this bot so spam-clicks (and concurrent
  // requests from the dashboard) don't race on the shared puppeteer mouse.
  _enqueueMouse(fn) {
    const prev = this._mouseQueue || Promise.resolve();
    const next = prev.then(fn, fn);
    // Don't keep failed promises in the chain forever.
    this._mouseQueue = next.catch(() => {});
    return next;
  }

  async keyDown(key) {
    if (!this.page) throw new Error("not connected");
    await this._focusGame();
    await this.page.keyboard.down(key);
    this._heldKeys.add(key);
  }

  async keyUp(key) {
    if (!this.page) throw new Error("not connected");
    await this.page.keyboard.up(key);
    this._heldKeys.delete(key);
  }

  async keyTap(key, ms = 80) {
    await this.keyDown(key);
    await new Promise((r) => setTimeout(r, ms));
    await this.keyUp(key);
  }

  async releaseAllKeys() {
    if (!this.page) return;
    for (const k of Array.from(this._heldKeys)) {
      try {
        await this.page.keyboard.up(k);
      } catch {}
    }
    this._heldKeys.clear();
  }

  async mouseDownAt(nx, ny) {
    return this._enqueueMouse(async () => {
      if (!this.page) throw new Error("not connected");
      const box = await this._canvasBoxFast();
      const x = box.x + box.width * Math.max(0, Math.min(1, nx));
      const y = box.y + box.height * Math.max(0, Math.min(1, ny));
      if (this._mirrorHolding) {
        try { await this.page.mouse.up({ clickCount: this._currentClickCount || 1 }); } catch {}
      }
      // Compute clickCount so consecutive clicks at (roughly) the same spot
      // produce real `click` (detail=2) + `dblclick` events in chromium —
      // drednot's hotbar uses dblclick to equip, and without this every
      // mirror click was sent with clickCount=1 (so dblclick never fired).
      const last = this._lastClickEnd;
      let clickCount = 1;
      if (last && Date.now() - last.time < 450) {
        const dx = x - last.x;
        const dy = y - last.y;
        if (Math.hypot(dx, dy) < 8) {
          clickCount = Math.min(3, (last.clickCount || 1) + 1);
        }
      }
      this._currentClickCount = clickCount;
      await this.page.mouse.move(x, y);
      await this.page.mouse.down({ clickCount });
      this._mirrorHolding = { x, y };
      return { ok: true };
    });
  }

  async mouseMoveTo(nx, ny) {
    return this._enqueueMouse(async () => {
      if (!this.page) throw new Error("not connected");
      const box = await this._canvasBoxFast();
      const x = box.x + box.width * Math.max(0, Math.min(1, nx));
      const y = box.y + box.height * Math.max(0, Math.min(1, ny));
      // Interpolate from the last known position so the game receives a
      // smooth stream of mousemove events (required for drag-detection
      // in many HTML5 games like drednot). Without `steps`, puppeteer
      // teleports the cursor and the game never sees the movement.
      const last = this._mirrorHolding;
      let steps = 1;
      if (last) {
        const dx = x - last.x;
        const dy = y - last.y;
        const dist = Math.hypot(dx, dy);
        // ~10px per intermediate step, capped so we don't stall.
        steps = Math.max(1, Math.min(20, Math.round(dist / 10)));
      }
      await this.page.mouse.move(x, y, { steps });
      if (this._mirrorHolding) this._mirrorHolding = { x, y };
      return { ok: true };
    });
  }

  async mouseUpHere() {
    return this._enqueueMouse(async () => {
      if (!this.page) throw new Error("not connected");
      const clickCount = this._currentClickCount || 1;
      const pos = this._mirrorHolding;
      try { await this.page.mouse.up({ clickCount }); } catch {}
      // Record where/when this click ended so the next mouseDownAt can
      // decide whether to bump clickCount (and produce a real dblclick).
      if (pos) {
        this._lastClickEnd = {
          time: Date.now(),
          x: pos.x,
          y: pos.y,
          clickCount,
        };
      }
      this._mirrorHolding = null;
      this._currentClickCount = 1;
      return { ok: true };
    });
  }

  // Latest-target-wins mouse move. The dashboard fires mousemoves at up to
  // 60Hz while dragging, but each puppeteer move + canvas-box lookup takes
  // ~20-40ms over CDP plus network RTT. If we enqueued every one we'd build
  // a long backlog and the cursor would visibly lag behind the user. Instead
  // we keep only the most recent target, and a worker drains it through the
  // shared mouse queue (so mouse-down/up still serialize correctly). When
  // a new target arrives mid-flight we just overwrite — intermediate points
  // are dropped. This is what real games / remote-desktop do.
  mouseMoveCoalesced(nx, ny) {
    if (!this.page) return;
    this._pendingMoveTarget = {
      nx: Math.max(0, Math.min(1, Number(nx))),
      ny: Math.max(0, Math.min(1, Number(ny))),
    };
    this._pumpCoalescedMoves();
  }

  _pumpCoalescedMoves() {
    if (this._coalescedMoveLoopRunning) return;
    this._coalescedMoveLoopRunning = true;
    const loop = () => {
      if (!this._pendingMoveTarget || !this.page) {
        this._coalescedMoveLoopRunning = false;
        return;
      }
      const { nx, ny } = this._pendingMoveTarget;
      this._pendingMoveTarget = null;
      this._enqueueMouse(async () => {
        if (!this.page) return;
        const box = await this._canvasBoxFast();
        const x = box.x + box.width * nx;
        const y = box.y + box.height * ny;
        const last = this._mirrorHolding;
        let steps = 1;
        if (last) {
          const dx = x - last.x;
          const dy = y - last.y;
          const dist = Math.hypot(dx, dy);
          // Smaller cap than the legacy mouseMoveTo path because at 60Hz
          // the per-move deltas are tiny — we don't need many sub-steps,
          // and high step counts compound into noticeable lag.
          steps = Math.max(1, Math.min(8, Math.round(dist / 12)));
        }
        await this.page.mouse.move(x, y, { steps });
        if (this._mirrorHolding) this._mirrorHolding = { x, y };
      }).then(loop, loop);
    };
    loop();
  }

  async dragStart(nx, ny, holdBeforeMs = 200) {
    if (!this.page) throw new Error("not connected");
    await this._focusGame();
    const box = await this._canvasBox();
    const x = box.x + box.width * Math.max(0, Math.min(1, nx));
    const y = box.y + box.height * Math.max(0, Math.min(1, ny));
    if (this._dragHolding) {
      try { await this.page.mouse.up(); } catch {}
      this._dragHolding = null;
    }
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    const hold = Math.max(0, Math.min(2000, Number(holdBeforeMs) || 0));
    if (hold > 0) await new Promise((r) => setTimeout(r, hold));
    this._dragHolding = { x, y };
    return { ok: true, x, y };
  }

  async dragEnd(nx, ny, durationMs = 1200, steps = 40, settleMs = 200) {
    if (!this.page) throw new Error("not connected");
    const box = await this._canvasBox();
    const xEnd = box.x + box.width * Math.max(0, Math.min(1, nx));
    const yEnd = box.y + box.height * Math.max(0, Math.min(1, ny));
    const start = this._dragHolding || { x: xEnd, y: yEnd };
    const dur = Math.max(100, Math.min(8000, Number(durationMs) || 1200));
    const n = Math.max(4, Math.min(120, Number(steps) || 40));
    const perStep = Math.max(8, Math.floor(dur / n));
    try {
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        // ease-in-out for a more human feel
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const x = start.x + (xEnd - start.x) * e;
        const y = start.y + (yEnd - start.y) * e;
        await this.page.mouse.move(x, y);
        await new Promise((r) => setTimeout(r, perStep));
      }
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(2000, Number(settleMs) || 0))));
    } finally {
      try { await this.page.mouse.up(); } catch {}
      this._dragHolding = null;
    }
    return { ok: true };
  }

  async dragCancel() {
    if (this._dragHolding && this.page) {
      try { await this.page.mouse.up(); } catch {}
    }
    this._dragHolding = null;
    return { ok: true };
  }

  async dragCanvas(nx1, ny1, nx2, ny2, holdBeforeMs = 200, durationMs = 1200) {
    await this.dragStart(nx1, ny1, holdBeforeMs);
    return this.dragEnd(nx2, ny2, durationMs);
  }

  async clickCanvas(nx, ny, holdMs = 0) {
    if (!this.page) throw new Error("not connected");
    await this._focusGame();
    const box = await this._canvasBox();
    const x = box.x + box.width * Math.max(0, Math.min(1, nx));
    const y = box.y + box.height * Math.max(0, Math.min(1, ny));
    const hold = Math.max(0, Math.min(60000, Number(holdMs) || 0));
    if (hold > 0) {
      await this.page.mouse.move(x, y);
      await this.page.mouse.down();
      try {
        await new Promise((r) => setTimeout(r, hold));
      } finally {
        try { await this.page.mouse.up(); } catch {}
      }
    } else {
      await this.page.mouse.click(x, y);
    }
  }

  // Real, atomic double-click executed entirely inside chromium so the
  // game receives two click events with the proper short interval that
  // drednot needs to register a double-click (and equip the item).
  async doubleClickCanvas(nx, ny, gapMs = 80) {
    if (!this.page) throw new Error("not connected");
    await this._focusGame();
    const box = await this._canvasBox();
    const x = box.x + box.width * Math.max(0, Math.min(1, nx));
    const y = box.y + box.height * Math.max(0, Math.min(1, ny));
    const gap = Math.max(20, Math.min(500, Number(gapMs) || 80));
    await this.page.mouse.move(x, y);
    // Two manual down/up cycles with explicit clickCount so chromium
    // produces a real `dblclick` event on the canvas — `mouse.click()`
    // with default options always sends clickCount=1, which is why the
    // hotbar wasn't equipping.
    await this.page.mouse.down({ clickCount: 1 });
    await new Promise((r) => setTimeout(r, 30));
    await this.page.mouse.up({ clickCount: 1 });
    await new Promise((r) => setTimeout(r, gap));
    await this.page.mouse.down({ clickCount: 2 });
    await new Promise((r) => setTimeout(r, 30));
    await this.page.mouse.up({ clickCount: 2 });
    // Reset mirror tracker so a follow-up mirror click doesn't get bumped
    // to clickCount=3 (triple) by mistake.
    this._lastClickEnd = null;
    this._currentClickCount = 1;
  }

  async setSpaceHoldCycle({ enabled, holdMs, releaseMs }) {
    if (this._spaceTimer) {
      clearTimeout(this._spaceTimer);
      this._spaceTimer = null;
    }
    if (this._spaceHeld) {
      try { await this.keyUp("Space"); } catch {}
      this._spaceHeld = false;
    }
    this._spaceHoldEnabled = !!enabled;
    if (!this._spaceHoldEnabled) {
      this.log("info", "space-hold cycle: off");
      return;
    }
    const hold = Math.max(50, Math.min(60000, Number(holdMs) || 3000));
    const release = Math.max(50, Math.min(60000, Number(releaseMs) || 200));
    this.log("info", `space-hold cycle: on (${hold}ms hold / ${release}ms release)`);
    const cycle = async () => {
      if (!this._spaceHoldEnabled) return;
      try {
        await this.keyDown("Space");
        this._spaceHeld = true;
      } catch (e) {
        this.log("error", "space-hold down: " + e.message);
      }
      this._spaceTimer = setTimeout(async () => {
        try {
          await this.keyUp("Space");
        } catch (e) {
          this.log("error", "space-hold up: " + e.message);
        }
        this._spaceHeld = false;
        if (!this._spaceHoldEnabled) return;
        this._spaceTimer = setTimeout(cycle, release);
      }, hold);
    };
    cycle();
  }

  async setMouseHoldCenter(enabled, nx, ny) {
    if (!this.page) throw new Error("not connected");
    enabled = !!enabled;
    if (nx != null && Number.isFinite(+nx)) this._mouseHoldNx = Math.max(0, Math.min(1, +nx));
    if (ny != null && Number.isFinite(+ny)) this._mouseHoldNy = Math.max(0, Math.min(1, +ny));
    if (enabled === this._mouseHeld) {
      // Already in desired state — but if still held, move to updated position
      if (enabled) await this.moveMouseHold(this._mouseHoldNx, this._mouseHoldNy);
      return;
    }
    if (enabled) {
      await this._focusGame();
      const box = await this._canvasBox();
      await this.page.mouse.move(
        box.x + this._mouseHoldNx * box.width,
        box.y + this._mouseHoldNy * box.height,
      );
      await this.page.mouse.down();
      this._mouseHeld = true;
      this.log("info", `mouse-hold: on at (${this._mouseHoldNx.toFixed(2)}, ${this._mouseHoldNy.toFixed(2)})`);
    } else {
      try { await this.page.mouse.up(); } catch {}
      this._mouseHeld = false;
      this.log("info", "mouse-hold: off");
    }
  }

  // Move the hold point to a new canvas-normalised position (0–1 each axis).
  // If the mouse is currently held down, the physical cursor moves immediately.
  async moveMouseHold(nx, ny) {
    if (!this.page) throw new Error("not connected");
    nx = Math.max(0, Math.min(1, +nx));
    ny = Math.max(0, Math.min(1, +ny));
    this._mouseHoldNx = nx;
    this._mouseHoldNy = ny;
    if (this._mouseHeld) {
      const box = await this._canvasBox();
      await this.page.mouse.move(box.x + nx * box.width, box.y + ny * box.height);
      this.log("info", `mouse-hold: moved to (${nx.toFixed(2)}, ${ny.toFixed(2)})`);
    }
  }

  // Install (or clear) the spam-click timer entirely inside the browser so
  // there are zero per-tick CDP roundtrips — only one evaluate() call to
  // start and one to stop, eliminating the "freeze" caused by rapid IPC.
  async setSpamClick({ enabled, nx, ny, intervalMs }) {
    if (nx != null && Number.isFinite(+nx)) this._spamClickNx = Math.max(0, Math.min(1, +nx));
    if (ny != null && Number.isFinite(+ny)) this._spamClickNy = Math.max(0, Math.min(1, +ny));
    if (intervalMs != null && Number.isFinite(+intervalMs)) this._spamClickIntervalMs = Math.max(20, +intervalMs);
    this._spamClickEnabled = !!enabled;

    // Always clear any running in-page timer first.
    try {
      await this.page.evaluate(() => {
        if (window.__spamClickId != null) { clearInterval(window.__spamClickId); window.__spamClickId = null; }
      });
    } catch (_) {}

    if (!this._spamClickEnabled) {
      this.log("info", "spam-click: off");
      return;
    }

    // Resolve pixel coords once; the in-page timer does the rest natively.
    let box;
    try { box = await this._canvasBoxFast(); } catch (e) { this.log("error", "spam-click: " + e.message); return; }
    const px = box.x + box.width  * this._spamClickNx;
    const py = box.y + box.height * this._spamClickNy;

    this.log("info", `spam-click: on at (${this._spamClickNx.toFixed(2)}, ${this._spamClickNy.toFixed(2)}) every ${this._spamClickIntervalMs}ms`);
    try {
      await this.page.evaluate(({ px, py, ms }) => {
        window.__spamClickId = setInterval(() => {
          const el = document.elementFromPoint(px, py) || document.body;
          const opts = { bubbles: true, cancelable: true, clientX: px, clientY: py, button: 0, buttons: 1 };
          el.dispatchEvent(new MouseEvent("mousedown", opts));
          el.dispatchEvent(new MouseEvent("mouseup",   { ...opts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent("click",     { ...opts, buttons: 0 }));
        }, ms);
      }, { px, py, ms: this._spamClickIntervalMs });
    } catch (e) { this.log("error", "spam-click install: " + e.message); }
  }

  // Same approach for spam-Q: install a keydown/keyup cycle in whichever
  // frame has the live game socket (the frame that handles keyboard input).
  async setSpamQ({ enabled, intervalMs }) {
    if (intervalMs != null && Number.isFinite(+intervalMs)) this._spamQIntervalMs = Math.max(20, +intervalMs);
    this._spamQEnabled = !!enabled;

    // Clear timer in every frame.
    const clearInPage = async (frame) => {
      try {
        await frame.evaluate(() => {
          if (window.__spamQId != null) { clearInterval(window.__spamQId); window.__spamQId = null; }
        });
      } catch (_) {}
    };
    if (this.page) {
      await Promise.all(this.page.frames().map(clearInPage));
    }

    if (!this._spamQEnabled) {
      this.log("info", "spam-q: off");
      return;
    }

    this.log("info", `spam-q: on every ${this._spamQIntervalMs}ms`);

    // Prefer the game frame (has the live socket); fall back to main frame.
    let targetFrame = null;
    try { targetFrame = await this._findGameFrame(); } catch (_) {}
    if (!targetFrame) targetFrame = this.page.mainFrame();

    try {
      await targetFrame.evaluate((ms) => {
        const fire = () => {
          const kd = new KeyboardEvent("keydown", { key: "q", code: "KeyQ", keyCode: 81, which: 81, bubbles: true, cancelable: true });
          const ku = new KeyboardEvent("keyup",   { key: "q", code: "KeyQ", keyCode: 81, which: 81, bubbles: true, cancelable: true });
          window.dispatchEvent(kd);
          setTimeout(() => window.dispatchEvent(ku), 20);
        };
        window.__spamQId = setInterval(fire, ms);
      }, this._spamQIntervalMs);
    } catch (e) { this.log("error", "spam-q install: " + e.message); }
  }

  getInputState() {
    return {
      spaceHold: this._spaceHoldEnabled,
      mouseHold: this._mouseHeld,
      mouseHoldNx: this._mouseHoldNx,
      mouseHoldNy: this._mouseHoldNy,
      heldKeys: Array.from(this._heldKeys),
      spamClick: this._spamClickEnabled,
      spamClickNx: this._spamClickNx,
      spamClickNy: this._spamClickNy,
      spamClickIntervalMs: this._spamClickIntervalMs,
      spamQ: this._spamQEnabled,
      spamQIntervalMs: this._spamQIntervalMs,
    };
  }

  // Returns { x, y, worldX, worldY, source, kind, count, ageMs } or null.
  // worldX/worldY are the negated translation (camera matrices store -camX,
  // -camY). If the player isn't in a ship yet there's usually no live camera
  // matrix, so this returns null.
  async getPlayerPosition() {
    if (!this.page) throw new Error("not connected");
    return await this.page.evaluate(() => {
      try {
        return typeof window.__getPlayerPos === "function"
          ? window.__getPlayerPos()
          : null;
      } catch (e) {
        return null;
      }
    });
  }

  async getPlayerPositionCandidates() {
    if (!this.page) throw new Error("not connected");
    return await this.page.evaluate(() => {
      try {
        return typeof window.__getPlayerPosCandidates === "function"
          ? window.__getPlayerPosCandidates()
          : [];
      } catch (e) {
        return [];
      }
    });
  }

  // ---------- Ship-position scraper -----------------------------------------
  // The in-page WS hook keeps every recv binary frame in __wsBin. The
  // scanShipPositionFormat helper finds where the player's known coords
  // appear inside those frames (by anchoring on __getPlayerPos) — that
  // tells us the position-field offset and entity stride in drednot's
  // binary update packets. Once learned, getShipPositions decodes every
  // entity in the most recent matching frame. This is fully passive: we
  // never send any extra packets to drednot's server.

  // The WS interceptor lives in whichever frame opened the live game
  // socket — usually the about:blank inner frame, NOT the main drednot.io
  // document. All scan/decode helpers must run there or __wsBin appears
  // empty even when frames are flooding in.
  async _wsFrame() {
    const f = await this._findGameFrame();
    return f || (this.page && this.page.mainFrame());
  }

  async _findFloatInFrames(px, py, opts) {
    const f = await this._wsFrame();
    if (!f) return { error: "no frame" };
    return await f.evaluate(
      (px, py, opts) => {
        try {
          return typeof window.__wsFindFloat === "function"
            ? window.__wsFindFloat(px, py, opts || {})
            : { error: "hook not installed" };
        } catch (e) { return { error: String(e && e.message || e) }; }
      }, px, py, opts || null);
  }

  async _learnShipFormatFromHits(hits) {
    const f = await this._wsFrame();
    if (!f) return { error: "no frame" };
    return await f.evaluate((hits) => {
      try {
        const r = window.__wsLearnShipFormat ? window.__wsLearnShipFormat(hits) : { error: "hook not installed" };
        if (r && r.frameLen != null && !r.error) {
          window.__shipFormat = {
            frameLen: r.frameLen,
            recordOffset: r.recordOffset,
            stride: r.stride,
            encoding: r.encoding || "f32le",
            gap: Number.isFinite(r.gap) ? r.gap : 0,
          };
        }
        return r;
      } catch (e) { return { error: String(e && e.message || e) }; }
    }, hits);
  }

  // Run the full discovery pipeline. We sample the player position
  // twice (separated by `dwellMs` so the player has a chance to move),
  // hit the in-page finder with each anchor, and intersect the candidate
  // offsets. Offsets that match BOTH samples are real position fields;
  // offsets that only matched the first sample were coincidental
  // constants. The intersected set is fed to the format learner.
  async scanShipPositionFormat(opts) {
    if (!this.page) throw new Error("not connected");
    opts = opts || {};
    const dwellMs = Math.max(200, Math.min(5000, Number(opts.dwellMs) || 700));
    const tol = Number(opts.tol) || 1.5;

    const p1 = await this.getPlayerPosition();
    if (!p1 || !Number.isFinite(p1.x) || !Number.isFinite(p1.y)) {
      return { ok: false, error: "player position unknown — bot must be in a ship and the camera must have moved" };
    }
    const r1 = await this._findFloatInFrames(p1.x, p1.y, { tol });
    if (r1.error) return { ok: false, error: r1.error };

    await new Promise((res) => setTimeout(res, dwellMs));

    const p2 = await this.getPlayerPosition();
    let intersected = r1.hits || [];
    if (p2 && Number.isFinite(p2.x) && Number.isFinite(p2.y)
        && (Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y) > tol * 2)) {
      const r2 = await this._findFloatInFrames(p2.x, p2.y, { tol });
      if (r2 && Array.isArray(r2.hits) && r2.hits.length) {
        // Keep hits whose (frameLen, offset) appears in BOTH passes.
        const set2 = new Set(r2.hits.map((h) => h.frameLen + ":" + h.offset));
        intersected = intersected.filter((h) => set2.has(h.frameLen + ":" + h.offset));
        // Plus any new hits from pass 2 that we hadn't seen — same logic
        // in reverse — gives a richer pool for stride detection.
        const set1 = new Set((r1.hits || []).map((h) => h.frameLen + ":" + h.offset));
        for (const h of r2.hits) if (set1.has(h.frameLen + ":" + h.offset)) intersected.push(h);
      }
    }
    if (!intersected.length) {
      return {
        ok: false,
        error: "no offsets matched the player coordinates in any recent frame — try again after moving the bot for a few seconds",
        framesScanned: r1.framesScanned,
        rawHits: (r1.hits || []).length,
      };
    }
    const fmt = await this._learnShipFormatFromHits(intersected);
    if (fmt.error) return { ok: false, error: fmt.error };
    return {
      ok: true,
      format: {
        frameLen: fmt.frameLen,
        recordOffset: fmt.recordOffset,
        stride: fmt.stride,
        encoding: fmt.encoding,
        gap: fmt.gap,
      },
      aligned: fmt.aligned,
      totalHits: fmt.totalHits,
      anchor: { p1, p2 },
    };
  }

  async getShipPositions() {
    if (!this.page) throw new Error("not connected");
    const f = await this._wsFrame();
    if (!f) return { ships: [], format: null, error: "no frame" };
    const r = await f.evaluate(() => {
      try {
        return typeof window.__getShipPositions === "function"
          ? window.__getShipPositions()
          : { ships: [], format: null, error: "hook not installed" };
      } catch (e) { return { ships: [], format: null, error: String(e && e.message || e) }; }
    });
    // Tag each ship with its offset relative to the player so the dashboard
    // can show "X meters away".
    const me = await this.getPlayerPosition();
    if (r && Array.isArray(r.ships) && me && Number.isFinite(me.x)) {
      r.ships = r.ships.map((s) => ({
        ...s,
        dx: s.x - me.x, dy: s.y - me.y,
        dist: Math.sqrt((s.x - me.x) ** 2 + (s.y - me.y) ** 2),
      }));
      r.ships.sort((a, b) => a.dist - b.dist);
      r.player = { x: me.x, y: me.y };
    }
    return r;
  }

  async clearShipPositionFormat() {
    if (!this.page) return { ok: true };
    const f = await this._wsFrame();
    if (!f) return { ok: true };
    return await f.evaluate(() => {
      window.__shipFormat = null;
      window.__shipHistory = [];
      return { ok: true };
    });
  }

  // ---------- Auto-paint pipeline -------------------------------------------
  // The dashboard quantizes an uploaded image into a grid of palette codes
  // (each cell is one ship block, one of the 256 palette colors or null).
  // The bot then walks that grid and, for each non-empty cell:
  //   1. opens the radial paint menu by holding R near the screen center,
  //   2. clicks the matching palette cell, releases R (paint is now equipped),
  //   3. converts the cell's world coordinate to a canvas-normalized point
  //      via the live camera matrix and clicks that point to paint the block.
  //
  // The paint-menu geometry (where the palette grid sits relative to the
  // cursor when you hold R) is *configurable from the dashboard* because it
  // depends on UI scale and the build hasn't been measured precisely yet.
  // The defaults are reasonable starting values; tweak `paintMenu.cell.{x0,y0,w,h}`
  // until the bot actually clicks the right color.

  async getCameraMatrix() {
    if (!this.page) throw new Error("not connected");
    return await this.page.evaluate(() => {
      try {
        return typeof window.__getCameraMatrix === "function"
          ? window.__getCameraMatrix()
          : null;
      } catch (e) {
        return null;
      }
    });
  }

  // Convert a world (x,y) coord into canvas-normalized [0,1] coords using
  // the live camera matrix. WebGL NDC has Y up; the canvas has Y down — we
  // flip Y here. Returns null if no camera matrix is available.
  worldToNorm(worldX, worldY, m) {
    if (!m || !Number.isFinite(m.sx) || !Number.isFinite(m.sy)) return null;
    const ndcX = m.sx * worldX + m.tx;
    const ndcY = m.sy * worldY + m.ty;
    return {
      nx: (ndcX + 1) / 2,
      ny: 1 - (ndcY + 1) / 2,
      ndcX, ndcY,
    };
  }

  async _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Sample player position over time; resolve as soon as horizontal +
  // vertical velocity drops below `threshold` (blocks/second), or `maxMs`
  // elapses. Used between walkToReach and paintAtWorld so we don't click
  // while the bot is still drifting — drift makes the cursor land on the
  // adjacent cell (the "skipped block" pattern) and the camera matrix
  // snapshot used for projection becomes stale by the time the click is
  // delivered. Returns `{ok:true, v}` if the bot stopped, `{ok:false}` on
  // timeout (the caller proceeds anyway — better a slightly-drifty click
  // than no click at all; the patch pass will retry if it really missed).
  async _waitUntilStopped(maxMs = 350, threshold = 0.08) {
    const startTs = Date.now();
    let last = await this.getPlayerPosition();
    let lastTs = last && Number.isFinite(last.x) ? Date.now() : 0;
    while (Date.now() - startTs < maxMs) {
      await this._sleep(12); // 12ms poll — fast confirmation of stillness
      const cur = await this.getPlayerPosition();
      if (!cur || !Number.isFinite(cur.x)) continue;
      if (!last || !Number.isFinite(last.x)) {
        last = cur; lastTs = Date.now(); continue;
      }
      const dt = Math.max(0.005, (Date.now() - lastTs) / 1000);
      const v = Math.hypot(cur.x - last.x, cur.y - last.y) / dt;
      if (v < threshold) return { ok: true, v };
      last = cur;
      lastTs = Date.now();
    }
    return { ok: false };
  }

  // Find the iframe whose patched WebSocket is currently open — this is the
  // frame that owns drednot's game socket (lives inside an iframe; the top
  // frame's lobby socket closes after handshake). Used by all the
  // color-packet helpers below so they target the right frame's __colors map
  // and __lastWS.
  async _findGameFrame() {
    if (!this.page) throw new Error("not connected");
    const frames = this.page.frames();
    const main = this.page.mainFrame();
    const probes = await Promise.all(
      frames.map(async (f) => {
        try {
          const info = await f.evaluate(() => {
            const ws = window.__lastWS;
            if (!ws) return { has: false };
            return { has: true, ready: ws.readyState, url: ws.url };
          });
          return { f, ...info };
        } catch (_) { return { f, has: false }; }
      }),
    );
    const open = probes.filter((p) => p.has && p.ready === 1);
    open.sort((a, b) => (a.f === main ? 1 : 0) - (b.f === main ? 1 : 0));
    return (open[0] && open[0].f) || null;
  }

  // Manually store a captured "set color" packet for `code` so future paints
  // of that color can replay it instead of opening the radial menu.
  // `entry` is { kind: "text"|"binary", data: string|number[] }.
  async learnColor(code, entry) {
    const frame = await this._findGameFrame();
    if (!frame) throw new Error("no open game socket frame");
    return await frame.evaluate(
      (c, e) => window.__colorLearn(c, e),
      code, entry,
    );
  }

  // Replay the learned packet for `code`. Returns { ok, ... } from the page.
  async setColorViaPacket(code) {
    const frame = await this._findGameFrame();
    if (!frame) return { ok: false, err: "no open game socket frame" };
    return await frame.evaluate((c) => window.__colorSet(c), code);
  }

  // Read the learned color map (codes + packet kind/length) from the game
  // frame. Useful for the dashboard to show training progress.
  async getLearnedColors() {
    const frame = await this._findGameFrame();
    if (!frame) return {};
    return await frame.evaluate(() =>
      window.__colorMap ? window.__colorMap() : {});
  }

  async forgetColor(code) {
    const frame = await this._findGameFrame();
    if (!frame) return { ok: false, err: "no open game socket frame" };
    return await frame.evaluate((c) => window.__colorForget(c), code);
  }

  // Auto-learn one color: clear the WS log, drive the radial menu the slow
  // way to actually pick `code`, then capture the resulting outbound frame
  // (which is the "set color" packet) and store it. Returns the captured
  // packet so the caller can inspect / save it.
  async learnColorAuto(code, paintMenu, opts = {}) {
    const captureWindowMs = opts.captureWindowMs || 250;
    const frame = await this._findGameFrame();
    if (!frame) throw new Error("no open game socket frame");
    // Snapshot how many send-frames already exist so we can find the new ones.
    const before = await frame.evaluate(() =>
      ((window.__wsLog || []).filter((e) => e.dir === "send")).length);
    // Drive the menu the real way.
    await this.openPaintMenuAndSelectColor(code, paintMenu);
    // Wait briefly for the WASM to flush the resulting send.
    await this._sleep(captureWindowMs);
    // Pull every new send-frame since `before`. Drednot's set-color is
    // typically a single short frame; if multiple appear we store the LAST
    // one (closest to the click) and return all candidates so the caller can
    // see the trace.
    const sends = await frame.evaluate((skip) => {
      const log = (window.__wsLog || []).filter((e) => e.dir === "send");
      const fresh = log.slice(skip);
      return fresh.map((e) => ({
        kind: e.kind, len: e.len, head: e.head,
      }));
    }, before);
    if (!sends.length) {
      return { ok: false, err: "no new send frames after color pick", code, candidates: [] };
    }
    // For text frames we already have the full payload in `head` if it's
    // ≤200 chars (drednot set-color packets are short). For binary we have
    // up to 128 bytes of hex in `head` — enough for any realistic set-color
    // packet. Re-fetch the *exact* payload from the most recent send so
    // we're not truncating; we do this by re-running send capture with a
    // larger head budget.
    const bestIdx = sends.length - 1;
    const exact = await frame.evaluate((skip, want) => {
      // We can't re-read the actual payload after the fact (the data isn't
      // retained beyond `head`). So we have to rely on `head`. Document the
      // limit here and warn if the frame appears truncated.
      const log = (window.__wsLog || []).filter((e) => e.dir === "send");
      const fresh = log.slice(skip);
      const f = fresh[want];
      if (!f) return null;
      if (f.kind === "text") {
        const truncated = f.len > (f.head ? f.head.length : 0);
        return { kind: "text", data: f.head, truncated, len: f.len };
      }
      if (f.kind === "binary" || f.kind === "view") {
        const bytes = (f.head || "").trim().split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));
        const truncated = f.len > bytes.length;
        return { kind: "binary", data: bytes, truncated, len: f.len };
      }
      return null;
    }, before, bestIdx);
    if (!exact) return { ok: false, err: "could not extract packet", code, candidates: sends };
    if (exact.truncated) {
      return {
        ok: false,
        err: `captured packet was truncated by the WS log buffer (full len=${exact.len}). Increase head budget in the WS hook before re-learning.`,
        code, partial: exact, candidates: sends,
      };
    }
    const stored = await frame.evaluate(
      (c, e) => window.__colorLearn(c, e),
      code, { kind: exact.kind, data: exact.data },
    );
    return { ok: true, code: code.toUpperCase(), packet: exact, stored, candidates: sends };
  }

  async learnAllColors(codes, paintMenu, opts = {}) {
    const list = Array.isArray(codes) ? codes : [];
    const unique = [];
    const seen = new Set();
    for (const code of list) {
      const c = String(code || "").toUpperCase();
      if (!c || seen.has(c)) continue;
      seen.add(c);
      unique.push(c);
    }
    const results = [];
    const perCellDelayMs = Math.max(0, Number(opts.perCellDelayMs) || 0);
    const stopOnError = !!opts.stopOnError;
    for (let i = 0; i < unique.length; i++) {
      const code = unique[i];
      const r = await this.learnColorAuto(code, paintMenu, opts);
      results.push(r);
      if (!r.ok && stopOnError) {
        return { ok: false, results, failedCode: code, failedIndex: i };
      }
      if (perCellDelayMs > 0 && i < unique.length - 1) {
        await this._sleep(perCellDelayMs);
      }
    }
    return { ok: true, results, count: unique.length };
  }

  // Open the paint menu and click the cell for `code` (a 2-char hex string
  // "00".."FE"). Important: drednot's paint picker opens at a FIXED position
  // on screen — it does NOT follow the cursor — so `anchor` is just where
  // we park the cursor before pressing the trigger. After the menu opens
  // we move the cursor to `anchor + cell.x0 + (col+0.5)*cell.w` (and same
  // for y) and left-click to select the wedge.
  //
  // FAST PATH: if a packet has been learned for this code (see learnColor /
  // learnColorAuto), we replay that WS frame directly and skip the radial
  // menu entirely. Disable per-call by passing `paintMenu.fastPath = false`
  // (learnColorAuto must do this so it actually drives the real menu and
  // captures the resulting packet).
  async openPaintMenuAndSelectColor(code, paintMenu) {
    if (!this.page) throw new Error("not connected");
    const fastPath = !paintMenu || paintMenu.fastPath !== false;
    if (fastPath) {
      try {
        const r = await this.setColorViaPacket(code);
        if (r && r.ok) return { fastPath: true, ...r };
      } catch (_) { /* fall through to menu */ }
    }
    const anchor = (paintMenu && paintMenu.anchor) || { nx: 0.5, ny: 0.5 };
    const cell = (paintMenu && paintMenu.cell) || {
      // Calibrated against test.drednot.io at canvas size 1280x800. The
      // menu is a 16x16 grid spanning canvas pixels x=382..899 y=137..662
      // (cells ~32.3x32.8 px). Cell (0,0) center sits at norm
      // (0.3111, 0.1918), so the offsets below are relative to anchor
      // (0.5, 0.5) — i.e. cell.x0 = cell00center.nx - anchor.nx - cell.w/2.
      x0: -0.2015, y0: -0.3287, w: 0.0252, h: 0.0410,
    };
    // How the radial color picker is opened. In drednot you HOLD R to
    // bring up the color wheel and LEFT-CLICK a wedge to pick that color.
    // We keep "rightclick" as an alternate trigger in case the user has
    // rebound it. `triggerKey` lets the user point at any keyboard
    // shortcut they've bound.
    const trigger = (paintMenu && paintMenu.trigger) || "key";
    const triggerKey = (paintMenu && paintMenu.triggerKey) || "r";
    const openDelay = (paintMenu && paintMenu.openDelayMs) ?? 200;
    const afterClose = (paintMenu && paintMenu.afterCloseMs) ?? 100;

    const idx = parseInt(code, 16);
    if (!Number.isFinite(idx) || idx < 0 || idx > 255) {
      throw new Error("invalid color code: " + code);
    }
    // Drednot's color picker is laid out 16 cols x 16 rows = 256 cells, but
    // two cells are NOT colors:
    //   - 0xFF: doesn't exist in the official palette (row F has only 15
    //           color entries: F0..FE).
    //   - 0xFA: replaced in the picker by the [X] cancel button at row F,
    //           col 10. Clicking it just closes the menu without selecting.
    //           The dsa.tools palette JSON still lists FA's RGB but the
    //           in-game picker can't pick it, so the quantizer should also
    //           avoid emitting FA.
    if (idx === 0xff || idx === 0xfa) {
      throw new Error(`color ${code} is not selectable in the picker`);
    }
    const col = idx & 0x0f;
    const row = (idx >> 4) & 0x0f;
    const targetNx = anchor.nx + cell.x0 + (col + 0.5) * cell.w;
    const targetNy = anchor.ny + cell.y0 + (row + 0.5) * cell.h;

    // Park cursor at the menu anchor, then engage the trigger so the menu
    // opens at that screen location. Move to the chosen palette cell
    // (without releasing the trigger) and click it, then release.
    await this.mouseMoveTo(anchor.nx, anchor.ny);
    await this._sleep(40);

    if (trigger === "rightclick") {
      // Hold right mouse button to open drednot's radial color picker, then
      // LEFT-click the chosen palette wedge to actually select it (the
      // selection is a left click, not just releasing the trigger), then
      // release the right button to close the menu.
      try {
        await this.page.mouse.down({ button: "right" });
      } catch (e) {
        throw new Error("failed to press right mouse: " + e.message);
      }
      await this._sleep(openDelay);
      await this.mouseMoveTo(targetNx, targetNy);
      await this._sleep(40);
      await this.mouseDownAt(targetNx, targetNy);
      await this._sleep(30);
      await this.mouseUpHere();
      await this._sleep(30);
      try { await this.page.mouse.up({ button: "right" }); } catch {}
      await this._sleep(afterClose);
    } else {
      // Legacy keyboard-trigger path (default key: R).
      await this.keyDown(triggerKey);
      await this._sleep(openDelay);
      await this.mouseMoveTo(targetNx, targetNy);
      await this._sleep(30);
      await this.mouseDownAt(targetNx, targetNy);
      await this._sleep(30);
      await this.mouseUpHere();
      await this._sleep(30);
      await this.keyUp(triggerKey);
      await this._sleep(afterClose);
    }
  }

  // Paint a single block at the given world coordinate, assuming the correct
  // color is already equipped. Throws if the target is outside the visible
  // viewport (caller should re-aim camera / move closer).
  //
  // opts:
  //   holdMs   — how long to hold the mouse down (ms). Default 80. Drednot's
  //              paint sprayer sometimes ignores a sub-30ms click; longer
  //              holds are reliable and don't paint extra blocks.
  //   retries  — extra down/up cycles at the same spot if the first one
  //              didn't take. Default 0. Each retry adds ~holdMs+40ms.
  //   settleMs — sleep before re-reading the camera matrix. Used by the
  //              paint job to let walking momentum bleed off so the matrix
  //              we project from matches where the cursor will actually be
  //              when the click is processed. Default 0.
  async paintAtWorld(worldX, worldY, opts = {}) {
    const holdMs = Math.max(5, Number(opts.holdMs) || 30);
    const retries = Math.max(0, Number(opts.retries) || 0);
    const settleMs = Math.max(0, Number(opts.settleMs) || 0);
    // If the caller asked for a settle, wait for the player to ACTUALLY
    // stop moving (with a generous timeout cap of 4×settleMs) instead of
    // sleeping a fixed amount. Drednot's deceleration after key-up takes
    // 200-400ms; a flat 80ms sleep often clicks while the bot is still
    // drifting, which produced the "walk-paint-skip-walk-paint-skip"
    // pattern reported by the user — drift moves the cursor onto the
    // wrong cell and the click is silently swallowed.
    if (settleMs) {
      // Wait up to 8× settleMs so long-walk momentum has time to bleed off
      // fully. The 2-consecutive-readings requirement in _waitUntilStopped
      // means this may run up to settleMs*8 ms; that's fine — a late but
      // accurate click beats an early but misaimed one.
      await this._waitUntilStopped(settleMs * 8, 0.04);
    }
    const m = await this.getCameraMatrix();
    if (!m) throw new Error("no camera matrix yet (bot not in a ship?)");
    const p = this.worldToNorm(worldX, worldY, m);
    if (!p) throw new Error("could not project world coord");
    const margin = 0.04;
    if (p.nx < margin || p.nx > 1 - margin || p.ny < margin || p.ny > 1 - margin) {
      throw new Error(
        `target out of view: nx=${p.nx.toFixed(2)} ny=${p.ny.toFixed(2)}`,
      );
    }
    // Force every paint click to be a clean clickCount=1 event. mouseDownAt
    // promotes consecutive clicks within 8 screen pixels + 450ms to
    // clickCount=2 so chromium emits a real `dblclick` (needed for hotbar
    // equip). In a paint job, adjacent cells of the same color are often
    // < 8px apart on screen at high zoom — without this reset, every other
    // cell becomes a dblclick and drednot treats it as something other than
    // a single spray, which manifests as random skipped blocks.
    this._lastClickEnd = null;
    await this.mouseMoveTo(p.nx, p.ny);
    await this._sleep(5);
    // Re-read the camera matrix immediately before clicking. If the camera
    // has shifted since the projection above (player still drifting,
    // camera lerping, browser hitch), the cursor would land on the wrong
    // cell — silently swallowed by drednot and shows up as a "skipped
    // block". Throwing here leaves the cell in `todo` state so the patch
    // pass picks it up rather than wrongly marking it done.
    const m2 = await this.getCameraMatrix();
    if (m2) {
      const p2 = this.worldToNorm(worldX, worldY, m2);
      if (p2) {
        const drift = Math.hypot(p2.nx - p.nx, p2.ny - p.ny);
        if (drift > 0.025) {
          throw new Error(
            `camera drifted between project and click (Δ=${drift.toFixed(3)})`,
          );
        }
        // Use the freshly-projected position for the actual click; even a
        // sub-threshold drift is worth correcting for.
        p.nx = p2.nx;
        p.ny = p2.ny;
      }
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.mouseDownAt(p.nx, p.ny);
      await this._sleep(holdMs);
      await this.mouseUpHere();
      // Reset between retries too so attempt #2 isn't a dblclick of #1.
      this._lastClickEnd = null;
      if (attempt < retries) await this._sleep(40);
    }
    return p;
  }

  // Walk the player toward (targetX, targetY) until they are within
  // `reachRadius` world-units of it. Drednot's tools (paint sprayer etc.)
  // only reach about 3 blocks, so the bot needs to actually be near a cell
  // before it can paint it. Movement is WASD: A/D horizontal, W/S vertical
  // — most drednot rooms are flying / low-grav so the player can move up
  // and down freely, the same way a human would. Returns true if we got
  // into reach within `timeoutMs`, false otherwise. Always releases all
  // movement keys before returning so we don't drift afterwards.
  async walkToReach(targetX, targetY, reachRadius = 3, timeoutMs = 4000, opts = {}) {
    // Movement mode:
    //   "fly"  — hold W/S for vertical (works in zero-grav rooms only).
    //   "jump" — tap Space to go up, gravity pulls you down (normal grav).
    //   "auto" — try W/S first; if the bot doesn't move vertically after
    //            ~600ms, switch to jump+space. Default.
    const mode = (opts.mode || "auto").toLowerCase();
    const start = Date.now();
    const stop = async () => {
      for (const k of ["a", "d", "w", "s", " "]) {
        try { await this.keyUp(k); } catch {}
      }
    };
    let usingJump = mode === "jump";
    let lastJumpAt = 0;
    let probeStartY = null;
    let probeStartTs = 0;
    // Optional job reference — if provided, cancel flag is checked every
    // iteration so a Stop button press during a long walk is responsive
    // within ~110ms instead of up to walkTimeoutMs.
    const jobRef = opts.jobRef || null;
    // Track the last horizontal AND vertical key pressed so we can brake
    // both axes when we enter the reach zone. Previously only horizontal
    // momentum was cancelled — vertical momentum from W/S oscillation
    // (the "goes down then up then skips a block" pattern) was left
    // unbraked, causing the post-stop click to land on the row above/below.
    let lastHKey = null;
    let lastVKey = null;
    try {
      while (Date.now() - start < timeoutMs) {
        // Honour cancel flag mid-walk so Stop is always responsive.
        if (jobRef && jobRef.cancel) {
          await stop();
          return { ok: false, dist: null, pos: null, mode: usingJump ? "jump" : "fly", cancelled: true };
        }
        const pos = await this.getPlayerPosition();
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
          await this._sleep(80);
          continue;
        }
        const dx = targetX - pos.x;
        const dy = targetY - pos.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= reachRadius) {
          // Apply counter-thrust on BOTH axes simultaneously, then release
          // everything and wait for the physics to confirm zero velocity.
          // Old approach applied H and V sequentially (130ms + 120ms + 60ms =
          // 310ms fixed), often overshooting the wait while still drifting.
          // New approach: 60ms burst then velocity-confirmed stop — faster
          // AND more reliable (we know the bot actually stopped).
          if (lastHKey) {
            const opp = lastHKey === "a" ? "d" : "a";
            try { await this.keyUp(lastHKey); } catch {}
            try { await this.keyDown(opp); } catch {}
          }
          if (lastVKey && !usingJump) {
            const opp = lastVKey === "w" ? "s" : "w";
            try { await this.keyUp(lastVKey); } catch {}
            try { await this.keyDown(opp); } catch {}
          }
          await this._sleep(60);
          await stop();
          // Confirmed stop: poll every 12ms until velocity < threshold.
          await this._waitUntilStopped(450, 0.05);
          return { ok: true, dist, pos, mode: usingJump ? "jump" : "fly" };
        }
        // Horizontal: A = -x, D = +x. Tighter deadband (0.3 vs 0.4) so we
        // stop pressing keys sooner and overshoot less on approach.
        if (dx > 0.3) {
          try { await this.keyUp("a"); } catch {}
          try { await this.keyDown("d"); } catch {}
          lastHKey = "d";
        } else if (dx < -0.3) {
          try { await this.keyUp("d"); } catch {}
          try { await this.keyDown("a"); } catch {}
          lastHKey = "a";
        } else {
          try { await this.keyUp("a"); } catch {}
          try { await this.keyUp("d"); } catch {}
        }
        // Vertical movement.
        if (usingJump) {
          // Normal gravity: tap Space repeatedly to gain height; gravity
          // brings us down on its own.
          if (dy > 0.3 && Date.now() - lastJumpAt > 300) {
            try { await this.keyDown(" "); } catch {}
            await this._sleep(35);
            try { await this.keyUp(" "); } catch {}
            lastJumpAt = Date.now();
          }
          try { await this.keyUp("w"); } catch {}
          try { await this.keyUp("s"); } catch {}
        } else {
          // Zero / low grav: W = +y (up), S = -y (down).
          if (dy > 0.3) {
            try { await this.keyUp("s"); } catch {}
            try { await this.keyDown("w"); } catch {}
            lastVKey = "w";
          } else if (dy < -0.3) {
            try { await this.keyUp("w"); } catch {}
            try { await this.keyDown("s"); } catch {}
            lastVKey = "s";
          } else {
            try { await this.keyUp("w"); } catch {}
            try { await this.keyUp("s"); } catch {}
          }
          // Auto-detect normal gravity: if W is held but Y hasn't moved
          // toward the target after ~600ms, switch to jump mode.
          if (mode === "auto" && Math.abs(dy) > 0.3) {
            if (probeStartY === null) {
              probeStartY = pos.y;
              probeStartTs = Date.now();
            } else if (Date.now() - probeStartTs > 600) {
              const moved = Math.abs(pos.y - probeStartY);
              if (moved < 0.5) {
                this.log("info", `walkToReach: switching to jump mode (no vertical movement)`);
                usingJump = true;
                try { await this.keyUp("w"); } catch {}
                try { await this.keyUp("s"); } catch {}
              }
              probeStartY = pos.y;
              probeStartTs = Date.now();
            }
          }
        }
        await this._sleep(40);
      }
      await stop();
      return { ok: false, dist: null, pos: null, mode: usingJump ? "jump" : "fly" };
    } catch (e) {
      await stop();
      throw e;
    }
  }

  // Run a full paint job. `plan` is a 2D array (rows of arrays); each cell is
  // either a 2-char hex color code ("00".."FF") or null/empty to skip. The
  // top-left of the plan is painted at world (anchor.x, anchor.y); each step
  // right is +1 in worldX, each step down is -1 in worldY (drednot Y is up).
  // Cells whose target world position falls outside the visible viewport are
  // skipped (logged as `outOfView`) — the user can pan the bot's view and
  // re-run, or run with a smaller plan in one shot.
  async runPaintJob({ plan, anchor, paintMenu, options }) {
    if (this._paintJob && this._paintJob.state === "running") {
      throw new Error("a paint job is already running");
    }
    if (!Array.isArray(plan) || !plan.length) throw new Error("empty plan");
    const cellDelay = Math.max(0, Number((options && options.cellDelayMs)) || 0);
    // Per-click reliability tuning, all forwarded to paintAtWorld:
    //   paintHoldMs   — how long to hold the mouse for each paint click.
    //                   Default 80ms. Lower = faster but more skips.
    //   paintRetries  — how many extra down/up cycles per cell. Default 0.
    //                   Set to 1 if you still see occasional skipped blocks.
    //   paintSettleMs — pause AFTER walking & BEFORE re-reading the camera
    //                   matrix, so residual walking momentum doesn't make
    //                   the projection stale. Default 80ms when walking,
    //                   0 when not.
    const paintHoldMs = Math.max(1, Number(options && options.paintHoldMs) || 20);
    // Pixel verification: after each paint click, take a 1px screenshot at
    // the clicked screen position and compare it to the palette colour. If
    // they don't match (the server silently dropped the click), the cell is
    // left in "todo" state and retried on the next patch pass. Adds ~220ms
    // per block. Off by default; enable via options.verify:true.
    const paintVerify = !!(options && options.verify);
    const paintRetries = Math.max(
      0,
      options && options.paintRetries != null
        ? Number(options.paintRetries)
        : 1, // 1 retry by default — costs ~30ms, eliminates single-dropped-click failures
    );
    // After the main pass, repeat over any cell that didn't end up painted.
    // Default 3 patch passes covers nearly every transient failure without
    // requiring the user to run again manually.
    const patchPasses = Math.max(
      0,
      options && options.patchPasses != null
        ? Number(options.patchPasses)
        : 3,
    );
    // Walking. Drednot's paint sprayer (and most tools) only reaches about
    // 3 blocks from the player, so by default we walk the bot to each cell
    // before clicking it. Set walk:false to fall back to the old behavior
    // where the bot stands still and skips cells it can't reach.
    const walk = (options && options.walk) !== false;
    // paintSettleMs is now always 0 — settling is handled inside walkToReach
    // via _waitUntilStopped, which velocity-confirms the bot has stopped
    // before returning. A second settle in paintAtWorld is redundant and slow.
    const paintSettleMs = 0;
    // Reliable reach: 1.5 blocks. Well inside drednot's sprayer range (3),
    // accounts for camera-matrix lag (~0.3–0.5 blocks mid-lerp). Override
    // via options.reachRadius if needed.
    const reachRadius = Math.max(
      0.5,
      Number((options && options.reachRadius)) || 1.5,
    );
    const walkTimeoutMs = Math.max(
      500,
      Number((options && options.walkTimeoutMs)) || 3500,
    );
    // Movement mode: "auto" (default — try fly then jump), "fly" (W/S),
    // or "jump" (Space + gravity, for normal-gravity ships).
    const walkMode = (options && options.walkMode) || "auto";
    const rows = plan.length;
    const cols = Math.max(...plan.map((r) => (Array.isArray(r) ? r.length : 0)));
    // sortByColor: group all cells of each color together and paint them in
    // one sweep before moving to the next color. This reduces color-menu
    // opens from O(cells) to O(unique_colors). Row-major order is preserved
    // within each color group so the bot still walks left→right, top→bottom.
    const sortByColor = !!(options && options.sortByColor);
    const job = (this._paintJob = {
      state: "running",
      rows, cols,
      total: rows * cols,
      done: 0,
      skipped: 0,
      failed: 0,
      outOfView: 0,
      outOfReach: 0,
      currentCell: null,
      currentColor: null,
      lastError: null,
      startedAt: Date.now(),
      startedPaintingAt: null, // set after verify pre-scan so ETA ignores scan time
      finishedAt: null,
      cancel: false,
      anchor: { x: anchor.x, y: anchor.y },
      walk,
      reachRadius,
      sortByColor,
    });
    this.log(
      "info",
      `paint job started: ${cols}x${rows} grid, anchor (${anchor.x.toFixed(2)}, ${anchor.y.toFixed(2)}), walk=${walk}, reach=${reachRadius}`,
    );

    // Per-cell status: 0 = todo, 1 = done, 2 = skip-by-design (no color in
    // the plan, e.g. a transparent pixel). The main pass and every patch
    // pass only attempt cells that are still 0 — once a cell is marked
    // done it's never re-clicked, even on a later pass.
    const status = Array.from({ length: rows }, (_, r) => {
      const row = plan[r] || [];
      const a = new Array(cols);
      for (let c = 0; c < cols; c++) a[c] = row[c] ? 0 : 2;
      return a;
    });
    // Most-recent failure reason per cell, used to populate the final
    // job.outOfView / outOfReach / failed counters once all passes finish.
    const reason = Array.from({ length: rows }, () => new Array(cols).fill(""));
    job.skipped = status.flat().filter((s) => s === 2).length;

    // Verify-only pre-scan: when verifyOnly:true, take a single full-canvas
    // PNG snapshot and mark every cell whose pixel already matches the target
    // palette colour as status=1 (done). Only mismatched cells get painted.
    // This lets you run a fast integrity check + targeted repaint on a
    // region that was previously painted, without redoing the whole job.
    const verifyOnly = !!(options && options.verifyOnly);
    if (verifyOnly) {
      job.state = "verifying";
      this.log("info", `verify pass: scanning ${rows}×${cols} grid for colour mismatches…`);
      try {
        const m = await this.getCameraMatrix();
        if (m) {
          const pngBuf = await this.captureCanvasPng().catch(() => null);
          const decoded = pngBuf ? DrednotBot._decodePng(pngBuf) : null;
          if (decoded) {
            let okCount = 0, badCount = 0;
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                if (status[r][c] !== 0) continue;
                const code = (plan[r] || [])[c];
                if (!code) continue;
                const expected = PALETTE_RGB[code.toUpperCase ? code.toUpperCase() : code];
                if (!expected) continue;
                const wx = anchor.x + c, wy = anchor.y - r;
                const p = this.worldToNorm(wx, wy, m);
                if (!p || p.nx < 0.02 || p.nx > 0.98 || p.ny < 0.02 || p.ny > 0.98) continue;
                const px = Math.round(p.nx * decoded.width);
                const py = Math.round(p.ny * decoded.height);
                const actual = DrednotBot._sampleDecodedPng(decoded, px, py);
                if (!actual) continue;
                const dist = Math.sqrt(
                  (actual[0] - expected[0]) ** 2 +
                  (actual[1] - expected[1]) ** 2 +
                  (actual[2] - expected[2]) ** 2,
                );
                if (dist <= 80) { status[r][c] = 1; okCount++; }
                else badCount++;
              }
            }
            job.verifyStats = { ok: okCount, bad: badCount };
            this.log("info", `verify scan done: ${okCount} OK, ${badCount} need repainting`);
          } else {
            this.log("warn", "verify scan: could not decode canvas PNG, will repaint everything");
          }
        } else {
          this.log("warn", "verify scan: no camera matrix, will repaint everything");
        }
      } catch (e) {
        this.log("warn", "verify scan failed: " + (e && e.message));
      }
      job.state = "running";
    }

    // Mark when actual painting starts (after verify pre-scan) so the
    // dashboard can compute an accurate ETA that ignores scan time.
    job.startedPaintingAt = Date.now();
    let lastColor = null;
    try {
      // ---- Color-sorted pass helper ----
      // When sortByColor is on, the first main pass groups all cells of the
      // same color and paints them in one sweep (row-major within the group).
      // This reduces color-menu opens from O(cells) to O(unique_colors) —
      // a huge speed gain for complex images. Patch passes reuse the normal
      // row-major loop (fewer cells remain, any order is fine).
      const runColorSortedPass = async (passNum) => {
        // Build color→cells map, preserving row-major order within each group.
        const colorGroups = new Map();
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (status[r][c] !== 0) continue;
            const code = (plan[r] || [])[c];
            if (!code) continue;
            if (!colorGroups.has(code)) colorGroups.set(code, []);
            colorGroups.get(code).push({ r, c });
          }
        }
        if (colorGroups.size === 0) return false;
        // Sort groups largest-first so we spend the most time on the most
        // common colors (fewer remaining straggler cells for patch passes).
        const groups = Array.from(colorGroups.entries())
          .sort((a, b) => b[1].length - a[1].length);
        this.log(
          "info",
          `paint job color-sorted pass ${passNum}: ${groups.length} unique color(s), ${groups.reduce((s, g) => s + g[1].length, 0)} cell(s)`,
        );
        let madeProgress = false;
        for (const [code, cells] of groups) {
          if (job.cancel) break;
          // Select the color once for the whole group.
          job.currentColor = code;
          await this.openPaintMenuAndSelectColor(code, paintMenu);
          lastColor = code;
          for (const { r, c } of cells) {
            if (status[r][c] !== 0) continue; // painted by a previous group (shouldn't happen but guard)
            if (job.cancel) break;
            job.currentCell = { c, r, pass: passNum };
            const wx = anchor.x + c;
            const wy = anchor.y - r;
            try {
              if (walk) {
                const pos = await this.getPlayerPosition();
                if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
                  const already = Math.hypot(wx - pos.x, wy - pos.y) <= reachRadius;
                  if (!already) {
                    const w = await this.walkToReach(wx, wy, reachRadius, walkTimeoutMs, { mode: walkMode, jobRef: job });
                    if (!w.ok) {
                      if (w.cancelled) return madeProgress;
                      reason[r][c] = "outOfReach";
                      if (cellDelay > 0) await this._sleep(cellDelay);
                      continue;
                    }
                    // No extra sleep — walkToReach already confirmed stop via _waitUntilStopped.
                  }
                }
              }
              const painted = await this.paintAtWorld(wx, wy, { holdMs: paintHoldMs, retries: paintRetries, settleMs: paintSettleMs });
              let verifyOk = true;
              if (paintVerify && painted) {
                await this._sleep(220);
                const vr = await this.verifyBlockColor(painted.nx, painted.ny, code).catch(() => null);
                if (vr && !vr.match) {
                  verifyOk = false;
                  reason[r][c] = "verifyFail";
                  this.log("warn", `verify fail (${c},${r}) code=${code}: expected [${vr.expected}] got [${vr.actual}] dist=${vr.dist.toFixed(0)}`);
                }
              }
              if (verifyOk) {
                status[r][c] = 1;
                reason[r][c] = "";
                madeProgress = true;
              }
            } catch (e) {
              const msg = (e && e.message) || String(e);
              if (msg.startsWith("target out of view")) reason[r][c] = "outOfView";
              else { reason[r][c] = "failed"; job.lastError = msg; }
            }
            if (cellDelay > 0) await this._sleep(cellDelay);
          }
          // Recount after each color group so dashboard sees live progress.
          let done = 0, oov = 0, oor = 0, fld = 0;
          for (let ri = 0; ri < rows; ri++) for (let ci = 0; ci < cols; ci++) {
            const s = status[ri][ci];
            if (s === 1) done++;
            else if (s === 0) {
              const why = reason[ri][ci];
              if (why === "outOfView") oov++;
              else if (why === "outOfReach") oor++;
              else fld++;
            }
          }
          job.done = done; job.outOfView = oov; job.outOfReach = oor; job.failed = fld;
        }
        return madeProgress;
      };

      const totalPasses = 1 + patchPasses;
      for (let pass = 0; pass < totalPasses; pass++) {
        let toDo = 0;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
          if (status[r][c] === 0) toDo++;
        if (toDo === 0) break;
        if (pass > 0) {
          this.log(
            "info",
            `paint job patch pass ${pass}/${patchPasses}: ${toDo} cell(s) still need painting`,
          );
        }
        // Color-sorted first pass: paints all cells of each color in one
        // sweep, minimising color-menu opens from O(cells) → O(unique_colors).
        if (pass === 0 && sortByColor) {
          const progress = await runColorSortedPass(0);
          if (job.cancel) {
            job.state = "cancelled";
            job.finishedAt = Date.now();
            try { await this.keyUp("a"); } catch {}
            try { await this.keyUp("d"); } catch {}
            this.log("info", "paint job cancelled");
            return job;
          }
          // After the color-sorted pass, any remaining cells fall through
          // to the normal patch passes below. If nothing was painted and
          // there are no patch passes, bail early.
          if (!progress && patchPasses === 0) {
            this.log("warn", "color-sorted pass made no progress, stopping early");
            break;
          }
          continue;
        }
        let madeProgressThisPass = false;
        // On odd-numbered patch passes, iterate REVERSE — bottom-to-top,
        // right-to-left — so any cell that was persistently skipped by a
        // forward pass (e.g. because the bot consistently overshoots
        // going right) gets approached from the opposite direction. This
        // breaks deterministic skip patterns: a cell missed because the
        // bot was drifting east is unlikely to be missed on the same
        // approach drifting west.
        const reverse = pass % 2 === 1;
        const rOrder = reverse
          ? Array.from({ length: rows }, (_, i) => rows - 1 - i)
          : Array.from({ length: rows }, (_, i) => i);
        for (const r of rOrder) {
          const row = plan[r] || [];
          const cOrder = reverse
            ? Array.from({ length: cols }, (_, i) => cols - 1 - i)
            : Array.from({ length: cols }, (_, i) => i);
          for (const c of cOrder) {
            if (status[r][c] !== 0) continue;
            if (job.cancel) {
              job.state = "cancelled";
              job.finishedAt = Date.now();
              try { await this.keyUp("a"); } catch {}
              try { await this.keyUp("d"); } catch {}
              this.log("info", "paint job cancelled");
              return job;
            }
            job.currentCell = { c, r, pass };
            const code = row[c];
            const wx = anchor.x + c;
            const wy = anchor.y - r;
            try {
              if (code !== lastColor) {
                job.currentColor = code;
                await this.openPaintMenuAndSelectColor(code, paintMenu);
                lastColor = code;
              }
              // Walk into reach before clicking. On failure, leave the
              // cell as 0 (todo) and let the next patch pass try again —
              // the bot may be in a different position later that makes
              // this cell reachable.
              if (walk) {
                const pos = await this.getPlayerPosition();
                if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
                  const already =
                    Math.hypot(wx - pos.x, wy - pos.y) <= reachRadius;
                  if (!already) {
                    const w = await this.walkToReach(wx, wy, reachRadius, walkTimeoutMs, { mode: walkMode, jobRef: job });
                    if (!w.ok) {
                      if (w.cancelled) {
                        job.state = "cancelled";
                        job.finishedAt = Date.now();
                        try { await this.keyUp("a"); } catch {}
                        try { await this.keyUp("d"); } catch {}
                        this.log("info", "paint job cancelled during walk");
                        return job;
                      }
                      reason[r][c] = "outOfReach";
                      if (cellDelay > 0) await this._sleep(cellDelay);
                      continue;
                    }
                    // No extra sleep — walkToReach confirmed stop via _waitUntilStopped.
                  }
                } else if (!job._warnedNoPos) {
                  job._warnedNoPos = true;
                  this.log(
                    "warn",
                    "no player position yet; painting without walking. Make sure the bot is in a ship and has moved at least once.",
                  );
                }
              }
              const painted = await this.paintAtWorld(wx, wy, {
                holdMs: paintHoldMs,
                retries: paintRetries,
                settleMs: paintSettleMs,
              });
              // Pixel verification: if enabled, wait for the game to render
              // the newly painted block, then take a 1px screenshot at the
              // clicked position and compare it to the expected palette color.
              // A mismatch means the click was silently rejected by the server
              // (out of range, wrong tool, etc.) — leave the cell in todo so
              // the next patch pass retries from a better position.
              let verifyOk = true;
              if (paintVerify && painted) {
                await this._sleep(220);
                const vr = await this.verifyBlockColor(painted.nx, painted.ny, code).catch(() => null);
                if (vr && !vr.match) {
                  verifyOk = false;
                  reason[r][c] = "verifyFail";
                  this.log(
                    "warn",
                    `verify fail (${c},${r}) code=${code}: expected [${vr.expected}] got [${vr.actual}] dist=${vr.dist.toFixed(0)}`,
                  );
                }
              }
              if (verifyOk) {
                status[r][c] = 1;
                reason[r][c] = "";
                madeProgressThisPass = true;
              }
            } catch (e) {
              const msg = (e && e.message) || String(e);
              if (msg.startsWith("target out of view")) {
                reason[r][c] = "outOfView";
              } else {
                reason[r][c] = "failed";
                job.lastError = msg;
                if (pass === totalPasses - 1) {
                  this.log("warn", `paint cell (${c},${r}) failed (final pass): ${msg}`);
                }
              }
            }
            if (cellDelay > 0) await this._sleep(cellDelay);
          }
        }
        // Recompute counters after each pass so the dashboard sees live
        // progress for "done" growing across passes.
        let done = 0, oov = 0, oor = 0, fld = 0;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const s = status[r][c];
          if (s === 1) done++;
          else if (s === 0) {
            const why = reason[r][c];
            if (why === "outOfView") oov++;
            else if (why === "outOfReach") oor++;
            else fld++;
          }
        }
        job.done = done;
        job.outOfView = oov;
        job.outOfReach = oor;
        job.failed = fld;
        // Bail early if a patch pass painted nothing — further passes
        // would just spin without making progress.
        if (pass > 0 && !madeProgressThisPass) {
          this.log(
            "warn",
            `patch pass ${pass} made no progress, stopping early (${toDo} cell(s) unpaintable)`,
          );
          break;
        }
      }
      // Release movement keys at the end so the bot isn't drifting after
      // a finished job.
      try { await this.keyUp("a"); } catch {}
      try { await this.keyUp("d"); } catch {}
      job.state = "completed";
      job.finishedAt = Date.now();
      this.log(
        "info",
        `paint job done: ${job.done} painted, ${job.skipped} skipped, ${job.outOfView} out-of-view, ${job.outOfReach} out-of-reach, ${job.failed} failed`,
      );
      return job;
    } catch (e) {
      try { await this.keyUp("a"); } catch {}
      try { await this.keyUp("d"); } catch {}
      job.state = "errored";
      job.lastError = (e && e.message) || String(e);
      job.finishedAt = Date.now();
      this.log("error", "paint job errored: " + job.lastError);
      throw e;
    }
  }

  cancelPaintJob() {
    if (this._paintJob && this._paintJob.state === "running") {
      this._paintJob.cancel = true;
      return true;
    }
    return false;
  }

  paintJobStatus() {
    return this._paintJob || null;
  }

  async captureShipInfo() {
    if (!this.page) throw new Error("not connected");
    const data = await this.page.evaluate(() => {
      const out = { shipName: null, shipId: null, crew: [], serverPort: null };
      // Try to detect ship name/id from chat history (last "Joined ship" line)
      const chat = document.querySelector("#chat-content");
      if (chat) {
        const lines = chat.innerText.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/Joined ship\s+'([^']+)'\s*\{([^}]+)\}/);
          if (m) {
            out.shipName = m[1];
            out.shipId = m[2];
            break;
          }
        }
      }
      // Crew list lives inside #team_players_inner -> table
      const inner = document.querySelector("#team_players_inner");
      if (inner) {
        const rows = inner.querySelectorAll("tr, .row, li");
        rows.forEach((r) => {
          const text = (r.innerText || "").replace(/\s+/g, " ").trim();
          if (!text) return;
          // Skip header rows
          if (/Identity/i.test(text) && /Inventory/i.test(text)) return;
          out.crew.push({ raw: text.slice(0, 200) });
        });
        if (!out.crew.length) {
          // Fallback - flatten
          const flat = (inner.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
          flat.forEach((line) => {
            if (/Identity/i.test(line) && /Inventory/i.test(line)) return;
            out.crew.push({ raw: line.slice(0, 200) });
          });
        }
      }
      // Online player count from header (if any)
      const onText = document.querySelector("#team_players")?.innerText || "";
      const om = onText.match(/(\d+)\s*\/\s*(\d+)\s*Crew/i);
      if (om) {
        out.crewOnline = parseInt(om[1], 10);
        out.crewMax = parseInt(om[2], 10);
      }
      return out;
    });
    if (!data.shipName && this.currentShip.name) data.shipName = this.currentShip.name;
    if (!data.shipId && this.currentShip.id) data.shipId = this.currentShip.id;
    return data;
  }

  // Find a "Sandbox" option anywhere in the live game UI and activate it.
  // Drednot's server picker is a <select> whose <option> labels include
  // entries like "13 - Sandbox (US East) - 78/250". We also fall back to
  // any visible button/li/anchor whose text contains "sandbox" in case a
  // future UI revision moves it out of the dropdown.
  async enableSandbox() {
    if (!this.page) throw new Error("not connected");
    await this._focusGame();

    // If the in-game side menu is hidden ("Show Menu" button visible),
    // open it so the server <select> is in the DOM/visible. We click any
    // button whose text starts with "Show Menu".
    try {
      await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        for (const b of btns) {
          const t = (b.textContent || "").trim();
          if (/^show menu/i.test(t) && b.offsetParent !== null) {
            b.click();
            return;
          }
        }
      });
    } catch {}

    // Brief pause for any menu-open animation to settle.
    await new Promise((r) => setTimeout(r, 200));

    const result = await this.page.evaluate(() => {
      const isVisible = (el) => {
        if (!el || !(el instanceof HTMLElement)) return false;
        if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      // 1) Try every <select> on the page — the server picker is one.
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const opts = Array.from(sel.options || []);
        const match = opts.find((o) => /sandbox/i.test(o.textContent || o.label || ""));
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { kind: "select", label: (match.textContent || "").trim() };
        }
      }

      // 2) Fallback — any clickable element whose visible text mentions sandbox.
      const clickables = Array.from(
        document.querySelectorAll("button, a, li, [role='button'], [role='option']"),
      );
      for (const el of clickables) {
        const t = (el.textContent || "").trim();
        if (!/sandbox/i.test(t)) continue;
        if (!isVisible(el)) continue;
        el.click();
        return { kind: "click", label: t.slice(0, 80) };
      }

      return null;
    });

    if (!result) {
      this.log("warn", "sandbox option not found in current UI");
      throw new Error("sandbox option not found — open the side menu first");
    }
    this.log("info", `sandbox enabled via ${result.kind}: ${result.label}`);
    return result;
  }

  // Search the live game UI for any visible element whose text / title /
  // aria-label / alt / data-name contains the query, then double-click the
  // best match to equip it. Drednot's in-game HUD renders inventory slots
  // and item tooltips as real DOM nodes, so this is reliable for items
  // that are currently visible in your inventory.
  //
  // Returns { label, x, y } on success. Throws if nothing matches.
  async searchAndEquip(query) {
    if (!this.page) throw new Error("not connected");
    const q = String(query || "").trim();
    if (!q) throw new Error("query required");
    await this._focusGame();

    const found = await this.page.evaluate((needleRaw) => {
      const needle = String(needleRaw).toLowerCase();
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
        return true;
      };
      const score = (el) => {
        const fields = [
          el.getAttribute("title"),
          el.getAttribute("aria-label"),
          el.getAttribute("alt"),
          el.getAttribute("data-name"),
          el.getAttribute("data-item"),
          // Use innerText if it's short — long blocks of text are usually
          // chat or tooltips for *other* items; we want compact labels.
          (el.innerText || "").length < 80 ? el.innerText : "",
        ].filter(Boolean).map((s) => s.toLowerCase().trim());
        let best = 0;
        for (const t of fields) {
          if (!t) continue;
          if (t === needle) best = Math.max(best, 1000);
          else if (t.startsWith(needle)) best = Math.max(best, 500 - Math.min(400, t.length - needle.length));
          else if (t.includes(needle)) best = Math.max(best, 200 - Math.min(180, t.length - needle.length));
        }
        return best;
      };

      // Prefer elements that are typical inventory tiles / buttons first.
      const pools = [
        Array.from(document.querySelectorAll("[title], [aria-label], [data-name], [data-item], img")),
        Array.from(document.querySelectorAll("button, a, li, [role='button'], [role='option']")),
      ];

      const seen = new Set();
      const matches = [];
      for (const pool of pools) {
        for (const el of pool) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!isVisible(el)) continue;
          const s = score(el);
          if (s > 0) matches.push({ s, el });
        }
      }
      if (!matches.length) return null;
      matches.sort((a, b) => b.s - a.s);
      const top = matches[0];
      const r = top.el.getBoundingClientRect();
      return {
        label: (
          top.el.getAttribute("title") ||
          top.el.getAttribute("aria-label") ||
          top.el.getAttribute("alt") ||
          top.el.innerText ||
          ""
        ).trim().slice(0, 80),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        score: top.s,
        total: matches.length,
      };
    }, q);

    if (!found) {
      this.log("warn", `searchAndEquip: no match for "${q}"`);
      throw new Error(`no visible item matched "${q}"`);
    }

    // Double-click via real puppeteer mouse so the game's canvas / DOM
    // handlers receive bona-fide pointer events (synthetic dispatch from
    // page.evaluate doesn't always work on canvas-mounted handlers).
    await this._enqueueMouse(async () => {
      if (!this.page) return;
      await this.page.mouse.move(found.x, found.y);
      await this.page.mouse.click(found.x, found.y, { clickCount: 2, delay: 30 });
    });

    this.log("info", `searchAndEquip: equipped "${found.label}" at (${Math.round(found.x)}, ${Math.round(found.y)})`);
    return found;
  }

  async joinShip(inviteUrlOrCode) {
    if (!this.page) throw new Error("not connected");
    const raw = String(inviteUrlOrCode || "").trim();
    if (!raw) throw new Error("invite url or code required");

    // Accept either a full URL or a bare invite code
    let url;
    try {
      const u = new URL(raw);
      if (!/drednot\.io$/i.test(u.hostname))
        throw new Error("not a drednot.io url");
      url = u.toString();
    } catch (_) {
      const code = raw.replace(/[^A-Za-z0-9_-]/g, "");
      if (!code) throw new Error("invalid invite code");
      url = `https://${this.targetHost}/invite/${code}`;
    }

    this.log("info", `joining ship: ${url}`);
    this.setStatus("joining");
    this._cachedBox = null;
    this._lastJoinedShip = url;
    await this._gotoWithRetry(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }, 3, "ship join");
    // Wait for chat input to reappear after the join
    await this.page.waitForSelector("#chat-input", { timeout: 30000 });
    // Install before dismissing the remaining UI dialogs. Players can join
    // while those dialogs are being closed, and missing the first event makes
    // the welcome appear only after a later rejoin.
    await this.installChatObserver();
    await this.dismissDialogs();
    this.setStatus("online");
    this.log("info", "joined ship");
  }

  async stop() {
    this.shouldStop = true;
    this._closing = true;
    this._stopAutomation();
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.signInWatcher) clearInterval(this.signInWatcher);
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {}
      this.browser = null;
      this.page = null;
    }
    this.setStatus("stopped");
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Standalone helper: spin up a throwaway browser, click "Play Anonymously" on
// a fresh drednot.io session, and return the brand-new anon_key the game
// generated for that session. Used by the dashboard's "Create new key" button.
// ---------------------------------------------------------------------------
async function createNewAnonKey({ target = "https://drednot.io/", timeoutMs = 60000, log } = {}) {
  const note = (level, msg) => {
    try { log && log(level, msg); } catch (_) {}
    const ts = new Date().toISOString();
    console.log(`[${ts}] [new-key/${level}] ${msg}`);
  };

  const executablePath = await findChromium();
  note("info", `launching chromium at ${executablePath} for ${target}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    timeout: 60000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--use-angle=swiftshader-webgl",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--disable-gpu-sandbox",
      "--window-size=1280,800",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1000, deadline - Date.now());

  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => note("warn", `page error: ${err.message}`));

    note("info", "navigating with empty cookie jar (no anon_key)");
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: remaining() });

    // Drednot has two flows for a brand-new visitor:
    //  (a) it auto-generates an anon_key and writes it to localStorage on load,
    //      then drops you straight into the game;
    //  (b) it shows a sign-in modal and you have to click "Play Anonymously"
    //      for it to mint a new account key.
    // We poll for both at the same time. Whichever shows up first wins.
    const readKey = async () =>
      page.evaluate(() => {
        let v = null;
        try {
          v = localStorage.getItem("anon_key") || localStorage.getItem("anonymous_key");
        } catch (_) {}
        if (!v) {
          // Drednot writes the freshly minted account key to the cookie first;
          // only later (after entering a ship) does it sync into localStorage.
          const m = (document.cookie || "").match(/(?:^|;\s*)anon_key=([^;]+)/);
          if (m) v = decodeURIComponent(m[1]);
        }
        return v || null;
      });

    const probePage = async () =>
      page.evaluate(() => {
        let lsKeys = [];
        let lsSnapshot = {};
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            lsKeys.push(k);
            const v = localStorage.getItem(k);
            lsSnapshot[k] = v && v.length > 40 ? v.slice(0, 12) + "…(" + v.length + ")" : v;
          }
        } catch (_) {}
        const cookies = document.cookie || "";
        const buttons = Array.from(
          document.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]"),
        )
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && el.offsetParent !== null;
          })
          .map((el) => (el.innerText || el.value || "").trim())
          .filter(Boolean)
          .slice(0, 25);
        return { lsKeys, lsSnapshot, cookies, buttons };
      });

    // The first time you visit drednot fresh you land on a "Rules" page with
    // an "Accept" button BEFORE the sign-in modal appears. After that you get
    // the sign-in modal where "Play Anonymously" mints the new account key.
    // We click whichever of these is visible — Accept first, then Play.
    const tryClickPlay = async () =>
      page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a, [role=button]"))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && el.offsetParent !== null;
          });
        const find = (re) => btns.find((b) => re.test((b.textContent || "").trim()));
        // Priority: Play Anonymously > plain Play > Accept (rules) > Continue > OK
        const hit =
          find(/play anonymously/i) ||
          find(/^play$/i) ||
          find(/^accept$/i) ||
          find(/^i agree$/i) ||
          find(/^continue$/i);
        if (hit) {
          hit.click();
          return (hit.textContent || "").trim();
        }
        return null;
      });

    let key = null;
    const clickHistory = [];
    let lastTick = 0;
    while (Date.now() < deadline) {
      key = await readKey();
      if (key) break;
      // Re-try every loop because each click can reveal the next button
      // (Accept rules → Play Anonymously → key gets stored).
      const newClick = await tryClickPlay();
      if (newClick && clickHistory[clickHistory.length - 1] !== newClick) {
        clickHistory.push(newClick);
        note("info", `clicked sign-in button: "${newClick}"`);
      }
      const clicked = clickHistory[clickHistory.length - 1] || null;
      // Light periodic heartbeat so we can see we're still polling.
      if (Date.now() - lastTick > 5000) {
        lastTick = Date.now();
        try {
          const probe = await probePage();
          note("info", `waiting (clicked=${clicked || "no"}) ls=${JSON.stringify(probe.lsKeys)} cookies="${probe.cookies}" buttons=${JSON.stringify(probe.buttons)}`);
        } catch (e) {
          note("info", `waiting (clicked=${clicked || "no"}) probe failed: ${e.message}`);
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    if (!key) {
      throw new Error(
        clickHistory.length
          ? `clicked ${JSON.stringify(clickHistory)} but no anon_key appeared in localStorage`
          : "neither auto-generated anon_key nor Play Anonymously button appeared",
      );
    }
    note("info", `captured new anon_key …${key.slice(-6)} (clicks=${JSON.stringify(clickHistory)})`);
    return { key, target };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { DrednotBot, formatDuration };
