/**
 * Rotas do Product Evolution Ledger (ADR-193 F1). Todas montadas sob
 * `/api/admin/product-evolution/*` e herdam `requireMasterAdmin` do pai
 * (server.ts monta `protectedApi.use("/admin", requireMasterAdmin, ...)`).
 *
 * O router aqui é montado dentro do adminRoutes ou como sub-router próprio
 * — ver server.ts. Não repetir guard aqui (RN: gate único no ponto de mount).
 */
import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import {
  ProductEvolutionLedgerService as Ledger,
  LedgerNotFoundError,
  LedgerValidationError,
  Status,
} from "../ProductEvolutionLedgerService.js";
import { ProductEvolutionScoringService as Scoring } from "../ProductEvolutionScoringService.js";
import {
  GitHubEvidenceSyncService as GhSync,
  GitHubEvidenceSyncError,
} from "../GitHubEvidenceSyncService.js";
import db from "../db.js";

const router = Router();

/** Converte erros tipados do service em respostas HTTP consistentes. */
function handle(res: any, e: any) {
  if (e instanceof LedgerNotFoundError) return res.status(404).json({ error: e.message });
  if (e instanceof LedgerValidationError) return res.status(400).json({ error: e.message, code: e.code });
  if (e instanceof GitHubEvidenceSyncError) {
    // disabled=503, rate_limit=429, github_4xx=502 (upstream)
    const s = e.code === "disabled" ? 503
      : e.code === "rate_limit" ? 429
      : e.code.startsWith("github_") ? 502
      : 500;
    return res.status(s).json({ error: e.message, code: e.code });
  }
  console.error("[product-evolution] erro inesperado", e);
  return res.status(500).json({ error: e?.message || "internal_error" });
}

// ─── Items ──────────────────────────────────────────────────────────────────

router.get("/items", (req: AuthRequest, res): any => {
  try {
    const filters = {
      status: req.query.status ? String(req.query.status) as Status : undefined,
      domain: req.query.domain ? String(req.query.domain) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
    };
    return res.json({ items: Ledger.listItems(filters) });
  } catch (e) { return handle(res, e); }
});

router.get("/items/:key", (req: AuthRequest, res): any => {
  try {
    const item = Ledger.getItem(req.params.key);
    if (!item) return res.status(404).json({ error: "not_found" });
    return res.json(item);
  } catch (e) { return handle(res, e); }
});

router.post("/items", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    const item = Ledger.createItem({
      evolution_key: String(b.evolution_key || ""),
      title: String(b.title || ""),
      domain: b.domain ?? null,
      summary: b.summary ?? null,
      priority: b.priority ?? null,
      risk_level: b.risk_level ?? null,
      owner_user_id: b.owner_user_id ?? null,
      source_of_truth: b.source_of_truth ?? null,
      target_release: b.target_release ?? null,
    });
    return res.status(201).json(item);
  } catch (e) { return handle(res, e); }
});

router.patch("/items/:key", (req: AuthRequest, res): any => {
  try {
    // Explicitamente recusa mudança de evolution_key ou status por PATCH.
    const b = req.body || {};
    if ("evolution_key" in b) return res.status(400).json({ error: "evolution_key é imutável (RN-PEL-1). Use SUPERSEDED para renomear.", code: "immutable_key" });
    if ("status" in b) return res.status(400).json({ error: "status muda por POST /items/:key/status (transição validada).", code: "status_via_transition" });
    const item = Ledger.updateItem(req.params.key, b);
    return res.json(item);
  } catch (e) { return handle(res, e); }
});

router.post("/items/:key/status", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    const item = Ledger.setStatus(req.params.key, {
      new_status: String(b.new_status || "") as Status,
      reason: String(b.reason || ""),
      superseded_by: b.superseded_by ?? null,
    });
    return res.json(item);
  } catch (e) { return handle(res, e); }
});

// ─── Evidence ───────────────────────────────────────────────────────────────

router.post("/items/:key/evidence", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    const evid = Ledger.addEvidence(req.params.key, {
      evidence_type: b.evidence_type,
      reference: String(b.reference || ""),
      description: b.description ?? null,
      metadata_json: b.metadata_json ?? null,
    });
    return res.status(201).json(evid);
  } catch (e) { return handle(res, e); }
});

router.get("/items/:key/evidence", (req: AuthRequest, res): any => {
  try {
    return res.json({ evidence: Ledger.listEvidence(req.params.key) });
  } catch (e) { return handle(res, e); }
});

router.post("/evidence/:id/verify", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    const evid = Ledger.verifyEvidence(req.params.id, String(b.verified_by || ""));
    return res.json(evid);
  } catch (e) { return handle(res, e); }
});

// ─── Sources ────────────────────────────────────────────────────────────────

router.post("/items/:key/sources", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    const src = Ledger.addSource(req.params.key, {
      source_type: b.source_type,
      title: String(b.title || ""),
      source_date: b.source_date ?? null,
      source_reference: b.source_reference ?? null,
      external_url: b.external_url ?? null,
      file_ref: b.file_ref ?? null,
      notes: b.notes ?? null,
    });
    return res.status(201).json(src);
  } catch (e) { return handle(res, e); }
});

