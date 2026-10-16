import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

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
const backupTimers = {};

const sentMessagesCache = new Map();
const recentAiTexts = new Set();
const processedMsgIds = new Set();
const lidToPhoneMap = new Map();
const msgRetryCounterMap = new Map();

let cachedUnits = [];
const recentEvents = [];

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const msgRetryCounterCache = {
  get: (key) => msgRetryCounterMap.get(key),
  set: (key, value) => {
    msgRetryCounterMap.set(key, value);
    if (msgRetryCounterMap.size > 1000) {
      const firstKey = msgRetryCounterMap.keys().next().value;
      msgRetryCounterMap.delete(firstKey);
    }
  },
  del: (key) => msgRetryCounterMap.delete(key),
  flushAll: () => msgRetryCounterMap.clear()
};

function setBoundedMap(map, key, value, maxSize = 1000) {
  map.set(key, value);
  if (map.size > maxSize) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

function addBoundedSet(set, value, maxSize = 1000) {
  set.add(value);
  if (set.size > maxSize) {
    const firstVal = set.values().next().value;
    set.delete(firstVal);
  }
}

function logEvent(info) {
  recentEvents.unshift({ time: new Date().toISOString(), ...info });
  if (recentEvents.length > 30) recentEvents.pop();
}

function extractMessageText(messageObj) {
  if (!messageObj) return '';
  const m =
    messageObj.ephemeralMessage?.message ||
    messageObj.viewOnceMessage?.message ||
    messageObj.viewOnceMessageV2?.message ||
    messageObj.documentWithCaptionMessage?.message ||
    messageObj.editedMessage?.message?.protocolMessage?.editedMessage ||
    messageObj;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  );
}

async function scheduleFolderBackupToSupabase(unitId, authFolder) {
  if (!SUPABASE_KEY || !unitId) return;
  if (backupTimers[unitId]) clearTimeout(backupTimers[unitId]);

  backupTimers[unitId] = setTimeout(async () => {
    try {
      if (!fs.existsSync(authFolder)) return;
      const files = fs.readdirSync(authFolder);
      const snapshot = {};
      for (const file of files) {
        const fullPath = path.join(authFolder, file);
        if (fs.statSync(fullPath).isFile()) {
          snapshot[file] = fs.readFileSync(fullPath, 'utf-8');
        }
      }
      if (Object.keys(snapshot).length === 0) return;

      await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify([
          {
            id: `snapshot__${unitId}`,
            unit_id: String(unitId),
            data: snapshot,
            updated_at: new Date().toISOString()
          }
        ])
      });
    } catch (err) {
      console.error(`[${unitId}] Erro no backup snapshot:`, err.message);
    }
  }, 5000);
}

