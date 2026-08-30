/**
 * BeautyHairSimulationService (ADR-169 F6 / BEAUTY-006) — Simulador de Cabelo.
 *
 * O coração da Beauty AI. Espelha 100% o padrão do Fashion Studio try-on
 * (`FashionTryOnService`, ADR-037) — **mesmo contrato de provedor plugável,
 * mesma fila `JobQueueService` com `maxAttempts:1`, mesma idempotência por
 * `input_hash`, mesma escrita em `private_media/beauty/`, mesma URL assinada
 * do F5** — trocando duas coisas:
 *
 *  (a) O **PROMPT invertido** (RN-BS-04): em vez de "prova a peça de roupa,
 *      NÃO mude a pessoa", o prompt manda "preserve rosto/corpo/expressão/
 *      idade, ALTERE o cabelo (cor/corte) conforme os parâmetros". A regra
 *      "IA NUNCA julga aparência" (RN-BS-03) segue explícita: sem
 *      embelezar, sem afinar, sem rejuvenescer.
 *  (b) A entrada é PARÂMETRICA (`{color?, cut?, referenceLookId?}`) em vez
 *      de imagens de peças. Referência real de cor/corte vem via
 *      `beauty_reference_looks` (F5, curadas pelo salão).
 *
 * Providers:
 *  - `StubHairSimulationProvider` (SEMPRE DISPONÍVEL, determinístico) —
 *    gera um PNG 1x1 codificado a partir do hash. Serve pra CI, testes,
 *    demo local e fallback quando IA não está configurada. NÃO produz
 *    imagem real; apenas prova o fluxo end-to-end sem depender do provedor.
 *  - `GoogleGeminiHairSimulationProvider` — quando `GOOGLE_AI_API_KEY` ou
 *    `GEMINI_API_KEY` estão setadas, usa `editImagesGoogleB64` (mesma API
 *    que o Fashion) com o prompt invertido. Este é o caminho REAL de
 *    produção pra F6+. Fallback pro Stub em ausência de chave.
 *
 * Guardrails RN-BS ATIVOS:
 *  - RN-BS-01: SIMULAÇÃO ≠ AGENDAMENTO — output SUCCEEDED NÃO cria
 *    appointment; só marca `beauty_visual_simulations.status = 'SUCCEEDED'`.
 *    A escolha do visual pela cliente (`selected_simulation_id` da
 *    consulta) e o agendamento vêm em F10.
 *  - RN-BS-02: parâmetros de referência (cor/corte) precisam bater com
 *    `beauty_reference_looks` do PRÓPRIO tenant. `referenceLookId` de
 *    outra org é ignorado.
 *  - RN-BS-04: consent `hair_simulation` do contato da consulta precisa
 *    estar ativo — a foto só chega aqui porque F5 checou. Este service
 *    revalida antes de qualquer chamada ao provider (belt-and-suspenders).
 *  - RN-BS-05: logs sem foto/base64/prompt. Só `error_code`/
 *    `error_message_safe`.
 *  - RN-BS-06: idempotência real por `input_hash = sha256(org:contato:
 *    sha256(bytesDaFoto):stableParams)` (F26). Retry NUNCA gera duas
 *    vezes; a MESMA foto re-enviada noutra consulta reusa o acervo; o
 *    provider fica FORA do hash (trocar de IA não invalida imagem salva).
 *  - RN-BS-07: isolamento cross-tenant duro em toda query.
 *  - RN-BS-11: sem foto approved → não simula (erro amigável); sem
 *    consent ativo → não simula.
 *
 * Créditos por-tenant/por-cliente ficam pra fatia futura (F5 do PRD é
 * "Beauty AI" — F16+ do ADR-169 detalha métricas de custo).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { VisualGenerationKernel } from "./VisualGenerationKernel.js";
import { JobQueueService } from "./JobQueueService.js";
import { BeautyVisualConsultationService } from "./BeautyVisualConsultationService.js";
import { safeStorageKey } from "./fileSigning.js";

const PRIVATE_MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "private_media");
try { fs.mkdirSync(path.join(PRIVATE_MEDIA_DIR, "beauty"), { recursive: true }); } catch { /* noop */ }

export const SIMULATION_TYPES = ["color", "cut", "combined"] as const;
export type SimulationType = (typeof SIMULATION_TYPES)[number];

export const SIMULATION_STATUSES = [
  "CREATED", "QUEUED", "PROCESSING", "SUCCEEDED", "FAILED_FINAL", "DELETED", "EXPIRED",
] as const;
export type SimulationStatus = (typeof SIMULATION_STATUSES)[number];

export interface HairSimulationParameters {
  color?: string | null;              // 'morena_iluminada' | 'loiro' | 'ruivo' | ...
  cut?: string | null;                // 'chanel' | 'bob' | 'longo' | ...
  referenceLookId?: string | null;    // fk pra beauty_reference_looks
  notes?: string | null;              // observações da cliente (usado no prompt como texto CONTROLADO — não vai texto arbitrário)
}

export interface HairSimulationInput {
  avatar: Buffer;
  parameters: HairSimulationParameters;
}

export interface HairSimulationProvider {
  key: string;
  available(): boolean;
  generate(input: HairSimulationInput):
    Promise<{ ok: true; b64: string } | { ok: false; error: string; retryable: boolean }>;
}

