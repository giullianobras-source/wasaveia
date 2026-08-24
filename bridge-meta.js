// bridge-meta.js - Versão Nuvemshop: memória, saudação, busca de pedidos por e-mail/telefone/CNPJ, rastreio e tratamento de erro de cota
const express = require('express');
const axios = require('axios');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json());

// ===== CONFIGURAÇÃO =====
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'wasaveia_token_2026';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1197397706799276';
const AI_URL = process.env.AI_URL;
const AI_API_KEY = process.env.AI_API_KEY;

// Nuvemshop
const NUVEMSHOP_STORE_ID = process.env.NUVEMSHOP_STORE_ID;
const NUVEMSHOP_ACCESS_TOKEN = process.env.NUVEMSHOP_ACCESS_TOKEN;

const WELCOME_MESSAGE = 'Olá! 👋 Eu sou o Save, assistente da Moobbile.\n\nPosso te ajudar com:\n• Status do seu pedido\n• Acompanhamento de entrega\n• Nota fiscal e pagamento\n\nPara consultar, me informe o e-mail, telefone ou CPF da compra. Como posso ajudar?';

const SESSION_TTL_SECONDS = 24 * 60 * 60;

const SYSTEM_PROMPT = {
  role: 'user',
  parts: [{ text: `[Instrução do sistema] Você é o Save, assistente de atendimento da Moobbile.
Seja cordial, direto e profissional. Ao informar dados de pedido, use formato claro com negrito (Data, Status, Item, Valor).
NUNCA invente números de pedido, status, valores ou código de rastreio — use somente os dados fornecidos no contexto.
Se o pedido tiver código de rastreio, informe-o junto com o link de acompanhamento quando disponível.
Se não encontrar o pedido, informe educadamente e peça os dados corretos.` }]
};

const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN
});

// ===== HELPERS =====
async function getHistory(phone) {
  try {
    const data = await redis.get(`hist:${phone}`);
    return data ? data : [];
  } catch (e) {
    console.error('Erro ao ler histórico:', e.message);
    return [];
  }
}

async function saveHistory(phone, history) {
  try {
    await redis.set(`hist:${phone}`, JSON.stringify(history), { ex: SESSION_TTL_SECONDS });
  } catch (e) {
    console.error('Erro ao salvar histórico:', e.message);
  }
}

async function isFirstContact(phone) {
  const exists = await redis.exists(`hist:${phone}`);
  return exists === 0;
}

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

async function callGemini(history) {
  const MAX_TRIES = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await axios.post(`${AI_URL}?key=${AI_API_KEY}`, {
        contents: history
      });
      return res.data.candidates[0].content.parts[0].text;
    } catch (e) {
      lastError = e;
      const status = e.response?.status;
      if (status === 429 || status === 500 || status === 503) {
        console.error(`Gemini erro ${status} (tentativa ${attempt}/${MAX_TRIES}): ${e.message}`);
        if (attempt < MAX_TRIES) {
          await new Promise(res => setTimeout(res, 2000));
          continue;
        }
      }
      throw e;
    }
  }
  throw lastError;
}

