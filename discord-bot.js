const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const CONFIG_FILE = path.join(__dirname, "..", "config.json");
const DREDNOT_SERVER = `http://127.0.0.1:${process.env.PORT || 5000}`;
const MISSION_SERVERS_URL = "https://dsa-api.certainhuman.com/v1/game/servers";
const MISSION_API_URL = "https://dsa-api.certainhuman.com/v1/missions/current";
const RELATION_CATEGORIES = ["ally", "neutral", "enemy", "whitelist", "kos"];
const NO_MENTIONS = { parse: [] };
const DSA_WORKER = path.join(__dirname, "..", "dsatools", "worker.js");
const dsaSessions = new Map();
const dsaResults = new Map();

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function guildConfig(guildId) {
  const config = loadConfig();
  const key = String(guildId);
  if (!config[key]) {
    config[key] = {
      channel_id: null,
      message_id: null,
      roles: [],
      original_nicks: {},
      relation_channel_id: null,
      relation_message_id: null,
      relations: Object.fromEntries(RELATION_CATEGORIES.map((c) => [c, []])),
    };
    saveConfig(config);
  }
  const gc = config[key];
  gc.relations ||= Object.fromEntries(RELATION_CATEGORIES.map((c) => [c, []]));
  gc.roles ||= [];
  gc.ticket_roles ||= [];
  gc.drednot_last_ts ||= 0;
  return gc;
}

function updateGuildConfig(guildId, gc) {
  const config = loadConfig();
  config[String(guildId)] = gc;
  saveConfig(config);
}

