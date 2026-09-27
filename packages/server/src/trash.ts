import type { MeetingStore, MeetingTranscript } from "./meetings.js";
import type { ProjectStore, StoredProject } from "./projects.js";

/**
 * The trash (docs/26 A6): deleting a board, a meeting or a project moves it
 * here for 30 days — restorable by whoever could delete it — and a sweep
 * purges it for good after that. Boards keep their trash state in the board
 * store (every board read filters it in SQL); meetings and projects are
 * registered here and hidden by wrapping their stores, so nothing that
 * lists or opens them needs to know the trash exists.
 */

export const TRASH_DAYS = 30;
export const TRASH_WINDOW_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;

export type TrashKind = "meeting" | "project";

export interface TrashItem {
  kind: TrashKind;
  id: string;
  orgId: string;
  /** The board a meeting lives on; null for a project. */
  boardId: string | null;
  name: string;
  deletedBy: string;
  deletedAt: number;
}

export interface TrashStore {
  put(item: TrashItem): Promise<void>;
  remove(kind: TrashKind, id: string): Promise<boolean>;
  get(kind: TrashKind, id: string): Promise<TrashItem | undefined>;
  forOrg(orgId: string): Promise<TrashItem[]>;
  /** Everything trashed before `before`, oldest first, bounded. */
  expired(before: number, limit: number): Promise<TrashItem[]>;
  /** Ids of this kind currently in the trash — the read filter. */
  hidden(kind: TrashKind, ids: readonly string[]): Promise<Set<string>>;
}

export class InMemoryTrashStore implements TrashStore {
  private readonly items = new Map<string, TrashItem>();
  private key(kind: TrashKind, id: string) {
    return `${kind}:${id}`;
  }
  async put(item: TrashItem): Promise<void> {
    this.items.set(this.key(item.kind, item.id), { ...item });
  }
  async remove(kind: TrashKind, id: string): Promise<boolean> {
    return this.items.delete(this.key(kind, id));
  }
  async get(kind: TrashKind, id: string): Promise<TrashItem | undefined> {
    const item = this.items.get(this.key(kind, id));
    return item ? { ...item } : undefined;
  }
  async forOrg(orgId: string): Promise<TrashItem[]> {
    return [...this.items.values()]
      .filter((i) => i.orgId === orgId)
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }
  async expired(before: number, limit: number): Promise<TrashItem[]> {
    return [...this.items.values()]
      .filter((i) => i.deletedAt < before)
      .sort((a, b) => a.deletedAt - b.deletedAt)
      .slice(0, limit);
  }
  async hidden(kind: TrashKind, ids: readonly string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.items.has(this.key(kind, id))));
  }
}

function passThrough<T extends object>(target: T, prop: string | symbol, receiver: unknown) {
  const value = Reflect.get(target, prop, receiver) as unknown;
  return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
}

/**
 * Purge what has been in the trash longer than the window (the
 * `sweep-trash` job): boards through the board store, meetings and projects
 * through theirs, then off the register.
 */
export async function purgeExpiredTrash(deps: {
  boards: { purgeTrashed(before: number, limit: number): Promise<string[]> };
  meetings?: { delete(boardId: string, id: string): Promise<boolean> };
  projects: { delete(id: string): Promise<boolean> };
  trash: TrashStore;
  now?: number;
  limit?: number;
}): Promise<{ boards: number; meetings: number; projects: number }> {
  const before = (deps.now ?? Date.now()) - TRASH_WINDOW_MS;
  const limit = deps.limit ?? 100;
  const boards = (await deps.boards.purgeTrashed(before, limit)).length;
  let meetings = 0;
  let projects = 0;
  for (const item of await deps.trash.expired(before, limit)) {
    if (item.kind === "meeting" && item.boardId) {
      await deps.meetings?.delete(item.boardId, item.id);
      meetings += 1;
    } else if (item.kind === "project") {
      await deps.projects.delete(item.id);
      projects += 1;
    }
    await deps.trash.remove(item.kind, item.id);
  }
  return { boards, meetings, projects };
}

/** A meeting store whose reads leave out trashed meetings. */
export function withMeetingTrash(meetings: MeetingStore, trash: TrashStore): MeetingStore {
  const visible = async (rows: MeetingTranscript[]) => {
    const gone = await trash.hidden(
      "meeting",
      rows.map((m) => m.id),
    );
    return gone.size === 0 ? rows : rows.filter((m) => !gone.has(m.id));
  };
  return new Proxy(meetings, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return async (boardId: string, id: string) => {
          const found = await target.get(boardId, id);
          return found && (await visible([found])).length > 0 ? found : undefined;
        };
      }
      if (prop === "forBoard") {
        return async (boardId: string, limit?: number) =>
          visible(await target.forBoard(boardId, limit));
      }
      if (prop === "forBoards") {
        return async (boardIds: readonly string[], limit?: number) =>
          visible(await target.forBoards(boardIds, limit));
      }
      return passThrough(target, prop, receiver);
    },
  });
}

/** A project store whose reads leave out trashed projects. */
export function withProjectTrash(projects: ProjectStore, trash: TrashStore): ProjectStore {
  const visible = async (rows: StoredProject[]) => {
    const gone = await trash.hidden(
      "project",
      rows.map((p) => p.id),
    );
    return gone.size === 0 ? rows : rows.filter((p) => !gone.has(p.id));
  };
  return new Proxy(projects, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return async (id: string) => {
          const found = await target.get(id);
          return found && (await visible([found])).length > 0 ? found : undefined;
        };
      }
      if (prop === "listForOrg") {
        return async (orgId: string, options?: { includeArchived?: boolean }) =>
          visible(await target.listForOrg(orgId, options));
      }
      if (prop === "forBoard") {
        return async (boardId: string) => visible(await target.forBoard(boardId));
      }
      return passThrough(target, prop, receiver);
    },
  });
}
