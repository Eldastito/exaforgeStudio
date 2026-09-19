/**
 * RetailSetupChecklistService — CHECKLIST VIVO de implantação da rede de lojas
 * (pedido do dono, 19/09/2026 — desdobramento do Guia de Implantação Varejo).
 *
 * A tese: os incêndios da implantação TOULON (Metas zeradas, "Em caixa"
 * inflado, comissão anônima, dia "de folga") são todos dado-fundação faltando.
 * Este serviço DETECTA essas lacunas sozinho — em vez de esperar alguém ler o
 * guia — e a Central de Saúde mostra "o que falta, em qual loja e onde
 * resolver".
 *
 * Regras duras:
 *  - 100% DERIVADO por query (RN-004): nenhuma tabela nova, nenhum contador,
 *    nenhum estado — o checklist reflete o banco AGORA e se "completa" sozinho
 *    quando o cadastro entra. Read-only absoluto.
 *  - HONESTO: cada item só acusa o que dá pra provar (ex.: filial órfã só
 *    quando há venda do PDV sem loja casando; depósito só quando houve
 *    dinheiro no fechamento e nenhum depósito registrado).
 *  - Gate por módulo: org sem o add-on `retail` → `applicable:false` (o
 *    checklist é da OPERAÇÃO DA REDE, não de toda org).
 *  - `todo` = quebra fluxo (dado que zera telas) · `warn` = degrada (tela
 *    funciona mas mente/empobrece). Janelas móveis (7/14/21/60 dias) em vez
 *    de aritmética de semana — robusto e sem duplicar a regra de calendário.
 *  - Isolamento multi-tenant: toda query filtra organization_id.
 */
import db from "./db.js";
import { ModuleService } from "./ModuleService.js";

export type ChecklistStatus = "ok" | "todo" | "warn";

