# Edição de vídeo — operação e prova em produção (ADR-207 F13b)

O que o app faz com vídeo: **cortar e enquadrar** por canal, **cortar pausas**, **legenda automática**, **título e CTA na imagem**, em segundo plano, a partir de um vídeo do Estúdio ou enviado pelo cliente. Tudo roda no próprio servidor com o `ffmpeg`. Sem ele, o app continua de pé e a tela avisa que a edição não está disponível — **nada mais quebra**.

> **Estado da prova (honesto):** tudo foi testado com o `ffmpeg-static` numa máquina de desenvolvimento. **Nunca foi verificado na imagem Docker de produção** nem contra o Whisper real. Este runbook é como verificar isso em 5 minutos, depois do deploy.

## 1. Conferir depois do deploy (nesta ordem)

1. **Smoke test no container** (testa de verdade, com os mesmos serviços do app):
   ```
   docker exec <container-do-core> node dist/video-smoke.cjs
   ```
   Saída `0` = tudo certo · `2` = corte/pausas ok, mas legenda/título/miniatura não · `1` = ffmpeg indisponível ou quebrado. Acrescente `--json` para saída estruturada. Não lê nem altera dado de cliente (gera um clipe sintético numa pasta temporária e a remove). Em desenvolvimento: `npm run smoke:video`.
2. **O que o app enxerga:** `GET /api/studio/video-post/capabilities` (logado). `ffmpeg: true` e `canRenderCaptions: true` esperados. `transcription` depende da chave de IA (item 4).
3. **Uma edição real:** no Estúdio, “Enviar meu vídeo para editar” com um vídeo curto de celular → canal → marcar pausas/título → “Editar vídeo”. Conferir o resultado no celular.

## 2. Se o smoke falhar

| Sintoma (smoke) | Causa provável | O que fazer |
| --- | --- | --- |
| `ffmpeg disponível` ❌ “nem FFMPEG_PATH nem o pacote ffmpeg-static” | O `npm ci` do build não conseguiu baixar o binário do `ffmpeg-static` (GitHub bloqueado/limitado no build). O pacote é **opcional**: o build segue, a imagem sobe **sem** ffmpeg. | (a) Definir `FFMPEG_PATH` apontando para um ffmpeg do sistema (instalar na imagem); ou (b) no build, definir `FFMPEG_BINARIES_URL` para um **espelho** do binário (só vale durante o `npm ci`); ou (c) liberar o acesso do build a github.com. Procure “ffmpeg-static” no log do build. |
| `FFMPEG_PATH aponta para "...", que não executa` | `FFMPEG_PATH` errado. **Ele vence o pacote mesmo errado** (decisão: configuração do operador não é ignorada em silêncio). | Corrigir o caminho ou remover a variável. |
| Legenda ⚠️ “fonte DejaVuSans-Bold.ttf ausente” | A pasta `assets/fonts` não está onde o app roda (procura em `<pasta de execução>/assets/fonts`; no container, `/app`). | Conferir que `assets/` foi para a imagem e o `WORKDIR` é `/app`; ou apontar `SUBTITLE_FONTS_DIR`. |
| Legenda ⚠️ “não tem o filtro de legenda (libass)” | O ffmpeg do sistema (`FFMPEG_PATH`) foi compilado sem libass. | Usar o `ffmpeg-static` ou um build com libass. |
| `pasta de mídia gravável` ❌ | O volume de `DATA_DIR` não é gravável pelo usuário `node` (uid 1000). | `chown 1000:1000` no volume (ver comentário no `Dockerfile`). |

O build local do smoke vai para `dist/video-smoke.cjs` junto do resto (`npm run build`). Não há mudança no `Dockerfile`.

## 3. Variáveis de ambiente

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `FFMPEG_PATH` | Binário do ffmpeg. Ordem: **FFMPEG_PATH → pacote ffmpeg-static → indisponível** | — |
| `FFMPEG_BINARIES_URL` | Espelho para o download do binário **no build** (`npm ci`) — o app em execução não lê | — |
| `FFMPEG_MAX_INPUT_BYTES` / `FFMPEG_MAX_OUTPUT_BYTES` | Limite do arquivo de entrada/saída por edição | 200 MB |
| `FFMPEG_TIMEOUT_MS` | Tempo máximo de uma operação do ffmpeg (depois, mata) | 120000 |
| `FFMPEG_MAX_CONCURRENT` | Processos ffmpeg ao mesmo tempo (também o teto da fila de edições) | 2 |
| `VIDEO_UPLOAD_MAX_BYTES` / `VIDEO_UPLOAD_MAX_SECONDS` | Tamanho e duração máximos do vídeo enviado | 200 MB / 600 s |
| `VIDEO_JOBS_MAX_ACTIVE` | Edições ativas (na fila + rodando) por empresa | 3 |
| `VIDEO_TRANSCRIBE_MAX_PER_DAY` | Transcrições por dia, por empresa (custo de IA) | 20 |
| `STT_PROVIDER` | Provedor de transcrição | OpenAI Whisper |
| `OPENAI_API_KEY` | Sem ela a transcrição (e a legenda) fica indisponível | — |
| `OPENAI_TRANSCRIBE_TIMED_MODEL` / `OPENAI_TRANSCRIBE_MODEL` / `OPENAI_TRANSCRIBE_LANG` | Modelo e idioma da transcrição | whisper-1 / pt |
| `SUBTITLE_FONTS_DIR` | Pasta da fonte da legenda (padrão: `assets/fonts` empacotada) | — |
| `DATA_DIR` | Onde ficam a mídia (`DATA_DIR/media`) e o banco | pasta de execução |

## 4. Limites que existem e não são bug

- **Um processo só.** A fila de edições usa o `JobQueueService` (mesma limitação dele): se o servidor reiniciar no meio, a edição é refeita pelo passe de manutenção (pode levar até ~15 minutos).
- **Upload grande pode ser barrado antes do app** por proxy/CDN (ex.: ~100 MB). O app aceita até 200 MB; o proxy decide o que chega.
- **Sem retenção:** vídeos editados e enviados ficam em `DATA_DIR/media` para sempre; o disco cresce. Acompanhar o espaço. (`video_render_jobs` também só cresce, pouco.)
- **Pastas temporárias** `zf-ffmpeg-*` ficam em `/tmp` se o processo for morto no meio; somem no próximo deploy (o `/tmp` do container é descartável).
- **Transcrição:** só foi testada com cliente simulado; o primeiro uso real do Whisper é o teste de verdade (custo por minuto de áudio).
- **Limiares não calibrados com vídeo real de loja:** pausas (−35 dB, 0,6 s, respiro 0,15 s), tempos de título/CTA (≤3 s).
- **A tela “Editar vídeo” não foi vista num navegador/celular real** por quem a escreveu — conferir aparência.
- Publicar o vídeo editado nas redes **não** é feito por aqui (Instagram/Facebook seguem o fluxo governado de publicação; TikTok/YouTube/LinkedIn/X são manuais — pacote para colar).

## 5. Reversão

Não há nada a reverter: sem ffmpeg ou sem a fonte, as opções correspondentes ficam travadas na tela com o motivo e o resto do app não é afetado. Para desligar vídeo de vez, aponte `FFMPEG_PATH` para um caminho inexistente (o app trata como indisponível).