// Prompt de segurança FIXO — RN-BS-04 (invertido do FashionTryOnService.
// SAFETY_PROMPT). NUNCA composto com texto arbitrário da cliente. O único
// input variável é o par (cor, corte) validado contra vocabulário fechado
// abaixo — se vier fora, o service rejeita antes de chegar ao provider.
export const SAFETY_PROMPT_HAIR =
  "A primeira imagem é a foto real de uma pessoa. Gere uma prévia mostrando ESSA MESMA PESSOA — o mesmíssimo rosto, feições, expressão, tom de pele, formato do corpo e idade aparente da foto original — apenas com O CABELO alterado conforme os parâmetros a seguir. " +
  "Regras invioláveis: é PROIBIDO trocar a pessoa, gerar um rosto diferente, embelezar, afinar, emagrecer, rejuvenescer, envelhecer ou alterar QUALQUER aspecto da aparência que não seja o cabelo — mantenha rosto/expressão/tom de pele/corpo IDÊNTICOS à primeira foto; " +
  "não adicione outras pessoas; nenhuma nudez, roupa íntima exposta ou sexualização; " +
  "aplique a MUDANÇA DE CABELO (cor e/ou corte) de forma natural e realista, respeitando o formato do rosto; " +
  "enquadramento igual ao da foto original, iluminação natural coerente.";

// Vocabulário fechado — RN-BS-11 (nunca aceitar texto livre pro prompt).
// Extensível: adicionar aqui, não em rota.
export const COLOR_VOCAB = new Set([
  // Loiros (família mais pedida — do escuro ao platinado + reflexos)
  "loiro", "loiro_claro", "loiro_escuro", "loiro_platinado",
  "loiro_dourado", "loiro_mel", "loiro_perola", "loiro_acinzentado",
  "loiro_champagne", "loiro_morango", "loiro_bege",
  // Castanhos
  "castanho", "castanho_claro", "castanho_escuro",
  "castanho_dourado", "castanho_acobreado", "castanho_acinzentado",
  "castanho_avermelhado", "chocolate", "chocolate_avermelhado",
  "caramelo", "mel", "nozes",
  // Pretos
  "preto", "preto_azulado", "preto_intenso",
  // Ruivos / avermelhados
  "ruivo", "ruivo_acobreado", "ruivo_acaju", "ruivo_borgonha",
  "acaju", "vermelho", "vermelho_cereja", "borgonha",
  // Grisalhos / acinzentados
  "grisalho", "prateado", "grafite", "cinza", "branco",
  // Coloração fantasia (RN-BS-11 — só se o salão oferecer)
  "rose", "rose_gold", "rosa", "azul", "azul_petroleo",
  "verde", "roxo", "lilas", "lavanda",
  // Técnicas / mechas (não é 1 cor sólida — o prompt trata como efeito)
  "mechas", "mechas_californianas", "balayage", "morena_iluminada",
  "ombre_hair", "luzes", "reflexo", "californianas", "degrade_ombre",
]);
export const CUT_VOCAB = new Set([
  // Comprimento base
  "curto", "medio", "longo", "repicado", "camadas", "corte_reto",
  "corte_v", "corte_u",
  // Cortes femininos clássicos
  "bob", "long_bob", "chanel", "chanel_de_bico", "pixie", "joaozinho",
  "shaggy", "wolf_cut",
  // Franjas
  "franja", "franja_lateral", "franja_reta", "franja_cortina", "franja_repicada",
  // Cortes masculinos / unissex
  "social", "undercut", "moicano", "degrade", "degrade_navalhado",
  "americano", "black_power", "topete", "corte_maquina", "raspado",
  // Textura / finalização
  "ondulado", "cacheado", "liso", "volume",
]);

/**
 * F32 — Objetivos de consulta prontos pra a UI (dropdown do campo "Objetivo").
 * Vocabulário FECHADO e GENÉRICO de salão (RN-BS-11; §17/§65 — nada hardcoded
 * de nenhum tenant específico): o usuário CLICA e escolhe em vez de digitar.
 * `value` é o que vai gravado em `beauty_visual_consultations.goal` (metadado
 * descritivo — não entra no prompt da IA, que só recebe cor/corte validados).
 * `label` é o texto pt-BR mostrado. Ordenados do mais comum ao mais específico.
 */
export const CONSULTATION_GOALS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "coloracao", label: "Mudar a cor do cabelo" },
  { value: "mechas", label: "Fazer mechas ou luzes" },
  { value: "balayage", label: "Balayage / iluminado" },
  { value: "clarear", label: "Clarear os fios (ficar mais loira)" },
  { value: "escurecer", label: "Escurecer os fios" },
  { value: "ruivo", label: "Virar ruiva" },
  { value: "cobrir_grisalhos", label: "Cobrir os grisalhos" },
  { value: "corte", label: "Mudar o corte" },
  { value: "franja", label: "Experimentar franja" },
  { value: "transformacao", label: "Transformação completa (cor + corte)" },
  { value: "visagismo", label: "Descobrir o que combina comigo (visagismo)" },
  { value: "evento", label: "Visual para um evento especial" },
  { value: "repaginar", label: "Repaginar o visual (ainda decidindo o quê)" },
];

// ─────────────────────────── PROVIDERS ───────────────────────────

/**
 * Stub determinístico — SEMPRE DISPONÍVEL. Gera um PNG 1x1 com bytes
 * derivados do input hash (assinatura reprodutível). Serve pra CI/testes/
 * demo. NÃO produz imagem visualmente útil; só prova o fluxo end-to-end.
 * Em produção, prefira o Google Gemini (real).
 */
