import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AfterEvent,
  type BeforeEvent,
  type Caller,
  type Denial,
  type Disposable,
  type EmitResult,
  EventHookError,
  type HookOptions,
  type HookPhase,
  type Logger,
  ServiceDeniedError,
  type Subscription,
  type ValetEvents,
  type ValetSignals,
} from "@valethq/sdk";
import { deepFreeze } from "./freeze";
import type { ActionResult, CoreBus, CoreBusOptions, HookErrorReport, ScopedPluginEventBus } from "./types";

type EvName = Extract<keyof ValetEvents, string>;
type SigName = Extract<keyof ValetSignals, string>;

const HOOK_LIMIT_MS = 10_000;
const SLOW_HOOK_WARN_MS = 250;
const MAX_DEPTH = 8;
const TIMEOUT = Symbol("hook-timeout");

type AnyEvent = BeforeEvent<string, unknown> | AfterEvent<string, unknown>;
type HookFn = (event: AnyEvent) => void | Promise<void>;
type SignalFn = (payload: unknown, caller: Caller) => void | Promise<void>;

interface HookRecord {
  id: number;
  phase: HookPhase;
  priority: number;
  once: boolean;
  plugin: string;
  hook: HookFn;
}

interface SignalRecord {
  id: number;
  plugin: string;
  fn: SignalFn;
}

interface RecordWithId {
  id: number;
}

/** Tracks which hook is running so re-entrant emits get their depth and caller.cause (7.2 changes 6 and 9). */
interface HookScope {
  depth: number;
  event: string;
  plugin: string;
}

class CoreBusImpl implements CoreBus {
  readonly #hooks = new Map<string, HookRecord[]>();
  readonly #signals = new Map<string, SignalRecord[]>();
  readonly #restrict = new Map<
    string,
    { owner: string; fn: (subscriber: string, name: string) => boolean }
  >();
  readonly #scope = new AsyncLocalStorage<HookScope>();
  readonly #logger: Logger;
  readonly #dev: boolean;
  readonly #onHookError: ((report: HookErrorReport) => void) | undefined;
  readonly #limits: Record<string, number>;
  readonly #slowMs: number;
  readonly #maxDepth: number;
  #nextId = 1;

  constructor(opts: CoreBusOptions = {}) {
    this.#logger = opts.logger ?? console;
    this.#dev = opts.dev ?? false;
    this.#onHookError = opts.onHookError;
    this.#limits = opts.hookTimeLimitMs ?? {};
    this.#slowMs = opts.slowHookWarnMs ?? SLOW_HOOK_WARN_MS;
    this.#maxDepth = opts.maxDepth ?? MAX_DEPTH;
  }

  // ---- core-facing API -------------------------------------------------

  emitAs<N extends EvName>(
    caller: Caller,
    name: N,
    payload: ValetEvents[N],
  ): Promise<EmitResult<ValetEvents[N]>> {
    return this.#emit(caller, name, payload) as Promise<EmitResult<ValetEvents[N]>>;
  }

  emitActionAs<N extends EvName, T>(
    caller: Caller,
    name: N,
    payload: ValetEvents[N],
    commit: (payload: ValetEvents[N]) => T,
  ): Promise<ActionResult<ValetEvents[N], T>> {
    return this.#emit(caller, name, payload, commit as (payload: unknown) => unknown) as Promise<
      ActionResult<ValetEvents[N], T>
    >;
  }

  signalAs<N extends SigName>(caller: Caller, name: N, payload: ValetSignals[N]): void {
    this.#signal(caller, name, payload);
  }

  forPlugin(pluginId: string, namespace?: string): ScopedPluginEventBus {
    return new PluginBusView(this, pluginId, namespace ?? pluginId.replace(/^valet-/, ""));
  }

  listenerCount(name: string, phase?: HookPhase): number {
    const hooks = this.#hooks.get(name) ?? [];
    return phase === undefined ? hooks.length : hooks.filter((r) => r.phase === phase).length;
  }

  // ---- registration, called only by PluginBusView -----------------------

  addHook(plugin: string, phase: HookPhase, name: string, hook: HookFn, opts: HookOptions): Subscription {
    this.#checkRestricted(plugin, name);
    const record: HookRecord = {
      id: this.#nextId++,
      phase,
      priority: opts.priority ?? 0,
      once: opts.once ?? false,
      plugin,
      hook,
    };
    const hooks = this.#hooks.get(name) ?? [];
    hooks.push(record);
    hooks.sort((left, right) => right.priority - left.priority || left.id - right.id);
    this.#hooks.set(name, hooks);
    return this.#subscription(this.#hooks, name, record.id);
  }

