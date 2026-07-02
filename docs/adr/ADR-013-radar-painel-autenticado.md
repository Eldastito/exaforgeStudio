# ADR-013 — Radar: painel autenticado (Fase 1 finalmente com frontend)

**Status:** Implementado e testado ponta a ponta em navegador real.
**Origem:** lacuna encontrada ao levantar o próximo passo do roadmap após a correção do contraste do onboarding público (ADR-012): o backend autenticado do Radar (`RadarService.ts`, `routes/radar.ts`, Fase 1/ADR-009) e o Índice de Velocidade de Conversão (`ConversionVelocityService.ts`, ADR-010) estavam completos e testados desde antes — mas **inalcançáveis pela UI**. Nenhuma organização cliente conseguia criar um diagnóstico, responder perguntas ou ver o próprio IVC de dentro do produto; só o visitante anônimo da landing pública (Fase 2) tinha uma tela.

## O que faltava (achado por levantamento, não assumido)

Levantamento no código antes de decidir o que construir confirmou três lacunas, não duas:

1. **Nenhum componente React autenticado** falava com `/api/radar/*`. `src/main.tsx` só roteava a Wizard pública (`/radar-ia`); a Sidebar não tinha item de navegação para o Radar.
2. **`SettingsView.tsx` não listava `radar`** no array `OPTIONAL_MODULES` do painel de Módulos — mesmo o backend já tratando `radar` como módulo opcional de pleno direito (`verticals.ts`, `ModuleService.ts` desde a ADR-009). Sem essa linha, nem um admin com acesso direto ao banco tinha como ativar o módulo pela UI.
3. **Nenhum caso especial era necessário para leads capturados** pelo fluxo público (ADR-012): como `ProspectService.importRecords` já grava em `prospect_accounts` sem filtro de `provider`, um lead `radar_ia` já aparece normalmente em `ProspectView.tsx` — confirmado por leitura direta da query (`ProspectService.ts`), não presumido.

Este ADR resolve (1) e (2). (3) não precisou de código.

## Decisões de implementação

### Um único arquivo novo: `src/features/RadarView.tsx`

Segue o padrão de todo o resto do app: nenhum router — `viewMode` no Zustand (`useStore.ts`), dispatch condicional em `App.tsx`, item de menu condicional (`mod('radar') && <NavItem .../>`) na `Sidebar.tsx`, mesmo padrão do `vms` mais recente. `ViewMode` ganhou o literal `'radar'`; o mapa de gate-por-módulo em `App.tsx` (que redireciona pro Kanban se o módulo cair) ganhou `radar: 'radar'`.

Dentro do arquivo, quatro sub-telas com estado local (`list` → `new` → `questions` → `result`), deliberadamente reaproveitando a MESMA estrutura visual e a mesma lógica de navegação por pergunta (barra de progresso, opções de escala, "não sei", comentário opcional) já validada em produção pela Wizard pública (`src/radar-public/RadarPublicWizard.tsx`) — inclusive o mesmo reforço de contraste (`color-scheme: dark` + `background-color` explícito nos `<option>`) que motivou a correção mais recente (PR #252), aplicado aqui preventivamente nos selects de Segmento/Porte do formulário de novo diagnóstico, em vez de esperar o mesmo bug aparecer de novo num select novo.

Diferenças deliberadas em relação à Wizard pública (não é código duplicado por descuido — são fluxos com regras diferentes):
- Autenticação via `apiFetch` (Bearer token), não fetch anônimo por token opaco de URL.
- RBAC: só `owner`/`admin` veem "Novo diagnóstico" e "Calcular agora" (espelha o `isManager` já aplicado no backend em `routes/radar.ts` — a tela apenas oculta o que o backend já rejeitaria com 403, não inventa uma regra nova).
- Sessão concluída pelo fluxo autenticado sempre pousa em `awaiting_review` (nunca `completed`) — `RadarService.completeSession` sempre define esse status, mesmo já tendo calculado o score; é o diagnóstico do PRÓPRIO tenant aguardando revisão do owner/admin antes de virar plano de ação, diferente do visitante anônimo da Fase 2 (sem consultor no caminho). A tela reflete esse status tal como o backend o define, sem reinterpretar.

### Cartão de Índice de Velocidade de Conversão na mesma tela

Em vez de uma view separada, o card de IVC (ADR-010) mora no topo da lista de diagnósticos: busca `GET /api/radar/velocity/latest` ao montar (404 esperado e tratado silenciosamente quando a organização nunca calculou — mesmo padrão de "ainda sem dado" já usado nos outros módulos do produto) e permite recalcular sob demanda (`POST /api/radar/velocity/calculate`), reaproveitando o endpoint que já existia sem consumidor de UI.

### `SettingsView.tsx`: uma linha adicionada, nada mais

`OPTIONAL_MODULES` ganhou `{ key: 'radar', label: 'Radar de Execução IA', desc: '...' }`. O painel (`ModulesPanel`) já era genérico — funciona para qualquer chave presente no array, sem lógica especial por módulo.

## Validação real (não só os testes automatizados existentes)

Rodei a suíte completa do projeto de novo (**7 scripts, 113 verificações, todas passando**, nenhuma tocada por este PR) e, adicionalmente, um fluxo end-to-end num Chromium headless real, criando uma organização nova, simulando o preset "outro" que o onboarding real aplicaria (`vertical` sem `vms`/`radar`, que continuam opt-in por design — ADR-009), e depois:

1. Confirmado que o item "Radar de Execução IA" NÃO aparece na Sidebar antes do módulo ser habilitado.
2. Habilitado o módulo pela própria UI de Configurações › Módulos (clique real no toggle + Salvar), e confirmado que o item passa a aparecer na Sidebar após recarregar.
3. Criado um diagnóstico pela UI, respondidas as 18 perguntas pela UI (sempre a opção de maior score), concluído e verificada a tela de resultado (score, nível de maturidade, os 7 pilares, recomendações).
4. Confirmado que a lista volta a mostrar a sessão com o status correto (`Aguardando revisão`).
5. Calculado o IVC pela UI e confirmado que o card atualiza com o valor calculado.
6. Zero erros de console atribuíveis a este código (os únicos erros capturados — WebSocket de HMR do Vite e um 404 esperado de `/velocity/latest` antes do primeiro cálculo — já existiam antes de tocar em qualquer tela do Radar, confirmado rodando o mesmo teste sem visitar o módulo).

## Não incluído nesta rodada (deliberado)

- **Edição de uma sessão em andamento por vários respondentes ao mesmo tempo** (Fase 3 — painel do consultor, diagnóstico multi-respondente). O painel autenticado desta rodada assume um único respondente por sessão, igual à Fase 1 original.
- **Visualização de leads capturados pelo Radar dentro do próprio módulo.** Como já aparecem em `ProspectView.tsx` sem nenhum código adicional (achado confirmado, não presumido — ver seção acima), não há necessidade de duplicar essa visualização dentro do Radar.
- **Recalcular/editar uma sessão já em `awaiting_review`.** O backend já expõe `POST /sessions/:id/recalculate`, mas a tela desta rodada não oferece essa ação — fica para quando o painel do consultor (Fase 3) definir o que "revisar" significa de fato.
