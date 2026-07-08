# ADR-077 — Prospect AI como módulo experimental (opt-in explícito)

**Status:** Implementado.

**Origem:** Fase 5 do plano de produção — decisão sobre o Prospect AI. O levantamento apontou que o módulo é claramente incompleto: os próprios comentários do código descrevem `ProspectService` como "Fase 0: fundação — Descoberta, enriquecimento, evidências, score e outreach entram nas próximas fases. Determinístico/read-write; nada de IA ainda nesta camada." Isto é: hoje o "Prospect AI" é um CRUD de ICP + rascunho de campanha, **sem inteligência de fato**. Ativado no menu de todas as verticais e planos, ele quebra a expectativa comercial que o nome cria.

---

## Contexto

O ZappFlow tem três módulos em estado "experimental" (código real, funcional em partes, mas ainda não pronto para ser vendido como produto):

- **`vms`** — Vision VMS depende de hardware de câmera no cliente. Sem piloto, ativar quebra UX.
- **`radar`** — Radar de Execução IA está atrás do feature flag `ai_execution_radar_enabled` desligado por padrão.
- **`prospect`** (foco deste ADR) — Fase 0 (~2.280 linhas de código: `ProspectService` + `ProspectDiscoveryService` + `ProspectView` + rotas). Faltam: motor de descoberta com um provedor decidido, enriquecimento com IA (com controle de custo), scoring calibrado, integração com outreach. Sem cliente pagando esperando ou hipótese de negócio específica, fechar as fases 1+ hoje = construir "spec sheet feature".

A decisão anterior desses três módulos foi consistente: **não desligar o código, desligar o default de novas orgs**. Padrão que este ADR aplica também ao Prospect.

## Decisão

**O `prospect` deixa de ser default em novas organizações.** Mudanças mínimas, todas defensivas:

1. **`src/server/verticals.ts`** — removido `prospect` da lista `modules` de cada uma das 6 verticais preset (varejo, food, servicos, saude, educacao, hospitalidade) E adicionado ao filtro do `OUTRO_MODULES` (mesma técnica de `vms` e `radar`). Novas orgs que escolhem qualquer vertical não ganham o Prospect no menu.
2. **`src/server/db.ts`** — removido `prospect` dos planos seed (Pro e Business). Novos deploys com banco vazio não semearão o módulo nos planos padrão.
3. **`OPTIONAL_MODULES` intacto** — o módulo permanece como opção conhecida do sistema. Uma organização com `enabled_modules` contendo `"prospect"` (orgs existentes, ativação explícita futura via Configurações › Módulos) continua vendo tudo normalmente.

**O que NÃO muda:**

- Código do `ProspectService` / `ProspectDiscoveryService` / rotas / `ProspectView` — **preservado**. Nada é removido.
- Tabelas do banco (`prospect_icp_profiles`, `prospect_campaigns`, `prospect_accounts`, etc.) — **preservadas**. Migração é aditiva, dados existentes intactos.
- Orgs que já ativaram o módulo (têm `"prospect"` em `enabled_modules`) — **continuam vendo o módulo**. Sem regressão de experiência.

## Consequências

**Positivas:**
- Novo cliente entra no onboarding e **não vê "Prospect AI" no menu** → nenhuma expectativa quebrada. A promessa do produto (atendimento, vendas, campanhas, reservas, agenda) é o que ele contratou.
- Base de código, banco e componentes **preservados** para quando o gatilho de fase 1+ chegar (cliente pagando, hipótese específica, competição). Retomada custa 0 em migração.
- Padrão consistente com `vms` e `radar` — três módulos experimentais gerenciados do mesmo jeito.
- Onboarding vira mais limpo: 12-14 módulos por vertical em vez de 13-15 (o número exato depende da vertical).

**Trade-offs aceitos:**
- **Descoberta perdida no menu**: se um usuário existente sabia da existência do Prospect por outro canal (docs, redes), ele não vai achar sem alguém orientar. Aceitável enquanto o módulo estiver em Fase 0.
- **Regressão possível em orgs sem `enabled_modules` populado** (legado nulo). O `ModuleService.backfillNullModules()` já rodou no boot e populou todas as orgs com o preset da vertical delas — se o backfill for feito NOVAMENTE agora, orgs que estavam com `enabled_modules=NULL` perderiam o Prospect. Como o backfill só roda quando o campo é `NULL`, e isso já é raro após a Fase 3, o risco é baixo. Mitigação: quem quiser reativar, ativa em Configurações › Módulos (mesmo fluxo do `vms`/`radar`).
- **Sem toggle de UI para "reativar em massa em orgs experimentais"** — se decidirmos GA do Prospect no futuro, será preciso um script one-shot que adicione `"prospect"` aos `enabled_modules` de cada org. Aceitável: quando essa hora chegar, também vamos querer decidir org a org.

## Fase 5 — o que este ADR fecha

Este é o **fechamento da Fase 5** do plano de produção. As opções em jogo eram:
- **(A) Flip de default para experimental** ← esta decisão.
- (B) Remover completamente o módulo do código.
- (C) Fechar as fases 1+ agora (descoberta, enriquecimento, scoring, outreach).

Optamos por (A) porque **hoje não há gatilho de negócio para (C) e (B) descartaria WIP recuperável**. Quando o gatilho existir — primeiro cliente pagando por prospecção, hipótese específica testável, movimento competitivo — o custo de retomar é linha reta: implementar a descoberta contra um provedor, plugar o enriquecimento com controle de custo, calibrar o score com dados reais.

## Testes

- **Não há teste novo** — a mudança é config (JSON em código). Cobertura indireta: `test-rbac-audit` e o boot do backend exercitam `ModuleService.isEnabled('prospect')` e não devem regredir.
- Regressão manual esperada em produção após deploy: novo signup → menu não mostra "Prospect AI". Org existente com prospect em `enabled_modules` → continua vendo.

Fase 5 fechada.
