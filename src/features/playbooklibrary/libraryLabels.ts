/**
 * Biblioteca de playbooks (ADR-206 F5.11) — funções PURAS, sem React nem rede. Quem decide o que existe, em que estágio e com que
 * autonomia máxima é o `PlaybookRegistryService` (F5.3); aqui só se traduz a resposta em frases de dono. Nada aqui calcula eficácia,
 * ativa, desativa ou recomenda um playbook (RN-F2-4: sem regra de negócio na tela).
 */

export interface LibraryEfficacy { definitionVersion: number; completed: number; failed: number; inProgress: number; n: number; completionRate: number | null; interval: { lower: number; upper: number } | null; confidence: string; vertical: string | null }
export interface LibraryItem {
  playbook: { id: string; version: number; name: string; summary: string; verticals: string[]; archetypes: string[]; risk: string; maxAutonomy: string; stage: string; preconditions: string[]; successMetric: string; evidence: string };
  fits: boolean; reasons: string[]; adopted: boolean;
  activeDefinition: { id: string; version: number; autonomyLevel: string } | null;
  autonomyAboveCeiling: boolean;
  canRunAtOrgLevel: { ok: boolean; reason?: string } | null;
  efficacy: LibraryEfficacy[];
}

/** `certified` nunca é inventado: "validado" quer dizer só "coberto por testes", e o texto diz isso. */
export function stageLabel(stage: string): string {
  return stage === "certified" ? "Certificado em piloto" : stage === "validated" ? "Validado por testes (sem piloto)" : stage === "experimental" ? "Experimental" : "Estágio desconhecido";
}
export const riskLabel = (r: string): string => r === "low" ? "Risco baixo" : r === "medium" ? "Risco médio" : r === "high" ? "Risco alto" : "Risco desconhecido";
export function autonomyLabel(level: string | null | undefined): string {
  return level === "observe" ? "Só observa e relata" : level === "suggest" ? "Sugere" : level === "prepare" ? "Prepara e pede a sua aprovação"
    : level === "execute" ? "Pode executar dentro do limite que você autorizou" : "—";
}
export const verticalsLabel = (v: string[]): string => v.length ? v.join(", ") : "Qualquer ramo";

export function fitLine(i: LibraryItem): string {
  if (i.fits) return "Cabe no ramo da sua empresa.";
  return i.reasons.length ? `Não cabe: ${i.reasons.join("; ")}.` : "Não cabe na sua empresa.";
}

export function adoptionLine(i: LibraryItem): string {
  if (!i.adopted || !i.activeDefinition) return "Ainda não está ligado na sua empresa.";
  return `Ligado na sua empresa (versão ${i.activeDefinition.version}, ${autonomyLabel(i.activeDefinition.autonomyLevel).toLowerCase()}).`;
}

/** Aviso (e só aviso) quando a autonomia configurada passa do teto do playbook, ou quando o estágio não permite o nível. */
export function ceilingWarning(i: LibraryItem): string | null {
  if (i.autonomyAboveCeiling) return `A autonomia configurada passa do teto deste playbook (${autonomyLabel(i.playbook.maxAutonomy).toLowerCase()}).`;
  if (i.canRunAtOrgLevel && !i.canRunAtOrgLevel.ok) return i.canRunAtOrgLevel.reason || "O estágio deste playbook não permite o nível de autonomia configurado.";
  return null;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Eficácia SEMPRE com n e banda — nunca um percentual solto (RN-F5-8); sem execução concluída → "sem dado", nunca 0%. */
export function efficacyLine(list: LibraryEfficacy[]): string {
  const withData = (list || []).filter((e) => e.n > 0);
  if (!withData.length) return "Sem execuções concluídas ainda — não dá para dizer se funciona na sua empresa.";
  const e = withData[withData.length - 1];
  const band = e.interval ? `, faixa de ${pct(e.interval.lower)} a ${pct(e.interval.upper)}` : "";
  const conf = e.confidence ? `, confiança ${e.confidence}` : "";
  return `${e.completed} de ${e.n} execuções concluídas na sua empresa (versão ${e.definitionVersion})${band}${conf}.`;
}

/** Cabem na empresa primeiro; dentro de cada grupo, a ordem do catálogo. Não esconde nenhum. */
export function orderLibrary(items: LibraryItem[]): LibraryItem[] {
  return [...items].sort((a, b) => Number(b.fits) - Number(a.fits));
}
