/**
 * Módulo Clínica — CATÁLOGO CID-10 COM BUSCA (ADR-080 Fase 23).
 *
 * Fecha o buraco de qualidade do campo `cid` no atestado (Fase H): hoje é
 * texto livre, então "H10.9", "H10", "H109" e "conjuntivite" viram entradas
 * diferentes pra mesma condição, quebrando auditoria e agregações. Este
 * serviço expõe um catálogo GLOBAL (mesmo pra todas as clínicas — CID-10 é
 * padrão OMS/DATASUS) e uma busca por prefixo de código ou substring de
 * descrição.
 *
 * NÃO é policy: `ClinicDocumentsService.createCertificate` continua aceitando
 * CID fora do catálogo (não trava quem já tem seus códigos memorizados). O
 * catálogo é AJUDA — autocomplete na UI + auto-preenchimento do snapshot
 * `cid_description` quando o código bate.
 *
 * Seed é chamado do bootstrap uma única vez por processo; idempotente por
 * PRIMARY KEY (`INSERT OR IGNORE`). O conjunto inicial cobre condições
 * comuns de atestado em clínica generalista — não é a base completa (14 mil
 * códigos). Import completo é problema separado (script de admin, não
 * bootstrap).
 */
import db from "./db.js";

export interface Cid10 {
  code: string;
  description: string;
  chapter: string | null;
}

/**
 * Normaliza um código pra o formato canônico usado como PRIMARY KEY:
 * uppercase, sem espaço, sem ponto extra (padrão CID-10 usa 1 ponto entre
 * categoria e subcategoria — "H10.9", nunca "H10..9" nem "h109").
 * Aceita ambas as formas de input do usuário — "h109" e "H10.9" resolvem
 * pro mesmo lookup.
 */
