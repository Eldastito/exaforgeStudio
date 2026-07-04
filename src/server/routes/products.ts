import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { logAuthEvent } from "../auditLog.js";
import { AuthRequest } from "../middleware/auth.js";
import { InventoryService } from "../InventoryService.js";
import { chat, isAIConfigured, extractProductFromImage, extractInvoiceItems } from "../llm.js";
import { parseNFeXml } from "../nfeParser.js";
import { suggestSalePrice } from "../pricing.js";
import { findBestProductMatch, nameSimilarity } from "../productMatcher.js";
import { uniqueProductSlug } from "../productSlug.js";
import { verifyNFeSignature } from "../nfeSignature.js";

const router = Router();

// Cadastro Inteligente (Smart Inventory, ADR-019/ADR-020) — mesmo padrão de
// disco local de src/server/routes/uploads.ts (MEDIA_DIR, servido em /media).
const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { /* noop */ }

// HEIC/HEIF (foto padrão do iPhone) foi avaliado e DELIBERADAMENTE não é
// aceito: o binário do `sharp` distribuído via npm só decodifica HEIF no
// perfil AVIF (royalty-free) — o HEVC que o iPhone realmente grava exige um
// decodificador licenciado que não vem embutido. Fingir suportar e falhar
// silenciosamente seria pior do que recusar com uma mensagem clara. Ver
// ADR-020.
const SCAN_EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp",
};
const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB (ADR-020)
  fileFilter: (_req, file, cb) => {
    if (SCAN_EXT[file.mimetype]) return cb(null, true);
    if (file.mimetype === "image/heic" || file.mimetype === "image/heif") {
      return cb(new Error("Fotos em HEIC/HEIF (padrão de câmera do iPhone) ainda não são suportadas. No iPhone: Ajustes > Câmera > Formatos > \"Mais Compatível\", ou escolha a foto já em JPG/PNG."));
    }
    cb(new Error("Formato de imagem não suportado (use PNG, JPG ou WEBP)."));
  },
});

// Upload de XML de NF-e (Smart Inventory Fase 2, ADR-022) — arquivo pequeno,
// sem processamento de imagem nenhum (não passa por sharp/MEDIA_DIR).
const xmlUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB — XML de NF-e é texto, raramente passa de algumas centenas de KB
  fileFilter: (_req, file, cb) => {
    const okMime = ["text/xml", "application/xml", "application/octet-stream"].includes(file.mimetype);
    const okExt = (file.originalname || "").toLowerCase().endsWith(".xml");
    if (okMime || okExt) return cb(null, true);
    cb(new Error("Envie um arquivo XML de NF-e (.xml)."));
  },
});

// Markup padrão da organização para o preço sugerido (ADR-023/ADR-024).
// Configurável em storefront_settings.default_markup_percent; 40% quando não
// definido. Clamp em 0–500 para uma configuração corrompida nunca gerar uma
// sugestão absurda.
function orgMarkup(orgId: string): number {
  const row = db.prepare(`SELECT default_markup_percent FROM storefront_settings WHERE organization_id = ?`).get(orgId) as any;
  const v = Number(row?.default_markup_percent);
  if (!Number.isFinite(v) || v <= 0) return 40;
  return Math.min(500, v);
}

// Enriquece os itens extraídos de uma nota com o melhor candidato do catálogo
// (matching aproximado, ver src/server/productMatcher.ts) — a tela de revisão
// pré-seleciona "repor" em vez de "novo produto" quando há um match forte,
// evitando cadastro duplicado a cada recompra. Só produtos ativos entram como
// candidatos.
function attachCatalogMatches(orgId: string, items: any[]): any[] {
  const catalog = db.prepare(`SELECT id, name FROM products_services WHERE organization_id = ? AND type = 'product' AND active = 1`).all(orgId) as any[];
  return items.map((it) => {
    const match = findBestProductMatch(it.name, catalog);
    return match ? { ...it, matchedProductId: match.id, matchedProductName: match.name, matchScore: Math.round(match.score * 100) / 100 } : it;
  });
}

// Fornecedor da nota -> contato do CRM já marcado como fornecedor
// (contacts.is_supplier=1). Só VINCULA quando o nome casa com folga — nunca
// cria contato sozinho (contato exige canal/identificador que a nota não tem).
function matchSupplierContact(orgId: string, supplierName: string | null): { id: string; name: string } | null {
  if (!supplierName) return null;
  const suppliers = db.prepare(`SELECT id, name FROM contacts WHERE organization_id = ? AND COALESCE(is_supplier, 0) = 1`).all(orgId) as any[];
  let best: { id: string; name: string; score: number } | null = null;
  for (const s of suppliers) {
    const score = nameSimilarity(supplierName, s.name || "");
    if (score >= 0.7 && (!best || score > best.score)) best = { id: s.id, name: s.name, score };
  }
  return best ? { id: best.id, name: best.name } : null;
}

