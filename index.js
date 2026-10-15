import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  Browsers,
  makeCacheableSignalKeyStore
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
const sendQueues = {};
const sentMessagesCache = new Map();
let cachedUnits = [];
const recentEvents = [];

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function logEvent(info) {
  recentEvents.unshift({ time: new Date().toISOString(), ...info });
  if (recentEvents.length > 20) recentEvents.pop();
}

function extractMessageText(messageObj) {
  if (!messageObj) return '';
  const m =
    messageObj.ephemeralMessage?.message ||
    messageObj.viewOnceMessage?.message ||
    messageObj.viewOnceMessageV2?.message ||
    messageObj.documentWithCaptionMessage?.message ||
    messageObj;

  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.buttonsResponseMessage?.selectedDisplayText ||
    m?.listResponseMessage?.title ||
    m?.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  );
}

async function useSupabaseAuthState(unitId) {
  const memoryStore = new Map();
  const dirtyKeys = new Set();
  const deletedKeys = new Set();

  if (SUPABASE_KEY) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/whatsapp_sessions?unit_id=eq.${encodeURIComponent(String(unitId))}&select=id,data`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      if (res.ok) {
        const rows = await res.json();
        for (const row of rows || []) {
          const shortKey = String(row.id).replace(`${unitId}__`, '');
          const revived = JSON.parse(JSON.stringify(row.data), BufferJSON.reviver);
          memoryStore.set(shortKey, revived);
        }
      }
    } catch (e) {
      console.error('Erro ao carregar cofre:', e.message);
    }
  }

  let isFlushing = false;
  const flushToSupabase = async () => {
    if (!SUPABASE_KEY || isFlushing || (dirtyKeys.size === 0 && deletedKeys.size === 0)) return;
    isFlushing = true;
    try {
      if (dirtyKeys.size > 0) {
        const keysToSave = Array.from(dirtyKeys);
        dirtyKeys.clear();
        const payload = keysToSave
          .filter((k) => memoryStore.has(k))
          .map((k) => ({
            id: `${unitId}__${k}`,
            unit_id: String(unitId),
            data: JSON.parse(JSON.stringify(memoryStore.get(k), BufferJSON.replacer)),
            updated_at: new Date().toISOString()
          }));

        if (payload.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions`, {
            method: 'POST',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates'
            },
            body: JSON.stringify(payload)
          });
        }
      }

      if (deletedKeys.size > 0) {
        const keysToDel = Array.from(deletedKeys);
        deletedKeys.clear();
        for (const k of keysToDel) {
          const id = `${unitId}__${k}`;
          await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions?id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
        }
      }
    } catch (e) {
      console.error('Erro flush Supabase:', e.message);
    } finally {
      isFlushing = false;
    }
  };

  const flushTimer = setInterval(flushToSupabase, 4000);
  const creds = memoryStore.get('creds') || initAuthCreds();
  memoryStore.set('creds', creds);

  const rawKeys = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        const val = memoryStore.get(`${type}-${id}`);
        data[id] = val || null;
      }
      return data;
    },
    set: async (data) => {
      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          const key = `${category}-${id}`;
          if (value) {
            memoryStore.set(key, value);
            dirtyKeys.add(key);
            deletedKeys.delete(key);
          } else {
            memoryStore.delete(key);
            dirtyKeys.delete(key);
            deletedKeys.add(key);
          }
        }
      }
      flushToSupabase();
    }
  };

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(rawKeys, logger)
    },
    saveCreds: async () => {
      memoryStore.set('creds', creds);
      dirtyKeys.add('creds');
      await flushToSupabase();
    },
    clearSession: async () => {
      clearInterval(flushTimer);
      memoryStore.clear();
      dirtyKeys.clear();
      deletedKeys.clear();
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
    console.error('Erro ao buscar unidades:', err.message);
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
      logger,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => {
        const cachedText = sentMessagesCache.get(key.id);
        if (cachedText) return { conversation: cachedText };
        return { conversation: 'Olá!' };
      }
    });

    session.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.qrCodeBase64 = await QRCode.toDataURL(qr);
        session.status = 'qr_ready';
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        session.status = 'disconnected';
        session.qrCodeBase64 = null;
        session.phone = null;
        await updateUnitInSupabase(unitId, 'disconnected', null);

        if (loggedOut) {
          await clearSession();
          delete sessions[unitId];
        } else {
          const retryMs = randomBetween(5000, 10000);
          setTimeout(() => startUnitWhatsApp(unitId, unitName), retryMs);
        }
      } else if (connection === 'open') {
        session.status = 'connected';
        session.qrCodeBase64 = null;
        session.phone = sock?.user?.id?.split(':')[0] || 'Conectado';
        await updateUnitInSupabase(unitId, 'connected', session.phone);
      }
    });

    // CAPTURA UNIVERSAL DE MENSAGENS (Sem ignorar notify/append)
    sock.ev.on('messages.upsert', async (m) => {
      for (const msg of m.messages) {
        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast') || remoteJid.includes('@newsletter')) continue;

        const text = extractMessageText(msg.message);
        if (!text) {
          logEvent({ status: 'ignored_empty_text', remoteJid, type: m.type });
          continue;
        }

        const rawPhone =
          msg.key.senderPn ||
          msg.key.participantPn ||
          msg.key.remoteJidAlt ||
          (remoteJid.includes('@lid') ? '' : remoteJid);
        const phone = String(rawPhone || remoteJid).split('@')[0].split(':')[0].replace(/\D/g, '');

        const fromMe = Boolean(msg.key.fromMe);
        const senderName = msg.pushName || 'Lead WhatsApp';

        if (!phone) continue;

        try {
          const whRes = await fetch(WEBHOOK_URL, {
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
          const whBody = await whRes.text();
          logEvent({
            status: 'delivered_to_crm_success',
            unitName,
            phone,
            text,
            fromMe,
            httpStatus: whRes.status,
            crmResponse: whBody.slice(0, 180)
          });
        } catch (err) {
          logEvent({ status: 'webhook_error', error: err.message });
        }
      }
    });
  } catch (err) {
    console.error(`[${unitName}] Erro Baileys:`, err.message);
  }
}

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
        startUnitWhatsApp(unit.id, unit.name);
        await sleep(2000);
      }
    }
  } catch (err) {
    console.error('Erro restore:', err.message);
  }
}

