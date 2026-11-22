import type { ResourceScope } from "./acl";
import type { Caller } from "./events";
import type { Disposable } from "./plugin";
import type { Principal } from "./store";

export type RouteHandler = (req: Request, ctx: RequestContext) => Response | Promise<Response>;
export interface RequestContext {
  caller: Caller;
  principal: Principal | undefined;
  params: Record<string, string>;
  url: URL;
}

export interface HttpHost {
  /**
   * Path is relative to /plugins/<id>; ":param" segments are supported. Non-public routes need an identified
   * principal and `permission` (default `<namespace>:control`, owner) on the resolved resource.
   */
  route(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    handler: RouteHandler,
    opts?: RouteAcl,
  ): Disposable;
  /** Absolute URL of a mounted path, for MCP endpoints and webhooks, from the active `transport@1` provider. */
  url(path: string): string;
}

export interface RouteAcl {
  public?: boolean;
  permission?: string;
  resource?: (req: Request) => ResourceScope | undefined;
  /** Opt in only if the handler enforces the route permission on every returned item. */
  collection?: boolean;
}