export interface ChecklistItem {
  id: string;
  label: string;
  status: ChecklistStatus;
  detail: string | null;         // o que falta, nomeando lojas/filiais (curto)
  impact: string;                // o que quebra se ficar assim (linguagem do dono)
  action: { view: string; label: string }; // deep-link pra tela que resolve
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const listNames = (names: string[], max = 3) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} e mais ${names.length - max}`;

export class RetailSetupChecklistService {
  static checklist(orgId: string): { applicable: boolean; done: number; total: number; items: ChecklistItem[] } {
    if (!orgId || !ModuleService.isEnabled(orgId, "retail")) {
      return { applicable: false, done: 0, total: 0, items: [] };
    }

    const stores = db.prepare(
      `SELECT id, name, code, whatsapp_identifier, gross_margin_percent FROM retail_stores WHERE organization_id = ? AND active = 1`
    ).all(orgId) as any[];
    const hasStores = stores.length > 0;

    // O PDV está em uso? (proxy: alguma venda sincronizada nos últimos 60 dias)
    const pdvSince = daysAgo(60);
    const hasPdv = !!db.prepare(
      `SELECT 1 FROM retail_pdv_sales WHERE organization_id = ? AND sale_date >= ? LIMIT 1`
    ).get(orgId, pdvSince);

    const items: ChecklistItem[] = [];
    const push = (i: ChecklistItem) => items.push(i);

    // ── 1. Lojas cadastradas ────────────────────────────────────────────────
    push({
      id: "stores", label: "Lojas cadastradas",
      status: hasStores ? "ok" : "todo",
      detail: hasStores ? null : "Nenhuma loja ativa cadastrada.",
      impact: "Sem loja, nada da Operação da Rede existe — fechamento, malote, metas e comissão ficam vazios.",
      action: { view: "retailops", label: "Fechamento diário → Nova loja" },
    });

    // ── 2. Código da filial (a chave do PDV) ────────────────────────────────
    const noCode = stores.filter((s) => !String(s.code || "").trim());
    push({
      id: "store_codes", label: "Código da filial (ERP) nas lojas",
      // Com PDV em uso, loja sem código é quebra real; sem PDV ainda, é aviso.
      status: !hasStores ? "todo" : noCode.length === 0 ? "ok" : (hasPdv ? "todo" : "warn"),
      detail: noCode.length ? `Sem código: ${listNames(noCode.map((s) => s.name))}.` : (hasStores ? null : "Cadastre as lojas primeiro."),
      impact: "O código casa a loja com a filial do Alterdata — sem ele o PDV inteiro da filial é descartado e Metas/Resultado zeram.",
      action: { view: "retailops", label: "Editar loja → campo Código" },
    });

    // ── 3. Filiais órfãs (vendem no PDV sem loja casando) ───────────────────
    if (hasPdv) {
      const codes = new Set(stores.map((s) => String(s.code || "").trim()).filter(Boolean));
      const filiais = (db.prepare(
        `SELECT DISTINCT filial FROM retail_pdv_sales WHERE organization_id = ? AND sale_date >= ? AND COALESCE(status,'N') != 'C'`
      ).all(orgId, pdvSince) as any[]).map((r) => String(r.filial || "").trim()).filter(Boolean);
      const orphans = filiais.filter((f) => !codes.has(f));
      push({
        id: "orphan_filiais", label: "Filiais do PDV casando com as lojas",
        status: orphans.length === 0 ? "ok" : "todo",
        detail: orphans.length ? `Filial(is) vendendo sem loja: ${listNames(orphans)}.` : null,
        impact: "Venda de filial órfã não aparece em lugar nenhum — os números das telas ficam parciais em silêncio.",
        action: { view: "integrations", label: "Integrações → Filiais órfãs" },
      });
    }

    // ── 4. Vendedores cadastrados (matrícula + nome) ────────────────────────
    const sellerCount = Number((db.prepare(
      `SELECT COUNT(*) c FROM retail_sellers WHERE organization_id = ? AND active = 1 AND TRIM(COALESCE(name,'')) != ''`
    ).get(orgId) as any)?.c || 0);
    let unnamed = 0;
    if (hasPdv) {
      unnamed = Number((db.prepare(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(s.vendedor_codigo,''), s.vendedor)) c
           FROM retail_pdv_sales s
          WHERE s.organization_id = ? AND s.sale_date >= ? AND COALESCE(s.status,'N') != 'C'
            AND COALESCE(NULLIF(s.vendedor_codigo,''), s.vendedor, '') != ''
            AND COALESCE(NULLIF(s.vendedor_codigo,''), s.vendedor) NOT IN
                (SELECT matricula FROM retail_sellers WHERE organization_id = ? AND matricula IS NOT NULL)`
      ).get(orgId, pdvSince, orgId) as any)?.c || 0);
    }
    push({
      id: "sellers", label: "Vendedores com matrícula e nome",
      status: sellerCount === 0 ? "todo" : unnamed > 0 ? "warn" : "ok",
      detail: sellerCount === 0
        ? "Nenhum vendedor cadastrado."
        : unnamed > 0 ? `${unnamed} matrícula(s) do PDV sem cadastro (aparecem como "Matrícula NNNN").` : null,
      impact: "Sem matrícula+nome, a comissão sai anônima e o ranking do fechamento parte a mesma pessoa em duas linhas.",
      action: { view: "retailops", label: "Vendedores da loja" },
    });

    // ── 5. Escala da semana ─────────────────────────────────────────────────
    if (hasStores) {
      const since7 = daysAgo(7);
      const withSchedule = new Set((db.prepare(
        `SELECT DISTINCT store_id FROM retail_schedule_entries WHERE organization_id = ? AND work_date >= ? AND status = 'work'`
      ).all(orgId, since7) as any[]).map((r) => String(r.store_id)));
      const missing = stores.filter((s) => !withSchedule.has(String(s.id)));
      push({
        id: "schedule", label: "Escala da semana lançada",
        status: missing.length === 0 ? "ok" : "todo",
        detail: missing.length ? `Sem escala (últimos 7 dias): ${listNames(missing.map((s) => s.name))}.` : null,
        impact: "Sem escala, todo mundo aparece 'de folga' em Metas do vendedor e a cota do dia zera.",
        action: { view: "retailops", label: "Escala & cotas" },
      });

      // ── 6. Cotas definidas ────────────────────────────────────────────────
      const since21 = daysAgo(21);
      const hasQuota = !!db.prepare(
        `SELECT 1 FROM retail_store_quotas WHERE organization_id = ? AND quota_date >= ? LIMIT 1`
      ).get(orgId, since21) || !!db.prepare(
        `SELECT 1 FROM retail_seller_quotas WHERE organization_id = ? AND week_start >= ? LIMIT 1`
      ).get(orgId, since21);
      push({
        id: "quotas", label: "Cotas (loja e vendedor) definidas",
        status: hasQuota ? "ok" : "todo",
        detail: hasQuota ? null : "Nenhuma cota lançada nas últimas 3 semanas.",
        impact: "Sem cota não há régua: Metas mostra 'sem cota', o desvio do fechamento some e prêmio por meta não sai.",
        action: { view: "retailops", label: "Escala & cotas → Salvar cotas" },
      });

      // ── 7. Fechamento diário fluindo ──────────────────────────────────────
      const hasRecentClosing = !!db.prepare(
        `SELECT 1 FROM retail_daily_closings WHERE organization_id = ? AND closing_date >= ? AND status != 'rejected' LIMIT 1`
      ).get(orgId, daysAgo(3));
      push({
        id: "closings", label: "Fechamento diário entrando",
        status: hasRecentClosing ? "ok" : "warn",
        detail: hasRecentClosing ? null : "Nenhum fechamento informado nos últimos 3 dias.",
        impact: "Fechamento não informado ≠ venda zero: sem a folha, malote, metas e resultado ficam no escuro.",
        action: { view: "retailops", label: "Fechamento diário" },
      });

      // ── 8. Depósitos do malote sendo registrados ──────────────────────────
      const since14 = daysAgo(14);
      const cash14 = Number((db.prepare(
        `SELECT COALESCE(SUM(i.informed_amount),0) s FROM retail_daily_closings c
           JOIN retail_daily_closing_items i ON i.closing_id = c.id AND i.payment_method = 'dinheiro'
          WHERE c.organization_id = ? AND c.closing_date >= ? AND c.status != 'rejected'`
      ).get(orgId, since14) as any)?.s || 0);
      if (cash14 > 0) {
        const hasDeposit = !!db.prepare(
          `SELECT 1 FROM retail_cash_deposits WHERE organization_id = ? AND deposit_date >= ? LIMIT 1`
        ).get(orgId, since14);
        push({
          id: "deposits", label: "Depósitos do malote registrados",
          status: hasDeposit ? "ok" : "warn",
          detail: hasDeposit ? null : "Entrou dinheiro nos fechamentos, mas nenhum depósito foi registrado em 14 dias.",
          impact: "Sem registrar o depósito, o 'Em caixa (a depositar)' só acumula e parece rombo. Dá pra registrar mandando a foto do comprovante no WhatsApp com a palavra 'depósito'.",
          action: { view: "retailops", label: "Malote / Depósitos" },
        });
      }

      // ── 9. WhatsApp da loja (cobrança + fechamento por foto) ──────────────
      const noWa = stores.filter((s) => !String(s.whatsapp_identifier || "").trim());
      push({
        id: "store_whatsapp", label: "WhatsApp das lojas",
        status: noWa.length === 0 ? "ok" : "warn",
        detail: noWa.length ? `Sem WhatsApp: ${listNames(noWa.map((s) => s.name))}.` : null,
        impact: "Sem o número, a cobrança automática de pendências não tem destino e a loja não manda o fechamento por foto.",
        action: { view: "retailops", label: "Editar loja → WhatsApp da loja" },
      });

      // ── 10. Margem bruta (Resultado por loja) ─────────────────────────────
      const noMargin = stores.filter((s) => !(Number(s.gross_margin_percent) > 0));
      push({
        id: "margins", label: "Margem bruta das lojas",
        status: noMargin.length === 0 ? "ok" : "warn",
        detail: noMargin.length ? `Sem margem: ${listNames(noMargin.map((s) => s.name))}.` : null,
        impact: "Sem a margem, o Resultado por loja não calcula lucro nem ponto de equilíbrio.",
        action: { view: "retailops", label: "Editar loja → Margem bruta" },
      });
    }

    // ── 11. WhatsApp da empresa conectado ───────────────────────────────────
    const waConnected = !!db.prepare(
      `SELECT 1 FROM channels WHERE organization_id = ? AND provider IN ('evolution','evolution_go','whatsapp_cloud') AND status = 'connected' LIMIT 1`
    ).get(orgId);
    push({
      id: "whatsapp_channel", label: "WhatsApp da empresa conectado",
      status: waConnected ? "ok" : "todo",
      detail: waConnected ? null : "Nenhum número conectado.",
      impact: "Sem o número, não há cobrança automática, fechamento por foto, comprovante de depósito nem conversa com a IA.",
      action: { view: "channels", label: "Canais e I.A. → Conectar WhatsApp" },
    });

    // todo primeiro (quebra fluxo), depois warn, depois ok — leitura por prioridade.
    const rank: Record<ChecklistStatus, number> = { todo: 0, warn: 1, ok: 2 };
    items.sort((a, b) => rank[a.status] - rank[b.status]);
    const done = items.filter((i) => i.status === "ok").length;
    return { applicable: true, done, total: items.length, items };
  }
}
