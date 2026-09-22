import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/AppShell.js';
import { AccountsPage } from './pages/AccountsPage.js';
import { CodexPage } from './pages/CodexPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { LabelsPage } from './pages/LabelsPage.js';
import { RepositoriesPage } from './pages/RepositoriesPage.js';
import { RepositoryDetailPage } from './pages/RepositoryDetailPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { TasksPage } from './pages/TasksPage.js';

export function App(): ReactNode {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/repositories" element={<RepositoriesPage />} />
        <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/codex" element={<CodexPage />} />
        <Route path="/labels" element={<LabelsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
