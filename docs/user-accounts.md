# User accounts and name resolution

How BasecaBot decides *who* someone means when they type a name.

Two rules drive everything:

1. **Under the hood, people are Twitch user ids.** Ids never change, even when
   someone renames their account. Anything that records a person — points,
   quotes, list entries, event logs — stores the id.
2. **On the way out, people are display names.** Never a login, never the string
   that was originally typed. Rename yourself and every past quote updates.

Between those two sits the name index, which turns typed text into an id.

---

## The name index

Every name a user can be referenced by lives in **one globally-unique table**,
`UserName`. Each row has a `normalized` form (lowercased, `@` stripped) that is
unique **across all users and all kinds of name**:

| kind | how many | where it comes from |
| --- | --- | --- |
| `login` | exactly one per user | the Twitch account name, synced on every sighting |
| `display` | at most one per user | a **custom** display name the user set themselves |
| `alias` | any number | nicknames the user adds |

Because `normalized` is unique across the whole table, **a typed name resolves to
at most one person.** That single database constraint is what prevents the entire
class of impersonation and ambiguity problems — no display name or alias can be
made to stand in for someone else's Twitch account, because the name is simply
already taken.

### Why display names usually have no row

A Twitch display name is normally just the login with different capitalization
(`baseca` → `Baseca`). Those normalize to the same string as the login, so they
need no second row — the login row already covers them.

A `display` row is created only when a user sets a **custom** display name that
differs from their login. (A rare exception: some Twitch accounts have a
localized display name that genuinely differs from the login. Those aren't
indexed, so the person is still reachable by login or alias, just not by that
localized name.)

### Precedence: real accounts always win

When two claims collide, `login` > `display` > `alias`:

- **User-chosen names are rejected on conflict.** Adding an alias or setting a
  display name that anyone else already holds fails with a clear error. Nothing
  is silently overwritten.
- **Logins evict.** If someone aliases themselves `newstreamer` and an account
  named `newstreamer` later shows up in chat, the real account takes the name and
  the squatter's alias row is dropped. A Twitch account can always be referred to
  by its own name.
- **Renames free the old name.** When a user renames on Twitch, their old `login`
  row is removed, so the name is available for whoever takes it next.

---

## Resolving a typed name

`UsersService.resolveUserRef(input)` is the single entry point. It returns one of
four results, and callers branch on them:

| result | meaning |
| --- | --- |
| `user` | matched a person — use `id`, display `displayName` |
| `unlinked` | a bare name that matched nobody; valid free text |
| `unknown-handle` | written as `@name`, but no such Twitch account exists |
| `empty` | nothing was typed |

### Bare name vs. `@handle`

These mean different things on purpose:

- **`name`** (no `@`) may be *any* indexed name — login, custom display name, or
  alias — and is case-insensitive. If it matches nobody it comes back `unlinked`
  rather than failing, because names are legitimately used for people who aren't
  Twitch users at all: a guest on the couch, a caller, "chat".
- **`@name`** asserts a real Twitch account, so only a `login` matches. If the bot
  has never seen that account it is **looked up on Twitch and recorded on the
  spot** — otherwise `@someone` would fail for anyone who has never chatted. Only
  a genuinely nonexistent account returns `unknown-handle`.

So `@ace` will *not* resolve to a user whose alias is "ace": the `@` says "this is
a Twitch handle," and it is treated as one.

---

## What this looks like in commands

Any command taking a username accepts any variant — `!points give`,
`!points grant`, `!quote add`, `!quote edituser`, `!quote searchuser`, and
`$(user …)` in custom command variables all go through the same resolver.

```
!quote add @baseca      Just a bit tired.     → linked, if the account exists
!quote add Baseca       Just a bit tired.     → linked, matched by display name
!quote add BigB         Just a bit tired.     → linked, matched by alias
!quote add a caller     Just a bit tired.     → unlinked; the name is kept as text
!quote add @nosuchuser  Just a bit tired.     → rejected: no such Twitch account
```

All four accepted forms produce the same output — the person's current display
name, with no `@`:

```
Quote 12: "Just a bit tired." - Baseca [Just Chatting] [2026/07/18]
```

The `@` is dropped deliberately: what's shown is a display name, which often
differs from the login, so `@Baseca` would imply a handle that may not exist.

---

## Quotes specifically

`Quote` carries both halves of the attribution:

- `quotedUserId` — the person's Twitch id when the name resolved. This is what
  display reads from, so the name shown is always current.
- `quotedUser` — the name as entered. For a linked quote it's a fallback (used if
  that user row is ever deleted); for an unlinked quote it's the only record.

`!quote searchuser` matches linked quotes **by id**, so it finds a person's quotes
under any of their names and across renames, and *also* matches the stored
snapshot so unlinked quotes (guests, imported rows) are still findable.

CSV export/import carries `User ID` alongside `User`, so a backup restores the
links intact. An id that doesn't exist at import time is dropped to null rather
than failing the import — the quote survives as an unlinked snapshot.

---

## Managing your own names

From the dashboard's user page:

- **Display name** — setting a custom one locks it, and the bot stops syncing it
  from Twitch. It's indexed unless it's just your login recapitalized. Setting a
  display name that is currently one of your own aliases converts that alias row
  into your display row (the name stays yours either way).
- **Aliases** — add or remove freely; a name already claimed by anyone is refused.

Names are capped at 40 characters.

---

## Adding a new command that takes a username

Use the resolver, and decide what an unmatched name should mean:

```ts
const ref = await ctx.users.resolveUserRef(typedName);
if (ref.kind !== 'user') {
  await ctx.chat.say(e.channel, `I don't know a user called ${typedName}.`);
  return;
}
// ref.id for storage, ref.displayName for output
```

Commands that act *on an account* (points, moderation) should require
`kind === 'user'`. Commands that merely *record a name* (quotes) can accept
`unlinked` and store the text, while still rejecting `unknown-handle`.

Don't reach for `getByLogin` — it matches logins only, and will miss people
referred to by their display name or an alias.