export function normalizeCode(input: string): string {
  const raw = String(input || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";
  // Se veio sem ponto e tem 4+ chars começando com letra+2dígitos, insere:
  // "H109" → "H10.9"; "H10" fica "H10".
  if (!raw.includes(".") && /^[A-Z]\d{2,3}[A-Z0-9]?$/.test(raw) && raw.length > 3) {
    return `${raw.slice(0, 3)}.${raw.slice(3)}`;
  }
  return raw;
}

// Conjunto inicial curado. Cobre atestado geral (viroses, ortopedia leve,
// oftalmologia, ginecologia, saúde mental básica, cirurgias comuns).
// Fonte: DATASUS CID-10 (2008), colunas resumidas pra rótulos que a UI
// vai exibir. Não pretende ser exaustivo — o gestor pode adicionar mais
// via script depois.
const SEED: Array<[code: string, description: string, chapter: string]> = [
  // Infecções virais
  ["B34.9", "Infecção viral não especificada", "Doenças infecciosas"],
  ["B08.4", "Enterovirose com exantema", "Doenças infecciosas"],
  ["J00", "Nasofaringite aguda (resfriado comum)", "Doenças respiratórias"],
  ["J02.9", "Faringite aguda não especificada", "Doenças respiratórias"],
  ["J03.9", "Amigdalite aguda não especificada", "Doenças respiratórias"],
  ["J06.9", "Infecção aguda das vias aéreas superiores não especificada", "Doenças respiratórias"],
  ["J11.1", "Influenza (gripe) com outras manifestações respiratórias", "Doenças respiratórias"],
  ["J20.9", "Bronquite aguda não especificada", "Doenças respiratórias"],
  ["U07.1", "COVID-19, vírus identificado", "Doenças infecciosas"],
  // Gastro
  ["A09", "Diarreia e gastroenterite de origem infecciosa presumível", "Doenças infecciosas"],
  ["K52.9", "Gastroenterite e colite não infecciosa não especificada", "Doenças do aparelho digestivo"],
  ["K29.7", "Gastrite não especificada", "Doenças do aparelho digestivo"],
  ["K30", "Dispepsia", "Doenças do aparelho digestivo"],
  ["R11", "Náusea e vômito", "Sinais e sintomas"],
  // Cabeça/enxaqueca
  ["G43.9", "Enxaqueca não especificada", "Doenças do sistema nervoso"],
  ["G44.2", "Cefaleia devida a tensão", "Doenças do sistema nervoso"],
  ["R51", "Cefaleia", "Sinais e sintomas"],
  // Ortopedia leve / dor
  ["M54.5", "Dor lombar baixa", "Doenças do sistema osteomuscular"],
  ["M25.5", "Dor articular", "Doenças do sistema osteomuscular"],
  ["M79.6", "Dor em membro", "Doenças do sistema osteomuscular"],
  ["S93.4", "Entorse e distensão do tornozelo", "Traumatismos"],
  ["S63.5", "Entorse e distensão do punho", "Traumatismos"],
  ["T14.9", "Traumatismo não especificado", "Traumatismos"],
  // Oftalmologia
  ["H10.9", "Conjuntivite não especificada", "Doenças do olho"],
  ["H10.3", "Conjuntivite aguda não especificada", "Doenças do olho"],
  ["H52.1", "Miopia", "Doenças do olho"],
  ["H52.4", "Presbiopia", "Doenças do olho"],
  // Otorrino
  ["H65.9", "Otite média não supurativa não especificada", "Doenças do ouvido"],
  ["H66.9", "Otite média não especificada", "Doenças do ouvido"],
  ["J30.4", "Rinite alérgica não especificada", "Doenças respiratórias"],
  // Dermato
  ["L20.9", "Dermatite atópica não especificada", "Doenças da pele"],
  ["L23.9", "Dermatite alérgica de contato de causa não especificada", "Doenças da pele"],
  ["L30.9", "Dermatite não especificada", "Doenças da pele"],
  ["B02.9", "Herpes zoster sem complicações", "Doenças infecciosas"],
  // Ginecologia / obstetrícia comum
  ["N39.0", "Infecção do trato urinário de localização não especificada", "Aparelho geniturinário"],
  ["N76.0", "Vaginite aguda", "Aparelho geniturinário"],
  ["N94.6", "Dismenorreia não especificada", "Aparelho geniturinário"],
  ["O26.9", "Afecção relacionada com a gravidez não especificada", "Gravidez e parto"],
  // Cardio/pressão
  ["I10", "Hipertensão essencial (primária)", "Doenças do aparelho circulatório"],
  ["R00.2", "Palpitações", "Sinais e sintomas"],
  // Saúde mental
  ["F32.9", "Episódio depressivo não especificado", "Transtornos mentais"],
  ["F41.1", "Ansiedade generalizada", "Transtornos mentais"],
  ["F41.2", "Transtorno misto ansioso e depressivo", "Transtornos mentais"],
  ["F43.0", "Reação aguda ao stress", "Transtornos mentais"],
  ["F43.2", "Transtornos de adaptação", "Transtornos mentais"],
  ["G47.0", "Insônia", "Doenças do sistema nervoso"],
  // Endócrino
  ["E11.9", "Diabetes mellitus tipo 2 sem complicações", "Doenças endócrinas"],
  ["E03.9", "Hipotireoidismo não especificado", "Doenças endócrinas"],
  // Sintomas comuns
  ["R50.9", "Febre não especificada", "Sinais e sintomas"],
  ["R53", "Mal-estar e fadiga", "Sinais e sintomas"],
  ["R10.4", "Outra dor abdominal não especificada", "Sinais e sintomas"],
  // Comparecimento (código Z do CID-10, comum em atestado de acompanhante)
  ["Z76.3", "Acompanhamento de pessoa doente em instituição de saúde", "Contatos com serviços de saúde"],
];

let seeded = false;

export class Cid10Service {
  /**
   * Idempotente. Chamar no bootstrap. INSERT OR IGNORE preserva descrições
   * customizadas que o admin tenha ajustado depois.
   */
  static seed(): void {
    if (seeded) return;
    const stmt = db.prepare(`INSERT OR IGNORE INTO cid10_codes (code, description, chapter) VALUES (?, ?, ?)`);
    const tx = db.transaction((rows: typeof SEED) => {
      for (const [code, description, chapter] of rows) stmt.run(code, description, chapter);
    });
    try { tx(SEED); seeded = true; }
    catch (e) { console.error("[Cid10Service] Falha ao seed CID-10", e); }
  }

  static get(code: string): Cid10 | null {
    Cid10Service.seed(); // idempotente, custo O(1) após 1ª chamada
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    const r = db.prepare(`SELECT code, description, chapter FROM cid10_codes WHERE code = ?`).get(normalized) as any;
    if (!r) return null;
    return { code: r.code, description: r.description, chapter: r.chapter ?? null };
  }

  /**
   * Busca por código (prefix) OU descrição (substring, case-insensitive).
   * Ordena por relevância:
   *   1. Match exato de código
   *   2. Prefix de código
   *   3. Substring da descrição
   * Query vazia devolve `[]`.
   */
  static search(query: string, limit = 20): Cid10[] {
    Cid10Service.seed(); // idempotente, custo O(1) após 1ª chamada
    const raw = String(query || "").trim();
    if (!raw) return [];
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));

    // Como código: normaliza pra bater com o formato canônico da tabela.
    const asCode = normalizeCode(raw);
    // Como descrição: usa o raw sem normalizar (não força uppercase — mas o
    // LIKE do SQLite ignora ASCII case por default no builder padrão).
    const descLike = `%${raw}%`;
    const codeLike = `${asCode}%`;

    // Uma única query com CASE pra ordenar por precedência de match.
    const rows = db.prepare(
      `SELECT code, description, chapter,
              CASE
                WHEN code = ?             THEN 0
                WHEN code LIKE ?          THEN 1
                WHEN description LIKE ?   THEN 2
                ELSE 3
              END AS rank
         FROM cid10_codes
        WHERE code = ? OR code LIKE ? OR description LIKE ?
        ORDER BY rank ASC, code ASC
        LIMIT ?`
    ).all(asCode, codeLike, descLike, asCode, codeLike, descLike, lim) as any[];

    return rows.map((r) => ({ code: r.code, description: r.description, chapter: r.chapter ?? null }));
  }
}

export default Cid10Service;
