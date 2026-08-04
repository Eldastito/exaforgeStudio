# PRD — Verticais, Planos, Assinaturas e Upgrade Inteligente do ZappFlow

**Governança comercial, catálogo de funcionalidades e automação da venda de assinaturas.**

- **Produto:** ZappFlow
- **Repositório:** `Eldastito/exaforgeStudio`
- **Prioridade:** Crítica — pré-requisito para venda de assinaturas em escala.
- **Responsável pela execução:** IA Dev.
- **Tipo:** PRD funcional, técnico e de política de negócio.
- **Status:** Pronto para análise crítica e planejamento técnico (Fase 0 iniciada — ver `docs/vertical-entitlements/STATUS-DE-EXECUCAO.md`).
- **ADR associado:** [ADR-153 — Vertical Entitlements + Assinaturas + Upgrade Inteligente](../adr/ADR-153-vertical-entitlements-assinaturas-upgrade.md).
- **Dependências principais:** ADR-091 (planos), ADR-092 (verticais), ADR-093 (Configurações), `ModuleService`, `PlanService`, `AsaasService`, `AddonService`, `PermissionService`, Vertical Quick-Start (`OnboardingTemplateService`), Execution Runtime (ADR-152).

## Resumo executivo

O ZappFlow já possui estrutura relevante de verticais, planos, módulos, RBAC, add-ons, billing, trial, consumo de IA, automações, Quick-Start, assinaturas via Asaas, recomendações do Diretor IA e execução de processos. Entretanto, o sistema ainda apresenta **10 riscos** que precisam ser corrigidos antes da comercialização massiva de assinaturas:

1. Administradores das empresas podem visualizar, na tela de módulos, funcionalidades que não fazem parte do seu produto contratado.
2. A vertical recomenda módulos, mas o plano pode bloquear o módulo principal da própria vertical.
3. Algumas funcionalidades podem ser habilitadas em `enabled_modules`, mas continuar bloqueadas pelo plano, criando uma interface enganosa.
4. O plano Autônomo possui o módulo Comigo/Copiloto, mas os planos superiores não o herdam, podendo fazer o cliente perder sua principal ferramenta ao realizar upgrade.
5. A troca de `plan_id` existe, mas não representa necessariamente um upgrade comercial completo, com cobrança, aceite, proporcionalidade e sincronização com a assinatura externa.
6. Não existe uma política consolidada para recomendações inteligentes de upgrade.
7. A IA ainda não possui regras claras para distinguir sugestão comercial legítima de pressão de venda indevida.
8. As verticais ainda são presets amplos, e não produtos por nicho versionados e replicáveis.
9. A ativação de módulos, menus, rotas e configurações depende de múltiplas camadas que precisam ser unificadas em uma única decisão de entitlement.
10. Não há garantia suficiente de que menu, Configurações, APIs e automações usem exatamente a mesma fonte de verdade.

Este projeto deverá criar uma arquitetura comercial segura, previsível e replicável.

## §2 — Instrução obrigatória para a IA Dev

Antes de iniciar qualquer alteração, a IA Dev deverá:

1. Ler este PRD integralmente.
2. Analisar o codebase atual.
3. Mapear os componentes existentes.
4. Verificar quais partes já estão implementadas.
5. Identificar divergências entre este documento e o código.
6. Registrar suas ponderações.
7. Propor uma arquitetura mínima.
8. Salvar o PRD e o plano de implementação no repositório.
9. Criar uma matriz de cobertura.
10. Somente depois iniciar o desenvolvimento.

A IA Dev não deverá recriar mecanismos já existentes. Deverá avaliar especialmente: `verticals.ts`, `ModuleService`, `PlanService`, `plansGrade.ts`, `AddonService`, `PermissionService`, RBAC, Sidebar e menus, Configurações › Módulos, onboarding, Quick-Start, Asaas, checkout, trial, consumo, add-ons, status de billing, webhooks, Execution Runtime, Diretor IA, Business Signals, Outcome Ledger.

## §3 — Diagnóstico atual

### §3.1 Verticais

