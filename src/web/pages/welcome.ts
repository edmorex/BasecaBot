import { renderLayout } from '../layout.js';

/**
 * Landing page (served at `/` to everyone). Logged-out visitors get a welcome,
 * a Twitch-purple "Login with Twitch" button, and a plain-language explainer of
 * how Twitch's OAuth is used and exactly what access the bot is granted. Logged-in
 * visitors get the same welcome but the CTA becomes "Go to your profile" and the
 * OAuth explainer is hidden.
 */
export function welcomePage(): string {
  const body = /* html */ `
    <div class="card" style="text-align:center">
      <h1>Welcome to BasecaBot</h1>
      <p class="muted">Browse the channel's tools above. Sign in with Twitch to access your 
      profile and additional features. No account required just to look around.</p>
      <div id="welcome-cta" style="margin-top:1.5rem">
        <a class="btn" href="/auth/login">Login with Twitch</a>
      </div>
    </div>

    <div class="card" id="welcome-oauth">
      <h2 style="margin-top:0">Signing in with Twitch — is it safe?</h2>
      <p>BasecaBot signs you in with <strong>Twitch's OAuth 2.0</strong> — the same
      “Login with Twitch” system used across the web. You enter your credentials on
      <strong>Twitch's own site</strong>; BasecaBot never sees or stores your password. Twitch
      manages the entire exchange, and you can revoke access at any time.</p>

      <p>When you authorize BasecaBot it requests <strong>read-only access to your basic public
      identity and nothing else</strong> (no OAuth scopes). Specifically:</p>
      <ul style="line-height:1.7; margin:0.5rem 0">
        <li><span class="yes">✓</span> Your public Twitch <strong>username, display name, and profile picture</strong> (the same info shown on your channel page).</li>
        <li><span class="no">✗</span> <strong>No</strong> email address, follow/subscription lists, chat history, or payment info.</li>
        <li><span class="no">✗</span> <strong>Cannot</strong> post messages, send whispers, follow/subscribe, or change any setting on your account.</li>
      </ul>
      <p class="muted" style="margin-top:0.75rem">Whether you follow, subscribe, or moderate this
      channel is determined from the <em>channel's</em> side, not by any access to your account.</p>

      <p style="margin-top:1rem">Want the details? See Twitch's
      <a href="https://dev.twitch.tv/docs/authentication/" target="_blank" rel="noopener">authentication documentation</a>
      and the <a href="https://oauth.net/2/" target="_blank" rel="noopener">OAuth&nbsp;2.0 standard</a>.
      You can review or revoke connected apps anytime in your
      <a href="https://www.twitch.tv/settings/connections" target="_blank" rel="noopener">Twitch Connections settings</a>.</p>

      <p style="margin-top:1rem">Don't just take our word for it — BasecaBot is <strong>open source</strong>.
      You can read exactly what it does at
      <a href="https://github.com/edmorex/BasecaBot" target="_blank" rel="noopener">github.com/edmorex/BasecaBot</a>.</p>
    </div>`;

  const script = `
    window.onMe=function(me){
      if(!me) return;
      var cta=document.getElementById('welcome-cta');
      if(cta) cta.innerHTML='<a class="btn pink" href="/user">Go to your profile</a>';
      var ox=document.getElementById('welcome-oauth');
      if(ox) ox.style.display='none';
    };`;

  return renderLayout({ title: 'BasecaBot', active: '', body, script });
}
