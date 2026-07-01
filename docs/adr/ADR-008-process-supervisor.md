# ADR-008 — Supervisor de Processo do Container de Produção

**Status:** Aceito e implementado (código real, não apenas especificação).
**Data:** pós-Fase 0, resolvendo o item 7 (deploy em produção) deixado "EM ABERTO" no adendo da `ADR-001-vision-edge-runtime.md`.

## Contexto

O adendo da ADR-001 ("Vision Cloud como terceiro serviço") implementou e validou em runtime um segundo processo Node (`apps/vision-cloud/server.ts`) rodando ao lado do core (`server.ts`), compartilhando o mesmo banco SQLite (WAL + `busy_timeout`) e exposto no mesmo domínio via proxy interno (`/api/vision/*`). Ficou explicitamente registrado como **em aberto**: como os dois processos sobem juntos em produção, já que hoje o `Dockerfile` builda e roda um único processo (`CMD ["npm", "run", "start"]` → `node dist/server.cjs` como PID 1 direto).

Critério explícito do cliente (dono do produto) para esta decisão: **"faça o que for melhor para o projeto e que tenha menores chances de quebrar no futuro, seja mais simples de identificar erros e mais simples de fazer manutenção, documente no código para facilitar manutenção no futuro"** — ou seja, priorizar simplicidade/robustez/observabilidade sobre arquitetura especulativa.

## Alternativas consideradas

Três opções foram desenhadas e avaliadas de forma independente (design + julgamento + revisão adversarial em 3 dimensões: correção de mecanismo, manutenibilidade, simplicidade/YAGNI):

| Opção | Resumo | Risco de quebrar | Debugabilidade | Manutenção |
|---|---|---:|---:|---:|
| **A — Supervisor Node puro** (sem `tini`) | Um script Node faz spawn dos dois processos, encaminha sinais, reinicia o vision-cloud. | 7/10 | 8/10 | 8/10 |
| **B — `tini` + supervisor** | `tini` como PID 1 real (reaping de zumbi/sinais, ferramenta padrão de mercado) + supervisor Node como seu filho único. | 9/10 | 9/10 | 9/10 |
| **C — Dois containers + roteamento na borda** | Cada processo em seu próprio container; Traefik/Coolify roteia por path. | 3/10 | 4/10 | 3/10 |

**Opção C foi descartada.** Ela reabre exatamente a categoria de mudança de infraestrutura fora do repositório que o cliente já havia recusado durante a decisão do proxy interno (ADR-001, adendo): exigiria uma segunda aplicação no Coolify, volume Docker compartilhado entre dois containers (superfície de erro sutil — dados divergentes sem crash óbvio), rede interna entre containers, e fragmentaria os logs em duas telas do painel em vez do console único que existe hoje. Nenhum desses custos é necessário para resolver o problema real (supervisão de dois processos), que tem solução madura dentro do próprio container.

**Opção A** é viável, mas tem uma lacuna honesta: sem `tini`, o próprio supervisor Node teria que reimplementar reaping de processo zumbi/órfão — e o Node não expõe uma API para "reap qualquer filho reparentado", só reap automático dos filhos que ele mesmo criou (via libuv). Isso é seguro **hoje** (nem `core` nem `vision-cloud` geram subprocessos), mas seria um ponto cego se algum dia um dos dois passar a invocar um binário externo (ex.: `ffmpeg` — mencionado no ADR-001 item 2 como decisão futura, aplicável ao Vision **Edge**, não ao Vision **Cloud** tratado aqui, mas o container de produção do Cloud não deveria depender dessa distinção para estar correto).

## Decisão

**Opção B: `tini` (PID 1 real) + supervisor Node próprio, ambos dentro do mesmo container.** `tini` cuida exclusivamente de reaping de zumbi/repasse de sinal (é literalmente o binário usado por `docker run --init` — ferramenta madura, não experimental); o supervisor (`scripts/supervisor.ts`) cuida exclusivamente de orquestração (subir os dois processos, política de reinício, detecção de travamento, logs unificados).

```text
tini (PID 1, ENTRYPOINT do Dockerfile)
  └── scripts/supervisor.ts (CMD)
        ├── core (dist/server.cjs)         — processo principal do produto
        └── vision-cloud (dist/vision-cloud.cjs) — isolado, pode falhar sem afetar o core
```

### Comportamento exato dos 5 cenários cobertos