  addSignal(plugin: string, name: string, fn: SignalFn): Subscription {
    this.#checkRestricted(plugin, name);
    const record: SignalRecord = { id: this.#nextId++, plugin, fn };
    const records = this.#signals.get(name) ?? [];
    records.push(record);
    this.#signals.set(name, records);
    return this.#subscription(this.#signals, name, record.id);
  }

  addRestrict(
    owner: string,
    namespace: string,
    fn: (subscriber: string, name: string) => boolean,
  ): Disposable {
    const existing = this.#restrict.get(namespace);
    if (existing && existing.owner !== owner) {
      throw new Error(`event namespace "${namespace}" is already restricted by "${existing.owner}"`);
    }
    const entry = { owner, fn };
    this.#restrict.set(namespace, entry);
    return {
      dispose: () => {
        if (this.#restrict.get(namespace) === entry) this.#restrict.delete(namespace);
      },
    };
  }

  /** 7.2 change 11: the namespace owner's restrict fn is checked when a hook subscribes. */
  #checkRestricted(subscriber: string, name: string): void {
    const entry = this.#restrict.get(name.split(".")[0] ?? "");
    if (!entry || entry.fn(subscriber, name)) return;
    const error = new ServiceDeniedError(`"${entry.owner}" refused "${name}" to "${subscriber}"`);
    (error as { by: string }).by = entry.owner;
    throw error;
  }

  // ---- emit -------------------------------------------------------------

  async #emit(
    caller: Caller,
    name: string,
    initialPayload: unknown,
    commit?: (payload: unknown) => unknown,
  ): Promise<EmitResult<unknown> & { value?: unknown }> {
    const parent = this.#scope.getStore();
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > this.#maxDepth) {
      throw new EventHookError(name, "before", caller.plugin, "depth");
    }
    const stampedCaller: Caller = parent
      ? { ...caller, cause: { event: parent.event, plugin: parent.plugin } }
      : caller;
    const dev = this.#dev;

    let payload = dev ? deepFreeze(initialPayload) : initialPayload;
    let cancelled = false;
    let cancelReason: string | undefined;
    let denied: Denial | undefined;

    // 7.2 change 3: one snapshot per emit covers both phases.
    const snapshot = (this.#hooks.get(name) ?? []).slice();
    const before = snapshot.filter((r) => r.phase === "before");
    const after = snapshot.filter((r) => r.phase === "after");

    for (const record of before) {
      if (!this.#isRegistered(this.#hooks, name, record.id)) continue;
      if (record.once) this.#remove(this.#hooks, name, record.id);

      let live = true;
      const context: BeforeEvent<string, unknown> = {
        name,
        phase: "before",
        caller: stampedCaller,
        get payload() {
          return payload;
        },
        set payload(next: unknown) {
          if (live) payload = dev ? deepFreeze(next) : next;
        },
        get cancelled() {
          return cancelled;
        },
        get cancelReason() {
          return cancelReason;
        },
        get denied() {
          return denied;
        },
        cancel(reason?: string) {
          if (!live) return;
          cancelled = true;
          cancelReason = reason;
        },
        deny(reason: string) {
          if (!live) return;
          cancelled = true;
          cancelReason = reason;
          denied = { by: record.plugin, reason };
        },
      };
      try {
        await this.#runHook(record, context, depth);
      } finally {
        live = false;
      }
      if (cancelled) break;
    }

    // 7.3: the action's write happens between the phases, on the final payload.
    let value: unknown;
    if (!cancelled && commit) value = commit(payload);

    for (const record of after) {
      if (!this.#isRegistered(this.#hooks, name, record.id)) continue;
      if (record.once) this.#remove(this.#hooks, name, record.id);
      const context: AfterEvent<string, unknown> = {
        name,
        phase: "after",
        caller: stampedCaller,
        payload,
        cancelled,
        cancelReason,
        denied,
      };
      // 7.2 change 2: after-hook failures are isolated, reported and logged.
      try {
        await this.#runHook(record, context, depth);
      } catch (error) {
        this.#reportHookError({ eventName: name, phase: "after", plugin: record.plugin, error });
      }
    }

    return {
      payload,
      cancelled,
      ...(cancelReason === undefined ? {} : { cancelReason }),
      ...(denied === undefined ? {} : { denied }),
      ...(commit === undefined ? {} : { value }),
    };
  }

  #signal(caller: Caller, name: string, payload: unknown): void {
    const parent = this.#scope.getStore();
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > this.#maxDepth) {
      throw new EventHookError(name, "after", caller.plugin, "depth");
    }
    const stampedCaller: Caller = parent
      ? { ...caller, cause: { event: parent.event, plugin: parent.plugin } }
      : caller;
    const data = this.#dev ? deepFreeze(payload) : payload;

    // 7.2 change 7: synchronous, fire-and-forget, errors are logged.
    for (const record of (this.#signals.get(name) ?? []).slice()) {
      if (!this.#isRegistered(this.#signals, name, record.id)) continue;
      try {
        const result = this.#scope.run({ depth, event: name, plugin: record.plugin }, () =>
          record.fn(data, stampedCaller),
        );
        if (result instanceof Promise) {
          result.catch((error) => this.#logSignalError(name, record.plugin, error));
        }
      } catch (error) {
        this.#logSignalError(name, record.plugin, error);
      }
    }
  }

  #logSignalError(name: string, plugin: string, error: unknown): void {
    this.#logger.error(`Signal listener for "${name}" failed`, { plugin, error });
  }

  #reportHookError(report: HookErrorReport): void {
    this.#logger.error(`After hook on "${report.eventName}" failed`, {
      plugin: report.plugin,
      error: report.error,
    });
    try {
      this.#onHookError?.(report);
    } catch (error) {
      this.#logger.error("onHookError callback failed", { error });
    }
  }

  // 7.2 change 5: slow-hook warning plus a time limit; on timeout the hook keeps
  // running detached but its result is dropped.
  async #runHook(record: HookRecord, context: AnyEvent, depth: number): Promise<void> {
    const limit = this.#limits[context.name] ?? this.#limits["*"] ?? HOOK_LIMIT_MS;
    const started = performance.now();
    const work = this.#scope.run({ depth, event: context.name, plugin: record.plugin }, () =>
      Promise.resolve().then(() => record.hook(context)),
    );
    void work.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(TIMEOUT), limit);
        }),
      ]);
    } catch (cause) {
      if (cause instanceof EventHookError) throw cause;
      throw new EventHookError(
        context.name,
        context.phase,
        record.plugin,
        cause === TIMEOUT ? "timeout" : cause,
      );
    } finally {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - started);
      if (ms >= this.#slowMs) {
        this.#logger.warn(`Slow ${context.phase} hook on "${context.name}"`, { plugin: record.plugin, ms });
      }
    }
  }

  // ---- subscriptions -----------------------------------------------------

  #subscription(records: Map<string, RecordWithId[]>, name: string, id: number): Subscription {
    let active = true;
    return {
      get active() {
        return active;
      },
      disconnect: () => {
        if (!active) return;
        active = false;
        this.#remove(records, name, id);
      },
    };
  }

  #isRegistered(records: Map<string, RecordWithId[]>, name: string, id: number): boolean {
    return records.get(name)?.some((r) => r.id === id) ?? false;
  }

  #remove(records: Map<string, RecordWithId[]>, name: string, id: number): void {
    const list = records.get(name);
    if (!list) return;
    const remaining = list.filter((r) => r.id !== id);
    if (remaining.length === 0) {
      records.delete(name);
    } else {
      records.set(name, remaining);
    }
  }
}