// Rate limit simples por organização, em memória — cada scan é uma chamada
// de IA paga; sem isso, um uso descontrolado (ou automatizado por engano)
// queimaria orçamento de IA sem limite. Mesmo padrão de
// src/server/routes/radarPublic.ts (não exportado de lá, replicado aqui).
const scanRateBuckets = new Map<string, { count: number; resetTime: number }>();
function scanRateLimited(orgId: string, max = 20, windowMs = 60 * 1000): boolean {
  const now = Date.now();
  let b = scanRateBuckets.get(orgId);
  if (!b || now > b.resetTime) b = { count: 0, resetTime: now + windowMs };
  b.count++;
  scanRateBuckets.set(orgId, b);
  return b.count > max;
}

// POST /api/products/smart-scan (multipart, campo "file") — extrai um
// cadastro de produto a partir da FOTO e grava um RASCUNHO (product_scan_drafts)
// — nenhum produto é criado ainda. A extração é só uma prévia editável; só
// vira produto de verdade em POST /smart-scan/:draftId/confirm. Nunca
// publica sozinho — ver ADR-019/ADR-020.
router.post("/smart-scan", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isAIConfigured()) return res.status(400).json({ error: "IA não configurada nesta instância." });
  if (scanRateLimited(orgId)) return res.status(429).json({ error: "Muitos cadastros por foto em pouco tempo. Aguarde um minuto e tente de novo." });

  scanUpload.single("file")(req, res, async (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "Nenhuma imagem enviada." });
    try {
      // Sempre reprocessa via sharp antes de guardar/enviar pra IA:
      // - .rotate() sem argumento lê a orientação EXIF e já gira os pixels
      //   fisicamente (corrige fotos "de lado" tiradas com celular);
      // - reencodar como JPEG novo remove o EXIF original (localização,
      //   modelo do aparelho, etc.) — privacidade, sem exigir uma etapa à parte;
      // - normaliza todo upload pro mesmo formato de saída (JPEG), então o
      //   restante do código nunca precisa se preocupar com PNG vs WEBP.
      const processed = await sharp(file.buffer).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();

      const name = `${uuidv4()}.jpg`;
      fs.writeFileSync(path.join(MEDIA_DIR, name), processed);
      const imageUrl = `/media/${name}`;

      const raw = await extractProductFromImage(processed.toString("base64"), "image/jpeg");
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }

      const confidenceScore = Math.max(0, Math.min(100, Number(parsed.confidence)));
      const extracted = {
        name: String(parsed.name || "").trim().slice(0, 120),
        brand: parsed.brand ? String(parsed.brand).trim().slice(0, 80) : null,
        category: parsed.category ? String(parsed.category).trim().slice(0, 80) : null,
        weightLabel: parsed.weightLabel ? String(parsed.weightLabel).trim().slice(0, 40) : null,
        description: String(parsed.description || "").trim().slice(0, 500),
      };

      const draftId = uuidv4();
      db.prepare(
        `INSERT INTO product_scan_drafts (id, organization_id, uploaded_by, image_url, raw_extraction_json, confidence_score, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`
      ).run(draftId, orgId, userId || null, imageUrl, JSON.stringify({ extracted, rawModelOutput: raw }), Number.isFinite(confidenceScore) ? confidenceScore : 0);
      logAuthEvent(orgId, userId, draftId, "PRODUCT_SCAN_EXTRACTED", { confidenceScore });

      res.json({ draftId, imageUrl, extracted, confidenceScore: Number.isFinite(confidenceScore) ? confidenceScore : 0 });
    } catch (e: any) {
      console.error("[Smart Scan] erro", e);
      res.status(500).json({ error: "Falha ao analisar a imagem com a IA. Tente novamente ou cadastre manualmente." });
    }
  });
});

