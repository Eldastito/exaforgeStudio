# PRD — ZappFlow Vision VMS v1.1
## Vigilância Inteligente, Operação Visual, Identity & Access e Execução Integrada

**Versão:** 1.1
**Status:** Documento oficial para reconciliação PRD × codebase
**Produto-mãe:** ZappFlow OS
**Módulo:** ZappFlow Vision VMS
**Modelo de implantação recomendado:** ZappFlow Edge Hybrid
**Públicos prioritários:** condomínios, administradoras, hotelaria, clínicas, redes varejistas, indústrias e empresas multiunidade
**Regra de ouro:** reaproveitar o hardware de vigilância existente sempre que tecnicamente viável; substituir progressivamente o software/VMS legado sem obrigar o cliente a pagar duas plataformas de vigilância de forma permanente.

> Este arquivo é a cópia oficial, versionada no repositório, do PRD recebido do cliente (v1.1). Ele é a fonte de verdade para a reconciliação em `docs/PRD-VISION-VMS-RECONCILIACAO.md` e para as ADRs em `docs/adr/`. Não editar o conteúdo abaixo sem nova aprovação do cliente — mudanças de escopo devem gerar uma v1.2.

---

# 0. Leitura obrigatória para a IA Dev

Este PRD substitui o `PRD_ZappFlow_Vision_VMS_v1.md`.

Antes de criar qualquer tela, integrar uma câmera, conectar um stream RTSP/ONVIF, gravar vídeo, chamar modelo de visão computacional ou acionar uma cancela, a IA Dev deve entregar a matriz de reconciliação PRD × codebase.

## 0.1 Estado conhecido do codebase — hipótese a validar na reconciliação

Conforme análise técnica recebida, o produto atual possui:

- SPA React 19;
- backend Express concentrado em `server.ts`;
- SQLite via `better-sqlite3`;
- isolamento multiempresa por camada de aplicação;
- serviços já existentes como `AIOrchestratorService`, `MaestroService`, `BusinessContextService`, `AnalyticsService`, `ExecutiveAdvisorService`, `TaskService`, `NotificationService`, `LgpdService`, `SecurityAuditService` e `EncryptionService`;
- ausência atual de runtime de vídeo, ONVIF, RTSP, WebRTC/HLS, object storage de vídeo, GPU, Vision Edge separado e RLS nativo de banco.

Essas informações devem ser confirmadas em código. Elas não substituem auditoria técnica.

## 0.2 Matriz obrigatória PRD × codebase

Criar o documento:

```text
docs/PRD-VISION-VMS-RECONCILIACAO.md
```

Usar a tabela:

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|

Usar somente estas classificações:

- `EXISTE E PODE SER REUTILIZADO`
- `EXISTE PARCIALMENTE`
- `EXISTE, MAS PRECISA SER ADAPTADO`
- `NÃO EXISTE`
- `EXISTE, MAS HÁ RISCO DE COMPATIBILIDADE`
- `PRECISA SER VALIDADO COM DISPOSITIVO REAL`
- `PRECISA SER VALIDADO COM CARGA REAL`

A reconciliação deve cobrir, no mínimo:

1. arquitetura frontend, backend, banco, filas, storage, PWA e Docker;
2. multi-tenant, RBAC, isolamento de tenant e testes de isolamento existentes;
3. serviços de tarefas, notificações, Maestro, Copiloto, RIC, Analytics e Diretor Executivo IA;
4. feature gating, planos, limites e custos já existentes;
5. estado de Edge/Intranet e sincronização;
6. capacidade de jobs assíncronos, cron e webhooks;
7. possibilidades reais de storage local, playback, streaming, transcodificação e gravação;
8. integração de dispositivos, rede local e mecanismo de update do Edge;
9. controles de auditoria, criptografia, secrets, logs e acessos;
10. bibliotecas candidatas, licença, riscos de distribuição e manutenção;
11. impacto da atual base SQLite e alternativas futuras;
12. estratégia de testes com câmeras, NVRs, DVRs, cancelas e cargas reais.

## 0.3 Regra de não regressão

O Vision VMS não pode interromper ou degradar CRM, Atendimento, Kanban, RIC, Copiloto, WhatsApp, Instagram, Estúdio de Criação, automações, tarefas, integrações existentes ou administração multiempresa.

Obrigatório:

- feature flags;
- migrations aditivas;
- módulos e contratos isolados;
- rollout por tenant, unidade e câmera;
- testes unitários, integração, E2E e hardware-in-the-loop;
- logs de auditoria;
- rollback documentado;
- monitoramento de saúde;
- corte gradual por câmera e unidade.

## 0.4 Branch inicial

```text
feat/zappflow-vision-vms-v11
```

## 0.5 Feature flags

```text
vision_vms
vision_edge
vision_live_view
vision_recording
vision_playback
vision_device_health
vision_incident_management
vision_ai
vision_remote_access
vision_webhooks
vision_access_control
vision_lpr
vision_pet_zone_compliance
vision_panic_mode
vision_multi_condominium
vision_demo_kit
vision_identity_search
vision_face_identity
vision_ptz
```

Regras:

- `vision_face_identity` permanece desligada por padrão e fora do MVP.
- `vision_identity_search` depende de política de privacidade, permissões reforçadas, auditoria e aprovação específica.
- `vision_ptz` fica fora do MVP Core.
- funções de abertura automática devem ser separadas de funções de identificação.

---

# 1. Resumo executivo

O **ZappFlow Vision VMS** é a plataforma de vigilância inteligente, operação visual e execução integrada do ZappFlow OS.

Ele é projetado para substituir progressivamente o software de vigilância/VMS legado de empresas e condomínios, preservando — quando compatíveis — as câmeras, gravadores, cabeamento, switches PoE, racks, nobreaks, monitores e rede de CFTV já existentes.

O produto une:

1. câmeras ao vivo;
2. mosaico e console de portaria;
3. gravação local;
4. playback e busca;
5. cadeia de evidências;
6. saúde de dispositivos;
7. zonas e regras inteligentes;
8. eventos de segurança e operação;
9. ocorrências, alertas e webhooks;
10. tarefas, responsáveis e escalonamento;
11. Copiloto interno;
12. Maestro/Orquestrador;
13. Diretor Executivo IA;
14. RIC e inteligência de impacto;
15. controle de acesso veicular;
16. credenciais para motos e bicicletas;
17. conformidade de áreas com pets;
18. busca de pessoa autorizada, em escopo Enterprise e com governança reforçada.

A promessa comercial é:

> **Mantenha as câmeras que sua operação já possui. Substitua o software de vigilância por uma plataforma que grava, protege evidências, percebe eventos relevantes, coordena pessoas e acompanha a resolução até o resultado.**

---

# 2. Problema

