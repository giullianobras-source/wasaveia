
// bridge-meta-woo.js - Ponte Meta (WhatsApp) + Gemini + WooCommerce

const express = require('express');

const axios = require('axios');

const { Redis } = require('@upstash/redis');

const app = express();

app.use(express.json());

// ===== CONFIGURAÇÃO =====

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'Ba96350836??wasaveia_token_2026';

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1197397706799276';

const AI_URL = process.env.AI_URL;

const AI_API_KEY = process.env.AI_API_KEY;

// WooCommerce

const WOO_URL = process.env.WOO_URL;

const WOO_CONSUMER_KEY = process.env.WOO_CONSUMER_KEY;

const WOO_CONSUMER_SECRET = process.env.WOO_CONSUMER_SECRET;

const LOJA_NOME = 'SaveMax';

const WELCOME_MESSAGE = `Olá! ������ Eu sou o Save, assistente da ${LOJA_NOME}.\n\nPosso te ajudar com:\n• Status do seu pedido\n• Acompanhamento de entrega\n• Nota fiscal e pagamento\n\nPara consultar, me informe o e-mail, telefone ou CPF da compra. Como posso ajudar?`;

const SESSION_TTL_SECONDS = 24 * 60 * 60;

const SYSTEM_PROMPT = {

  role: 'user',

  parts: [{ text: `[Instrução do sistema] Você é o Save, assistente de atendimento da ${LOJA_NOME}.

Seja cordial, direto e profissional. Ao informar dados de pedido, use formato claro com negrito (Data, Status, Item, Valor).

NUNCA invente números de pedido, status, valores ou código de rastreio — use SOMENTE os dados do bloco [Contexto do sistema] mais recente.

Se um pedido não estiver no contexto, não o mencione.

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

async function clearHistory(phone) {

  try {

    await redis.del(`hist:${phone}`);

  } catch (e) {

    console.error('Erro ao limpar histórico:', e.message);

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

// ===== WOOCOMMERCE =====

async function getWooOrders(query) {

  try {

    if (!WOO_URL || !WOO_CONSUMER_KEY || !WOO_CONSUMER_SECRET) {

      console.error('WooCommerce não configurada (faltam variáveis WOO_*)');

      return null;

    }

    const auth = Buffer.from(`${WOO_CONSUMER_KEY}:${WOO_CONSUMER_SECRET}`).toString('base64');

    const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };

    const base = `${WOO_URL.replace(/\/$/, '')}/wp-json/wc/v3`;



    let orders = [];



    // 1. Cliente por e-mail -> pedidos dele (customer_id)

    let customerIds = [];

    if (query.email) {

      const custRes = await axios.get(`${base}/customers`, { headers, params: { email: query.email, per_page: 100 }, timeout: 15000 });

      customerIds = (custRes.data || []).map(c => c.id);

      console.log(`[WOO] Cliente(s) por e-mail: ${customerIds.length}`);

    }



    if (customerIds.length > 0) {

      for (const cid of customerIds) {

        let page = 1;

        while (true) {

          const res = await axios.get(`${base}/orders`, { headers, params: { customer: cid, per_page: 100, page }, timeout: 15000 });

          const data = res.data || [];

          orders = orders.concat(data);

          if (data.length < 100) break;

          page++;

        }

      }

      console.log(`[WOO] Pedidos via customer_id: ${orders.length}`);

    } else {

      // 2. Sem cliente por e-mail: busca pelo termo (e-mail, telefone ou número do pedido)

      const termo = query.email || query.phone || query.cnpj || '';

      if (!termo) return null;

      let page = 1;

      while (true) {

        const res = await axios.get(`${base}/orders`, { headers, params: { search: termo, per_page: 100, page }, timeout: 15000 });

        const data = res.data || [];

        orders = orders.concat(data);

        if (data.length < 100) break;

        page++;

      }

      console.log(`[WOO] Pedidos por termo "${termo}": ${orders.length}`);

    }



    // 3. Filtro defensivo: só pedidos do cliente consultado

    let filtered = orders;

    if (query.email) {

      const em = query.email.toLowerCase().trim();

      filtered = filtered.filter(o => o.billing && o.billing.email && o.billing.email.toLowerCase().trim() === em);

    } else if (query.phone) {

      const telLimpo = query.phone.replace(/\D/g, '');

      filtered = filtered.filter(o => {

        const telNum = ((o.billing && o.billing.phone) || '').replace(/\D/g, '');

        return telNum && (telNum.includes(telLimpo.slice(-10)) || telLimpo.includes(telNum.slice(-10)));

      });

    } else if (query.cnpj) {

      const docLimpo = query.cnpj.replace(/\D/g, '');

      filtered = filtered.filter(o => {

        const metas = o.meta_data || [];

        const docs = metas.map(m => String(m.value || '')).join('|').replace(/\D/g, '');

        return docs && docs.includes(docLimpo);

      });

    }

    console.log(`[WOO] Após filtro: ${filtered.length} pedido(s)`);

    if (filtered.length === 0) return null;



    // 4. Converte para o formato que o Gemini entende (com rastreio se o plugin gravar em meta)

    const STATUS_MAP = {

      pending: 'Pagamento pendente',

      processing: 'Em processamento',

      'on-hold': 'Aguardando confirmação',

      completed: 'Concluído',

      cancelled: 'Cancelado',

      refunded: 'Reembolsado',

      failed: 'Pagamento falhou',

      trash: 'Pedido removido'

    };

    return filtered.slice(0, 20).map(o => {

      const metas = o.meta_data || [];

      let rastreio = null;

      for (const m of metas) {

        const k = String(m.key || '').toLowerCase();

        if ((k.includes('track') || k.includes('rastre')) && m.value) { rastreio = String(m.value); break; }

      }

      const end = o.shipping || {};

      const cidade = [end.address_1, end.city, end.state].filter(Boolean).join(', ') || 'não informado';

      return {

        numero: o.id || o.number,

        status: STATUS_MAP[o.status] || o.status,

        data: o.date_created || 'não informado',

        total: `R$ ${Number(o.total).toFixed(2).replace('.', ',')}`,

        pagamento: o.payment_method_title || 'não informado',

        itens: (o.line_items || []).map(i => `${i.name} (x${i.quantity})`),

        endereco: cidade,

        rastreio: rastreio || 'não informado'

      };

    });

  } catch (e) {

    console.error('Erro ao buscar WooCommerce:', e.message);

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

    let history = await getHistory(phone);

    history.push({ role: 'user', parts: [{ text }] });

    // === DETECÇÃO: dispara com palavra-chave OU com dados (e-mail/CPF/telefone) ===

    const pedidoKeywords = /pedido|compra|entrega|status|rastreio|pagamento|nota|envio|meus pedidos|meu pedido|fatura|nf|nota fiscal|boleto|quando chega|onde esta|cade minha compra|cadê minha compra|meu pedido chegou|chegou|foi enviado|ja foi enviado|ja chegou|quando chega meu|acompanhar|rastrear|cpf|email|e-mail|telefone/i;

    let wooContext = '';

    // === CORREÇÃO CPF: aceita CPF (11 dígitos) OU CNPJ (14 dígitos), com ou sem máscara ===

    const docMatch = text.match(/(?:\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/);

    const doc = docMatch ? docMatch[0].replace(/[^\d]/g, '') : null;

    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);

    const email = emailMatch ? emailMatch[0] : null;

    // Só procura telefone se NÃO houver documento (evita confundir CPF com telefone)

    const phoneMatch = doc ? null : text.match(/(?:\+?\d{2}[\s-]?)?\(?\d{2}\)?[\s-]?\d{4,5}[\s-]?\d{4}/);

    const phoneNum = phoneMatch ? phoneMatch[0].replace(/[^\d]/g, '') : null;

    const temPalavraChave = pedidoKeywords.test(text);

    const temDado = !!(email || doc || phoneNum);

    if (temPalavraChave || temDado) {

      if (temDado) {

        const orders = await getWooOrders({ email, cnpj: doc, phone: phoneNum });

        if (orders) {

          wooContext = `\n\nDADOS DO CLIENTE (do WooCommerce):\n${JSON.stringify(orders, null, 2)}\n\nUse esses dados para responder sobre os pedidos de forma amigável, incluindo código de rastreio quando existir.`;

          history = [{ role: 'user', parts: [{ text }] }];

          await clearHistory(phone);

          console.log(`[WOO] Histórico limpo. Contexto gerado com ${orders.length} pedido(s).`);

        } else {

          wooContext = `\n\nNenhum pedido encontrado no WooCommerce para os dados informados. Informe o cliente educadamente que não encontramos pedidos vinculados e sugira verificar se os dados estão corretos.`;

        }

      } else {

        wooContext = '\n\nO cliente perguntou sobre pedidos mas não informou e-mail, telefone ou CPF. Peça gentilmente que ele informe o e-mail cadastrado na compra, o telefone ou o CPF para que você possa buscar os pedidos.';

      }

    }

    const geminiHistory = [SYSTEM_PROMPT, ...history];

    if (wooContext) {

      geminiHistory.push({ role: 'user', parts: [{ text: `[Contexto do sistema]${wooContext}` }] });

    }

    let reply;

    try {

      reply = await callGemini(geminiHistory);

      console.log(`Resposta do Gemini para ${phone}: ${reply}`);

    } catch (e) {

      const status = e.response?.status;

      console.error(`Falha ao chamar Gemini (${status}):`, e.message);

      reply = '������ Estou com um pico de atendimento agora e não consegui processar sua mensagem. Por favor, tente novamente em instantes. Se preferir, me mande o e-mail, telefone ou CPF da compra que eu verifico seu pedido assim que voltar.';

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

