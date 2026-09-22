import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import { registerAccountRoutes } from './accounts.js';
import { registerCodexRoutes } from './codex.js';
import { registerRepositoryRoutes } from './repositories.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSystemRoutes } from './system.js';
import { registerTaskRoutes } from './tasks.js';

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerSystemRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerRepositoryRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerCodexRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
}
