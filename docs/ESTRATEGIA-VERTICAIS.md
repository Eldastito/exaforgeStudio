# Estratégia de Verticais & Modularização — ExaForge Studio

> Documento de produto/estratégia. Captura: nichos atendidos, mapa de modos de
> venda, pontos fracos atuais, viabilidade de modularizar por categoria e os
> recursos que abrem mais mercado. Base para decisão — não é spec de implementação.

## 1. Tese

Segmentar o público e oferecer "edições/módulos por categoria" (cada cliente paga
só pelo que usa) é **viável e de complexidade média-baixa**, porque a arquitetura
já é modular e multi-tenant:

- Multi-tenant por `organization_id`.
- `organization_settings` já tem **feature flags** (negotiator_enabled,
  appointment_reminders_enabled, pay_enabled, pix_reminder_enabled, sale_mode,
  google_* toggles…).
- `plans` já tem um **JSON `features`** com limites por plano (IA/mês, contatos,
  canais, usuários) lido por `PlanService.parseFeatures`.

**Não fazer:** apps/codebases separados por nicho — multiplica manutenção por N e
é o caminho errado. **Fazer:** UMA base, módulos ligados por flag + presets por
vertical (padrão SaaS "editions/verticals on one core").

## 2. Como modularizar (incremental, sem reescrita)

1. **Conceito de `vertical`** em `organization_settings` (ex.: `varejo`, `food`,
   `servicos`, `saude`, `educacao`, `hospitalidade`). Definido no onboarding.
2. **Registro de módulos + gating**: módulos = Atendimento, Catálogo/Vendas, Loja
   Virtual, Agenda, Pagamentos, Áreas, Campanhas, Cadências, Relatórios. Conjunto
   de módulos habilitados por org. Sidebar e rotas respeitam (frontend esconde,
   backend 403 no módulo desligado).
3. **Presets por vertical (templates)**: cada vertical pré-liga os módulos certos,
   define `sale_mode` padrão, persona/tom da IA, conhecimento (RAG) inicial e
   estágios do Kanban. É AQUI que se resolve a "dor específica" — em maior parte
   é **configuração + ajuste de prompt**, não engine nova.
4. **Preço por módulo/plano**: estender o `features` JSON dos planos para listar
   módulos habilitados. "Não pagar pelo que não usa" já fica ~80% pronto.

### Esforço por tipo de mudança
- Gating + presets de vertical: **médio-baixo** (a base já existe).
- Verticais que são só config/prompt: **baixo**.
- Verticais que precisam de 1 módulo novo (reserva por período, recorrência):
  **médio** (features pontuais, não reescrita).

## 3. Mapa: modo de venda x tipo de negócio

| Modo de venda | Abre |
|---|---|
| `unit` (Unidade) | varejo geral, roupas, eletrônicos, pet, papelaria |
| `slice` (Fatia) | bolos, tortas, pizzas, marmitas, doces/salgados |
| `size` (P/M/G) | roupas, calçados, bebidas |
| `weight` (kg) | açougue, hortifruti, granel, mercadinho |
| `volume` (L) | adega, distribuidora, chopp, água |
| tipo `service` + duração + Agenda/Calendar | salão, barbearia, estética, clínica, oficina, autônomos |

## 4. Nichos atendidos hoje (forte)

Comércio por unidade · Food/porcionado · Venda por peso · Bebidas/volume ·
Prestadores com hora marcada · Saúde/bem-estar · Serviços técnicos.

## 5. Novos nichos pedidos (escolas, cursos, hotéis, restaurantes/pensão)

| Nicho | Já cobre | Falta (gap) |
|---|---|---|
| **Escolas / Cursos** | Atendimento/secretaria virtual (RAG), agendamento de aulas, pagamento avulso | **Cobrança recorrente** (mensalidade), gestão de turmas/alunos, matrícula |
| **Hotéis / Pousadas / Pensão** | Atendimento/RAG, sinal via PIX | **Reserva por período** (check-in/out), disponibilidade de quartos |
| **Restaurantes** | Cardápio (catálogo), delivery (unit + endereço), pagamento | **Reserva de mesa** (parcial), adicionais/observações no item, comanda |

## 6. Os 2 recursos que abrem MAIS mercado

1. **Motor de reservas por período/disponibilidade** — abre hotéis, pousadas,
   pensões, restaurantes (mesa), aluguéis (temporada/equipamentos), quadras e
   salões de festa. O tipo `reservation` já existe no schema, falta o motor de
   disponibilidade por data/recurso.
2. **Cobrança recorrente / assinatura** — abre escolas, cursos, academias, clubes,
   planos de manutenção, "clube de assinatura". Pagamento hoje é avulso (PIX).

## 7. Pontos fracos atuais (ser honesto na venda)

- Sem **NF-e / emissão fiscal** (não substitui ERP).
- Sem **logística de frete** (Correios/transportadora); entrega é endereço manual/local.
- Sem **marketplace/multi-loja** por cliente (1 loja por empresa).
- **Reserva** existe como tipo, mas sem fluxo de período/disponibilidade.
- Foco **Brasil/PIX** (não é venda internacional).

## 8. Próximos passos sugeridos (ordem de maior alavancagem)

1. Onboarding com escolha de **vertical** + presets (libera segmentação já).
2. **Gating de módulos** por plano (libera o "pague só pelo que usa").
3. **Motor de reservas por período** (abre hospitalidade + restaurantes-mesa).
4. **Cobrança recorrente** (abre educação + assinaturas).
