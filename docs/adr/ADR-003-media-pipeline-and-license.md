# ADR-003 — Media Pipeline, Licenciamento e Componentes do Vision Edge

**Status:** Aceito (bloqueia adoção de qualquer dependência de mídia até validação final em laboratório)
**Data:** Fase 0

## Contexto

O PRD (§6.4) proíbe adotar qualquer biblioteca de RTSP, WebRTC, HLS, gravação, ONVIF, inferência ou OCR/LPR "por conveniência de protótipo" sem antes avaliar licença, obrigações de distribuição, manutenção e compatibilidade com um produto SaaS comercial fechado, distribuído inclusive como appliance de Edge no site do cliente. Nenhuma dessas dependências existe hoje no `package.json` do projeto — este é 100% território novo.

O risco central: várias das bibliotecas mais populares do ecossistema de CFTV/visão computacional têm licenças **copyleft fortes (AGPL/GPL)** que, dependendo de como são integradas, criam obrigação de abrir o código-fonte do produto ou de conceder a qualquer usuário da rede acesso ao código (cláusula de "network use" da AGPL). Isso é incompatível com um SaaS comercial fechado.

## Alternativas avaliadas por função

### Stream Gateway (RTSP/ONVIF ingest, WebRTC/HLS output, gravação)

| Candidato | Licença | Observação |
|---|---|---|
| **MediaMTX** (ex-rtsp-simple-server) | MIT | Binário Go único, suporta RTSP/RTMP/HLS/WebRTC/SRT ingest e output, gravação nativa em segmentos. Sem contaminação copyleft. |
| **go2rtc** | MIT | Similar ao MediaMTX, popular no ecossistema Home Assistant, bom suporte a WebRTC de baixa latência. |
| **Janus WebRTC Gateway** | GPLv3 | Rejeitado — GPL contaminante para um SFU linkado/distribuído com o produto. |
| **Kurento** | Apache 2.0 | Licença aceitável, mas projeto com manutenção incerta nos últimos anos — não recomendado para MVP. |

**Decisão:** adotar **MediaMTX (MIT)** como Stream Gateway principal do MVP. `go2rtc` fica como alternativa de fallback caso o laboratório encontre limitação específica.

### Transcodificação / processamento de vídeo

| Candidato | Licença | Observação |
|---|---|---|
| **FFmpeg** | LGPL 2.1+ (build padrão) ou GPL (se compilado com `--enable-gpl` + libx264 etc.) | Usar **exclusivamente como processo externo (CLI/subprocess)**, nunca linkado estaticamente (`libavcodec`/`libavformat`) dentro do binário do Vision Edge. Isso evita a maior parte das obrigações de linking da LGPL/GPL, que se aplicam a quem *linka* a biblioteca, não a quem invoca o binário como processo separado. Build sem componentes GPL (evitar `libx264` estático; preferir codecs de hardware ou OpenH264). |
| **GStreamer** | Núcleo LGPL; vários plugins (ex. `x264enc`) GPL | Mesma postura do FFmpeg — só como processo externo, evitando plugins GPL quando a licitude comercial for prioridade. |

**Decisão:** FFmpeg como processo externo (subprocess via `child_process`), build LGPL-only, sem plugins GPL. Nenhuma biblioteca de mídia é linkada estaticamente ao binário do produto.

### Descoberta ONVIF

| Candidato | Licença | Observação |
|---|---|---|
| `onvif` / `node-onvif` (npm) | MIT | Seguro para uso e distribuição. |

**Decisão:** usar bibliotecas ONVIF MIT no Node.

### Inferência visual (contagem, ocupação, fila, veículo, EPI, tamper)

| Candidato | Licença | Observação |
|---|---|---|
| **ONNX Runtime** | MIT (Microsoft) | Motor de inferência universal — modelo-agnóstico, roda CPU ou GPU (CUDA/TensorRT). |
| **OpenCV** | Apache 2.0 | Pré/pós-processamento de imagem. |
| **Ultralytics YOLOv8/v11** | **AGPL-3.0** + licença comercial paga da Ultralytics para uso fechado | **Rejeitado** para o MVP sem avaliação jurídica e sem contrato comercial com a Ultralytics — usar sob AGPL num SaaS fechado é o exato risco que o PRD pede para evitar. |
| **YOLOX** (Megvii) ou arquiteturas de detecção sob **Apache 2.0/BSD** | Apache 2.0 / BSD | Preferido — mesma família de detectores, sem contaminação de licença. |

