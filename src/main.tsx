import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { AuthProvider } from './contexts/AuthContext.tsx';
import { Toaster } from './components/ui/Toaster.tsx';
import { Storefront } from './storefront/Storefront.tsx';
import { LandingPage } from './landing/LandingPage.tsx';
import { RadarPublicWizard } from './radar-public/RadarPublicWizard.tsx';
import { RadarRespondentWizard } from './radar-public/RadarRespondentWizard.tsx';

// Vitrine pública (loja virtual) — renderizada fora do app autenticado.
// Qualquer URL /loja/:slug abre a landing page Glass Toggle, sem login.
const isStorefront = window.location.pathname.startsWith('/loja/');
// Landing comercial pública (/lp) — fora do app autenticado, sem login.
const isLanding = window.location.pathname === '/lp' || window.location.pathname.startsWith('/lp/');
// Radar de Execução IA — diagnóstico rápido público (/radar-ia), sem login.
// /radar-ia/respond/:token é o convite de respondente (ADR-018) — sessão de
// um tenant já existente, mas respondida sem login; precisa vir ANTES da
// checagem genérica de /radar-ia/ (que cobre o diagnóstico anônimo, Fase 2).
const isRadarRespondent = window.location.pathname.startsWith('/radar-ia/respond/');
const isRadarPublic = !isRadarRespondent && (window.location.pathname === '/radar-ia' || window.location.pathname.startsWith('/radar-ia/'));

const originalFetch = window.fetch;
Object.defineProperty(window, 'fetch', {
  writable: true,
  configurable: true,
  value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = localStorage.getItem('zappflow_token');
    // Injeta o token do PAINEL (staff) só nas rotas autenticadas do painel.
    // NUNCA nas rotas públicas /api/public/* — elas têm autenticação própria
    // (ex.: o Provador Virtual usa o token do CLIENTE, com segredo diferente).
    // Sem esta exclusão, o token do painel (quando o dono está logado no mesmo
    // navegador) era injetado por cima do token do provador e o backend
    // recusava com 401 ("Sessão inválida"). Também respeita um Authorization
    // que o chamador já tenha definido explicitamente.
    const injectable =
      token &&
      typeof input === 'string' &&
      input.startsWith('/api') &&
      !input.startsWith('/api/auth/register') &&
      !input.startsWith('/api/auth/login') &&
      !input.startsWith('/api/public/');
    if (injectable) {
      const headers = new Headers(init?.headers);
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
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
    ) : isRadarRespondent ? (
      <RadarRespondentWizard />
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
