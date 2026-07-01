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
