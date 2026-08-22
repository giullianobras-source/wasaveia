// bridge-meta.js - Versão com memória, saudação e integração WooCommerce via endpoint próprio (Opção B)
const express = require('express');
const axios = require('axios');
const { Redis } = require('@upstash/redis'); // Upstash Redis via REST/HTTPS

const app = express();
app.use(express.json());

// ===== CONFIGURAÇÃO =====
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'wasaveia_token_2026';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN; // Token permanente
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1197397706799276';
const AI_URL = process.env.AI_URL; // URL do Gemini
const AI_API_KEY = process.env.AI_API_KEY;

// WooCommerce (Opção B - endpoint próprio no WordPress)
const WOO_URL = process.env.WOO_URL;                 // https://savemax.com.br (sem barra no final)
const WOO_CONSUMER_KEY = process.env.WOO_CONSUMER_KEY; // AGORA guarda o token do endpoint (X-Save-Token)

// Saudação fixa para primeiro contato
const WELCOME_MESSAGE = 'Olá! Sou o Save, como posso ajudar?';

// TTL do histórico: 24h (um dia de conversa por cliente)
const SESSION_TTL_SECONDS = 24 * 60 * 60;

// ===== CLIENTE REDIS (Upstash - via REST/HTTPS) =====
const redis = new Redis({
  url: process.env.REDIS_URL,     // URL REST https://... do Upstash
  token: process.env.REDIS_TOKEN  // Token REST do Upstash
});

// ===== HELPERS =====

// Busca o histórico do dia de um cliente
async function getHistory(phone) {
  try {
    const data = await redis.get(`hist:${phone}`);
    return data ? data : []; // o Upstash já devolve o objeto pronto (sem JSON.parse)
  } catch (e) {
    console.error('Erro ao ler histórico:', e.message);
    return [];
  }
}

// Salva o histórico do dia de um cliente (com TTL de 24h)
async function saveHistory(phone, history) {
  try {
    await redis.set(`hist:${phone}`, JSON.stringify(history), { ex: SESSION_TTL_SECONDS });
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

// ===== WOOCOMMERCE (Opção B - endpoint próprio, compatível com HPOS) =====

// Busca os pedidos do cliente pelo e-mail no endpoint próprio do WordPress
async function getWooOrdersByEmail(email) {
  try {
    if (!WOO_URL || !WOO_CONSUMER_KEY) {
      console.error('WooCommerce não configurado (faltam variáveis WOO_*)');
      return null;
    }

    const url = `${WOO_URL}/wp-json/save/v1/orders?email=${encodeURIComponent(email)}`;
    const res = await axios.get(url, {
      headers: {
        'X-Save-Token': WOO_CONSUMER_KEY // token de proteção do endpoint
      }
    });

    const orders = res.data;
    if (!orders || orders.length === 0) return null;

    return orders;
  } catch (e) {
    console.error('Erro ao buscar WooCommerce:', e.message);
    console.error('Status:', e.response?.status);
    console.error('Detalhe:', e.response?.data);
    return null;
  }
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

    // --- 3. Detecta se a mensagem é sobre pedido/compra e busca no WooCommerce ---
    const pedidoKeywords = /pedido|compra|entrega|status|rastreio|pagamento|nota|envio|meus pedidos|meu pedido/i;
    let wooContext = '';

    if (pedidoKeywords.test(text)) {
      // Tenta extrair um e-mail da mensagem, se o cliente informar
      const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
      const email = emailMatch ? emailMatch[0] : null;

      if (email) {
        // Cliente informou o e-mail na mensagem
        const orders = await getWooOrdersByEmail(email);
        if (orders) {
          wooContext = `\n\nDADOS DO CLIENTE (do WooCommerce, e-mail ${email}):\n${JSON.stringify(orders, null, 2)}\n\nUse esses dados para responder sobre os pedidos de forma amigável.`;
        } else {
          wooContext = `\n\nNenhum pedido encontrado no WooCommerce para o e-mail ${email}. Informe o cliente educadamente que não encontramos pedidos vinculados a este e-mail e sugira verificar se digitou corretamente.`;
        }
      } else {
        // Cliente não informou o e-mail — pede educadamente
        wooContext = '\n\nO cliente perguntou sobre pedidos mas não informou o e-mail. Peça gentilmente que ele informe o e-mail cadastrado na compra para que você possa buscar os pedidos.';
      }
    }

    // --- 4. Adiciona o contexto do WooCommerce ao histórico do Gemini ---
    const geminiHistory = [...history];
    if (wooContext) {
      geminiHistory.push({ role: 'user', parts: [{ text: `[Contexto do sistema]${wooContext}` }] });
    }

    // --- 5. Chama o Gemini com TODO o histórico do dia ---
    const reply = await callGemini(geminiHistory);
    console.log(`Resposta do Gemini para ${phone}: ${reply}`);

    // --- 6. Envia a resposta e salva no histórico ---
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