function ensureTicketConfig(gc) {
  gc.ticket_channel_id ||= null;
  gc.ticket_panel_message_id ||= gc.ticet_panel_message_id || null;
  gc.ticket_roles ||= [];
  gc.ticket_category_id ||= null;
  gc.ticket_form_log_channel_id ||= null;
  return gc;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${DREDNOT_SERVER}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchMissions() {
  try {
    const serversResponse = await fetch(MISSION_SERVERS_URL, {
      headers: { "cache-control": "no-cache", "user-agent": "Shadow66DiscordBot/1.0" },
    });
    const body = await serversResponse.json();
    const servers = (body.servers || []).filter((s) => s.active === 1 || s.active === true);
    return await Promise.all(servers.map(async (server) => {
      try {
        const response = await fetch(`${MISSION_API_URL}?server=${server.server_id}`, {
          headers: { "cache-control": "no-cache" },
        });
        return {
          server_id: Number(server.server_id),
          name: server.name || String(server.server_id),
          data: await response.json(),
          error: null,
        };
      } catch (error) {
        return {
          server_id: Number(server.server_id),
          name: server.name || String(server.server_id),
          data: null,
          error: String(error),
        };
      }
    }));
  } catch (error) {
    return [{ server_id: 0, name: "Mission service", data: null, error: String(error) }];
  }
}

function missionTarget(snapshot) {
  const data = snapshot.data || {};
  const event = data.event || {};
  if (data.type === "open") {
    return ["Open for", event.name || "Mission",
      event.close_time || (event.open_time ? event.open_time + 15 * 60 : null)];
  }
  if (data.type === "announced") return ["Opening in", event.name || "Mission", event.open_time || null];
  if (data.type === "closed") return ["Opening in", event.name || "—", data.predicted_open_time || null];
  if (snapshot.error) return ["Unavailable", "—", null];
  return ["Checking", "—", null];
}

function missionPanel(snapshots) {
  const lines = ["**Mission Tracker**", ""];
  for (const snapshot of snapshots) {
    const [status, mission, target] = missionTarget(snapshot);
    lines.push(`${snapshot.name}: ${status}: ${target ? `<t:${Math.floor(target)}:R>` : "—"} — ${mission}`);
  }
  if (!snapshots.length) lines.push("No mission data available.");
  return lines.join("\n");
}

function roleForCategory(guild, category) {
  const names = {
    ally: ["ally", "allied"],
    neutral: ["neutral"],
    enemy: ["enemy", "enemies"],
    whitelist: ["whitelisted", "whitelist"],
    kos: ["kos", "kill on sight"],
  }[category] || [category];
  return guild.roles.cache.find((role) => names.includes(role.name.toLowerCase()));
}

function relationsList(guild, relations) {
  const lines = ["**🌐 Shadow 66 Relations『☬』**", ""];
  const labels = { ally: "Ally", neutral: "Neutral", enemy: "Enemy", whitelist: "Whitelisted", kos: "KOS" };
  for (const category of RELATION_CATEGORIES) {
    const entries = relations[category] || [];
    const role = roleForCategory(guild, category);
    lines.push(`${role ? `<@&${role.id}>` : `**@${labels[category]}**`} (${entries.length})`);
    lines.push("▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔");
    if (!entries.length) lines.push("• —");
    for (const [index, entry] of entries.entries()) {
      const emoji = (entry.tags || "").match(/^[\p{Extended_Pictographic}\u2600-\u27BF️‍]+/u)?.[0] || "";
      lines.push(`${index + 1}. ${entry.name}${emoji ? ` ${emoji}` : ""}`);
    }
    lines.push("");
  }
  lines.push("⎽".repeat(25), `Updated <t:${Math.floor(Date.now() / 1000)}:R>`);
  return lines.join("\n");
}

async function editOrSend(channel, messageId, content) {
  if (messageId) {
    try {
      const message = await channel.messages.fetch(messageId);
      await message.edit({ content, allowedMentions: NO_MENTIONS });
      return message;
    } catch {}
  }
  return channel.send({ content, allowedMentions: NO_MENTIONS });
}

async function syncRelations(client, guild, gc) {
  if (!gc.relation_channel_id) return;
  const channel = guild.channels.cache.get(gc.relation_channel_id);
  if (!channel?.isTextBased()) return;
  const message = await editOrSend(channel, gc.relation_message_id, relationsList(guild, gc.relations));
  gc.relation_message_id = message.id;
  updateGuildConfig(guild.id, gc);
}

function memberList(guild, roleIds) {
  const lines = ["**🌖Shadow 66 Memberlist『☬』**", ""];
  const seen = new Set();
  let total = 0;
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    const members = [...role.members.values()]
      .filter((member) => !member.user.bot && !seen.has(member.id))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (!members.length) continue;
    total += members.length;
    members.forEach((member) => seen.add(member.id));
    lines.push(`<@&${role.id}>`, "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔");
    lines.push(...members.map((member) => `• *<@${member.id}>*`), "");
  }
  lines.push("⎽".repeat(25), `**${total} members** ━ <t:${Math.floor(Date.now() / 1000)}:R>`);
  return lines.join("\n");
}

function leadingEmoji(text) {
  return text.trim().match(/^(?:[\p{Extended_Pictographic}\u2600-\u27BF][\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]?)+/u)?.[0] || "";
}

function trailingTag(text) {
  const value = text.trim();
  return value.match(/([『【「〔\[\(\{][^』】」〕\]\)\}]*[』】」〕\]\)\}])$/)?.[1]
    || value.match(/(?:^|\s)([^\p{Letter}\p{Number}\s]+)$/u)?.[1]
    || "";
}

function cleanMemberBase(member) {
  let current = member.nickname || member.user.username;
  for (const role of member.roles.cache.values()) {
    const emoji = leadingEmoji(role.name);
    if (emoji && current.startsWith(emoji)) {
      current = current.slice(emoji.length).trim();
      break;
    }
  }
  const tag = trailingTag(current);
  return tag ? current.slice(0, current.lastIndexOf(tag)).trim() : current.trim();
}

