// bridge-meta.js - Versão melhorada com memória por cliente, saudação e persistência
const express = require('express');
const axios = require('axios');
const { createClient } = require('redis'); // Redis/Upstash para persistência

const app = express();
app.use(express.json());

// ===== CONFIGURAÇÃO =====
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'wasaveia_token_2026';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN; // Token permanente
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1197397706799276';
const AI_URL = process.env.AI_URL; // URL do Gemini
const AI_API_KEY = process.env.AI_API_KEY;

// Saudação fixa para primeiro contato
const WELCOME_MESSAGE = 'Olá! Sou o Save, como posso ajudar?';

// TTL do histórico: 24h (um dia de conversa por cliente)
const SESSION_TTL_SECONDS = 24 * 60 * 60;

// ===== CLIENTE REDIS (Upstash) =====
// Crie um banco Redis grátis em https://upstash.com e cole a URL na variável REDIS_URL
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('Redis error:', err.message));
redis.connect().then(() => console.log('Redis conectado ✅')).catch((e) => console.error('Falha ao conectar Redis:', e.message));

// ===== HELPERS =====

// Busca o histórico do dia de um cliente
async function getHistory(phone) {
  try {
    const data = await redis.get(`hist:${phone}`);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.error('Erro ao ler histórico:', e.message);
    return [];
  }
}

// Salva o histórico do dia de um cliente (com TTL de 24h)
async function saveHistory(phone, history) {
  try {
    await redis.set(`hist:${phone}`, JSON.stringify(history), { EX: SESSION_TTL_SECONDS });
  } catch (e) {
    console.error('Erro ao salvar histórico:', e.message);
  }
}

// Verifica se é o primeiro contato do dia
async function isFirstContact(phone) {
  const exists = await redis.exists(`hist:${phone}`);
  return exists === 0;
}

// Envia mensagem via Graph API da Meta
async function sendWhatsApp(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  };
  const res = await axios.post(url, payload, {
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

// Chama o Gemini (o "Save")
async function callGemini(history) {
  const res = await axios.post(`${AI_URL}?key=${AI_API_KEY}`, {
    contents: history
  });
  return res.data.candidates[0].content.parts[0].text;
}

// ===== WEBHOOK - Verificação (GET) =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado pela Meta!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ===== WEBHOOK - Recebimento de mensagens (POST) =====
app.post('/webhook', async (req, res) => {
  // Responde 200 imediatamente para a Meta não reenviar
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const phone = message.from; // número do cliente
    const text = message.text.body;
    console.log(`Mensagem recebida de ${phone}: ${text}`);

    // --- 1. Primeiro contato do dia: envia saudação fixa ---
    const firstContact = await isFirstContact(phone);
    if (firstContact) {
      await sendWhatsApp(phone, WELCOME_MESSAGE);
      console.log(`Saudação enviada para ${phone}`);
    }

    // --- 2. Monta o histórico do dia (com a nova mensagem) ---
    const history = await getHistory(phone);
    history.push({ role: 'user', parts: [{ text }] });

    // --- 3. Chama o Gemini com TODO o histórico do dia ---
    const reply = await callGemini(history);
    console.log(`Resposta do Gemini para ${phone}: ${reply}`);

    // --- 4. Envia a resposta e salva no histórico ---
    await sendWhatsApp(phone, reply);
    history.push({ role: 'model', parts: [{ text: reply }] });
    await saveHistory(phone, history);

  } catch (err) {
    console.error('Erro no webhook:', err.message);
    console.error('Status:', err.response?.status);
    console.error('Detalhe:', err.response?.data?.error?.message);
  }
});

// ===== INICIALIZAÇÃO =====
app.listen(PORT, () => {
  console.log(`Ponte Meta ativa na porta ${PORT}`);
});