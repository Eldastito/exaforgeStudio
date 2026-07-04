import fs from "fs";
import path from "path";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { editImagesB64, isAIConfigured } from "./llm.js";
import { JobQueueService } from "./JobQueueService.js";
import { FashionStudioService } from "./FashionStudioService.js";
import { FashionAvatarService } from "./FashionAvatarService.js";

/**
 * Orquestrador de try-on (Fashion AI Studio FAS-3, ADR-037) — a prévia
 * "look em você".
 *
 * Desenho (seções 9.2–9.4 do PRD):
 *  - PROVEDOR PLUGÁVEL: a geração fica atrás da interface TryOnProvider,
 *    selecionada por env (FASHION_TRYON_PROVIDER). O provedor padrão usa a
 *    edição multi-imagem da OpenAI (foto da cliente + fotos reais das peças);
 *    trocar de provedor (serviço dedicado de try-on, endpoint privado, modelo
 *    local) é registrar outra implementação — nada no orquestrador muda.
 *  - CRÉDITOS (9.3): janela DIÁRIA por cliente com o limite da loja (FAS-0,
 *    padrão 3). Reserva no aceite do job; consome no sucesso; FALHA TÉCNICA
 *    devolve automaticamente; resultado ruim NÃO devolve (política do PRD).
 *  - IDEMPOTÊNCIA/ECONOMIA: input_hash (avatar + itens do look + provedor).
 *    Mesmo pedido já SUCCEEDED → devolve o resultado pronto SEM gastar
 *    crédito nem IA (mesmo princípio "consultar antes de gastar" da ADR-032).
 *  - FILA: JobQueueService (existente) com maxAttempts=1 — o retry de custo
 *    caro é decisão do cliente (botão), nunca automático/silencioso.
 *  - RESULTADO PRIVADO: mesmo diretório privado e URL assinada do avatar
 *    (FAS-1); nunca /media público; purga pela mesma retenção da loja.
 *  - SEGURANÇA DO PROMPT (19.2): identidade/rosto preservados, sem nudez/
 *    sexualização, sem mudar idade aparente, sem pessoas extras — fixo no
 *    provedor, nunca vindo de texto do catálogo ou da cliente.
 */

const PRIVATE_MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "private_media");
try { fs.mkdirSync(PRIVATE_MEDIA_DIR, { recursive: true }); } catch (e) { /* noop */ }
const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");

export interface TryOnProvider {
  key: string;
  available(): boolean;
  generate(input: { avatar: Buffer; garments: { name: string; buffer: Buffer; mime: string }[]; notes: string }):
    Promise<{ ok: true; b64: string } | { ok: false; error: string; retryable: boolean }>;
}

// Prompt de segurança FIXO (19.2) — nunca composto com texto do catálogo/cliente.
const SAFETY_PROMPT =
  "Vista a pessoa da primeira imagem com as peças de roupa mostradas nas demais imagens, como uma prévia realista de provador virtual. " +
  "Regras invioláveis: preserve exatamente o rosto, a identidade, o tom de pele, o cabelo e a idade aparente da pessoa; " +
  "não adicione outras pessoas; nenhuma nudez, roupa íntima exposta ou sexualização; " +
  "mantenha as peças fiéis às fotos originais (cor, estampa, modelagem); fundo neutro de estúdio.";

class OpenAIEditTryOnProvider implements TryOnProvider {
  key = "openai_edit";
  available(): boolean { return isAIConfigured(); }
  async generate(input: { avatar: Buffer; garments: { name: string; buffer: Buffer; mime: string }[]; notes: string }) {
    try {
      const images = [
        { buffer: input.avatar, name: "pessoa.jpg", mime: "image/jpeg" },
        ...input.garments.map((g, i) => ({ buffer: g.buffer, name: `peca-${i + 1}${path.extname(g.name) || ".jpg"}`, mime: g.mime })),
      ];
      const b64 = await editImagesB64(images, SAFETY_PROMPT);
      if (!b64) return { ok: false as const, error: "Provedor não retornou imagem.", retryable: true };
      return { ok: true as const, b64 };
    } catch (e: any) {
      // 4xx (ex.: moderação) = definitivo; resto = tecnicamente re-tentável.
      const status = Number(e?.status || e?.response?.status || 0);
      const retryable = !(status >= 400 && status < 500);
      return { ok: false as const, error: String(e?.message || "Falha no provedor").slice(0, 200), retryable };
    }
  }
}

