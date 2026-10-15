import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  Browsers
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || 'multZap2026!secret').trim();

const cleanUrl = (url) => String(url || '').replace(/\[.*?\]\((.*?)\)/g, '$1').replace(/\/+$/, '').trim();
const WEBHOOK_URL = cleanUrl(process.env.WEBHOOK_URL || 'https://multmanager.vercel.app/api/whatsapp-webhook');
const SUPABASE_URL = cleanUrl(process.env.SUPABASE_URL || 'https://mpzupaofcmuaiiitgzud.supabase.co');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/[\r\n\s]+/g, '');

const sessions = {};
const sendQueues = {}; // Fila Anti-Rajada por unidade
let cachedUnits = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ============================================================================
// 1. COFRE DE SESSÃO NO SUPABASE (Nunca perde o QR Code quando o Render dorme)
// ============================================================================
async function useSupabaseAuthState(unitId) {
  const readData = async (key) => {
    if (!SUPABASE_KEY) return null;
    try {
      const id = `${unitId}__${key}`;
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/whatsapp_sessions?id=eq.${encodeURIComponent(id)}&select=data`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      if (!rows || !rows.length || !rows[0].data) return null;
      return JSON.parse(JSON.stringify(rows[0].data), BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const writeData = async (key, data) => {
    if (!SUPABASE_KEY) return;
    try {
      const id = `${unitId}__${key}`;
      const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
      await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          id,
          unit_id: String(unitId),
          data: serialized,
          updated_at: new Date().toISOString()
        })
      });
    } catch (e) {
      console.error('Erro ao salvar chave de sessão no Supabase:', e.message);
    }
  };

  const removeData = async (key) => {
    if (!SUPABASE_KEY) return;
    try {
      const id = `${unitId}__${key}`;
      await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
    } catch {}
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = value;
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData('creds', creds),
    clearSession: async () => {
      if (!SUPABASE_KEY) return;
      try {
        await fetch(
          `${SUPABASE_URL}/rest/v1/whatsapp_sessions?unit_id=eq.${encodeURIComponent(String(unitId))}`,
          {
            method: 'DELETE',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          }
        );
      } catch {}
    }
  };
}

// Busca unidades na tabela 'units'
async function fetchUnitsFromSupabase() {
  if (!SUPABASE_KEY) return cachedUnits;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/units?select=id,name,whatsapp_status,whatsapp_number&order=name.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) cachedUnits = data;
    }
  } catch (err) {
    console.error('Erro ao buscar unidades no Supabase:', err.message);
  }
  return cachedUnits;
}

async function updateUnitInSupabase(unitId, status, phone = null) {
  if (!SUPABASE_KEY || !unitId) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/units?id=eq.${unitId}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ whatsapp_status: status, whatsapp_number: phone })
    });
  } catch {}
}

// ============================================================================
// 2. MOTOR BAILEYS COM PROTEÇÃO ANTI-BAN E RECONEXÃO INTELIGENTE
// ============================================================================
async function startUnitWhatsApp(unitId, unitName = 'Unidade MULT') {
  if (!unitId) return;

  if (sessions[unitId] && (sessions[unitId].status === 'connected' || sessions[unitId].status === 'qr_ready')) {
    return sessions[unitId];
  }

  sessions[unitId] = {
    sock: null,
    qrCodeBase64: null,
    status: 'starting',
    phone: null,
    name: unitName,
    clearSession: null
  };

  const session = sessions[unitId];

  try {
    const { state, saveCreds, clearSession } = await useSupabaseAuthState(unitId);
    session.clearSession = clearSession;
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      // Assinatura oficial de Desktop macOS/Windows para maior confiança na Meta
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false, // Anti-Ban: Não fica "Online 24h" artificialmente!
      generateHighQualityLinkPreview: false
    });

    session.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.qrCodeBase64 = await QRCode.toDataURL(qr);
        session.status = 'qr_ready';
        console.log(`[${unitName}] QR Code pronto.`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        session.status = 'disconnected';
        session.qrCodeBase64 = null;
        session.phone = null;
        await updateUnitInSupabase(unitId, 'disconnected', null);

        if (loggedOut) {
          console.log(`[${unitName}] Aparelho desconectado pelo celular. Limpando cofre no Supabase...`);
          await clearSession();
          delete sessions[unitId];
        } else {
          // Reconexão suave com atraso aleatório para não metralhar o servidor da Meta
          const retryMs = randomBetween(5000, 10000);
          setTimeout(() => startUnitWhatsApp(unitId, unitName), retryMs);
        }
      } else if (connection === 'open') {
        session.status = 'connected';
        session.qrCodeBase64 = null;
        session.phone = sock?.user?.id?.split(':')[0] || 'Conectado';
        console.log(`[${unitName}] WhatsApp Conectado e Blindado: ${session.phone}`);
        await updateUnitInSupabase(unitId, 'connected', session.phone);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message) continue;
        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast') || remoteJid.includes('@newsletter')) continue;

        const phone = remoteJid.replace(/\D/g, '');
        const fromMe = Boolean(msg.key.fromMe);
        const senderName = msg.pushName || 'Lead WhatsApp';
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

        if (!phone || !text) continue;

        try {
          await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              unitId,
              unitName,
              phone,
              senderName,
              message: text,
              fromMe
            })
          });
          console.log(`[${unitName}] Mensagem enviada ao CRM (${phone})`);
        } catch (err) {
          console.error(`[${unitName}] Erro Webhook:`, err.message);
        }
      }
    });
  } catch (err) {
    console.error(`[${unitName}] Erro Baileys:`, err.message);
  }
}

// Restaura automaticamente do Supabase todas as unidades que tinham sessão salva!
async function restoreSavedSessionsFromSupabase() {
  if (!SUPABASE_KEY) return;
  try {
    const units = await fetchUnitsFromSupabase();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions?select=unit_id`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    if (!res.ok) return;
    const rows = await res.json();
    const savedUnitIds = [...new Set((rows || []).map((r) => String(r.unit_id)))];

    for (const unitId of savedUnitIds) {
      const unit = units.find((u) => String(u.id) === unitId);
      if (unit) {
        console.log(`🔄 Restaurando sessão blindada do Supabase para: ${unit.name}`);
        startUnitWhatsApp(unit.id, unit.name);
        await sleep(2000); // Espaça a inicialização entre unidades
      }
    }
  } catch (err) {
    console.error('Erro ao restaurar sessões do Supabase:', err.message);
  }
}

// ============================================================================
// 3. FUNÇÃO DE ENVIO HUMANO ANTI-BAN (Presença + Digitando + Cadência)
// ============================================================================
async function sendHumanizedMessage(unitId, targetJid, messageText) {
  const session = sessions[unitId];
  if (!session || session.status !== 'connected' || !session.sock) {
    throw new Error('Sessão da unidade desconectada.');
  }
  const sock = session.sock;

  // 1. Pausa inicial humana (1.2s a 2.8s) como se estivesse abrindo a conversa
  await sleep(randomBetween(1200, 2800));

  // 2. Assina presença e mostra "Digitando..." (composing) proporcional ao texto (3.5s a 7.5s)
  try {
    await sock.presenceSubscribe(targetJid);
    await sock.sendPresenceUpdate('composing', targetJid);
  } catch {}

  const typingTimeMs = Math.min(Math.max(messageText.length * 38, 3500), 7500) + randomBetween(300, 1200);
  await sleep(typingTimeMs);

  try {
    await sock.sendPresenceUpdate('paused', targetJid);
  } catch {}

  await sleep(randomBetween(400, 900));

  // 3. Envia a mensagem real
  const sentMsg = await sock.sendMessage(targetJid, { text: messageText });

  // 4. Volta o aparelho para "indisponível" após alguns segundos para não ficar online 24h
  setTimeout(() => {
    try { sock.sendPresenceUpdate('unavailable'); } catch {}
  }, 5000);

  return sentMsg;
}

// Enfileira disparos da mesma unidade para nunca saírem 2 mensagens no mesmo segundo
function enqueueUnitSend(unitId, taskFn) {
  if (!sendQueues[unitId]) {
    sendQueues[unitId] = Promise.resolve();
  }
  const nextTask = sendQueues[unitId].then(async () => {
    const result = await taskFn();
    // Pausa obrigatória de segurança na fila da unidade após cada envio (4s a 8s)
    await sleep(randomBetween(4000, 8000));
    return result;
  });
  sendQueues[unitId] = nextTask.catch(() => {});
  return nextTask;
}

// Painel Central Dinâmico
app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const units = await fetchUnitsFromSupabase();

  const cardsHtml = units.map((u) => {
    const s = sessions[u.id] || { status: 'idle', phone: null };
    const isConn = s.status === 'connected';
    return `
      <div style="background:#1e293b;padding:24px;border-radius:12px;width:290px;border:1px solid ${isConn ? '#22c55e' : '#334155'};">
        <h2 style="margin:0 0 10px 0;color:#f8fafc;font-size:20px;">📍 ${u.name}</h2>
        <p style="color:${isConn ? '#22c55e' : '#94a3b8'};font-weight:bold;min-height:24px;">
          ${isConn ? `✅ Blindado (\${s.phone})` : '⚪ Desconectado (0 MB RAM)'}
        </p>
        <a href="/connect/${u.id}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:${isConn ? '#334155' : '#f97316'};color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">
          ${isConn ? 'Ver Status / Desconectar' : '📱 Gerar QR Code'}
        </a>
      </div>
    `;
  }).join('');

  res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
      <h1 style="color:#f97316;">🛡️ Central WhatsApp Blindada - MULT Profissões</h1>
      <p style="color:#94a3b8;margin-bottom:35px;">Sessões salvas no Supabase + Simulação Humana Anti-Ban Ativa:</p>
      <div style="display:flex;gap:24px;justify-content:center;flex-wrap:wrap;max-width:1000px;margin:0 auto;">
        ${cardsHtml || '<p>Nenhuma unidade encontrada.</p>'}
      </div>
    </div>
  `);
});

app.get('/connect/:unitId', async (req, res) => {
  const unitId = req.params.unitId;
  const units = await fetchUnitsFromSupabase();
  const unit = units.find((u) => String(u.id) === String(unitId));
  if (!unit) return res.status(404).send('Unidade não encontrada.');

  if (!sessions[unitId] || sessions[unitId].status === 'disconnected') {
    startUnitWhatsApp(unitId, unit.name);
  }

  const s = sessions[unitId] || { status: 'starting' };
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (s.status === 'connected') {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
        <a href="/" style="color:#94a3b8;text-decoration:none;">← Voltar para Todas as Unidades</a>
        <h1 style="color:#22c55e;margin-top:25px;">✅ WhatsApp ${unit.name} Conectado e Salvo no Banco!</h1>
        <p style="font-size:18px;">Aparelho ativo: <strong>${s.phone}</strong></p>
        <p style="color:#94a3b8;">🛡️ Sessão persistente no Supabase (não desconecta se o servidor reiniciar) + Modo Digitando Humano ativo.</p>
        <form method="POST" action="/logout/${unit.id}" style="margin-top:30px;">
          <button type="submit" style="padding:10px 20px;background:#ef4444;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:bold;">
            🔌 Desconectar Aparelho desta Unidade
          </button>
        </form>
      </div>
    `);
  }

  if (s.status === 'qr_ready' && s.qrCodeBase64) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#fff;min-height:100vh;">
        <a href="/" style="color:#94a3b8;text-decoration:none;">← Voltar para Todas as Unidades</a>
        <h1 style="color:#f97316;margin-top:20px;">📱 Conectar Unidade: ${unit.name}</h1>
        <p>Abra o WhatsApp da unidade <strong>${unit.name}</strong> > Aparelhos Conectados > Conectar um aparelho:</p>
        <div style="background:#fff;padding:20px;display:inline-block;border-radius:16px;margin-top:15px;">
          <img src="${s.qrCodeBase64}" style="width:280px;height:280px;" />
        </div>
        <p style="color:#94a3b8;margin-top:20px;">A página atualiza sozinha a cada 8 segundos.</p>
        <script>setTimeout(() => location.reload(), 8000);</script>
      </div>
    `);
  }

  return res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
      <h2>⏳ Preparando conexão segura para ${unit.name}...</h2>
      <script>setTimeout(() => location.reload(), 3500);</script>
    </div>
  `);
});

