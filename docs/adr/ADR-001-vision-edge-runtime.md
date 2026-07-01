# ADR-001 — Vision Edge Runtime

**Status:** Aceito (decisão parcial — runtime de linguagem explicitamente adiado para pós-laboratório, conforme PRD §6.1)
**Data:** Fase 0
**Decisores:** IA Dev (proposta técnica), pendente validação do cliente após laboratório

## Contexto

O PRD (`docs/PRD-VISION-VMS.md` §6.1) exige que o **ZappFlow Vision Edge Gateway** seja um serviço tecnicamente independente do core ZappFlow, sem compartilhar processo com `server.ts`. A pesquisa de reconciliação confirmou que hoje:

- `server.ts` é um processo Express único (Node 22) que serve API + estáticos do build Vite, com `Scheduler`, `NotificationService`, `PaymentService`, `ModuleService` e `EncryptionService` todos rodando **in-process** (sem worker separado, sem fila externa).
- Não existe nenhum precedente de segundo processo, container adicional ou runtime não-Node no repositório.
- O `Dockerfile` builda uma imagem single-stage que gera um único binário (`dist/server.cjs`).

Colocar streaming de vídeo, gravação, inferência de IA e ONVIF/RTSP dentro desse mesmo processo violaria a regra de não regressão do PRD (§0.3): qualquer travamento de I/O de vídeo bloquearia o event loop do CRM/WhatsApp/Kanban.

## Alternativas consideradas

| Opção | Prós | Contras |
|---|---|---|
| **Node.js/TypeScript** | Mesma linguagem do core; reaproveita padrões já validados (`EncryptionService`, contratos TS, `packages/vision-contracts` compartilhado); equipe já domina; caminho mais rápido para o laboratório da Fase 0 | Concorrência de I/O via event loop único; processamento de vídeo pesado deve obrigatoriamente rodar fora do processo Node (child process) |
| **Go** | Excelente concorrência para múltiplos streams simultâneos; binário estático único, fácil de distribuir para um appliance Edge; baixo consumo de memória | Equipe sem experiência prévia no repositório; exigiria geração de contratos (OpenAPI/JSON Schema) para manter `vision-contracts` compartilhado com o TypeScript do core; maior custo de ramp-up |
| **Python** | Ecossistema maduro de visão computacional (OpenCV, PyTorch, ONNX) | Modelo de concorrência mais fraco para muitos streams RTSP simultâneos (GIL); empacotamento/distribuição mais pesado para um appliance |
| **Rust** | Melhor performance e segurança de memória | Maior custo de aprendizado; ecossistema ONVIF/RTSP menos maduro que em Go/Node |

## Decisão

1. **Separação de processo é inegociável e não depende da linguagem escolhida.** O Vision Edge Gateway roda em processo(s) de sistema operacional distintos do `server.ts`, com seu próprio ciclo de vida, logs, health checks, storage local (SQLite próprio) e outbox. A comunicação com o Cloud é exclusivamente via API/eventos versionados (ver ADR-007).
2. **Motores de mídia são sempre processos externos** (binários spawnados via `child_process`/CLI — ex. FFmpeg, MediaMTX), independentemente da linguagem escolhida para a lógica de orquestração do Edge. Isso isola o Edge do risco de travar o event loop de qualquer runtime escolhido, e também simplifica a análise de licenciamento (ADR-003), já que nenhum motor de mídia é linkado estaticamente ao binário do produto.
3. **Para o laboratório da Fase 0 (Sprint 0/1), prototipar o Vision Edge em Node.js/TypeScript.** Justificativa: menor tempo até o primeiro live view/gravação/playback funcionando ponta a ponta, reaproveitamento do padrão de criptografia (`EncryptionService`) e da disciplina de isolamento por tenant já validada em `scripts/test-tenant-isolation.ts`. Isso **não é a decisão final de runtime** — é a base para coletar dados reais de CPU/RAM por stream nos perfis Edge S/M/L (PRD §9.1).
4. **Gatilho explícito para reavaliação:** se, ao final do Sprint 2 (Live view e health, PRD §22), os testes de carga mostrarem que o modelo de I/O do Node não sustenta o perfil Edge M (8–24 câmeras) mesmo com motores de mídia externos, abrir um adendo a este ADR avaliando reescrita do Stream Gateway/Recording Service em Go. Essa reavaliação é factível sem impacto no core, pois o Edge é um serviço isolado.
5. Estrutura de repositório recomendada (PRD §6.1):
   ```text
   apps/
     zappflow-core/      (código atual, sem mover fisicamente na Fase 0 — ver nota abaixo)
     vision-edge/         (novo)
   packages/
     vision-contracts/    (schemas de eventos e DTOs compartilhados)
     shared-security/      (padrão de criptografia/idempotência reaproveitado do core)
   ```
   Nota: mover `server.ts`/`src/server` para `apps/zappflow-core` fisicamente é uma reestruturação de build (Docker, esbuild, Vite) com custo e risco próprios. Recomenda-se **não mover o core na Fase 0** — apenas criar `apps/vision-edge` como novo diretório/processo, e avaliar a reestruturação completa do monorepo como um item separado de Fase 1, para não misturar risco de infraestrutura com risco de produto novo.

