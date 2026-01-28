/**
 * WOPR Discord Plugin
 * Proper streaming with single active message
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, DMChannel } from "discord.js";
import winston from "winston";
import path from "path";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage } from "./types.js";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    new winston.transports.File({ 
      filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin-error.log"),
      level: "error"
    }),
    new winston.transports.File({ 
      filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin.log")
    }),
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()), level: "warn" })
  ],
});

let client: Client | null = null;
let ctx: WOPRPluginContext | null = null;

const configSchema: ConfigSchema = {
  title: "Discord Integration",
  description: "Configure Discord bot integration",
  fields: [
    { name: "token", type: "password", label: "Discord Bot Token", placeholder: "Bot token from Discord Developer Portal", required: true, description: "Your Discord bot token" },
    { name: "guildId", type: "text", label: "Guild ID (optional)", placeholder: "Server ID to restrict bot to", description: "Restrict bot to a specific Discord server" },
    { name: "pairingRequests", type: "object", hidden: true, default: {} },
    { name: "mappings", type: "object", hidden: true, default: {} },
  ],
};

const DISCORD_LIMIT = 2000;
const EDIT_THRESHOLD = 800;     // Edit every ~800 chars
const IDLE_TIMEOUT_MS = 1000;   // New message after 1 second idle

interface StreamState {
  channel: TextChannel | ThreadChannel | DMChannel;
  replyTo: Message;
  message: Message | null;      // Current message being edited
  buffer: string;               // Accumulated content
  sentLength: number;           // How much we've sent to Discord
  lastTokenTime: number;
  editTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  isReply: boolean;             // Is this the first message (a reply)?
}

const streams = new Map<string, StreamState>();

async function sendOrEdit(state: StreamState) {
  const content = state.buffer.trim();
  if (!content) return;
  
  // Check if we need to split (hit Discord limit)
  if (content.length > DISCORD_LIMIT) {
    // Finalize current content
    if (state.message) {
      try {
        await state.message.edit(content.slice(0, DISCORD_LIMIT));
        state.sentLength = DISCORD_LIMIT;
      } catch (e) {
        logger.error({ msg: "Edit failed", error: String(e) });
      }
    } else {
      // Create first part as reply or channel message
      try {
        if (state.isReply) {
          state.message = await state.replyTo.reply(content.slice(0, DISCORD_LIMIT));
          state.isReply = false;
        } else {
          state.message = await state.channel.send(content.slice(0, DISCORD_LIMIT));
        }
        state.sentLength = DISCORD_LIMIT;
      } catch (e) {
        logger.error({ msg: "Send failed", error: String(e) });
        return;
      }
    }
    
    // Start new message with remaining content
    const remaining = content.slice(DISCORD_LIMIT);
    state.buffer = remaining;
    state.sentLength = 0;
    state.message = null;
    
    // Recursively send remaining
    await sendOrEdit(state);
    return;
  }
  
  // Normal case - content fits in one message
  try {
    if (!state.message) {
      // Create new message
      if (state.isReply) {
        state.message = await state.replyTo.reply(content);
        state.isReply = false;
      } else {
        state.message = await state.channel.send(content);
      }
    } else {
      // Edit existing
      await state.message.edit(content);
    }
    state.sentLength = content.length;
  } catch (e) {
    logger.error({ msg: "Send/Edit failed", error: String(e) });
  }
}

function clearTimers(state: StreamState) {
  if (state.editTimer) {
    clearTimeout(state.editTimer);
    state.editTimer = null;
  }
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function scheduleEdit(sessionKey: string, state: StreamState) {
  // Only schedule if not already scheduled
  if (state.editTimer) return;
  
  state.editTimer = setTimeout(() => {
    state.editTimer = null;
    const newContent = state.buffer.slice(state.sentLength);
    if (newContent.length > 0) {
      sendOrEdit(state).catch((e) => logger.error({ msg: "Scheduled edit failed", error: String(e) }));
    }
  }, 100); // Small delay to batch rapid tokens
}

function startIdleTimer(sessionKey: string, state: StreamState) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  
  state.idleTimer = setTimeout(() => {
    logger.info({ msg: "Idle timeout - finalizing message", sessionKey, finalLength: state.buffer.length });
    clearTimers(state);
    // Mark as done - next tokens will create new message
    streams.delete(sessionKey);
  }, IDLE_TIMEOUT_MS);
}

async function handleChunk(msg: StreamMessage, sessionKey: string) {
  if (msg.type !== "text" || !msg.content) return;
  
  const state = streams.get(sessionKey);
  if (!state) return;
  
  state.lastTokenTime = Date.now();
  state.buffer += msg.content;
  
  // Check if we should edit now (every ~800 new chars)
  const newContent = state.buffer.slice(state.sentLength);
  if (newContent.length >= EDIT_THRESHOLD) {
    // Edit immediately
    clearTimers(state);
    await sendOrEdit(state);
    startIdleTimer(sessionKey, state);
  } else {
    // Schedule edit
    scheduleEdit(sessionKey, state);
    startIdleTimer(sessionKey, state);
  }
}

async function handleMessage(message: Message) {
  if (!client || !ctx) return;
  if (message.author.bot) return;
  if (!client.user) return;

  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isDM = message.channel.type === 1;
  if (!isDirectlyMentioned && !isDM) return;

  const authorDisplayName = message.member?.displayName || (message.author as any).displayName || message.author.username;
  
  let messageContent = message.content;
  if (client.user && isDirectlyMentioned) {
    const botMention = `<@${client.user.id}>`;
    const botNicknameMention = `<@!${client.user.id}>`;
    messageContent = messageContent.replace(botNicknameMention, "").replace(botMention, "").trim();
  }
  
  try {
    ctx.logMessage(`discord-${message.channel.id}`, `${authorDisplayName}: ${message.content}`, {
      from: authorDisplayName,
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name }
    });
  } catch (e) {}

  try { await message.react("👀"); } catch (e) {}
  
  const sessionKey = `discord-${message.channel.id}`;
  
  // Clean up existing stream for this session
  const existing = streams.get(sessionKey);
  if (existing) clearTimers(existing);
  streams.delete(sessionKey);
  
  // Create new stream
  const state: StreamState = {
    channel: message.channel as TextChannel | ThreadChannel | DMChannel,
    replyTo: message,
    message: null,
    buffer: "",
    sentLength: 0,
    lastTokenTime: Date.now(),
    editTimer: null,
    idleTimer: null,
    isReply: true,
  };
  streams.set(sessionKey, state);
  
  logger.info({ msg: "New stream", sessionKey, content: messageContent.slice(0, 100) });
  
  try {
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
      onStream: (msg: StreamMessage) => {
        handleChunk(msg, sessionKey).catch((e) => logger.error({ msg: "Chunk error", error: String(e) }));
      }
    });
    
    // Injection done - finalize
    const finalState = streams.get(sessionKey);
    if (finalState) {
      clearTimers(finalState);
      await sendOrEdit(finalState);
      streams.delete(sessionKey);
    }
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    
  } catch (error: any) {
    logger.error({ msg: "Inject failed", error: String(error) });
    const failState = streams.get(sessionKey);
    if (failState) clearTimers(failState);
    streams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("❌");
    } catch (e) {}
    await message.reply("Error processing your request.");
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.5.0",
  description: "Discord bot with proper streaming",

  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);

    let config = ctx.getConfig<{token?: string; guildId?: string}>();
    if (!config?.token) {
      const legacyConfig = ctx.getMainConfig("discord") as {token?: string; guildId?: string};
      if (legacyConfig?.token) config = { token: legacyConfig.token, guildId: legacyConfig.guildId };
    }

    if (!config?.token) {
      logger.warn("Discord not configured");
      return;
    }

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    client.on(Events.MessageCreate, (msg) => {
      handleMessage(msg).catch((e) => logger.error({ msg: "Handler error", error: String(e) }));
    });
    
    client.on(Events.ClientReady, () => logger.info({ msg: "Bot logged in", tag: client?.user?.tag }));

    try {
      await client.login(config.token);
      logger.info("Bot started");
    } catch (error: any) {
      logger.error({ msg: "Failed to start", error: String(error) });
      throw error;
    }
  },

  async shutdown() {
    if (client) await client.destroy();
    logger.info("Plugin shut down");
  },
};

export default plugin;
