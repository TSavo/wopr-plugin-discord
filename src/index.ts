/**
 * WOPR Discord Plugin - Fixed streaming
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, DMChannel } from "discord.js";
import winston from "winston";
import path from "path";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage } from "./types.js";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin-error.log"), level: "error" }),
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin.log") }),
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()), level: "info" }),
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
const EDIT_THRESHOLD = 800;
const IDLE_SPLIT_MS = 1000;

interface StreamState {
  channel: TextChannel | ThreadChannel | DMChannel;
  replyTo: Message;
  message: Message | null;
  buffer: string;
  lastUpdateTime: number;
  isReply: boolean;
}

const streams = new Map<string, StreamState>();

async function sendChunk(state: StreamState, text: string): Promise<Message> {
  if (state.message) {
    await state.message.edit(text);
    return state.message;
  } else if (state.isReply) {
    const msg = await state.replyTo.reply(text);
    state.isReply = false;
    return msg;
  } else {
    return await state.channel.send(text);
  }
}

async function handleChunk(msg: StreamMessage, sessionKey: string) {
  if (msg.type !== "text" || !msg.content) return;
  
  const state = streams.get(sessionKey);
  if (!state) {
    logger.error({ msg: "No state found for chunk", sessionKey });
    return;
  }
  
  const now = Date.now();
  const timeSinceLast = now - state.lastUpdateTime;
  
  // Check for idle gap - split to new message
  if (timeSinceLast > IDLE_SPLIT_MS && state.buffer.length > 0 && state.message) {
    logger.info({ msg: "IDLE GAP - starting new message", sessionKey, gapMs: timeSinceLast });
    // Reset for new message
    state.message = null;
    state.buffer = msg.content;
    state.lastUpdateTime = now;
    await sendChunk(state, state.buffer);
    return;
  }
  
  // Add content
  state.buffer += msg.content;
  state.lastUpdateTime = now;
  
  // Check if we need to split (hit Discord limit)
  if (state.buffer.length > DISCORD_LIMIT) {
    logger.info({ msg: "SPLITTING at Discord limit", sessionKey, bufferLength: state.buffer.length });
    
    // Send what fits
    const toSend = state.buffer.slice(0, DISCORD_LIMIT);
    await sendChunk(state, toSend);
    
    // Start new message with remainder
    const remaining = state.buffer.slice(DISCORD_LIMIT);
    state.message = null;
    state.buffer = remaining;
    
    if (remaining.length > 0) {
      await sendChunk(state, remaining);
    }
    return;
  }
  
  // Normal update
  await sendChunk(state, state.buffer);
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
  
  try { ctx.logMessage(`discord-${message.channel.id}`, `${authorDisplayName}: ${message.content}`, { from: authorDisplayName, channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name } }); } catch (e) {}
  try { await message.react("👀"); } catch (e) {}
  
  const sessionKey = `discord-${message.channel.id}`;
  streams.delete(sessionKey);
  
  const state: StreamState = {
    channel: message.channel as TextChannel | ThreadChannel | DMChannel,
    replyTo: message,
    message: null,
    buffer: "",
    lastUpdateTime: Date.now(),
    isReply: true,
  };
  streams.set(sessionKey, state);
  
  logger.info({ msg: "New stream", sessionKey });
  
  try {
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
      onStream: (msg: StreamMessage) => {
        handleChunk(msg, sessionKey).catch((e) => logger.error({ msg: "Chunk error", error: String(e) }));
      }
    });
    
    streams.delete(sessionKey);
    try { await message.reactions.cache.get("👀")?.users.remove(client.user.id); await message.react("✅"); } catch (e) {}
  } catch (error: any) {
    logger.error({ msg: "Inject failed", error: String(error) });
    streams.delete(sessionKey);
    try { await message.reactions.cache.get("👀")?.users.remove(client.user.id); await message.react("❌"); } catch (e) {}
    await message.reply("Error processing your request.");
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.8.0",
  description: "Discord bot with fixed streaming",
  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    let config = ctx.getConfig<{token?: string; guildId?: string}>();
    if (!config?.token) { const legacy = ctx.getMainConfig("discord") as {token?: string}; if (legacy?.token) config = { token: legacy.token }; }
    if (!config?.token) { logger.warn("Not configured"); return; }
    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessageReactions] });
    client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => logger.error(e)));
    client.on(Events.ClientReady, () => logger.info({ tag: client?.user?.tag }));
    try { await client.login(config.token); logger.info("Started"); } catch (e) { logger.error(e); throw e; }
  },
  async shutdown() { if (client) await client.destroy(); },
};

export default plugin;
