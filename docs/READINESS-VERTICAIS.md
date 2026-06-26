# Readiness do ZappFlow por Vertical

> Avaliação honesta de quão pronto o ZappFlow está para atender cada público,
> com base no que existe no código. Legenda: 🟢 pronto · 🟡 parcial · 🔴 lacuna.

## Resumo executivo

| Vertical | Piloto hoje | Escala (rede/integração) |
|---|---|---|
| **Hotelaria** (hotel-fazenda, resort, pousada) | 🟢 ~80% | 🟡 falta PMS + eventos/grupos |
| **Serviços / Saúde-bem-estar** (clínica, estética) | 🟢 | 🟡 falta prontuário-lite/filas |
| **Varejo / Food** | 🟢 | 🟡 |
| **Mercado / Minimercado** | 🟡 | 🔴 falta ERP/PDV + entrega por região |
| **Hospital** (alta complexidade) | 🔴 | 🔴 integração + LGPD clínica |

O motor é forte e **transversal**: omnicanal (WhatsApp/Instagram), RAG, CRM/funil,
reservas, agenda, pagamentos, cadências, recuperação de receita, NPS, indicação,
áreas/roteamento e handoff. As lacunas são quase sempre **integração** (PMS/ERP) e
**módulos verticais específicos** — não o núcleo.

---

## Base transversal (vale para todas as verticais)

| Capacidade | Status |
|---|---|
| Omnicanal WhatsApp (Cloud + Evolution) e Instagram | 🟢 |
| Telefone (voz) | 🔴 planejado (`docs/PLANO-MODULO-VOZ-0800.md`) |
| Site / OTAs | 🟡 vitrine própria; 🔴 OTAs |
| RAG / base de conhecimento (responde só o documentado) | 🟢 |
| CRM + funil de 12 estágios + lead score/temperatura | 🟢 |
| Reservas por período (capacidade/disponibilidade reais + sinal) | 🟢 |
| Agenda / agendamentos + lembretes | 🟢 |
| Pagamentos (PIX manual + Mercado Pago) | 🟢 |
| Cadências, carrinho abandonado, lembrete progressivo de PIX, reativação | 🟢 |
| NPS/CSAT + programa de indicação (cupom) | 🟢 |
| Áreas/roteamento + handoff invisível com resumo | 🟢 |
| Trava anti-alucinação (não inventa preço/prazo/promoção; confirma/transfere) | 🟢 |
| Integração com sistemas externos (PMS/ERP/PDV) | 🔴 |

---

## Hotelaria — 🟢 pronta para o piloto (≈80%)

| Módulo "Hospitality" | Status | Observação |
|---|---|---|
| Reservas Diretas | 🟡→🟢 | Reservas já capturam datas/unidades/hóspedes + disponibilidade + sinal. **Em andamento:** captura estruturada de adultos/crianças/pet/pedidos especiais/orçamento. |
| Eventos e Grupos | 🔴 | Falta pipeline consultivo dedicado (convidados, salas, orçamento por etapa). |
| Concierge Pré-Estadia | 🟢 | É o RAG: check-in, alimentação, transfer, pet, estacionamento, horários. |
| Recuperação de Receita | 🟢 | Cadências, orçamento/carrinho abandonado, PIX progressivo, reativação, NPS. |

**5 métricas do piloto:** 1ª resposta 🟢 · % qualificados 🟡 · orçamentos acompanhados
🟡 · abandonadas recuperadas 🟡 · viraram reserva/evento 🟡 → falta um **painel
comercial de hotelaria** e **orçamento como objeto rastreável**.

**Gaps para escalar (redes):** 1) integração PMS/motor de reservas; 2) pipeline de
eventos/grupos; 3) painel de métricas + orçamento rastreável; 4) telefone/OTAs.

## Mercado / Minimercado — 🟡 motor pronto, falta integração

| Necessidade | Status |
|---|---|
| Catálogo, pedido por WhatsApp, retirada/entrega, ofertas, reativação, SAC, roteamento | 🟢 |
| Integração ERP/PDV/estoque (preço/estoque confiáveis) | 🔴 |
| Catálogo/preço por loja + região/raio de entrega | 🔴 |
| Ruptura de estoque / atualização de promoções em tempo real | 🟡 |

➡️ Não vender para mercados grandes; começar por redes locais (2–10 lojas) **após**
um conector de estoque. Sem isso, a IA erra preço/estoque = problema operacional.

## Saúde / Bem-estar — 🟢 (clínicas/estética) · 🔴 (hospital)

Clínicas/consultórios/estética: agendamento + lembretes + áreas + assinaturas já
cobrem bem. **Hospital de verdade** exige triagem clínica, filas, integração com
prontuário/HIS, e tratamento de dados sensíveis (LGPD saúde) — vertical de longo
prazo, não imediata.

---

## Onde focar (recomendação)

1. **Hotelaria** primeiro (GTM viva): fechar os 4 gaps na ordem reserva estruturada →
   métricas/orçamento → eventos/grupos → integração PMS.
2. **Conector de integração genérico** (HTTP/webhook + planilha) reutilizável —
   destrava hotel (PMS) e mercado (ERP/PDV) com a mesma base.
3. **Mercado** depois do conector.
4. **Hospital** e **telefone/OTAs** no horizonte mais longo.

Detalhes de arquitetura e sequência em `docs/ARQUITETURA-MODULOS-VERTICAIS.md`.
