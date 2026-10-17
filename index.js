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
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || 'multZap2026!secret').trim();

const cleanUrl = (url) => String(url || '').replace(/\[.*?\]\((.*?)\)/g, '$1').replace(/\/+$/, '').trim();
const WEBHOOK_URL = cleanUrl(process.env.WEBHOOK_URL || 'https://multmanager.vercel.app/api/whatsapp-webhook');
const SUPABASE_URL = cleanUrl(process.env.SUPABASE_URL || 'https://mpzupaofcmuaiiitgzud.supabase.co');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/[\r\n\s]+/g, '');

const sessions = {};
const sendQueues = {};
const backupTimers = {};
const pendingRetryTimers = new Map();

const sentMessagesCache = new Map();
const recentAiTexts = new Set();
const processedMsgIds = new Set();
const lidToPhoneMap = new Map();
const phoneToLidMap = new Map();
const humanActiveContacts = new Map();
const msgRetryCounterMap = new Map();

let cachedUnits = [];
const recentEvents = [];
let lastBackupResult = 'none';

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const msgRetryCounterCache = {
  get: (key) => msgRetryCounterMap.get(key),
  set: (key, value) => {
    msgRetryCounterMap.set(key, value);
    if (msgRetryCounterMap.size > 1500) {
      const firstKey = msgRetryCounterMap.keys().next().value;
      msgRetryCounterMap.delete(firstKey);
    }
  },
  del: (key) => msgRetryCounterMap.delete(key),
  flushAll: () => msgRetryCounterMap.clear()
};