**Decisão:** motor de inferência = ONNX Runtime (MIT) + modelos de detecção sob licença permissiva (Apache 2.0/BSD), evitando explicitamente Ultralytics YOLO sem contrato comercial prévio.

### OCR/LPR (leitura de placa)

| Candidato | Licença | Observação |
|---|---|---|
| **OpenALPR** | **AGPL-3.0** | **Rejeitado.** É exatamente o risco "Alto" já sinalizado na tabela de privacidade do PRD (§21.3) e no material do cliente. Usar como microserviço isolado não resolve a obrigação de "network use" da AGPL para um produto comercial fechado. |
| **PaddleOCR** | Apache 2.0 | Aceitável para o motor de OCR genérico. |
| **Tesseract** | Apache 2.0 | Alternativa aceitável, menor acurácia em placas de baixa qualidade. |
| **Plate Recognizer (SaaS)** | Comercial (API paga) | Sem risco de licença copyleft — modelo de custo por chamada; avaliar como opção rápida para o piloto Fase 4 antes de treinar modelo próprio. |

**Decisão:** rejeitar OpenALPR. Para o piloto de LPR (Fase 4), avaliar **Plate Recognizer (SaaS pago)** como via rápida de validação comercial, em paralelo à opção de treinar um detector de placa próprio (Apache/MIT) + PaddleOCR/Tesseract para leitura — decisão final de qual das duas vias vira produção fica para o início da Fase 4, com dado real de acurácia em campo.

## Decisão consolidada

1. Nenhuma dependência AGPL/GPL é linkada estaticamente ou distribuída como parte do binário do Vision Edge.
2. Motores de mídia (FFmpeg/GStreamer) são sempre invocados como processo externo.
3. Stream Gateway: MediaMTX (MIT).
4. Inferência: ONNX Runtime (MIT) + modelos sob licença permissiva; Ultralytics YOLO **proibido** sem contrato comercial explícito.
5. LPR: OpenALPR **proibido**; usar SaaS pago (Plate Recognizer) ou stack própria (detector Apache/MIT + PaddleOCR/Tesseract Apache 2.0).
6. Toda nova dependência de mídia/IA proposta depois desta ADR deve passar por atualização deste documento antes de entrar no `package.json`/requirements do vision-edge.

## Riscos

- **Alto** se um desenvolvedor futuro adicionar Ultralytics YOLO ou OpenALPR "porque é o mais fácil de achar tutorial" — mitigar com checklist de PR/CI que bloqueia dependências não pré-aprovadas nesta ADR.
- **Médio**: MediaMTX/go2rtc são mantidos por comunidade (não corporativos) — mitigar fixando versões, avaliando fork próprio se o projeto for abandonado.
- **Médio**: custo de SaaS de LPR (Plate Recognizer) escala com volume — reavaliar custo-benefício assim que houver dado real de uso no piloto.

## Custo

Baixo em licenciamento direto (a maioria das escolhas é gratuita/MIT/Apache); custo variável apenas se o SaaS de LPR for adotado, ou se for necessário compra de licença comercial da Ultralytics (não recomendado nesta fase).

## Segurança

Isolar motores de mídia como processos externos também limita o raio de explosão de uma vulnerabilidade de parsing de vídeo malicioso (ex.: um exploit em decodificador de codec não compromete o processo principal do Vision Edge, apenas o subprocess sandboxado).

## Impacto de manutenção

Médio — múltiplos componentes de terceiros para acompanhar (CVEs, atualizações). Recomenda-se um processo trimestral de revisão de dependências de mídia/IA.

## Plano de rollback

Cada componente (Stream Gateway, motor de inferência, LPR) é acessado pelo Vision Edge através de uma interface interna (contrato), não diretamente — trocar de MediaMTX para go2rtc, ou de um modelo de detecção para outro, não exige mudança na lógica de negócio do Edge, apenas na implementação do adaptador correspondente.