const PROVIDERS: Record<string, TryOnProvider> = {
  openai_edit: new OpenAIEditTryOnProvider(),
};

function activeProvider(): TryOnProvider {
  return PROVIDERS[process.env.FASHION_TRYON_PROVIDER || "openai_edit"] || PROVIDERS.openai_edit;
}

export class FashionTryOnService {
  // ---- créditos (9.3): janela diária por cliente ----

  private static creditRow(orgId: string, customerId: string): any {
    let row = db.prepare(
      `SELECT * FROM fashion_usage_credits WHERE organization_id = ? AND customer_id = ? AND window_start = date('now')`
    ).get(orgId, customerId) as any;
    if (!row) {
      db.prepare(
        `INSERT INTO fashion_usage_credits (id, organization_id, customer_id, window_start, window_end, limit_total, used_count, reserved_count)
         VALUES (?, ?, ?, date('now'), date('now', '+1 day'), ?, 0, 0)`
      ).run(uuidv4(), orgId, customerId, FashionStudioService.dailyGenerationLimit(orgId));
      row = db.prepare(`SELECT * FROM fashion_usage_credits WHERE organization_id = ? AND customer_id = ? AND window_start = date('now')`).get(orgId, customerId);
    }
    return row;
  }

  static creditsAvailable(orgId: string, customerId: string): { available: number; limit: number } {
    const row = this.creditRow(orgId, customerId);
    return { available: Math.max(0, row.limit_total - row.used_count - row.reserved_count), limit: row.limit_total };
  }

  private static reserveCredit(orgId: string, customerId: string): boolean {
    const row = this.creditRow(orgId, customerId);
    const r = db.prepare(
      `UPDATE fashion_usage_credits SET reserved_count = reserved_count + 1
       WHERE id = ? AND (limit_total - used_count - reserved_count) > 0`
    ).run(row.id);
    return r.changes > 0;
  }

  private static consumeCredit(orgId: string, customerId: string): void {
    const row = this.creditRow(orgId, customerId);
    db.prepare(`UPDATE fashion_usage_credits SET reserved_count = MAX(0, reserved_count - 1), used_count = used_count + 1 WHERE id = ?`).run(row.id);
  }

  private static refundCredit(orgId: string, customerId: string): void {
    const row = this.creditRow(orgId, customerId);
    db.prepare(`UPDATE fashion_usage_credits SET reserved_count = MAX(0, reserved_count - 1) WHERE id = ?`).run(row.id);
  }

  // ---- criação do job ----