As verticais atualmente funcionam como presets de módulos opcionais. Categorias: varejo, moda, alimentação, serviços, saúde, educação, hospitalidade, outro. Os módulos core são sempre disponibilizados: atendimento, contatos, relatórios, configurações. A vertical não é hoje o produto final — ela funciona como uma lista recomendada de módulos.

Disponibilidade efetiva:

```
Módulo efetivo
=
módulo recomendado pela vertical
∩ módulo permitido pelo plano
∩ módulo habilitado na organização
∩ permissão RBAC do usuário
∩ feature flag
```

A arquitetura atual explicitamente trata a vertical como uma recomendação e o plano como teto.

### §3.2 Planos

Grade atual: Autônomo, Start, Growth, Scale, Enterprise. Módulos em `features.modules`. Planos superiores herdam vários módulos dos inferiores, mas o módulo `copiloto` está somente no Autônomo. **Risco grave:** uma peixaria ou um chaveiro que usa o Comigo pode fazer upgrade e perder acesso ao seu Balcão. Isso é incompatível com uma política normal de upgrade — upgrade deve adicionar valor, nunca remover silenciosamente uma função operacional principal.

### §3.3 Configurações › Módulos

Visão atual classifica módulos como: recomendados, disponíveis, requer upgrade. O backend já impede que módulos acima do plano sejam realmente usados, mas o requisito comercial deste PRD será mais restritivo:

- O administrador da empresa não deverá visualizar funcionalidades fora da combinação contratada de vertical, plano e add-ons.
- A empresa não deve enxergar uma prateleira interna de todos os módulos existentes no ZappFlow.

Deverá enxergar apenas:
1. O que já possui.
2. O que pode ativar dentro do próprio plano.
3. O próximo upgrade comercial coerente, em uma área separada e controlada.

### §3.4 Upgrade

O `PlanService` já permite trocar o plano gravado na organização. A troca altera o teto de módulos imediatamente. Trocar `plan_id` NÃO é suficiente para uma venda real. O upgrade comercial precisa contemplar: proposta, consentimento, checkout, método de pagamento, cobrança proporcional, alteração no Asaas, atualização de período, confirmação por webhook, ativação dos novos entitlements, auditoria, comunicação, rollback em caso de falha.

## §4 — Objetivo principal

Criar um sistema unificado de **Vertical Entitlements, Assinaturas e Upgrade Inteligente**, capaz de:

1. Garantir que empresas vejam apenas o que contrataram.
2. Impedir habilitação manual de recursos fora do contrato.
3. Tornar plano, vertical, add-ons e módulos coerentes.
4. Permitir upgrades sem perda de funcionalidades.
5. Automatizar venda, pagamento e ativação.
6. Permitir que a IA recomende o plano certo no momento certo.
7. Exigir consentimento explícito para qualquer alteração contratual.
8. Transformar verticais personalizadas em modelos replicáveis.
9. Manter backend, menu, configurações e automações usando a mesma fonte de verdade.

## §5 — Princípios obrigatórios

- **§5.1** Nenhuma tela define permissão. O frontend apenas representa permissões. A autorização real deverá ser feita no backend.
- **§5.2** Uma única fonte de verdade. Todos os componentes deverão consultar o mesmo serviço de entitlement. Não deverá haver uma regra no menu, outra no backend e outra na tela de módulos.
- **§5.3** Upgrade nunca remove capacidade. Um upgrade não poderá retirar funcionalidades ativas, salvo quando houver incompatibilidade técnica + aviso + consentimento + plano de migração.
- **§5.4** IA recomenda, cliente decide. A IA poderá detectar necessidade, explicar motivo, simular benefício, apresentar plano, iniciar checkout após consentimento. NÃO poderá trocar plano sem confirmação, criar assinatura silenciosamente, cobrar cartão sem autorização, contratar add-on sem aceite, esconder aumento de preço.
- **§5.5** Vertical não é plano. Vertical define adequação operacional. Plano define capacidade comercial e limites. Blueprint define a configuração do nicho.

## §6 — Nova arquitetura

Criar o serviço central **`EntitlementService`**. Ele deverá responder:

```
A organização pode:
- ver este módulo?
- usar este módulo?
- habilitar este módulo?
- comprar este módulo?
- executar esta rota?
- executar esta automação?
- recomendar este upgrade?
```