Os sistemas tradicionais de CFTV normalmente gravam imagens e exibem telas, mas não transformam vídeo em trabalho coordenado.

Problemas recorrentes:

- operador precisa acompanhar muitas telas sem contexto;
- eventos relevantes só são descobertos depois de ocorrerem;
- localizar uma gravação consome muito tempo;
- câmeras offline passam despercebidas;
- alertas não viram tarefas;
- ninguém sabe quem deve agir;
- a resolução de um incidente não é acompanhada;
- o gestor não tem visão consolidada por unidade;
- o VMS fica separado de CRM, agenda, manutenção, portaria e operação;
- a empresa paga por vários softwares desconectados;
- equipamentos existentes são subutilizados;
- dependência de nuvem pode paralisar uma operação local;
- vídeo contínuo na nuvem aumenta custo, banda e exposição indevida.

O Vision VMS muda a lógica:

```text
Câmera ou dispositivo detecta uma condição
↓
Vision Edge transforma em evento estruturado
↓
Regra e Maestro classificam prioridade e contexto
↓
ZappFlow alerta, cria ocorrência ou gera tarefa
↓
Copiloto orienta o responsável
↓
Equipe atua
↓
Operador ou nova evidência confirma a resolução
↓
Diretor Executivo IA e RIC consolidam impacto
```

---

# 3. Objetivos

## 3.1 Objetivos de negócio

- substituir mensalidades de VMS legado em instalações compatíveis;
- reduzir a necessidade de sistemas paralelos de vigilância, ocorrência, tarefa e relatório;
- aproveitar hardware existente para reduzir barreira de entrada;
- vender uma plataforma de vigilância e execução, não somente uma câmera com IA;
- criar expansão por câmera, gateway, unidade, detector, identidade/acesso e suporte;
- habilitar receitas adicionais em Edge, manutenção, implantação, integradores e contratos enterprise;
- criar uma proposta competitiva para condomínios e administradoras multiunidade.

## 3.2 Objetivos de produto

- permitir live view, mosaico, gravação, playback, evidência e retenção;
- permitir migração gradual de software de vigilância;
- operar localmente sem internet;
- sincronizar eventos e metadados sem duplicidade;
- detectar condições objetivas configuradas;
- transformar eventos em alertas, incidentes e tarefas;
- integrar vigilância com execução operacional;
- possibilitar acesso veicular governado;
- apoiar motos, bicicletas e visitantes por credencial;
- manter rastreabilidade e governança de acessos;
- oferecer administração por tenant, unidade, área e papel.

## 3.3 Objetivos técnicos

- criar um runtime Vision Edge separado do core;
- conectar fontes de vídeo por protocolos e APIs homologadas;
- registrar, armazenar e reproduzir vídeo localmente;
- processar IA visual localmente sempre que possível;
- evitar envio contínuo de vídeo para a nuvem;
- usar eventos estruturados, outbox, idempotência e sincronização resiliente;
- separar rede de CFTV, serviços Edge e sistema corporativo;
- documentar capacidade por perfil de hardware;
- manter possibilidade de evolução para múltiplas unidades e alta disponibilidade.

---

# 4. Não objetivos do MVP

O MVP não deve:

- suportar todas as marcas e modelos de câmera;
- prometer compatibilidade universal;
- substituir alarmes de incêndio ou sistemas de emergência certificados;
- usar reconhecimento facial, biometria ou busca de pessoa como recurso padrão;
- operar busca de pessoa em escolas na primeira versão;
- analisar emoção, caráter, intenção, honestidade ou "suspeita" por aparência;
- automatizar advertência, multa, demissão, punição, bloqueio disciplinar ou decisão trabalhista;
- abrir portão/cancela por reconhecimento facial;
- liberar acesso físico sem política explícita, modo configurado e mecanismos de segurança física;
- enviar vídeo contínuo para a nuvem por padrão;
- colocar streaming, gravação e IA de vídeo dentro do processo monolítico de CRM;
- prometer valor probatório garantido a qualquer exportação sem análise jurídica e operacional;
- implementar PTZ, reconhecimento de placa e IA avançada antes da validação do VMS Core;
- integrar qualquer DVR/NVR proprietário sem prova de compatibilidade;
- tratar alertas probabilísticos como fatos confirmados sem revisão humana.

---

# 5. Posicionamento e pacotes

## 5.1 Nome

**ZappFlow Vision VMS**

## 5.2 Subtítulo

**Vigilância inteligente, operação visual, acesso governado e execução integrada.**

## 5.3 Pacotes comerciais

| Pacote | Escopo |
|---|---|
| Vision VMS Core | Inventário, live view, mosaico, gravação, playback, evidência, retenção, device health, usuários e auditoria. |
| Vision Intelligence | Core + zonas, regras, eventos, detectores selecionados, ocorrências, alertas e integrações básicas. |
| Vision Operations | Intelligence + Maestro, Copiloto, Execution Intelligence, tarefas, escalonamento, dashboards e RIC correlacional. |
| Vision Identity & Access | LPR, cadastro de veículos, credenciais, políticas de acesso, relés/cancelas homologados, motos e bicicletas. |
| Vision Enterprise | Multiunidade, painel de administradora, SSO, APIs, governança avançada, alta disponibilidade, integrações especiais e busca de pessoa autorizada. |

---

# 6. Decisões arquiteturais

## 6.1 Vision Edge é serviço separado

O **ZappFlow Vision Edge Gateway** deve ser um subproduto técnico independente do core ZappFlow.

Estrutura recomendada para avaliação:

```text
apps/
  zappflow-core/
  vision-edge/
packages/
  vision-contracts/
  shared-security/
  shared-events/
```

Alternativamente, a IA Dev pode recomendar repositório separado para `vision-edge`, desde que justifique trade-offs de build, deploy, versionamento, suporte e segurança.

O Vision Edge:

- não compartilha processo com `server.ts`;
- não depende do CRM estar disponível para gravação local;
- tem ciclo de atualização independente;
- tem logs, health checks, storage e outbox próprios;
- comunica-se com o core somente por contratos de API/eventos;
- pode operar em internet indisponível;
- pode ser instalado por unidade/site.

## 6.2 ADR obrigatórias da Fase 0

Criar documentos de decisão arquitetural:

```text
docs/adr/ADR-001-vision-edge-runtime.md
docs/adr/ADR-002-tenant-isolation-and-storage.md
docs/adr/ADR-003-media-pipeline-and-license.md
docs/adr/ADR-004-recording-and-evidence-chain.md
docs/adr/ADR-005-vision-ai-inference.md
docs/adr/ADR-006-access-control-and-fail-safe.md
docs/adr/ADR-007-edge-cloud-sync.md
```

Cada ADR deve apresentar:

