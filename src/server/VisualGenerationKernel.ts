/**
 * VisualGenerationKernel — dono canônico de `image.generation` (DUP-004).
 *
 * Antes, cada domínio visual (Studio/Visual Recipes, Fashion Try-On, Beauty AI)
 * falava direto com as primitivas do `llm.ts`, cada um com sua fila/hash/storage.
 * Este kernel centraliza o essencial:
 *   - HASH CANÔNICO da entrada (operação + prompt + size + refs) → chave de reuso;
 *   - REUSO de imagem idêntica: a MESMA entrada, na MESMA org, NÃO chama o
 *     provider de novo — reaproveita a mídia já gerada (economia de IA + latência);
 *   - roteamento de PROVIDER (Google Imagen → OpenAI, via `llm.ts`), com override
 *     injetável para testes;
 *   - STORAGE local da mídia + registro de metering/observabilidade no cache.
 *
 * Fronteira: determinístico até chamar o provider. Isolado por `organization_id`.
 * O Studio (Visual Recipe Engine) é o primeiro caller a usar o kernel; Fashion e
 * Beauty migram como fachadas em incrementos seguintes (mesmo contrato).
 */
import { randomUUID, createHash } from "crypto";
import path from "path";
import fs from "fs";
import db from "./db.js";
import { generateImageB64 as defaultGenerateImageB64 } from "./llm.js";

export type KernelSize = "1024x1024" | "1024x1536" | "1536x1024";

const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch { /* noop */ }

export interface KernelGenerateInput {
  orgId: string;
  prompt: string;
  size: KernelSize;
  operation?: string;      // "generate" (default). "edit" fica reservado p/ Fashion/Beauty.
  recipeKey?: string;      // metadado p/ metering/observabilidade
  extraKey?: string;       // entra no hash — ex.: hash das imagens de referência
}

export interface KernelGenerateResult {
  mediaUrl: string;
  inputHash: string;
  reused: boolean;         // true = veio do cache (não pagou provider)
  provider: string;
  size: KernelSize;
}

// Provider injetável (testes substituem por adapter fake). Default = llm.ts.
type ImageProvider = (prompt: string, size: KernelSize) => Promise<string>;
let moduleProvider: ImageProvider = (p, s) => defaultGenerateImageB64(p, s);

export class VisualGenerationKernel {
  static configureProvider(fn: ImageProvider): void { moduleProvider = fn; }
  static resetProvider(): void { moduleProvider = (p, s) => defaultGenerateImageB64(p, s); }

  /** Hash canônico determinístico da entrada — a chave de reuso. */
  static canonicalHash(input: { operation: string; prompt: string; size: string; extraKey?: string }): string {
    const norm = JSON.stringify({
      o: input.operation,
      p: (input.prompt || "").trim(),
      s: input.size,
      x: input.extraKey || "",
    });
    return createHash("sha256").update(norm).digest("hex");
  }

  /** Nome do provider que será (ou foi) usado — só p/ registro/observabilidade. */
  private static providerName(): string {
    return (process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY) ? "gemini_imagen" : "openai_gpt_image";
  }

  private static absFromUrl(mediaUrl: string): string {
    return path.join(MEDIA_DIR, path.basename(mediaUrl));
  }

  /**
   * Gera (ou reaproveita) uma imagem. Se `providerOverride` vier, ele é usado no
   * lugar do provider do módulo (o Studio passa o seu para preservar injeção de
   * teste). Reuso: cache hit por (org, input_hash) com o arquivo ainda no disco.
   */
  static async generate(input: KernelGenerateInput, providerOverride?: ImageProvider): Promise<KernelGenerateResult> {
    if (!input.orgId) throw new Error("orgId é obrigatório");
    const operation = input.operation || "generate";
    const inputHash = this.canonicalHash({ operation, prompt: input.prompt, size: input.size, extraKey: input.extraKey });

    // 1) REUSO — cache hit com arquivo presente.
    const cached = db.prepare(
      "SELECT media_url, provider FROM visual_generation_cache WHERE organization_id = ? AND input_hash = ?"
    ).get(input.orgId, inputHash) as any;
    if (cached?.media_url) {
      if (fs.existsSync(this.absFromUrl(cached.media_url))) {
        try {
          db.prepare("UPDATE visual_generation_cache SET hits = hits + 1, last_used_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND input_hash = ?")
            .run(input.orgId, inputHash);
        } catch { /* noop */ }
        return { mediaUrl: cached.media_url, inputHash, reused: true, provider: cached.provider || "cache", size: input.size };
      }
      // Arquivo sumiu (limpeza/rotação) → remove a linha órfã e regenera.
      try { db.prepare("DELETE FROM visual_generation_cache WHERE organization_id = ? AND input_hash = ?").run(input.orgId, inputHash); } catch { /* noop */ }
    }

    // 2) GERA no provider e persiste.
    const provider = providerOverride || moduleProvider;
    const b64 = await provider(input.prompt, input.size);
    if (!b64) throw new Error("provider retornou vazio");
    const name = `${randomUUID()}.png`;
    fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.from(b64, "base64"));
    const mediaUrl = `/media/${name}`;
    const providerLabel = this.providerName();
    try {
      db.prepare(
        `INSERT INTO visual_generation_cache (id, organization_id, input_hash, operation, provider, media_url, size, recipe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, input_hash) DO UPDATE SET
           media_url = excluded.media_url, provider = excluded.provider, last_used_at = CURRENT_TIMESTAMP`
      ).run(randomUUID(), input.orgId, inputHash, operation, providerLabel, mediaUrl, input.size, input.recipeKey || null);
    } catch { /* noop — cache é best-effort, não bloqueia a entrega */ }

    return { mediaUrl, inputHash, reused: false, provider: providerLabel, size: input.size };
  }

  /** Métricas de reuso por org (quantas entradas em cache, quantos reaproveitamentos). */
  static stats(orgId: string): { cached: number; reusedHits: number } {
    try {
      const r = db.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS reused FROM visual_generation_cache WHERE organization_id = ?"
      ).get(orgId) as any;
      return { cached: Number(r?.n || 0), reusedHits: Number(r?.reused || 0) };
    } catch { return { cached: 0, reusedHits: 0 }; }
  }
}

export default VisualGenerationKernel;
