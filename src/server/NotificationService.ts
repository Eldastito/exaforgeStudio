import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Notificações in-app por organização. Persiste em `notifications` e emite em
 * tempo real via Socket.io para o painel (sino no topo).
 *
 * Tipos: 'info' | 'success' | 'warning' | 'alert'. O frontend usa o tipo para
 * a cor/ícone. `meta` é livre (ex.: contactId, orderId) para deep-link futuro.
 *
 * Anti-spam: `dedupeKey` opcional evita repetir a mesma notificação dentro de
 * uma janela (ex.: estoque baixo do mesmo produto não notifica de hora em hora).
 */
export class NotificationService {
  static io: any = null;
  static setIo(io: any) { this.io = io; }

  static push(params: {
    organizationId: string;
    title: string;
    message: string;
    type?: 'info' | 'success' | 'warning' | 'alert';
    meta?: any;
    dedupeKey?: string;
    dedupeWindowMin?: number;
  }): boolean {
    const { organizationId, title, message } = params;
    if (!organizationId || !title) return false;
    const type = params.type || 'info';

    try {
      // Dedupe: se já existe uma notificação igual recente, não repete.
      if (params.dedupeKey) {
        const win = params.dedupeWindowMin ?? 360; // 6h por padrão
        const recent = db.prepare(`
          SELECT id FROM notifications
          WHERE organization_id = ? AND type = ? AND title = ? AND message = ?
            AND created_at >= datetime('now', ?)
          LIMIT 1
        `).get(organizationId, type, title, message, `-${win} minutes`) as any;
        if (recent) return false;
      }

      const id = uuidv4();
      db.prepare(`
        INSERT INTO notifications (id, organization_id, title, message, type, is_read)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(id, organizationId, title, message, type);

      if (this.io) {
        this.io.to(`org:${organizationId}`).emit('notification', {
          id, organization_id: organizationId, title, message, type,
          is_read: 0, meta: params.meta || null, created_at: new Date().toISOString(),
        });
      }
      return true;
    } catch (e) {
      console.error('[Notification] Falha ao criar:', e);
      return false;
    }
  }

  // ── Helpers semânticos para os eventos do dia-a-dia ──────────────────────

  static newLead(orgId: string, contactName: string, channel?: string) {
    return this.push({
      organizationId: orgId, type: 'info',
      title: '🆕 Novo lead',
      message: `${contactName || 'Um contato'} iniciou uma conversa${channel ? ` (${channel})` : ''}.`,
    });
  }

  static handoff(orgId: string, contactName: string) {
    return this.push({
      organizationId: orgId, type: 'warning',
      title: '🙋 Atendimento humano solicitado',
      message: `${contactName || 'Um cliente'} precisa de um atendente. A IA foi pausada nessa conversa.`,
    });
  }

  static orderCreated(orgId: string, contactName: string, total: number) {
    return this.push({
      organizationId: orgId, type: 'success',
      title: '🛒 Novo pedido',
      message: `Pedido de ${contactName || 'cliente'} no valor de R$ ${Number(total || 0).toFixed(2)} foi criado pela IA.`,
    });
  }

  static storeOrder(orgId: string, customerName: string, total: number) {
    return this.push({
      organizationId: orgId, type: 'success',
      title: '🛍️ Pedido pela vitrine',
      message: `${customerName || 'Um cliente'} fez um pedido de R$ ${Number(total || 0).toFixed(2)} na loja virtual.`,
    });
  }

  static paymentConfirmed(orgId: string, total: number, contactName?: string) {
    return this.push({
      organizationId: orgId, type: 'success',
      title: '💰 Pagamento confirmado',
      message: `Recebemos R$ ${Number(total || 0).toFixed(2)}${contactName ? ` de ${contactName}` : ''}.`,
    });
  }

  static lowStock(orgId: string, productName: string, qty: number) {
    return this.push({
      organizationId: orgId, type: 'warning',
      title: '📉 Estoque baixo',
      message: `"${productName}" está com apenas ${qty} unidade(s) disponível(is).`,
      dedupeKey: `lowstock:${productName}`, dedupeWindowMin: 720, // 12h
    });
  }

  static trialEnding(orgId: string, daysLeft: number) {
    return this.push({
      organizationId: orgId, type: 'alert',
      title: '⏰ Seu período de teste está acabando',
      message: `Faltam ${daysLeft} dia(s) para o fim do teste. Escolha um plano em Configurações → Cobrança para não perder o acesso.`,
      dedupeKey: `trial:${daysLeft}`, dedupeWindowMin: 1440, // 1x/dia
    });
  }

  static backupReady(orgId: string, ok: boolean) {
    return this.push({
      organizationId: orgId, type: ok ? 'success' : 'alert',
      title: ok ? '💾 Backup pronto' : '⚠️ Backup falhou',
      message: ok ? 'Seu backup foi gerado e está disponível para download em Integrações.' : 'Não conseguimos gerar o backup. Tente novamente.',
    });
  }
}