async function sendHumanizedMessage(unitId, targetJid, messageText) {
  const session = sessions[unitId];
  if (!session || session.status !== 'connected' || !session.sock) {
    throw new Error('Sessão desconectada.');
  }
  const sock = session.sock;

  await sleep(randomBetween(1200, 2500));

  try {
    await sock.presenceSubscribe(targetJid);
    await sock.sendPresenceUpdate('composing', targetJid);
  } catch {}

  const typingTimeMs = Math.min(Math.max(messageText.length * 35, 3000), 6500) + randomBetween(300, 1000);
  await sleep(typingTimeMs);

  try {
    await sock.sendPresenceUpdate('paused', targetJid);
  } catch {}

  await sleep(randomBetween(300, 700));

  const sentMsg = await sock.sendMessage(targetJid, { text: messageText });

  if (sentMsg?.key?.id) {
    sentMessagesCache.set(sentMsg.key.id, messageText);
    if (sentMessagesCache.size > 200) {
      const firstKey = sentMessagesCache.keys().next().value;
      sentMessagesCache.delete(firstKey);
    }
  }

  setTimeout(() => {
    try { sock.sendPresenceUpdate('unavailable'); } catch {}
  }, 5000);

  return sentMsg;
}

function enqueueUnitSend(unitId, taskFn) {
  if (!sendQueues[unitId]) {
    sendQueues[unitId] = Promise.resolve();
  }
  const nextTask = sendQueues[unitId].then(async () => {
    const result = await taskFn();
    await sleep(randomBetween(4000, 8000));
    return result;
  });
  sendQueues[unitId] = nextTask.catch(() => {});
  return nextTask;
}

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
          ${isConn ? `✅ Blindado (\${s.phone})` : '⚪ Desconectado'}
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
      <div style="display:flex;gap:24px;justify-content:center;flex-wrap:wrap;max-width:1000px;margin:30px auto;">
        ${cardsHtml}
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
        <a href="/" style="color:#94a3b8;text-decoration:none;">← Voltar</a>
        <h1 style="color:#22c55e;margin-top:25px;">✅ WhatsApp ${unit.name} Conectado!</h1>
        <p>Aparelho: <strong>${s.phone}</strong></p>
        <form method="POST" action="/logout/${unit.id}" style="margin-top:30px;">
          <button type="submit" style="padding:10px 20px;background:#ef4444;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:bold;">🔌 Desconectar</button>
        </form>
      </div>
    `);
  }

  if (s.status === 'qr_ready' && s.qrCodeBase64) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#fff;min-height:100vh;">
        <a href="/" style="color:#94a3b8;text-decoration:none;">← Voltar</a>
        <h1 style="color:#f97316;">📱 Conectar: ${unit.name}</h1>
        <div style="background:#fff;padding:20px;display:inline-block;border-radius:16px;margin-top:15px;">
          <img src="${s.qrCodeBase64}" style="width:280px;height:280px;" />
        </div>
        <script>setTimeout(() => location.reload(), 8000);</script>
      </div>
    `);
  }

  return res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
      <h2>⏳ Preparando conexão para ${unit.name}...</h2>
      <script>setTimeout(() => location.reload(), 3500);</script>
    </div>
  `);
});

app.post('/logout/:unitId', async (req, res) => {
  const unitId = req.params.unitId;
  const s = sessions[unitId];
  if (s?.sock) { try { await s.sock.logout(); } catch {} }
  if (s?.clearSession) { await s.clearSession(); }
  delete sessions[unitId];
  await updateUnitInSupabase(unitId, 'disconnected', null);
  res.redirect('/');
});

app.get('/status', (req, res) => {
  const summary = {};
  for (const [id, s] of Object.entries(sessions)) {
    summary[id] = { name: s.name, status: s.status, phone: s.phone };
  }
  res.json({
    active_sessions: Object.keys(sessions).length,
    units: summary,
    last_events: recentEvents
  });
});

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
      return res.status(400).json({ error: 'O WhatsApp desta unidade não está conectado.', unitId });
    }

    const sock = sessions[targetUnitId].sock;
    let cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone.startsWith('55')) cleanPhone = `55${cleanPhone}`;

    let targetJid = `${cleanPhone}@s.whatsapp.net`;
    const [result] = await sock.onWhatsApp(cleanPhone);
    if (result && result.exists) targetJid = result.jid;

    const sentMsg = await enqueueUnitSend(targetUnitId, () =>
      sendHumanizedMessage(targetUnitId, targetJid, message)
    );

    return res.json({
      status: 'sent_humanized',
      unitIdUsed: targetUnitId,
      to: targetJid,
      messageId: sentMsg?.key?.id
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Gateway rodando na porta ${PORT}`);
  restoreSavedSessionsFromSupabase();
});
