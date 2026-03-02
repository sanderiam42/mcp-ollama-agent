// src/XAAAuth.ts
// Implements two-step XAA OAuth token exchange (RFC 8693 + RFC 7523)

export interface XAAAuthParams {
  idpUrl: string;
  authServerUrl: string;
  audience: string;
  scopes: string[];
  idToken: string;
  // Step 1 client credentials (IDP client)
  clientId: string;
  clientSecret: string;
  // Step 2 client credentials (resource/auth server client)
  resourceClientId: string;
  resourceClientSecret: string;
}

/**
 * Step 1 — Token Exchange (RFC 8693):
 *   POST {idpUrl}/token with the user's ID token → get an ID-JAG JWT
 * Step 2 — JWT Bearer Grant (RFC 7523):
 *   POST {authServerUrl}/token with the ID-JAG → get the final Bearer token
 */
export async function getXAAAccessToken(config: XAAAuthParams): Promise<string> {
  // Step 1: exchange the user's ID token for an ID-JAG JWT
  const step1BasicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const idpResponse = await fetch(`${config.idpUrl}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${step1BasicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: config.idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:oauth-id-jag+jwt",
      audience: config.audience,
    }).toString(),
  });

  if (!idpResponse.ok) {
    const body = await idpResponse.text();
    throw new Error(
      `XAA step 1 failed (${idpResponse.status}): ${body}`
    );
  }

  const idpData = await idpResponse.json() as { access_token?: string };
  const idJag = idpData.access_token;
  if (!idJag) {
    throw new Error("XAA step 1: no access_token in IDP response");
  }

  // Step 2: exchange the ID-JAG for the final Bearer token
  const step2BasicAuth = Buffer.from(`${config.resourceClientId}:${config.resourceClientSecret}`).toString("base64");
  const authResponse = await fetch(`${config.authServerUrl}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${step2BasicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: idJag,
      scope: config.scopes.join(" "),
    }).toString(),
  });

  if (!authResponse.ok) {
    const body = await authResponse.text();
    throw new Error(
      `XAA step 2 failed (${authResponse.status}): ${body}`
    );
  }

  const authData = await authResponse.json() as { access_token?: string };
  const accessToken = authData.access_token;
  if (!accessToken) {
    throw new Error("XAA step 2: no access_token in auth server response");
  }

  return accessToken;
}

/**
 * Returns a fetch wrapper that injects a Bearer Authorization header
 * on every request.
 */
export function createAuthenticatedFetch(
  accessToken: string
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(input, { ...init, headers });
  };
}