- contexto;
- alternativas;
- licenças;
- riscos;
- custo;
- segurança;
- impacto de manutenção;
- decisão;
- plano de rollback.

## 6.3 Banco e isolamento multiempresa

A arquitetura atual precisa ser respeitada sem prometer recursos inexistentes.

Enquanto o core utilizar SQLite:

- isolamento será aplicado por `tenant_id`, `site_id`, escopo de usuário e serviços de aplicação;
- toda query Vision deve ter tenant e site explícitos;
- testes automatizados de isolamento são obrigatórios;
- não é permitido confiar em filtro de frontend;
- cada Edge deve manter metadados locais no escopo de um tenant/site;
- acesso de suporte deve ser temporário, explícito e auditado.

A eventual migração para PostgreSQL com políticas de banco deve ser uma decisão própria e não bloqueia o MVP, salvo descoberta técnica contrária na Fase 0.

## 6.4 Pipeline de mídia e licenças

Antes de escolher qualquer motor de RTSP, WebRTC, HLS, gravação, ONVIF, inferência, OCR/LPR ou transcodificação, a IA Dev deve:

- identificar licença da biblioteca, container e modelo;
- confirmar se a licença é compatível com produto comercial distribuído em Edge;
- verificar obrigações de código-fonte, distribuição e avisos;
- analisar manutenção e segurança;
- documentar codecs suportados;
- confirmar compatibilidade com hardware alvo;
- registrar a decisão no ADR-003.

Nenhuma dependência de mídia deve ser adotada só por conveniência de protótipo.

---

# 7. Arquitetura de referência

```text
Câmeras IP / NVR / DVR / Encoder / Controladores físicos
                         │
                         ▼
                Rede de CFTV isolada
                         │
                         ▼
          ZappFlow Vision Edge Gateway
 ┌───────────────────────────────────────────────────────┐
 │ Descoberta de dispositivos                             │
 │ Stream Gateway / Live View                             │
 │ Gravação e indexação                                  │
 │ Playback                                               │
 │ Storage Manager                                        │
 │ Device Health                                          │
 │ Vision AI Inference                                    │
 │ Event Processor                                        │
 │ Evidence Generator                                     │
 │ Access Control Adapter                                 │
 │ Local Metadata Store                                   │
 │ Sync Outbox                                            │
 │ Edge Console                                           │
 └───────────────────────────────────────────────────────┘
                         │
                  Eventos e metadados
                         │
                         ▼
                  ZappFlow OS Cloud
 ┌───────────────────────────────────────────────────────┐
 │ Maestro / Orquestrador                                 │
 │ Copiloto Interno                                       │
 │ Execution Intelligence                                 │
 │ RIC                                                    │
 │ Diretor Executivo IA                                   │
 │ Dashboard multiunidade                                 │
 │ Administração e Auditoria                              │
 └───────────────────────────────────────────────────────┘
```

Princípios:

- vídeo contínuo fica local por padrão;
- eventos e métricas sobem para a nuvem;
- clipes e imagens sobem apenas se política permitir;
- credenciais de câmera permanecem no Edge quando possível;
- Edge continua gravando e exibindo câmera localmente sem internet;
- ações físicas passam por controlador adaptador e regras de segurança;
- nenhum stream deve ser exposto diretamente à internet.

---

# 8. Topologias de fonte de vídeo

## A. Câmera IP direta — cenário ideal

```text
Câmera IP ONVIF/RTSP → Vision Edge
```

Uso: conexão direta para live view, gravação, substream, health e IA.

## B. NVR/DVR como fonte de stream — fallback comum

```text
Câmeras → NVR/DVR → RTSP/API homologada → Vision Edge
```

Uso: aproveita gravador existente como fonte temporária ou permanente.

## C. DVR analógico antigo

```text
Câmera analógica → DVR → HDMI/BNC/stream limitado
```

Uso: avaliar encoder, integração limitada ou substituição gradual.

## D. Câmera ou ecossistema proprietário

```text
Câmera vendor-only → SDK específico / substream / integração limitada
```

Uso: homologar SDK/API, usar substream permitido ou recomendar migração pontual.

### Política comercial

Nunca prometer "compatível com qualquer câmera".

Usar esta redação:

> **O ZappFlow Vision VMS reaproveita câmeras e gravadores compatíveis. Cada instalação passa por diagnóstico técnico para classificar o que será reutilizado, adaptado, mantido temporariamente ou substituído.**

---

# 9. Hardware e implantação Edge

## 9.1 Perfis iniciais

A Fase 0 deve homologar perfis de hardware. Referência inicial:

| Perfil | Uso indicativo | Hardware a validar |
|---|---|---|
| Edge S | 4 a 8 câmeras, poucos detectores | CPU multicore, 16 GB RAM, SSD NVMe, rede gigabit, nobreak |
| Edge M | 8 a 24 câmeras, detectores selecionados | CPU mais forte, 32 GB RAM, SSD/NVMe maior, GPU opcional, RAID/backup conforme necessidade |
| Edge L | 24 a 64+ câmeras ou multiárea | servidor dedicado, 64 GB+ RAM, GPU homologada, storage resiliente, monitoramento avançado |

Os números não são promessa. Devem ser medidos com streams, codecs, FPS, resolução, detectores e política de retenção reais.

## 9.2 Rede

Requisitos:

- rede de câmeras separada da rede de convidados;
- VLAN ou segmentação equivalente;
- tráfego de administração restrito;
- DNS/NTP internos quando aplicável;
- switches adequados a PoE e banda;
- nobreak;
- firewall entre rede corporativa, Edge e câmeras;
- nenhuma câmera exposta diretamente à internet;
- credenciais exclusivas por dispositivo.

---

# 10. VMS Core — funcionalidades

## 10.1 Inventário e onboarding

Cadastrar:

- tenant;
- organização administradora, quando aplicável;
- site/unidade;
- bloco/torre/área;
- gateway;
- dispositivo;
- câmera;
- NVR/DVR/encoder;
- stream principal e substream;
- capacidade;
- políticas de retenção;
- status de compatibilidade;
- responsável técnico.

Fluxo:

```text
Administrador acessa Edge Console
↓
Descoberta controlada de dispositivos ou cadastro manual
↓
Teste de credenciais e stream
↓
Leitura de codec, resolução, FPS e estabilidade
↓
Classificação de compatibilidade
↓
Nome, área, zona e política da câmera
↓
Ativação em ambiente de piloto
```

## 10.2 Live view

Obrigatório:

- visualização individual;
- mosaico 1, 4, 9 e 16;
- grupos por área;
- favoritos;
- modo tela cheia;
- status online/offline;
- nome, local e horário;
- uso de substream em mosaico;
- uso de stream principal em câmera individual quando disponível;
- abertura de playback a partir da câmera;
- acesso conforme RBAC.

## 10.3 Console de Portaria / Operator Console

