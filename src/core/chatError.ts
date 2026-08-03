/**
 * An error whose `message` is safe to show directly in chat.
 *
 * Service and plugin code throws these for user-facing problems (bad input, an
 * unknown target, a duplicate name, …). The CommandRouter catches a `ChatError`
 * thrown from a command handler and says its `message` in chat — instead of the
 * generic "something went wrong" — so plugins don't each need a try/catch that
 * turns their domain error into a reply.
 *
 * Errors that are NOT user-facing (bugs, unexpected failures) should be plain
 * `Error`s, so the router logs them and shows the generic message instead.
 */
export class ChatError extends Error {}
