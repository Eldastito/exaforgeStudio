/**
 * Configuração central dos CTAs da landing pública (ZappFlow).
 * Preencha com seus destinos reais. Vazio → usa a âncora local (#diagnostico).
 */
export const marketingConfig = {
  primaryCtaUrl: "#diagnostico",   // destino do botão principal (ou âncora)
  whatsappUrl: "https://wa.me/5521999947477?text=" + encodeURIComponent("Olá! Quero agendar um diagnóstico operacional com o ZappFlow."),
  calendarUrl: "",                 // ex.: link do Calendly/Google Agenda
  email: "",                       // ex.: "contato@zappflow.ai"
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
