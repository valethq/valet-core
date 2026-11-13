import type {
  Caller,
  EmitResult,
  HookPhase,
  Logger,
  PluginEventBus,
  ValetEvents,
  ValetSignals,
} from "@valethq/sdk";

type EvName = Extract<keyof ValetEvents, string>;
type SigName = Extract<keyof ValetSignals, string>;

/** Matches the `core.hook.error` signal payload (7.3). */
export interface HookErrorReport {
  eventName: string;
  phase: HookPhase;
  plugin: string | undefined;
  error: unknown;
}

export interface CoreBusOptions {
  /** Log sink for slow-hook warnings, after-hook failures and signal errors. Defaults to console. */
  logger?: Logger;
  /** Deep-freeze payloads so hooks must replace, not mutate (7.2 change 8). */
  dev?: boolean;
  /** After-phase hook failures are reported here (core wires it to `core.hook.error`) and logged. */
  onHookError?: (report: HookErrorReport) => void;
  /** Per-event hook time limit in ms. spec-gap: unnamed events and "*" fall back to 10_000. */
  hookTimeLimitMs?: Record<string, number>;
  /** Warn when a hook runs longer. spec-gap: default 250. */
  slowHookWarnMs?: number;
  /** Re-entrant emit/signal depth limit. spec-gap: default 8. */
  maxDepth?: number;
}

/** EmitResult plus the value produced by a mid-emit commit (core action events, 7.3). */
export interface ActionResult<P, T> extends EmitResult<P> {
  /** Present when `commit` ran; undefined when the action was cancelled. */
  readonly value: T | undefined;
}

export interface CoreBus {
  /** Core-internal emit with a full caller. Not reachable from PluginContext. */
  emitAs<N extends EvName>(
    caller: Caller,
    name: N,
    payload: ValetEvents[N],
  ): Promise<EmitResult<ValetEvents[N]>>;
  /**
   * Action event (7.3): `before` hooks run, then `commit(finalPayload)` performs the
   * write inside its transaction, then `after` hooks. Skipped when cancelled; a
   * throw from `commit` rejects the emit and skips the after phase.
   */
  emitActionAs<N extends EvName, T>(
    caller: Caller,
    name: N,
    payload: ValetEvents[N],
    commit: (payload: ValetEvents[N]) => T,
  ): Promise<ActionResult<ValetEvents[N], T>>;
  signalAs<N extends SigName>(caller: Caller, name: N, payload: ValetSignals[N]): void;
  /** The PluginEventBus for one plugin, bound to its id and its event namespace (default: id minus "valet-"). */
  forPlugin(pluginId: string, namespace?: string): ScopedPluginEventBus;
  listenerCount(name: string, phase?: HookPhase): number;
}

export interface ScopedPluginEventBus extends PluginEventBus {
  readonly pluginId: string;
  readonly namespace: string;
  /** Disconnects every subscription and restriction this view made (deactivate path). */
  disposeAll(): void;
}