function setBoundedMap(map, key, value, maxSize = 1500) {
  map.set(key, value);
  if (map.size > maxSize) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

function addBoundedSet(set, value, maxSize = 1500) {
  set.add(value);
  if (set.size > maxSize) {
    const firstVal = set.values().next().value;
    set.delete(firstVal);
  }
}

function logEvent(info) {
  recentEvents.unshift({ time: new Date().toISOString(), ...info });
  if (recentEvents.length > 35) recentEvents.pop();
}

function getPhoneVariants(rawPhone) {
  const clean = String(rawPhone || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!clean) return [];
  const variants = new Set([clean]);
  if (!clean.startsWith('55') && (clean.length === 10 || clean.length === 11)) {
    variants.add(`55${clean}`);
  }
  for (const num of Array.from(variants)) {
    if (num.startsWith('55')) {
      if (num.length === 13 && num[4] === '9') {
        variants.add(num.slice(0, 4) + num.slice(5));
      } else if (num.length === 12) {
        variants.add(num.slice(0, 4) + '9' + num.slice(4));
      }
    }
  }
  return Array.from(variants);
}

function registerLidMapping(lidJid, phoneJid) {
  if (!lidJid || !phoneJid) return;
  const cleanLid = String(lidJid).trim();
  const cleanPhone = String(phoneJid).split('@')[0].split(':')[0].replace(/\D/g, '');
  if (cleanLid.includes('@lid') && cleanPhone.length >= 10) {
    setBoundedMap(lidToPhoneMap, cleanLid, cleanPhone, 1500);
    for (const v of getPhoneVariants(cleanPhone)) {
      setBoundedMap(phoneToLidMap, v, cleanLid, 1500);
    }
  }
}

// Cancela qualquer timer de fallback pendente para este contato quando um humano assume ou quando a mensagem abre
function cancelPendingFallbacksForContact(phone, remoteJid) {
  for (const [id, entry] of pendingRetryTimers.entries()) {
    if (
      (remoteJid && entry.remoteJid === remoteJid) ||
      (phone && entry.phone === phone)
    ) {
      clearTimeout(entry.timer);
      pendingRetryTimers.delete(id);
    }
  }
}

// Marca imediatamente o contato como em atendimento humano (bloqueia criação de card falso / IA por 24h)
function markContactAsHumanActive(phone, remoteJid) {
  const now = Date.now();
  cancelPendingFallbacksForContact(phone, remoteJid);
  if (remoteJid) {
    setBoundedMap(humanActiveContacts, String(remoteJid).trim(), now, 1500);
  }
  if (phone) {
    for (const v of getPhoneVariants(phone)) {
      setBoundedMap(humanActiveContacts, v, now, 1500);
      const mappedLid = phoneToLidMap.get(v);
      if (mappedLid) {
        setBoundedMap(humanActiveContacts, mappedLid, now, 1500);
      }
    }
  }
}

function isContactHumanActive(phone, remoteJid) {
  const ttlMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (remoteJid && humanActiveContacts.has(String(remoteJid).trim())) {
    if (now - humanActiveContacts.get(String(remoteJid).trim()) < ttlMs) return true;
  }
  if (phone) {
    for (const v of getPhoneVariants(phone)) {
      if (humanActiveContacts.has(v) && (now - humanActiveContacts.get(v) < ttlMs)) {
        return true;
      }
    }
  }
  return false;
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
      if (!snapshot['creds.json']) return;

      const res = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions?on_conflict=id`, {
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

      if (!res.ok) {
        const errTxt = await res.text();
        lastBackupResult = `error_http_${res.status}: ${errTxt.slice(0, 80)}`;
      } else {
        lastBackupResult = `ok (${Object.keys(snapshot).length} files at ${new Date().toISOString()})`;
      }
    } catch (err) {
      lastBackupResult = `exception: ${err.message}`;
    }
  }, 6000);
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
    lastBackupResult = `restored (${Object.keys(snapshot).length} files)`;
    return true;
  } catch (err) {
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
  } catch {}
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

async function forwardToCrmWebhook({ unitId, unitName, phone, remoteJid, senderName, text, fromMe }) {
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

    if (fromMe && whBody.includes('ignored_outbound_without_lead')) {
      markContactAsHumanActive(phone, remoteJid);
    }

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

async function processIncomingMessage(unitId, unitName, key, messageObj, pushName) {
  const remoteJid = key?.remoteJid || '';
  if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast') || remoteJid.includes('@newsletter')) {
    return;
  }

  if (key.senderPn && remoteJid.includes('@lid')) {
    registerLidMapping(remoteJid, key.senderPn);
  }
  if (key.remoteJidAlt && remoteJid.includes('@lid')) {
    registerLidMapping(remoteJid, key.remoteJidAlt);
  }

  const msgId = key?.id;
  if (msgId && processedMsgIds.has(msgId)) return;

  // Se foi enviada pelo WhatsApp da unidade, verifica se é eco da IA ou mensagem manual da equipe (ex: Camilla)
  const fromMe = Boolean(key.fromMe);

  if (msgId && sentMessagesCache.has(msgId)) {
    addBoundedSet(processedMsgIds, msgId, 1000);
    logEvent({ status: 'ignored_ai_outbound_echo_by_id', msgId });
    return;
  }

  const mappedPhone = lidToPhoneMap.get(remoteJid) || '';
  const rawPhone =
    key.senderPn ||
    key.participantPn ||
    key.remoteJidAlt ||
    mappedPhone ||
    (remoteJid.includes('@lid') ? '' : remoteJid);

  const phone = String(rawPhone).split('@')[0].split(':')[0].replace(/\D/g, '');
  const senderName = pushName || 'Lead WhatsApp';

  // SE FOR MENSAGEM MANUAL DA EQUIPE (fromMe: true):
  // Cancela imediatamente qualquer timer de fallback daquele contato e marca como atendimento humano!
  if (fromMe) {
    if (!messageObj) return;
    const text = extractMessageText(messageObj);
    const textSignature = String(text || '').trim().slice(0, 50);
    if (textSignature && recentAiTexts.has(textSignature)) {
      if (msgId) addBoundedSet(processedMsgIds, msgId, 1000);
      logEvent({ status: 'ignored_ai_outbound_echo_by_text', phone });
      return;
    }
    // É uma atendente humana (ex: Camilla) conversando! Protege esse contato imediatamente:
    markContactAsHumanActive(phone, remoteJid);
  }

  // SE FOR RESPOSTA DE UM CONTATO EM ATENDIMENTO HUMANO:
  // Nunca aciona fallback falso nem cria card novo por engano!
  if (!fromMe && isContactHumanActive(phone, remoteJid)) {
    cancelPendingFallbacksForContact(phone, remoteJid);
    if (!messageObj) {
      logEvent({ status: 'ignored_retry_on_human_chat', phone, remoteJid });
      return;
    }
  }

  if (!messageObj) {
    if (!fromMe) {
      logEvent({ status: 'decrypt_retry_waiting', remoteJid, phone, msgId });
      if (phone && msgId && !pendingRetryTimers.has(msgId) && !isContactHumanActive(phone, remoteJid)) {
        const timer = setTimeout(async () => {
          pendingRetryTimers.delete(msgId);
          if (processedMsgIds.has(msgId) || isContactHumanActive(phone, remoteJid)) return;
          addBoundedSet(processedMsgIds, msgId, 1000);
          logEvent({ status: 'lid_safe_fallback_to_crm', phone, remoteJid });
          await forwardToCrmWebhook({
            unitId,
            unitName,
            phone,
            remoteJid,
            senderName,
            text: 'Olá! Gostaria de saber mais informações sobre os cursos.',
            fromMe: false
          });
        }, 6000);
        pendingRetryTimers.set(msgId, { timer, phone, remoteJid });
      }
    }
    return;
  }

  if (msgId && pendingRetryTimers.has(msgId)) {
    clearTimeout(pendingRetryTimers.get(msgId).timer);
    pendingRetryTimers.delete(msgId);
  }
  cancelPendingFallbacksForContact(phone, remoteJid);

  if (messageObj.protocolMessage || messageObj.senderKeyDistributionMessage || messageObj.reactionMessage) {
    return;
  }

  const text = extractMessageText(messageObj);

  if (!phone || !text) {
    if (!fromMe) {
      logEvent({ status: 'ignored_non_text_or_unmapped_lid', remoteJid, phone });
    }
    return;
  }

  if (msgId) addBoundedSet(processedMsgIds, msgId, 1000);

  // Se o contato já foi marcado como conversa humana externa (sem card prévio), não envia ao CRM como novo lead
  if (!fromMe && isContactHumanActive(phone, remoteJid)) {
    logEvent({ status: 'blocked_reply_to_human_external_chat', phone, remoteJid, text });
    return;
  }

  await forwardToCrmWebhook({
    unitId,
    unitName,
    phone,
    remoteJid,
    senderName,
    text,
    fromMe
  });
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
      // CRÍTICO: markOnlineOnConnect: true mantém o canal Signal aberto para receber e enviar pre-keys sem "Aguardando mensagem"!
      markOnlineOnConnect: true,
      syncFullHistory: false,
      fireInitQueries: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 20000,
      msgRetryCounterCache,
      // CRÍTICO: Quando o celular do lead pede reenvio de pacote ("Aguardando mensagem"), devolve o proto exato!
      getMessage: async (key) => {
        const cachedText = sentMessagesCache.get(key.id);
        if (cachedText) {
          logEvent({ status: 'signal_retry_fulfilled_to_lead', msgId: key.id, remoteJid: key.remoteJid });
          return { conversation: cachedText };
        }
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
        if (c.lid && c.id) registerLidMapping(c.lid, c.id);
      }
    });

    sock.ev.on('contacts.update', (updates) => {
      for (const c of updates) {
        if (c.lid && c.id) registerLidMapping(c.lid, c.id);
      }
    });

    sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          if (c.lid && c.id) registerLidMapping(c.lid, c.id);
        }
      }
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (m?.key?.fromMe && m?.key?.remoteJid) {
            markContactAsHumanActive(m.key?.senderPn || m.key?.participantPn, m.key.remoteJid);
          }
        }
      }
      scheduleFolderBackupToSupabase(unitId, authFolder);
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
          const retryMs = randomBetween(3000, 6000);
          setTimeout(() => startUnitWhatsApp(unitId, unitName), retryMs);
        }
      } else if (connection === 'open') {
        session.status = 'connected';
        session.qrCodeBase64 = null;
        const rawUserId = sock?.user?.id || '';
        session.phone = rawUserId ? rawUserId.split(':')[0].split('@')[0] : 'Ativo';
        await updateUnitInSupabase(unitId, 'connected', session.phone);
        scheduleFolderBackupToSupabase(unitId, authFolder);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify' && m.type !== 'append') return;
      for (const msg of m.messages) {
        const msgTimestamp = Number(msg.messageTimestamp || 0);
        const nowSec = Math.floor(Date.now() / 1000);
        if (msgTimestamp > 0 && (nowSec - msgTimestamp) > 60) {
          if (msg.key?.fromMe) {
            markContactAsHumanActive(msg.key?.senderPn, msg.key?.remoteJid);
          }
          continue;
        }
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

// ENVIO COM ASSERT SESSIONS + SUPORTE HÍBRIDO (@LID E @S.WHATSAPP.NET) PARA ELIMINAR "AGUARDANDO MENSAGEM"
async function sendHumanizedMessage(unitId, targetJid, mappedLid, messageText) {
  const session = sessions[unitId];
  if (!session || session.status !== 'connected' || !session.sock) {
    throw new Error('Sessão da unidade desconectada.');
  }
  const sock = session.sock;

  const textKey = String(messageText || '').trim().slice(0, 50);
  if (textKey) {
    addBoundedSet(recentAiTexts, textKey, 500);
    setTimeout(() => recentAiTexts.delete(textKey), 90000);
  }

  // 1. Força o Baileys a buscar/validar as chaves públicas (PreKeyBundle) do destinatário antes de cifrar!
  const jidsToAssert = [targetJid];
  if (mappedLid && mappedLid !== targetJid) {
    jidsToAssert.push(mappedLid);
  }
  try {
    await sock.assertSessions(jidsToAssert, true);
  } catch {}

  await sleep(randomBetween(700, 1300));

  const activeChatJid = mappedLid || targetJid;

  try {
    await sock.presenceSubscribe(activeChatJid);
    await sock.sendPresenceUpdate('composing', activeChatJid);
  } catch {}

  const typingTimeMs = Math.min(Math.max(messageText.length * 24, 1800), 4000) + randomBetween(200, 500);
  await sleep(typingTimeMs);

  try {
    await sock.sendPresenceUpdate('paused', activeChatJid);
  } catch {}

  await sleep(randomBetween(200, 400));

  // 2. Envia a mensagem para o JID verificado após o assertSessions
  const sentMsg = await sock.sendMessage(targetJid, { text: messageText });

  if (sentMsg?.key?.id) {
    setBoundedMap(sentMessagesCache, sentMsg.key.id, messageText, 500);
  }

  // NÃO envia presenceUpdate('unavailable') para não cortar o canal de retry receipts do celular do lead!
  return sentMsg;
}

function enqueueUnitSend(unitId, taskFn) {
  if (!sendQueues[unitId]) {
    sendQueues[unitId] = Promise.resolve();
  }
  const nextTask = sendQueues[unitId].then(async () => {
    try {
      const result = await taskFn();
      await sleep(randomBetween(4000, 7500));
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
    const displayPhone = s.phone || u.whatsapp_number || 'Ativo';
    const statusLabel = isConn ? ('✅ Conectado (' + displayPhone + ')') : '⚪ Desconectado';

    return `
      <div style="background:#1e293b;padding:24px;border-radius:12px;width:290px;border:1px solid ${isConn ? '#22c55e' : '#334155'};">
        <h2 style="margin:0 0 10px 0;color:#f8fafc;font-size:20px;">📍 ${u.name}</h2>
        <p style="color:${isConn ? '#22c55e' : '#94a3b8'};font-weight:bold;min-height:24px;">
          ${statusLabel}
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
      <p style="color:#94a3b8;margin-bottom:35px;">Motor Oficial v7.0 (AssertSessions E2E + Anti-Invasão Humana Imediata):</p>
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
  const displayPhone = s.phone || unit.whatsapp_number || 'Ativo';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (s.status === 'connected') {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
        <a href="/" style="color:#94a3b8;text-decoration:none;">← Voltar para Todas as Unidades</a>
        <h1 style="color:#22c55e;margin-top:25px;">✅ WhatsApp ${unit.name} Conectado!</h1>
        <p style="font-size:18px;">Aparelho ativo: <strong>${displayPhone}</strong></p>
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
  try {
    const s = sessions[unitId];
    if (s?.sock) {
      try { s.sock.end(undefined); } catch {}
    }
    if (s?.authFolder) {
      try { fs.rmSync(s.authFolder, { recursive: true, force: true }); } catch {}
    }
    await deleteSnapshotFromSupabase(unitId);
    delete sessions[unitId];
    await updateUnitInSupabase(unitId, 'disconnected', null);
  } catch (err) {
    console.error('Erro no logout seguro:', err.message);
  }
  res.redirect('/');
});

app.get('/status', (req, res) => {
  const summary = {};
  for (const [id, s] of Object.entries(sessions)) {
    let fileCount = 0;
    try {
      if (s.authFolder && fs.existsSync(s.authFolder)) {
        fileCount = fs.readdirSync(s.authFolder).length;
      }
    } catch {}
    summary[id] = { name: s.name, status: s.status, phone: s.phone, auth_files_on_disk: fileCount };
  }
  const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  res.json({
    engine: 'native_multifile_v7.0_assert_sessions',
    memory_rss_mb: `${memMb} MB`,
    last_cloud_backup: lastBackupResult,
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
    const { phone, remoteJid, message, unitId } = req.body;

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
      addBoundedSet(recentAiTexts, textKey, 500);
      setTimeout(() => recentAiTexts.delete(textKey), 120000);
    }

    enqueueUnitSend(targetUnitId, async () => {
      const sock = sessions[targetUnitId]?.sock;
      if (!sock) return;

      const candidates = getPhoneVariants(cleanPhone);

      let mappedLid = remoteJid && String(remoteJid).includes('@lid') ? String(remoteJid).trim() : null;
      if (!mappedLid) {
        for (const num of candidates) {
          if (phoneToLidMap.has(num)) {
            mappedLid = phoneToLidMap.get(num);
            break;
          }
        }
      }

      let targetJid = `${cleanPhone}@s.whatsapp.net`;
      for (const num of candidates) {
        try {
          const [result] = await sock.onWhatsApp(num);
          if (result && result.exists && result.jid) {
            targetJid = result.jid;
            break;
          }
        } catch {}
      }

      const sent = await sendHumanizedMessage(targetUnitId, targetJid, mappedLid, message);
      logEvent({
        status: 'outbound_sent_ok',
        unitId: targetUnitId,
        targetJid,
        mappedLid: mappedLid || null,
        msgId: sent?.key?.id || null
      });
      return sent;
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
  console.log(`Servidor Multi-Unidades v7.0 MULT CRM rodando na porta ${PORT}`);
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
