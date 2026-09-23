import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell } from './components/AppShell.js';
import { Spinner } from './components/primitives.js';
import { useAuth } from './lib/auth.js';
import { AccountsPage } from './pages/AccountsPage.js';
import { CodexPage } from './pages/CodexPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { LabelsPage } from './pages/LabelsPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { ProxyPage } from './pages/ProxyPage.js';
import { RepositoriesPage } from './pages/RepositoriesPage.js';
import { RepositoryDetailPage } from './pages/RepositoryDetailPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { TasksPage } from './pages/TasksPage.js';

export function App(): ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/repositories" element={<RepositoriesPage />} />
          <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/codex" element={<CodexPage />} />
          <Route path="/proxy" element={<ProxyPage />} />
          <Route path="/labels" element={<LabelsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

/**
 * Route guard for the whole console.
 *
 * Nothing under it mounts before the session question is answered, and an
 * unauthenticated visitor is sent to `/login` with the original target so the
 * login page can hand it back afterwards.
 */
function RequireAuth(): ReactNode {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2.5 text-xs text-slate-400">
        <Spinner />
        正在校验登录状态…
      </div>
    );
  }

  if (!session) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }

  return <Outlet />;
}
