export interface AuthorizationOutcome {
  status: number;
  /** Final URL the browser landed on, usually the gateway callback. */
  finalUrl: string;
  body: string;
  /** Every URL visited, so a test can assert on the redirect chain. */
  trail: string[];
}

export interface BrowserOptions {
  maxRedirects?: number;
  /** Sent on the gateway callback so it can bind the flow to a signed-in user. */
  gatewayApiKey?: string;
  gatewayBaseUrl?: string;
}

/**
 * Stands in for the user's browser during an upstream authorization. It
 * follows the redirect chain from the authorization endpoint through to the
 * gateway callback, which is exactly what a real user does after approving
 * the consent screen.
 */
export async function completeAuthorization(
  authorizationUrl: string,
  options: BrowserOptions = {},
): Promise<AuthorizationOutcome> {
  const maxRedirects = options.maxRedirects ?? 5;
  const trail: string[] = [];
  let current = authorizationUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    trail.push(current);
    const isGatewayCallback =
      options.gatewayBaseUrl !== undefined && current.startsWith(options.gatewayBaseUrl);
    const headers: Record<string, string> = {};
    if (isGatewayCallback && options.gatewayApiKey) {
      headers["authorization"] = `Bearer ${options.gatewayApiKey}`;
    }
    const response = await fetch(current, { redirect: "manual", headers });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return {
      status: response.status,
      finalUrl: current,
      body: await response.text(),
      trail,
    };
  }
  throw new Error(`The authorization flow exceeded ${maxRedirects} redirects`);
}
