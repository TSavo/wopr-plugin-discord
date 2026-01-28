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

// Discord message limit
const DISCORD_LIMIT = 2000;

function chunkMessage(text: string, maxLength: number = DISCORD_LIMIT): string[] {
  if (text.length <= maxLength) return [text];
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    
    // Find good breaking point
    let breakPoint = remaining.lastIndexOf("\n", maxLength);
    if (breakPoint === -1 || breakPoint < maxLength * 0.5) {
      breakPoint = remaining.lastIndexOf(" ", maxLength);
    }
    if (breakPoint === -1 || breakPoint < maxLength * 0.5) {
      breakPoint = maxLength;
    }
    
    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trim();
  }
  
  return chunks;
}

// Track streaming state per session
interface StreamState {
  thinkingMsg: Message | null;
  responseMsg: Message | null;
  thinkingBuf: string;
  responseBuf: string;
  inResponse: boolean;
}

const streams = new Map<string, StreamState>();

async function sendToChannel(channel: Message["channel"], text: string): Promise<Message | undefined> {
  if (channel.isTextBased() && "send" in channel) {
    return await (channel as TextChannel | ThreadChannel | DMChannel).send(text);
  }
  return undefined;
}

async function handleStream(msg: StreamMessage, channel: Message["channel"], replyTo: Message, state: StreamState) {
  if (msg.type !== "text" || !msg.content) return;
  
  const text = msg.content;
  
  // Detect transition from thinking to response
  if (!state.inResponse) {
    // Check for response markers (headers, dividers, code blocks, etc.)
    if (looksLikeResponseStart(text)) {
      state.inResponse = true;
      // Flush thinking buffer first
      if (state.thinkingBuf.trim()) {
        const chunks = chunkMessage(state.thinkingBuf.trim());
        for (const chunk of chunks) {
          await sendToChannel(channel, "💭 " + chunk);
        }
      }
    }
  }
  
  if (state.inResponse) {
    state.responseBuf += text;
    
    // Update or create response message
    const chunks = chunkMessage(state.responseBuf);
    
    if (!state.responseMsg) {
      // First chunk as reply
      state.responseMsg = await replyTo.reply(chunks[0]);
      
      // Send remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        await sendToChannel(channel, chunks[i]);
      }
    } else if (chunks.length === 1) {
      // Still fits in one message, edit it
      await state.responseMsg.edit(chunks[0]);
    } else {
      // Multiple chunks needed, edit first and send rest
      await state.responseMsg.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await sendToChannel(channel, chunks[i]);
      }
    }
  } else {
    state.thinkingBuf += text;
    
    // Send thinking updates periodically
    if (state.thinkingBuf.length > 500 || text.includes("\n\n")) {
      const chunks = chunkMessage(state.thinkingBuf.trim());
      
      if (!state.thinkingMsg) {
        state.thinkingMsg = await sendToChannel(channel, "💭 " + chunks[chunks.length - 1]) as Message;
      } else {
        await state.thinkingMsg.edit("💭 " + chunks[chunks.length - 1].slice(0, 1990));
      }
    }
  }
}

function looksLikeResponseStart(text: string): boolean {
  const trimmed = text.trim();
  
  // Response markers
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("---")) return true;
  if (trimmed.startsWith("```")) return true;
  if (trimmed.startsWith(">")) return true;
  if (trimmed.startsWith("|")) return true;  // Tables
  if (/^\d+\./.test(trimmed)) return true;   // Numbered lists
  if (/^[A-Z][a-z]+ \d+:/.test(trimmed)) return true;  // "Section 1:"
  
  // If it's a substantial block with formatting, it's probably response
  if (text.length > 200 && (text.includes("```") || text.includes("**"))) {
    return true;
  }
  
  return false;
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
  const state: StreamState = {
    thinkingMsg: null,
    responseMsg: null,
    thinkingBuf: "",
    responseBuf: "",
    inResponse: false,
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
          handleStream(msg, message.channel, message, state).catch(() => {});
        }
      }
    );
    
    // Flush any remaining content
    if (!state.inResponse && state.thinkingBuf.trim()) {
      const chunks = chunkMessage(state.thinkingBuf.trim());
      for (const chunk of chunks) {
        await sendToChannel(message.channel, "💭 " + chunk);
      }
    }
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    
  } catch (error: any) {
    ctx.log.error("Discord inject error:", error);
    streams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("❌");
    } catch (e) {}
    
    await message.reply("Error processing your request.");
  }
  
  streams.delete(sessionKey);
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.2.0",
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
