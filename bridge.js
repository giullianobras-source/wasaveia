// ============================================
// PONTE WhatsApp (Z-API) + Agente de IA (Gemini)
// ============================================
// Instale as dependências:
//   npm init -y
//   npm install express axios dotenv
// ============================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ---------- CONFIGURAÇÃO (preenchida pelo .env) ----------
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN    = process.env.ZAPI_TOKEN;
const PORT          = process.env.PORT || 3000;

// ---------- FUNÇÃO: chamar o Gemini (Google) ----------
async function gerarResposta(mensagemDoCliente, historico) {
  const API_KEY = process.env.AI_API_KEY;   // sua chave Gemini
  const AI_URL  = process.env.AI_URL;       // endpoint do Gemini

  // Personalidade do agente "Save" — edite aqui o tom e as regras
  const systemPrompt = `
    Você é o "Save", assistente de IA de atendimento ao cliente.
    Seja educado, objetivo e prestativo. Responda em português.
    Regras: [EDITE AQUI as regras do seu negócio]
  `;

  // Monta o histórico no formato do Gemini
  const contents = historico.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  contents.unshift({
    role: 'user',
    parts: [{ text: systemPrompt + '\n\n' + mensagemDoCliente }]
  });

  const resposta = await axios.post(
    AI_URL + '?key=' + API_KEY,
    { contents },
    { headers: { 'Content-Type': 'application/json' } }
  );

  // Extrai o texto da resposta do Gemini
  return resposta.data.candidates[0].content.parts[0].text;
}

// ---------- FUNÇÃO: enviar resposta pelo WhatsApp ----------
async function enviarWhatsApp(numero, texto) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
  await axios.post(url, {
    phone: numero,
    message: texto
  });
}

// ---------- MEMÓRIA simples por cliente (em memória) ----------
const conversas = {}; // { numeroCliente: [ {role, content}, ... ] }

// ---------- WEBHOOK: recebe mensagens do cliente ----------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const msg = body.message || body.data || {};
    const texto = msg.text?.message || msg.text || '';
    const numero = msg.from || msg.phone;

    if (!texto || !numero) return res.sendStatus(200);

    if (!conversas[numero]) conversas[numero] = [];
    conversas[numero].push({ role: 'user', content: texto });

    const resposta = await gerarResposta(texto, conversas[numero]);

    conversas[numero].push({ role: 'assistant', content: resposta });

    await enviarWhatsApp(numero, resposta);

    res.sendStatus(200);
  } catch (erro) {
    console.error('Erro no webhook:', erro.message);
    res.sendStatus(200);
  }
});

// ---------- Health check ----------
app.get('/', (req, res) => res.send('Ponte rodando!'));

app.listen(PORT, () => {
  console.log(`Ponte ativa na porta ${PORT}`);
});