Deve existir uma experiência específica para guarita e central de monitoramento, distinta do painel administrativo.

Recursos:

- tema escuro;
- multi-monitor;
- layout salvo por estação física;
- mosaico configurável;
- atalhos de teclado;
- botão de pânico;
- busca rápida de evento e playback;
- tile de câmera offline com orientação clara;
- reorganização automática de mosaico em falha, sem tela preta inútil;
- acesso rápido a portão/cancela somente se permitido;
- indicador de eventos recentes;
- lista de ocorrências ativas;
- modo de operação compartilhada;
- sessão de estação auditada;
- suporte posterior a áudio/interfone, apenas se homologado.

## 10.4 Gravação

Modos:

- contínua;
- por evento;
- híbrida;
- sob demanda.

Requisitos:

- política por câmera e grupo;
- retenção configurável;
- validação de lacuna;
- indicador de gravação;
- alarme de storage;
- não apagar evidência bloqueada;
- segmentos indexados por tempo;
- NTP/clock health;
- preservação de metadata do codec e stream.

## 10.5 Playback e busca

Permitir:

- timeline;
- data/hora;
- câmera;
- site;
- zona;
- evento;
- incidente;
- tag;
- bookmarks;
- exportação controlada;
- recorte de clipe;
- exibição de eventos na timeline;
- modo acelerado;
- permissões diferentes para playback e exportação.

## 10.6 Device Health

Monitorar:

- câmera offline;
- stream indisponível;
- perda de gravação;
- baixa taxa de frames;
- storage baixo/crítico;
- gateway offline;
- CPU/RAM/GPU/disco;
- falha de sincronização;
- relógio fora de sincronia;
- mudança de configuração;
- obstrução/tamper quando detector habilitado.

---

# 11. Evidência e cadeia de custódia

## 11.1 MVP

Toda evidência deve conter:

- tenant, site e câmera de origem;
- evento/incidente relacionado;
- início/fim do clipe;
- hash SHA-256;
- data/hora;
- gateway de origem;
- usuário ou serviço que gerou;
- política de retenção;
- marca d'água;
- histórico de visualização;
- histórico de exportação;
- razão de exportação, quando exigida.

## 11.2 Enterprise

Avaliar:

- assinatura/HMAC por tenant;
- timestamp confiável;
- cadeia de custódia imutável;
- pacote de evidência assinado;
- bloqueio legal de retenção;
- cópia de preservação em storage autorizado;
- auditoria reforçada.

O produto deve falar em **integridade e rastreabilidade**, e não prometer valor probatório automático sem validação jurídica/operacional do cliente.

---

# 12. Zonas, regras e eventos

## 12.1 Zonas

Tipos:

- entrada;
- portaria;
- recepção;
- caixa;
- corredor;
- garagem;
- doca;
- estacionamento;
- área restrita;
- estoque;
- rota de emergência;
- área de risco;
- portão/porta;
- bicicletário;
- pet zone;
- perímetro;
- área técnica.

Cada zona possui:

- nome;
- tipo;
- polígono;
- criticidade;
- horário;
- máscara de privacidade;
- responsáveis padrão;
- regras;
- política de retenção;
- configurações de detector.

## 12.2 Eventos MVP

```text
camera_offline
stream_unavailable
recording_gap
storage_low
storage_critical
gateway_offline
clock_drift_detected
tamper_suspected
manual_incident_created
zone_intrusion
occupancy_threshold_exceeded
queue_threshold_exceeded
person_count_changed
vehicle_detected
restricted_area_presence
ppe_missing
door_or_gate_open_suspected
person_down_suspected
object_left_in_zone
```

Todos os eventos devem ter:

- tipo;
- câmera;
- zona;
- severidade;
- confiança;
- evidência;
- estado;
- regra de origem;
- timestamp;
- correlação;
- tenant e site.

## 12.3 Estados de evento

```text
detected
queued_for_review
acknowledged
in_progress
resolved
false_positive
dismissed
expired
escalated
```

---

# 13. Vision AI operacional

## 13.1 Permitido no MVP

- contagem de pessoas;
- ocupação;
- fila;
- presença em zona;
- veículo;
- área vazia;
- objeto em zona;
- porta/portão sob detector homologado;
- EPI em áreas configuradas;
- câmera obstruída/tamper;
- pessoa caída como alerta de possível situação.

## 13.2 Proibido no MVP

- emoção;
- intenção;
- perfil psicológico;
- suspeita baseada em aparência;
- classificação de comportamento individual;
- produtividade individual automática;
- decisão trabalhista;
- reconhecimento facial em massa;
- multa/advertência automática;
- ação física crítica sem política e confirmação adequadas.

## 13.3 Revisão humana

O operador/gestor deve poder:

- confirmar;
- descartar;
- marcar falso positivo;
- modificar severidade;
- atribuir responsável;
- adicionar comentário;
- abrir ocorrência;
- gerar tarefa;
- escalar;
- concluir;
- registrar efeito.

O feedback humano serve para calibrar regra, zona, horário e limiar. Não autoriza uso automático de vídeo do cliente para treinamento global sem política específica.

---

# 14. Vision Identity & Access

## 14.1 Princípio

Identity & Access separa três camadas:

```text
Identificação
↓
Decisão de política
↓
Ação física
```

```text
Vision Identity & Access
→ placa, QR, RFID, NFC, BLE, cadastro de visitante, credencial

Maestro / Access Policy Engine
→ valida status, horário, unidade, área, bloqueios, segundo fator e política

Vision Access Control
→ aciona controlador homologado, relé, portão, cancela, catraca ou bicicletário
```

Nenhum detector de identidade deve abrir um acesso sem passar por política de acesso e mecanismos físicos de segurança.

## 14.2 LPR — leitura de placas

### Funcionalidades

- leitura de placa;
- normalização;
- score de confiança;
- cadastro de veículo;
- vínculo com morador, unidade, funcionário, visitante ou fornecedor;
- consulta de política;
- log de entrada/saída;
- câmera/portão de origem;
- bloqueio temporário;
- lista de exceções;
- fila de revisão manual;
- integração com controlador homologado.

### Modos por portão

| Modo | Funcionamento | Uso |
|---|---|---|
| Sugestão | Sistema lê e mostra cadastro; operador decide abrir. | Padrão e piloto. |
| Assistido | Placa + segundo fator válido liberam automaticamente; ausência de segundo fator vai para operador. | Operações maduras. |
| Autônomo | Placa sozinha pode liberar conforme política. | Apenas após validação técnica, operacional e contratual. |

O padrão comercial e técnico é **Sugestão**.

### Regras de liberação

A autorização precisa considerar:

- placa e confiança da leitura;
- cadastro ativo;
- vínculo vigente;
- site/portão permitido;
- horário;
- status de bloqueio;
- credencial adicional, quando exigida;
- disponibilidade do controlador;
- sensores/intertravamentos físicos;
- modo de acesso configurado.

### Dados de acesso

```text
vehicle_id
plate_normalized
vehicle_type
credential_type
person_or_unit_reference
site_id
gate_id
camera_id
detected_at
decision
decision_reason
confidence
operator_id
controller_response
access_event_status
```

## 14.3 Motos

- usar leitura de placa quando a câmera e ângulo forem adequados;
- permitir RFID/UHF como segundo fator;
- permitir QR/NFC/BLE quando aplicável;
- cadastrar veículo e tipo `motorcycle`;
- usar política própria por portão.

## 14.4 Bicicletas

Não usar imagem como identidade primária.

Usar:

- RFID adesivo;
- QR Code permanente;
- NFC;
- BLE;
- cartão/chaveiro;
- credencial móvel.

A câmera pode registrar contexto visual, mas a decisão de acesso deve vir da credencial.

## 14.5 Visitantes e prestadores

Permitir:

- pré-cadastro;
- QR temporário;
- lista de autorização;
- validade de janela;
- veículo vinculado;
- acompanhante;
- logs de entrada/saída;
- revisão de portaria;
- regras por torre, unidade, horário e tipo de acesso.

## 14.6 Busca de pessoa autorizada — Enterprise

Esse recurso deve ser tratado como busca delimitada e autorizada, não rastreamento aberto.

### Escopo de uso inicial

Permitido apenas para cenários de segurança/emergência em:

- condomínios;
- indústria;
- hotel;
- clínica/hospital;
- ambientes corporativos autorizados.

**Escolas ficam fora da oferta inicial.**

### Requisitos

- pessoa cadastrada e autorizada;
- finalidade registrada;
- justificativa obrigatória;
- usuário com permissão especial;
- escopo por site, câmera, zona e período;
- resultados com confiança e evidência;
- revisão humana;
- log imutável de busca;
- expiração de resultado;
- regras de retenção;
- revisão de privacidade e jurídico antes de go-live.

### Proibido

- busca sem justificativa;
- monitoramento contínuo;
- tracking oculto;
- uso disciplinar;
- uso em escolas na primeira fase;
- decisão automática baseada em match;
- uso de template facial fora da finalidade aprovada.

## 14.7 Pet Zone Compliance

### Objetivo

Detectar possível presença de pet acompanhado de pessoa em área configurada como proibida ou restrita.

### Regra de produto

```text
Pessoa + pet detectados
+
Zona restrita
+
Regra e horário válidos
=
Evento provável para revisão humana
```

### Proteções obrigatórias

- cooldown por câmera/zona;
- agrupamento de eventos correlatos;
- janela de revisão;
- expiração de evento não validado;
- sem multa automática;
- sem advertência automática;
- sem vínculo automático a morador no MVP;
- identificação manual somente por usuário autorizado;
- evidência e comentários;
- política de privacidade por condomínio.

---

# 15. Botão de pânico e incidente bloqueado

## 15.1 Fluxo

```text
Operador aciona pânico
↓
Evento crítico criado
↓
Janela de gravação anterior e posterior é marcada para preservação
↓
Ocorrência é aberta
↓
Política de escalonamento é acionada
↓
Alertas seguem para responsáveis autorizados
↓
Evidência recebe retenção bloqueada
↓
Auditoria reforçada registra ações
```

## 15.2 Requisitos

- acesso apenas para papéis autorizados;
- confirmação para evitar acionamento acidental, salvo modo dedicado de hardware;
- registro da estação, usuário, horário e motivo;
- configuração de janelas pré e pós-evento;
- opcionalidade de integração com webhook/alarme homologado;
- nenhuma chamada automática para serviços públicos sem contrato e integração validada.

---

# 16. Integrações e webhooks

## 16.1 Vision Integration Gateway

O produto deve ter contratos para:

- webhooks de saída;
- webhooks de entrada;
- integrações com alarme;
- controladores de acesso;
- relés;
- cancelas;
- portões;
- catracas;
- sensores;
- sistema de visitantes;
- central de monitoramento;
- ERP/gestão de manutenção;
- MQTT opcional;
- APIs corporativas.

## 16.2 Requisitos de integração física

- adaptador por fabricante/controlador;
- credenciais protegidas;
- timeout;
- retry idempotente;
- resposta auditável;
- modo manual disponível;
- fail-safe/fail-secure definido por equipamento e política;
- teste em ambiente controlado;
- não acionar hardware físico sem validação de segurança;
- logs de comando, resposta e exceção.

## 16.3 Webhooks de saída

Exemplos:

```text
vision.event.detected
vision.incident.created
vision.incident.resolved
vision.access.requested
vision.access.granted
vision.access.denied
vision.panic.activated
vision.camera.offline
vision.storage.critical
vision.evidence.exported
```

Cada webhook deve ter:

- assinatura;
- idempotency key;
- retry;
- status de entrega;
- log de payload;
- possibilidade de reprocessamento autorizado.

---

# 17. Integração com ZappFlow OS

## 17.1 Maestro

O Maestro recebe eventos Vision e aplica regras determinísticas:

- registrar;
- alertar;
- criar incidente;
- criar tarefa;
- solicitar aprovação;
- escalar;
- acionar integração;
- informar Diretor Executivo IA;
- enviar correlação ao RIC.

LLM pode resumir contexto e sugerir plano. Não deve substituir regra crítica de prioridade ou controle físico.

## 17.2 Copiloto interno

No MVP, usar preferencialmente:

- PWA;
- Console de Portaria;
- notificações internas.

WhatsApp interno pode entrar em fase posterior, isolado do atendimento a clientes e com política própria.

Exemplo:

```text
Evento Vision: fila acima do limite na recepção.
Ação: abrir ponto adicional de atendimento.
Responsável: equipe da recepção.
Prazo: imediato.
[Assumir] [Solicitar apoio] [Registrar impedimento]
```

## 17.3 Execution Intelligence

Um evento pode criar tarefa com:

- objetivo;
- câmera/zona;
- prioridade;
- prazo;
- responsável;
- checklist;
- evidência;
- recursos;
- escalonamento;
- critério de conclusão;
- resultado.

## 17.4 Diretor Executivo IA

Deve consumir eventos estruturados, não vídeo bruto por padrão.

Perguntas suportadas:

- quais unidades tiveram mais eventos críticos?
- quais câmeras estão offline?
- onde a fila excedeu SLA?
- quais ocorrências continuam abertas?
- qual unidade possui maior risco operacional?
- qual é o tempo médio de resposta?
- quais tarefas geradas por Vision estão atrasadas?
- quais padrões merecem atenção?

## 17.5 RIC

