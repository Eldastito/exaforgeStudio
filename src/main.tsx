import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { AuthProvider } from './contexts/AuthContext.tsx';
import { Toaster } from './components/ui/Toaster.tsx';
import { Storefront } from './storefront/Storefront.tsx';
import { LandingPage } from './landing/LandingPage.tsx';
import { RadarPublicWizard } from './radar-public/RadarPublicWizard.tsx';

// Vitrine pública (loja virtual) — renderizada fora do app autenticado.
// Qualquer URL /loja/:slug abre a landing page Glass Toggle, sem login.
const isStorefront = window.location.pathname.startsWith('/loja/');
// Landing comercial pública (/lp) — fora do app autenticado, sem login.
const isLanding = window.location.pathname === '/lp' || window.location.pathname.startsWith('/lp/');
// Radar de Execução IA — diagnóstico rápido público (/radar-ia), sem login.
const isRadarPublic = window.location.pathname === '/radar-ia' || window.location.pathname.startsWith('/radar-ia/');

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

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error("Elemento #root não encontrado no HTML. Verifique o index.html.");
}

createRoot(rootEl).render(
  <StrictMode>
    {isStorefront ? (
      <Storefront />
    ) : isLanding ? (
      <LandingPage />
    ) : isRadarPublic ? (
      <RadarPublicWizard />
    ) : (
      <AuthProvider>
        <App />
        <Toaster />
      </AuthProvider>
    )}
  </StrictMode>,
);
