export type EventMap = object;
export type EventName<Events extends EventMap> = Extract<keyof Events, string>;
export type HookPhase = "before" | "after";

export interface HookOptions {
  phase?: HookPhase;
  priority?: number;
  once?: boolean;
  plugin?: string;
}

export interface Subscription {
  readonly active: boolean;
  disconnect(): void;
}

export interface BeforeEventContext<Name extends string, Payload> {
  readonly name: Name;
  readonly phase: "before";
  readonly plugin: string | undefined;
  payload: Payload;
  readonly cancelled: boolean;
  readonly cancelReason: string | undefined;
  cancel(reason?: string): void;
}

export interface AfterEventContext<Name extends string, Payload> {
  readonly name: Name;
  readonly phase: "after";
  readonly plugin: string | undefined;
  readonly payload: Payload;
  readonly cancelled: boolean;
  readonly cancelReason: string | undefined;
}

export type EventContext<Name extends string, Payload> =
  | BeforeEventContext<Name, Payload>
  | AfterEventContext<Name, Payload>;

export interface EventResult<Payload> {
  readonly payload: Payload;
  readonly cancelled: boolean;
  readonly cancelReason?: string;
}

type Hook<Name extends string, Payload> = (
  event: EventContext<Name, Payload>,
) => void | Promise<void>;

interface HookRecord {
  id: number;
  phase: HookPhase;
  priority: number;
  once: boolean;
  plugin?: string;
  hook: Hook<string, unknown>;
}

export class EventHookError extends Error {
  constructor(
    readonly eventName: string,
    readonly phase: HookPhase,
    readonly plugin: string | undefined,
    readonly cause: unknown,
  ) {
    super(
      `Hook${plugin ? ` from "${plugin}"` : ""} failed during ${phase} phase of "${eventName}"`,
      { cause },
    );
    this.name = "EventHookError";
  }
}

export class EventBus<Events extends EventMap> {
  readonly #hooks = new Map<EventName<Events>, HookRecord[]>();
  #nextHookId = 1;

  on<Name extends EventName<Events>>(
    name: Name,
    hook: Hook<Name, Events[Name]>,
    options: HookOptions = {},
  ): Subscription {
    const record: HookRecord = {
      id: this.#nextHookId++,
      phase: options.phase ?? "before",
      priority: options.priority ?? 0,
      once: options.once ?? false,
      hook: hook as Hook<string, unknown>,
      ...(options.plugin === undefined ? {} : { plugin: options.plugin }),
    };

    const hooks = this.#hooks.get(name) ?? [];
    hooks.push(record);
    hooks.sort((left, right) => right.priority - left.priority || left.id - right.id);
    this.#hooks.set(name, hooks);

    let active = true;
    return {
      get active() {
        return active;
      },
      disconnect: () => {
        if (!active) return;
        active = false;
        this.#remove(name, record.id);
      },
    };
  }

  once<Name extends EventName<Events>>(
    name: Name,
    hook: Hook<Name, Events[Name]>,
    options: Omit<HookOptions, "once"> = {},
  ): Subscription {
    return this.on(name, hook, { ...options, once: true });
  }

  async emit<Name extends EventName<Events>>(
    name: Name,
    initialPayload: Events[Name],
  ): Promise<EventResult<Events[Name]>> {
    let payload = initialPayload;
    let cancelled = false;
    let cancelReason: string | undefined;

    for (const record of this.#snapshot(name, "before")) {
      if (!this.#isRegistered(name, record.id)) continue;
      if (record.once) this.#remove(name, record.id);

      const context: BeforeEventContext<Name, Events[Name]> = {
        name,
        phase: "before",
        plugin: record.plugin,
        get payload() {
          return payload;
        },
        set payload(nextPayload) {
          payload = nextPayload;
        },
        get cancelled() {
          return cancelled;
        },
        get cancelReason() {
          return cancelReason;
        },
        cancel(reason) {
          cancelled = true;
          cancelReason = reason;
        },
      };

      await this.#runHook(record, context);
      if (cancelled) break;
    }

    for (const record of this.#snapshot(name, "after")) {
      if (!this.#isRegistered(name, record.id)) continue;
      if (record.once) this.#remove(name, record.id);

      const context: AfterEventContext<Name, Events[Name]> = {
        name,
        phase: "after",
        plugin: record.plugin,
        payload,
        cancelled,
        cancelReason,
      };
      await this.#runHook(record, context);
    }

    return {
      payload,
      cancelled,
      ...(cancelReason === undefined ? {} : { cancelReason }),
    };
  }

  listenerCount<Name extends EventName<Events>>(name: Name): number {
    return this.#hooks.get(name)?.length ?? 0;
  }

  #snapshot<Name extends EventName<Events>>(name: Name, phase: HookPhase): HookRecord[] {
    return (this.#hooks.get(name) ?? []).filter((record) => record.phase === phase);
  }

  #isRegistered<Name extends EventName<Events>>(name: Name, id: number): boolean {
    return this.#hooks.get(name)?.some((record) => record.id === id) ?? false;
  }

  #remove<Name extends EventName<Events>>(name: Name, id: number): void {
    const hooks = this.#hooks.get(name);
    if (!hooks) return;

    const remaining = hooks.filter((record) => record.id !== id);
    if (remaining.length === 0) {
      this.#hooks.delete(name);
    } else {
      this.#hooks.set(name, remaining);
    }
  }

  async #runHook<Name extends string, Payload>(
    record: HookRecord,
    context: EventContext<Name, Payload>,
  ): Promise<void> {
    try {
      await record.hook(context as EventContext<string, unknown>);
    } catch (cause) {
      throw new EventHookError(context.name, context.phase, record.plugin, cause);
    }
  }
}