O RIC pode receber correlações operacionais, nunca afirmar causalidade financeira sem metodologia.

Exemplo correto:

> Filas acima do limiar coincidiram com aumento de abandono no período analisado. Há risco operacional e potencial impacto comercial sob análise.

---

# 18. Modelo de degradação e contingência

| Situação | Comportamento obrigatório |
|---|---|
| Internet indisponível | Live view local, gravação e eventos continuam; outbox acumula sincronização. |
| Cloud indisponível | Edge continua; informações sincronizam quando serviço retorna. |
| Edge offline | Core registra perda de heartbeat; alerta e escalonamento são disparados. |
| Storage baixo | Alertar; preservar incidentes; limpar somente conteúdo expirado e permitido. |
| Storage crítico | Bloquear novas políticas que excedam capacidade; notificar administrador. |
| Storage cheio | Aplicar política explícita e auditada; nunca apagar evidência bloqueada; registrar impacto de gravação. |
| GPU/inferência falhou | Gravação continua; IA visual fica degradada; criar evento técnico e alertar. |
| Camera offline | Evento, tarefa de manutenção e escalonamento conforme SLA. |
| Clock drift | Marcar inconsistência, alertar e impedir uso silencioso para evidência crítica. |
| Codec incompatível | Tentar perfil homologado; caso falhe, marcar incompatível e não declarar proteção ativa. |
| Sync falhou | Retry idempotente, logs, limite de tentativas e alerta. |
| Controlador de acesso indisponível | Não abrir automaticamente; encaminhar para modo manual/portaria. |
| Detector com alta taxa de falso positivo | Reduzir/pausar automação configurada e solicitar revisão de regra. |

---

# 19. Modelo de dados

> Ajustar nomes ao padrão do codebase. Todas as entidades devem conter tenant/site, timestamps, auditoria e controles de escopo.

## 19.1 Núcleo Vision

```text
vision_sites
vision_gateways
vision_devices
vision_cameras
vision_stream_credentials
vision_recording_policies
vision_retention_policies
vision_recording_segments
vision_storage_volumes
vision_zones
vision_detector_profiles
vision_rules
vision_events
vision_event_reviews
vision_incidents
vision_evidence
vision_access_logs
vision_sync_outbox
vision_sync_inbox
vision_station_layouts
vision_webhook_deliveries
```

## 19.2 Identity & Access

```text
vision_identities
vision_identity_templates
vision_identity_search_requests
vision_identity_match_candidates

vision_vehicles
vision_vehicle_credentials
vision_vehicle_access_events
vision_access_policies
vision_access_points
vision_access_controller_commands

vision_visitors
vision_visitor_passes

vision_pets
vision_pet_zone_events
vision_policy_violations
```

## 19.3 Campos adicionais essenciais

### `vision_events`

```text
id
tenant_id
site_id
gateway_id
camera_id
zone_id
rule_id
event_type
severity
confidence
status
detected_at
started_at
ended_at
correlation_key
payload_json
created_at
updated_at
```

### `vision_evidence`

```text
id
tenant_id
site_id
event_id
incident_id
camera_id
evidence_type
local_path_ref
cloud_path_ref
sha256
signature_ref
created_at
created_by
retention_until
legal_hold
export_count
```

### `vision_vehicle_access_events`

```text
id
tenant_id
site_id
access_point_id
vehicle_id
plate_normalized
vehicle_type
credential_type
camera_id
detected_at
confidence
decision
decision_reason
policy_id
operator_id
controller_command_id
status
created_at
```

### `vision_pet_zone_events`

```text
id
tenant_id
site_id
camera_id
zone_id
event_id
pet_event_group_id
cooldown_seconds
review_due_at
expires_at
status
manual_identity_linked_by
created_at
updated_at
```

### `vision_identity_search_requests`

```text
id
tenant_id
site_id
requested_by
purpose
justification
identity_id
scope_json
started_at
ended_at
status
reviewed_by
expires_at
created_at
```

---

# 20. Permissões e RBAC

## 20.1 Papéis

| Papel | Capacidades |
|---|---|
| Vision Admin | Dispositivos, usuários, políticas, retenção, zonas, regras, integrações e exportação avançada. |
| Security Operator | Live view, playback, eventos, incidentes, pânico e revisão dentro do escopo. |
| Operations Manager | Eventos operacionais, tarefas, relatórios, dashboards e correlações. |
| Portaria Operator | Console de portaria, visualização permitida, LPR em modo sugestão e fluxo manual. |
| Access Controller | Aprova/recusa solicitações de acesso conforme política. |
| Evidence Auditor | Consulta evidências e logs em escopo autorizado. |
| Unit Manager | Visão e indicadores restritos à unidade. |
| Administradora Master | Visão consolidada de condomínios/unidades permitidas. |
| Support Técnico | Acesso temporário, explícito e auditado para diagnóstico. |
| Identity Search Officer | Permissão excepcional para busca de pessoa autorizada. |

## 20.2 Regras

- live view, playback e exportação são permissões distintas;
- acesso por tenant, site, bloco/torre e área;
- exportação pode exigir justificativa;
- busca de pessoa exige motivo, escopo e log;
- acesso técnico externo tem expiração;
- credenciais de câmera jamais são entregues ao frontend;
- ações físicas exigem papel, política e log.

---

# 21. Privacidade, segurança e governança

## 21.1 Princípios

- finalidade explícita;
- minimização;
- menor privilégio;
- retenção mínima;
- processamento local por padrão;
- transparência de regras;
- revisão humana;
- auditoria;
- controle de exportação;
- isolamento por tenant/site;
- uso proporcional ao risco.

## 21.2 Áreas proibidas

Não permitir monitoramento em:

- banheiros;
- vestiários;
- áreas íntimas;
- áreas de descanso incompatíveis com política;
- locais cuja captação seja proibida ou inadequada.

## 21.3 Avaliação de privacidade

Antes de ativar Identity & Access ou busca de pessoa, o cliente deve passar por avaliação de privacidade, segurança e jurídico aplicável.

| Recurso | Potencial de identificar pessoa | Sensibilidade de uso | Exigência mínima |
|---|---:|---:|---|
| LPR de morador/funcionário | Alta | Média | Política, retenção, acesso e auditoria. |
| LPR de visitante | Alta | Média | Aviso, retenção, acessos controlados. |
| RFID/QR/NFC/BLE | Alta | Média | RBAC, logs e expiração de credencial. |
| Pet em zona | Média | Média | Revisão humana, expiração e sem punição automática. |
| Busca de pessoa autorizada | Muito alta | Alta | Avaliação específica, justificativa, acesso restrito e logs reforçados. |

## 21.4 Uso proibido