async function syncNicknames(guild, gc) {
  if (!gc.roles?.length) return;
  await guild.members.fetch().catch(() => {});
  for (const member of guild.members.cache.values()) {
    if (member.user.bot || member.id === guild.ownerId) continue;
    let selectedRole = null;
    for (const roleId of gc.roles) {
      const role = guild.roles.cache.get(roleId);
      if (role && member.roles.cache.has(roleId) && leadingEmoji(role.name)) {
        selectedRole = role;
        break;
      }
    }
    if (!selectedRole) continue;
    const emoji = leadingEmoji(selectedRole.name);
    const tag = trailingTag(selectedRole.name);
    const desired = `${emoji} ${cleanMemberBase(member)}${tag ? ` ${tag}` : ""}`.trim();
    if (member.nickname === desired) continue;
    await member.setNickname(desired, "Shadow 66 role nickname sync").catch((error) => {
      if (error.code !== 50013) console.warn(`[nick-sync] ${member.user.tag}: ${error.message}`);
    });
  }
}

async function syncGuild(client, guild, gc) {
  ensureTicketConfig(gc);
  if (gc.roles.length) await guild.members.fetch().catch(() => {});
  await syncNicknames(guild, gc);
  if (gc.channel_id) {
    const channel = guild.channels.cache.get(gc.channel_id);
    if (channel?.isTextBased()) {
      const message = await editOrSend(channel, gc.message_id, memberList(guild, gc.roles));
      gc.message_id = message.id;
    }
  }
  await syncRelations(client, guild, gc);
  updateGuildConfig(guild.id, gc);
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function adminReply(interaction) {
  return interaction.reply({
    content: "🚫 You need the **Administrator** permission to use this command.",
    ephemeral: true,
  });
}

function optionString(name, description, required = true) {
  return (builder) => builder.setName(name).setDescription(description).setRequired(required);
}

function commandDefinitions() {
  const config = new SlashCommandBuilder().setName("config").setDescription("Configure the bot")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName("memberlist_channel").setDescription("Set the member list channel")
      .addChannelOption(optionString("channel", "Channel to post the member list in", true)))
    .addSubcommand((s) => s.setName("relation_channel").setDescription("Set the relations list channel")
      .addChannelOption(optionString("channel", "Channel to post the relations list in", true)))
    .addSubcommand((s) => s.setName("drednot_message_channel").setDescription("Set the game chat channel")
      .addChannelOption(optionString("channel", "Channel to post game messages in", true)))
    .addSubcommand((s) => s.setName("add_roles").setDescription("Add a member-list role")
      .addRoleOption(optionString("role", "Role to track", true)))
    .addSubcommand((s) => s.setName("remove_roles").setDescription("Remove a member-list role")
      .addRoleOption(optionString("role", "Role to remove", true)))
    .addSubcommand((s) => s.setName("role_order").setDescription("Set a role display position")
      .addRoleOption(optionString("role", "Role to reorder", true))
      .addIntegerOption((o) => o.setName("position").setDescription("Position, 1 is top").setMinValue(1).setRequired(true)))
    .addSubcommand((s) => s.setName("ticket_channel").setDescription("Set the ticket panel channel")
      .addChannelOption((o) => optionString("channel", "Channel to post the ticket panel in")(o).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName("add_ticket_roles").setDescription("Add a ticket staff role")
      .addRoleOption(optionString("role", "Role to add", true)))
    .addSubcommand((s) => s.setName("remove_ticket_roles").setDescription("Remove a ticket staff role")
      .addRoleOption(optionString("role", "Role to remove", true)))
    .addSubcommand((s) => s.setName("ticket_category").setDescription("Set the ticket category")
      .addChannelOption((o) => optionString("category", "Category for tickets")(o).addChannelTypes(ChannelType.GuildCategory)))
    .addSubcommand((s) => s.setName("form_log_channel").setDescription("Set the ticket form log channel")
      .addChannelOption((o) => optionString("channel", "Channel for ticket logs")(o).addChannelTypes(ChannelType.GuildText)));
  const send = new SlashCommandBuilder().setName("send").setDescription("Send bot panels")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName("panel").setDescription("Post the mission tracker panel")
      .addChannelOption(optionString("channel", "Channel for the panel", true)))
    .addSubcommand((s) => s.setName("ticket_panel").setDescription("Post the ticket panel"));
  const commands = [
    config, send,
    new SlashCommandBuilder().setName("missiontracker").setDescription("Show current mission countdowns"),
    new SlashCommandBuilder().setName("dsatools").setDescription("Open a private DSA tools panel")
      .addStringOption((o) => o.setName("blueprint").setDescription("Optional DSA code to preload").setRequired(false))
      .addAttachmentOption((o) => o.setName("file").setDescription("Optional text file containing DSA code").setRequired(false)),
    ...[
      ["ally", "Add a clan to Ally"], ["neutral", "Add a clan to Neutral"], ["enemy", "Add a clan to Enemy"],
      ["whitelist", "Add a person to Whitelist"], ["kos", "Add a person to KOS"],
    ].map(([name, description]) => new SlashCommandBuilder().setName(name).setDescription(description)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName(name === "ally" || name === "neutral" || name === "enemy" ? "clan_name" : "person")
        .setDescription("Name").setRequired(true))
      .addStringOption((o) => o.setName("tags").setDescription("Optional tags").setRequired(false))),
    ...["removeclan", "removewhitelist", "removekos"].map((name) =>
      new SlashCommandBuilder().setName(name).setDescription("Remove an entry")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption((o) => o.setName(name === "removeclan" ? "clan_name" : "person").setDescription("Name").setRequired(true))),
    new SlashCommandBuilder().setName("moveclan").setDescription("Move a clan to another category")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName("clan_name").setDescription("Clan name").setRequired(true))
      .addStringOption((o) => o.setName("destination").setDescription("Destination").setRequired(true)
        .addChoices({ name: "Ally", value: "ally" }, { name: "Neutral", value: "neutral" }, { name: "Enemy", value: "enemy" })),
  ];
  return commands.map((command) => command.toJSON());
}

