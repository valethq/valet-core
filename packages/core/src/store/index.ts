import { join } from "node:path";
import type { Logger, PluginStorage } from "@valethq/sdk";
import type { CoreBus } from "../bus/types";
import { stampActor } from "./actor";
import { defaultDbPath, openDatabase } from "./engine";
import { runCoreMigrations } from "./migrate";
import { createPluginStorage } from "./storage";
import { PartTypeRegistry, type PluginOrigin } from "./parttypes";
import { createStore, type CoreStore, type StoreDeps } from "./store";

export { defaultDbPath, hasFts5, openDatabase } from "./engine";
export { newId } from "./ids";
export { ensureMigrationsTable, migrationApplied, recordMigration, runCoreMigrations } from "./migrate";
export { createPluginStorage } from "./storage";
export { PartTypeRegistry, type PluginOrigin } from "./parttypes";
export { createStore, StoreView } from "./store";
export type { CoreStore, StoreDeps } from "./store";

export interface OpenStoreOptions {
  valetHome: string;
  /** Defaults to <valetHome>/valet.sqlite; ":memory:" for tests. */
  dbPath?: string;
  bus: CoreBus;
  logger?: Logger;
}

export interface OpenedStore extends CoreStore {
  pluginStorage(pluginId: string): PluginStorage;
  readonly partTypes: PartTypeRegistry;
  /** Records a loaded plugin's manifest facts for the part types it defines. */
  setOrigin(origin: PluginOrigin): void;
}

/** Opens the database, applies core migrations and returns the single core store. */
export async function openStore(opts: OpenStoreOptions): Promise<OpenedStore> {
  const db = openDatabase(opts.dbPath ?? defaultDbPath(opts.valetHome));
  await runCoreMigrations(db);
  const deps: StoreDeps = {
    db,
    bus: opts.bus,
    blobsDir: join(opts.valetHome, "blobs"),
    logger: opts.logger ?? console,
    liveParts: new Map(),
    partTypes: new PartTypeRegistry(
      opts.dbPath === ":memory:" ? null : join(opts.valetHome, "part-types.json"),
    ),
    origins: new Map(),
  };
  opts.bus.setActorResolver((caller, ref) => stampActor(db, caller, ref));
  return {
    ...createStore(deps),
    pluginStorage: (pluginId) => createPluginStorage(db, pluginId),
    partTypes: deps.partTypes,
    setOrigin: (origin) => deps.origins.set(origin.id, origin),
  };
}