class StubHairSimulationProvider implements HairSimulationProvider {
  key = "stub_v1";
  available() { return true; }
  async generate(input: HairSimulationInput) {
    // PNG mínimo válido de 1x1 pixel — bytes fixos + variação pelo hash pra
    // que dois inputs diferentes gerem outputs diferentes (útil pra teste).
    const seed = crypto.createHash("sha256")
      .update(input.avatar)
      .update(JSON.stringify(input.parameters || {}))
      .digest();
    // PNG signature + IHDR + IDAT + IEND (1x1 RGBA). Byte de cor derivado do seed.
    const r = seed[0], g = seed[1], b = seed[2];
    const pngBytes = Buffer.from([
      // PNG signature
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      // IHDR chunk (13 bytes: width=1, height=1, bit_depth=8, color_type=2 RGB)
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
      // IDAT chunk with zlib-wrapped raw pixel (filter byte + RGB)
      0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54,
      0x08, 0x99, 0x63, 0x60 | (r & 0x0F), g, b, 0x00, 0x00,
      0x00, 0x03, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x00,  // placeholder CRC IDAT
      // IEND
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);
    return { ok: true as const, b64: pngBytes.toString("base64") };
  }
}

/**
 * OpenAI gpt-image-1 (produção — PRIMÁRIO por decisão do operador). Reusa
 * `editImagesB64` (mesma API de edição do Estúdio) com `input_fidelity:
 * "high"` pra preservar a identidade da pessoa. Disponível quando
 * `OPENAI_API_KEY` está setada.
 */
class OpenAIHairSimulationProvider implements HairSimulationProvider {
  key = "openai_hair_v1";
  available() { return !!process.env.OPENAI_API_KEY; }
  async generate(input: HairSimulationInput) {
    try {
      const paramLine = describeParametersSafely(input.parameters);
      const finalPrompt = `${SAFETY_PROMPT_HAIR}\n\nPARÂMETROS DA MUDANÇA:\n${paramLine}`;
      const b64 = await VisualGenerationKernel.editImages(
        [{ buffer: input.avatar, name: "avatar.jpg", mime: "image/jpeg" }],
        finalPrompt,
        { inputFidelity: "high", quality: "medium", size: "1024x1024" },
      );
      if (!b64) return { ok: false as const, error: "Provedor OpenAI não retornou imagem.", retryable: true };
      return { ok: true as const, b64 };
    } catch (e: any) {
      const msg = String(e?.message || "Falha no provedor OpenAI");
      const status = Number((e as any)?.status || 0);
      const retryable = !(status >= 400 && status < 500);
      return { ok: false as const, error: msg.slice(0, 200), retryable };
    }
  }
}

/**
 * Google Gemini (produção — FALLBACK quando o OpenAI falha ou não responde).
 * Reusa `editImagesGoogleB64` (mesma função que o Fashion Studio try-on
 * chama, ADR-042) — API `gemini-2.0-flash-exp` por default. Disponível
 * quando `GOOGLE_AI_API_KEY`/`GEMINI_API_KEY` estão setadas.
 */
class GoogleGeminiHairSimulationProvider implements HairSimulationProvider {
  key = "google_gemini_hair_v1";
  available() { return !!(process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY); }
  async generate(input: HairSimulationInput) {
    try {
      const images = [{ buffer: input.avatar, mime: "image/jpeg" }];
      const paramLine = describeParametersSafely(input.parameters);
      const finalPrompt = `${SAFETY_PROMPT_HAIR}\n\nPARÂMETROS DA MUDANÇA:\n${paramLine}`;
      const b64 = await VisualGenerationKernel.editImagesGoogle(images, finalPrompt);
      if (!b64) return { ok: false as const, error: "Provedor Google não retornou imagem.", retryable: true };
      return { ok: true as const, b64 };
    } catch (e: any) {
      const msg = String(e?.message || "Falha no provedor Google");
      const status = Number(msg.match(/Gemini (\d+)/)?.[1] || 0);
      const retryable = !(status >= 400 && status < 500);
      return { ok: false as const, error: msg.slice(0, 200), retryable };
    }
  }
}

/**
 * Descreve parâmetros em linguagem CONTROLADA (RN-BS-11 — nunca texto
 * arbitrário no prompt). Cada campo é validado contra o vocabulário fechado
 * antes de virar parte do prompt.
 */
function describeParametersSafely(p: HairSimulationParameters): string {
  const parts: string[] = [];
  if (p.color && COLOR_VOCAB.has(String(p.color))) {
    parts.push(`Cor desejada do cabelo: ${p.color}.`);
  }
  if (p.cut && CUT_VOCAB.has(String(p.cut))) {
    parts.push(`Corte desejado: ${p.cut}.`);
  }
  if (!parts.length) parts.push("Manter cor e corte atuais (apenas ajuste natural).");
  return parts.join(" ");
}

const PROVIDERS: Record<string, HairSimulationProvider> = {
  stub: new StubHairSimulationProvider(),
  openai: new OpenAIHairSimulationProvider(),
  google_gemini: new GoogleGeminiHairSimulationProvider(),
};

// Ordem de preferência (decisão do operador): OpenAI PRIMÁRIO → Google
// FALLBACK → Stub (só quando nenhum real está configurado). O env
// `BEAUTY_HAIR_SIMULATION_PROVIDER` continua mandando quando setado.
function activeProvider(): HairSimulationProvider {
  const explicit = process.env.BEAUTY_HAIR_SIMULATION_PROVIDER;
  if (explicit && PROVIDERS[explicit]) return PROVIDERS[explicit];
  if (PROVIDERS.openai.available()) return PROVIDERS.openai;
  if (PROVIDERS.google_gemini.available()) return PROVIDERS.google_gemini;
  return PROVIDERS.stub;
}

/**
 * Cadeia de fallback do processJob: se o provider primário FALHAR em runtime
 * (erro/timeout/sem imagem), tenta o próximo provider REAL disponível antes
 * de marcar FAILED. Nunca cai pro stub como fallback de produção (imagem 1x1
 * no lugar de uma falha explícita seria PIOR que o erro honesto).
 */
function fallbackProvidersFor(primaryKey: string): HairSimulationProvider[] {
  const order = [PROVIDERS.openai, PROVIDERS.google_gemini];
  return order.filter((p) => p.key !== primaryKey && p.available());
}

/**
 * Resolve o provider a partir do `provider_key` GRAVADO na linha (ex.:
 * "openai_hair_v1"). BUG histórico (F25→F29): o `processJob` fazia
 * `PROVIDERS[job.provider_key]`, mas `PROVIDERS` é indexado por "stub"/
 * "openai"/"google_gemini", NÃO pelo `.key` ("stub_v1"/"openai_hair_v1"/
 * "google_gemini_hair_v1"). O lookup dava SEMPRE `undefined` e caía no stub —
 * então TODA geração de produção saía como o quadrado 1x1, mesmo com o OpenAI
 * ativo e escolhido no pedido. Os testes não pegavam porque em CI o provider é
 * o stub mesmo (o lookup quebrado "acertava" por acidente). Aqui casamos pelo
 * `.key` de verdade. */
export function providerByStoredKey(storedKey: string): HairSimulationProvider | null {
  return Object.values(PROVIDERS).find((p) => p.key === storedKey) || null;
}

/**
 * Registra um provider (SÓ para teste) — permite exercitar a resolução do
 * `processJob` ponta-a-ponta sem chamada de rede a IA real. Não usar em
 * produção. */
export function __registerHairProviderForTest(id: string, provider: HairSimulationProvider): void {
  PROVIDERS[id] = provider;
}

// ─────────────────────────── SERVICE ───────────────────────────

export interface BeautyVisualSimulationRow {
  id: string;
  organizationId: string;
  consultationId: string;
  avatarId: string;
  simulationType: SimulationType;
  parameters: HairSimulationParameters;
  referenceLookId: string | null;
  providerKey: string;
  inputHash: string;
  status: SimulationStatus;
  outputStorageKey: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  signedUrl?: string | null;
}

export class BeautyHairSimulationService {
  /** Provider ATIVO (útil pra rota `/status` e pra teste). */
  static providerKey(): string { return activeProvider().key; }

