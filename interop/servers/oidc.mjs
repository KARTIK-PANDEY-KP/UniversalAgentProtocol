// A real, certified OpenID Connect provider standing in for a production
// authorization server. Nothing here is written to suit the gateway: it is
// oidc-provider's own implementation of discovery, dynamic registration, PKCE,
// resource indicators, refresh and revocation.
import express from "express";
import Provider from "oidc-provider";

const PORT = Number(process.env.PORT ?? 8821);
// Kept separate from the listen port so the provider can sit behind a proxy
// without its issuer identity changing.
const ISSUER = process.env.ISSUER_URL ?? `http://127.0.0.1:${PORT}`;
const RESOURCE = process.env.RESOURCE ?? "http://127.0.0.1:8811/mcp";

const configuration = {
  // The resource server authenticates to the introspection endpoint as itself.
  clients: [
    {
      client_id: "resource-server",
      client_secret: "resource-server-secret",
      grant_types: [],
      response_types: [],
      redirect_uris: [],
      token_endpoint_auth_method: "client_secret_basic",
    },
  ],
  clientDefaults: {
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_basic",
  },
  scopes: ["openid", "offline_access"],
  features: {
    registration: { enabled: true },
    revocation: { enabled: true },
    introspection: { enabled: true },
    devInteractions: { enabled: false },
    resourceIndicators: {
      enabled: true,
      defaultResource: () => RESOURCE,
      useGrantedResource: () => true,
      // Honour whatever resource the client asked for, the way a real
      // multi-resource provider does, instead of pinning one audience.
      getResourceServerInfo: (_ctx, resourceIndicator) => ({
        scope: "mcp:read mcp:write",
        audience: resourceIndicator,
        accessTokenTTL: 30,
        accessTokenFormat: "opaque",
      }),
    },
  },
  pkce: { required: () => true },
  ttl: {
    AccessToken: 30,
    AuthorizationCode: 60,
    Grant: 3600,
    IdToken: 300,
    Interaction: 300,
    RefreshToken: 3600,
    Session: 3600,
  },
  findAccount: async (_ctx, id) => ({
    accountId: id,
    claims: async () => ({ sub: id }),
  }),
  // Refresh tokens for a plain OAuth client that never asks for offline_access.
  issueRefreshToken: async (_ctx, client) =>
    client.grantTypeAllowed("refresh_token"),
  rotateRefreshToken: true,
};

const provider = new Provider(ISSUER, configuration);
provider.proxy = true;

for (const event of ["grant.error", "server_error", "introspection.error", "registration_create.error"]) {
  provider.on(event, (...args) => {
    const error = args[args.length - 1];
    process.stdout.write(
      `EVENT ${event}: ${error?.message} | detail=${error?.error_detail ?? ""} | desc=${error?.error_description ?? ""}\n`,
    );
  });
}

const app = express();

// Every grant this provider has issued, so a test can revoke the way a user
// revokes: from the provider's side, without telling the client.
const grantIds = new Set();
app.post("/admin/revoke-all", async (_req, res) => {
  let destroyed = 0;
  for (const id of grantIds) {
    const grant = await provider.Grant.find(id);
    if (grant) {
      await grant.destroy();
      destroyed += 1;
    }
  }
  grantIds.clear();
  res.json({ destroyed });
});

// A consenting user, without a login form to drive. The gateway never sees
// this: from its side it is an ordinary redirect to the provider and back.
app.get("/interaction/:uid", async (req, res, next) => {
  try {
    const details = await provider.interactionDetails(req, res);
    const { prompt, params, uid } = details;
    const accountId = "user-real-oauth";

    if (prompt.name === "login") {
      await provider.interactionFinished(
        req,
        res,
        { login: { accountId } },
        { mergeWithLastSubmission: false },
      );
      return;
    }

    let grant = details.grantId
      ? await provider.Grant.find(details.grantId)
      : new provider.Grant({ accountId, clientId: params.client_id });

    if (prompt.details.missingOIDCScope) {
      grant.addOIDCScope(prompt.details.missingOIDCScope.join(" "));
    }
    if (prompt.details.missingResourceScopes) {
      for (const [indicator, scopes] of Object.entries(
        prompt.details.missingResourceScopes,
      )) {
        grant.addResourceScope(indicator, scopes.join(" "));
      }
    }
    if (params.scope) grant.addOIDCScope(params.scope);
    grant.addResourceScope(RESOURCE, "mcp:read mcp:write");

    const grantId = await grant.save();
    grantIds.add(grantId);
    await provider.interactionFinished(
      req,
      res,
      { consent: { grantId } },
      { mergeWithLastSubmission: true },
    );
    void uid;
  } catch (error) {
    next(error);
  }
});

app.use(provider.callback());

app.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`oidc-provider issuer ${ISSUER}\n`);
});