async function handleInteraction(client, interaction) {
  if (interaction.isButton()) return handleButton(client, interaction);
  if (interaction.isModalSubmit()) return handleModal(client, interaction);
  if (!interaction.isChatInputCommand()) return;
  if (interaction.guildId && !isAdmin(interaction) &&
      ["config", "send", "ally", "neutral", "enemy", "whitelist", "kos", "moveclan", "removeclan", "removewhitelist", "removekos"].includes(interaction.commandName)) {
    return adminReply(interaction);
  }
  const gc = interaction.guildId ? guildConfig(interaction.guildId) : null;
  const name = interaction.commandName;
  if (name === "missiontracker") {
    return interaction.reply({ content: missionPanel(await fetchMissions()), ephemeral: true, allowedMentions: NO_MENTIONS });
  }
  if (name === "config") {
    const sub = interaction.options.getSubcommand();
    ensureTicketConfig(gc);
    if (sub === "memberlist_channel") {
      gc.channel_id = interaction.options.getChannel("channel").id; gc.message_id = null;
    } else if (sub === "relation_channel") {
      gc.relation_channel_id = interaction.options.getChannel("channel").id; gc.relation_message_id = null;
    } else if (sub === "drednot_message_channel") {
      gc.drednot_channel_id = interaction.options.getChannel("channel").id; gc.drednot_last_ts = 0;
    } else if (sub === "add_roles" || sub === "remove_roles") {
      const roleId = interaction.options.getRole("role").id;
      if (sub === "add_roles" && !gc.roles.includes(roleId)) gc.roles.push(roleId);
      if (sub === "remove_roles") gc.roles = gc.roles.filter((id) => id !== roleId);
    } else if (sub === "role_order") {
      const roleId = interaction.options.getRole("role").id;
      gc.roles = gc.roles.filter((id) => id !== roleId);
      gc.roles.splice(Math.min(interaction.options.getInteger("position") - 1, gc.roles.length), 0, roleId);
    } else if (sub === "ticket_channel") {
      gc.ticket_channel_id = interaction.options.getChannel("channel").id;
    } else if (sub === "add_ticket_roles" || sub === "remove_ticket_roles") {
      const roleId = interaction.options.getRole("role").id;
      if (sub === "add_ticket_roles" && !gc.ticket_roles.includes(roleId)) gc.ticket_roles.push(roleId);
      if (sub === "remove_ticket_roles") gc.ticket_roles = gc.ticket_roles.filter((id) => id !== roleId);
    } else if (sub === "ticket_category") {
      gc.ticket_category_id = interaction.options.getChannel("category").id;
    } else if (sub === "form_log_channel") {
      gc.ticket_form_log_channel_id = interaction.options.getChannel("channel").id;
    }
    updateGuildConfig(interaction.guildId, gc);
    await syncGuild(client, interaction.guild, gc);
    return interaction.reply({ content: `✅ Configuration updated: \`${sub}\`.`, ephemeral: true });
  }
  if (["ally", "neutral", "enemy", "whitelist", "kos"].includes(name)) {
    const category = name;
    const entryName = interaction.options.getString(name === "ally" || name === "neutral" || name === "enemy" ? "clan_name" : "person").trim();
    const tags = interaction.options.getString("tags") || "";
    if (RELATION_CATEGORIES.some((categoryName) => (gc.relations[categoryName] || []).some((entry) => entry.name.toLowerCase() === entryName.toLowerCase()))) {
      return interaction.reply({ content: `⚠️ **${entryName}** is already in a relations list.`, ephemeral: true });
    }
    gc.relations[category].push({ name: entryName, tags });
    updateGuildConfig(interaction.guildId, gc); await syncRelations(client, interaction.guild, gc);
    return interaction.reply({ content: `✅ Added **${entryName}** to **${category}**.`, ephemeral: true });
  }
  if (name === "moveclan" || name === "removeclan" || name === "removewhitelist" || name === "removekos") {
    const entryName = interaction.options.getString(name === "removeclan" ? "clan_name" : "person").trim();
    const categories = name === "removeclan" ? ["ally", "neutral", "enemy"] : [name === "removewhitelist" ? "whitelist" : name === "removekos" ? "kos" : "ally", "neutral", "enemy"];
    let found;
    for (const category of categories) {
      const index = (gc.relations[category] || []).findIndex((entry) => entry.name.toLowerCase().includes(entryName.toLowerCase()));
      if (index >= 0) { found = { category, index, entry: gc.relations[category][index] }; break; }
    }
    if (!found) return interaction.reply({ content: `⚠️ **${entryName}** was not found.`, ephemeral: true });
    gc.relations[found.category].splice(found.index, 1);
    if (name === "moveclan") gc.relations[interaction.options.getString("destination")].push(found.entry);
    updateGuildConfig(interaction.guildId, gc); await syncRelations(client, interaction.guild, gc);
    return interaction.reply({ content: `✅ Updated **${found.entry.name}**.`, ephemeral: true });
  }
  if (name === "send") {
    const sub = interaction.options.getSubcommand();
    if (sub === "panel") {
      const channel = interaction.options.getChannel("channel");
      const snapshots = await fetchMissions();
      const message = await channel.send({ content: missionPanel(snapshots), allowedMentions: NO_MENTIONS });
      gc.mission_panel_channel_id = channel.id; gc.mission_panel_message_id = message.id; updateGuildConfig(interaction.guildId, gc);
      return interaction.reply({ content: `✅ Mission tracker posted in ${channel}.`, ephemeral: true });
    }
    if (sub === "ticket_panel") {
      ensureTicketConfig(gc);
      const channel = await client.channels.fetch(gc.ticket_channel_id).catch(() => null);
      if (!channel?.isTextBased()) return interaction.reply({ content: "❌ Configure a ticket channel first with `/config ticket_channel`.", ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle("🌕Shadow 66 Ticket Creation『☬』")
        .setDescription("Open a ticket by clicking one of the buttons below.\n\n➡️ **Join** — Apply to join Shadow 66\n🤝 **Diplomacy** — Establish relations with our clan\n😀 **Whitelist** — Request to be whitelisted\n❗ **Report** — Report a user or issue")
        .setColor(0x172554).setFooter({ text: "🌕Shadow 66 『☬』" });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_panel_join").setLabel("Join").setEmoji("➡️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ticket_panel_diplomacy").setLabel("Diplomacy").setEmoji("🤝").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ticket_panel_whitelist").setLabel("Whitelist").setEmoji("😀").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ticket_panel_report").setLabel("Report").setEmoji("❗").setStyle(ButtonStyle.Danger),
      );
      const message = await channel.send({ embeds: [embed], components: [row] });
      gc.ticket_panel_message_id = message.id; updateGuildConfig(interaction.guildId, gc);
      return interaction.reply({ content: `✅ Ticket panel posted in ${channel}.`, ephemeral: true });
    }
  }
  if (name === "dsatools") return handleDsaCommand(interaction);
}