### §6.1 Entrada

```json
{
  "organizationId": "org_123",
  "userId": "user_456",
  "resource": "clinica",
  "action": "view"
}
```

### §6.2 Saída

```json
{
  "allowed": false,
  "visibility": "hidden",
  "reason": "not_in_product",
  "source": {
    "verticalBlueprint": "chaveiro_autonomo_v1",
    "plan": "autonomo",
    "addon": null,
    "rbac": "full"
  },
  "upgradeEligible": false
}
```

## §7 — Modelo de entitlement

Resolução explícita:

```
entitlement efetivo
=
blueprint permitido
∩ plano permitido
+ add-ons contratados
+ concessões comerciais explícitas
∩ módulos habilitados
∩ RBAC
∩ flags operacionais
```

### §7.1 Estados de um recurso

Cada módulo deverá assumir um estado: `active`, `available_to_enable`, `available_to_buy`, `hidden`, `suspended`, `deprecated`, `pilot_only`.

### §7.2 Diferença entre oculto e upgrade

- **`hidden`** — o recurso não pertence àquele produto e não deve ser mostrado (Clínica para um chaveiro; Escola para uma peixaria; Retail Ops para uma clínica de uma única unidade).
- **`available_to_buy`** — é um upgrade ou add-on coerente (Cadências para plano Start; Retail Ops para uma empresa de moda com várias lojas; mais canais para empresa que atingiu o limite).

## §8 — Correção da grade de planos

### §8.1 Corrigir o Comigo

O módulo `copiloto` deverá ser preservado nos planos superiores quando a empresa vier do produto Autônomo. Duas opções:

- **Opção recomendada — Comigo como produto base persistente.** Todos os planos superiores passam a aceitar `copiloto`.
- **Alternativa — Add-on Comigo.** O módulo se torna um add-on contratado e preservado em qualquer plano.

A IA Dev deverá analisar impacto e escolher a solução com menor regressão.

### §8.2 Regras de herança

```
entitlements do destino
=
entitlements do novo plano
+ recursos adquiridos anteriormente
+ add-ons ativos
+ grandfathering explícito
```

### §8.3 Matriz obrigatória

Criar teste automatizado para `plano origem × plano destino × vertical × módulos ativos`. Nenhum upgrade poderá resultar em perda inesperada.

## §9 — Nova definição das verticais

As verticais atuais continuarão existindo como categorias amplas. O produto comercial será definido por **Vertical Blueprint**.

### §9.1 Exemplos

- `moda_loja_unica_v1`
- `moda_rede_lojas_v1`
- `clinica_multiespecialidades_v1`
- `chaveiro_autonomo_v1`
- `peixaria_balcao_peso_v1`

### §9.2 Estrutura

```json
{
  "key": "peixaria_balcao_peso",
  "version": 1,
  "baseVertical": "varejo",
  "allowedPlans": ["autonomo", "start", "growth"],
  "defaultPlan": "autonomo",
  "minimumPlan": "autonomo",
  "requiredModules": ["catalogo", "vendas", "pagamentos", "copiloto"],
  "optionalModules": ["agenda", "loja", "campanhas"],
  "commercialUpgrades": ["start", "growth"],
  "hiddenModules": ["clinica", "escola", "vms", "retail"],
  "quickStartPack": "peixaria_v1",
  "runtimePlaybooks": ["receivable_collection_v2"]
}
```

## §10 — Blueprints iniciais

### §10.1 Moda — loja única

- **Essenciais:** catálogo, vendas, loja, pagamentos, campanhas, estúdio, integrações, Diretor, RIE.
- **Opcionais:** cadências, compras, execução, atendimento de loja.
- **Ocultos por padrão:** clínica, escola, VMS, Prospect, Retail Ops de rede.

### §10.2 Moda — rede de lojas / TOULON

- **Essenciais:** catálogo, vendas, pagamentos, integrações, Retail Ops, Atendimento de Loja, RIE, execução, Diretor, fechamento, conciliação, comissão, Alterdata, Runtime.
- **Opcionais:** VMS, Prospect, Estúdio, compras, campanhas.

### §10.3 Clínica multiespecialidades