  static requestGeneration(orgId: string, customerId: string, lookId: string):
    { ok: true; jobId: string; status: string; reused: boolean } | { ok: false; error: string } {
    // Look da própria cliente (via request) — ownership igual ao saveLook.
    const look = db.prepare(
      `SELECT fl.id FROM fashion_looks fl JOIN fashion_look_requests flr ON flr.id = fl.request_id
       WHERE fl.id = ? AND fl.organization_id = ? AND flr.customer_id = ?`
    ).get(lookId, orgId, customerId) as any;
    if (!look) return { ok: false, error: "Look não encontrado." };

    const avatar = db.prepare(
      `SELECT id, storage_key FROM fashion_avatar_assets WHERE organization_id = ? AND customer_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1`
    ).get(orgId, customerId) as any;
    if (!avatar?.storage_key) return { ok: false, error: "Envie e valide sua foto antes de gerar a prévia." };

    const items = db.prepare(
      `SELECT product_service_id FROM fashion_look_items WHERE look_id = ? AND organization_id = ? ORDER BY product_service_id ASC`
    ).all(lookId, orgId) as any[];
    if (!items.length) return { ok: false, error: "Este look não tem peças." };

    const provider = activeProvider();
    if (!provider.available()) return { ok: false, error: "O provador está temporariamente indisponível. Tente mais tarde." };

    // Idempotência/economia: mesmo avatar + mesmas peças + mesmo provedor já
    // gerado com sucesso → devolve pronto, sem crédito nem IA.
    const inputHash = crypto.createHash("sha256")
      .update(`${avatar.id}:${items.map((i) => i.product_service_id).join(",")}:${provider.key}`).digest("hex");
    const existing = db.prepare(
      `SELECT id, status FROM fashion_tryon_jobs WHERE organization_id = ? AND customer_id = ? AND input_hash = ? AND status IN ('SUCCEEDED', 'QUEUED', 'PROCESSING') ORDER BY created_at DESC LIMIT 1`
    ).get(orgId, customerId, inputHash) as any;
    if (existing) return { ok: true, jobId: existing.id, status: existing.status, reused: true };

    if (!this.reserveCredit(orgId, customerId)) {
      const { limit } = this.creditsAvailable(orgId, customerId);
      return { ok: false, error: `Você usou suas ${limit} prévias de hoje. Amanhã tem mais! Enquanto isso, dá para salvar looks e comprar normalmente.` };
    }

    const jobId = uuidv4();
    db.prepare(
      `INSERT INTO fashion_tryon_jobs (id, organization_id, customer_id, look_id, provider_key, status, input_hash)
       VALUES (?, ?, ?, ?, ?, 'QUEUED', ?)`
    ).run(jobId, orgId, customerId, lookId, provider.key, inputHash);
    FashionStudioService.recordEvent(orgId, "FashionTryOnQueued", { providerKey: provider.key }, customerId, jobId);

    // maxAttempts=1: repetir uma geração cara é decisão da CLIENTE (botão),
    // nunca retry automático silencioso — mesmo racional da ADR-029.
    JobQueueService.enqueue("fashion_tryon", { jobId }, { organizationId: orgId, maxAttempts: 1 });
    return { ok: true, jobId, status: "QUEUED", reused: false };
  }