async function syncDrednot(client) {
  const bots = await api("/api/bots");
  if (!bots.length) return;
  const botId = bots[0].id;
  const snapshots = await fetchMissions();
  const config = loadConfig();
  for (const [guildId, gc] of Object.entries(config)) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;
    const fullGuild = await client.guilds.fetch(guildId);
    const members = gc.roles.map((roleId) => {
      const role = fullGuild.roles.cache.get(roleId);
      return role ? { role: role.name, members: [...role.members.values()].filter((m) => !m.user.bot).map((m) => m.displayName) } : null;
    }).filter(Boolean);
    await api(`/api/bots/${botId}/motd-data`, {
      method: "POST",
      body: JSON.stringify({
        relations: gc.relations || {},
        members,
        missions: snapshots.map((snapshot) => {
          const [status, mission, target] = missionTarget(snapshot);
          return { server: snapshot.name, status, name: mission, target };
        }),
      }),
    });
  }
}

async function syncChat(client) {
  const config = loadConfig();
  for (const [guildId, gc] of Object.entries(config)) {
    if (!gc.drednot_channel_id) continue;
    const chat = await api(`/api/game-chat?since=${gc.drednot_last_ts || 0}`);
    const channel = await client.channels.fetch(gc.drednot_channel_id).catch(() => null);
    if (channel?.isTextBased()) {
      for (const message of chat.messages || []) {
        await channel.send(`🎮 **${String(message.author || "?").replaceAll("*", "\\*")}**: ${String(message.text || "").replaceAll("*", "\\*")}`, { allowedMentions: NO_MENTIONS });
      }
    }
    gc.drednot_last_ts = chat.serverTs || gc.drednot_last_ts || 0;
    updateGuildConfig(guildId, gc);
  }
}