- **Essenciais:** agenda, clínica, pagamentos, assinaturas, cadências, áreas, integrações, Diretor, RIE, Runtime.
- **Opcionais:** campanhas, execução, VMS, Prospect.
- **Ocultos:** loja, retail, retail_floor, escola.

**Correção comercial necessária:** o módulo Clínica não deve depender exclusivamente do Enterprise se a vertical comercial se chama Clínica. Deverá existir uma das opções: Plano Clínica; Add-on Clínica; Bundle vertical Clínica; plano mínimo específico. Recomendado: Blueprint Clínica + plano Growth ou Scale + add-on Clínica incluído no bundle.

### §10.4 Chaveiro autônomo

- **Essenciais:** Comigo, catálogo de serviços, vendas, pagamentos, agenda, integrações.
- **Opcionais:** campanhas, cadências, assinaturas, Diretor.
- **Ocultos:** Clínica, Escola, Retail Ops, VMS, Estúdio (salvo contratação explícita).

### §10.5 Peixaria

- **Essenciais:** Comigo, catálogo, venda por peso, vendas, pagamentos, estoque básico, loja quando aplicável.
- **Opcionais:** campanhas, cadências, compras, Diretor, RIE.
- **Ocultos:** clínica, escola, Retail Ops de rede, VMS, Prospect.

## §11 — Regra de visibilidade na interface

### §11.1 Menu principal

Listar apenas recursos com:
```
visibility = visible
AND entitlement = active
AND RBAC != none
```
Não mostrar: módulo bloqueado, módulo de outra vertical, recurso interno, módulo experimental, upgrade irrelevante.

### §11.2 Configurações › Módulos

Substituir a tela atual por três áreas:
- **Seus recursos** — somente módulos ativos.
- **Recursos disponíveis no seu plano** — módulos que a empresa pode habilitar sem pagar.
- **Expansões recomendadas** — somente upgrades relevantes e aprovados pelo Blueprint.

Não mostrar um catálogo global do ZappFlow.

### §11.3 Tela comercial separada

Criar `Configurações › Plano e Expansões`. Mostrará: plano atual, uso, limites, próximos níveis, add-ons compatíveis, recomendação da IA, preço, impacto, checkout.

## §12 — Política de upgrade inteligente

Criar o **Upgrade Recommendation Engine**. Motor deverá usar dados reais para recomendar upgrade.

### §12.1 Sinais permitidos

Uso de IA, número de usuários/canais/contatos/unidades, volume de vendas/oportunidades, necessidade de cadências/assinaturas/Retail Ops, quantidade de tarefas manuais, horas economizáveis, oportunidades perdidas, processos bloqueados pelo plano, uso recorrente de funcionalidades relacionadas.

### §12.2 Sinais proibidos isoladamente

Não recomendar upgrade apenas porque: o usuário entrou muitas vezes na tela, o plano mais caro existe, faltou receita para o ZappFlow, uma mensagem genérica pode pressionar o cliente.

## §13 — Condições para recomendar upgrade

A IA somente deverá recomendar quando houver:
1. Evidência de necessidade.
2. Benefício concreto.
3. Produto compatível com a vertical.
4. Ganho superior ao custo estimado.
5. Confiança mínima.
6. Frequência controlada.
7. Ausência de recomendação recente rejeitada.

### §13.1 Exemplos

- **Limite de uso:** "Você utilizou 92% das interações de IA do mês e o volume cresceu 28% nos últimos 60 dias. O plano Growth oferece capacidade suficiente para manter esse ritmo."
- **Ganho operacional:** "Sua equipe executou manualmente 340 follow-ups em 30 dias. O plano Growth libera cadências automáticas e pode absorver parte desse trabalho."
- **Expansão de lojas:** "A empresa passou de uma para quatro unidades. O Retail Ops pode consolidar fechamento, comissão e divergências entre lojas."
- **Clínica:** "A clínica já possui quatro profissionais e 380 agendamentos mensais. O bundle Clínica permitirá acompanhamento de jornada, autorizações e recorrência."

## §14 — Score de recomendação

Criar um score entre 0 e 100:

```
necessidade operacional: 30
uso próximo ao limite: 20
ganho financeiro provável: 20
recorrência da necessidade: 15
adequação à vertical: 10
confiança dos dados: 5
```

Regras: abaixo de 60 não recomendar; 60–74 sugestão discreta no painel; 75–89 recomendação contextual; 90+ recomendação ativa, sem cobrança automática.

## §15 — Controle de frequência

Não exibir recomendação: mais de uma vez por 30 dias para o mesmo plano; após rejeição recente; durante inadimplência; durante incidente; durante cancelamento; se o cliente estiver usando menos de 30% do plano atual.

## §16 — Explicabilidade

Toda recomendação deverá explicar: por que foi feita, quais dados foram usados, qual funcionalidade será liberada, qual problema será resolvido, preço, impacto estimado, limitações da estimativa.

Exemplo:
```
Recomendamos Growth porque:
- 94% do limite de IA foi utilizado;
- 213 oportunidades aguardaram follow-up;
- sua equipe possui 4 usuários;
- o Growth libera cadências, assinaturas e até 5 usuários.
```

## §17 — Automação da venda de assinaturas

Fluxo completo:

```
Escolha do plano
→ resumo
→ aceite
→ checkout
→ cobrança Asaas
→ confirmação
→ ativação
→ onboarding
→ emissão de comprovante
```

### §17.1 Checkout

Coletar: plano, ciclo mensal ou anual, empresa, CPF/CNPJ, responsável, e-mail, telefone, método de pagamento, aceite de termos, autorização de cobrança.

### §17.2 Métodos

PIX, cartão, boleto quando permitido.

### §17.3 Assinatura

Criar ou atualizar a assinatura no Asaas. Persistir: provider, customer ID, subscription ID, payment ID, plan ID, billing cycle, preço, início, fim, status, termos aceitos, versão do contrato.

## §18 — Fluxo de upgrade

### §18.1 Usuário inicia

```
Recomendação ou tela de planos
→ selecionar novo plano
→ visualizar comparação
→ visualizar valor proporcional
→ aceitar
→ pagar ou autorizar
→ webhook
→ aplicar entitlement
```

### §18.2 IA inicia

A IA poderá dizer: "Identifiquei que o plano Growth é mais adequado. Deseja ver os detalhes?" Somente após o usuário dizer sim: apresentar comparação, apresentar preço, abrir checkout. A IA **não deverá** interpretar um "pode ser" genérico como autorização de cobrança.

## §19 — Proporcionalidade

**Upgrade imediato:** ativa imediatamente; cobra diferença proporcional do período; mantém data de renovação.

**Downgrade:** entra em vigor no próximo ciclo; avisa recursos que serão perdidos; impede downgrade se houver dependência ativa não resolvida; exige confirmação.

## §20 — Upgrade por add-on

Permitir compra de: usuários extras, canais extras, pacotes de IA, Retail Ops, Clínica, VMS, Prospect, unidades adicionais. Cada add-on deverá possuir: preço, ciclo, módulos, limites, dependências, compatibilidade de blueprint, regras de cancelamento.

## §21 — Aplicação dos entitlements

Recursos ativados somente após:
```
webhook confirmado
AND assinatura válida
AND entitlement calculado
AND módulos aplicados
```

Nunca ativar baseado apenas no clique do checkout.

## §22 — Falha no pagamento

Se o upgrade falhar: manter plano anterior; não liberar recursos; registrar tentativa; informar usuário; permitir nova tentativa. **Nunca deixar a organização num estado parcial.**

## §23 — Cancelamento e downgrade

Criar políticas para: solicitação, retenção, data efetiva, exportação, recursos perdidos, dados preservados, reativação, período de carência.

Módulos removidos não deverão apagar dados. Devem ficar `read_only` ou ocultos com dados preservados.

## §24 — Vertical Blueprint Service

Criar `VerticalBlueprintService`. Métodos mínimos: `createBlueprint`, `publishVersion`, `getBlueprint`, `listBlueprints`, `assignToOrganization`, `cloneToOrganization`, `previewEntitlements`, `upgradeBlueprintVersion`, `compareVersions`, `rollbackVersion`.

### §24.1 Versão publicada é imutável

Um blueprint publicado não deve ser alterado. Criar nova versão.