- vigilância secreta;
- rastreamento sem finalidade;
- decisões de emprego apenas por IA;
- multas ou advertências automáticas;
- uso de busca de pessoa fora do fluxo de autorização;
- compartilhamento de evidência sem controle;
- exposição pública de streams;
- combinação de dados para perfilamento indevido.

---

# 22. APIs e eventos de domínio

## 22.1 Endpoints indicativos

```text
GET    /api/vision/sites
POST   /api/vision/sites

GET    /api/vision/gateways
POST   /api/vision/gateways/register
GET    /api/vision/gateways/:id/health

GET    /api/vision/devices
POST   /api/vision/devices/discover
POST   /api/vision/devices
POST   /api/vision/devices/:id/test

GET    /api/vision/cameras
POST   /api/vision/cameras
PATCH  /api/vision/cameras/:id
GET    /api/vision/cameras/:id/live
GET    /api/vision/cameras/:id/playback

GET    /api/vision/zones
POST   /api/vision/zones
GET    /api/vision/rules
POST   /api/vision/rules
PATCH  /api/vision/rules/:id

GET    /api/vision/events
GET    /api/vision/events/:id
POST   /api/vision/events/:id/review
POST   /api/vision/events/:id/actions

GET    /api/vision/incidents
POST   /api/vision/incidents
PATCH  /api/vision/incidents/:id

POST   /api/vision/panic

GET    /api/vision/evidence
POST   /api/vision/evidence/export

GET    /api/vision/access-points
POST   /api/vision/access-points
GET    /api/vision/vehicles
POST   /api/vision/vehicles
POST   /api/vision/access/decide
POST   /api/vision/access/command

POST   /api/vision/identity-search/requests
GET    /api/vision/identity-search/requests/:id

GET    /api/vision/storage
GET    /api/vision/health
POST   /api/vision/webhooks
```

## 22.2 Eventos de domínio

```text
vision.gateway.online
vision.gateway.offline
vision.device.discovered
vision.device.compatibility_classified
vision.camera.online
vision.camera.offline
vision.stream.unavailable
vision.recording.started
vision.recording.gap_detected
vision.storage.low
vision.storage.critical
vision.clock_drift.detected
vision.zone.created
vision.rule.triggered
vision.event.detected
vision.event.reviewed
vision.event.false_positive
vision.event.escalated
vision.incident.created
vision.incident.resolved
vision.evidence.created
vision.evidence.exported
vision.panic.activated
vision.task.created_from_event
vision.task.completed_from_event
vision.access.requested
vision.access.granted
vision.access.denied
vision.controller.command_sent
vision.controller.command_failed
vision.pet_zone.detected
vision.pet_zone.expired
vision.identity_search.requested
vision.identity_search.completed
vision.sync.completed
vision.sync.failed
```

Todo evento deve conter:

```text
event_id
tenant_id
site_id
gateway_id
entity_type
entity_id
occurred_at
idempotency_key
schema_version
payload
```

---

# 23. Sincronização Edge ↔ Cloud

## 23.1 Princípio

Não sincronizar vídeo contínuo ou banco de vídeo integralmente de maneira bidirecional.

Usar:

- outbox local;
- inbox/cloud;
- idempotency key;
- versão de schema;
- retries;
- log de entrega;
- observabilidade;
- resolução explícita de conflito.

## 23.2 Sincronizar por padrão

- status de gateway;
- status de câmera;
- inventário;
- configuração;
- eventos;
- incidentes;
- tarefas;
- métricas;
- logs;
- metadados de evidência;
- relatórios;
- comandos e respostas de controladores.

## 23.3 Não sincronizar por padrão

- vídeo contínuo;
- credenciais de stream;
- áreas mascaradas;
- gravação sem evento;
- dados além do necessário para gestão central.

---

# 24. UX/UI

## 24.1 Telas

1. Vision Command Center;
2. Operator Console;
3. Live Wall;
4. Playback & Evidence;
5. Device Inventory;
6. Camera Detail;
7. Gateway Health;
8. Zone & Rules Builder;
9. Event Inbox;
10. Incident Detail;
11. Evidence Export;
12. Access Control Console;
13. Vehicle Registry;
14. Visitor Passes;
15. Pet Zone Review;
16. Identity Search Request;
17. Multi-Condominium Dashboard;
18. Edge Console;
19. Demo Kit.

## 24.2 Diretrizes visuais

- fundo escuro e contraste alto;
- alertas críticos claros sem poluição;
- vídeo como evidência, não como único centro da experiência;
- ação sempre visível;
- pouca interação para portaria;
- acessibilidade por teclado;
- feedback de estado e carregamento;
- prevenção de erro;
- logs e justificativas em ações sensíveis.

---

# 25. Painel Multi-Condomínio / Administradora

## 25.1 Objetivo

Permitir que administradoras autorizadas acompanhem vários condomínios sem quebrar isolamento de dados.

## 25.2 Indicadores

- câmeras offline;
- gateways degradados;
- eventos críticos;
- incidentes abertos;
- portões/cancelas em erro;
- acessos negados;
- storage crítico;
- tarefas atrasadas;
- pet zone events pendentes;
- SLA de resposta;
- condomínios com maior risco.

O acesso deve ser explicitamente atribuído e auditado por condomínio.

---

# 26. Demo Kit offline

## 26.1 Objetivo

Permitir demonstração, treinamento e QA sem depender da rede do cliente.

## 26.2 Componentes

```text
ZappFlow Vision Demo Kit
├── Vision Edge local
├── duas ou mais fontes de vídeo simuladas
├── datasets de teste autorizados
├── live wall
├── eventos simulados
├── console de portaria
├── painel de síndico
├── LPR simulado
└── operação offline
```

O Demo Kit não deve compartilhar dados reais de clientes.

---

# 27. Fases e sprints

## Fase 0 — Reconciliação e laboratório

Entregas:

- matriz PRD × codebase;
- ADRs;
- decisão do Edge runtime;
- decisão de media pipeline;
- avaliação de licenças;
- threat model;
- modelo de dados;
- feature flags;
- laboratório com câmeras homologadas;
- testes de stream, live view, gravação, playback e health;
- perfil de hardware inicial;
- plano de não regressão.

## Fase 1 — Vision VMS Core

- sites, gateways, dispositivos e câmeras;
- RBAC Vision;
- Edge registration e heartbeat;
- inventário;
- live view;
- mosaico;
- health;
- gravação local;
- playback;
- retenção;
- evidência básica;
- logs de acesso.

## Fase 2 — Eventos, ocorrências e pânico

- zonas;
- regras;
- Event Inbox;
- incidentes;
- botão de pânico;
- preservação de evidências;
- tarefas;
- Copiloto em PWA;
- webhooks de saída;
- console de portaria.

## Fase 3 — Vision AI operacional

- ocupação;
- fila;
- presença em zona;
- veículo;
- EPI;
- detector de objeto/área;
- revisão humana;
- score de confiança;
- playbooks;
- modo degradado de IA.