router.get("/items/:key/sources", (req: AuthRequest, res): any => {
  try {
    return res.json({ sources: Ledger.listSources(req.params.key) });
  } catch (e) { return handle(res, e); }
});

// ─── Gaps view ──────────────────────────────────────────────────────────────

router.get("/gaps", (_req: AuthRequest, res): any => {
  try {
    return res.json({ items: Ledger.gaps() });
  } catch (e) { return handle(res, e); }
});

// ─── Reviews (ADR-193 F1.5) ────────────────────────────────────────────────

router.get("/items/:key/reviews", (req: AuthRequest, res): any => {
  try {
    return res.json({ reviews: Ledger.listReviews(req.params.key) });
  } catch (e) { return handle(res, e); }
});

// ─── Dependencies (ADR-193 F1.5) ───────────────────────────────────────────

router.post("/items/:key/dependencies", (req: AuthRequest, res): any => {
  try {
    const b = req.body || {};
    const dep = Ledger.addDependency({
      evolution_key: req.params.key,
      depends_on_key: String(b.depends_on_key || ""),
      dependency_type: b.dependency_type,
      notes: b.notes ?? null,
    });
    return res.status(201).json(dep);
  } catch (e) { return handle(res, e); }
});

router.get("/items/:key/dependencies", (req: AuthRequest, res): any => {
  try {
    return res.json(Ledger.listDependencies(req.params.key));
  } catch (e) { return handle(res, e); }
});

router.delete("/dependencies/:id", (req: AuthRequest, res): any => {
  try {
    const removed = Ledger.removeDependency(req.params.id);
    if (!removed) return res.status(404).json({ error: "not_found" });
    return res.status(204).end();
  } catch (e) { return handle(res, e); }
});

// ─── Scoring (ADR-193 F3) ──────────────────────────────────────────────────

router.get("/items/:key/score", (req: AuthRequest, res): any => {
  try {
    const score = Scoring.computeScore(req.params.key);
    if (!score) return res.status(404).json({ error: "not_found" });
    return res.json(score);
  } catch (e) { return handle(res, e); }
});

router.get("/scores", (_req: AuthRequest, res): any => {
  try {
    return res.json({ scores: Scoring.listAllScores() });
  } catch (e) { return handle(res, e); }
});

// ─── GitHub Evidence Sync (ADR-193 F4) ─────────────────────────────────────

router.get("/github/status", (_req: AuthRequest, res): any => {
  try {
    return res.json(GhSync.status());
  } catch (e) { return handle(res, e); }
});

/**
 * Sync metadata GitHub para uma evidência já anexada. Nunca cria evidência
 * nova — o vínculo (item ↔ evidência ↔ ref GitHub) é sempre explícito.
 *
 * Body: { kind?: 'pr'|'commit'|'issue' } — se omitido, tenta parsear
 * `reference` como owner/repo#N (pr) ou owner/repo@sha (commit).
 *
 * Efeito: merge do metadata GitHub em `product_evolution_evidence.metadata_json`
 * sob chave `github` (aditivo; não sobrescreve outras chaves).
 */
router.post("/evidence/:id/sync-github", async (req: AuthRequest, res): Promise<any> => {
  try {
    const evid = db.prepare("SELECT * FROM product_evolution_evidence WHERE id = ?")
      .get(req.params.id) as any;
    if (!evid) return res.status(404).json({ error: "evidence not_found" });

    const b = req.body || {};
    const kindOverride: 'pr' | 'commit' | 'issue' | undefined = b.kind;

    // Parseia reference se kind não veio explícito
    let owner: string, repo: string, ref: string, kind: 'pr' | 'commit' | 'issue';
    if (kindOverride && b.owner && b.repo && b.ref) {
      kind = kindOverride;
      owner = String(b.owner); repo = String(b.repo); ref = String(b.ref);
    } else {
      const parsed = GhSync.parseReference(evid.reference);
      if (!parsed) {
        return res.status(400).json({
          error: `não consegui parsear reference "${evid.reference}". Formato esperado: owner/repo#N ou owner/repo@sha. Ou envie {kind, owner, repo, ref} no body.`,
          code: "unparseable_reference",
        });
      }
      kind = kindOverride || parsed.kind;
      owner = parsed.owner; repo = parsed.repo; ref = parsed.ref;
    }

    let meta;
    if (kind === "pr") meta = await GhSync.fetchPr(owner, repo, Number(ref));
    else if (kind === "commit") meta = await GhSync.fetchCommit(owner, repo, ref);
    else if (kind === "issue") meta = await GhSync.fetchIssue(owner, repo, Number(ref));
    else return res.status(400).json({ error: `kind inválido: ${kind}` });

    // Merge no metadata_json existente sob chave 'github'
    let existing: Record<string, any> = {};
    try { if (evid.metadata_json) existing = JSON.parse(evid.metadata_json); } catch { /* mantém {} */ }
    existing.github = meta;
    db.prepare("UPDATE product_evolution_evidence SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(existing), req.params.id);

    return res.json({
      evidence_id: req.params.id,
      github: meta,
      synced_at: new Date().toISOString(),
    });
  } catch (e) { return handle(res, e); }
});

export default router;