### §24.2 Empresa recebe instância

A empresa recebe: blueprint, versão, overrides, plano, add-ons.

### §24.3 Overrides

Personalizações ficam separadas: marca, horário, catálogo, mensagens, equipe, política, integrações.

## §25 — Banco de dados conceitual

### `vertical_blueprints`

```
id, key, name, base_vertical, version, status,
minimum_plan_id, default_plan_id, config_json,
created_at, published_at
```

### `organization_blueprints`

```
organization_id, blueprint_id, blueprint_version,
assigned_at, overrides_json, status
```

### `plan_entitlements`

```
plan_id, resource_key, entitlement_type, limit_value
```

### `organization_entitlements`

```
organization_id, resource_key, source_type, source_id,
status, starts_at, ends_at
```

### `upgrade_recommendations`

```
organization_id, current_plan_id, recommended_plan_id,
score, reasons_json, evidence_json,
status, created_at, dismissed_at, accepted_at
```

### `subscription_change_requests`

```
organization_id, from_plan_id, to_plan_id, change_type,
price_before, price_after, proration_amount, status,
consent_at, provider_reference, effective_at
```

## §26 — APIs necessárias

### Entitlements
```
GET /api/entitlements/me
GET /api/entitlements/modules
GET /api/entitlements/resource/:key
```

### Blueprints
```
GET /api/admin/blueprints
POST /api/admin/blueprints
POST /api/admin/blueprints/:id/publish
POST /api/admin/organizations/:id/blueprint
```

### Planos
```
GET /api/billing/plans
GET /api/billing/current
POST /api/billing/checkout
POST /api/billing/upgrade/preview
POST /api/billing/upgrade/confirm
POST /api/billing/downgrade
```

### Recomendação
```
GET /api/billing/recommendation
POST /api/billing/recommendation/dismiss
POST /api/billing/recommendation/accept
```

## §27 — Segurança

Requisitos obrigatórios: isolamento multi-tenant, RBAC, webhook autenticado, idempotência, consentimento, auditoria, proteção contra replay, proteção contra cobrança duplicada, valores calculados no backend, nenhuma confiança em preços do frontend, logs sem dados sensíveis, LGPD, contrato versionado, trilha de aceite.

## §28 — Critérios de aceite — visibilidade

1. Chaveiro não vê Clínica.
2. Peixaria não vê Escola.
3. Clínica não vê Retail Ops sem entitlement.
4. Administrador não consegue ativar módulo fora do plano.
5. Alterar payload no frontend não fura o backend.
6. Menu e API dão a mesma resposta.
7. Configurações mostra apenas módulos relevantes.
8. Upgrade aparece apenas em Plano e Expansões.
9. Usuário sem RBAC não vê módulo ativo da empresa.
10. Add-on cancelado é removido do entitlement.

## §29 — Critérios de aceite — upgrade

1. Upgrade não remove Comigo.
2. Preview mostra preço e proporcionalidade.
3. Consentimento é obrigatório.
4. Cobrança confirmada ativa recursos.
5. Cobrança falha mantém plano anterior.
6. Webhook duplicado não duplica upgrade.
7. Upgrade é auditado.
8. Downgrade só entra no próximo ciclo.
9. Dados de módulos removidos são preservados.
10. Add-ons continuam ativos se compatíveis.

## §30 — Critérios de aceite — recomendação IA

1. Recomendação usa dados reais.
2. Score fica registrado.
3. Razões são explicáveis.
4. Recomendação respeita a vertical.
5. IA não recomenda módulo oculto.
6. IA não altera plano sozinha.
7. Rejeição pausa novas ofertas.
8. Benefício estimado é rotulado como estimativa.
9. Preço exibido vem do backend.
10. Aceite explícito é obrigatório.

## §31 — Testes obrigatórios

**Matriz principal:** Vertical Blueprint × Plano × Add-on × Módulo × RBAC × Menu × Configurações × API.

**Casos mínimos:** peixaria Autônomo, peixaria Growth, chaveiro Autônomo, chaveiro Start, clínica bundle, clínica sem add-on, moda loja única, TOULON rede, downgrade, upgrade, cobrança falha, webhook duplicado, add-on, usuário sem permissão, administrador tentando alterar payload.