/** The PluginEventBus view one plugin sees (7.2 changes 1, 10, 11 + namespaces). */
class PluginBusView implements ScopedPluginEventBus {
  readonly #bus: CoreBusImpl;
  readonly pluginId: string;
  readonly namespace: string;
  readonly #registered = new Set<Subscription | Disposable>();

  constructor(bus: CoreBusImpl, pluginId: string, namespace: string) {
    this.#bus = bus;
    this.pluginId = pluginId;
    this.namespace = namespace;
  }

  before<N extends EvName>(
    name: N,
    fn: (e: BeforeEvent<N, ValetEvents[N]>) => void | Promise<void>,
    opts: HookOptions = {},
  ): Subscription {
    return this.#track(this.#bus.addHook(this.pluginId, "before", name, fn as HookFn, opts));
  }

  after<N extends EvName>(
    name: N,
    fn: (e: AfterEvent<N, ValetEvents[N]>) => void | Promise<void>,
    opts: HookOptions = {},
  ): Subscription {
    return this.#track(this.#bus.addHook(this.pluginId, "after", name, fn as HookFn, opts));
  }

  async emit<N extends EvName>(name: N, payload: ValetEvents[N]): Promise<EmitResult<ValetEvents[N]>> {
    this.#assertEmitAllowed(name);
    return this.#bus.emitAs({ plugin: this.pluginId }, name, payload);
  }

  onSignal<N extends SigName>(name: N, fn: (payload: ValetSignals[N], caller: Caller) => void): Subscription {
    return this.#track(this.#bus.addSignal(this.pluginId, name, fn as SignalFn));
  }

  signal<N extends SigName>(name: N, payload: ValetSignals[N]): void {
    this.#assertEmitAllowed(name);
    this.#bus.signalAs({ plugin: this.pluginId }, name, payload);
  }

  restrict(fn: (subscriber: string, name: string) => boolean): Disposable {
    return this.#track(this.#bus.addRestrict(this.pluginId, this.namespace, fn));
  }

  disposeAll(): void {
    for (const item of this.#registered) {
      if ("disconnect" in item) {
        item.disconnect();
      } else {
        item.dispose();
      }
    }
    this.#registered.clear();
  }

  #track<T extends Subscription | Disposable>(item: T): T {
    this.#registered.add(item);
    return item;
  }

  /** Plugins may emit `<namespace>.*` and the shared `tool.call` action (7.2). */
  #assertEmitAllowed(name: string): void {
    if (name !== "tool.call" && !name.startsWith(`${this.namespace}.`)) {
      throw new Error(
        `plugin "${this.pluginId}" cannot emit "${name}" outside its namespace "${this.namespace}"`,
      );
    }
  }
}

export function createCoreBus(opts: CoreBusOptions = {}): CoreBus {
  return new CoreBusImpl(opts);
}
