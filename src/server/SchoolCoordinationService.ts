import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";

/**
 * Módulo Escola (ADR-144, Fatia 4) — o PAINEL DA COORDENAÇÃO.
 *
 * REUSA o kernel de sinais (ADR-132/136): não cria tabela nova. Deriva, de forma
 * DETERMINÍSTICA (zero-token) a partir dos dados das Fatias 1-3, os sinais que
 * exigem ação da coordenação e os publica no domínio `education` — o
 * ImpactPrioritizationService já os leva ao Pareto/briefing (agora com peso,
 * ação e dono próprios do domínio).
 *
 * Sinais derivados (recomputáveis, idempotentes por dedupe_key):
 *  - `turma_sem_professor`      — turma com alunos ativos e sem grade/professor ativo.
 *  - `falta_recorrente`         — aluno com N+ faltas NÃO justificadas (Fatia 1).
 *  - `aula_cancelada_recorrente`— item de grade com N+ aulas não realizadas (Fatia 2).
 *  - `atividade_lista_espera`   — extracurricular com fila de espera (Fatia 3).
 *
 * O passe RESOLVE os sinais que gerencia quando a condição deixa de valer
 * (resolveByDedupe), para o painel não acumular ruído.
 */

// Tipos de sinal que ESTE serviço gerencia (deriva e resolve). Não inclui os
// eventos pontuais student_absence/class_not_held (emitidos pelas Fatias 1/2).
const MANAGED_TYPES = ["turma_sem_professor", "falta_recorrente", "aula_cancelada_recorrente", "atividade_lista_espera"];

const ABSENCE_RECURRENCE = 3;   // faltas não justificadas p/ virar sinal de coordenação
const NOT_HELD_RECURRENCE = 2;  // aulas não realizadas p/ virar lacuna crônica

export interface CoordinationPassResult {
  published: number;
  resolved: number;
  byType: Record<string, number>;
}

