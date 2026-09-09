/**
 * ChannelBindingMigrationService — F2.3 (RF-03 §9 "migração não habilita tudo").
 *
 * Deriva bindings de USO POR FINALIDADE a partir do que HOJE já determina o
 * canal, para preencher um PERFIL DE COMPATIBILIDADE — SEM ligar finalidades
 * novas. Só dois sinais existentes viram binding:
 *   - canal `kind='internal'`  → finalidade `gestao`   (número da equipe / Coordenador)
 *   - canal de atendimento (WhatsApp, não interno, não desabilitado) → `atendimento`
 * Campanhas/cobrança/agenda/etc. NÃO são inferidas — ficam desligadas até o dono
 * configurar (§9). Origem registrada (`origin='migration'`).
 *
 * Guardrails:
 *   - `dryRun` é o DEFAULT seguro: só relata o que faria, não grava.
 *   - Idempotente: rodar 2× não recria (binding já existente → `skip_existing`).
 *   - NUNCA sobrescreve binding MANUAL: se a finalidade já tem binding em OUTRO
 *     canal, reporta `conflict` e não mexe (revisão humana).
 *   - Isolado por org (INV-01). 0-regressão: como os produtores ainda não leem o
 *     resolvedor (Fase 6), migrar não muda envio — só popula o mapa.
 */
import db from "./db.js";
import { ChannelBindingService } from "./ChannelBindingService.js";
import { logAuthEvent } from "./auditLog.js";

const WA_PROVIDERS = ["evolution", "evolution_go", "whatsapp_cloud", "whatsapp_web"];

export interface MigrationPlanItem {
  feature: string;
  channelId: string;
  channelName: string;
  action: "create" | "skip_existing" | "conflict";
  detail?: string;
}
export interface MigrationReport {
  dryRun: boolean;
  planned: MigrationPlanItem[];
  created: number;
  skippedExisting: number;
  conflicts: number;
}

export class ChannelBindingMigrationService {
  static migrate(orgId: string, actorUserId: string | null, opts?: { dryRun?: boolean }): MigrationReport {
    const dryRun = opts?.dryRun !== false; // default TRUE (seguro)
    const report: MigrationReport = { dryRun, planned: [], created: 0, skippedExisting: 0, conflicts: 0 };
    if (!orgId) return report;

    // Candidatos: canais WhatsApp da org, não desabilitados, com finalidade inferida.
    const channels = db.prepare(
      `SELECT id, name, identifier, COALESCE(kind,'client') AS kind
         FROM channels
        WHERE organization_id = ? AND provider IN (${WA_PROVIDERS.map(() => "?").join(",")})
          AND COALESCE(status,'') != 'disabled'`
    ).all(orgId, ...WA_PROVIDERS) as any[];

    // Bindings existentes por finalidade (pra detectar manual/idempotência).
    const existing = ChannelBindingService.list(orgId);
    const byFeature = new Map<string, any[]>();
    for (const b of existing) {
      const arr = byFeature.get(b.feature_key) || [];
      arr.push(b); byFeature.set(b.feature_key, arr);
    }

    const candidates: { feature: string; channelId: string; channelName: string }[] = [];
    for (const c of channels) {
      const feature = c.kind === "internal" ? "gestao" : "atendimento";
      candidates.push({ feature, channelId: c.id, channelName: c.name || c.identifier || c.id.slice(0, 8) });
    }

    for (const cand of candidates) {
      const rules = byFeature.get(cand.feature) || [];
      const sameChannel = rules.find((r) => r.channel_id === cand.channelId);
      if (sameChannel) {
        report.planned.push({ ...cand, action: "skip_existing" });
        report.skippedExisting++;
        continue;
      }
      if (rules.length > 0) {
        // A finalidade já tem binding manual em outro canal → não sobrescreve.
        report.planned.push({ ...cand, action: "conflict", detail: "finalidade já configurada em outro número" });
        report.conflicts++;
        continue;
      }
      // Novo: criar (ou só planejar, se dryRun).
      report.planned.push({ ...cand, action: "create" });
      report.created++;
      if (!dryRun) {
        const r = ChannelBindingService.upsert(orgId, actorUserId, { channelId: cand.channelId, featureKey: cand.feature, origin: "migration" });
        if (!r.ok) {
          // Se falhar a escrita, rebaixa pra conflito honesto (não conta como criado).
          report.created--;
          report.conflicts++;
          const last = report.planned[report.planned.length - 1];
          last.action = "conflict"; last.detail = r.error || "falha na escrita";
        }
      }
    }

    if (!dryRun) {
      logAuthEvent(orgId, actorUserId, orgId, "CHANNEL_BINDINGS_MIGRATED", {
        created: report.created, skippedExisting: report.skippedExisting, conflicts: report.conflicts,
      });
    }
    return report;
  }
}
