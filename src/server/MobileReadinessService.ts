/**
 * MobileReadinessService — PRD 6 / ADR-163 F11 (§75-§79): mobile hardening.
 *
 * A experiência principal já é browser-first (Fala Tu) — esta fatia ENDURECE os
 * fluxos móveis críticos (voz, anexo, push, aprovação) reportando o que o cliente
 * suporta e GARANTINDO um caminho de degradação pra cada um. É COMPOSIÇÃO (RN-UX-1):
 * mapeia as capacidades do cliente aos serviços que já existem (captura, intake de
 * arquivo, push, aprovação); nenhum motor novo.
 *
 * GUARDRAIL DURO — CA1 (§75-§79): mobile NUNCA bloqueia. Todo fluxo sem suporte
 * nativo tem `fallback` e `blocking:false` — sem `mediaRecorder` digita o texto;
 * sem `serviceWorker`/push cai no sino in-app; WhatsApp é conector opcional, jamais
 * pré-requisito. O núcleo (ver/aprovar) funciona em qualquer navegador.
 *
 * Só computa a partir de dicas SANITIZADAS (sem UA cru, sem PII — RN-UX-7). Sem
 * tabela/flag nova; leitura pura.
 */

const PLATFORMS = new Set(["ios", "android", "desktop", "other"]);
const BROWSERS = new Set(["safari", "chrome", "firefox", "edge", "samsung", "other"]);

export interface ClientHints {
  platform?: string; browser?: string;
  serviceWorker?: boolean; mediaRecorder?: boolean; pushManager?: boolean;
  fileInput?: boolean; standalone?: boolean;
}
export interface MobileFlow {
  key: string; label: string; supported: boolean; fallback: string | null; blocking: false; note?: string;
}

function pick(v: unknown, set: Set<string>, dflt: string): string {
  const s = String(v ?? "").toLowerCase();
  return set.has(s) ? s : dflt;
}
const bool = (v: unknown, dflt = false): boolean => (typeof v === "boolean" ? v : dflt);

export class MobileReadinessService {
  /**
   * Avalia a prontidão dos fluxos móveis pro cliente. CA1: cada fluxo sem suporte
   * cai num fallback; nada bloqueia. `allCriticalHavePath` prova a garantia.
   */
  static assess(_orgId: string, _user: any, hints: ClientHints = {}): {
    platform: string; browser: string; standalone: boolean;
    flows: MobileFlow[];
    pwaInstallable: boolean;
    allCriticalHavePath: boolean;
    generatedAt: string;
  } {
    const platform = pick(hints.platform, PLATFORMS, "other");
    const browser = pick(hints.browser, BROWSERS, "other");
    const standalone = bool(hints.standalone);
    // Padrão OTIMISTA só onde é seguro: fileInput é universal em navegador; os
    // demais só contam suporte se o cliente confirmou a capacidade.
    const hasMediaRecorder = bool(hints.mediaRecorder);
    const hasServiceWorker = bool(hints.serviceWorker);
    const hasPush = bool(hints.pushManager);
    const hasFileInput = bool(hints.fileInput, true);

    const flows: MobileFlow[] = [
      {
        key: "capture_voice", label: "Captura por voz",
        supported: hasMediaRecorder,
        fallback: hasMediaRecorder ? null : "type_text",   // sem gravador → digita (Fala Tu aceita texto)
        blocking: false,
        note: platform === "ios" && browser !== "safari" ? "iOS só grava áudio no Safari; fora dele, use texto." : undefined,
      },
      {
        key: "capture_attachment", label: "Anexo (foto/arquivo)",
        supported: hasFileInput,
        fallback: hasFileInput ? null : "share_whatsapp",  // conector opcional, nunca pré-requisito (CA1)
        blocking: false,
      },
      {
        key: "receive_push", label: "Notificação push",
        supported: hasServiceWorker && hasPush,
        fallback: hasServiceWorker && hasPush ? null : "in_app_bell", // sino in-app sempre funciona
        blocking: false,
        note: platform === "ios" && !standalone ? "iOS só entrega push com o app instalado na tela inicial (PWA)." : undefined,
      },
      {
        key: "approve_action", label: "Aprovar ação",
        supported: true,                                   // núcleo: funciona em qualquer navegador
        fallback: null, blocking: false,
        note: platform === "ios" && standalone ? "Sessão pode expirar no PWA iOS — reautentique se pedir." : undefined,
      },
    ];

    // CA1: todo fluxo ou é suportado ou tem fallback; nenhum bloqueia.
    const allCriticalHavePath = flows.every((f) => (f.supported || !!f.fallback) && f.blocking === false);
    const pwaInstallable = hasServiceWorker && platform !== "desktop";

    return { platform, browser, standalone, flows, pwaInstallable, allCriticalHavePath, generatedAt: new Date().toISOString() };
  }

  /** Descritor canônico do PWA (fonte da verdade do backend; o frontend serve o manifest.json). */
  static pwaManifest(): {
    name: string; short_name: string; display: "standalone"; start_url: string;
    theme_color: string; background_color: string; orientation: "portrait" | "any"; scope: string;
  } {
    return {
      name: "ZapFlow",
      short_name: "ZapFlow",
      display: "standalone",
      start_url: "/",
      scope: "/",
      theme_color: "#0f172a",
      background_color: "#ffffff",
      orientation: "portrait",
    };
  }
}

export default MobileReadinessService;
