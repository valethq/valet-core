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

export interface CoreBus {
  /** Core-internal emit with a full caller. Not reachable from PluginContext. */
  emitAs<N extends EvName>(caller: Caller, name: N, payload: ValetEvents[N]): Promise<EmitResult<ValetEvents[N]>>;
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
