/**
 * Configuração central dos CTAs da landing pública (ZappFlow).
 * Preencha com seus destinos reais. Vazio → usa a âncora local (#diagnostico).
 */
export const marketingConfig = {
  primaryCtaUrl: "#diagnostico",   // destino do botão principal (ou âncora)
  whatsappUrl: "https://wa.me/5521999947477?text=" + encodeURIComponent("Olá! Quero agendar um diagnóstico operacional com o ZappFlow."),
  calendarUrl: "",                 // ex.: link do Calendly/Google Agenda
  email: "",                       // ex.: "contato@zappflow.ai"
  // Analytics da landing (Plausible — cookieless, LGPD-limpo). Domínio registrado na
  // conta Plausible. Vazio → analytics desligado (nenhum script carregado). Passa a
  // MEDIR de fato só depois de criar a conta em plausible.io e adicionar este domínio.
  plausibleDomain: "zapflowia.tesseractauto.com.br",
};

/** Resolve o destino do CTA principal a partir da config (com fallback). */
export function primaryCtaHref(): string {
  return (
    marketingConfig.calendarUrl ||
    marketingConfig.whatsappUrl ||
    (marketingConfig.email ? `mailto:${marketingConfig.email}` : "") ||
    marketingConfig.primaryCtaUrl ||
    "#diagnostico"
  );
}
