/**
 * Discord Plugin UI Component for WOPR
 * 
 * Vanilla JS version using SolidJS's h() hyperscript function.
 * This avoids needing JSX compilation.
 * 
 * The host WOPR UI provides: Solid (solid-js), api, currentSession, pluginConfig, saveConfig
 */

const { createSignal, onMount, For, Show, createMemo } = window.Solid || Solid;

// Helper to create elements with classes
function el(tag, className, children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (children) {
    if (Array.isArray(children)) {
      children.forEach(child => {
        if (typeof child === 'string') {
          element.appendChild(document.createTextNode(child));
        } else if (child) {
          element.appendChild(child);
        }
      });
    } else if (typeof children === 'string') {
      element.textContent = children;
    } else if (children) {
      element.appendChild(children);
    }
  }
  return element;
}

export default function DiscordPluginUI(props) {
  const [token, setToken] = createSignal("");
  const [mappings, setMappings] = createSignal([]);
  const [pendingRequests, setPendingRequests] = createSignal([]);
  const [newChannelId, setNewChannelId] = createSignal("");
  const [newSession, setNewSession] = createSignal("");
  const [status, setStatus] = createSignal("disconnected");

  // Load config on mount
  onMount(async () => {
    const config = await props.api.getConfig();
    const discordConfig = config.plugins?.data?.discord || {};
    
    if (discordConfig.token) {
      setToken(discordConfig.token);
      setStatus("configured");
    }
    
    setMappings(Object.entries(discordConfig.mappings || {}));
    setPendingRequests(
      Object.entries(discordConfig.pairingRequests || {})
        .filter(([_, req]) => req.status === "pending")
    );
  });

  const handleSaveToken = async () => {
    await props.saveConfig({
      token: token(),
    });
    setStatus("configured");
  };

  // Create container
  const container = el("div", "discord-plugin-ui");
  
  // Header
  const header = el("div", "flex items-center justify-between mb-4");
  const title = el("h3", "text-lg font-semibold", "Discord Integration");
  const statusBadge = el("span", "px-2 py-1 rounded text-xs");
  
  // Status styling
  const updateStatus = () => {
    const s = status();
    if (s === "connected") {
      statusBadge.className = "px-2 py-1 rounded text-xs bg-green-500/20 text-green-400";
    } else if (s === "configured") {
      statusBadge.className = "px-2 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400";
    } else {
      statusBadge.className = "px-2 py-1 rounded text-xs bg-red-500/20 text-red-400";
    }
    statusBadge.textContent = s;
  };
  
  // Reactive status update
  createMemo(() => {
    updateStatus();
    return status();
  });
  
  header.appendChild(title);
  header.appendChild(statusBadge);
  container.appendChild(header);
  
  // Token configuration section
  const tokenSection = el("div", "mb-4 p-3 bg-wopr-panel rounded border border-wopr-border");
  const tokenLabel = el("label", "block text-sm text-wopr-muted mb-2", "Discord Bot Token");
  const tokenRow = el("div", "flex gap-2");
  const tokenInput = el("input", "flex-1 bg-wopr-bg border border-wopr-border rounded px-3 py-2 text-sm");
  tokenInput.type = "password";
  tokenInput.placeholder = "Enter bot token...";
  tokenInput.addEventListener("input", (e) => setToken(e.target.value));
  
  const saveBtn = el("button", "px-4 py-2 bg-wopr-accent text-wopr-bg rounded text-sm font-medium hover:bg-wopr-accent/90", "Save");
  saveBtn.addEventListener("click", handleSaveToken);
  
  tokenRow.appendChild(tokenInput);
  tokenRow.appendChild(saveBtn);
  tokenSection.appendChild(tokenLabel);
  tokenSection.appendChild(tokenRow);
  container.appendChild(tokenSection);
  
  // Pending requests section (conditional)
  const requestsSection = el("div");
  
  // Mappings section
  const mappingsSection = el("div");
  const mappingsTitle = el("h4", "text-sm font-semibold text-wopr-muted uppercase mb-2");
  mappingsSection.appendChild(mappingsTitle);
  
  // Reactive mappings list
  const renderMappings = () => {
    mappingsTitle.textContent = `Channel Mappings (${mappings().length})`;
    
    // Clear previous
    while (mappingsSection.children.length > 1) {
      mappingsSection.removeChild(mappingsSection.lastChild);
    }
    
    const list = el("div", "space-y-2");
    
    mappings().forEach(([channelId, mapping]) => {
      const item = el("div", "p-3 bg-wopr-panel rounded border border-wopr-border flex items-center justify-between");
      const info = el("div");
      const sessionName = el("div", "font-medium", mapping.session);
      const channelInfo = el("div", "text-sm text-wopr-muted", `Channel: ${channelId}`);
      info.appendChild(sessionName);
      info.appendChild(channelInfo);
      
      const unmapBtn = el("button", "px-3 py-1 bg-red-500/20 text-red-400 rounded text-sm hover:bg-red-500/30", "Unmap");
      unmapBtn.addEventListener("click", () => {
        // Call unmap API
        fetch(`/api/discord/unmap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelId }),
        });
      });
      
      item.appendChild(info);
      item.appendChild(unmapBtn);
      list.appendChild(item);
    });
    
    mappingsSection.appendChild(list);
    
    // Add mapping form
    const formSection = el("div", "mt-3 p-3 bg-wopr-panel rounded border border-wopr-border");
    const formRow = el("div", "flex gap-2");
    
    const channelInput = el("input", "flex-1 bg-wopr-bg border border-wopr-border rounded px-3 py-2 text-sm");
    channelInput.placeholder = "Channel ID";
    channelInput.addEventListener("input", (e) => setNewChannelId(e.target.value));
    
    const sessionInput = el("input", "flex-1 bg-wopr-bg border border-wopr-border rounded px-3 py-2 text-sm");
    sessionInput.placeholder = "Session name";
    sessionInput.addEventListener("input", (e) => setNewSession(e.target.value));
    
    const mapBtn = el("button", "px-4 py-2 bg-wopr-accent text-wopr-bg rounded text-sm font-medium hover:bg-wopr-accent/90", "Map");
    mapBtn.addEventListener("click", () => {
      if (newChannelId() && newSession()) {
        fetch(`/api/discord/map`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelId: newChannelId(), session: newSession() }),
        });
        setNewChannelId("");
        setNewSession("");
        channelInput.value = "";
        sessionInput.value = "";
      }
    });
    
    formRow.appendChild(channelInput);
    formRow.appendChild(sessionInput);
    formRow.appendChild(mapBtn);
    formSection.appendChild(formRow);
    mappingsSection.appendChild(formSection);
  };
  
  // Initial render and reactive updates
  createMemo(() => {
    renderMappings();
    return mappings().length;
  });
  
  container.appendChild(mappingsSection);
  
  return container;
}
