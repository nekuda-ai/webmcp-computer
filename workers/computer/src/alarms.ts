// A Durable Object has exactly one alarm. Several concerns (sync retry, runtime lease)
// need their own deadlines, so this multiplexes named deadlines onto that alarm: the
// alarm always fires at the earliest slot, and `alarm()` asks which slots are due.

export type AlarmStorage = Pick<
  DurableObjectStorage,
  "delete" | "deleteAlarm" | "get" | "getAlarm" | "put" | "setAlarm"
>;

const SLOTS_KEY = "webmcp-computer:alarm-slots";

export class AlarmSlots {
  readonly #storage: AlarmStorage;

  constructor(storage: AlarmStorage) {
    this.#storage = storage;
  }

  async slots(): Promise<Record<string, number>> {
    return (await this.#storage.get<Record<string, number>>(SLOTS_KEY)) ?? {};
  }

  async get(name: string): Promise<number | undefined> {
    return (await this.slots())[name];
  }

  async set(name: string, at: number): Promise<void> {
    if (!Number.isFinite(at)) {
      await this.clear(name);
      return;
    }
    const slots = await this.slots();
    slots[name] = at;
    await this.#storage.put(SLOTS_KEY, slots);
    await this.#arm(slots);
  }

  async clear(name: string): Promise<void> {
    const slots = await this.slots();
    if (!(name in slots)) return;
    delete slots[name];
    if (Object.keys(slots).length === 0) await this.#storage.delete(SLOTS_KEY);
    else await this.#storage.put(SLOTS_KEY, slots);
    await this.#arm(slots);
  }

  /** Names whose deadline has passed. Handlers must `set` or `clear` them afterwards. */
  async due(now: number, skewMs = 1_000): Promise<string[]> {
    const slots = await this.slots();
    return Object.entries(slots)
      .filter(([, at]) => at <= now + skewMs)
      .map(([name]) => name);
  }

  /** Re-arm the DO alarm from the stored slots; call at the end of every `alarm()`. */
  async rearm(): Promise<void> {
    await this.#arm(await this.slots());
  }

  async #arm(slots: Record<string, number>): Promise<void> {
    const deadlines = Object.values(slots);
    if (deadlines.length === 0) {
      await this.#storage.deleteAlarm();
      return;
    }
    const next = Math.min(...deadlines);
    const current = await this.#storage.getAlarm();
    if (current !== next) await this.#storage.setAlarm(next);
  }
}