async function restoreFolderFromSupabase(unitId, authFolder) {
  if (!SUPABASE_KEY || !unitId) return false;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/whatsapp_sessions?id=eq.${encodeURIComponent(`snapshot__\${unitId}`)}&select=data`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    const snapshot = rows?.[0]?.data;
    if (!snapshot || typeof snapshot !== 'object' || !snapshot['creds.json']) return false;

    fs.mkdirSync(authFolder, { recursive: true });
    for (const [fileName, content] of Object.entries(snapshot)) {
      if (typeof content === 'string') {
        fs.writeFileSync(path.join(authFolder, fileName), content, 'utf-8');
      }
    }
    return true;
  } catch (err) {
    console.error(`[${unitId}] Erro ao restaurar snapshot:`, err.message);
    return false;
  }
}

async function deleteSnapshotFromSupabase(unitId) {
  if (!SUPABASE_KEY || !unitId) return;
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

async function processIncomingMessage(unitId, unitName, key, messageObj, pushName) {
  const remoteJid = key?.remoteJid || '';
  if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast') || remoteJid.includes('@newsletter')) {
    return;
  }

  const msgId = key?.id;
  if (msgId && processedMsgIds.has(msgId)) return;

  if (!messageObj && key?.fromMe) return;

  if (msgId && sentMessagesCache.has(msgId)) {
    addBoundedSet(processedMsgIds, msgId);
    logEvent({ status: 'ignored_ai_outbound_echo_by_id', msgId });
    return;
  }

  if (!messageObj) {
    if (!key?.fromMe) {
      logEvent({ status: 'decrypt_retry_requested_lead', remoteJid, key });
    }
    return;
  }

  if (messageObj.protocolMessage || messageObj.senderKeyDistributionMessage || messageObj.reactionMessage) {
    return;
  }

  if (key.senderPn && remoteJid.includes('@lid')) {
    setBoundedMap(lidToPhoneMap, remoteJid, key.senderPn);
  }
  const mappedJid = lidToPhoneMap.get(remoteJid) || '';
  const rawPhone =
    key.senderPn ||
    key.participantPn ||
    key.remoteJidAlt ||
    mappedJid ||
    remoteJid;

  const phone = String(rawPhone).split('@')[0].split(':')[0].replace(/\D/g, '');
  const fromMe = Boolean(key.fromMe);
  const senderName = pushName || 'Lead WhatsApp';
  const text = extractMessageText(messageObj);

  if (!phone || !text) {
    if (!fromMe) {
      logEvent({ status: 'ignored_non_text', remoteJid, phone, keys: Object.keys(messageObj || {}) });
    }
    return;
  }

  const textSignature = text.trim().slice(0, 50);
  if (fromMe && recentAiTexts.has(textSignature)) {
    if (msgId) addBoundedSet(processedMsgIds, msgId);
    logEvent({ status: 'ignored_ai_outbound_echo_by_text', phone });
    return;
  }

  if (msgId) addBoundedSet(processedMsgIds, msgId);

  try {
    const whRes = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unitId,
        unitName,
        phone,
        remoteJid,
        senderName,
        message: text,
        fromMe
      })
    });
    const whBody = await whRes.text();
    logEvent({
      status: 'delivered_to_crm',
      unitName,
      phone,
      remoteJid,
      text,
      fromMe,
      httpStatus: whRes.status,
      crmResponse: whBody.slice(0, 180)
    });
  } catch (err) {
    logEvent({ status: 'webhook_error', error: err.message });
  }
}

async function startUnitWhatsApp(unitId, unitName = 'Unidade MULT') {
  if (!unitId) return;

  if (sessions[unitId] && (sessions[unitId].status === 'connected' || sessions[unitId].status === 'qr_ready')) {
    return sessions[unitId];
  }

  const authFolder = `./auth_info_${unitId}`;

  sessions[unitId] = {
    sock: null,
    qrCodeBase64: null,
    status: 'starting',
    phone: null,
    name: unitName,
    authFolder
  };

  const session = sessions[unitId];

  try {
    if (!fs.existsSync(authFolder)) {
      await restoreFolderFromSupabase(unitId, authFolder);
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache,
      getMessage: async (key) => {
        const cachedText = sentMessagesCache.get(key.id);
        if (cachedText) return { conversation: cachedText };
        return undefined;
      }
    });

    session.sock = sock;

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      scheduleFolderBackupToSupabase(unitId, authFolder);
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (c.lid && c.id) setBoundedMap(lidToPhoneMap, c.lid, c.id);
      }
    });

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
          try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch {}
          await deleteSnapshotFromSupabase(unitId);
          delete sessions[unitId];
        } else {
          const retryMs = randomBetween(4000, 8000);
          setTimeout(() => startUnitWhatsApp(unitId, unitName), retryMs);
        }
      } else if (connection === 'open') {
        session.status = 'connected';
        session.qrCodeBase64 = null;
        session.phone = sock?.user?.id?.split(':')[0] || 'Conectado';
        await updateUnitInSupabase(unitId, 'connected', session.phone);
        scheduleFolderBackupToSupabase(unitId, authFolder);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify' && m.type !== 'append') return;
      for (const msg of m.messages) {
        await processIncomingMessage(unitId, unitName, msg.key, msg.message, msg.pushName);
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const u of updates) {
        if (u.update?.message) {
          await processIncomingMessage(unitId, unitName, u.key, u.update.message, u.update.pushName || 'Lead WhatsApp');
        }
      }
    });
  } catch (err) {
    console.error(`[${unitName}] Erro Baileys:`, err.message);
  }
}

async function restoreAllSessionsOnBoot() {
  const units = await fetchUnitsFromSupabase();
  for (const unit of units) {
    const folder = `./auth_info_${unit.id}`;
    const hasLocal = fs.existsSync(folder);
    const restoredCloud = !hasLocal ? await restoreFolderFromSupabase(unit.id, folder) : true;

    if (hasLocal || restoredCloud) {
      startUnitWhatsApp(unit.id, unit.name);
      await sleep(1500);
    } else if (unit.whatsapp_status === 'connected') {
      await updateUnitInSupabase(unit.id, 'disconnected', null);
    }
  }
}

async function sendHumanizedMessage(unitId, targetJid, messageText) {
  const session = sessions[unitId];
  if (!session || session.status !== 'connected' || !session.sock) {
    throw new Error('Sessão da unidade desconectada.');
  }
  const sock = session.sock;

  const textKey = String(messageText || '').trim().slice(0, 50);
  if (textKey) {
    addBoundedSet(recentAiTexts, textKey);
    setTimeout(() => recentAiTexts.delete(textKey), 90000);
  }

  await sleep(randomBetween(1000, 2200));

  try {
    await sock.presenceSubscribe(targetJid);
    await sock.sendPresenceUpdate('composing', targetJid);
  } catch {}

  const typingTimeMs = Math.min(Math.max(messageText.length * 32, 2800), 6000) + randomBetween(200, 800);
  await sleep(typingTimeMs);

  try {
    await sock.sendPresenceUpdate('paused', targetJid);
  } catch {}

  await sleep(randomBetween(300, 600));

  const sentMsg = await sock.sendMessage(targetJid, { text: messageText });

  if (sentMsg?.key?.id) {
    setBoundedMap(sentMessagesCache, sentMsg.key.id, messageText, 300);
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
    try {
      const result = await taskFn();
      await sleep(randomBetween(4500, 8500));
      return result;
    } catch (err) {
      logEvent({ status: 'async_send_error', unitId, error: err.message });
    }
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
          ${isConn ? `✅ Conectado (\${s.phone})` : '⚪ Desconectado'}
        </p>
        <a href="/connect/${u.id}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:${isConn ? '#334155' : '#f97316'};color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">
          ${isConn ? 'Ver Status / Desconectar' : '📱 Gerar QR Code'}
        </a>
      </div>
    `;
  }).join('');

  res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
      <h1 style="color:#f97316;">🛡️ Central WhatsApp Multi-Unidades - MULT Profissões</h1>
      <p style="color:#94a3b8;margin-bottom:35px;">Motor Oficial v6 (Fila Assíncrona Instantânea + Snapshot Cloud + Anti-Echo):</p>
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
        <h1 style="color:#22c55e;margin-top:25px;">✅ WhatsApp ${unit.name} Conectado!</h1>
        <p style="font-size:18px;">Aparelho ativo: <strong>${s.phone}</strong></p>
        <form method="POST" action="/logout/${unit.id}" style="margin-top:30px;">
          <button type="submit" style="padding:10px 20px;background:#ef4444;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:bold;">
            🔌 Desconectar e Limpar Sessão
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
      <h2>⏳ Preparando conexão para ${unit.name}...</h2>
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
  if (s?.authFolder) {
    try { fs.rmSync(s.authFolder, { recursive: true, force: true }); } catch {}
  }
  await deleteSnapshotFromSupabase(unitId);
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
    engine: 'native_multifile_v6_async_queue_snapshot',
    active_sessions: Object.keys(sessions).length,
    webhook_url_configured: WEBHOOK_URL,
    units: summary,
    last_webhook_events: recentEvents
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
      return res.status(400).json({ error: 'O WhatsApp desta unidade não está conectado no momento.', unitId });
    }

    let cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone.startsWith('55') && cleanPhone.length <= 11) {
      cleanPhone = `55${cleanPhone}`;
    }

    const textKey = String(message || '').trim().slice(0, 50);
    if (textKey) {
      addBoundedSet(recentAiTexts, textKey);
      setTimeout(() => recentAiTexts.delete(textKey), 120000);
    }

    enqueueUnitSend(targetUnitId, async () => {
      const sock = sessions[targetUnitId]?.sock;
      if (!sock) return;

      const candidates = [cleanPhone];
      if (cleanPhone.length === 13 && cleanPhone[4] === '9') {
        candidates.push(cleanPhone.slice(0, 4) + cleanPhone.slice(5));
      } else if (cleanPhone.length === 12 && cleanPhone.startsWith('55')) {
        candidates.push(cleanPhone.slice(0, 4) + '9' + cleanPhone.slice(4));
      }

      let targetJid = `${cleanPhone}@s.whatsapp.net`;
      for (const num of candidates) {
        try {
          const [result] = await sock.onWhatsApp(num);
          if (result && result.exists) {
            targetJid = result.jid;
            break;
          }
        } catch {}
      }

      return await sendHumanizedMessage(targetUnitId, targetJid, message);
    });

    return res.status(200).json({
      status: 'queued_humanized',
      unitIdUsed: targetUnitId,
      unitName: sessions[targetUnitId].name,
      phone: cleanPhone
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Multi-Unidades v6 MULT CRM rodando na porta ${PORT}`);
  restoreAllSessionsOnBoot();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Porta ${PORT} já está em uso, reiniciando bind...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT, '0.0.0.0');
    }, 1000);
  } else {
    console.error('Erro no servidor HTTP:', e);
  }
});