## Fase 4 — Identity & Access

- LPR;
- veículos;
- políticas de acesso;
- modo Sugestão;
- modo Assistido;
- controladores homologados;
- motos;
- bicicletas por credencial;
- visitantes;
- pet zone compliance.

## Fase 5 — Inteligência corporativa

- dashboards multiunidade;
- Diretor Executivo IA;
- RIC correlacional;
- painel multi-condomínio;
- relatórios;
- métricas de resposta;
- Demo Kit.

## Fase 6 — Enterprise governado

- busca de pessoa autorizada;
- revisão de privacidade;
- auditoria reforçada;
- SSO;
- APIs enterprise;
- PTZ;
- alta disponibilidade;
- integrações complexas.

---

# 28. Critérios de aceite

## 28.1 Core

- [ ] conectar câmera homologada;
- [ ] cadastrar câmera manualmente;
- [ ] classificar compatibilidade;
- [ ] live view individual;
- [ ] mosaico;
- [ ] armazenamento e retenção;
- [ ] playback por data/hora;
- [ ] clipe de evidência;
- [ ] hash e logs;
- [ ] health de câmera/gateway;
- [ ] modo local sem internet.

## 28.2 Eventos

- [ ] evento de câmera offline;
- [ ] Event Inbox;
- [ ] revisão humana;
- [ ] incidente;
- [ ] tarefa;
- [ ] escalonamento;
- [ ] pânico com preservação;
- [ ] webhooks com retry e log.

## 28.3 IA visual

- [ ] detector ativo apenas em zona/regra configurada;
- [ ] confiança registrada;
- [ ] falso positivo;
- [ ] nenhuma sanção automática;
- [ ] modo degradado de inferência visível.

## 28.4 Acesso

- [ ] veículo cadastrado;
- [ ] evento LPR registrado;
- [ ] modo Sugestão;
- [ ] política bloqueia acesso inválido;
- [ ] controlador só recebe comando autorizado;
- [ ] comando é auditado;
- [ ] bicicleta por credencial;
- [ ] pet zone sem multa automática.

## 28.5 Segurança

- [ ] tenant/site obrigatório em toda rota;
- [ ] credenciais não aparecem no frontend;
- [ ] live view/playback/export com permissões distintas;
- [ ] logs de vídeo e exportação;
- [ ] Edge não expõe câmera à internet;
- [ ] testes de isolamento multiempresa.

---

# 29. Testes obrigatórios

## Unitários

- regras;
- severidade;
- retenção;
- idempotência;
- criação de incidente;
- criação de tarefa;
- RBAC;
- hash;
- outbox;
- sync;
- permissões de exportação;
- decisão de acesso;
- cooldown de pet;
- expiração de evento.

## Integração

- câmera online/offline;
- live view;
- recording;
- playback;
- evento → tarefa;
- evento → incidente;
- pânico → preservação;
- LPR → política → decisão;
- Edge offline → outbox;
- Edge online → sync;
- storage crítico;
- inference off;
- controlador indisponível.

## E2E

- onboarding de câmera;
- mosaico;
- portaria;
- evidência;
- exportação;
- operador sem permissão;
- administrador;
- site isolation;
- fluxo LPR sugestão;
- revisão de pet;
- modo local sem internet;
- retomada pós-sync.

## Hardware-in-the-loop

- câmera baixa luz;
- stream principal/substream;
- NVR como fonte;
- DVR/encoder;
- rede instável;
- reboot Edge;
- storage sob pressão;
- clock drift;
- operação multi-monitor;
- controlador de porta/cancela homologado.

---

# 30. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Escopo de VMS muito grande | Fasear Core → eventos → IA → Access → Enterprise. |
| Core monolítico afetado por vídeo | Edge separado e contratos isolados. |
| Equipamento incompatível | Diagnóstico, classificação e piloto antes de corte. |
| Licença inadequada | ADR de media pipeline antes de adoção. |
| Storage insuficiente | Calculadora, políticas, alertas e bloqueio de incidente. |
| Falso positivo | Revisão humana, cooldown, ajuste de regra e playbook. |
| Privacidade | Mascaramento, RBAC, logs, retenção, avaliação específica. |
| Placa clonada/erro LPR | Modo Sugestão padrão e segundo fator no Assistido. |
| Falha física de cancela | Modo manual, controlador homologado e fail-safe definido. |
| Dependência de nuvem | Edge local e outbox. |
| Falha de IA | Gravação continua; IA degrada visivelmente. |
| Regressão do ZappFlow | Flags, rollout, testes e serviços separados. |
| Uso inadequado de busca de pessoa | Recurso Enterprise com escopo, justificativa, auditoria e exclusões. |
| Cliente manter dois VMS para sempre | Plano de migração, aceite técnico, contingência curta e desligamento controlado. |

---

# 31. Migração de VMS legado

## 31.1 Fase 1 — Diagnóstico

- inventário;
- protocolos;
- streams;
- rede;
- armazenamento;
- iluminação;
- política de retenção;
- software atual;
- operadores;
- casos prioritários;
- classificação de ativos.

## 31.2 Fase 2 — Piloto paralelo

- 3 a 10 câmeras;
- Edge instalado;
- live view;
- gravação;
- playback;
- Event Inbox;
- treinamento;
- medição de estabilidade;
- correção de gaps.

## 31.3 Fase 3 — Cutover

- ativação por lotes;
- migração de operadores;
- teste de contingência;
- software antigo como fallback por período definido;
- aceite operacional.

## 31.4 Fase 4 — Desativação do legado

- confirmar cobertura;
- confirmar retenção;
- confirmar exportação;
- confirmar acesso;
- confirmar auditoria;
- cancelar software anterior;
- manter plano de rollback acordado.

---

# 32. Critério de pronto do primeiro release comercial

O primeiro release comercial estará pronto quando uma unidade-piloto puder:

1. instalar Vision Edge;
2. conectar câmeras homologadas;
3. operar live view e mosaico;
4. gravar localmente;
5. reproduzir gravações;
6. gerar evidência;
7. monitorar saúde;
8. configurar retenção;
9. criar zonas;
10. receber eventos técnicos;
11. abrir e fechar incidentes;
12. disparar pânico;
13. gerar tarefa para responsável;
14. operar localmente sem internet;
15. sincronizar ao retorno;
16. respeitar tenant, site e papel;
17. realizar migração controlada;
18. desligar o software VMS legado após aceite.

---

# 33. Frase final de produto

> **O ZappFlow Vision VMS preserva as câmeras que sua operação já possui e substitui o software de vigilância por uma plataforma que grava, protege evidências, entende eventos relevantes, controla acessos, coordena pessoas e transforma vídeo em ação operacional.**