// ===== NUVEMSHOP (busca por e-mail, telefone ou CNPJ + rastreio) =====
async function getNuvemshopOrders(query) {
  try {
    if (!NUVEMSHOP_STORE_ID || !NUVEMSHOP_ACCESS_TOKEN) {
      console.error('Nuvemshop não configurada (faltam variáveis NUVEMSHOP_*)');
      return null;
    }

    const headers = {
      'Authorization': `Bearer ${NUVEMSHOP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    };
    const base = `https://api.nuvemshop.com.br/v1/${NUVEMSHOP_STORE_ID}`;

    // 1. Procura o cliente por e-mail, telefone ou CNPJ
    let customer = null;
    const customerParams = new URLSearchParams();
    if (query.email) customerParams.set('email', query.email);
    if (query.phone) customerParams.set('phone', query.phone);
    if (query.cnpj) customerParams.set('identification', query.cnpj);

    if (customerParams.toString()) {
      const custRes = await axios.get(`${base}/customers?${customerParams.toString()}`, { headers });
      if (custRes.data && custRes.data.length > 0) {
        customer = custRes.data[0];
      }
    }

    // 2. Busca os pedidos do cliente
    const orderParams = new URLSearchParams();
    if (customer) {
      orderParams.set('customer_id', customer.id);
    } else if (query.email) {
      orderParams.set('email', query.email);
    } else {
      return null;
    }

    const orderRes = await axios.get(`${base}/orders?${orderParams.toString()}`, { headers });
    const orders = orderRes.data;
    if (!orders || orders.length === 0) return null;

    // 3. Converte para o formato que o Gemini entende — com rastreio
    return orders.map(o => {
      const fulfillment = (o.fulfillments && o.fulfillments[0]) || null;
      const rastreio = o.shipping?.tracking_number || fulfillment?.tracking_info?.code || null;
      const rastreioUrl = o.shipping?.tracking_url || fulfillment?.tracking_info?.url || null;

      return {
        numero: o.number || o.id,
        status: o.status,
        shipping_status: o.shipping_status || 'não informado',
        total: o.total,
        data: o.created_at,
        itens: (o.products || []).map(p => `${p.name} (x${p.quantity})`),
        endereco: o.shipping?.receiver_address || 'não informado',
        rastreio: rastreio || 'não informado',
        rastreio_url: rastreioUrl || 'não informado'
      };
    });
  } catch (e) {
    console.error('Erro ao buscar Nuvemshop:', e.message);
    if (e.response) console.error('Status:', e.response.status, 'Detalhe:', JSON.stringify(e.response.data));
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

// ===== WEBHOOK - Recebimento (POST) =====
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const phone = message.from;
    const text = message.text.body;
    console.log(`Mensagem recebida de ${phone}: ${text}`);

    const firstContact = await isFirstContact(phone);
    if (firstContact) {
      await sendWhatsApp(phone, WELCOME_MESSAGE);
      console.log(`Saudação enviada para ${phone}`);
    }

    const history = await getHistory(phone);
    history.push({ role: 'user', parts: [{ text }] });

    // Detecta pedido e extrai e-mail, telefone ou CNPJ
    const pedidoKeywords = /pedido|compra|entrega|status|rastreio|pagamento|nota|envio|meus pedidos|meu pedido|fatura|nf|nota fiscal|boleto|quando chega|onde esta|cade minha compra|cadê minha compra|meu pedido chegou|chegou|foi enviado|ja foi enviado|ja chegou|quando chega meu|acompanhar|rastrear|cpf|email|e-mail|telefone/i;
    let nuvemContext = '';

    if (pedidoKeywords.test(text)) {
      const emailMatch  = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
      const cnpjMatch   = text.match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/);
      const phoneMatch  = text.match(/(?:\+?\d{2}[\s-]?)?\(?\d{2}\)?[\s-]?\d{4,5}[\s-]?\d{4}/);

      const email = emailMatch ? emailMatch[0] : null;
      const cnpj  = cnpjMatch ? cnpjMatch[0].replace(/[^\d]/g, '') : null;
      const phoneNum = phoneMatch ? phoneMatch[0].replace(/[^\d]/g, '') : null;

      if (email || cnpj || phoneNum) {
        const orders = await getNuvemshopOrders({ email, cnpj, phone: phoneNum });
        if (orders) {
          nuvemContext = `\n\nDADOS DO CLIENTE (da Nuvemshop):\n${JSON.stringify(orders, null, 2)}\n\nUse esses dados para responder sobre os pedidos de forma amigável, incluindo código de rastreio quando existir.`;
        } else {
          nuvemContext = `\n\nNenhum pedido encontrado na Nuvemshop para os dados informados. Informe o cliente educadamente que não encontramos pedidos vinculados e sugira verificar se os dados estão corretos.`;
        }
      } else {
        nuvemContext = '\n\nO cliente perguntou sobre pedidos mas não informou e-mail, telefone ou CNPJ. Peça gentilmente que ele informe o e-mail cadastrado na compra, o telefone ou o CNPJ para que você possa buscar os pedidos.';
      }
    }

    const geminiHistory = [SYSTEM_PROMPT, ...history];
    if (nuvemContext) {
      geminiHistory.push({ role: 'user', parts: [{ text: `[Contexto do sistema]${nuvemContext}` }] });
    }

    let reply;
    try {
      reply = await callGemini(geminiHistory);
      console.log(`Resposta do Gemini para ${phone}: ${reply}`);
    } catch (e) {
      const status = e.response?.status;
      console.error(`Falha ao chamar Gemini (${status}):`, e.message);
      reply = '😅 Estou com um pico de atendimento agora e não consegui processar sua mensagem. Por favor, tente novamente em instantes. Se preferir, me mande o e-mail, telefone ou CNPJ da compra que eu verifico seu pedido assim que voltar.';
    }

    await sendWhatsApp(phone, reply);
    history.push({ role: 'model', parts: [{ text: reply }] });
    await saveHistory(phone, history);

  } catch (err) {
    console.error('Erro no webhook:', err.message);
    console.error('Status:', err.response?.status);
    console.error('Detalhe:', err.response?.data?.error?.message);
  }
});

app.listen(PORT, () => {
  console.log(`Ponte Meta ativa na porta ${PORT}`);
});