import type { AppConfig } from '../../services/config.js';
import type { SessionUser } from './types.js';

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const USERS_URL = 'https://api.twitch.tv/helix/users';

/**
 * "Login with Twitch" via the OAuth Authorization Code flow.
 *
 * We only need to confirm *who* the visitor is, so we request no scopes — an
 * unscoped user token can still read its own /users record (id, login, display
 * name, avatar). We never store the visitor's token: it's exchanged, used once
 * to fetch identity, then discarded. Their relationship to the channel is
 * computed separately using the broadcaster's token (see channelRelationship).
 */
export function buildAuthorizeUrl(config: AppConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: config.web.oauthRedirectUri,
    response_type: 'code',
    scope: '', // identity only
    state,
    force_verify: 'false',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange an authorization code for the visitor's user access token. */
export async function exchangeCodeForToken(config: AppConfig, code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.web.oauthRedirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Twitch token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('Twitch token exchange returned no access_token');
  return json.access_token;
}

/** Fetch the authenticated visitor's own Twitch identity using their token. */
export async function fetchAuthedUser(config: AppConfig, accessToken: string): Promise<SessionUser> {
  const res = await fetch(USERS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': config.twitch.clientId,
    },
  });
  if (!res.ok) {
    throw new Error(`Twitch /users failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data?: { id: string; login: string; display_name: string; profile_image_url: string }[];
  };
  const u = json.data?.[0];
  if (!u) throw new Error('Twitch /users returned no user');
  return { id: u.id, login: u.login, displayName: u.display_name, avatar: u.profile_image_url };
}