  /**
   * F28 — Diagnóstico do simulador (owner/admin). Diz a VERDADE sobre o que o
   * PROCESSO do servidor enxerga: qual provider está ativo, se é REAL (gera
   * imagem de verdade) ou o STUB de demonstração, e QUAIS chaves de IA estão
   * presentes no ambiente. Nunca expõe o valor da chave — só o booleano de
   * presença. Serve pra transformar "por que aparece um quadrado colorido?"
   * numa resposta observável: se `isReal=false`, a chave não chegou ao
   * container (config do Coolify), não é bug do app.
   */
  static simulatorStatus(orgId: string): {
    activeProviderKey: string;
    isReal: boolean;
    explicitOverride: string | null;
    keys: { openai: boolean; google: boolean; gemini: boolean };
    lastSimulation: { status: SimulationStatus; providerKey: string; errorMessageSafe: string | null; createdAt: string } | null;
  } {
    const provider = activeProvider();
    const last = db.prepare(
      `SELECT status, provider_key, error_message_safe, created_at
         FROM beauty_visual_simulations
        WHERE organization_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(orgId) as any;
    return {
      activeProviderKey: provider.key,
      isReal: provider.key !== "stub_v1",
      explicitOverride: process.env.BEAUTY_HAIR_SIMULATION_PROVIDER || null,
      keys: {
        openai: !!process.env.OPENAI_API_KEY,
        google: !!process.env.GOOGLE_AI_API_KEY,
        gemini: !!process.env.GEMINI_API_KEY,
      },
      lastSimulation: last
        ? { status: last.status, providerKey: last.provider_key, errorMessageSafe: last.error_message_safe, createdAt: last.created_at }
        : null,
    };
  }

  /** Vocabulário para UI (rota `/api/beauty/simulation/vocabulary` no F7+). */
  static vocabulary(): { colors: string[]; cuts: string[]; types: readonly string[]; goals: ReadonlyArray<{ value: string; label: string }> } {
    return { colors: [...COLOR_VOCAB], cuts: [...CUT_VOCAB], types: SIMULATION_TYPES, goals: CONSULTATION_GOALS };
  }

  /**
   * Requisita uma simulação. Pré-condições:
   *  (a) consulta existe na org em status='ready' (foto aprovada — F5);
   *  (b) contato da consulta tem consent `hair_simulation` ativo;
   *  (c) parâmetros validados contra vocabulário fechado.
   * Idempotência: mesmo (avatar+params+provider) já SUCCEEDED devolve o
   * job anterior sem tocar no provider.
   *
   * Enfileira no `JobQueueService` com `maxAttempts:1` (retry caro =
   * decisão humana, nunca automático).
   */
  static requestSimulation(
    orgId: string,
    consultationId: string,
    input: { simulationType: SimulationType; parameters?: HairSimulationParameters },
  ): { ok: true; simulationId: string; status: SimulationStatus; reused: boolean; providerKey: string } | { ok: false; error: string } {
    if (!(SIMULATION_TYPES as readonly string[]).includes(input.simulationType)) {
      return { ok: false, error: `simulationType inválido: ${input.simulationType}` };
    }
    const consultation = BeautyVisualConsultationService.getConsultation(orgId, consultationId);
    if (!consultation) return { ok: false, error: "Consulta não encontrada." };
    // F27: 'selected' também simula — escolher um visual ("Quero esse") não
    // congela a exploração; a cliente ainda troca cor/corte antes de agendar
    // (RN-BS-01: seleção ≠ agendamento). 'scheduled' encerra a exploração e
    // 'draft' segue exigindo foto aprovada.
    if (consultation.status !== "ready" && consultation.status !== "selected") {
      const hint = consultation.status === "draft"
        ? "envie e aprove a foto antes de simular"
        : "a consulta já virou agendamento — abra uma consulta nova";
      return { ok: false, error: `Consulta em status '${consultation.status}' — ${hint}.` };
    }
    if (!consultation.contactId) return { ok: false, error: "Consulta sem contato." };

    // Belt-and-suspenders: revalida consent (RN-BS-04) — a F5 checou no
    // upload, mas o dono pode ter revogado entre upload e requestSimulation.
    if (!BeautyVisualConsultationService.hasConsent(orgId, consultation.contactId, "hair_simulation")) {
      return { ok: false, error: "Consent 'hair_simulation' revogado — não é possível gerar simulação." };
    }

    // Busca o asset da referência da consulta (APPROVED).
    const asset = db.prepare(
      `SELECT id, storage_key FROM beauty_avatar_assets
        WHERE organization_id = ? AND consultation_id = ? AND status = 'approved'
        ORDER BY created_at DESC LIMIT 1`,
    ).get(orgId, consultationId) as any;
    if (!asset?.storage_key) return { ok: false, error: "Foto da consulta não está aprovada." };

    const params = sanitizeParameters(input.parameters || {});

    // Se `referenceLookId` foi passado, checa que é do mesmo tenant
    // (RN-BS-02 + RN-BS-07). Se for de outra org, ignora silenciosamente
    // (não lança — não queremos vazar existência).
    let referenceLookId: string | null = null;
    if (params.referenceLookId) {
      const look = db.prepare(
        `SELECT id FROM beauty_reference_looks WHERE id = ? AND organization_id = ? AND active = 1`,
      ).get(params.referenceLookId, orgId) as any;
      if (look) referenceLookId = look.id;
      // Se não achou (outra org ou inativo), remove do params pra não entrar
      // no hash de idempotência.
      params.referenceLookId = referenceLookId;
    }

    const provider = activeProvider();
    if (!provider.available()) {
      return { ok: false, error: "Simulador temporariamente indisponível — tente mais tarde." };
    }
    // F28 — STUB HONESTO (robusto, sem depender de NODE_ENV): o stub gera um
    // quadrado colorido de DEMONSTRAÇÃO, não um visual. Se ele foi alcançado
    // como ÚLTIMO RECURSO (nenhuma chave de IA visível pro processo) e NÃO
    // foi escolhido explicitamente via BEAUTY_HAIR_SIMULATION_PROVIDER=stub,
    // recusar com instrução clara é melhor que "suceder" com o bloco colorido
    // — o dono descobre na hora que a chave não chegou ao servidor. CI/dev
    // seguem funcionando: lá o stub é opt-in EXPLÍCITO (env=stub), então esta
    // guarda não dispara. (A F27 gateava por NODE_ENV; o container do Coolify
    // nem sempre reporta 'production', então o gate silenciava — por isso F28
    // troca pra "stub implícito = recusa".)
    if (provider.key === "stub_v1" && process.env.BEAUTY_HAIR_SIMULATION_PROVIDER !== "stub") {
      return {
        ok: false,
        error: "Nenhuma IA de imagem configurada no servidor — defina OPENAI_API_KEY ou GOOGLE_AI_API_KEY/GEMINI_API_KEY nas variáveis de ambiente (e redeploy) para gerar imagens reais.",
      };
    }

    // F26 — REUSO POR CONTEÚDO (economia de geração). O hash usa o SHA do
    // CONTEÚDO da foto (não o id do upload) + org + contato + parâmetros:
    //  - mesma foto re-enviada numa consulta NOVA (cliente voltou no mês
    //    seguinte) → mesmo hash → reusa a imagem salva, zero custo de IA;
    //  - o PROVIDER fica FORA do hash — trocar OpenAI↔Google não invalida o
    //    acervo (uma imagem já gerada vale igual, o barato é reusar);
    //  - org+contato DENTRO do hash: colisão cross-tenant/cross-cliente é
    //    impossível por construção (além do filtro org na query — RN-BS-07).
    // Fallback: se o arquivo não puder ser lido agora, usa o id do upload
    // (comportamento antigo — nunca bloqueia o fluxo por causa do cache).
    let contentKey: string;
    try {
      const avatarBytes = fs.readFileSync(path.join(PRIVATE_MEDIA_DIR, safeStorageKey(asset.storage_key)));
      contentKey = crypto.createHash("sha256").update(avatarBytes).digest("hex");
    } catch { contentKey = String(asset.id); }
    const inputHash = crypto.createHash("sha256")
      .update(`${orgId}:${consultation.contactId}:${contentKey}:${stableStringify(params)}`)
      .digest("hex");

    // Idempotência/reuso: mesmo pedido já processando/pronto → devolve a
    // imagem salva (só SUCCEEDED com output vivo — purga vira EXPIRED e sai
    // deste filtro, então acervo purgado re-gera corretamente).
    // F27 — quarentena do stub: com provider REAL ativo, linha gerada pelo
    // stub (quadrado de demonstração) NUNCA satisfaz o pedido — regenera de
    // verdade. Provider-independência (F26) vale só entre providers reais.
    const existing = db.prepare(
      `SELECT id, status FROM beauty_visual_simulations
        WHERE organization_id = ? AND input_hash = ? AND status IN ('SUCCEEDED','QUEUED','PROCESSING')
          AND (? = 'stub_v1' OR provider_key != 'stub_v1')
        ORDER BY created_at DESC LIMIT 1`,
    ).get(orgId, inputHash, provider.key) as any;
    if (existing) {
      return { ok: true, simulationId: existing.id, status: existing.status as SimulationStatus, reused: true, providerKey: provider.key };
    }

    const simulationId = randomUUID();
    db.prepare(
      `INSERT INTO beauty_visual_simulations
         (id, organization_id, consultation_id, avatar_id, simulation_type,
          parameters_json, reference_look_id, provider_key, input_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED')`,
    ).run(
      simulationId, orgId, consultationId, asset.id, input.simulationType,
      JSON.stringify(params), referenceLookId, provider.key, inputHash,
    );
    try { logAuthEvent(orgId, null, simulationId, "BEAUTY_SIMULATION_QUEUED", { providerKey: provider.key, simulationType: input.simulationType }); } catch { /* noop */ }

    // maxAttempts:1 — retry caro é decisão humana (mesmo racional do Fashion).
    JobQueueService.enqueue("beauty_hair_simulation", { simulationId }, { organizationId: orgId, maxAttempts: 1 });

    return { ok: true, simulationId, status: "QUEUED", reused: false, providerKey: provider.key };
  }

  /**
   * Executa a simulação (handler da fila). Público pra o teste exercitar
   * direto — mesma decisão do FashionTryOnService.processJob.
   */
  static async processJob(simulationId: string): Promise<void> {
    const job = db.prepare(`SELECT * FROM beauty_visual_simulations WHERE id = ?`).get(simulationId) as any;
    if (!job || !["QUEUED"].includes(job.status)) return;
    db.prepare(
      `UPDATE beauty_visual_simulations SET status = 'PROCESSING', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(simulationId);

    const fail = (code: string, message: string) => {
      db.prepare(
        `UPDATE beauty_visual_simulations
            SET status = 'FAILED_FINAL', error_code = ?, error_message_safe = ?, completed_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      ).run(code, message.slice(0, 200), simulationId);
      try { logAuthEvent(job.organization_id, null, simulationId, "BEAUTY_SIMULATION_FAILED", { code }); } catch { /* noop */ }
    };

    try {
      // Lê o arquivo da foto de referência (private_media/beauty/*).
      const asset = db.prepare(
        `SELECT storage_key FROM beauty_avatar_assets WHERE id = ? AND organization_id = ? AND status = 'approved'`,
      ).get(job.avatar_id, job.organization_id) as any;
      if (!asset?.storage_key) return fail("avatar_missing", "Foto de referência indisponível — envie/aprove novamente.");
      let avatarFile: string;
      try { avatarFile = path.join(PRIVATE_MEDIA_DIR, safeStorageKey(asset.storage_key)); }
      catch { return fail("avatar_missing", "Chave de arquivo inválida."); }
      if (!fs.existsSync(avatarFile)) return fail("avatar_missing", "Arquivo da foto não está mais disponível.");

      // Executa o provider ESCOLHIDO no pedido (casado pelo `.key` gravado —
      // ver providerByStoredKey; antes o lookup quebrado caía sempre no stub).
      // Se a linha aponta um provider que não existe mais / não está
      // disponível, usa o ATIVO agora (nunca o stub silenciosamente — o stub
      // implícito já foi barrado no requestSimulation, F28). Se ele FALHAR em
      // runtime, tenta o próximo provider REAL (cadeia OpenAI→Google) antes de
      // marcar FAILED.
      const provider = providerByStoredKey(job.provider_key) || activeProvider();
      const params: HairSimulationParameters = job.parameters_json ? JSON.parse(job.parameters_json) : {};
      const avatar = fs.readFileSync(avatarFile);
      let result = await provider.generate({ avatar, parameters: params });
      let usedProviderKey = provider.key;
      if (!result.ok) {
        for (const fb of fallbackProvidersFor(provider.key)) {
          try { logAuthEvent(job.organization_id, null, simulationId, "BEAUTY_SIMULATION_FALLBACK", { from: usedProviderKey, to: fb.key, error: String((result as any).error || "").slice(0, 120) }); } catch { /* noop */ }
          result = await fb.generate({ avatar, parameters: params });
          usedProviderKey = fb.key;
          if (result.ok) break;
        }
      }
      if (!result.ok) {
        return fail((result as any).retryable ? "provider_error" : "provider_rejected", (result as any).error || "Falha do provedor.");
      }
      // Registra o provider que DE FATO gerou (fallback pode ter assumido).
      if (usedProviderKey !== job.provider_key) {
        db.prepare(`UPDATE beauty_visual_simulations SET provider_key = ? WHERE id = ?`).run(usedProviderKey, simulationId);
      }

      // Grava output em private_media/beauty/{uuid}.png (subdir isolado dos
      // avatares de referência, ambos protegidos pelo escopo assinado F5).
      const outputKey = `beauty/${randomUUID()}.png`;
      const outPath = path.join(PRIVATE_MEDIA_DIR, safeStorageKey(outputKey));
      fs.writeFileSync(outPath, Buffer.from(result.b64, "base64"));

      db.prepare(
        `UPDATE beauty_visual_simulations
            SET status = 'SUCCEEDED', output_storage_key = ?, completed_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      ).run(outputKey, simulationId);
      try { logAuthEvent(job.organization_id, null, simulationId, "BEAUTY_SIMULATION_SUCCEEDED", {}); } catch { /* noop */ }
    } catch (e: any) {
      console.error("[BeautyHairSim] job falhou", simulationId, e);
      fail("internal_error", String(e?.message || "Falha interna.").slice(0, 200));
    }
  }

  /** Cancela simulação QUEUED (não interrompe em curso). */
  static cancelSimulation(orgId: string, simulationId: string): boolean {
    const r = db.prepare(
      `UPDATE beauty_visual_simulations
          SET status = 'DELETED', completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND organization_id = ? AND status = 'QUEUED'`,
    ).run(simulationId, orgId);
    return r.changes > 0;
  }

  /**
   * F31 — Deleta uma simulação (qualquer status ≠ DELETED) do PRÓPRIO tenant:
   * apaga o arquivo de output e marca a linha como DELETED (preserva a linha
   * pro histórico de auditoria, mas some da UI e da galeria). O botão de
   * "deletar" da BeautyView chama isto. Idempotente. */
  static deleteSimulation(orgId: string, simulationId: string): boolean {
    const row = db.prepare(
      `SELECT output_storage_key FROM beauty_visual_simulations
        WHERE id = ? AND organization_id = ? AND status != 'DELETED'`,
    ).get(simulationId, orgId) as any;
    if (!row) return false;
    if (row.output_storage_key) {
      try { fs.rmSync(path.join(PRIVATE_MEDIA_DIR, safeStorageKey(row.output_storage_key)), { force: true }); }
      catch { /* anti-traversal / arquivo já sumiu */ }
    }
    db.prepare(
      `UPDATE beauty_visual_simulations
          SET status = 'DELETED', output_storage_key = NULL, completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND organization_id = ?`,
    ).run(simulationId, orgId);
    try { logAuthEvent(orgId, null, simulationId, "BEAUTY_SIMULATION_DELETED", {}); } catch { /* noop */ }
    return true;
  }

  /**
   * F31 — Limpeza dos STUBS LEGADOS (quadrados de demonstração 1x1 gerados
   * quando o servidor ainda não tinha chave de IA, antes do fix da F30). Apaga
   * arquivo + linha das simulações `provider_key='stub_v1'`. GUARDA DURA: só
   * roda quando um provider REAL está ativo — nunca apaga o acervo de um
   * ambiente que usa o stub de propósito (CI/demo com opt-in explícito).
   * Rodado uma vez por boot no Scheduler; idempotente (some após a 1ª limpeza).
   * Retorna quantas linhas foram removidas. */
  static purgeStubOutputs(): number {
    if (activeProvider().key === "stub_v1") return 0; // stub é o ativo → não mexe
    const rows = db.prepare(
      `SELECT id, output_storage_key FROM beauty_visual_simulations WHERE provider_key = 'stub_v1'`,
    ).all() as any[];
    for (const r of rows) {
      if (r.output_storage_key) {
        try { fs.rmSync(path.join(PRIVATE_MEDIA_DIR, safeStorageKey(r.output_storage_key)), { force: true }); }
        catch { /* anti-traversal */ }
      }
    }
    const info = db.prepare(`DELETE FROM beauty_visual_simulations WHERE provider_key = 'stub_v1'`).run();
    return info.changes;
  }

  /** Lê 1 simulação — inclui `signedUrl` só para SUCCEEDED. */
  static getSimulation(orgId: string, simulationId: string): BeautyVisualSimulationRow | null {
    const r = db.prepare(
      `SELECT * FROM beauty_visual_simulations WHERE id = ? AND organization_id = ?`,
    ).get(simulationId, orgId) as any;
    if (!r) return null;
    const row = rowToSimulation(r);
    if (row.status === "SUCCEEDED" && row.outputStorageKey) {
      row.signedUrl = BeautyVisualConsultationService.signedUrl(row.outputStorageKey);
    }
    return row;
  }

  /**
   * F26 — Histórico de visuais do CLIENTE (todas as consultas): as imagens já
   * geradas ficam salvas e podem ser REVISTAS sem custo de IA — a cliente que
   * volta no mês seguinte compara o acervo antes de decidir gerar algo novo.
   * Só SUCCEEDED com output vivo (purga por retenção vira EXPIRED e sai).
   */
  static listForContact(orgId: string, contactId: string, limit = 30): BeautyVisualSimulationRow[] {
    // F27: com provider REAL ativo, o acervo esconde saídas do stub
    // (quadrados de demonstração não são "visuais salvos" da cliente).
    const activeKey = activeProvider().key;
    const rows = db.prepare(
      `SELECT s.* FROM beauty_visual_simulations s
        JOIN beauty_visual_consultations c ON c.id = s.consultation_id AND c.organization_id = s.organization_id
       WHERE s.organization_id = ? AND c.contact_id = ? AND s.status = 'SUCCEEDED'
         AND (? = 'stub_v1' OR s.provider_key != 'stub_v1')
       ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`,
    ).all(orgId, contactId, activeKey, Math.max(1, Math.min(100, limit))) as any[];
    return rows.map((r) => {
      const row = rowToSimulation(r);
      if (row.outputStorageKey) row.signedUrl = BeautyVisualConsultationService.signedUrl(row.outputStorageKey);
      return row;
    });
  }

  /** Lista simulações de uma consulta (ordena mais recente primeiro). */
  static listForConsultation(orgId: string, consultationId: string): BeautyVisualSimulationRow[] {
    // F29: com provider REAL ativo, a seção "Resultados" esconde as saídas do
    // STUB (quadrados coloridos de demonstração que ficaram no acervo de
    // quando não havia chave de IA). Assim que a IA real entra, some o
    // entulho e só as imagens de verdade aparecem. Com stub explícito
    // (CI/demo) tudo continua visível.
    const activeKey = activeProvider().key;
    const rows = db.prepare(
      `SELECT * FROM beauty_visual_simulations
        WHERE organization_id = ? AND consultation_id = ? AND status != 'DELETED'
          AND (? = 'stub_v1' OR provider_key != 'stub_v1')
        ORDER BY created_at DESC`,
    ).all(orgId, consultationId, activeKey) as any[];
    return rows.map((r) => {
      const row = rowToSimulation(r);
      if (row.status === "SUCCEEDED" && row.outputStorageKey) {
        row.signedUrl = BeautyVisualConsultationService.signedUrl(row.outputStorageKey);
      }
      return row;
    });
  }

  /**
   * Purga por retenção (Scheduler pass — F16+). Apaga arquivo de outputs
   * SUCCEEDED vencidos usando a mesma janela dos avatares (`beauty_avatar_
   * retention_days` da org).
   */
  static purgeExpired(): number {
    const rows = db.prepare(`
      SELECT s.id, s.output_storage_key,
             COALESCE(NULLIF(o.beauty_avatar_retention_days, 0), 30) AS days,
             s.completed_at
        FROM beauty_visual_simulations s
        LEFT JOIN organization_settings o ON o.organization_id = s.organization_id
       WHERE s.status = 'SUCCEEDED' AND s.output_storage_key IS NOT NULL
         AND s.completed_at IS NOT NULL
         AND s.completed_at < datetime('now', '-' || COALESCE(NULLIF(o.beauty_avatar_retention_days, 0), 30) || ' days')
    `).all() as any[];
    for (const r of rows) {
      if (r.output_storage_key) {
        try {
          const safe = safeStorageKey(r.output_storage_key);
          fs.rmSync(path.join(PRIVATE_MEDIA_DIR, safe), { force: true });
        } catch { /* anti-traversal */ }
      }
      db.prepare(
        `UPDATE beauty_visual_simulations SET status = 'EXPIRED', output_storage_key = NULL WHERE id = ?`,
      ).run(r.id);
    }
    return rows.length;
  }
}

function rowToSimulation(r: any): BeautyVisualSimulationRow {
  return {
    id: r.id,
    organizationId: r.organization_id,
    consultationId: r.consultation_id,
    avatarId: r.avatar_id,
    simulationType: r.simulation_type,
    parameters: r.parameters_json ? JSON.parse(r.parameters_json) : {},
    referenceLookId: r.reference_look_id,
    providerKey: r.provider_key,
    inputHash: r.input_hash,
    status: r.status,
    outputStorageKey: r.output_storage_key,
    errorCode: r.error_code,
    errorMessageSafe: r.error_message_safe,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    signedUrl: null,
  };
}

/** Sanitiza params: só campos conhecidos + vocab fechado (RN-BS-11). */
function sanitizeParameters(p: HairSimulationParameters): HairSimulationParameters {
  return {
    color: p.color && COLOR_VOCAB.has(String(p.color)) ? String(p.color) : null,
    cut: p.cut && CUT_VOCAB.has(String(p.cut)) ? String(p.cut) : null,
    referenceLookId: p.referenceLookId ? String(p.referenceLookId).slice(0, 40) : null,
    notes: p.notes ? String(p.notes).slice(0, 200) : null,
  };
}

/** Estabiliza serialização pra hash (ordem de chaves determinística). */
function stableStringify(obj: any): string {
  if (obj == null) return "null";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k] ?? null)}`).join(",") + "}";
}

// Handler da fila — registrado no load do módulo. maxAttempts:1 no enqueue.
JobQueueService.registerHandler("beauty_hair_simulation", async (p: any) => {
  await BeautyHairSimulationService.processJob(p.simulationId);
  return { processed: true };
});
