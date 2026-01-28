/**
 * WOPR Discord Plugin
 * Talk to your WOPR sessions via Discord.
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, DMChannel } from "discord.js";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage } from "./types.js";

let client: Client | null = null;
let ctx: WOPRPluginContext | null = null;

const configSchema: ConfigSchema = {
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

const DISCORD_LIMIT = 2000;
const COALESCE_CHARS = 500;  // Update Discord message every 500 chars
const COALESCE_MS = 300;     // Or after 300ms idle

// Track streaming state per session
interface StreamState {
  channel: Message["channel"];
  replyTo: Message;
  thinkingMsg: Message | null;
  responseMsg: Message | null;
  buffer: string;
  mode: "thinking" | "response";
  lastUpdate: number;
  timeout: NodeJS.Timeout | null;
}

const streams = new Map<string, StreamState>();

async function flushState(state: StreamState, force: boolean = false) {
  if (!state.buffer.trim()) return;
  
  const text = state.buffer.trim();
  const prefix = state.mode === "thinking" ? "💭 " : "";
  const fullText = prefix + text;
  
  // Check if we need to split (Discord 2000 char limit)
  if (fullText.length > DISCORD_LIMIT) {
    // Send current message and start new one
    const chunks = splitMessage(text, DISCORD_LIMIT - prefix.length);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = prefix + chunks[i];
      
      if (state.mode === "thinking") {
        if (state.thinkingMsg && i === 0) {
          await state.thinkingMsg.edit(chunkText);
        } else {
          state.thinkingMsg = await sendToChannel(state.channel, chunkText) || state.thinkingMsg;
        }
      } else {
        if (state.responseMsg && i === 0) {
          await state.responseMsg.edit(chunkText);
        } else if (i === 0) {
          state.responseMsg = await state.replyTo.reply(chunkText);
        } else {
          await sendToChannel(state.channel, chunks[i]);
        }
      }
    }
    
    state.buffer = "";
    state.lastUpdate = Date.now();
    return;
  }
  
  // Update existing message
  try {
    if (state.mode === "thinking") {
      if (state.thinkingMsg) {
        await state.thinkingMsg.edit(fullText);
      } else {
        state.thinkingMsg = await sendToChannel(state.channel, fullText) || null;
      }
    } else {
      if (state.responseMsg) {
        await state.responseMsg.edit(fullText);
      } else {
        state.responseMsg = await state.replyTo.reply(fullText);
      }
    }
    state.lastUpdate = Date.now();
  } catch (e) {
    // Message might have been deleted or other error
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    
    // Find good breaking point
    let breakPoint = remaining.lastIndexOf("\n\n", maxLen);
    if (breakPoint < maxLen * 0.5) breakPoint = remaining.lastIndexOf("\n", maxLen);
    if (breakPoint < maxLen * 0.5) breakPoint = remaining.lastIndexOf(" ", maxLen);
    if (breakPoint < maxLen * 0.5) breakPoint = maxLen;
    
    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trim();
  }
  
  return chunks;
}

function scheduleFlush(sessionKey: string, state: StreamState) {
  if (state.timeout) clearTimeout(state.timeout);
  
  state.timeout = setTimeout(() => {
    flushState(state, false).catch(() => {});
  }, COALESCE_MS);
}

async function handleStream(msg: StreamMessage, sessionKey: string) {
  if (msg.type !== "text" || !msg.content) return;
  
  const state = streams.get(sessionKey);
  if (!state) return;
  
  const text = msg.content;
  
  // Detect transition from thinking to response
  if (state.mode === "thinking" && looksLikeResponseStart(text)) {
    // Flush any remaining thinking
    await flushState(state, true);
    state.mode = "response";
    state.buffer = "";
  }
  
  // Add to buffer
  state.buffer += text;
  
  // Flush if buffer is large enough
  if (state.buffer.length >= COALESCE_CHARS) {
    await flushState(state, false);
  } else {
    scheduleFlush(sessionKey, state);
  }
}

function looksLikeResponseStart(text: string): boolean {
  const trimmed = text.trim();
  
  // Response markers
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("---")) return true;
  if (trimmed.startsWith("```")) return true;
  if (trimmed.startsWith(">")) return true;
  if (trimmed.startsWith("|")) return true;
  if (/^\d+\./.test(trimmed)) return true;
  if (/^[A-Z][a-z]+ \d+:/.test(trimmed)) return true;
  if (trimmed.startsWith("**")) return true;
  
  // Substantial formatted content
  if (text.length > 100 && (text.includes("```") || text.includes("**") || text.includes("|"))) {
    return true;
  }
  
  return false;
}

async function sendToChannel(channel: Message["channel"], text: string): Promise<Message | undefined> {
  if (channel.isTextBased() && "send" in channel) {
    return await (channel as TextChannel | ThreadChannel | DMChannel).send(text);
  }
  return undefined;
}

async function handleMessage(message: Message) {
  if (!client || !ctx) return;
  if (message.author.bot) return;
  if (!client.user) return;

  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isDM = message.channel.type === 1;
  
  const authorDisplayName = message.member?.displayName || (message.author as any).displayName || message.author.username;
  
  let messageContent = message.content;
  if (client.user && isDirectlyMentioned) {
    const botMention = `<@${client.user.id}>`;
    const botNicknameMention = `<@!${client.user.id}>`;
    messageContent = messageContent.replace(botNicknameMention, "").replace(botMention, "").trim();
  }
  
  const shouldRespond = isDirectlyMentioned || isDM;
  
  try {
    ctx.logMessage(
      `discord-${message.channel.id}`,
      `${authorDisplayName}: ${message.content}`,
      { from: authorDisplayName, channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name } }
    );
  } catch (e) {}
  
  if (!shouldRespond) return;

  try {
    await message.react("👀");
  } catch (e) {}
  
  const sessionKey = `discord-${message.channel.id}`;
  
  // Clean up any existing stream for this session
  const existing = streams.get(sessionKey);
  if (existing?.timeout) clearTimeout(existing.timeout);
  streams.delete(sessionKey);
  
  // Create new stream state
  const state: StreamState = {
    channel: message.channel,
    replyTo: message,
    thinkingMsg: null,
    responseMsg: null,
    buffer: "",
    mode: "thinking",
    lastUpdate: Date.now(),
    timeout: null,
  };
  streams.set(sessionKey, state);
  
  try {
    await ctx.inject(
      sessionKey,
      messageContent,
      {
        from: authorDisplayName,
        channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
        onStream: (msg: StreamMessage) => {
          handleStream(msg, sessionKey).catch(() => {});
        }
      }
    );
    
    // Final flush
    if (state.timeout) clearTimeout(state.timeout);
    await flushState(state, true);
    
    // Clean up
    streams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    
  } catch (error: any) {
    ctx.log.error("Discord inject error:", error);
    
    const state = streams.get(sessionKey);
    if (state?.timeout) clearTimeout(state.timeout);
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
  version: "2.2.1",
  description: "Discord bot integration for WOPR with streaming support",

  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    ctx.log.info("Discord config schema registered");

    let config = ctx.getConfig<{token?: string; guildId?: string}>();

    if (!config?.token) {
      const legacyConfig = ctx.getMainConfig("discord") as {token?: string; guildId?: string};
      if (legacyConfig?.token) {
        config = { 
          token: legacyConfig.token, 
          guildId: legacyConfig.guildId,
        };
      }
    }

    if (!config?.token) {
      ctx.log.warn("Discord not configured.");
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

    client.on(Events.MessageCreate, handleMessage);
    client.on(Events.ClientReady, () => {
      ctx!.log.info(`Discord bot logged in as ${client!.user?.tag}`);
    });

    try {
      await client.login(config.token);
      ctx.log.info("Discord bot started");
    } catch (error: any) {
      ctx.log.error("Failed to start Discord bot:", error.message);
    }
  },

  async shutdown() {
    if (client) await client.destroy();
    ctx?.log.info("Discord plugin shut down");
  },
};

export default plugin;
