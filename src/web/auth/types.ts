/** The authenticated user's public Twitch identity. */
export interface SessionUser {
  id: string;
  login: string;
  displayName: string;
  /** profile_image_url from Helix. */
  avatar: string;
}

/**
 * The user's relationship to the bot's channel — the basis for gating tools and
 * information in the dashboard. Computed at login from Helix + config.
 */
export interface ChannelRelationship {
  broadcaster: boolean;
  botAdmin: boolean;
  moderator: boolean;
  subscriber: boolean;
  follower: boolean;
}

/** What we persist in the (signed) session cookie. */
export interface SessionData {
  user: SessionUser;
  relationship: ChannelRelationship;
}
