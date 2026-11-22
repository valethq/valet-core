import type { AclDoc, AclHost, Caller, CredentialState, Logger, PermissionDef } from "@valethq/sdk";
import type { CoreScopes } from "./scopes";

const owner = (summary: string, resource?: string, requireVerifiedLogin?: boolean): PermissionDef => ({
  summary,
  default: "owner",
  ...(resource === undefined ? {} : { resource }),
  ...(requireVerifiedLogin ? { requireVerifiedLogin } : {}),
});

/** Core's own permissions; all default to owner, sensitive administration also needs a verified login. */
export const CORE_PERMISSIONS: Record<string, PermissionDef> = {
  "project.read": owner("Read projects", "project"),
  "project.write": owner("Create, change and delete projects", "project"),
  "session.read": owner("Read sessions, their messages and live topics", "session"),
  "session.write": owner("Create, change and delete sessions", "session"),
  "message.write": owner("Post and complete messages", "session"),
  "run.read": owner("Read runs", "session"),
  "run.cancel": owner("Cancel runs", "session"),
  "principal.read": owner("Read principals"),
  "principal.link": owner("Mint a link challenge for oneself"),
  "principal.admin": owner("Link identities without proof and set roles", undefined, true),
  "plugin.read": owner("Read plugins and part types"),
  "settings.read": owner("Read settings", "plugin"),
  "settings.write": owner("Change settings", "plugin", true),
  "config.reload": owner("Reload the config file", undefined, true),
  "secret.read": owner("Read secret names and sources", undefined, true),
  "secret.write": owner("Write and delete secrets", undefined, true),
  "blob.read": owner("Read blobs"),
  "blob.write": owner("Upload blobs"),
  "fs.read": owner("Browse folders"),
  "fs.write": owner("Create folders", undefined, true),
};

const CONTROL: PermissionDef = {
  summary: "Control-plane routes and calls without a declared permission",
  default: "owner",
};

export interface AclRegistry {
  /** Registers a plugin's `acl` and its implicit `<ns>:control`; throws when another plugin's acl uses the namespace. */
  register(pluginId: string, namespace: string, doc: AclDoc | undefined): void;
  unregister(pluginId: string): void;
  permission(name: string): PermissionDef | undefined;
  namespaceOf(pluginId: string): string | undefined;
  /** The `ctx.acl` every plugin (and core) sees. */
  readonly host: AclHost;
}

export function createAclRegistry(deps: { scopes: CoreScopes; logger: Logger }): AclRegistry {
  const perms = new Map<string, PermissionDef>(
    Object.entries(CORE_PERMISSIONS).map(([k, v]) => [`core:${k}`, v]),
  );
  const owners = new Map<string, { plugin: string; names: string[] }>();
  perms.set("core:control", CONTROL);

  const permission = (name: string) => perms.get(name);

  const credential = (ref: string): CredentialState | undefined => {
    const at = ref.indexOf(":");
    if (at <= 0) return undefined;
    const key = ref.slice(0, at);
    const caller: Caller = { plugin: "core" };
    const provider = deps.scopes.providersFor("identity", caller).find((p) => p.key === key);
    if (provider === undefined) return undefined;
    // spec-gap: a provider without credential() cannot report revocation; its credentials count as active.
    if (provider.impl.credential === undefined) return { active: true };
    try {
      return provider.impl.credential(ref.slice(at + 1));
    } catch (error) {
      deps.logger.error("identity credential lookup failed", {
        plugin: provider.plugin,
        error: String(error),
      });
      return undefined;
    }
  };

  return {
    register(pluginId, namespace, doc) {
      const taken = owners.get(namespace);
      if (namespace === "core" || (taken !== undefined && taken.plugin !== pluginId))
        throw new Error(`acl namespace "${namespace}" is already used by "${taken?.plugin ?? "core"}"`);
      const names = [`${namespace}:control`];
      for (const key of Object.keys(doc?.permissions ?? {})) {
        if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(key))
          throw new Error(`acl permission "${key}" must be dotted lowercase`);
        names.push(`${namespace}:${key}`);
      }
      for (const name of names) {
        const key = name.slice(namespace.length + 1);
        perms.set(name, doc?.permissions[key] ?? CONTROL);
      }
      owners.set(namespace, { plugin: pluginId, names });
    },
    unregister(pluginId) {
      for (const [ns, entry] of owners) {
        if (entry.plugin !== pluginId) continue;
        for (const name of entry.names) perms.delete(name);
        owners.delete(ns);
      }
    },
    permission,
    namespaceOf: (pluginId) => [...owners].find(([, e]) => e.plugin === pluginId)?.[0],
    host: { permission, names: () => [...perms.keys()], credential },
  };
}