## §32 — Roadmap

- **Fase 0 — Auditoria:** mapear todos os gates, telas, APIs, Asaas, planos; responder inconsistências. *(Esta fase — em execução.)*
- **Fase 1 — EntitlementService:** fonte única; migração do ModuleService; APIs; testes.
- **Fase 2 — Correção da grade:** preservar Comigo; definir bundles; corrigir Clínica; matriz de upgrades.
- **Fase 3 — Blueprints:** modelo; versionamento; primeiros nichos; clonagem.
- **Fase 4 — Interface:** menu; módulos; plano e expansões; comparação.
- **Fase 5 — Checkout e assinatura:** criação; Asaas; webhooks; ativação.
- **Fase 6 — Upgrade:** preview; proporcionalidade; consentimento; ativação; downgrade.
- **Fase 7 — Recomendação IA:** sinais; score; explicação; controle de frequência; CTA.
- **Fase 8 — Rollout:** shadow; contas de referência; TOULON; clínica piloto; vendas abertas.

## §33 — Bloqueadores para começar a vender

O sistema não deverá abrir vendas em escala antes de:

1. Corrigir a perda do Comigo no upgrade.
2. Implementar entitlement unificado.
3. Impedir exposição de módulos indevidos.
4. Definir produto Clínica.
5. Validar upgrade financeiro Asaas.
6. Implementar checkout.
7. Implementar aceite.
8. Testar webhook e idempotência.
9. Definir downgrade.
10. Criar ao menos quatro blueprints.
11. Executar testes de autorização.
12. Validar contratos e LGPD.

## §34 — O que pode ser vendido antes

Vendas controladas com ativação manual pelo Master Admin para TOULON, peixaria, chaveiro, clínica piloto — desde que: plano seja atribuído manualmente; módulos sejam revisados; não haja auto-upgrade; cobrança seja acompanhada; não seja prometido self-service completo.

## §35 — Política comercial recomendada

- **Autônomo** — uma pessoa, operação simples, Comigo.
- **Start** — pequenas equipes que precisam de campanhas, áreas e Diretor.
- **Growth** — empresas que precisam de automação, cadências, recorrência e mais canais.
- **Scale** — operações com processos, compras, múltiplas unidades, Retail e gestão avançada.
- **Enterprise** — soluções complexas, integrações, VMS, Prospect e necessidades negociadas.

**Bundles verticais:** Clínica, Moda Rede, Escola, Retail Ops. O bundle poderá combinar `plano base + add-ons + blueprint`.

## §36 — Resultado esperado

Ao final, o ZappFlow deverá ser capaz de dizer:

> "Esta empresa pertence ao nicho X, contratou o produto Y, possui o plano Z e estes add-ons. Estes são os únicos recursos que ela pode ver, usar ou comprar."

E:

> "Com base nos dados da operação, o próximo plano recomendado é Growth, porque o limite atual está em 93%, há quatro usuários ativos e 213 oportunidades aguardando follow-up. O upgrade custa R$ X e libera Y. Deseja visualizar o checkout?"

A alteração somente acontecerá após consentimento e confirmação do pagamento.

## §37 — Mensagem final para a IA Dev

Este projeto não é uma simples revisão da tela de módulos. Ele deverá transformar a arquitetura comercial do ZappFlow em uma estrutura: segura, coerente, vendável, escalável, explicável, replicável, auditável.

A prioridade é impedir que: empresas vejam recursos indevidos; administradores liberem módulos fora do contrato; upgrades removam capacidades; a IA faça pressão comercial sem evidência; pagamentos gerem estados inconsistentes; frontend e backend discordem.

**Antes de programar, analise. Antes de liberar vendas, teste toda a matriz.** O trabalho somente estará concluído quando vertical, blueprint, plano, add-on, módulo, RBAC, menu, API, cobrança e recomendação utilizarem a mesma decisão de entitlement.

**A decisão mais urgente é corrigir a grade de planos:** upgrade não pode retirar o Comigo, e a vertical Clínica não pode vender uma promessa cujo módulo central só aparece em um plano incompatível com o público-alvo.
