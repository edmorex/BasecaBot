/**
 * The bot.edmorex.com landing page. Self-contained HTML (inline CSS/JS) served
 * by the bot's HTTP server. On load it calls GET /api/me: if unauthenticated it
 * shows "Login with Twitch"; if authenticated it shows the visitor's identity
 * and a permission grid (their relationship to the channel).
 *
 * Future tools/dashboards can be added as new routes/pages and gated on the same
 * relationship fields returned by /api/me.
 */
export const dashboardHtml = /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BasecaBot</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; background: #0e0e10; color: #efeff1;
             display: grid; place-items: center; }
      main { width: min(30rem, 92vw); padding: 2rem; }
      .card { background: #18181b; border: 1px solid #2a2a2d; border-radius: 12px; padding: 1.75rem; }
      h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
      .muted { color: #adadb8; font-size: 0.9rem; }
      .center { text-align: center; }
      .btn { display: inline-flex; align-items: center; gap: 0.5rem; background: #9147ff; color: #fff;
             border: none; border-radius: 8px; padding: 0.7rem 1.1rem; font-size: 1rem; text-decoration: none; cursor: pointer; }
      .btn:hover { background: #772ce8; }
      .profile { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
      .profile img { width: 72px; height: 72px; border-radius: 50%; border: 2px solid #9147ff; }
      .grid { display: grid; gap: 0.5rem; }
      .row { display: flex; justify-content: space-between; align-items: center;
             padding: 0.6rem 0.85rem; background: #0e0e10; border: 1px solid #2a2a2d; border-radius: 8px; }
      .badge { font-weight: 700; }
      .yes { color: #3fb950; }
      .no { color: #6e6e77; }
      .foot { margin-top: 1.5rem; display: flex; justify-content: space-between; align-items: center; }
      a.logout { color: #adadb8; font-size: 0.9rem; }
      .spinner { text-align: center; color: #adadb8; padding: 1rem; }
    </style>
  </head>
  <body>
    <main>
      <div class="card" id="card">
        <div class="spinner">Loading…</div>
      </div>
    </main>

    <script>
      const ROWS = [
        ['broadcaster', 'Broadcaster'],
        ['botAdmin', 'Bot Admin'],
        ['moderator', 'Moderator'],
        ['subscriber', 'Subscriber'],
        ['follower', 'Follower'],
      ];
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

      function renderLoggedOut() {
        return \`
          <div class="center">
            <h1>BasecaBot</h1>
            <p class="muted">Sign in with your Twitch account to see your dashboard.</p>
            <p style="margin-top:1.5rem"><a class="btn" href="/auth/login">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 2 2 6v14h5v2h3l2-2h4l4-4V2H4zm16 11-3 3h-4l-2 2v-2H6V4h14v9zM15 7h-2v5h2V7zm-5 0H8v5h2V7z"/></svg>
              Login with Twitch
            </a></p>
          </div>\`;
      }

      function renderLoggedIn(data) {
        const rows = ROWS.map(([key, label]) => {
          const on = !!data.relationship[key];
          return \`<div class="row"><span>\${label}</span><span class="badge \${on ? 'yes' : 'no'}">\${on ? '✓' : '✗'}</span></div>\`;
        }).join('');
        return \`
          <div class="profile">
            <img src="\${esc(data.user.avatar)}" alt="avatar" />
            <div>
              <h1>\${esc(data.user.displayName)}</h1>
              <div class="muted">@\${esc(data.user.login)}</div>
            </div>
          </div>
          <div class="grid">\${rows}</div>
          <div class="foot">
            <span class="muted">Your relationship to the channel</span>
            <a class="logout" href="/auth/logout">Log out</a>
          </div>\`;
      }

      async function init() {
        const card = document.getElementById('card');
        try {
          const res = await fetch('/api/me', { credentials: 'same-origin' });
          card.innerHTML = res.ok ? renderLoggedIn(await res.json()) : renderLoggedOut();
        } catch {
          card.innerHTML = renderLoggedOut();
        }
      }
      init();
    </script>
  </body>
</html>`;
