// ============================================
// PONTE WhatsApp Cloud API (Meta) + Agente (Gemini)
// ============================================
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ---------- CONFIGURAÇÃO (do .env) ----------
const PORT = process.env.PORT || 3000;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'Ba96350836??wasaveia_token_2026';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;   // token EAA...
const PHONE_NUMBER_ID   = process.env.PHONE_NUMBER_ID;     // 1197397706799276
const GRAPH_VERSION     = 'v21.0';

// ---------- VERIFICAÇÃO DO WEBHOOK (handshake da Meta) ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('Webhook verificado pela Meta!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---------- FUNÇÃO: chamar o Gemini (o "Save") ----------
async function gerarResposta(mensagemDoCliente, historico) {
  const API_KEY = process.env.AI_API_KEY;
  const AI_URL  = process.env.AI_URL;

  const systemPrompt = `
    Você é o "Save", assistente de IA de atendimento ao cliente.
    Seja educado, objetivo e prestativo. Responda em português.
    Regras: [EDITE AQUI as regras do seu negócio]
  `;

  const contents = historico.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  contents.unshift({ role: 'user', parts: [{ text: systemPrompt + '\n\n' + mensagemDoCliente }] });

  const url = AI_URL + '?key=' + API_KEY;
  console.log('Chamando Gemini em:', url);

  const resposta = await axios.post(url, { contents }, {
    headers: { 'Content-Type': 'application/json' }
  });
  return resposta.data.candidates[0].content.parts[0].text;
}

// ---------- FUNÇÃO: enviar resposta via Graph API (Meta) ----------
async function enviarWhatsApp(numero, texto) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  console.log('Enviando resposta via Meta para', numero);
  await axios.post(url, {
    messaging_product: 'whatsapp',
    to: numero,
    type: 'text',
    text: { body: texto }
  }, {
    headers: {
      'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// ---------- MEMÓRIA simples por cliente ----------
const conversas = {};

// ---------- WEBHOOK: recebe mensagens da Meta ----------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Formato da Meta: entry[0].changes[0].value.messages[0]
    const entry = body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const msg = value?.messages?.[0];

    // Se não for mensagem (status, entrega etc.), confirma e ignora
    if (!msg) return res.sendStatus(200);

    const texto = msg.text?.body || '';
    let numero = msg.from || '';

    console.log('Mensagem recebida de', numero, ':', texto);

    if (!texto || !numero) return res.sendStatus(200);

    if (!conversas[numero]) conversas[numero] = [];
    conversas[numero].push({ role: 'user', content: texto });

    const resposta = await gerarResposta(texto, conversas[numero]);

    conversas[numero].push({ role: 'assistant', content: resposta });

    await enviarWhatsApp(numero, resposta);

    res.sendStatus(200);
  } catch (erro) {
    console.error('Erro no webhook:', erro.message);
    console.error('URL que falhou:', erro.config?.url);
    console.error('Status:', erro.response?.status);
    console.error('Detalhe:', JSON.stringify(erro.response?.data));
    res.sendStatus(200);
  }
});

// ---------- Health check ----------
app.get('/', (req, res) => res.send('Ponte Meta rodando!'));

app.listen(PORT, () => {
  console.log(`Ponte Meta ativa na porta ${PORT}`);
});
