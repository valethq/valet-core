import type { Principal } from "./store";
import type { ClientFrame, ServerFrame } from "./ws";

export interface ControlPlane {
  /** Resolve, identify, authorize and run one request. Never throws for a denied request; it returns 401 or 403. */
  dispatch(req: Request): Promise<Response>;
  /** One identified connection for sub, unsub and call frames. */
  connect(req: Request): Promise<ControlChannel>;
}
export interface ControlChannel {
  readonly principal: Principal | undefined;
  send(frame: ClientFrame): void;
  onFrame(fn: (frame: ServerFrame) => void): void;
  /** Core closes the channel (4401) if that principal or its originating credential is no longer valid. */
  onClose(fn: (code: number, reason: string) => void): void;
  close(): void;
}

/** spec-gap: `connect` rejects with this when the request is not identified (401), denied (403) or early (503). */
export class ControlRefusedError extends Error {
  constructor(readonly response: Response) {
    super(`control plane refused the connection (${response.status})`);
    this.name = "ControlRefusedError";
  }
}
