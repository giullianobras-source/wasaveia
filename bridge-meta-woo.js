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
const WELCOME_MESSAGE = `Olá! 👋 Eu sou o Save, assistente da ${LOJA_NOME}.\n\nPosso te ajudar com:\n• Status do seu pedido\n• Acompanhamento de entrega\n• Nota fiscal e pagamento\n\nPara consultar, me informe o e-mail, telefone ou CPF da compra. Como posso ajudar?`;
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const SYSTEM_PROMPT = {
  role: 'user',
  parts: [{ text: `[Instrução do sistema] Você é o Save, assistente de atendimento da ${LOJA_NOME}.
Seja cordial, direto e profissional. Ao informar dados de pedido, use formato claro (Data, Status, Item, Valor).
NUNCA invente números de pedido, status, valores ou código de rastreio — use SOMENTE os dados do bloco [Contexto do sistema] mais recente.
Se um pedido não estiver no contexto, não o mencione.
Se o pedido tiver código de rastreio, informe-o junto com o link de acompanhamento quando disponível.
Se não encontrar o pedido, informe educadamente e peça os dados corretos.` }]
};

const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN
});

// ===== HELPERS DE MEMÓRIA (Redis) =====
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
  try {
    const exists = await redis.exists(`hist:${phone}`);
    return exists === 0;
  } catch (e) {
    console.error('Erro ao verificar histórico:', e.message);
    return false;
  }
}

// ===== FUNÇÃO: enviar resposta pelo WhatsApp (Meta) =====
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

// ===== FUNÇÃO: chamar o Gemini (com retry) =====
async function callGemini(history) {
  const MAX_TRIES = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await axios.post(`${AI_URL}?key=${AI_API_KEY}`, { contents: history });
      return res.data.candidates[0].content.parts[0].text;
    } catch (e) {
      lastError = e;
      const status = e.response?.status;
      if (status === 429 || status === 500 || status === 503) {
        console.error(`Gemini erro ${status} (tentativa ${attempt}/${MAX_TRIES}): ${e.message}`);
        if (attempt < MAX_TRIES) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      }
      throw e;
    }
  }
  throw lastError;
}

// ===== WOOCOMMERCE =====
const WOO_KEYS_META = ['_billing_cpf', 'billing_cpf', '_billing_cnpj', 'billing_cnpj', '_billing_cpf_cnpj', 'billing_cpf_cnpj'];

function normDigits(s) { return String(s || '').replace(/\D/g, ''); }

