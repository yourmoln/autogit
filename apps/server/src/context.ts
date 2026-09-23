import type { RuntimeConfig } from './config.js';
import { Db } from './db/database.js';
import { migrate } from './db/migrations.js';
import { Store } from './db/store.js';
import { AuthService } from './services/auth.js';
import { CodexService } from './services/codex.js';
import { EventBus } from './services/events.js';
import { LabelService } from './services/labels.js';
import { Orchestrator } from './services/orchestrator.js';
import { ProviderFactory } from './services/providers.js';
import { ProxyService } from './services/proxy.js';
import { EngineRunner } from './services/runner.js';
import { SettingsService } from './services/settings.js';
import { WorkspaceManager } from './services/workspace.js';
import { loadOrCreateSecretKey } from './util/crypto.js';
import { logger } from './util/logger.js';

export interface AppContext {
  config: RuntimeConfig;
  db: Db;
  store: Store;
  auth: AuthService;
  settings: SettingsService;
  proxy: ProxyService;
  events: EventBus;
  providers: ProviderFactory;
  labels: LabelService;
  codex: CodexService;
  runner: EngineRunner;
  workspace: WorkspaceManager;
  orchestrator: Orchestrator;
  dispose: () => void;
}

export function createContext(config: RuntimeConfig): AppContext {
  const db = new Db(config.dbFile);
  const migration = migrate(db);
  logger().info(
    { applied: migration.applied, current: migration.current, db: config.dbFile },
    'database ready',
  );

  const store = new Store(db);
  const auth = new AuthService(store);
  auth.bootstrap();
  const secretKey = loadOrCreateSecretKey(config.secretKeyPath, process.env.AUTOGIT_SECRET_KEY);
  const settings = new SettingsService(store, config);
  const proxy = new ProxyService(store, secretKey);
  const events = new EventBus();
  const providers = new ProviderFactory(store, secretKey, proxy);
  const labels = new LabelService({ store, providers, events });
  const codex = new CodexService(config, settings, events);
  const runner = new EngineRunner(config, settings, codex);
  const workspace = new WorkspaceManager(config, settings);
  const orchestrator = new Orchestrator({
    config,
    store,
    settings,
    events,
    codex,
    runner,
    workspace,
    providers,
    labels,
  });

  return {
    config,
    db,
    store,
    auth,
    settings,
    proxy,
    events,
    providers,
    labels,
    codex,
    runner,
    workspace,
    orchestrator,
    dispose: () => {
      orchestrator.stop();
      db.close();
    },
  };
}

export type { RuntimeConfig };
