/**
 * Discord Plugin UI Component for WOPR
 * 
 * This is a SolidJS component that renders inside the main WOPR UI.
 * Build this file to a JS module and serve it via HTTP.
 */

// Plugin UI component - receives api and config via props
export default function DiscordPluginUI(props) {
  const [token, setToken] = createSignal("");
  const [mappings, setMappings] = createSignal([]);
  const [pendingRequests, setPendingRequests] = createSignal([]);
  const [status, setStatus] = createSignal("disconnected");

  // Load config on mount
  onMount(async () => {
    const config = await props.api.getConfig();
    // Plugin config is under plugins.data.discord
    const discordConfig = config.plugins?.data?.discord || {};
    setMappings(Object.entries(discordConfig.mappings || {}));
    setPendingRequests(
      Object.entries(discordConfig.pairingRequests || {})
        .filter(([_, req]) => req.status === "pending")
    );
  });

  const handleSaveToken = async () => {
    const config = await props.api.getConfig();
    config.plugins = config.plugins || {};
    config.plugins.data = config.plugins.data || {};
    config.plugins.data.discord = config.plugins.data.discord || {};
    config.plugins.data.discord.token = token();
    await props.api.setConfigValue("plugins.data.discord", config.plugins.data.discord);
    setStatus("configured");
  };

  return (
    <div class="discord-plugin-ui">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold">Discord Integration</h3>
        <span class={`px-2 py-1 rounded text-xs ${
          status() === "connected" ? "bg-green-500/20 text-green-400" : 
          status() === "configured" ? "bg-yellow-500/20 text-yellow-400" :
          "bg-red-500/20 text-red-400"
        }`}>
          {status()}
        </span>
      </div>

      {/* Bot Token Configuration */}
      <div class="mb-4 p-3 bg-wopr-panel rounded border border-wopr-border">
        <label class="block text-sm text-wopr-muted mb-2">Discord Bot Token</label>
        <div class="flex gap-2">
          <input
            type="password"
            value={token()}
            onInput={(e) => setToken(e.target.value)}
            placeholder="Enter bot token..."
            class="flex-1 bg-wopr-bg border border-wopr-border rounded px-3 py-2 text-sm"
          />
          <button
            onClick={handleSaveToken}
            class="px-4 py-2 bg-wopr-accent text-wopr-bg rounded text-sm font-medium hover:bg-wopr-accent/90"
          >
            Save
          </button>
        </div>
      </div>

      {/* Pending Pairing Requests */}
      <Show when={pendingRequests().length > 0}>
        <div class="mb-4">
          <h4 class="text-sm font-semibold text-wopr-muted uppercase mb-2">
            Pending Pairing Requests ({pendingRequests().length})
          </h4>
          <div class="space-y-2">
            <For each={pendingRequests()}>
              {([code, req]) => (
                <div class="p-3 bg-wopr-panel rounded border border-wopr-border flex items-center justify-between">
                  <div>
                    <div class="font-medium">{req.userName}</div>
                    <div class="text-sm text-wopr-muted">
                      Code: {code} | Session: {req.session}
                    </div>
                  </div>
                  <div class="flex gap-2">
                    <button
                      onClick={() => /* approve */}
                      class="px-3 py-1 bg-green-500/20 text-green-400 rounded text-sm hover:bg-green-500/30"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => /* reject */}
                      class="px-3 py-1 bg-red-500/20 text-red-400 rounded text-sm hover:bg-red-500/30"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Channel Mappings */}
      <div>
        <h4 class="text-sm font-semibold text-wopr-muted uppercase mb-2">
          Channel Mappings ({mappings().length})
        </h4>
        <div class="space-y-2">
          <For each={mappings()}>
            {([channelId, mapping]) => (
              <div class="p-3 bg-wopr-panel rounded border border-wopr-border flex items-center justify-between">
                <div>
                  <div class="font-medium">{mapping.session}</div>
                  <div class="text-sm text-wopr-muted">Channel: {channelId}</div>
                </div>
                <button
                  onClick={() => /* unmap */}
                  class="px-3 py-1 bg-red-500/20 text-red-400 rounded text-sm hover:bg-red-500/30"
                >
                  Unmap
                </button>
              </div>
            )}
          </For>
        </div>
        
        {/* Add Mapping Form */}
        <div class="mt-3 p-3 bg-wopr-panel rounded border border-wopr-border">
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Channel ID"
              class="flex-1 bg-wopr-bg border border-wopr-border rounded px-3 py-2 text-sm"
            />
            <select class="bg-wopr-bg border border-wopr-border rounded px-3 py-2 text-sm">
              <option value="">Select session...</option>
              {/* Sessions would be populated from props */}
            </select>
            <button
              class="px-4 py-2 bg-wopr-accent text-wopr-bg rounded text-sm font-medium hover:bg-wopr-accent/90"
            >
              Map
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// SolidJS imports (assumed to be provided by host)
const { createSignal, onMount, For, Show } = window.Solid;
