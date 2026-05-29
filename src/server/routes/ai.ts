import { Router, Request, Response } from "express";
import { chat } from "../llm.js";

const router = Router();

// POST /api/ai/suggest — sugere uma resposta de atendimento (usado no ChatPanel)
router.post("/suggest", async (req: Request, res: Response): Promise<any> => {
  const { contact, history } = req.body || {};
  if (!contact || !Array.isArray(history)) {
    return res.status(400).json({ error: "Payload inválido: contact e history são obrigatórios." });
  }
  try {
    const prompt = `Você é um atendente especialista em atendimento ao cliente via WhatsApp.
Gere UMA sugestão de resposta educada, curta e humanizada.

Nome do Cliente: ${contact.name}
Histórico da conversa:
${history.map((m: any) => `${m.sender}: ${m.text}`).join('\n')}

Responda APENAS com o texto da mensagem que o atendente deve enviar, sem aspas ou comentários.`;
    const text = await chat(prompt, { temperature: 0.5 });
    res.json({ text });
  } catch (e) {
    console.error("[AI Suggest]", e);
    res.status(500).json({ error: "Erro ao gerar sugestão" });
  }
});

// POST /api/ai/summarize — resume a conversa
router.post("/summarize", async (req: Request, res: Response): Promise<any> => {
  const { history } = req.body || {};
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: "Payload inválido: history é obrigatório." });
  }
  if (history.length === 0) return res.json({ text: "A conversa está vazia." });
  try {
    const prompt = `Faça um resumo conciso (em tópicos) desta conversa de atendimento.
Destaque o problema principal e as ações já tomadas.

Histórico:
${history.map((m: any) => `${m.sender}: ${m.text}`).join('\n')}

Resumo em tópicos:`;
    const text = await chat(prompt, { temperature: 0.3 });
    res.json({ text });
  } catch (e) {
    console.error("[AI Summarize]", e);
    res.status(500).json({ error: "Erro ao resumir conversa" });
  }
});

export default router;