app.post('/logout/:unitId', async (req, res) => {
  const unitId = req.params.unitId;
  const s = sessions[unitId];
  if (s?.sock) {
    try { await s.sock.logout(); } catch {}
  }
  if (s?.clearSession) {
    await s.clearSession();
  }
  delete sessions[unitId];
  await updateUnitInSupabase(unitId, 'disconnected', null);
  res.redirect('/');
});

app.get('/status', (req, res) => {
  const summary = {};
  for (const [id, s] of Object.entries(sessions)) {
    summary[id] = { name: s.name, status: s.status, phone: s.phone };
  }
  res.json({ active_sessions: Object.keys(sessions).length, units: summary });
});

// Rota de Disparo com Fila Anti-Rajada e Simulação de Digitação
app.post('/send', async (req, res) => {
  const token = req.headers['apikey'] || req.headers['authorization']?.replace('Bearer ', '');
  if (token !== API_KEY) return res.status(401).json({ error: 'Não autorizado' });

  try {
    const { phone, message, unitId } = req.body;

    let targetUnitId = unitId && sessions[unitId]?.status === 'connected' ? unitId : null;
    if (!targetUnitId) {
      targetUnitId = Object.keys(sessions).find((k) => sessions[k]?.status === 'connected');
    }

    if (!targetUnitId || !sessions[targetUnitId]?.sock) {
      return res.status(400).json({ error: 'O WhatsApp desta unidade não está conectado no momento.', unitId });
    }

    const sock = sessions[targetUnitId].sock;
    let cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone.startsWith('55')) cleanPhone = `55${cleanPhone}`;

    const candidates = [cleanPhone];
    if (cleanPhone.length === 13 && cleanPhone[4] === '9') {
      candidates.push(cleanPhone.slice(0, 4) + cleanPhone.slice(5));
    } else if (cleanPhone.length === 12) {
      candidates.push(cleanPhone.slice(0, 4) + '9' + cleanPhone.slice(4));
    }

    let targetJid = `${cleanPhone}@s.whatsapp.net`;
    for (const num of candidates) {
      const [result] = await sock.onWhatsApp(num);
      if (result && result.exists) {
        targetJid = result.jid;
        break;
      }
    }

    // Executa o envio dentro da fila humanizada da unidade (Digitando... + Pausa Anti-Ban)
    const sentMsg = await enqueueUnitSend(targetUnitId, () =>
      sendHumanizedMessage(targetUnitId, targetJid, message)
    );

    return res.json({
      status: 'sent_humanized',
      unitIdUsed: targetUnitId,
      unitName: sessions[targetUnitId].name,
      to: targetJid,
      messageId: sentMsg?.key?.id
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Blindado Multi-Unidades MULT CRM rodando na porta ${PORT}`);
  restoreSavedSessionsFromSupabase();
});
