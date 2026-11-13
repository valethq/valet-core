import type { Disposable } from "./plugin";
import type { Role } from "./tools";

export type HookPhase = "before" | "after";
export interface HookOptions {
  priority?: number;
  once?: boolean;
}
export interface Subscription {
  readonly active: boolean;
  disconnect(): void;
}

/** Who caused an event, a store write or a scope call. Core fills it in; plugins cannot set `plugin`. */
export interface Caller {
  /** The emitting, writing or calling plugin's id, or "core" (boot recovery, control-plane requests). */
  readonly plugin: string;
  /**
   * The principal this is on behalf of, if any. Inside a run, `role` is the run's effective role (section 8.3).
   * A plugin claims it (via `store.as()` or a message author), or an identity provider proves it. Hooks decide whether to believe it.
   */
  readonly actor?: { readonly principalId: string; readonly role: Role };
  /** Control-plane requests only: the identity@1 provider that authenticated the request. */
  readonly authenticatedBy?: string;
  /** Set on re-entrant emits: the event whose hook caused this one. */
  readonly cause?: { readonly event: string; readonly plugin: string };
}
export interface Denial {
  readonly by: string;
  readonly reason: string;
}

export interface BeforeEvent<N extends string, P> {
  readonly name: N;
  readonly phase: "before";
  readonly caller: Caller;
  payload: P;
  readonly cancelled: boolean;
  readonly cancelReason: string | undefined;
  readonly denied: Denial | undefined;
  cancel(reason?: string): void;
  /** Refuse service to this caller. Like cancel(), it skips the remaining before hooks. Core sets `by` to this hook's plugin. */
  deny(reason: string): void;
}
export interface AfterEvent<N extends string, P> {
  readonly name: N;
  readonly phase: "after";
  readonly caller: Caller;
  readonly payload: P;
  readonly cancelled: boolean;
  readonly cancelReason: string | undefined;
  readonly denied: Denial | undefined;
}
export interface EmitResult<P> {
  readonly payload: P;
  readonly cancelled: boolean;
  readonly cancelReason?: string;
  readonly denied?: Denial;
}

/** Extended by declaration merging; plugin events are named "<namespace>.<rest>". */
// biome-ignore lint/suspicious/noEmptyInterface: spec: open interface extended by declaration merging
export interface ValetEvents {}
/** High-frequency, after-only signals. */
// biome-ignore lint/suspicious/noEmptyInterface: spec: open interface extended by declaration merging
export interface ValetSignals {}

type EvName = Extract<keyof ValetEvents, string>;
type SigName = Extract<keyof ValetSignals, string>;

export interface PluginEventBus {
  before<N extends EvName>(
    name: N,
    fn: (e: BeforeEvent<N, ValetEvents[N]>) => void | Promise<void>,
    opts?: HookOptions,
  ): Subscription;
  after<N extends EvName>(
    name: N,
    fn: (e: AfterEvent<N, ValetEvents[N]>) => void | Promise<void>,
    opts?: HookOptions,
  ): Subscription;
  /** Only for events in this plugin's namespace; core events are emitted by core actions. */
  emit<N extends EvName>(name: N, payload: ValetEvents[N]): Promise<EmitResult<ValetEvents[N]>>;
  onSignal<N extends SigName>(name: N, fn: (payload: ValetSignals[N], caller: Caller) => void): Subscription;
  signal<N extends SigName>(name: N, payload: ValetSignals[N]): void;
  /** Decide which plugins may hook or observe this plugin's namespace. Checked when a hook subscribes. */
  restrict(fn: (subscriber: string, name: string) => boolean): Disposable;
}

/** spec-gap: `cause` is the thrown error, or the literal string "timeout" | "depth" for bus limits. */
export class EventHookError extends Error {
  constructor(
    readonly eventName: string,
    readonly phase: HookPhase,
    readonly plugin: string | undefined,
    readonly cause: unknown,
  ) {
    super(`Hook${plugin ? ` from "${plugin}"` : ""} failed during ${phase} phase of "${eventName}"`, {
      cause,
    });
    this.name = "EventHookError";
  }
}