  /** Executa o job (handler da fila). Não-privado para o teste exercitar diretamente. */
  static async processJob(jobId: string): Promise<void> {
    const job = db.prepare(`SELECT * FROM fashion_tryon_jobs WHERE id = ?`).get(jobId) as any;
    if (!job || !["QUEUED", "FAILED_RETRYABLE"].includes(job.status)) return;
    db.prepare(`UPDATE fashion_tryon_jobs SET status = 'PROCESSING', started_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobId);

    const fail = (code: string, message: string, refund: boolean) => {
      db.prepare(`UPDATE fashion_tryon_jobs SET status = 'FAILED_FINAL', error_code = ?, error_message_safe = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(code, message, jobId);
      if (refund) this.refundCredit(job.organization_id, job.customer_id); // falha técnica devolve (9.3)
      FashionStudioService.recordEvent(job.organization_id, "FashionTryOnFailed", { code }, job.customer_id, jobId);
    };

    try {
      const avatar = db.prepare(
        `SELECT storage_key FROM fashion_avatar_assets WHERE organization_id = ? AND customer_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1`
      ).get(job.organization_id, job.customer_id) as any;
      const avatarFile = avatar?.storage_key ? path.join(PRIVATE_MEDIA_DIR, path.basename(avatar.storage_key)) : null;
      if (!avatarFile || !fs.existsSync(avatarFile)) return fail("avatar_missing", "Sua foto não está mais disponível. Envie uma nova.", true);

      // Fotos reais das peças (foto de estúdio da ADR-032 tem prioridade — é a
      // versão mais limpa para o provedor compor).
      const items = db.prepare(
        `SELECT ps.id, ps.name, ps.studio_image_url,
                (SELECT url FROM product_images pi WHERE pi.product_service_id = ps.id ORDER BY position ASC, created_at ASC LIMIT 1) AS cover
         FROM fashion_look_items fli JOIN products_services ps ON ps.id = fli.product_service_id
         WHERE fli.look_id = ? AND fli.organization_id = ?`
      ).all(job.look_id, job.organization_id) as any[];
      const garments: { name: string; buffer: Buffer; mime: string }[] = [];
      for (const it of items.slice(0, 4)) { // 1 avatar + até 4 peças por chamada
        const url = it.studio_image_url || it.cover;
        if (!url || !url.startsWith("/media/")) continue;
        const file = path.join(MEDIA_DIR, path.basename(url));
        if (!fs.existsSync(file)) continue;
        const ext = path.extname(file).toLowerCase();
        garments.push({ name: it.name, buffer: fs.readFileSync(file), mime: ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg" });
      }
      if (!garments.length) return fail("garments_missing", "As fotos das peças deste look não estão disponíveis.", true);

      const result = await activeProvider().generate({ avatar: fs.readFileSync(avatarFile), garments, notes: "" });
      if (!result.ok) {
        return fail((result as any).retryable ? "provider_error" : "provider_rejected",
          "Não foi possível gerar sua prévia agora. Seu crédito foi devolvido — tente novamente.", true);
      }

      const outputKey = `${uuidv4()}.png`;
      fs.writeFileSync(path.join(PRIVATE_MEDIA_DIR, outputKey), Buffer.from(result.b64, "base64"));
      db.prepare(`UPDATE fashion_tryon_jobs SET status = 'SUCCEEDED', output_storage_key = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(outputKey, jobId);
      db.prepare(`UPDATE fashion_looks SET status = 'generated' WHERE id = ?`).run(job.look_id);
      this.consumeCredit(job.organization_id, job.customer_id); // consome SÓ no sucesso
      FashionStudioService.recordEvent(job.organization_id, "FashionTryOnSucceeded", {}, job.customer_id, jobId);
    } catch (e: any) {
      console.error("[FashionTryOn] Job falhou", jobId, e);
      fail("internal_error", "Não foi possível gerar sua prévia agora. Seu crédito foi devolvido — tente novamente.", true);
    }
  }

  // ---- consulta e cancelamento ----

  static getJob(orgId: string, customerId: string, jobId: string): { id: string; status: string; url: string | null; error: string | null; credits: { available: number; limit: number } } | null {
    const job = db.prepare(`SELECT * FROM fashion_tryon_jobs WHERE id = ? AND organization_id = ? AND customer_id = ?`).get(jobId, orgId, customerId) as any;
    if (!job) return null;
    return {
      id: job.id, status: job.status,
      url: job.status === "SUCCEEDED" && job.output_storage_key ? FashionAvatarService.signedUrl(job.output_storage_key) : null,
      error: job.error_message_safe || null,
      credits: this.creditsAvailable(orgId, customerId),
    };
  }

  /** Cancelamento (RF-024): só enquanto está na fila — devolve o crédito reservado. */
  static cancelJob(orgId: string, customerId: string, jobId: string): boolean {
    const r = db.prepare(
      `UPDATE fashion_tryon_jobs SET status = 'DELETED', completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ? AND customer_id = ? AND status = 'QUEUED'`
    ).run(jobId, orgId, customerId);
    if (r.changes > 0) { this.refundCredit(orgId, customerId); return true; }
    return false;
  }

  /** Purga por retenção (Scheduler): apaga o ARQUIVO do resultado vencido, mesma janela do avatar. */
  static purgeExpired(): number {
    const rows = db.prepare(`
      SELECT j.id, j.output_storage_key, s.fashion_avatar_retention_days AS days
      FROM fashion_tryon_jobs j
      LEFT JOIN storefront_settings s ON s.organization_id = j.organization_id
      WHERE j.status = 'SUCCEEDED' AND j.output_storage_key IS NOT NULL
        AND j.completed_at < datetime('now', '-' || COALESCE(NULLIF(s.fashion_avatar_retention_days, 0), 30) || ' days')
    `).all() as any[];
    for (const r of rows) {
      try { fs.rmSync(path.join(PRIVATE_MEDIA_DIR, path.basename(r.output_storage_key)), { force: true }); } catch { /* noop */ }
      db.prepare(`UPDATE fashion_tryon_jobs SET status = 'EXPIRED', output_storage_key = NULL WHERE id = ?`).run(r.id);
    }
    return rows.length;
  }
}

// Handler da fila — registrado no load do módulo (importado pelas rotas, que
// o server.ts carrega no boot). maxAttempts=1 no enqueue: sem retry automático.
JobQueueService.registerHandler("fashion_tryon", async (p: any) => {
  await FashionTryOnService.processJob(p.jobId);
  return { processed: true };
});