| Cenário | Comportamento |
|---|---|
| **(1) Container recebe SIGTERM** (redeploy/`docker stop` do Coolify) | `tini` repassa o sinal ao supervisor; o supervisor manda `SIGTERM` para os dois filhos e espera ambos saírem antes de sair ele mesmo. O core não trata `SIGTERM` (mata na hora — comportamento idêntico ao de hoje, sem regressão). |
| **(2) `vision-cloud` crasha uma vez (falha isolada)** | Log grita `*** CAIU ***`; supervisor reinicia após um intervalo fixo (`RETRY_INTERVAL_MS`); o core nunca é tocado. |
| **(3) `vision-cloud` em crash-loop persistente** (ex.: config errada) | Depois de `MAX_VISION_RESTARTS` tentativas, o supervisor **desiste** e loga isso de forma explícita — não vira loop infinito escondendo o bug atrás de ruído de log. O core continua saudável; `/api/vision/*` responde erro de proxy até o próximo redeploy corrigir a causa. |
| **(4) `vision-cloud` "travado"** (não crasha, só para de responder) | Health-check ativo (ping periódico em `GET /health`, endpoint que o `vision-cloud` já expõe) detecta a falta de resposta; após N falhas seguidas, o supervisor mata o processo à força (`SIGKILL`) e trata como crash normal (mesma lógica de retry do item 2/3). |
| **(5) `core` crasha** | Supervisor derruba o `vision-cloud` também e sai com o mesmo código de saída do core — o container inteiro morre, e o Coolify aplica sua política de restart, exatamente como acontecia antes deste supervisor existir (quando o core era o próprio PID 1). |

### Por que a política de reinício é mais simples do que a primeira versão

A primeira especificação usava backoff exponencial (1s, 2s, 4s...) com uma janela de reset por tempo. A revisão de simplicidade/YAGNI apontou, corretamente, que isso é peso desnecessário: o "recurso" que uma nova tentativa consome é só um `spawn` de processo Node local (barato, não uma API externa a poupar), e o reset natural do contador já existe — todo redeploy/restart do container recria o supervisor do zero. A versão implementada usa **intervalo fixo** (`RETRY_INTERVAL_MS`) e **teto simples de tentativas** (`MAX_VISION_RESTARTS`), sem janela de reset — menos estado, menos parâmetro para explicar, mesma garantia observável.

### Limite de memória do `vision-cloud`

Os dois processos rodam no mesmo container/cgroup — sem nenhuma proteção, um `vision-cloud` que aloca agressivamente antes de crashar poderia ser morto pelo *OOM killer* do kernel, que não necessariamente escolhe matar o processo "certo" (pode matar o `core` em vez do `vision-cloud`, dependendo da pontuação relativa de uso de memória). O supervisor passa `--max-old-space-size` (via `NODE_OPTIONS`, configurável por `VISION_CLOUD_MAX_OLD_SPACE_MB`, default 512 MB) **só** para o `vision-cloud`, para que ele mesmo se autolimite com um erro de heap V8 tratável (contabilizado como crash normal) antes de pressionar a memória do container inteiro.

## Validação empírica (não apenas teórica)

Uma primeira especificação (gerada por um processo de design e revisão adversarial com múltiplos agentes) citou "testes empíricos" que, na re-verificação, se mostraram parcialmente inconsistentes (o log citado como prova de reaping de zumbi na verdade documentava o aviso do `tini` de que ele **não** estava rodando como subreaper real naquela execução específica). Por isso, os pontos centrais foram **revalidados de forma independente**, neste ambiente, antes de qualquer implementação:

### 1. Reaping de processo zumbi/órfão — confirmado com teste de controle

Reproduzido com `unshare --pid --fork --mount-proc` (simula a topologia real de PID namespace de um container, sem precisar de daemon Docker — indisponível neste ambiente de desenvolvimento):

- **Sem `tini`** (Node como PID 1 direto): um processo "neto" órfão (cujo pai/processo intermediário saiu antes dele) fica como `<defunct>` (zumbi) permanentemente, confirmado via snapshot de `/proc` dentro do namespace.
- **Com `tini` como PID 1 real** (`tini -- node ...`): o mesmo cenário produz **zero** processos zumbis — o neto órfão é reapeado corretamente e nem aparece mais na tabela de processos.

### 2. Repasse de SIGTERM — medido, não assumido

`SIGTERM` enviado diretamente ao PID do `tini` (visto do host, simulando o Docker mandando o sinal ao PID 1 do container) chegou ao supervisor e foi repassado aos dois processos filhos (um sem handler de `SIGTERM`, saindo imediatamente; um com cleanup simulado de 800ms). **Tempo total do sinal até os dois processos + supervisor saírem: ~808ms** — bem dentro da janela padrão de ~10s que o Docker/Coolify espera antes de escalar para `SIGKILL`.

### 3. Suíte de teste automatizada (`npm run test:supervisor`)

Criado `scripts/test-supervisor.ts` (mesmo padrão de `scripts/test-tenant-isolation.ts`: relatório PASS/FAIL, código de saída 1 em falha), que sobe o supervisor real (não uma simulação) contra processos de teste (stubs) programáveis para crashar, travar ou se comportar normalmente, e verifica automaticamente os 5 cenários da tabela acima. **10/10 verificações passam.**

