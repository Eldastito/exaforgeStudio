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
import { ClinicPortalPage } from './clinic-public/ClinicPortalPage.tsx';
import { ProfessionalPortalPage } from './clinic-public/ProfessionalPortalPage.tsx';
import { PatientPortalPage } from './clinic-public/PatientPortalPage.tsx';
import { ComigoMesaPage } from './comigo-public/ComigoMesaPage.tsx';
import { FalatuApp } from './falatu-app/FalatuApp.tsx';

// ADR-154 F7.1 — app FalaTu STANDALONE por subdomínio dedicado. Quando o
// host começa com `falatu.` (ex.: falatu.tesseractauto.com.br), servimos um
// bundle próprio: só login/cadastro do FalaTu + tela de conexão + app. Sem
// suíte, sem sidebar, sem master admin. A origem própria isola o localStorage
// da sessão do painel (mata a sessão-fantasma da F2.1c por construção).
// Override local pra dev: ?falatu=1 força o app sem precisar do subdomínio.
const isFalatuApp = (() => {
  try {
    if (window.location.hostname.startsWith('falatu.')) return true;
    return new URLSearchParams(window.location.search).get('falatu') === '1';
  } catch { return false; }
})();

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
// Portal do Profissional (Clínica, Fase D2) — página pública read-only, sem
// login. /clinic/professional/:token abre a agenda do dia do profissional.
const isClinicPortal = window.location.pathname.startsWith('/clinic/professional/');
// Webapp de autoatendimento do profissional (ADR-180 F7b) — /profissional/:token,
// público, magic-link → sessão escopada. COM escrita (agenda + disponibilidade).
const isProfessionalPortal = window.location.pathname.startsWith('/profissional/');
const isPatientPortal = window.location.pathname.startsWith('/paciente/');
// Comigo Mesa/QR (ADR-119) — autoatendimento público sem login (/mesa/:token).
const isComigoMesa = window.location.pathname.startsWith('/mesa/');

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
      // ADR-154 F6.1: onboarding Solo é pré-auth (cria a conta). Se o navegador
      // já tem token de OUTRA sessão no localStorage, injetá-lo aqui confundiria
      // o backend — a rota é pública, tem que sair sem Authorization.
      !input.startsWith('/api/onboarding-solo') &&
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
    {isFalatuApp ? (
      <AuthProvider>
        <FalatuApp />
        <Toaster />
      </AuthProvider>
    ) : isStorefront ? (
      <Storefront />
    ) : isLanding ? (
      <LandingPage />
    ) : isRadarRespondent ? (
      <RadarRespondentWizard />
    ) : isRadarPublic ? (
      <RadarPublicWizard />
    ) : isClinicPortal ? (
      <ClinicPortalPage />
    ) : isProfessionalPortal ? (
      <ProfessionalPortalPage />
    ) : isPatientPortal ? (
      <PatientPortalPage />
    ) : isComigoMesa ? (
      <ComigoMesaPage />
    ) : (
      <AuthProvider>
        <App />
        <Toaster />
      </AuthProvider>
    )}
  </StrictMode>,
);