export class SchoolCoordinationService {
  /**
   * Recomputa e publica os sinais de coordenação de uma org, e resolve os que
   * este serviço gerencia e não valem mais. Determinístico e idempotente.
   */
  static runSignalsPass(orgId: string): CoordinationPassResult {
    const out: CoordinationPassResult = { published: 0, resolved: 0, byType: {} };
    const valid = new Set<string>();
    const bump = (t: string) => { out.byType[t] = (out.byType[t] || 0) + 1; out.published++; };

    const publish = (dedupeKey: string, signalType: string, severity: string, entityType: string, entityId: string | null, evidence: any) => {
      BusinessSignalService.publish(orgId, {
        domain: "education", signalType, severity, basis: "fact", confidence: 1,
        sourceService: "SchoolCoordinationService", sourceEntityType: entityType, sourceEntityId: entityId,
        evidence, dedupeKey,
      });
      valid.add(dedupeKey);
      bump(signalType);
    };

    // 1. turma_sem_professor — turmas com alunos ativos, sem grade de professor ativo.
    const turmas = db.prepare(`SELECT DISTINCT turma FROM student_profiles WHERE organization_id = ? AND status = 'active' AND turma IS NOT NULL AND TRIM(turma) <> ''`).all(orgId) as any[];
    for (const { turma } of turmas) {
      const hasSchedule = db.prepare(`
        SELECT 1 FROM class_schedule_items cs
        JOIN teacher_profiles t ON t.id = cs.teacher_id AND t.organization_id = cs.organization_id AND t.status = 'active'
        WHERE cs.organization_id = ? AND cs.turma = ? AND cs.status = 'active' LIMIT 1`).get(orgId, turma);
      if (!hasSchedule) {
        const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM student_profiles WHERE organization_id = ? AND status = 'active' AND turma = ?`).get(orgId, turma) as any).n);
        publish(`education:turma_sem_professor:${turma}`, "turma_sem_professor", "risk", "turma", null, { turma, students: n });
      }
    }

    // 2. falta_recorrente — aluno com N+ faltas NÃO justificadas (sinais da Fatia 1).
    const absent = db.prepare(`
      SELECT source_entity_id AS student_id, COUNT(*) AS n
      FROM business_signals
      WHERE organization_id = ? AND domain = 'education' AND signal_type = 'student_absence'
        AND evidence_json LIKE '%"justified":false%'
      GROUP BY source_entity_id HAVING n >= ?`).all(orgId, ABSENCE_RECURRENCE) as any[];
    for (const a of absent) {
      const s = db.prepare(`SELECT full_name, turma FROM student_profiles WHERE id = ? AND organization_id = ?`).get(a.student_id, orgId) as any;
      publish(`education:falta_recorrente:${a.student_id}`, "falta_recorrente", "risk", "student", a.student_id, { student: s?.full_name || null, turma: s?.turma || null, absences: Number(a.n) });
    }

    // 3. aula_cancelada_recorrente — item de grade com N+ aulas não realizadas (Fatia 2).
    const notHeld = db.prepare(`
      SELECT schedule_item_id, COUNT(*) AS n
      FROM class_confirmations
      WHERE organization_id = ? AND status = 'not_held'
      GROUP BY schedule_item_id HAVING n >= ?`).all(orgId, NOT_HELD_RECURRENCE) as any[];
    for (const c of notHeld) {
      const item = db.prepare(`SELECT cs.turma, cs.subject, t.full_name AS teacher_name FROM class_schedule_items cs
        LEFT JOIN teacher_profiles t ON t.id = cs.teacher_id AND t.organization_id = cs.organization_id
        WHERE cs.id = ? AND cs.organization_id = ?`).get(c.schedule_item_id, orgId) as any;
      publish(`education:aula_cancelada_recorrente:${c.schedule_item_id}`, "aula_cancelada_recorrente", "risk", "class_schedule_item", c.schedule_item_id,
        { turma: item?.turma || null, subject: item?.subject || null, teacher: item?.teacher_name || null, notHeld: Number(c.n) });
    }

    // 4. atividade_lista_espera — extracurricular com fila de espera (Fatia 3).
    const waitl = db.prepare(`
      SELECT a.id AS activity_id, a.name, COUNT(e.id) AS n
      FROM extracurricular_activities a
      JOIN extracurricular_enrollments e ON e.activity_id = a.id AND e.organization_id = a.organization_id AND e.status = 'waitlisted'
      WHERE a.organization_id = ? AND a.status = 'active'
      GROUP BY a.id HAVING n >= 1`).all(orgId) as any[];
    for (const w of waitl) {
      publish(`education:atividade_lista_espera:${w.activity_id}`, "atividade_lista_espera", "attention", "extracurricular_activity", w.activity_id, { activity: w.name, waitlist: Number(w.n) });
    }

    // Resolve os sinais gerenciados que não valem mais (condição deixou de existir).
    const ph = MANAGED_TYPES.map(() => "?").join(",");
    const open = db.prepare(`SELECT dedupe_key FROM business_signals WHERE organization_id = ? AND domain = 'education' AND status = 'open' AND signal_type IN (${ph})`).all(orgId, ...MANAGED_TYPES) as any[];
    for (const o of open) {
      if (!valid.has(o.dedupe_key)) { BusinessSignalService.resolveByDedupe(orgId, o.dedupe_key); out.resolved++; }
    }
    return out;
  }

  /**
   * Painel da coordenação: sinais abertos do domínio `education` com a AÇÃO
   * recomendada (do kernel), e as prioridades do Pareto para o domínio.
   */
  static panel(orgId: string): { signals: any[]; priorities: any[]; generatedAt: string } {
    const signals = BusinessSignalService.list(orgId, { domain: "education", status: "open" }).map((s: any) => ({
      ...s,
      action: ImpactPrioritizationService.actionFor(s.signal_type),
    }));
    const prio = ImpactPrioritizationService.prioritize(orgId, { perDomain: 5 });
    return { signals, priorities: prio?.byDomain?.education || [], generatedAt: prio?.generatedAt || "" };
  }
}

export default SchoolCoordinationService;
