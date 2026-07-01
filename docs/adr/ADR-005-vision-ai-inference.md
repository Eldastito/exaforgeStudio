# ADR-005 — Vision AI Inference

**Status:** Aceito
**Data:** Fase 0

## Contexto

O PRD (§13) restringe rigorosamente o escopo permitido de IA visual no MVP (contagem de pessoas, ocupação, fila, presença em zona, veículo, EPI em área configurada, tamper, pessoa caída como alerta de possível situação) e proíbe explicitamente emoção, intenção, perfil psicológico, produtividade individual e qualquer decisão automática crítica. Toda detecção exige score de confiança, evidência e revisão humana (§13.3); nenhum evento pode gerar punição automática.

O motor de inferência escolhido (ONNX Runtime + modelos sob licença permissiva) foi definido no ADR-003. Esta ADR trata da arquitetura de execução da inferência, não da escolha de biblioteca/licença.

## Decisão

1. **Toda inferência roda no Edge, nunca na nuvem.** Consistente com o princípio "processamento local por padrão" (PRD §6.3/§21.1) — vídeo bruto nunca sai do site do cliente para fins de inferência.
2. **Detectores só rodam dentro de zona + regra + horário configurados.** Nunca em modo "analisar tudo, todas as câmeras, todos os frames, resolução máxima" — isso é um não-objetivo explícito do PRD (§4) e também controla custo de CPU/GPU no Edge.
3. **Todo evento gerado carrega `confidence` e vínculo com evidência**, alimentando a máquina de estados já modelada no PRD (§12.3: `detected → queued_for_review → acknowledged → ... → resolved/false_positive/expired`). Nenhum evento se autorresolve sem ação humana **ou** um `expires_at` explícito (ex.: eventos de pet zone que expiram se não revisados).
4. **Modo degradado é um requisito de arquitetura, não um "nice to have".** A inferência roda como processo/sidecar separado do Recording Service (reforçando a separação de processos do ADR-001): se o sidecar de inferência travar, ficar sem GPU, ou explodir por exceção, a gravação continua intacta e ininterrupta. O Event Processor emite um evento técnico (`inference_degraded`, análogo aos eventos de saúde já listados no PRD §12.2) e o Device Health reflete isso visivelmente na UI — nunca falhar silenciosamente fingindo que a IA está ativa.
5. **Nenhum aprendizado contínuo automático com vídeo de cliente.** O feedback humano (confirmar/marcar falso positivo) serve só para calibrar regra, zona, horário e limiar **daquele tenant** — não para treinar um modelo global, replicando a restrição explícita do PRD §13.3. Qualquer futura oferta de "treinar modelo com meus dados" exigiria um opt-in explícito e contrato específico, fora do escopo desta ADR.
6. **Ordem de introdução de detectores** segue o faseamento do PRD (Fase 2 = eventos técnicos sem IA; Fase 3 = primeiros detectores de IA, começando pelos de menor ambiguidade — contagem/ocupação/fila/veículo — antes de EPI e "pessoa caída", que têm maior taxa esperada de falso positivo e maior sensibilidade).

## Licenças

Ver ADR-003 (ONNX Runtime MIT + modelos sob licença permissiva; Ultralytics YOLO e OpenALPR explicitamente rejeitados).

## Riscos

- **Alto**: falso positivo em detectores sensíveis (`person_down_suspected`, `ppe_missing`) pode gerar alarme desnecessário ou, pior, falsa sensação de segurança se o operador passar a ignorar alertas ("alert fatigue"). Mitigação: cooldown, revisão humana obrigatória, e telemetria de taxa de falso positivo por detector/zona alimentando ajuste de limiar (conforme degradação do PRD §18: "Detector com alta taxa de falso positivo → reduzir/pausar automação e solicitar revisão de regra").
- **Alto**: custo de GPU não dimensionado corretamente pode inviabilizar o perfil Edge S/M comercialmente. Mitigação: medir custo real por detector/câmera no laboratório da Fase 0/3 antes de precificar o pacote "Vision Intelligence".
- **Médio**: dependência de qualidade de câmera/iluminação para acurácia dos detectores — não é responsabilidade do software resolver; deve ser coberto pelo diagnóstico de compatibilidade (PRD §7).

## Custo

Variável conforme perfil de hardware (Edge S = CPU-only viável para poucos detectores leves; Edge M/L = GPU recomendada). A ser medido no laboratório, não estimado a priori.

## Segurança

Isolar o sidecar de inferência do Recording Service limita o impacto de uma eventual vulnerabilidade no motor de IA (ex.: um modelo malicioso ou um bug de parsing de tensor) — ele não tem acesso direto ao armazenamento de vídeo bruto além do necessário para ler o frame que está processando.

## Impacto de manutenção

Médio-alto no longo prazo — modelos de IA exigem reavaliação periódica de acurácia e podem precisar de reentreinamento por vertical (condomínio vs. indústria têm cenários visuais muito diferentes). Não estimar isso como custo zero ao planejar Fase 3 em diante.

## Plano de rollback

A inferência é inteiramente controlada pela feature flag `vision_ai`. Desligá-la não afeta gravação, playback, live view ou eventos técnicos (câmera offline, storage etc.), que são independentes da IA visual.
