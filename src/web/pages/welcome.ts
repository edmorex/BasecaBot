import { renderLayout } from '../layout.js';

/** Logged-out landing page: welcome + "Login with Twitch". */
export function welcomePage(): string {
  const body = /* html */ `
    <div class="card" style="text-align:center">
      <h1>Welcome to BasecaBot</h1>
      <p class="muted">Sign in with your Twitch account to see your profile, the channel's command
      list, and (coming soon) more tools and dashboards.</p>
      <p style="margin-top:1.5rem">
        <a class="btn" href="/auth/login">Login with Twitch</a>
      </p>
    </div>`;
  return renderLayout({ title: 'BasecaBot', active: '', body, hideNavUser: true });
}
