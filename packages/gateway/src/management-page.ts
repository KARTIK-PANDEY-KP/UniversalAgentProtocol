/**
 * The management page, as one self-contained document.
 *
 * Inlined rather than served from a directory of assets because the gateway
 * has no bundler and should not grow one for this: `tsc -b` is the whole build,
 * and a page that is a string survives packaging, containers and `npx` without
 * anything having to remember to copy a folder.
 *
 * Two properties are load-bearing and are asserted in the conformance suite:
 *
 * The page holds no credential. It is served to anyone who asks, because there
 * is nothing in it to protect; the API key is typed into the browser, kept in
 * session storage, and sent as a header by script. Nothing authenticates by
 * cookie, so there is no cross-site request forgery to defend against.
 *
 * The page never builds HTML from data. Aliases, display names and error
 * messages all originate from upstream servers, which are exactly the parties
 * a credential broker should not trust with markup. Everything reaches the
 * document through `textContent`, and the policy below refuses inline script
 * that lacks the nonce, so an injected `<script>` would not run even if one
 * arrived.
 */
export interface ManagementPageOptions {
  /** Public origin, used for the MCP endpoint shown in the setup snippet. */
  baseUrl: string;
  nonce: string;
}

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function managementPage(options: ManagementPageOptions): string {
  const { baseUrl, nonce } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Universal Agent Protocol</title>
<style nonce="${nonce}">
:root {
  color-scheme: light dark;
  --bg: #fbfbfd; --panel: #fff; --line: #e3e3e8; --text: #16161a;
  --muted: #6b6b76; --accent: #3257d0; --ok: #17794a; --warn: #9a5b00;
  --bad: #b3261e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131317; --panel: #1b1b21; --line: #2c2c34; --text: #f2f2f5;
    --muted: #a0a0ad; --accent: #7d9bff; --ok: #4ac98a; --warn: #e0a147;
    --bad: #ff8a80;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text); line-height: 1.5;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 5rem; }
header { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; }
h1 { font-size: 1.35rem; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 1rem; margin: 2.25rem 0 .75rem; }
.sub { color: var(--muted); font-size: .875rem; }
.spacer { flex: 1 1 auto; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
.row {
  display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;
  padding: .875rem 1rem; border-top: 1px solid var(--line);
}
.row:first-child { border-top: none; }
.grow { flex: 1 1 16rem; min-width: 0; }
.name { font-weight: 600; }
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem;
  color: var(--muted); overflow-wrap: anywhere;
}
.pill {
  font-size: .75rem; font-weight: 600; padding: .125rem .5rem; border-radius: 999px;
  border: 1px solid currentColor; white-space: nowrap;
}
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
button {
  font: inherit; font-size: .8125rem; padding: .375rem .75rem; border-radius: 7px;
  border: 1px solid var(--line); background: transparent; color: var(--text);
  cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover:not(:disabled) { color: #fff; opacity: .9; }
button.danger:hover:not(:disabled) { border-color: var(--bad); color: var(--bad); }
input[type=text], input[type=password] {
  font: inherit; font-size: .875rem; padding: .4375rem .625rem; border-radius: 7px;
  border: 1px solid var(--line); background: var(--bg); color: var(--text);
  min-width: 0;
}
input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
form.inline { display: flex; gap: .5rem; flex-wrap: wrap; padding: .875rem 1rem; }
pre {
  margin: 0; padding: 1rem; overflow-x: auto; font-size: .8125rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.note { color: var(--muted); font-size: .8125rem; margin: .5rem 0 0; }
.error { color: var(--bad); font-size: .8125rem; }
.empty { padding: 1.25rem 1rem; color: var(--muted); font-size: .875rem; }
.tools { display: none; padding: 0 1rem 1rem; }
.tools.open { display: block; }
.tool { display: flex; gap: .625rem; align-items: center; padding: .25rem 0; font-size: .8125rem; }
.tool .mono { flex: 1 1 auto; color: var(--text); }
#banner { padding: .75rem 1rem; border-radius: 8px; margin-bottom: 1rem; display: none; }
#banner.show { display: block; }
#banner.bad { background: color-mix(in srgb, var(--bad) 12%, transparent); color: var(--bad); }
#banner.ok { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Universal Agent Protocol</h1>
    <span class="sub mono">${escapeHtml(baseUrl)}</span>
    <span class="spacer"></span>
    <button id="sign-out" hidden>Sign out</button>
  </header>

  <div id="banner"></div>

  <section id="signin" hidden>
    <div class="row"><div class="grow">
      <div class="name">Gateway API key</div>
      <div class="sub">Kept in this tab only, and sent as a bearer header. Never stored on the server.</div>
    </div></div>
    <form class="inline" id="signin-form">
      <input class="grow" type="password" id="key" placeholder="uap_..." autocomplete="off" required>
      <button class="primary" type="submit">Continue</button>
    </form>
  </section>

  <div id="app" hidden>
    <h2>Connections</h2>
    <section>
      <div id="connections"><div class="empty">Loading…</div></div>
      <form class="inline" id="add-form">
        <input class="grow" type="text" id="mcp-url" placeholder="https://mcp.example.com/mcp" required>
        <input type="text" id="alias" placeholder="alias (optional)">
        <button class="primary" type="submit">Add</button>
      </form>
    </section>

    <h2>Connect a client</h2>
    <section>
      <pre id="snippet"></pre>
    </section>
    <p class="note">Same JSON for Cursor, Claude Code and VS Code. Claude Desktop needs the key written literally.</p>
  </div>
</main>

<script nonce="${nonce}">
(() => {
  "use strict";
  const KEY = "uap.key";
  const el = (id) => document.getElementById(id);
  const key = () => sessionStorage.getItem(KEY);

  function say(message, kind) {
    const banner = el("banner");
    banner.textContent = message;
    banner.className = message ? "show " + kind : "";
  }

  async function api(path, init) {
    const options = init || {};
    const headers = Object.assign({ authorization: "Bearer " + key() }, options.headers);
    if (options.body) headers["content-type"] = "application/json";
    const response = await fetch(path, Object.assign({}, options, { headers }));
    if (response.status === 401) {
      sessionStorage.removeItem(KEY);
      void render();
      throw new Error("That key was rejected.");
    }
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = await response.json();
        detail = body.error_description || body.message || body.error || detail;
      } catch (_) { /* a non-JSON error body is still an error */ }
      throw new Error(detail);
    }
    return response.status === 204 ? null : response.json();
  }

  // Everything below builds nodes and sets textContent. Aliases, display names
  // and upstream error messages are not ours and are never treated as markup.
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  /**
   * The browser cannot open /connect/:id, which wants a bearer header no
   * address bar will send. Asking for the provider's URL and following it is
   * the same flow with the credential in the one place a browser can put it.
   */
  async function startAuthorization(connectionId) {
    const result = await api(
      "/api/v1/connections/" + encodeURIComponent(connectionId) + "/authorize",
      { method: "POST", body: JSON.stringify({ return_to: location.origin + "/ui" }) },
    );
    location.href = result.authorization_url;
  }

  const STATUS = {
    CONNECTED: "ok",
    CONNECTED_NON_REFRESHABLE: "ok",
    AUTHORIZATION_REQUIRED: "warn",
    REAUTH_REQUIRED: "warn",
    DEGRADED: "bad",
    FAILED: "bad",
    REVOKED: "bad",
  };

  function connectionRow(connection, tools, onChange) {
    const row = node("div", "row");
    const main = node("div", "grow");
    main.append(node("div", "name", connection.alias || connection.display_name));
    main.append(node("div", "mono", connection.mcp_url));
    if (connection.last_error) main.append(node("div", "error", connection.last_error));
    row.append(main);

    row.append(node("span", "pill " + (STATUS[connection.status] || "warn"), connection.status));

    const mine = tools.filter((tool) => tool.connection_id === connection.connection_id);
    const list = node("div", "tools");

    if (mine.length > 0) {
      const toggle = node("button", null, mine.length + (mine.length === 1 ? " tool" : " tools"));
      toggle.addEventListener("click", () => list.classList.toggle("open"));
      row.append(toggle);
    }

    const needsAuth =
      connection.status === "AUTHORIZATION_REQUIRED" || connection.status === "REAUTH_REQUIRED";
    if (needsAuth) {
      const authorize = node("button", "primary", "Authorize");
      authorize.addEventListener("click", () => {
        authorize.disabled = true;
        startAuthorization(connection.connection_id).catch((error) => {
          authorize.disabled = false;
          say(error.message, "bad");
        });
      });
      row.append(authorize);
    } else {
      const resync = node("button", null, "Resync");
      resync.addEventListener("click", async () => {
        resync.disabled = true;
        try {
          const result = await api(
            "/api/v1/connections/" + encodeURIComponent(connection.connection_id) + "/refresh",
            { method: "POST" },
          );
          say(
            "Resynced " + connection.alias + ": " +
              result.added.length + " added, " + result.changed.length + " changed, " +
              result.removed.length + " removed.",
            "ok",
          );
          onChange();
        } catch (error) {
          say(error.message, "bad");
          resync.disabled = false;
        }
      });
      row.append(resync);
    }

    const remove = node("button", "danger", "Remove");
    remove.addEventListener("click", async () => {
      if (!confirm("Remove " + (connection.alias || connection.mcp_url) + "?")) return;
      remove.disabled = true;
      try {
        await api("/api/v1/connections/" + encodeURIComponent(connection.connection_id), {
          method: "DELETE",
        });
        onChange();
      } catch (error) {
        say(error.message, "bad");
        remove.disabled = false;
      }
    });
    row.append(remove);

    for (const tool of mine) {
      const entry = node("div", "tool");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = tool.enabled;
      box.addEventListener("change", async () => {
        box.disabled = true;
        try {
          await api("/api/v1/tools/" + encodeURIComponent(tool.id), {
            method: "POST",
            body: JSON.stringify({ enabled: box.checked }),
          });
        } catch (error) {
          box.checked = !box.checked;
          say(error.message, "bad");
        }
        box.disabled = false;
      });
      entry.append(box, node("span", "mono", tool.name), node("span", "sub", tool.risk_level));
      list.append(entry);
    }

    const wrapper = document.createElement("div");
    wrapper.append(row, list);
    return wrapper;
  }

  /**
   * The callback sends the browser here with ?authorize=<id> when the gateway
   * had to replace the client mid-flow: the code it was holding belonged to
   * the old one and cannot be exchanged, so the only way to finish is to go
   * round again. Doing it without a second click keeps that a detail of the
   * protocol rather than a thing the user has to understand.
   */
  async function resumeFromQuery() {
    const params = new URLSearchParams(location.search);
    const connectionId = params.get("authorize");
    if (!connectionId) return false;
    // Cleared first, so a failure does not leave a URL that retries forever.
    history.replaceState(null, "", location.pathname);
    say("Finishing authorization with a new client…", "ok");
    try {
      await startAuthorization(connectionId);
      return true;
    } catch (error) {
      say(error.message, "bad");
      return false;
    }
  }

  async function load() {
    const target = el("connections");
    try {
      const [connections, tools] = await Promise.all([
        api("/api/v1/connections"),
        api("/api/v1/tools"),
      ]);
      target.replaceChildren();
      if (connections.connections.length === 0) {
        target.append(node("div", "empty", "No connections yet. Add an MCP server below."));
        return;
      }
      for (const connection of connections.connections) {
        target.append(connectionRow(connection, tools.tools, load));
      }
    } catch (error) {
      target.replaceChildren(node("div", "empty", error.message));
    }
  }

  async function render() {
    const signedIn = Boolean(key());
    el("signin").hidden = signedIn;
    el("app").hidden = !signedIn;
    el("sign-out").hidden = !signedIn;
    if (signedIn) {
      // A navigation away ends this render; nothing below needs to run.
      if (await resumeFromQuery()) return;
      el("snippet").textContent = JSON.stringify(
        {
          mcpServers: {
            gateway: {
              url: ${JSON.stringify(`${baseUrl}/mcp`)},
              headers: { Authorization: "Bearer " + key() },
            },
          },
        },
        null,
        2,
      );
      load();
    }
  }

  el("signin-form").addEventListener("submit", (event) => {
    event.preventDefault();
    sessionStorage.setItem(KEY, el("key").value.trim());
    el("key").value = "";
    say("", "");
    void render();
  });

  el("sign-out").addEventListener("click", () => {
    sessionStorage.removeItem(KEY);
    void render();
  });

  el("add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = el("mcp-url").value.trim();
    const alias = el("alias").value.trim();
    const button = event.target.querySelector("button");
    button.disabled = true;
    say("Connecting…", "ok");
    try {
      const created = await api("/api/v1/connections", {
        method: "POST",
        body: JSON.stringify(Object.assign({ mcp_url: url }, alias ? { alias: alias } : {})),
      });
      el("mcp-url").value = "";
      el("alias").value = "";
      say(
        created.status === "CONNECTED"
          ? "Connected " + created.alias + " with " + created.tool_count + " tools."
          : "Added " + created.alias + ". It needs authorizing.",
        "ok",
      );
      load();
    } catch (error) {
      say(error.message, "bad");
    }
    button.disabled = false;
  });

  void render();
})();
</script>
</body>
</html>
`;
}

/** The base URL is configuration rather than input, but it is still printed. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
