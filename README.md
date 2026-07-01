<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/f421bc6f-5c1a-4640-82b3-0531d4490804

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Operação em produção

O container de produção roda **dois processos Node** (o core/CRM e o Vision Cloud) supervisionados por `scripts/supervisor.ts`, com `tini` como PID 1 real. Decisão completa, comportamento esperado e troubleshooting: [`docs/adr/ADR-008-process-supervisor.md`](docs/adr/ADR-008-process-supervisor.md) (e o adendo "Vision Cloud" em [`docs/adr/ADR-001-vision-edge-runtime.md`](docs/adr/ADR-001-vision-edge-runtime.md) para o contexto do porquê existem dois processos).

Testar a supervisão de processo localmente, sem Docker: `npm run test:supervisor`.