## Licenças

Não aplicável diretamente ao runtime em si (Node, Go, Python e Rust têm licenças permissivas — MIT/BSD nos toolchains). Licenciamento de bibliotecas específicas de mídia e IA é tratado no ADR-003.

## Riscos

- **Alto** se streaming/inferência forem implementados como bibliotecas linkadas in-process no Node (bloqueiam o event loop) — mitigado pela regra de "motores de mídia sempre externos" (item 2).
- **Médio** custo de eventual reescrita futura em Go, caso o gatilho do item 4 seja acionado — mitigado por manter os contratos (`vision-contracts`) desacoplados de linguagem (JSON Schema/OpenAPI), permitindo reescrever o runtime sem quebrar o Cloud.

## Custo

Baixo para o protótipo Node (reaproveita conhecimento da equipe). Custo de uma eventual migração para Go é desconhecido até o teste de carga real — por isso o item 4 declara um gatilho objetivo, não uma reescrita especulativa.

## Segurança

Processo separado reduz superfície de ataque do core (uma falha de parsing de stream RTSP malicioso não compromete CRM/WhatsApp). Comunicação Edge↔Cloud deve usar autenticação própria (API key/JWT de serviço), nunca reaproveitar tokens de usuário do core.

## Impacto de manutenção

Equipe precisa manter dois deployables (core e edge) com pipelines de build/versionamento próprios. Compensado pela possibilidade de atualizar o Edge por site sem redeploy do Cloud.

## Plano de rollback

Como o Vision Edge é um processo novo e isolado, o rollback é trivial na Fase 0: desligar o processo/flag `vision_edge` não afeta o core em nenhuma hipótese, pois nenhuma dependência é injetada de volta no `server.ts`.

---

## Adendo — Vision Cloud como terceiro serviço (separado do core, mesmo banco, mesmo domínio)

**Status:** Aceito e validado com prova de conceito em runtime.
**Data:** pós-Fase 0, antes do início da Fase 1.

### Contexto do adendo

Este ADR, na versão original, resolveu a separação entre `zappflow-core` e `vision-edge` (o serviço que roda fisicamente no site do cliente). Ficou em aberto onde rodaria a parte de **gestão na nuvem** do Vision (Command Center, dashboards, Event Inbox, RBAC de câmeras/sites) — implicitamente, ela poderia nascer dentro do próprio `server.ts`, como mais um módulo (padrão de Reservas/Assinaturas).

Decidiu-se ir um passo além: essa parte também nasce como **processo separado do `server.ts`**, chamado **Vision Cloud**, pelos mesmos motivos de isolamento de falha, deploy independente e organização de código já usados para justificar a separação do Edge — mas com uma diferença importante: o Vision Cloud **compartilha o mesmo banco de dados** do core e é exposto **no mesmo domínio**, com **login único**. Ao contrário do Edge (que precisa de banco próprio local para operar sem internet), o Vision Cloud roda ao lado do core na mesma infraestrutura de nuvem, então não há motivo técnico para duplicar banco ou autenticação.

### Decisão

