import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';

import { App } from './App.js';
import { ThemeProvider, useTheme } from './hooks/useTheme.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 容器');

/** Sonner renders outside the panels, so it keeps its own themed surface. */
function ThemedToaster(): ReactNode {
  const { theme } = useTheme();
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        style:
          theme === 'dark'
            ? {
                background: 'rgba(15,18,26,0.96)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgb(226 232 240)',
              }
            : {
                background: 'rgba(255,255,255,0.97)',
                border: '1px solid rgba(15,23,42,0.12)',
                color: 'rgb(30 41 59)',
              },
      }}
    />
  );
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <App />
          <ThemedToaster />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