// POST /api/products/smart-scan/:draftId/confirm — só aqui um produto é
// criado de verdade. Idempotente por rascunho: um draftId já 'confirmed' não
// pode virar um segundo produto (evita duplicar com duplo clique/retry).
// Audita o que a IA sugeriu vs. o que o humano de fato salvou.
router.post("/smart-scan/:draftId/confirm", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const draft = db.prepare(`SELECT * FROM product_scan_drafts WHERE id = ? AND organization_id = ?`).get(req.params.draftId, orgId) as any;
  if (!draft) return res.status(404).json({ error: "Rascunho não encontrado." });
  if (draft.status !== "pending") return res.status(400).json({ error: "Este rascunho já foi confirmado ou descartado." });

  const { name, category, description, price, stock_control_enabled, initial_stock } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Informe o nome do produto." });
  if (!(Number(price) > 0)) return res.status(400).json({ error: "Informe o preço de venda antes de publicar." });

  try {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled, category, slug)
       VALUES (?, ?, 'product', ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, String(name).trim(), description || "", Number(price), stock_control_enabled ? 1 : 0, category ? String(category).trim().slice(0, 80) : null, uniqueProductSlug(orgId, String(name)));

    if (stock_control_enabled) {
      db.prepare(
        `INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, low_stock_threshold)
         VALUES (?, ?, ?, ?, 0)`
      ).run(uuidv4(), orgId, id, Math.max(0, parseInt(String(initial_stock ?? "0"), 10) || 0));
    }

    const count = (db.prepare("SELECT COUNT(*) AS c FROM product_images WHERE product_service_id = ?").get(id) as any)?.c || 0;
    db.prepare("INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, ?, ?)")
      .run(uuidv4(), orgId, id, draft.image_url, count);

    db.prepare(`UPDATE product_scan_drafts SET status = 'confirmed', product_id = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id, draft.id);

    // Diff entre o que a IA sugeriu e o que o humano de fato publicou —
    // alimenta futura análise de qualidade do prompt, sem bloquear nada agora.
    let extracted: any = {};
    try { extracted = JSON.parse(draft.raw_extraction_json || "{}").extracted || {}; } catch { /* noop */ }
    const changedFields = ["name", "category", "description"].filter((f) => {
      const before = (extracted as any)[f === "name" ? "name" : f] ?? null;
      const after = f === "name" ? name : f === "category" ? category : description;
      return String(before ?? "").trim() !== String(after ?? "").trim();
    });

    logAuthEvent(orgId, userId, id, "PRODUCT_CREATED", { name, type: "product", source: "smart_scan" });
    logAuthEvent(orgId, userId, draft.id, "PRODUCT_SCAN_CONFIRMED", { productId: id, confidenceScore: draft.confidence_score, changedFields });

    res.status(201).json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/products/invoice-scan (multipart, campo "file") — Cadastro por
// Nota Fiscal (Smart Inventory Fase 1, ADR-021): extrai TODOS os itens de
// compra de uma foto de nota fiscal e grava um RASCUNHO (invoice_scan_drafts)
// — nenhum produto é criado/estoque é mexido ainda. Mesmo padrão de
// upload/rate-limit/pré-processamento do /smart-scan (ADR-019/ADR-020).
router.post("/invoice-scan", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isAIConfigured()) return res.status(400).json({ error: "IA não configurada nesta instância." });
  if (scanRateLimited(orgId)) return res.status(429).json({ error: "Muitos cadastros por foto em pouco tempo. Aguarde um minuto e tente de novo." });

  scanUpload.single("file")(req, res, async (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "Nenhuma imagem enviada." });
    try {
      // Nota fiscal tem bem mais texto miúdo que a foto de um produto único —
      // usa uma resolução maior (2000px) que o /smart-scan (1600px) pra dar à
      // IA a melhor chance de ler cada linha corretamente. Mesmo tratamento de
      // EXIF/rotação do /smart-scan.
      const processed = await sharp(file.buffer).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();

      const name = `${uuidv4()}.jpg`;
      fs.writeFileSync(path.join(MEDIA_DIR, name), processed);
      const imageUrl = `/media/${name}`;

      const raw = await extractInvoiceItems(processed.toString("base64"), "image/jpeg");
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }

      const confidenceScore = Math.max(0, Math.min(100, Number(parsed.confidence)));
      const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 60).map((it: any) => ({
        name: String(it?.name || "").trim().slice(0, 120),
        quantity: Math.max(0, Number(it?.quantity) || 0),
        unit: it?.unit ? String(it.unit).trim().slice(0, 20) : null,
        unitCost: Math.max(0, Number(it?.unitCost) || 0),
        confidence: Math.max(0, Math.min(100, Number(it?.confidence) || 0)),
      })).filter((it: any) => it.name);
      const supplierName = parsed.supplierName ? String(parsed.supplierName).trim().slice(0, 120) : null;

      if (!items.length) return res.status(422).json({ error: "Não foi possível identificar itens de compra nesta foto. Tente uma foto mais nítida da nota fiscal." });

      const supplierContact = matchSupplierContact(orgId, supplierName);
      const draftId = uuidv4();
      db.prepare(
        `INSERT INTO invoice_scan_drafts (id, organization_id, uploaded_by, image_url, raw_extraction_json, confidence_score, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`
      ).run(draftId, orgId, userId || null, imageUrl, JSON.stringify({ supplierName, supplierContactId: supplierContact?.id || null, items, rawModelOutput: raw }), Number.isFinite(confidenceScore) ? confidenceScore : 0);
      logAuthEvent(orgId, userId, draftId, "INVOICE_SCAN_EXTRACTED", { confidenceScore, itemCount: items.length });

      // Sugestão de preço de venda a partir do custo real da nota (markup da
      // organização, ver orgMarkup/pricing.ts) — sempre editável, nunca
      // aplicada sem o humano revisar e publicar. matchedProductId pré-aponta
      // reposição de um produto já existente quando o nome casa com folga.
      const markup = orgMarkup(orgId);
      const enriched = attachCatalogMatches(orgId, items).map((it: any) => ({ ...it, suggestedSalePrice: suggestSalePrice(it.unitCost, markup) }));

      res.json({ draftId, imageUrl, supplierName, supplierContact, items: enriched, confidenceScore: Number.isFinite(confidenceScore) ? confidenceScore : 0 });
    } catch (e: any) {
      console.error("[Invoice Scan] erro", e);
      res.status(500).json({ error: "Falha ao analisar a nota fiscal com a IA. Tente novamente ou cadastre manualmente." });
    }
  });
});

// POST /api/products/invoice-scan/xml (multipart, campo "file") — mesma ideia
// do /invoice-scan (foto), mas a partir do XML de NF-e em vez de OCR de foto
// (Smart Inventory Fase 2, ADR-022). Dado estruturado e assinado, muito mais
// confiável que a foto — por isso NÃO passa pela IA (nem exige
// isAIConfigured()): quem não tem IA configurada ainda consegue usar este
// caminho. Devolve exatamente o mesmo formato de resposta do /invoice-scan
// (draftId/imageUrl/supplierName/items/confidenceScore), então o restante do
// fluxo (revisão na tela, POST /invoice-scan/:draftId/confirm) é 100%
// reaproveitado sem nenhuma mudança — só a extração é diferente.
router.post("/invoice-scan/xml", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (scanRateLimited(orgId)) return res.status(429).json({ error: "Muitos cadastros em pouco tempo. Aguarde um minuto e tente de novo." });

  // Aceita LOTE (até 20 XMLs de uma vez, ADR-024) — quem baixa as notas do
  // ERP/fornecedor geralmente baixa o mês inteiro. Cada arquivo vira um
  // rascunho independente, revisado um por vez na tela; arquivos com problema
  // (não é NF-e, nota já importada) entram em `skipped` com o motivo, sem
  // derrubar o lote inteiro.
  xmlUpload.array("file", 20)(req, res, (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const files: any[] = (req as any).files || [];
    if (!files.length) return res.status(400).json({ error: "Nenhum arquivo XML enviado." });

    const markup = orgMarkup(orgId);
    const drafts: any[] = [];
    const skipped: { fileName: string; error: string }[] = [];
    const seenKeysInBatch = new Set<string>();

    for (const file of files) {
      const fileName = file.originalname || "arquivo.xml";
      try {
        const xmlText = file.buffer.toString("utf-8");
        const parsed = parseNFeXml(xmlText);
        if (!parsed.items.length) { skipped.push({ fileName, error: "Nenhum item de mercadoria neste XML." }); continue; }
        // Assinatura digital (ADR-029): verificação LOCAL (digest + RSA do
        // certificado embutido) — INFORMATIVA, nunca bloqueia a importação
        // (o lojista está importando a própria compra; a consulta online à
        // Sefaz exigiria certificado digital da organização, fora de escopo).
        const signature = verifyNFeSignature(xmlText);

        // Dedupe pela chave de acesso (44 dígitos, única por NF-e no Brasil):
        // mesma nota já importada nesta organização — ou repetida dentro do
        // próprio lote — é pulada com aviso, nunca reimportada em silêncio.
        if (parsed.accessKey) {
          if (seenKeysInBatch.has(parsed.accessKey)) { skipped.push({ fileName, error: "NF-e repetida dentro do próprio lote." }); continue; }
          const dupe = db.prepare(
            `SELECT id, status FROM invoice_scan_drafts WHERE organization_id = ? AND access_key = ? AND status IN ('pending', 'confirmed') LIMIT 1`
          ).get(orgId, parsed.accessKey) as any;
          if (dupe) {
            skipped.push({ fileName, error: dupe.status === "confirmed" ? "Esta NF-e já foi importada e confirmada antes." : "Esta NF-e já tem uma importação pendente de revisão." });
            continue;
          }
          seenKeysInBatch.add(parsed.accessKey);
        }

        // Dado estruturado direto da NF-e — não é uma "leitura" com incerteza
        // como a foto, então confiança é sempre máxima.
        const items = parsed.items.slice(0, 200).map((it) => ({ ...it, confidence: 100 }));
        const truncated = parsed.items.length > 200;
        const supplierContact = matchSupplierContact(orgId, parsed.supplierName);

        const draftId = uuidv4();
        db.prepare(
          `INSERT INTO invoice_scan_drafts (id, organization_id, uploaded_by, image_url, raw_extraction_json, confidence_score, status, access_key)
           VALUES (?, ?, ?, ?, ?, 100, 'pending', ?)`
        ).run(draftId, orgId, userId || null, "", JSON.stringify({ supplierName: parsed.supplierName, supplierContactId: supplierContact?.id || null, items, source: "xml", signature }), parsed.accessKey);
        logAuthEvent(orgId, userId, draftId, "INVOICE_SCAN_EXTRACTED", { confidenceScore: 100, itemCount: items.length, source: "xml" });

        const enriched = attachCatalogMatches(orgId, items).map((it: any) => ({ ...it, suggestedSalePrice: suggestSalePrice(it.unitCost, markup) }));
        drafts.push({ draftId, imageUrl: "", fileName, supplierName: parsed.supplierName, supplierContact, items: enriched, confidenceScore: 100, truncated, signature });
      } catch (e: any) {
        skipped.push({ fileName, error: e.message || "Não foi possível ler este XML." });
      }
    }

    if (!drafts.length) {
      return res.status(422).json({ error: skipped[0]?.error || "Nenhum XML pôde ser importado.", skipped });
    }
    res.json({ drafts, skipped });
  });
});

// POST /api/products/invoice-scan/:draftId/confirm — só aqui produtos são
// criados/repostos de verdade, item por item, conforme a ação escolhida pelo
// humano para cada linha: 'create' (produto novo), 'restock' (soma estoque a
// um produto já existente, escolhido pelo humano) ou 'skip' (ignora a linha —
// ex.: item que não é de revenda). Idempotente por rascunho, mesmo padrão do
// /smart-scan/:draftId/confirm. Toda entrada de estoque passa por
// InventoryService.recordMovement, que já atualiza o custo médio ponderado.
router.post("/invoice-scan/:draftId/confirm", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const draft = db.prepare(`SELECT * FROM invoice_scan_drafts WHERE id = ? AND organization_id = ?`).get(req.params.draftId, orgId) as any;
  if (!draft) return res.status(404).json({ error: "Rascunho não encontrado." });
  if (draft.status !== "pending") return res.status(400).json({ error: "Este rascunho já foi confirmado ou descartado." });

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Nenhum item para confirmar." });

  let supplierName: string | null = null;
  let supplierContactId: string | null = null;
  try {
    const rawDraft = JSON.parse(draft.raw_extraction_json || "{}");
    supplierName = rawDraft.supplierName || null;
    supplierContactId = rawDraft.supplierContactId || null;
  } catch { /* noop */ }

  const created: string[] = [];
  const restocked: string[] = [];
  const skipped: number[] = [];

  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const action = it.action;
      if (action === "skip" || !action) { skipped.push(i); continue; }

      const quantity = Math.max(0, parseInt(String(it.quantity), 10) || 0);
      const unitCost = Math.max(0, Number(it.unitCost) || 0);
      if (quantity <= 0) return res.status(400).json({ error: `Item "${it.name || i + 1}": informe uma quantidade válida.` });

      if (action === "create") {
        const name = String(it.name || "").trim();
        if (!name) return res.status(400).json({ error: `Item ${i + 1}: informe o nome do produto.` });
        if (!(Number(it.salePrice) > 0)) return res.status(400).json({ error: `Item "${name}": informe o preço de venda antes de publicar.` });

        const productId = uuidv4();
        db.prepare(
          `INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled, category, slug)
           VALUES (?, ?, 'product', ?, '', ?, 1, ?, ?)`
        ).run(productId, orgId, name, Number(it.salePrice), it.category ? String(it.category).trim().slice(0, 80) : null, uniqueProductSlug(orgId, name));

        InventoryService.recordMovement(orgId, {
          productId, type: "entrada", quantity, unitCost,
          origin: "invoice_scan", note: supplierName ? `Nota fiscal — ${supplierName}` : "Nota fiscal", createdBy: userId,
          supplierContactId,
        });
        logAuthEvent(orgId, userId, productId, "PRODUCT_CREATED", { name, type: "product", source: "invoice_scan" });
        created.push(productId);
      } else if (action === "restock") {
        const matchedProductId = String(it.matchedProductId || "");
        const product = db.prepare(`SELECT id FROM products_services WHERE id = ? AND organization_id = ?`).get(matchedProductId, orgId) as any;
        if (!product) return res.status(400).json({ error: `Item ${i + 1}: produto existente selecionado não foi encontrado.` });

        InventoryService.recordMovement(orgId, {
          productId: matchedProductId, type: "entrada", quantity, unitCost,
          origin: "invoice_scan", note: supplierName ? `Nota fiscal — ${supplierName}` : "Nota fiscal", createdBy: userId,
          supplierContactId,
        });
        db.prepare(`UPDATE products_services SET stock_control_enabled = 1 WHERE id = ? AND organization_id = ?`).run(matchedProductId, orgId);
        restocked.push(matchedProductId);
      } else {
        return res.status(400).json({ error: `Item ${i + 1}: ação inválida.` });
      }
    }

    db.prepare(`UPDATE invoice_scan_drafts SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(draft.id);
    logAuthEvent(orgId, userId, draft.id, "INVOICE_SCAN_CONFIRMED", {
      confidenceScore: draft.confidence_score, created: created.length, restocked: restocked.length, skipped: skipped.length,
    });

    res.status(201).json({ success: true, created, restocked, skipped: skipped.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /ai/describe — curadoria pela IA: gera um título atraente e uma descrição
// de venda para o produto. Não inventa especificações; só melhora a apresentação.
router.post("/ai/describe", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isAIConfigured()) return res.status(400).json({ error: "IA não configurada nesta instância." });

  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Informe o nome do produto." });
  const type = req.body?.type === "service" ? "serviço" : "produto";
  const price = Number(req.body?.price || 0);
  const current = String(req.body?.description || "").trim();

  try {
    const biz = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const brand = biz?.business_name ? `A loja se chama "${biz.business_name}". ` : "";
    const priceLine = price > 0 ? `Preço: R$ ${price.toFixed(2)}. ` : "";
    const currentLine = current ? `Descrição atual (melhore-a, mantendo o sentido): "${current}". ` : "";

    const system = "Você é um copywriter de e-commerce brasileiro. Escreve em português do Brasil, de forma atraente, honesta e objetiva. NUNCA invente características, medidas, materiais ou benefícios que não foram informados — apenas apresente bem o que existe. Responda SOMENTE em JSON.";
    const prompt = `${brand}Crie a vitrine para este ${type}: "${name}". ${priceLine}${currentLine}
Gere um JSON com:
- "title": um título curto e chamativo (máx. 60 caracteres), sem inventar dados.
- "description": uma descrição de venda persuasiva e honesta (2 a 3 frases, máx. ~320 caracteres), em português.
Responda apenas o JSON: {"title": "...", "description": "..."}`;

    const raw = await chat(prompt, { json: true, temperature: 0.7, system });
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    const title = String(parsed.title || "").trim().slice(0, 80);
    const description = String(parsed.description || "").trim().slice(0, 500);
    if (!description && !title) return res.status(502).json({ error: "A IA não retornou um texto válido. Tente novamente." });
    res.json({ title, description });
  } catch (e: any) {
    console.error("[AI describe] erro", e);
    res.status(500).json({ error: "Falha ao gerar com a IA. Tente novamente." });
  }
});

// ---- Variações de produto (tamanho/cor/tipo) ----

// GET /api/products/:id/variants
router.get("/:id/variants", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const variants = db.prepare(`
      SELECT pv.*, inv.quantity_available, inv.quantity_reserved
      FROM product_variants pv
      LEFT JOIN inventory_items inv ON inv.variant_id = pv.id
      WHERE pv.organization_id = ? AND pv.product_service_id = ?
      ORDER BY pv.created_at ASC
    `).all(orgId, req.params.id) as any[];
    res.json(variants.map(v => ({ ...v, sellable: Math.max(0, (v.quantity_available || 0) - (v.quantity_reserved || 0)) })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/products/:id/variants — cria variação (e marca o produto com has_variants)
router.post("/:id/variants", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const { name, size, color, variant_type, sku, price, initial_stock } = req.body || {};
  const label = name || [size, color, variant_type].filter(Boolean).join(' / ');
  if (!label) return res.status(400).json({ error: "Informe ao menos tamanho/cor/tipo ou um nome." });
  try {
    const product = db.prepare('SELECT id FROM products_services WHERE id = ? AND organization_id = ?').get(req.params.id, orgId) as any;
    if (!product) return res.status(404).json({ error: "Produto não encontrado" });
    const vid = uuidv4();
    db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, sku, size, color, variant_type, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(vid, orgId, req.params.id, label, sku || null, size || null, color || null, variant_type || null, price ?? null);
    db.prepare(`UPDATE products_services SET has_variants = 1, stock_control_enabled = 1 WHERE id = ?`).run(req.params.id);
    if (initial_stock) InventoryService.setQuantity(orgId, req.params.id, parseInt(String(initial_stock), 10) || 0, vid);
    res.json({ success: true, id: vid });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---- Movimentações de estoque (entrada/saída/ajuste/transferência) ----

// GET /api/products/:id/movements
router.get("/:id/movements", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(InventoryService.listMovements(orgId, req.params.id)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/products/:id/movements — registra entrada/saída/ajuste/transferência
router.post("/:id/movements", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const { type, quantity, unit_cost, origin, note, variant_id } = req.body || {};
  if (!['entrada', 'saida', 'ajuste', 'transferencia'].includes(type)) return res.status(400).json({ error: "Tipo de movimentação inválido." });
  try {
    const movId = InventoryService.recordMovement(orgId, {
      productId: req.params.id, variantId: variant_id || null, type,
      quantity: parseInt(String(quantity), 10) || 0, unitCost: parseFloat(String(unit_cost)) || 0,
      origin, note, createdBy: userId,
    });
    db.prepare(`UPDATE products_services SET stock_control_enabled = 1 WHERE id = ? AND organization_id = ?`).run(req.params.id, orgId);
    logAuthEvent(orgId, userId, req.params.id, 'STOCK_MOVEMENT', { type, quantity, origin });
    res.json({ success: true, id: movId });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// GET /api/products/sales-analytics?days=30 — mais/menos vendidos (backlog
// ADR-027, registrado desde a ADR-019: "o dado bruto existe em order_items,
// nenhum relatório usa"). Mesmo filtro de status do best_sellers da vitrine
// (só pedidos que viraram receita de verdade). Inclui produtos ativos com
// ZERO venda no período — o "menos vendido" mais importante é o que nunca
// vendeu e continua ocupando vitrine/estoque.
router.get("/sales-analytics", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const days = Math.min(365, Math.max(1, parseInt(String(req.query.days || "30"), 10) || 30));
  try {
    const rows = db.prepare(`
      SELECT ps.id, ps.name, ps.price,
        COALESCE(s.units, 0) AS units_sold,
        COALESCE(s.revenue, 0) AS revenue,
        s.last_sale_at AS last_sale_at
      FROM products_services ps
      LEFT JOIN (
        SELECT oi.product_service_id, SUM(oi.quantity) units, SUM(oi.line_total) revenue, MAX(o.created_at) last_sale_at
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND o.created_at >= datetime('now', ?)
        GROUP BY oi.product_service_id
      ) s ON s.product_service_id = ps.id
      WHERE ps.organization_id = ? AND ps.type = 'product' AND ps.active = 1
      ORDER BY units_sold DESC, revenue DESC
    `).all(orgId, `-${days} days`, orgId) as any[];

    const withSales = rows.filter((r) => r.units_sold > 0);
    res.json({
      days,
      top: withSales.slice(0, 10),
      bottom: rows.slice(-10).reverse(), // os 10 piores (inclui zero-venda), do pior pro "menos pior"
      totals: {
        productsActive: rows.length,
        productsWithSales: withSales.length,
        unitsSold: withSales.reduce((s, r) => s + r.units_sold, 0),
        revenue: Math.round(withSales.reduce((s, r) => s + r.revenue, 0) * 100) / 100,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/products — produtos com estoque ao vivo (disponível e vendável)
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const products = db.prepare(`
      SELECT ps.*,
        COALESCE(prod.quantity_available, agg.qa) AS quantity_available,
        COALESCE(prod.quantity_reserved, agg.qr) AS quantity_reserved,
        prod.low_stock_threshold AS low_stock_threshold,
        prod.avg_cost AS avg_cost
      FROM products_services ps
      LEFT JOIN inventory_items prod ON prod.product_service_id = ps.id AND prod.variant_id IS NULL
      LEFT JOIN (
        SELECT product_service_id, SUM(quantity_available) qa, SUM(quantity_reserved) qr
        FROM inventory_items WHERE variant_id IS NOT NULL GROUP BY product_service_id
      ) agg ON agg.product_service_id = ps.id
      WHERE ps.organization_id = ?
      ORDER BY ps.created_at DESC
    `).all(orgId) as any[];
    const markup = orgMarkup(orgId);
    res.json(products.map(p => ({
      ...p,
      sellable: p.stock_control_enabled ? Math.max(0, (p.quantity_available || 0) - (p.quantity_reserved || 0)) : null,
      // Sugestão informativa a partir do custo médio real (Fases 1/2 do Smart
      // Inventory) — nunca substitui o preço já definido, só orienta quem
      // está editando. Markup configurável por organização (ADR-024).
      suggested_price: p.avg_cost > 0 ? suggestSalePrice(p.avg_cost, markup) : null,
    })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { type, name, description, price, stock_control_enabled, duration_minutes, min_price, capacity, reservation_unit, category } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled, duration_minutes, min_price, capacity, reservation_unit, category, slug)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, type || 'product', name, description || '', price || 0, stock_control_enabled ? 1 : 0, duration_minutes || null, (min_price !== undefined && min_price !== '' ? Number(min_price) : null),
       type === 'reservation' ? (Number(capacity) > 0 ? Number(capacity) : 1) : null,
       type === 'reservation' ? (['night','hour','slot','day'].includes(reservation_unit) ? reservation_unit : 'night') : null,
       category ? String(category).trim().slice(0, 80) : null,
       (type || 'product') === 'product' ? uniqueProductSlug(orgId, String(name || '')) : null);

    if (stock_control_enabled) {
      db.prepare(`
         INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, low_stock_threshold)
         VALUES (?, ?, ?, ?, ?)
      `).run(uuidv4(), orgId, id, req.body.initial_stock || 0, req.body.low_stock_threshold || 0);
    }

    logAuthEvent(orgId, userId, id, 'PRODUCT_CREATED', { name, type });

    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/products/:id — edita produto e/ou ajusta estoque em mãos
router.patch("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const product = db.prepare('SELECT * FROM products_services WHERE id = ? AND organization_id = ?').get(req.params.id, orgId) as any;
    if (!product) return res.status(404).json({ error: "Produto não encontrado" });

    const { name, description, price, active, type, stock_control_enabled, quantity, low_stock_threshold, min_price, capacity, reservation_unit, category } = req.body;
    const updates: string[] = [];
    const vals: any[] = [];
    if (name !== undefined) { updates.push("name = ?"); vals.push(name); }
    if (description !== undefined) { updates.push("description = ?"); vals.push(description); }
    if (price !== undefined) { updates.push("price = ?"); vals.push(price); }
    if (active !== undefined) { updates.push("active = ?"); vals.push(active ? 1 : 0); }
    if (type !== undefined) { updates.push("type = ?"); vals.push(type); }
    if (stock_control_enabled !== undefined) { updates.push("stock_control_enabled = ?"); vals.push(stock_control_enabled ? 1 : 0); }
    if (category !== undefined) { updates.push("category = ?"); vals.push(category ? String(category).trim().slice(0, 80) : null); }
    if (min_price !== undefined) { updates.push("min_price = ?"); vals.push(min_price === '' || min_price === null ? null : Number(min_price)); }
    if (capacity !== undefined) { updates.push("capacity = ?"); vals.push(Number(capacity) > 0 ? Number(capacity) : 1); }
    if (reservation_unit !== undefined) { updates.push("reservation_unit = ?"); vals.push(['night','hour','slot','day'].includes(reservation_unit) ? reservation_unit : 'night'); }
    if (updates.length) {
      db.prepare(`UPDATE products_services SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals, req.params.id, orgId);
    }

    // Ajuste de estoque em mãos (define a quantidade absoluta)
    if (quantity !== undefined && Number.isFinite(Number(quantity))) {
      InventoryService.setQuantity(orgId, req.params.id, Math.max(0, parseInt(String(quantity), 10)));
    }
    if (low_stock_threshold !== undefined) {
      db.prepare('UPDATE inventory_items SET low_stock_threshold = ? WHERE organization_id = ? AND product_service_id = ?')
        .run(parseInt(String(low_stock_threshold), 10) || 0, orgId, req.params.id);
    }

    logAuthEvent(orgId, userId, req.params.id, 'PRODUCT_UPDATED', {});
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /:id — exclui o produto/serviço do catálogo (e da vitrine). Remove os
// dados ligados ao produto (estoque, variações, imagens, movimentações), mas
// PRESERVA o histórico de pedidos (order_items guardam o nome no snapshot).
router.delete("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const product = db.prepare('SELECT id, name FROM products_services WHERE id = ? AND organization_id = ?').get(req.params.id, orgId) as any;
    if (!product) return res.status(404).json({ error: "Produto não encontrado" });

    const wipe = db.transaction((id: string) => {
      db.prepare('DELETE FROM inventory_items WHERE organization_id = ? AND product_service_id = ?').run(orgId, id);
      db.prepare('DELETE FROM product_variants WHERE organization_id = ? AND product_service_id = ?').run(orgId, id);
      db.prepare('DELETE FROM stock_movements WHERE organization_id = ? AND product_service_id = ?').run(orgId, id);
      db.prepare('DELETE FROM product_images WHERE organization_id = ? AND product_service_id = ?').run(orgId, id);
      db.prepare('DELETE FROM products_services WHERE id = ? AND organization_id = ?').run(id, orgId);
    });
    wipe(req.params.id);

    logAuthEvent(orgId, userId, req.params.id, 'PRODUCT_DELETED', { name: product.name });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/products/import — importação em massa via CSV (texto colado)
// Formato esperado (cabeçalho): nome,preco,quantidade,descricao,tipo
router.post("/import", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const csv = String(req.body?.csv || "");
  if (!csv.trim()) return res.status(400).json({ error: "CSV vazio." });

  try {
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: "CSV sem linhas de dados." });

    // Detecta o separador (vírgula ou ponto-e-vírgula) e mapeia o cabeçalho.
    const sep = (lines[0].match(/;/g)?.length || 0) > (lines[0].match(/,/g)?.length || 0) ? ';' : ',';
    const header = lines[0].split(sep).map(h => h.trim().toLowerCase());
    const idx = (names: string[]) => names.map(n => header.indexOf(n)).find(i => i >= 0) ?? -1;
    const iName = idx(['nome', 'name', 'produto']);
    const iPrice = idx(['preco', 'preço', 'price', 'valor']);
    const iQty = idx(['quantidade', 'qtd', 'estoque', 'quantity', 'stock']);
    const iDesc = idx(['descricao', 'descrição', 'description', 'desc']);
    const iType = idx(['tipo', 'type']);
    if (iName < 0) return res.status(400).json({ error: "Cabeçalho precisa ter a coluna 'nome'." });

    let created = 0, updated = 0;
    const parsePrice = (s: string) => parseFloat(String(s || '0').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || 0;

    const tx = db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(sep);
        const name = (cols[iName] || '').trim();
        if (!name) continue;
        const price = iPrice >= 0 ? parsePrice(cols[iPrice]) : 0;
        const qty = iQty >= 0 ? (parseInt(String(cols[iQty]).replace(/[^\d-]/g, ''), 10) || 0) : 0;
        const desc = iDesc >= 0 ? (cols[iDesc] || '').trim() : '';
        const type = iType >= 0 ? (cols[iType] || 'product').trim() : 'product';
        const stockControlled = iQty >= 0;

        // Upsert por nome (dentro da organização).
        const existing = db.prepare('SELECT id FROM products_services WHERE organization_id = ? AND name = ?').get(orgId, name) as any;
        if (existing) {
          db.prepare('UPDATE products_services SET price = ?, description = ?, type = ?, stock_control_enabled = ? WHERE id = ?')
            .run(price, desc, type, stockControlled ? 1 : 0, existing.id);
          if (stockControlled) InventoryService.setQuantity(orgId, existing.id, qty);
          updated++;
        } else {
          const pid = uuidv4();
          db.prepare('INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(pid, orgId, type, name, desc, price, stockControlled ? 1 : 0, type === 'product' ? uniqueProductSlug(orgId, name) : null);
          if (stockControlled) InventoryService.setQuantity(orgId, pid, qty);
          created++;
        }
      }
    });
    tx();

    logAuthEvent(orgId, userId, undefined, 'PRODUCTS_IMPORTED', { created, updated });
    res.json({ success: true, created, updated });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