function isValidCpf(cpf) {
  if (!cpf || cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(cpf[i]) * (10 - i);
  let d1 = 11 - (s % 11); if (d1 >= 10) d1 = 0;
  if (d1 !== parseInt(cpf[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(cpf[i]) * (11 - i);
  let d2 = 11 - (s % 11); if (d2 >= 10) d2 = 0;
  return d2 === parseInt(cpf[10]);
}

function dedupeOrders(arr) { return [...new Map(arr.map(o => [o.id, o])).values()]; }
function orderMeta(ord, key) {
  for (const m of (ord.meta_data || [])) {
    if (String(m.key).toLowerCase() === key.toLowerCase()) return m.value;
  }
  return null;
}
function matchDoc(ord, docDigits) {
  if (!docDigits) return false;
  const target = String(docDigits).replace(/^0+/, '');
  const docKeys = ['cpf', 'cnpj', 'documento', 'doc', 'inscricao', 'nit', 'pis'];
  for (const m of (ord.meta_data || [])) {
    const key = String(m.key || '').toLowerCase();
    if (!docKeys.some(k => key.includes(k))) continue;
    const v = String(m.value || '').replace(/\D/g, '').replace(/^0+/, '');
    if (!v) continue;
    if (v === target) return true;
    if ((v.endsWith(target) || target.endsWith(v)) && Math.min(v.length, target.length) >= 9) return true;
  }
  return false;
}

async function wooGet(path, params) {
  const auth = Buffer.from(WOO_CONSUMER_KEY + ':' + WOO_CONSUMER_SECRET).toString('base64');
  const base = WOO_URL.replace(/\/$/, '') + '/wp-json/wc/v3';
  const res = await axios.get(base + path, {
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    params,
    timeout: 20000
  });
  return res.data;
}
async function wooFetchAll(path, params) {
  const out = [];
  let page = 1;
  while (true) {
    const data = await wooGet(path, Object.assign({}, params, { per_page: 100, page }));
    out.push(...data);
    if (data.length < 100) break;
    page++;
    if (page > 20) break;
  }
  return out;
}
async function wooRecentPages(maxPages) {
  // Sem filtro de data (after): evita 404 da hospedagem; pedidos vem do mais novo ao mais antigo
  const out = [];
  let page = 1;
  maxPages = maxPages || 15;
  while (page <= maxPages) {
    try {
      const data = await wooGet('/orders', { per_page: 100, page });
      out.push(...data);
      if (!data.length || data.length < 100) break;
    } catch (e) {
      console.error('[WOO] Falha na pagina ' + page + ' (continuando com o que ja veio):', e.message);
      break;
    }
    page++;
  }
  return out;
}

function phonesMatch(a, b) {
  if (!a || !b) return false;
  const x = String(a).replace(/\D/g, '');
  const y = String(b).replace(/\D/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.endsWith(y) || y.endsWith(x)) return true;
  return x.slice(-9) === y.slice(-9);
}

async function getWooOrders(query) {
  try {
    if (!WOO_URL || !WOO_CONSUMER_KEY || !WOO_CONSUMER_SECRET) {
      console.error('WooCommerce nao configurada (faltam variaveis WOO_*)');
      return null;
    }
    const docDigits = query.cnpj ? normDigits(query.cnpj) : null;
    const email = query.email ? String(query.email).trim().toLowerCase() : null;
    const phoneDigits = query.phone ? normDigits(query.phone) : null;
    let orders = [];

    // 1) DOCUMENTO (CPF/CNPJ): filtro por campo (sem filtro de data)
    if (docDigits) {
      for (const k of WOO_KEYS_META) {
        for (const v of [docDigits, docDigits.replace(/^0+/, '')]) {
          try {
            orders = orders.concat(await wooFetchAll('/orders', { meta_key: k, meta_value: v }));
          } catch (e) { /* tenta proxima chave */ }
        }
      }
      orders = dedupeOrders(orders).filter(o => matchDoc(o, docDigits));
      if (!orders.length) {
        orders = (await wooRecentPages(15)).filter(o => matchDoc(o, docDigits));
      }
      console.log('[WOO] Busca por documento (' + docDigits.length + ' digitos): ' + orders.length + ' pedido(s)');
    }

    // 2) E-MAIL: cliente + pedidos dele (fallback billing email)
    if (!orders.length && email) {
      const custs = await wooGet('/customers', { email, per_page: 100 });
      for (const c of (custs || [])) {
        orders = orders.concat(await wooFetchAll('/orders', { customer: c.id }));
      }
      if (!orders.length) {
        orders = (await wooFetchAll('/orders', { search: email })).filter(o =>
          ((o.billing && o.billing.email) || '').trim().toLowerCase() === email
        );
      }
      orders = dedupeOrders(orders);
      console.log('[WOO] Busca por e-mail: ' + orders.length + ' pedido(s)');
    }

    // 3) TELEFONE: campo _billing_phone + varredura sem filtro de data
    if (!orders.length && phoneDigits && phoneDigits.length >= 10) {
      for (const k of ['_billing_phone', 'billing_phone']) {
        try {
          orders = orders.concat(await wooFetchAll('/orders', { meta_key: k, meta_value: phoneDigits }));
        } catch (e) { /* tenta outra chave */ }
      }
      orders = dedupeOrders(orders).filter(o => phonesMatch(o.billing && o.billing.phone, phoneDigits));
      if (!orders.length) {
        orders = (await wooRecentPages(15)).filter(o =>
          phonesMatch(o.billing && o.billing.phone, phoneDigits) ||
          phonesMatch(o.shipping && o.shipping.phone, phoneDigits)
        );
      }
      orders = dedupeOrders(orders);
      console.log('[WOO] Busca por telefone: ' + orders.length + ' pedido(s)');
    }

    if (!orders.length) return null;

    const STATUS_MAP = {
      pending: 'Pagamento pendente',
      processing: 'Em processamento',
      'on-hold': 'Aguardando confirmacao',
      completed: 'Concluido',
      cancelled: 'Cancelado',
      refunded: 'Reembolsado',
      failed: 'Pagamento falhou',
      trash: 'Pedido removido'
    };

    return orders.slice(0, 20).map(o => {
      let rastreio = null;
      for (const m of (o.meta_data || [])) {
        const k = String(m.key || '').toLowerCase();
        if ((k.includes('track') || k.includes('rastre') || k.includes('codigo')) && m.value) {
          rastreio = String(m.value);
          break;
        }
      }
      const end = o.shipping || {};
      const cidade = [end.address_1, end.city, end.state].filter(Boolean).join(', ') || 'nao informado';
      return {
        numero: o.id || o.number,
        status: STATUS_MAP[o.status] || o.status,
        data: o.date_created || 'nao informado',
        total: 'R$ ' + Number(o.total).toFixed(2).replace('.', ','),
        pagamento: o.payment_method_title || 'nao informado',
        itens: (o.line_items || []).map(i => i.name + ' (x' + i.quantity + ')'),
        endereco: cidade,
        rastreio: rastreio || 'nao informado'
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
      console.log(`Saudacao enviada para ${phone}`);
    }

    let history = await getHistory(phone);
    history.push({ role: 'user', parts: [{ text }] });

    // === DETECÇÃO: palavra-chave OU dados (e-mail/CPF/telefone) ===
    const pedidoKeywords = /pedido|compra|entrega|status|rastreio|pagamento|nota|envio|meus pedidos|meu pedido|fatura|nf|nota fiscal|boleto|quando chega|onde esta|cade minha compra|cadê minha compra|meu pedido chegou|chegou|foi enviado|ja foi enviado|ja chegou|quando chega meu|acompanhar|rastrear|cpf|email|e-mail|telefone/i;
    let wooContext = '';

    // DETECÇÃO: e-mail sempre; documento vs telefone por contagem de dígitos + validação de CPF
    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    const email = emailMatch ? emailMatch[0] : null;
    let digitos = text.replace(/\D/g, '');
    if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith('55')) digitos = digitos.slice(2);
    let doc = null;
    let phoneNum = null;
    if (digitos.length === 14) {
      doc = digitos; // CNPJ
    } else if (digitos.length === 11) {
      if (isValidCpf(digitos)) { doc = digitos; } else { phoneNum = digitos; }
    } else if (digitos.length === 10) {
      phoneNum = digitos;
    }
    const temPalavraChave = pedidoKeywords.test(text);
    const temDado = !!(email || doc || phoneNum);

    if (temPalavraChave || temDado) {
      if (temDado) {
        const orders = await getWooOrders({ email, cnpj: doc, phone: phoneNum });
        if (orders) {
          wooContext = `\n\nDADOS DO CLIENTE (do WooCommerce):\n${JSON.stringify(orders, null, 2)}\n\nUse esses dados para responder sobre os pedidos de forma amigavel, incluindo codigo de rastreio quando existir.`;
          history = [{ role: 'user', parts: [{ text }] }];
          await clearHistory(phone);
          console.log(`[WOO] Historico limpo. Contexto gerado com ${orders.length} pedido(s).`);
        } else {
          wooContext = `\n\nNenhum pedido encontrado no WooCommerce para os dados informados. Informe o cliente educadamente que nao encontramos pedidos vinculados e sugira verificar se os dados estao corretos.`;
        }
      } else {
        wooContext = '\n\nO cliente perguntou sobre pedidos mas nao informou e-mail, telefone ou CPF. Peça gentilmente que ele informe o e-mail cadastrado na compra, o telefone ou o CPF para que voce possa buscar os pedidos.';
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
      reply = '😅 Estou com um pico de atendimento agora e nao consegui processar sua mensagem. Por favor, tente novamente em instantes. Se preferir, me mande o e-mail, telefone ou CPF da compra que eu verifico seu pedido assim que voltar.';
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

// ===== PÁGINA DE LOGS (/logs) =====
const LOGS_TOKEN = 'Ba96350836??savemax_logs_2026';
const logs = [];
function capturar(tipo, args) {
  const linha = `[${new Date().toLocaleTimeString('pt-BR')}] ${args.join(' ')}`;
  logs.push({ tipo, linha });
  if (logs.length > 500) logs.shift();
}
const logOriginal = console.log;
const erroOriginal = console.error;
console.log = (...a) => { capturar('ok', a); logOriginal.apply(console, a); };
console.error = (...a) => { capturar('erro', a); erroOriginal.apply(console, a); };

app.get('/logs', (req, res) => {
  if (req.query.token !== LOGS_TOKEN) return res.sendStatus(403);
  const lines = Math.min(parseInt(req.query.lines) || 120, 500);
  const saida = logs.filter(l => l.tipo === 'ok').map(l => l.linha).slice(-lines).join('<br>') || 'Nenhuma saida ainda.';
  const erros = logs.filter(l => l.tipo === 'erro').map(l => l.linha).slice(-lines).join('<br>') || 'Nenhum erro registrado.';
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Logs do Bot</title>
<meta http-equiv="refresh" content="5">
<style>
body{font-family:monospace;background:#0f172a;color:#e2e8f0;padding:20px}
h1{color:#38bdf8} h2{color:#e2e8f0}
#saida{background:#064e3b;color:#a7f3d0;padding:15px;border-radius:8px;white-space:pre-wrap}
#erros{background:#7f1d1d;color:#fecaca;padding:15px;border-radius:8px;white-space:pre-wrap}
</style>
</head>
<body>
<h1>Logs do bot</h1>
<h2>SAIDA NORMAL</h2>
<div id="saida">${saida}</div>
<h2>ERROS</h2>
<div id="erros">${erros}</div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Ponte Meta ativa na porta ${PORT}`);
});
