import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { AuthProvider } from './contexts/AuthContext.tsx';
import { Toaster } from './components/ui/Toaster.tsx';
import { Storefront } from './storefront/Storefront.tsx';

// Vitrine pública (loja virtual) — renderizada fora do app autenticado.
// Qualquer URL /loja/:slug abre a landing page Glass Toggle, sem login.
const isStorefront = window.location.pathname.startsWith('/loja/');

const originalFetch = window.fetch;
Object.defineProperty(window, 'fetch', {
  writable: true,
  configurable: true,
  value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = localStorage.getItem('zappflow_token');
    if (token && typeof input === 'string' && input.startsWith('/api') && !input.startsWith('/api/auth/register') && !input.startsWith('/api/auth/login')) {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      init = { ...init, headers };
    }
    return originalFetch(input, init);
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isStorefront ? (
      <Storefront />
    ) : (
      <AuthProvider>
        <App />
        <Toaster />
      </AuthProvider>
    )}
  </StrictMode>,
);