1. **Estrutura**: novo diretório `apps/vision-cloud/server.ts` — processo Express próprio, sem importar nenhum módulo do grafo do `zappflow-core` (nenhum `import` de `src/server/*`). Isso preserva o isolamento de falha: um bug no Vision Cloud não pode derrubar o processo do CRM porque são binários/processos diferentes.
2. **Banco compartilhado**: o Vision Cloud abre sua própria conexão `better-sqlite3` para o **mesmo arquivo** `zappflow.db` (mesma variável `DATA_DIR`), em vez de importar `src/server/db.ts`. O banco já roda em modo **WAL** (`db.ts:10`), que é o que permite múltiplos processos lerem/escreverem no mesmo arquivo sem se bloquearem. Foi adicionado `db.pragma('busy_timeout = 5000')` nos dois lados (core e vision-cloud) para que uma rara colisão de escrita espere e tente de novo em vez de falhar imediatamente.
3. **Mesmo domínio via proxy interno**: o `server.ts` ganhou um proxy (`http-proxy-middleware`, MIT) que encaminha `/api/vision/*` para `http://127.0.0.1:VISION_CLOUD_PORT` — **depois** do middleware de autenticação e do gate de módulo já existentes (`protectedApi.use(requireAuth)`, `requireOrganizationAccess`, gate por `ModuleService.MODULE_BY_ROUTE`). O Vision Cloud nunca é exposto publicamente por conta própria (escuta só em `127.0.0.1`).
4. **Login único / defesa em profundidade**: o Vision Cloud valida **o mesmo JWT** (`JWT_SECRET` compartilhado) de forma **independente** — ele não confia cegamente no fato de a requisição ter vindo do proxy do core; ele revalida a assinatura do token por conta própria. Isso dá login único para o usuário e, ao mesmo tempo, segurança de que o Vision Cloud não pode ser enganado por uma requisição direta não autenticada, caso algum dia seja alcançável de outra forma.
5. **Gate de módulo**: registrado `vision -> "vms"` em `ModuleService.MODULE_BY_ROUTE` (`ModuleService.ts`). O módulo `"vms"` foi adicionado à lista de módulos opcionais conhecidos (`verticals.ts: OPTIONAL_MODULES`), mas **deliberadamente excluído** do preset de todas as verticais (inclusive "outro", que liga o resto) — só pode ser ativado por ação explícita em Configurações › Módulos, conforme a regra do PRD de feature flags desligadas por padrão.
6. **Flags granulares**: criada a tabela aditiva `vision_feature_flags` (`organization_id`, `site_id` opcional, `flag_key`, `enabled`, com índice único de escopo) — complementar ao gate grosso do módulo `"vms"`, para permitir ligar/desligar sub-recursos (`vision_ptz`, `vision_lpr` etc.) por tenant e por site quando essas rotas existirem de fato (Fase 1+).
7. **Deploy em produção — item em aberto, não resolvido por este adendo**: a decisão de proxy dentro do `server.ts` evita mudar infraestrutura (DNS, certificado, Traefik/Coolify) agora, mas ainda não resolve **como os dois processos sobem juntos em produção** (hoje o `Dockerfile` builda/roda um único processo). Isso precisa de uma decisão de deploy antes da Fase 1 ir a produção — candidatos: (a) um pequeno supervisor de processo dentro do mesmo container (ex.: o `CMD` do Docker sobe `vision-cloud` em background e depois o `server.ts` em foreground), ou (b) migrar para dois containers com roteamento por path na borda (Traefik/Coolify), como já foi cogitado e adiado nesta conversa. Não alterar o `Dockerfile`/processo de start em produção sem essa decisão explícita.

### Prova de conceito (validação em runtime, não só no papel)

Antes de fechar este adendo, os três pontos de risco técnico foram testados de verdade neste ambiente (não apenas assumidos):

- **Login único funciona de ponta a ponta**: um JWT gerado com o mesmo `JWT_SECRET` do core autenticou com sucesso em `GET /whoami` no processo `vision-cloud`; um token sem header foi rejeitado com 401; um token assinado com segredo diferente também foi rejeitado com 401.
- **Leitura cross-processo do mesmo banco funciona**: `vision-cloud`, com sua própria conexão `better-sqlite3`, leu corretamente uma linha de `organization_settings` inserida por um processo separado simulando o core.
- **Escrita concorrente de dois processos no mesmo arquivo SQLite não gera erro de lock**: um teste de carga de ~2 segundos com dois processos Node independentes escrevendo simultaneamente (um em `organization_settings`, outro em `vision_feature_flags`) produziu **mais de 46 mil escritas combinadas com zero erros de `SQLITE_BUSY`/`database is locked`**, confirmando que WAL + `busy_timeout` sustentam o modelo de dois processos compartilhando o mesmo arquivo sob a carga esperada de um SaaS deste porte.

### Riscos (adendo)

- **Médio**: sem o item 7 resolvido, este scaffold funciona em desenvolvimento local (dois processos rodados manualmente) mas **não deve ser considerado pronto para produção** até a decisão de deploy ser tomada.
- **Baixo**: volume de escrita concorrente em produção real (muitos tenants) pode ser maior que o teste sintético de 2 segundos — o `busy_timeout` de 5s dá margem, mas vale reincluir esse cenário nos testes de carga da Fase 1 (já previstos no PRD §29).

### Plano de rollback (adendo)

Reverter é trivial: remover o proxy `protectedApi.use("/vision", ...)` do `server.ts` (uma linha), o que faz `/api/vision/*` voltar a responder 404 sem nenhum efeito colateral no resto do core. As tabelas (`vision_feature_flags`) e o módulo (`"vms"`) são aditivos e podem ficar sem uso sem custo.