async function startDiscordBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.warn("[discord] DISCORD_TOKEN not set; Node dashboard will continue without Discord.");
    return null;
  }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.GuildMember],
  });
  client.once("clientReady", async () => {
    console.log(`[discord] Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(token);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commandDefinitions() });
    console.log(`[discord] Synced ${commandDefinitions().length} slash commands`);
    setInterval(() => syncDrednot(client).catch((error) => console.warn(`[motd-sync] ${error.message}`)), 20000);
    setInterval(() => syncChat(client).catch((error) => console.warn(`[drednot-chat] ${error.message}`)), 1000);
    setInterval(() => {
      const config = loadConfig();
      for (const [guildId, gc] of Object.entries(config)) {
        client.guilds.fetch(guildId).then((guild) => syncGuild(client, guild, gc)).catch(() => {});
      }
    }, 20000);
  });
  client.on("interactionCreate", (interaction) => handleInteraction(client, interaction).catch((error) => {
    console.error("[discord] interaction error", error);
    if (interaction.isRepliable() && !interaction.replied) interaction.reply({ content: "An unexpected error occurred.", ephemeral: true }).catch(() => {});
  }));
  client.on("error", (error) => console.error("[discord] client error", error));
  await client.login(token);
  return client;
}

module.exports = { startDiscordBot };