import type { Storage } from './storage/index.js';
import type { EventUser } from '../core/events.js';

/**
 * User persistence: remembers everyone the bot sees and keeps their
 * display name and last-seen timestamp current.
 */
export class UsersService {
  constructor(private readonly storage: Storage) {}

  /** Get-or-create a user by Twitch id, refreshing display name & last-seen. */
  async touch(user: Pick<EventUser, 'id' | 'login' | 'displayName'>) {
    const now = new Date();
    return this.storage.prisma.user.upsert({
      where: { id: user.id },
      create: {
        id: user.id,
        login: user.login.toLowerCase(),
        displayName: user.displayName,
      },
      update: {
        login: user.login.toLowerCase(),
        displayName: user.displayName,
        lastSeenAt: now,
      },
    });
  }

  async getById(id: string) {
    return this.storage.prisma.user.findUnique({ where: { id } });
  }

  async getByLogin(login: string) {
    return this.storage.prisma.user.findUnique({ where: { login: login.toLowerCase() } });
  }
}
