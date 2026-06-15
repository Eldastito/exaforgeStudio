import db from "./db.js";
import { generateRagResponse } from "./geminiRAG.js";
import { AIOrchestratorService } from "./AIOrchestratorService.js";
import { OrdersService } from "./OrdersService.js";
import { PaymentService } from "./PaymentService.js";
import { CustomerProfileService } from "./CustomerProfileService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { CadenceService } from "./CadenceService.js";
import { NotificationService } from "./NotificationService.js";
import { AttendanceAreaService } from "./AttendanceAreaService.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";
import { GoogleAutomationService } from "./GoogleAutomationService.js";
import { ReservationService } from "./ReservationService.js";
import { SubscriptionService } from "./SubscriptionService.js";
import { ReportPdfService } from "./ReportPdfService.js";
import { HandoffSummaryService } from "./HandoffSummaryService.js";
import { SatisfactionService } from "./SatisfactionService.js";
import { ReferralService } from "./ReferralService.js";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

export async function processIncomingMessage(
  payload: {
    channelId: string | null;  // DB ID of the channel OR null if mapping by org/identifier
    organizationId: string | null; 
    identifier: string; // The business ID/Instance Name
    provider: 'whatsapp_cloud' | 'instagram' | 'evolution' | 'whatsapp_web';
    senderId: string;
    contactName?: string;
    contactAvatar?: string;
    text: string;
    mediaUrl?: string;
  },
  io: any
) {
  // ===== Roteamento MULTI-TENANT =====
  // A organização é derivada do CANAL que casa com a instância/identificador
  // do webhook (entre TODAS as organizações). Só se não achar nada é que caímos
  // no comportamento antigo (org do dono), preservando o ambiente atual.
  let channel: any;

  if (payload.channelId) {
    channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(payload.channelId) as any;
  } else {
    // 1) Match exato por identifier+provider em QUALQUER organização.
    channel = db.prepare('SELECT * FROM channels WHERE identifier = ? AND provider = ?')
      .get(payload.identifier, payload.provider) as any;

    // 2) Instagram: o entry.id do webhook nem sempre é o IG Business ID salvo.
    //    Se houver só um canal de Instagram no sistema, usa ele.
    if (!channel && payload.provider === 'instagram') {
      const igs = db.prepare("SELECT * FROM channels WHERE provider = 'instagram'").all() as any[];
      if (igs.length === 1) channel = igs[0];
    }
  }

  // Organização-alvo: a do canal encontrado. Se NÃO houver canal correspondente,
  // só atribuímos a uma organização quando o sistema tem UMA única empresa
  // (deploy single-tenant) — assim um remetente desconhecido não pode ser
  // injetado no atendimento de um tenant específico num ambiente multi-empresa.
  let targetOrg: string;
  if (channel) {
    targetOrg = channel.organization_id;
  } else {
    const orgs = db.prepare(
      "SELECT DISTINCT organization_id FROM users WHERE role = 'owner'"
    ).all() as any[];
    if (orgs.length === 1) {
      targetOrg = orgs[0].organization_id;
    } else {
      console.warn(`[Webhook] Mensagem de remetente sem canal correspondente ignorada (identifier=${payload.identifier ?? '?'}; ${orgs.length} organizações). Cadastre o canal para receber.`);
      return;
    }
  }

  // Se ainda não existe canal, cria na organização-alvo (caminho legado/1ª vez).
  if (!channel) {
    const chId = uuidv4();
    db.prepare(`
      INSERT INTO channels (id, organization_id, provider, name, identifier, status)
      VALUES (?, ?, ?, ?, ?, 'connected')
    `).run(chId, targetOrg, payload.provider, payload.identifier || "Default Channel", payload.identifier);

    channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(chId) as any;
  }

  if (channel.status === 'disabled') {
     console.log(`[Webhook] Canal ${channel.id} pausado/desabilitado. Ignorando.`);
     return;
  }

  const orgId = channel.organization_id;

  // 1. Resolve Contact
  let contact = db.prepare('SELECT * FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?')
    .get(orgId, channel.id, payload.senderId) as any;

  if (!contact) {
    const contactId = uuidv4();
    db.prepare(`
      INSERT INTO contacts (id, organization_id, channel_id, name, identifier, profile_pic_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(contactId, orgId, channel.id, payload.contactName || payload.senderId, payload.senderId, payload.contactAvatar || null);
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as any;
  } else {
    // update avatar if provided
    if (payload.contactAvatar && payload.contactAvatar !== contact.profile_pic_url) {
      db.prepare('UPDATE contacts SET profile_pic_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(payload.contactAvatar, contact.id);
    }
  }

  // 2. Resolve Ticket
  let ticket = db.prepare('SELECT * FROM tickets WHERE contact_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
    .get(contact.id, 'open') as any;

  if (!ticket) {
    const ticketId = uuidv4();
    db.prepare(`
      INSERT INTO tickets (id, organization_id, contact_id, status, stage, ai_paused)
      VALUES (?, ?, ?, 'open', 'novo_lead', 0)
    `).run(ticketId, orgId, contact.id);
    ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
    // Notifica a equipe: novo lead iniciou conversa.
    try { NotificationService.newLead(orgId, contact.name, channel.provider); } catch (e) { /* noop */ }
  }

  // 3. Save incoming message
  const msgId = uuidv4();
  db.prepare(`
    INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, media_url)
    VALUES (?, ?, ?, 'contact', ?, ?)
  `).run(msgId, orgId, ticket.id, payload.text, payload.mediaUrl || null);

  // CRM: registra o último contato e recalcula a temperatura do lead.
  CustomerProfileService.touchContact(contact.id);

  // Cadência: ao receber mensagem do contato, cancela o follow-up pendente e
  // atualiza o timestamp para que o próximo delay conte a partir de agora.
  try {
    CadenceService.cancelForTicket(ticket.id);
  } catch (e) { /* noop */ }

  // Opt-out de campanhas: se o cliente pedir para sair, marca e NÃO recebe mais
  // mensagens ativas (obrigatório para não ser marcado como spam).
  const optOutText = (payload.text || '').trim().toLowerCase();
  if (/^(sair|parar|pare|cancelar|descadastrar|stop|remover|nao quero|não quero)\b/.test(optOutText)) {
    try { db.prepare('UPDATE contacts SET marketing_opt_out = 1 WHERE id = ?').run(contact.id); } catch(e){}
  }

  // 4. Emit to Organization Room (Frontend multi-tenant support)
  if (io) {
    const msgPayload = {
       id: msgId,
       ticketId: ticket.id,
       contactId: contact.id, // for backwards compat tracking
       contactName: contact.name,
       contactNumber: contact.identifier, // telefone real, para exibir na UI ao vivo
       contactAvatar: contact.profile_pic_url,
       provider: channel.provider,
       text: payload.text,
       mediaUrl: payload.mediaUrl,
       sender: "contact",
       timestamp: new Date().toISOString()
    };
    io.to(`org:${orgId}`).emit("new_message", msgPayload);
  }

  // 4.5 PESQUISA DE SATISFAÇÃO: se há uma pesquisa aberta e o cliente respondeu
  // com uma nota (1-5), registra, responde automaticamente (pede desculpas se
  // detrator) e encerra — sem acionar a IA normal nesta mensagem.
  try {
    const pending = SatisfactionService.pendingForContact(orgId, contact.id);
    if (pending) {
      const score = SatisfactionService.parseScore(payload.text);
      if (score !== null) {
        SatisfactionService.record(orgId, pending.id, score, payload.text);
        const first = (contact.name || '').trim().split(/\s+/)[0] || '';
        const reply = SatisfactionService.replyFor(score, first);
        const sId = uuidv4();
        db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content) VALUES (?, ?, ?, 'bot', ?)`)
          .run(sId, orgId, ticket.id, reply);
        if (io) io.to(`org:${orgId}`).emit("new_message", { id: sId, ticketId: ticket.id, contactId: contact.id, provider: channel.provider, text: reply, sender: "bot", timestamp: new Date().toISOString() });
        await MessageProviderService.sendMessage(channel.id, payload.senderId, reply);
        // Detrator: apenas registra e pede desculpas (a IA segue cuidando da
        // próxima mensagem do cliente). Sem acionar humano (escolha do produto).
        return;
      }
    }
  } catch (e) { console.error('[CSAT] Falha ao processar resposta de satisfação', e); }

  // 5. Call AI if enabled
  if (channel.ai_enabled === 1 && ticket.ai_paused === 0) {
      try {
       // Envia uma resposta do bot (persiste + emite + entrega ao provedor).
       const sendBotReply = async (text: string) => {
         const bId = uuidv4();
         db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content) VALUES (?, ?, ?, 'bot', ?)`)
           .run(bId, orgId, ticket.id, text);
         if (io) io.to(`org:${orgId}`).emit("new_message", { id: bId, ticketId: ticket.id, contactId: contact.id, provider: channel.provider, text, sender: "bot", timestamp: new Date().toISOString() });
         await MessageProviderService.sendMessage(channel.id, payload.senderId, text);
       };

       // ÁREAS DE ATENDIMENTO: se a org tem 2+ áreas, roteia ANTES da IA.
       let areaPersona: string | undefined;
       const areas = AttendanceAreaService.activeAreas(orgId);
       if (areas.length >= 2) {
         // Pedido de trocar de área. Se a mensagem já nomeia OUTRA área, pula
         // direto para ela; senão, volta ao menu para o cliente escolher.
         if (ticket.area_id && AttendanceAreaService.wantsSwitch(payload.text)) {
           const target = AttendanceAreaService.match(orgId, payload.text);
           if (target && target.id !== ticket.area_id) {
             db.prepare('UPDATE tickets SET area_id = ?, assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
               .run(target.id, target.assigned_user_id || null, ticket.id);
             ticket.area_id = target.id;
             if (io) io.to(`org:${orgId}`).emit("ticket_updated", { ticketId: ticket.id, contactId: contact.id, areaId: target.id, assignedTo: target.assigned_user_id || null });
             areaPersona = AttendanceAreaService.personaText(target);
             // Segue para a IA responder já como a nova área.
           } else {
             db.prepare('UPDATE tickets SET area_id = NULL, assigned_to = NULL WHERE id = ?').run(ticket.id);
             ticket.area_id = null;
             await sendBotReply(AttendanceAreaService.buildMenu(orgId, contact.name));
             return;
           }
         }
         if (!ticket.area_id) {
           const matched = AttendanceAreaService.match(orgId, payload.text);
           if (matched) {
             db.prepare('UPDATE tickets SET area_id = ?, assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
               .run(matched.id, matched.assigned_user_id || null, ticket.id);
             ticket.area_id = matched.id;
             if (io) io.to(`org:${orgId}`).emit("ticket_updated", { ticketId: ticket.id, contactId: contact.id, areaId: matched.id, assignedTo: matched.assigned_user_id || null });
             areaPersona = AttendanceAreaService.personaText(matched);
             // Segue para a IA responder já como a área escolhida.
           } else {
             // Ainda não escolheu: manda as boas-vindas + menu e aguarda.
             await sendBotReply(AttendanceAreaService.buildMenu(orgId, contact.name));
             return;
           }
         } else {
           const area = AttendanceAreaService.getArea(orgId, ticket.area_id);
           if (area) areaPersona = AttendanceAreaService.personaText(area);
         }
       }

       // Histórico da conversa (sem a mensagem atual) para a IA continuar de onde
       // parou, em vez de recomeçar a cada mensagem.
       const historyRows = db.prepare(`
         SELECT sender_type, content FROM messages
         WHERE ticket_id = ? AND id != ?
         ORDER BY created_at DESC LIMIT 20
       `).all(ticket.id, msgId) as any[];
       const history = historyRows.reverse().map(r => ({
         role: r.sender_type === 'contact' ? 'Cliente' : (r.sender_type === 'agent' ? 'Atendente' : 'Assistente'),
         text: r.content,
       }));

       let aiResult = await AIOrchestratorService.processMessage({
          message: payload.text,
          organizationId: orgId,
          senderId: payload.senderId,
          contactName: contact.name,
          channelId: channel.id,
          ticketStage: ticket.stage,
          history,
          contactId: contact.id,
          provider: channel.provider,
          areaPersona,
          areaId: ticket.area_id || null,
       });

       // ROTEAMENTO PELA IA: quando a IA sinaliza que o cliente quer outra área
       // (route_to_area), trocamos o ticket de área e RE-EXECUTAMOS a IA já como
       // a nova área, para responder na mesma mensagem (sem prometer e não cumprir).
       if (areas.length >= 2 && aiResult.routeToArea) {
         const target = AttendanceAreaService.match(orgId, aiResult.routeToArea);
         if (target && target.id !== ticket.area_id) {
           db.prepare('UPDATE tickets SET area_id = ?, assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
             .run(target.id, target.assigned_user_id || null, ticket.id);
           ticket.area_id = target.id;
           if (io) io.to(`org:${orgId}`).emit("ticket_updated", { ticketId: ticket.id, contactId: contact.id, areaId: target.id, assignedTo: target.assigned_user_id || null });
           aiResult = await AIOrchestratorService.processMessage({
              message: payload.text,
              organizationId: orgId,
              senderId: payload.senderId,
              contactName: contact.name,
              channelId: channel.id,
              ticketStage: ticket.stage,
              history,
              contactId: contact.id,
              provider: channel.provider,
              areaPersona: AttendanceAreaService.personaText(target),
              areaId: target.id,
           });
         } else if (!target) {
           // A IA pediu uma área que não existe: cai no menu para o cliente escolher.
           db.prepare('UPDATE tickets SET area_id = NULL, assigned_to = NULL WHERE id = ?').run(ticket.id);
           ticket.area_id = null;
           await sendBotReply(AttendanceAreaService.buildMenu(orgId, contact.name));
           return;
         }
       }

       if (aiResult.newStage && aiResult.newStage !== ticket.stage) {
          db.prepare('UPDATE tickets SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(aiResult.newStage, ticket.id);
          if (io) {
            io.to(`org:${orgId}`).emit("ticket_stage_change", { ticketId: ticket.id, contactId: contact.id, newStage: aiResult.newStage });
          }
          // Inicia cadência de follow-up se houver uma configurada para o novo estágio.
          try { CadenceService.startForTicket(orgId, ticket.id, contact.id, aiResult.newStage); } catch (e) { /* noop */ }
          // Reavalia o lead score: o novo estágio é um forte sinal de intenção.
          try { CustomerProfileService.recomputeScore(contact.id); } catch (e) { /* noop */ }
       }

       if (aiResult.needsHuman) {
          db.prepare('UPDATE tickets SET ai_paused = 1 WHERE id = ?').run(ticket.id);
          // TRANSIÇÃO INVISÍVEL: a IA gera um resumo do atendimento e já entrega
          // na tela do atendente (que recebe via área/assigned_to), para o cliente
          // não precisar repetir nada. Best-effort — nunca quebra o fluxo.
          let handoffSummary = '';
          try {
            handoffSummary = await HandoffSummaryService.fromHistory(history, payload.text);
            HandoffSummaryService.save(orgId, ticket.id, handoffSummary, aiResult.reply);
          } catch (e) { /* noop */ }
          if (io) {
            io.to(`org:${orgId}`).emit("ticket_ai_paused", { ticketId: ticket.id, contactId: contact.id, summary: handoffSummary });
          }
          // Notifica a equipe: cliente precisa de atendente humano.
          try { NotificationService.handoff(orgId, contact.name); } catch (e) { /* noop */ }
       }
       
       // E-mail capturado pela IA na conversa: salva no contato ANTES de criar
       // pedido/agendamento, para que as confirmações por e-mail o encontrem.
       if (aiResult.customerEmail) {
          try { db.prepare('UPDATE contacts SET email = ? WHERE id = ?').run(aiResult.customerEmail, contact.id); } catch (e) { /* noop */ }
       }

       if (aiResult.newAppointment) {
          const apptId = uuidv4();
          db.prepare(`
             INSERT INTO appointments (id, organization_id, ticket_id, contact_id, title, scheduled_start)
             VALUES (?, ?, ?, ?, ?, ?)
          `).run(apptId, orgId, ticket.id, contact.id, aiResult.newAppointment.title, aiResult.newAppointment.scheduled_start);
          // Sincroniza com o Google Calendar (best-effort).
          GoogleOAuthService.syncAppointment(orgId, apptId).catch(() => {});
          // Confirmação por e-mail ao cliente (best-effort; respeita o toggle do dono).
          GoogleAutomationService.confirmAppointment(orgId, apptId).catch(() => {});
       }
       
       if (aiResult.newDelivery) {
         db.prepare(`
             INSERT INTO deliveries (id, organization_id, ticket_id, contact_id, address)
             VALUES (?, ?, ?, ?, ?)
         `).run(uuidv4(), orgId, ticket.id, contact.id, aiResult.newDelivery.address);
       }

       // PEDIDO criado pela IA (canal de venda). O servidor valida o estoque de
       // novo (atômico) e reserva/baixa conforme o interruptor de autonomia.
       // Resposta final que será enviada (pode receber as instruções de pagamento).
       let finalReply = aiResult.reply;

       // INDICAÇÃO: cliente informou um código recebido → valida e cria o cupom
       // de boas-vindas (desconto na 1ª compra). Anexa a confirmação à resposta.
       if (aiResult.applyReferralCode) {
         try {
           const applied = ReferralService.applyCode(orgId, aiResult.applyReferralCode, contact.id);
           if (applied) {
             finalReply = `${finalReply}\n\n🎉 Código de indicação aplicado! Você ganhou *${applied.welcomePercent}% de desconto* na sua primeira compra. Já entra automaticamente quando você fechar o pedido.`;
           } else {
             finalReply = `${finalReply}\n\n(Não consegui aplicar esse código de indicação — ele pode ser inválido, já ter sido usado, ou ser para clientes novos.)`;
           }
         } catch (e) { /* noop */ }
       }

       // INDICAÇÃO: cliente quer indicar / pediu o próprio código → gera e envia.
       if (aiResult.referralCodeRequest) {
         try {
           const cfg = ReferralService.config(orgId);
           if (cfg.enabled) {
             const code = ReferralService.getOrCreateCode(orgId, contact.id);
             finalReply = `${finalReply}\n\n🤝 Seu código de indicação é *${code}*. Compartilhe com seus amigos: quando alguém comprar usando ele, seu amigo ganha *${cfg.welcomePercent}%* na 1ª compra e você ganha *${cfg.rewardPercent}%* de desconto na próxima! 🎁`;
           }
         } catch (e) { /* noop */ }
       }

       if (aiResult.newOrder && Array.isArray(aiResult.newOrder.items) && aiResult.newOrder.items.length) {
         try {
           // Trava anti-duplicidade: evita reservar o mesmo pedido várias vezes
           // quando o cliente responde "sim" repetidas vezes.
           if (OrdersService.hasRecentDuplicate(orgId, ticket.id, aiResult.newOrder.items)) {
             console.log(`[Vendas] Pedido duplicado ignorado para o ticket ${ticket.id}.`);
           } else {
             // INDICAÇÃO: aplica automaticamente um cupom ATIVO do cliente (desconto).
             const coupon = ReferralService.activeCoupon(orgId, contact.id);
             const order = OrdersService.createOrder(orgId, {
               contactId: contact.id,
               ticketId: ticket.id,
               items: aiResult.newOrder.items,
               createdBy: 'ai',
               autoClose: aiResult.newOrder.autoClose,
               discountPercent: coupon?.discount_percent || 0,
               couponId: coupon?.id || undefined,
             });
             if (coupon && (order.discount || 0) > 0) {
               ReferralService.redeem(orgId, coupon.id, order.id);
               finalReply = `${finalReply}\n\n🎁 Apliquei seu desconto de *${coupon.discount_percent}%* (indicação): você economizou R$ ${Number(order.discount).toFixed(2)}!`;
             }
             if (io) io.to(`org:${orgId}`).emit("order_created", { orderId: order.id, status: order.status, total: order.total, contactId: contact.id });
             try { NotificationService.orderCreated(orgId, contact.name, order.total); } catch (e) { /* noop */ }
             console.log(`[Vendas] Pedido criado pela IA: ${order.id} (status ${order.status}, total ${order.total})`);
             // FUNIL: pedido com pagamento pendente leva o ticket para 'aguardando_pagamento'
             // (e dispara a cadência de recuperação de pagamento, se configurada).
             // Se já nasceu pago (autoClose), vai direto para 'pos_venda'.
             try {
               const newOrderStage = order.status === 'pago' ? 'pos_venda' : 'aguardando_pagamento';
               if (ticket.stage !== newOrderStage) {
                 db.prepare('UPDATE tickets SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newOrderStage, ticket.id);
                 ticket.stage = newOrderStage;
                 if (io) io.to(`org:${orgId}`).emit("ticket_stage_change", { ticketId: ticket.id, contactId: contact.id, newStage: newOrderStage });
                 CadenceService.startForTicket(orgId, ticket.id, contact.id, newOrderStage);
                 CustomerProfileService.recomputeScore(contact.id);
               }
             } catch (e) { /* noop */ }
             // Cobrança: anexa as instruções de pagamento à resposta, se configurado.
             // Pix manual = chave estática; Mercado Pago = PIX dinâmico (copia e
             // cola + link) que confirma sozinho via webhook.
             try {
               const charge = await PaymentService.chargeForOrder(orgId, {
                 orderId: order.id, amount: order.total, contactName: contact.name, contactId: contact.id,
               });
               if (charge) finalReply = `${finalReply}\n\n${charge}`;
             } catch (e) { /* noop */ }
           }
         } catch (e) {
           console.error("[Vendas] Falha ao criar pedido da IA (provável estoque insuficiente):", e);
         }
       }

       // CANCELAMENTO confirmado pelo cliente: cancela o pedido ativo (devolve o estoque)
       // e também cancela os agendamentos/entregas abertos do ticket.
       if (aiResult.cancelOrder) {
         try {
           const cancelable = OrdersService.latestCancelableOrder(orgId, contact.id);
           if (cancelable) {
             OrdersService.updateStatus(orgId, cancelable.id, 'cancelado');
             if (io) io.to(`org:${orgId}`).emit("order_updated", { orderId: cancelable.id, status: 'cancelado', contactId: contact.id });
             console.log(`[Vendas] Pedido ${cancelable.id} cancelado a pedido do cliente (estoque devolvido).`);
           } else {
             console.log(`[Vendas] Cliente pediu cancelamento, mas não há pedido cancelável para o contato ${contact.id}.`);
           }
           // Cancela agendamentos abertos do contato (não os já concluídos/cancelados).
           // Antes guarda os IDs para remover os eventos do Google Calendar.
           const toCancel = db.prepare(
             "SELECT id FROM appointments WHERE organization_id = ? AND contact_id = ? AND status NOT IN ('cancelled','completed','no_show')"
           ).all(orgId, contact.id) as any[];
           const apptInfo = db.prepare(`
             UPDATE appointments SET status = 'cancelled'
             WHERE organization_id = ? AND contact_id = ? AND status NOT IN ('cancelled','completed','no_show')
           `).run(orgId, contact.id);
           for (const ap of toCancel) GoogleOAuthService.removeAppointmentEvent(orgId, ap.id).catch(() => {});
           // Cancela entregas pendentes do contato.
           db.prepare(`
             UPDATE deliveries SET status = 'cancelled'
             WHERE organization_id = ? AND contact_id = ? AND status NOT IN ('cancelled','delivered','completed')
           `).run(orgId, contact.id);
           if (apptInfo.changes > 0 && io) {
             io.to(`org:${orgId}`).emit("appointment_updated", { contactId: contact.id, status: 'cancelled' });
             console.log(`[Vendas] ${apptInfo.changes} agendamento(s) cancelado(s) junto com o pedido.`);
           }
         } catch (e) {
           console.error("[Vendas] Falha ao cancelar pedido/agendamento:", e);
         }
       }

       // RESERVA proposta pela IA: resolve o recurso, checa a disponibilidade e
       // cria a reserva. Se não houver vaga, troca a resposta por uma honesta.
       if (aiResult.newReservation) {
         try {
           const nr = aiResult.newReservation;
           const resource = ReservationService.matchResource(orgId, nr.resource);
           if (!resource) {
             console.log(`[Reservas] IA pediu recurso inexistente: "${nr.resource}".`);
           } else {
             const av = ReservationService.availability(orgId, resource.id, nr.start, nr.end, nr.units);
             if (!av.ok || !av.bookable) {
               finalReply = `Poxa, não temos *${resource.name}* disponível para esse período (${av.livres} de ${av.capacity} livre(s)). Quer tentar outras datas ou reduzir a quantidade? 🙏`;
             } else {
               const r = ReservationService.create(orgId, {
                 resourceId: resource.id, contactId: contact.id, ticketId: ticket.id,
                 startAt: nr.start, endAt: nr.end, units: nr.units, guests: nr.guests, createdBy: 'ai',
               });
               if (io) io.to(`org:${orgId}`).emit("reservation_created", { id: r.id, contactId: contact.id });
               console.log(`[Reservas] Reserva criada pela IA: ${r.id} (${resource.name}).`);
               // Sinal (se configurado): anexa as instruções de pagamento à resposta.
               try {
                 const resv = db.prepare("SELECT deposit_amount FROM reservations WHERE id = ?").get(r.id) as any;
                 const dep = Number(resv?.deposit_amount || 0);
                 if (dep > 0) {
                   const charge = await PaymentService.chargeForReservation(orgId, {
                     reservationId: r.id, amount: dep, contactName: contact.name, contactId: contact.id,
                   });
                   if (charge) finalReply = `${finalReply}\n\n${charge}`;
                 }
               } catch (e) { /* noop */ }
             }
           }
         } catch (e) {
           console.error("[Reservas] Falha ao criar reserva da IA:", e);
         }
       }

       // MENSALIDADE: o cliente pediu o PIX da assinatura em aberto — anexa a
       // cobrança da fatura pendente/vencida à resposta (best-effort).
       if (aiResult.sendSubscriptionPix) {
         try {
           const inv = SubscriptionService.openInvoiceForContact(orgId, contact.id);
           if (inv && Number(inv.amount) > 0) {
             const charge = await PaymentService.chargeForSubscription(orgId, {
               invoiceId: inv.id, amount: inv.amount, contactName: contact.name, contactId: contact.id,
             });
             if (charge) {
               finalReply = `${finalReply}\n\n${charge}`;
               SubscriptionService.setInvoiceCharged(orgId, inv.id, 'sent');
             }
           }
         } catch (e) { console.error("[Assinaturas] Falha ao reenviar PIX da mensalidade:", e); }
       }

       // RELATÓRIO EM PDF (Zapp gestor): gera o PDF (resumo + panorama). Tenta
       // enviar como DOCUMENTO nativo no WhatsApp; se não der, cai para o link em
       // texto (best-effort — nunca quebra a resposta).
       if (aiResult.exportPdf) {
         try {
           const pdf = await ReportPdfService.generateManagerReport(orgId, {
             title: aiResult.pdfTitle, summary: aiResult.reply, panorama: aiResult.pdfBody,
           });
           if (pdf?.url) {
             const fileName = `${(aiResult.pdfTitle || "Relatório").replace(/[^\w\sÀ-ÿ-]/g, "").trim().slice(0, 40) || "Relatório"}.pdf`;
             let nativeOk = false;
             try {
               await MessageProviderService.sendDocument(channel.id, payload.senderId, pdf.url, fileName, "📄 Seu relatório");
               nativeOk = true;
             } catch (e) { console.error("[Zapp] Envio nativo do PDF falhou, usando link:", e); }
             if (!nativeOk) finalReply = `${finalReply}\n\n📄 Seu relatório em PDF: ${pdf.url}`;
           }
         } catch (e) { console.error("[Zapp] Falha ao gerar o PDF:", e); }
       }

       // Save AI message
       const botMsgId = uuidv4();
       db.prepare(`
         INSERT INTO messages (id, organization_id, ticket_id, sender_type, content)
         VALUES (?, ?, ?, 'bot', ?)
       `).run(botMsgId, orgId, ticket.id, finalReply);

       // Emit AI response to frontend
       if (io) {
          const aiMsgPayload = {
             id: botMsgId,
             ticketId: ticket.id,
             contactId: contact.id,
             provider: channel.provider,
             text: finalReply,
             sender: "bot",
             timestamp: new Date().toISOString()
          };
          io.to(`org:${orgId}`).emit("new_message", aiMsgPayload);
       }

       // Send AI response back to provider
       await MessageProviderService.sendMessage(channel.id, payload.senderId, finalReply);

     } catch (e) {
       console.error("[IA RAG] Falha ao processar e responder:", e);
     }
  }
}
