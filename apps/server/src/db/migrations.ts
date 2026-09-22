import type { Db } from './database.js';

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        base_url TEXT NOT NULL,
        username TEXT,
        display_name TEXT,
        avatar_url TEXT,
        token_enc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        status_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        html_url TEXT NOT NULL,
        clone_url TEXT NOT NULL,
        private INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        labels_initialized INTEGER NOT NULL DEFAULT 0,
        label_synced_at TEXT,
        last_polled_at TEXT,
        last_poll_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, full_name)
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        author TEXT,
        html_url TEXT,
        updated_at TEXT NOT NULL,
        is_pull_request INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL,
        UNIQUE (repository_id, number)
      );

      CREATE TABLE IF NOT EXISTS pull_requests (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        merged INTEGER NOT NULL DEFAULT 0,
        labels TEXT NOT NULL DEFAULT '[]',
        author TEXT,
        html_url TEXT,
        head_ref TEXT,
        base_ref TEXT,
        head_sha TEXT,
        issue_number INTEGER,
        merged_at TEXT,
        updated_at TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        UNIQUE (repository_id, number)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        engine TEXT NOT NULL,
        priority TEXT NOT NULL,
        issue_number INTEGER,
        issue_title TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        branch TEXT,
        workspace TEXT,
        summary TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        stream TEXT NOT NULL,
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        scope TEXT NOT NULL,
        repository_id TEXT,
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues (repository_id);
      CREATE INDEX IF NOT EXISTS idx_pull_requests_repo ON pull_requests (repository_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks (repository_id, queued_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
      CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs (task_id, id);
      CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity (ts);
    `,
  },
  {
    // Per account proxy selection: the mode decides which channel is used and
    // `proxy_url_enc` only carries the address of a `custom` account. The value
    // is encrypted with the same key as the Git token.
    id: '002_account_proxy',
    sql: `
      ALTER TABLE accounts ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'inherit';
      ALTER TABLE accounts ADD COLUMN proxy_url_enc TEXT;
    `,
  },
  {
    // Retry budget baseline.
    //
    // `stuck_at` records the moment AutoGit parked an item on `ai/stuck`.
    // Failures that finished before that mark no longer count towards the
    // "连续失败 3 次" budget, so removing `ai/stuck` and retrying always starts
    // from a fresh budget instead of being parked again on the next tick (the
    // pipeline used to be unrecoverable once the lifetime counter passed 3).
    //
    // Items that already carry `ai/stuck` when this migration runs are
    // backfilled, so they become retryable as well.
    id: '003_stuck_baseline',
    sql: `
      ALTER TABLE issues ADD COLUMN stuck_at TEXT;
      ALTER TABLE pull_requests ADD COLUMN stuck_at TEXT;
      UPDATE issues SET stuck_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE labels LIKE '%ai/stuck%';
      UPDATE pull_requests SET stuck_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE labels LIKE '%ai/stuck%';
    `,
  },
];

export function migrate(db: Db): { applied: string[]; current: string } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    const existing = db.get<{ id: string }>('SELECT id FROM schema_migrations WHERE id = ?', [
      migration.id,
    ]);
    if (existing) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        new Date().toISOString(),
      ]);
    });
    applied.push(migration.id);
  }

  const last = MIGRATIONS.at(-1);
  return { applied, current: last ? last.id : 'none' };
}
