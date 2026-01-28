/**
 * WOPR Discord Plugin
 * Talk to your WOPR sessions via Discord.
 */

import { Client, GatewayIntentBits, Events } from "discord.js";
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

let client = null;
let ctx = null;

// Content types for UI server
const CONTENT_TYPES = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
};

// ============================================================================
// Config Schema
// ============================================================================
const configSchema = {
  title: "Discord Integration",
  description: "Configure Discord bot integration",
  fields: [
    {
      name: "token",
      type: "password",
      label: "Discord Bot Token",
      placeholder: "Bot token from Discord Developer Portal",
      required: true,
      description: "Your Discord bot token",
    },
    {
      name: "guildId",
      type: "text",
      label: "Guild ID (optional)",
      placeholder: "Server ID to restrict bot to",
      description: "Restrict bot to a specific Discord server",
    },
    {
      name: "pairingRequests",
      type: "object",
      hidden: true,
      default: {},
    },
    {
      name: "mappings",
      type: "object",
      hidden: true,
      default: {},
    },
  ],
};

// ============================================================================
// Pairing Requests
// ============================================================================
function generatePairingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createPairingRequest(userId, userName, channelName, guildName, session) {
  const config = ctx.getConfig();
  config.pairingRequests = config.pairingRequests || {};

  const existing = Object.entries(config.pairingRequests).find(
    ([_, req]) => req.userId === userId && req.status === "pending"
  );
  if (existing) {
    return { code: existing[0], existing: true };
  }

  const code = generatePairingCode();
  config.pairingRequests[code] = {
    userId,
    userName,
    channelName,
    guildName,
    session,
    status: "pending",
    createdAt: Date.now(),
  };

  ctx.saveConfig(config);
  return { code, existing: false };
}

// ============================================================================
// Session Management
// ============================================================================
function ensureSessionExists(sessionName, channel) {
  const sessionsDir = join(ctx.getPluginDir(), "..", "..", "sessions");
  const contextPath = join(sessionsDir, `${sessionName}.md`);

  if (!existsSync(contextPath)) {
    mkdirSync(sessionsDir, { recursive: true });

    const channelInfo = channel.guild
      ? `Discord server "${channel.guild.name}", channel #${channel.name}`
      : `Discord DM`;

    const context = `You are WOPR responding in ${channelInfo}.

Keep responses concise - Discord has a 2000 character limit.
Use markdown formatting (Discord supports it).
Be helpful but brief.`;

    writeFileSync(contextPath, context);
    ctx.log.info(`Created session: ${sessionName}`);
  }
}

function getSessionForChannel(channelId, channel) {
  const config = ctx.getConfig();
  if (config.mappings?.[channelId]) {
    return config.mappings[channelId].session;
  }

  // Auto-create session for new channels
  if (channel) {
    const sessionName = `discord-${channelId}`;
    config.mappings = config.mappings || {};
    config.mappings[channelId] = {
      session: sessionName,
      channelName: channel.name || "DM",
      guildName: channel.guild?.name || "Direct Message",
      createdAt: Date.now(),
    };
    ctx.saveConfig(config);

    ctx.log.info(`Auto-mapped ${channel.name || channelId} -> ${sessionName}`);
    return sessionName;
  }

  return null;
}

// ============================================================================
// Message Handling
// ============================================================================
async function resolveMentions(content, guild) {
  // Replace Discord mentions with usernames
  content = content.replace(/<@!?(\d+)>/g, (match, userId) => {
    const user = client.users.cache.get(userId);
    if (user) return `@${user.username}`;
    if (guild) {
      const member = guild.members.cache.get(userId);
      if (member) return `@${member.user.username}`;
    }
    return '@unknown';
  });
  
  content = content.replace(/<@&(\d+)>/g, (match, roleId) => {
    if (guild) {
      const role = guild.roles.cache.get(roleId);
      if (role) return `@${role.name}`;
    }
    return '@unknown-role';
  });
  
  content = content.replace(/<#(\d+)>/g, (match, channelId) => {
    if (guild) {
      const channel = guild.channels.cache.get(channelId);
      if (channel) return `#${channel.name}`;
    }
    return '#unknown-channel';
  });

  return content;
}

async function formatOutgoingMentions(content, guild) {
  if (!guild) return content;
  
  const usernameMap = new Map();
  guild.members.cache.forEach(member => {
    usernameMap.set(member.user.username.toLowerCase(), member.user.id);
  });
  
  content = content.replace(/@(\w+)/g, (match, username) => {
    const userId = usernameMap.get(username.toLowerCase());
    if (userId) return `<@${userId}>`;
    return match;
  });
  
  return content;
}

async function handleMessage(message) {
  if (message.author.bot) return;
  if (!client.user) return;

  const isMentioned = message.mentions.has(client.user.id);
  const isDM = message.channel.type === 1; // DM channel type

  if (!isMentioned && !isDM) return;

  const config = ctx.getConfig();
  const sessionName = getSessionForChannel(message.channel.id, message.channel);

  if (!sessionName) {
    await message.reply("No session configured for this channel.");
    return;
  }

  ensureSessionExists(sessionName, message.channel);

  // Resolve mentions for the prompt
  const resolvedContent = await resolveMentions(message.content, message.guild);

  // Build multimodal prompt
  const prompt = {
    text: resolvedContent,
    author: message.author.username,
  };

  // Handle images
  const imageAttachments = message.attachments
    .filter(att => att.contentType?.startsWith("image/"))
    .map(att => att.url);

  let responseText = "";
  let replyMessage = null;

  try {
    await ctx.inject(sessionName, prompt, async (chunk) => {
      if (chunk.type === "text") {
        responseText += chunk.content;

        // Discord has 2000 char limit - send in chunks
        if (responseText.length > 1800) {
          const toSend = responseText.slice(0, 1800);
          responseText = responseText.slice(1800);

          if (!replyMessage) {
            replyMessage = await message.reply(toSend);
          } else {
            await message.channel.send(toSend);
          }
        }
      }
    }, {
      from: message.author.username,
      channel: { type: "discord", id: message.channel.id },
      images: imageAttachments,
    });

    // Format mentions for outgoing message
    const formattedResponse = await formatOutgoingMentions(responseText, message.guild);

    if (responseText.trim()) {
      if (!replyMessage) {
        await message.reply(formattedResponse);
      } else if (responseText.length > 0) {
        await message.channel.send(formattedResponse);
      }
    }
  } catch (error) {
    ctx.log.error("Discord inject error:", error);
    await message.reply("Error processing your request.");
  }
}

// ============================================================================
// Plugin Export
// ============================================================================
const plugin = {
  name: "wopr-plugin-discord",
  version: "2.0.0",
  description: "Discord bot integration for WOPR",

  async init(context) {
    ctx = context;
    
    // Register config schema
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    ctx.log.info("Discord config schema registered");

    const config = ctx.getConfig();
    
    if (!config.token) {
      ctx.log.warn("Discord not configured. Add bot token in settings.");
      return;
    }

    // Initialize Discord client
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    client.on(Events.MessageCreate, handleMessage);

    client.on(Events.Ready, () => {
      ctx.log.info(`Discord bot logged in as ${client.user?.tag}`);
    });

    try {
      await client.login(config.token);
      ctx.log.info("Discord bot started");
    } catch (error) {
      ctx.log.error("Failed to start Discord bot:", error.message);
    }
  },

  async shutdown() {
    if (client) {
      await client.destroy();
    }
    ctx?.log.info("Discord plugin shut down");
  },
};

export default plugin;