Esse processo de teste **encontrou e corrigiu dois bugs reais** antes de qualquer deploy:

1. **No próprio `scripts/supervisor.ts`**: quando o `core` crashava, a variável `core` não era zerada antes de `shutdownAll()` tentar esperar por um novo evento `"exit"` no mesmo objeto `ChildProcess` — mas `"exit"` só dispara uma vez por processo, e já tinha disparado. O supervisor só saía "por acidente" (event loop esvaziando), com o **código de saída errado** (0 em vez do código real do crash) — o que teria escondido o crash do Coolify. Corrigido zerando a referência antes de propagar o shutdown (ver comentário no código, função `spawnCore`).
2. **No próprio teste** (`scripts/test-supervisor.ts`): usar `SIGKILL` para encerrar o supervisor entre cenários órfão-ava os processos-filho dele (`SIGKILL` não pode ser tratado nem repassado) — bug de vazamento de processo confirmado via `ps aux` mostrando dezenas de processos de teste acumulados entre execuções. Corrigido trocando para `SIGTERM` primeiro (mesmo caminho gracioso do Cenário 1), com `SIGKILL` só como último recurso.

Isso reforça por que a decisão de ADR-002/ADR-004 de sempre validar em runtime (não confiar só em revisão de código/especificação) importa: **o mecanismo mais sutil de todo este ADR (reaping de zumbi) só foi confirmado corretamente depois de um teste de controle mostrar o problema acontecendo sem `tini`, e depois mostrar que ele desaparece com `tini`.**

## Mudanças de código

- **`Dockerfile`**: instala `tini`; builda os três entrypoints (`npm run build && npm run build:vision-cloud && npm run build:supervisor`); `ENTRYPOINT ["tini", "--"]` + `CMD ["node", "dist/supervisor.cjs"]` (chamando `node` diretamente, não via `npm run`, pelo mesmo motivo do bug do `npx` encontrado no teste — evitar uma camada de processo que pode não repassar sinal/exit-code de forma confiável).
- **`scripts/supervisor.ts`** (novo): implementação completa, comentada com cabeçalho explicando o modelo, seção de troubleshooting para quem for investigar um incidente, e comentário de justificativa ao lado de cada constante ajustável.
- **`scripts/test-supervisor.ts`** (novo): suíte de teste automatizada, mesmo padrão de `test:isolation`.
- **`package.json`**: `build:supervisor`, `start:supervisor`, `test:supervisor`.
- **`server.ts`**: comentário cruzado perto do `app.listen()` avisando que um futuro handler de `SIGTERM` no core interage com a suposição de tempo do supervisor.

## Riscos

- **Baixo**: `tini` é infraestrutura madura (a mesma usada por `docker run --init`), com uso mínimo/padrão aqui (só como `ENTRYPOINT` fixo, sem flags exóticas).
- **Médio**: `scripts/supervisor.ts` é código novo — mitigado pela suíte de teste automatizada (10/10, cobrindo os 5 cenários) e pelo próprio processo de escrevê-lo já ter revelado e corrigido um bug de exit-code antes do primeiro deploy.
- **Baixo**: ainda não testado dentro de um container Docker real (o ambiente de desenvolvimento usado aqui não tem daemon Docker disponível) — a topologia de PID namespace foi validada via `unshare`, que replica fielmente o mecanismo relevante (reaping de zumbi, PID 1, sinais), mas recomenda-se um `docker build && docker run` manual (ou o primeiro deploy em staging) como confirmação final antes de considerar 100% encerrado.
- **Aceito conscientemente**: nenhum limite de CPU/memória em nível de container/Coolify foi configurado por esta ADR (está fora do que é versionável no repositório) — a mitigação de memória disponível (item "Limite de memória", acima) cobre o caso mais provável (heap do `vision-cloud` crescendo descontroladamente), mas não substitui um limite de recursos no nível da plataforma, caso o Coolify exponha essa opção.

## Custo

Zero custo de licença (`tini` é MIT, já usado internamente pelo próprio Docker). Custo de manutenção é baixo: um arquivo de ~200 linhas comentado, sem dependência de terceiros além do `tini` (ferramenta de sistema, não pacote npm).

## Plano de rollback

Reverter é simples e não deixa rastro: no `Dockerfile`, trocar `ENTRYPOINT ["tini", "--"]` / `CMD ["node", "dist/supervisor.cjs"]` de volta para `CMD ["npm", "run", "start"]` (removendo também a linha que instala `tini` e os dois `build:*` extras) volta exatamente ao comportamento anterior a este ADR — nenhuma tabela de banco, rota de API ou contrato externo depende do supervisor existir.
