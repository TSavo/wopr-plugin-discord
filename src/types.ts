/**
 * Local type definitions for WOPR plugin
 */

export interface ConfigField {
  name: string;
  type: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  description?: string;
  hidden?: boolean;
  default?: any;
}

export interface ConfigSchema {
  title: string;
  description: string;
  fields: ConfigField[];
}

export interface StreamMessage {
  type: "text";
  content: string;
}

export interface PluginLogger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface WOPRPluginContext {
  inject: (session: string, message: string, onStream?: (msg: StreamMessage) => void) => Promise<string>;
  injectPeer: (peer: string, session: string, message: string) => Promise<string>;
  getIdentity: () => { publicKey: string; shortId: string; encryptPub: string };
  getSessions: () => string[];
  getPeers: () => any[];
  getConfig: <T = any>() => T;
  saveConfig: <T>(config: T) => Promise<void>;
  getMainConfig: (key?: string) => any;
  registerConfigSchema: (pluginId: string, schema: ConfigSchema) => void;
  getPluginDir: () => string;
  log: PluginLogger;
}

export interface WOPRPlugin {
  name: string;
  version: string;
  description: string;
  init?: (context: WOPRPluginContext) => Promise<void>;
  shutdown?: () => Promise<void>;
}
