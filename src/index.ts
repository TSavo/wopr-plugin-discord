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
const EDIT_COALESCE_CHARS = 800;  // Edit every 800 chars
const EDIT_COALESCE_MS = 500;     // Or every 500ms

// Track streaming state per session
interface StreamState {
  channel: Message["channel"];
  replyTo: Message;
  message: Message | null;  // Single message for both thinking and response
  buffer: string;
  displayedLength: number;  // How much we've already sent to Discord
  mode: "thinking" | "response";
  flushTimer: NodeJS.Timeout | null;
  isComplete: boolean;
}

const streams = new Map<string, StreamState>();

async function updateDiscordMessage(state: StreamState) {
  if (!state.buffer.trim()) return;
  
  const fullText = state.buffer.trim();
  
  // Only update if we have new content to show
  if (fullText.length <= state.displayedLength) return;
  
  // Get just the new portion for appending
  const newContent = fullText.slice(state.displayedLength);
  
  try {
    if (!state.message) {
      // First message - create it
      const chunk = fullText.slice(0, DISCORD_LIMIT);
      state.message = await state.replyTo.reply(chunk);
      state.displayedLength = chunk.length;
    } else if (fullText.length <= DISCORD_LIMIT) {
      // Still fits in one message - edit it
      await state.message.edit(fullText);
      state.displayedLength = fullText.length;
    } else {
      // Need to split into multiple messages
      // Send remaining content as new messages
      let remaining = fullText.slice(state.displayedLength);
      
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, DISCORD_LIMIT);
        await sendToChannel(state.channel, chunk);
        state.displayedLength += chunk.length;
        remaining = remaining.slice(DISCORD_LIMIT);
      }
    }
  } catch (e) {
    // Message might have been deleted
  }
}

function scheduleUpdate(sessionKey: string, state: StreamState) {
  if (state.flushTimer) clearTimeout(state.flushTimer);
  
  state.flushTimer = setTimeout(() => {
    updateDiscordMessage(state).catch(() => {});
  }, EDIT_COALESCE_MS);
}

async function flushFinal(state: StreamState) {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  
  state.isComplete = true;
  
  // Final update with all remaining content
  if (state.buffer.trim()) {
    const fullText = state.buffer.trim();
    
    try {
      if (!state.message) {
        // No message created yet - send it all
        const chunks = splitMessage(fullText, DISCORD_LIMIT);
        for (let i = 0; i < chunks.length; i++) {
          if (i === 0) {
            state.message = await state.replyTo.reply(chunks[i]);
          } else {
            await sendToChannel(state.channel, chunks[i]);
          }
        }
      } else if (fullText.length <= DISCORD_LIMIT) {
        // Fits in one message - final edit
        await state.message.edit(fullText);
      } else {
        // Multiple messages needed - send remaining
        const remaining = fullText.slice(state.displayedLength);
        if (remaining) {
          const chunks = splitMessage(remaining, DISCORD_LIMIT);
          for (const chunk of chunks) {
            await sendToChannel(state.channel, chunk);
          }
        }
      }
    } catch (e) {}
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

async function handleStream(msg: StreamMessage, sessionKey: string) {
  if (msg.type !== "text" || !msg.content) return;
  
  const state = streams.get(sessionKey);
  if (!state || state.isComplete) return;
  
  const text = msg.content;
  
  // Detect transition from thinking to response
  if (state.mode === "thinking" && looksLikeResponseStart(text)) {
    // Flush thinking before switching
    await updateDiscordMessage(state);
    state.mode = "response";
  }
  
  // Append to buffer
  state.buffer += text;
  
  // Check if we should update Discord (every N chars or on natural breaks)
  const newContentLength = state.buffer.length - state.displayedLength;
  const hasNaturalBreak = text.includes("\n\n") || text.includes(". ") || text.includes("? ") || text.includes("! ");
  
  if (newContentLength >= EDIT_COALESCE_CHARS || (hasNaturalBreak && newContentLength > 100)) {
    await updateDiscordMessage(state);
  } else {
    scheduleUpdate(sessionKey, state);
  }
}

function looksLikeResponseStart(text: string): boolean {
  const trimmed = text.trim();
  
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("---")) return true;
  if (trimmed.startsWith("```")) return true;
  if (trimmed.startsWith(">")) return true;
  if (trimmed.startsWith("|")) return true;
  if (/^\d+\./.test(trimmed)) return true;
  if (/^[A-Z][a-z]+ \d+:/.test(trimmed)) return true;
  if (trimmed.startsWith("**")) return true;
  
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
  
  // Clean up any existing stream
  const existing = streams.get(sessionKey);
  if (existing?.flushTimer) clearTimeout(existing.flushTimer);
  streams.delete(sessionKey);
  
  // Create new stream state
  const state: StreamState = {
    channel: message.channel,
    replyTo: message,
    message: null,
    buffer: "",
    displayedLength: 0,
    mode: "thinking",
    flushTimer: null,
    isComplete: false,
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
    
    // Final flush when complete
    await flushFinal(state);
    streams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    
  } catch (error: any) {
    ctx.log.error("Discord inject error:", error);
    
    const state = streams.get(sessionKey);
    if (state?.flushTimer) clearTimeout(state.flushTimer);
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
  version: "2.2.3",
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
