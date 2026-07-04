/**
 * TESTE — Fashion AI Studio FAS-3: orquestrador de try-on (ADR-037)
 * -------------------------------------------------------------------------
 * A GERAÇÃO em si exige a chave de IA de produção (mesma limitação de
 * sempre); tudo ao redor dela — que é onde mora o dinheiro e o risco — é
 * determinístico e coberto aqui:
 *   - créditos por janela diária: reserva no aceite, consumo só no sucesso,
 *     ESTORNO automático em falha técnica, limite da loja respeitado;
 *   - idempotência por input_hash: mesmo pedido não gasta crédito de novo;
 *   - ownership: look de outra cliente/organização não gera; sem avatar
 *     aprovado não gera;
 *   - cancelamento só na fila, com estorno;
 *   - purga por retenção apaga o ARQUIVO do resultado;
 *   - job sem chave de IA falha como FAILED_FINAL com crédito devolvido.
 *
 * Uso: npm run test:fashion-tryon
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fashion-fas3-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fashion-fas3-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FashionTryOnService } = await import("../src/server/FashionTryOnService.js");
  const { FashionCustomerService } = await import("../src/server/FashionCustomerService.js");
  const { FashionLookService } = await import("../src/server/FashionLookService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique B', 'active')`).run(randomUUID(), orgB);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled, fashion_daily_generation_limit) VALUES (?, 'ba', 1, 1, 3)`).run(orgA);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled) VALUES (?, 'bb', 1, 1)`).run(orgB);

  const MEDIA_DIR = path.join(tmpDir, "media");
  const PRIVATE_DIR = path.join(tmpDir, "private_media");
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });

  function product(orgId: string, name: string, price: number): string {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, category, price, active, storefront_visible, slug) VALUES (?, ?, 'product', ?, 'Roupas', ?, 1, 1, ?)`)
      .run(id, orgId, name, price, `p-${id.slice(0, 8)}`);
    const imgName = `${randomUUID()}.jpg`;
    fs.writeFileSync(path.join(MEDIA_DIR, imgName), Buffer.from("fake-garment-jpeg"));
    db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, ?, 0)`).run(randomUUID(), orgId, id, `/media/${imgName}`);
    return id;
  }
  product(orgA, "Blusa Teste", 89.9);
  product(orgA, "Calça Teste", 129.9);

  const reg = FashionCustomerService.register(orgA, { name: "Ana", email: "ana@t.com", password: "senhaforte1", birthDate: "1990-01-01" });
  const customerId = (reg as any).customerId as string;
  const regB = FashionCustomerService.register(orgB, { name: "Bia", email: "bia@t.com", password: "senhaforte1", birthDate: "1992-01-01" });
  const customerB = (regB as any).customerId as string;

  // Look real via FAS-2 (fallback, sem IA).
  const lookResult = await FashionLookService.createRequestAndRecommend(orgA, customerId, { occasion: "jantar" });
  const lookId = (lookResult as any).looks[0].id as string;

  // ---- créditos ----
  const credits0 = FashionTryOnService.creditsAvailable(orgA, customerId);
  check("Janela diária nasce com o limite da loja (3)", credits0.available === 3 && credits0.limit === 3);

  // ---- pré-condições ----
  const noAvatar = FashionTryOnService.requestGeneration(orgA, customerId, lookId);
  check("Sem avatar aprovado: não gera, orienta a enviar a foto", !noAvatar.ok && /foto/i.test((noAvatar as any).error));
  check("Sem avatar: crédito não foi tocado", FashionTryOnService.creditsAvailable(orgA, customerId).available === 3);

  // Avatar aprovado com arquivo real no diretório privado.
  const avatarKey = `${randomUUID()}.jpg`;
  fs.writeFileSync(path.join(PRIVATE_DIR, avatarKey), Buffer.from("fake-avatar-jpeg"));
  db.prepare(`INSERT INTO fashion_avatar_assets (id, organization_id, customer_id, storage_key, status, expires_at) VALUES (?, ?, ?, ?, 'approved', datetime('now', '+30 days'))`)
    .run(randomUUID(), orgA, customerId, avatarKey);

  const otherLook = FashionTryOnService.requestGeneration(orgA, customerB, lookId);
  check("Look de OUTRA cliente: não gera (ownership)", !otherLook.ok);

  // ---- provedor indisponível (sem chave de IA): recusa educada ANTES de reservar ----
  const noProvider = FashionTryOnService.requestGeneration(orgA, customerId, lookId);
  check("Provedor indisponível: recusa educada sem consumir crédito", !noProvider.ok && FashionTryOnService.creditsAvailable(orgA, customerId).available === 3);

  // ---- com "provedor disponível" (chave fake): job enfileira, processa e FALHA TÉCNICA com estorno ----
  process.env.OPENAI_API_KEY = "sk-fake-para-teste";
  const req1 = FashionTryOnService.requestGeneration(orgA, customerId, lookId);
  check("Job aceito: QUEUED com crédito reservado", req1.ok && (req1 as any).status === "QUEUED" && FashionTryOnService.creditsAvailable(orgA, customerId).available === 2);
  const jobId1 = (req1 as any).jobId as string;

  // Pedido idêntico enquanto o primeiro está na fila: reaproveita o job, sem novo crédito.
  const dupe = FashionTryOnService.requestGeneration(orgA, customerId, lookId);
  check("Pedido idêntico em andamento: reaproveita o job (reused=true), sem novo crédito",
    dupe.ok && (dupe as any).jobId === jobId1 && (dupe as any).reused === true && FashionTryOnService.creditsAvailable(orgA, customerId).available === 2);

  await FashionTryOnService.processJob(jobId1); // chave fake -> falha técnica no provedor
  const failedJob = FashionTryOnService.getJob(orgA, customerId, jobId1);
  check("Falha técnica: FAILED_FINAL com mensagem segura", failedJob?.status === "FAILED_FINAL" && !!failedJob?.error);
  check("Falha técnica: crédito DEVOLVIDO automaticamente (9.3)", FashionTryOnService.creditsAvailable(orgA, customerId).available === 3);

  // ---- sucesso simulado: idempotência devolve o pronto sem gastar ----
  const okKey = `${randomUUID()}.png`;
  fs.writeFileSync(path.join(PRIVATE_DIR, okKey), Buffer.from("fake-result-png"));
  const inputHash = (db.prepare(`SELECT input_hash FROM fashion_tryon_jobs WHERE id = ?`).get(jobId1) as any).input_hash;
  const okJobId = randomUUID();
  db.prepare(
    `INSERT INTO fashion_tryon_jobs (id, organization_id, customer_id, look_id, provider_key, status, input_hash, output_storage_key, completed_at)
     VALUES (?, ?, ?, ?, 'openai_edit', 'SUCCEEDED', ?, ?, CURRENT_TIMESTAMP)`
  ).run(okJobId, orgA, customerId, lookId, inputHash, okKey);

  const reused = FashionTryOnService.requestGeneration(orgA, customerId, lookId);
  check("Mesmo pedido já SUCCEEDED: devolve pronto sem gastar crédito/IA",
    reused.ok && (reused as any).jobId === okJobId && (reused as any).reused === true && FashionTryOnService.creditsAvailable(orgA, customerId).available === 3);

  const jobView = FashionTryOnService.getJob(orgA, customerId, okJobId);
  check("Job SUCCEEDED expõe URL ASSINADA (nunca caminho público)", !!jobView?.url && jobView!.url!.includes("sig=") && !jobView!.url!.startsWith("/media/"));
  check("Outra cliente não enxerga o job", FashionTryOnService.getJob(orgA, customerB, okJobId) === null);

  // ---- limite diário esgota ----
  db.prepare(`UPDATE fashion_usage_credits SET used_count = 3, reserved_count = 0 WHERE organization_id = ? AND customer_id = ?`).run(orgA, customerId);
  db.prepare(`UPDATE fashion_tryon_jobs SET input_hash = 'outro-hash' WHERE id = ?`).run(okJobId); // evita o reaproveitamento
  db.prepare(`UPDATE fashion_tryon_jobs SET input_hash = 'outro-hash-2' WHERE id = ?`).run(jobId1);
  const exhausted = FashionTryOnService.requestGeneration(orgA, customerId, lookId);
  check("Limite diário esgotado: recusa com mensagem amigável citando o limite", !exhausted.ok && /3/.test((exhausted as any).error));

  // ---- cancelamento: só na fila, com estorno ----
  db.prepare(`UPDATE fashion_usage_credits SET used_count = 0 WHERE organization_id = ? AND customer_id = ?`).run(orgA, customerId);
  const req2 = FashionTryOnService.requestGeneration(orgA, customerId, lookId);
  const jobId2 = (req2 as any).jobId as string;
  check("Novo job na fila reservou crédito", FashionTryOnService.creditsAvailable(orgA, customerId).available === 2);
  check("Cancelar na fila: OK", FashionTryOnService.cancelJob(orgA, customerId, jobId2) === true);
  check("Cancelamento devolve o crédito", FashionTryOnService.creditsAvailable(orgA, customerId).available === 3);
  check("Job cancelado vira DELETED", (db.prepare(`SELECT status FROM fashion_tryon_jobs WHERE id = ?`).get(jobId2) as any).status === "DELETED");
  check("Cancelar de novo (já DELETED): recusado", FashionTryOnService.cancelJob(orgA, customerId, jobId2) === false);
  check("Outra cliente não cancela job alheio", FashionTryOnService.cancelJob(orgA, customerB, okJobId) === false);

  // ---- purga por retenção ----
  db.prepare(`UPDATE fashion_tryon_jobs SET completed_at = datetime('now', '-45 days') WHERE id = ?`).run(okJobId);
  const purged = FashionTryOnService.purgeExpired();
  check("Purga apaga o ARQUIVO do resultado vencido e marca EXPIRED",
    purged >= 1 && !fs.existsSync(path.join(PRIVATE_DIR, okKey)) &&
    (db.prepare(`SELECT status FROM fashion_tryon_jobs WHERE id = ?`).get(okJobId) as any).status === "EXPIRED");

  delete process.env.OPENAI_API_KEY;

  // ---- resultado ----
  console.log("\n=== Fashion AI Studio FAS-3 — orquestrador de try-on (ADR-037) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
