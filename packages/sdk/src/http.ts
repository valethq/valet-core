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
  /** Path is relative to /plugins/<id>; ":param" segments are supported. Non-public routes need an identified principal; beyond that, serving is the handler's call. */
  route(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    handler: RouteHandler,
    opts?: { public?: boolean },
  ): Disposable;
  /** Absolute URL of a mounted path, for MCP endpoints and webhooks. */
  url(path: string): string;
}
