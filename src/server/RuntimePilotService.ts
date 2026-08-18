/**
 * Runtime Pilot — ativação dos pilotos do ADR-152 por organização.
 *
 * O que o CLI (`scripts/pilot-runtime.ts`, ADR-152 F4d.1) usa pra ligar os
 * pilotos Cobrança (F4b*) e Recuperação Comercial (F4c*) numa org REAL,
 * de forma idempotente e auditada.
 *
 * `plan` NÃO escreve nada (dry-run/diagnóstico); `apply` liga as flags
 * pedidas, ajusta tuning e — opcionalmente — semeia `agent_policies`
 * exigidas pelo CommandExecutor (autonomy=execute + execution_mode=
 * approved_execution). Sem essas policies o executor F2.2 recusa antes de
 * qualquer efeito externo (guardas triplas).
 *
 * Cascade explícita (não é convenção — é gate técnico):
 *   collection|sales_recovery  →  exige runtime  (runtimeGate abre)
 *   followup|attribution       →  exigem sales_recovery
 *
 * Nunca DESLIGA flag automaticamente — CLI é opt-in por design (dono liga
 * o que quer; pra desligar usa SQL direto ou reverte o valor). Isso evita
 * que "aplicar de novo" apague configuração feita manualmente entre 2
 * rodadas.
 *
 * G-4c-1 preservada: mesmo com todas as flags LIGADAS, cada envio real
 * continua exigindo o clique humano de aprovação (execution_mode=
 * approved_execution). Modo `autonomous` fica BLOQUEADO na decisão #4
 * (LGPD) até parecer jurídico — este service NUNCA seta autonomous.
 *
 * RN-152-F4d.1-001: orgId sempre 1º arg; toda query filtra organization_id.
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";

const ACTOR = "runtime-pilot-cli";

export interface RuntimePilotOpts {
  // Flags (opt-in — só liga; nunca desliga aqui)
  runtime?: boolean;         // execution_runtime_enabled
  collection?: boolean;      // collection_cadence_enabled
  salesRecovery?: boolean;   // sales_recovery_enabled
  followup?: boolean;        // sales_recovery_followup_enabled
  attribution?: boolean;     // sales_recovery_attribution_enabled
  seedPolicies?: boolean;    // semeia agent_policies exigidas pelo Executor F2.2

  // Tuning (só grava se veio no opts)
  collectionR2Days?: number;         // 1..30
  collectionR3Days?: number;         // 1..60
  collectionGraceDays?: number;      // 0..14
  stalledDays?: number;              // 1..90
  replyWindowDays?: number;          // 1..60
  followupGapDays?: number;          // 1..30
  attributionWindowDays?: number;    // 1..90
}

export interface RuntimePilotPlan {
  org: { orgId: string; name: string; vertical: string | null; status: string };
  flags: {
    runtime: boolean;
    collection: boolean;
    salesRecovery: boolean;
    followup: boolean;
    attribution: boolean;
  };
  tuning: {
    collectionR2Days: number;
    collectionR3Days: number;
    collectionGraceDays: number;
    stalledDays: number;
    replyWindowDays: number;
    followupGapDays: number;
    attributionWindowDays: number;
  };
  prereqs: {
    channelsConnected: number;
    contactsCount: number;
    ownersCount: number;
    openaiKey: boolean;
    policiesReady: { collection: boolean; salesRecovery: boolean };
  };
  readiness: "PRONTO" | "PENDENCIAS" | "BLOQUEADO";
  blockers: string[];
  warnings: string[];
}

// Policies exigidas pelo CommandExecutor F2.2 pra cada piloto. Cada linha
// vira 1 row em agent_policies (UNIQUE(org, domain, action_type)) —
// semeadas quando `--seed-policies` é passado ao apply.
//
// - runtime_step_send_reminder / runtime_step_propose: são os `command_type`
//   dos steps compostos dos playbooks (CollectionPlaybook / SalesRecoveryPlaybook).
// - collection_send_reminder / sales_recovery_propose_message: são os
//   handlers concretos que o step chama internamente (WhatsApp+PIX).
const REQUIRED_POLICIES = {
  collection: [
    { domain: "runtime", action_type: "runtime_step_send_reminder" },
    { domain: "runtime", action_type: "collection_send_reminder" },
  ],
  salesRecovery: [
    { domain: "runtime", action_type: "runtime_step_propose" },
    { domain: "runtime", action_type: "sales_recovery_propose_message" },
  ],
} as const;

function policyReady(orgId: string, list: ReadonlyArray<{ domain: string; action_type: string }>): boolean {
  for (const p of list) {
    const row = db.prepare(
      `SELECT autonomy_level, execution_mode, active FROM agent_policies
        WHERE organization_id = ? AND domain = ? AND action_type = ?`,
    ).get(orgId, p.domain, p.action_type) as any;
    if (!row) return false;
    if (Number(row.active) !== 1) return false;
    if (row.autonomy_level !== "execute") return false;
    // approved_execution é o piso; autonomous também passa (mas ainda BLOQUEADO por LGPD — não semeamos).
    if (row.execution_mode !== "approved_execution" && row.execution_mode !== "autonomous") return false;
  }
  return true;
}

export class RuntimePilotService {
  /** Busca orgs candidatas por substring do NOME ou do ID (dono usa pra achar
   *  sem chutar o id; casa também pelo organization_id caso ele cole o id). */
  static findOrgs(term: string): Array<{ orgId: string; name: string; vertical: string | null; status: string }> {
    const like = `%${String(term || "").toLowerCase()}%`;
    return (db.prepare(
      `SELECT organization_id, business_name, vertical, status FROM organization_settings
        WHERE deleted_at IS NULL
          AND (LOWER(COALESCE(business_name, '')) LIKE ? OR LOWER(organization_id) LIKE ?)
        ORDER BY business_name LIMIT 20`,
    ).all(like, like) as any[])
      .map((r) => ({ orgId: r.organization_id, name: r.business_name || r.organization_id, vertical: r.vertical || null, status: r.status }));
  }

  /** Diagnóstico SEM escrita: o que está ligado e o que falta pra rodar. */
  static plan(orgId: string): RuntimePilotPlan {
    const org = db.prepare(
      `SELECT organization_id, business_name, vertical, status,
              execution_runtime_enabled,
              collection_cadence_enabled, collection_reminder_2_days_after_due,
              collection_reminder_3_days_after_due, collection_promise_grace_days,
              sales_recovery_enabled, sales_recovery_stalled_days,
              sales_recovery_reply_window_days,
              sales_recovery_followup_enabled, sales_recovery_followup_days_gap,
              sales_recovery_attribution_enabled, sales_recovery_attribution_window_days
         FROM organization_settings WHERE organization_id = ? AND deleted_at IS NULL`,
    ).get(orgId) as any;
    if (!org) throw new Error(`Organização não encontrada: ${orgId}`);

    const flags = {
      runtime: !!Number(org.execution_runtime_enabled),
      collection: !!Number(org.collection_cadence_enabled),
      salesRecovery: !!Number(org.sales_recovery_enabled),
      followup: !!Number(org.sales_recovery_followup_enabled),
      attribution: !!Number(org.sales_recovery_attribution_enabled),
    };

    const tuning = {
      collectionR2Days: Number(org.collection_reminder_2_days_after_due ?? 3),
      collectionR3Days: Number(org.collection_reminder_3_days_after_due ?? 7),
      collectionGraceDays: Number(org.collection_promise_grace_days ?? 0),
      stalledDays: Number(org.sales_recovery_stalled_days ?? 10),
      replyWindowDays: Number(org.sales_recovery_reply_window_days ?? 14),
      followupGapDays: Number(org.sales_recovery_followup_days_gap ?? 5),
      attributionWindowDays: Number(org.sales_recovery_attribution_window_days ?? 30),
    };

    const chan = db.prepare(
      `SELECT COUNT(*) c FROM channels WHERE organization_id = ? AND provider = 'whatsapp' AND status = 'connected'`,
    ).get(orgId) as any;
    const cont = db.prepare(`SELECT COUNT(*) c FROM contacts WHERE organization_id = ?`).get(orgId) as any;
    const owners = db.prepare(
      `SELECT COUNT(*) c FROM users u
         JOIN role_profiles p ON p.id = u.role_profile_id AND p.organization_id = u.organization_id
        WHERE u.organization_id = ? AND u.global_status = 'active' AND p.system_key = 'owner'`,
    ).get(orgId) as any;

    const prereqs = {
      channelsConnected: Number(chan?.c || 0),
      contactsCount: Number(cont?.c || 0),
      ownersCount: Number(owners?.c || 0),
      openaiKey: !!process.env.OPENAI_API_KEY,
      policiesReady: {
        collection: policyReady(orgId, REQUIRED_POLICIES.collection),
        salesRecovery: policyReady(orgId, REQUIRED_POLICIES.salesRecovery),
      },
    };

    const warnings: string[] = [];
    const blockers: string[] = [];

    // Cascade (gate técnico, não convenção): runtime é o master gate; sub-pilotos precisam dele
    if (!flags.runtime && (flags.collection || flags.salesRecovery)) {
      blockers.push("execution_runtime_enabled=0 mas sub-piloto ligado — runtimeGate 403 bloqueia. Corrige: --apply --runtime");
    }
    if (!flags.salesRecovery && (flags.followup || flags.attribution)) {
      blockers.push("sales_recovery_enabled=0 mas follow-up/atribuição ligados — sem base pra rodar. Corrige: --apply --sales-recovery");
    }

    // Pré-reqs pra piloto funcionar de fato (warning, não bloqueio — dono pode saber e ligar mesmo assim)
    if ((flags.collection || flags.salesRecovery) && prereqs.channelsConnected === 0) {
      warnings.push("Sem canal WhatsApp conectado (provider='whatsapp' status='connected') — envios ficam pendentes no ConfirmationEngine. Configure em Configurações › Canais.");
    }
    if (flags.salesRecovery && prereqs.contactsCount === 0) {
      warnings.push("Sem contatos importados — detector de deals parados varre em cima de contacts.");
    }
    if ((flags.collection || flags.salesRecovery) && prereqs.ownersCount === 0) {
      warnings.push("Nenhum usuário com role_profile.system_key='owner' ativo — G-4c-1 exige aprovação humana; sem owner, ninguém aprova envios pelo painel.");
    }
    if ((flags.collection || flags.salesRecovery) && !prereqs.openaiKey) {
      warnings.push("OPENAI_API_KEY não definida no ambiente do servidor — LLM cai em template fallback (piloto roda com mensagens genéricas).");
    }
    if (flags.collection && !prereqs.policiesReady.collection) {
      warnings.push("Policies de cobrança ausentes/incorretas (runtime.runtime_step_send_reminder + runtime.collection_send_reminder em autonomy=execute + execution_mode=approved_execution). Corrige: --apply --collection --seed-policies");
    }
    if (flags.salesRecovery && !prereqs.policiesReady.salesRecovery) {
      warnings.push("Policies de recuperação ausentes/incorretas (runtime.runtime_step_propose + runtime.sales_recovery_propose_message). Corrige: --apply --sales-recovery --seed-policies");
    }

    const readiness: RuntimePilotPlan["readiness"] =
      blockers.length ? "BLOQUEADO" : warnings.length ? "PENDENCIAS" : "PRONTO";

    return {
      org: { orgId: org.organization_id, name: org.business_name || orgId, vertical: org.vertical || null, status: org.status },
      flags, tuning, prereqs, readiness, blockers, warnings,
    };
  }

  /** Aplica flags/tuning/policies idempotente. Retorna o plan pós-aplicação. */
  static apply(orgId: string, opts: RuntimePilotOpts = {}): RuntimePilotPlan {
    const before = this.plan(orgId); // valida org e serve de baseline no audit

    // Cascade — falha rápido (dono acha o erro na hora, não vai debugar por que o piloto não roda)
    const willRuntime = opts.runtime === true || before.flags.runtime;
    if ((opts.collection === true || opts.salesRecovery === true) && !willRuntime) {
      throw new Error("Ligue --runtime junto de --collection/--sales-recovery (runtimeGate exige execution_runtime_enabled=1).");
    }
    const willSalesRecovery = opts.salesRecovery === true || before.flags.salesRecovery;
    if ((opts.followup === true || opts.attribution === true) && !willSalesRecovery) {
      throw new Error("Ligue --sales-recovery junto de --followup/--attribution (sub-pilotos exigem base da recuperação).");
    }

    // Validação numérica (mesmo range que o PRD §13.5 documenta; fora disso é bug de operador)
    const inRange = (label: string, val: number | undefined, min: number, max: number) => {
      if (val == null) return;
      if (!Number.isFinite(val) || val < min || val > max || val !== Math.trunc(val)) {
        throw new Error(`${label} deve ser inteiro entre ${min} e ${max} (recebido: ${val}).`);
      }
    };
    inRange("collection-r2-days", opts.collectionR2Days, 1, 30);
    inRange("collection-r3-days", opts.collectionR3Days, 1, 60);
    inRange("collection-grace-days", opts.collectionGraceDays, 0, 14);
    inRange("stalled-days", opts.stalledDays, 1, 90);
    inRange("reply-window-days", opts.replyWindowDays, 1, 60);
    inRange("followup-gap-days", opts.followupGapDays, 1, 30);
    inRange("attribution-window-days", opts.attributionWindowDays, 1, 90);

    // Liga flags (opt-in — nunca desliga)
    const setInt = (col: string, val: 0 | 1) => {
      db.prepare(`UPDATE organization_settings SET ${col} = ? WHERE organization_id = ?`).run(val, orgId);
    };
    const setNum = (col: string, val: number | undefined) => {
      if (val == null) return;
      db.prepare(`UPDATE organization_settings SET ${col} = ? WHERE organization_id = ?`).run(val, orgId);
    };

    if (opts.runtime === true) setInt("execution_runtime_enabled", 1);
    if (opts.collection === true) setInt("collection_cadence_enabled", 1);
    if (opts.salesRecovery === true) setInt("sales_recovery_enabled", 1);
    if (opts.followup === true) setInt("sales_recovery_followup_enabled", 1);
    if (opts.attribution === true) setInt("sales_recovery_attribution_enabled", 1);

    setNum("collection_reminder_2_days_after_due", opts.collectionR2Days);
    setNum("collection_reminder_3_days_after_due", opts.collectionR3Days);
    setNum("collection_promise_grace_days", opts.collectionGraceDays);
    setNum("sales_recovery_stalled_days", opts.stalledDays);
    setNum("sales_recovery_reply_window_days", opts.replyWindowDays);
    setNum("sales_recovery_followup_days_gap", opts.followupGapDays);
    setNum("sales_recovery_attribution_window_days", opts.attributionWindowDays);

    // Seed idempotente das policies exigidas pelo CommandExecutor F2.2.
    // Se já existir, força os campos corretos (autonomy=execute + execution_mode=approved_execution + active=1) —
    // dono pode ter deixado incorreto por engano (ex: autonomy=observe).
    const seededPolicies: Array<{ domain: string; action_type: string; created: boolean }> = [];
    if (opts.seedPolicies === true) {
      const seedIf = (list: ReadonlyArray<{ domain: string; action_type: string }>) => {
        for (const p of list) {
          const existing = db.prepare(
            `SELECT id, autonomy_level, execution_mode, active FROM agent_policies
              WHERE organization_id = ? AND domain = ? AND action_type = ?`,
          ).get(orgId, p.domain, p.action_type) as any;
          if (!existing) {
            db.prepare(
              `INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active)
               VALUES (?, ?, ?, ?, 'execute', 'approved_execution', 1)`,
            ).run(randomUUID(), orgId, p.domain, p.action_type);
            seededPolicies.push({ domain: p.domain, action_type: p.action_type, created: true });
          } else {
            db.prepare(
              `UPDATE agent_policies SET autonomy_level='execute', execution_mode='approved_execution', active=1
                WHERE id = ?`,
            ).run(existing.id);
            seededPolicies.push({ domain: p.domain, action_type: p.action_type, created: false });
          }
        }
      };
      const collectionActive = opts.collection === true || before.flags.collection;
      const salesRecoveryActive = opts.salesRecovery === true || before.flags.salesRecovery;
      if (collectionActive) seedIf(REQUIRED_POLICIES.collection);
      if (salesRecoveryActive) seedIf(REQUIRED_POLICIES.salesRecovery);
    }

    try {
      logAuthEvent(orgId, ACTOR, null, "RUNTIME_PILOT_APPLY", {
        opts: {
          runtime: opts.runtime ?? null,
          collection: opts.collection ?? null,
          salesRecovery: opts.salesRecovery ?? null,
          followup: opts.followup ?? null,
          attribution: opts.attribution ?? null,
          seedPolicies: opts.seedPolicies ?? null,
          tuning: {
            collectionR2Days: opts.collectionR2Days ?? null,
            collectionR3Days: opts.collectionR3Days ?? null,
            collectionGraceDays: opts.collectionGraceDays ?? null,
            stalledDays: opts.stalledDays ?? null,
            replyWindowDays: opts.replyWindowDays ?? null,
            followupGapDays: opts.followupGapDays ?? null,
            attributionWindowDays: opts.attributionWindowDays ?? null,
          },
        },
        seededPolicies,
        before: {
          runtime: before.flags.runtime,
          collection: before.flags.collection,
          salesRecovery: before.flags.salesRecovery,
          followup: before.flags.followup,
          attribution: before.flags.attribution,
        },
      });
    } catch { /* best-effort audit */ }
    return this.plan(orgId);
  }
}
