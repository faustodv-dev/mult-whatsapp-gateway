import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || 'multZap2026!secret').trim();

const cleanUrl = (url) => String(url || '').replace(/\[.*?\]\((.*?)\)/g, '$1').replace(/\/+$/, '').trim();
const WEBHOOK_URL = cleanUrl(process.env.WEBHOOK_URL || 'https://multmanager.vercel.app/api/whatsapp-webhook');
const FOLLOWUP_CRON_URL = WEBHOOK_URL.replace('/api/whatsapp-webhook', '/api/ai-followup');
const SUPABASE_URL = cleanUrl(process.env.SUPABASE_URL || 'https://mpzupaofcmuaiiitgzud.supabase.co');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/[\r\n\s]+/g, '');

// ── v10: configurações OPCIONAIS (se não definidas no Render, nada muda) ─────────────────────────
const WEBHOOK_SHARED_SECRET = String(process.env.WEBHOOK_SHARED_SECRET || '').trim(); // mesmo valor da Vercel
const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim(); // protege painel/QR/logout/status (opcional)
const FUP_CRON_INTERVAL_MIN = Math.max(2, Number(process.env.FUP_CRON_INTERVAL_MIN) || 10);
const FUP_CRON_LIMIT = Math.min(20, Math.max(1, Number(process.env.FUP_CRON_LIMIT) || 3));
const BACKUP_INTERVAL_MIN = Math.max(5, Number(process.env.BACKUP_INTERVAL_MIN) || 60);
const MAX_SEND_QUEUE_PER_UNIT = Math.max(20, Number(process.env.MAX_SEND_QUEUE_PER_UNIT) || 300);
const BOOT_CLOUD_RESTORE_DELAY_MS =
  process.env.BOOT_CLOUD_RESTORE_DELAY_MS !== undefined && process.env.BOOT_CLOUD_RESTORE_DELAY_MS !== ''
    ? Math.max(0, Number(process.env.BOOT_CLOUD_RESTORE_DELAY_MS) || 0)
    : 20000;
const startedAtMs = Date.now();

if (API_KEY === 'multZap2026!secret') {
  console.warn('[seguranca] API_KEY está usando o valor padrão legado. Defina API_KEY no Render (e a mesma GATEWAY_KEY na Vercel) quando puder.');
}

const sessions = {};
const sendQueues = {};
const backupTimers = {};
const lastBackupTimestamp = {};
const pendingRetryTimers = new Map();

const sentProtoMessagesCache = new Map();
const recentAiTexts = new Set();
const processedMsgIds = new Set();
const lidToPhoneMap = new Map();
const phoneToLidMap = new Map();
const humanActiveContacts = new Map();
const msgRetryCounterMap = new Map();

let cachedUnits = [];
const recentEvents = [];
let lastBackupResult = 'none';
let lastAutoFupTriggerResult = 'waiting_first_tick';
let shuttingDown = false;
let activeSends = 0;
let fupCronInFlight = false;
const backupInFlight = {};
// v10.1: economia de banda do Render (plano free): só envia backup quando o conteúdo mudou
const lastBackupHash = {};
const lastBackupOkAt = {};
const BACKUP_FORCE_REFRESH_MS = 6 * 60 * 60 * 1000; // mesmo sem mudança, reenvia a cada 6 h (garante que a nuvem tem uma cópia)
const netStats = { backupBytes: 0, backupCount: 0, backupSkippedUnchanged: 0, webhookBytes: 0, webhookCount: 0 };
const pendingSendCount = {};
const sendResults = new Map();

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── v10: helpers de segurança (comparação em tempo constante, HTML seguro, cookie admin) ─────────
function safeEqual(a, b) {
  try {
    const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
    const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readCookie(req, name) {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

function secretHeaders() {
  return WEBHOOK_SHARED_SECRET
    ? { 'x-webhook-secret': WEBHOOK_SHARED_SECRET, Authorization: `Bearer ${WEBHOOK_SHARED_SECRET}` }
    : {};
}

// Sem ADMIN_KEY definido => tudo liberado (comportamento anterior). Com ADMIN_KEY => exige chave.
function isAdminAuthorized(req, res = null) {
  if (!ADMIN_KEY) return true;
  const apiHeader = req.headers['apikey'];
  if (apiHeader && safeEqual(apiHeader, API_KEY)) return true;
  const fromHeader = req.headers['x-admin-key'];
  if (fromHeader && safeEqual(fromHeader, ADMIN_KEY)) return true;
  const fromQuery = req.query?.key;
  if (fromQuery && safeEqual(fromQuery, ADMIN_KEY)) {
    if (res) {
      const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      res.setHeader('Set-Cookie', `mult_admin=${encodeURIComponent(ADMIN_KEY)}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`);
    }
    return true;
  }
  const fromCookie = readCookie(req, 'mult_admin');
  if (fromCookie && safeEqual(fromCookie, ADMIN_KEY)) return true;
  return false;
}

function adminGate(req, res) {
  if (isAdminAuthorized(req, res)) return true;
  res.status(401).send('Acesso restrito. Abra esta página uma vez com ?key=SUA_ADMIN_KEY.');
  return false;
}

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
  if (recentEvents.length > 100) recentEvents.pop();
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
    setBoundedMap(lidToPhoneMap, cleanLid, cleanPhone, 2000);
    for (const v of getPhoneVariants(cleanPhone)) {
      setBoundedMap(phoneToLidMap, v, cleanLid, 2000);
    }
  }
}

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

function markContactAsHumanActive(phone, remoteJid) {
  const now = Date.now();
  cancelPendingFallbacksForContact(phone, remoteJid);
  if (remoteJid) {
    setBoundedMap(humanActiveContacts, String(remoteJid).trim(), now, 2000);
  }
  if (phone) {
    for (const v of getPhoneVariants(phone)) {
      setBoundedMap(humanActiveContacts, v, now, 2000);
      const mappedLid = phoneToLidMap.get(v);
      if (mappedLid) {
        setBoundedMap(humanActiveContacts, mappedLid, now, 2000);
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

function extractAudioObject(messageObj) {
  if (!messageObj) return null;
  const m =
    messageObj.ephemeralMessage?.message ||
    messageObj.viewOnceMessage?.message ||
    messageObj.viewOnceMessageV2?.message ||
    messageObj;
  return m.audioMessage || null;
}

function extractMetaAdTracking(messageObj) {
  if (!messageObj) return null;
  const m =
    messageObj.ephemeralMessage?.message ||
    messageObj.viewOnceMessage?.message ||
    messageObj.viewOnceMessageV2?.message ||
    messageObj;

  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.conversation?.contextInfo ||
    null;

  const ad = ctx?.externalAdReply;
  if (!ad && !ctx?.conversionSource && !ctx?.entryPointConversionSource) return null;

  const ctwaClid = ad?.ctwaClid || ctx?.ctwaClid || null;
  const sourceId = ad?.sourceId || null;
  const adTitle = ad?.title || ad?.body || null;
  const adSourceUrl = ad?.sourceUrl || null;
  const conversionSource = ctx?.conversionSource || ctx?.entryPointConversionSource || ad?.sourceType || null;

  if (!ctwaClid && !sourceId && !adTitle && !adSourceUrl) return null;

  return {
    ctwaClid,
    sourceId,
    adTitle,
    adSourceUrl,
    conversionSource
  };
}

async function executeLeanBackupToSupabase(unitId, authFolder, opts = {}) {
  if (!SUPABASE_KEY || !unitId) return;
  // v10: nunca grava snapshot de sessão removida (logout) e nunca duas vezes em paralelo na mesma unidade
  if (!sessions[unitId] || backupInFlight[unitId]) return;
  backupInFlight[unitId] = true;
  try {
    if (!fs.existsSync(authFolder)) return;
    const allFiles = fs.readdirSync(authFolder);
    if (!allFiles.includes('creds.json')) return;

    const snapshot = {};
    const credsPath = path.join(authFolder, 'creds.json');
    const credsRaw = fs.readFileSync(credsPath, 'utf-8');

    // v10: não sobrescreve um bom snapshot com creds.json cortado (escrita em andamento) ou de sessão ainda não pareada
    let credsParsed = null;
    try { credsParsed = JSON.parse(credsRaw); } catch {}
    if (!credsParsed || !credsParsed.me) {
      lastBackupResult = `skipped_creds_not_ready at ${new Date().toISOString()}`;
      return;
    }
    snapshot['creds.json'] = credsRaw;

    const newestFiles = (filterFn, limit) =>
      allFiles
        .filter(filterFn)
        .map((f) => {
          const fullPath = path.join(authFolder, f);
          let mtime = 0;
          try {
            const st = fs.statSync(fullPath);
            if (st.isFile()) mtime = st.mtimeMs;
          } catch {}
          return { name: f, fullPath, mtime };
        })
        .filter((item) => item.mtime > 0)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit);

    const recentKeyFiles = newestFiles(
      (f) => f !== 'creds.json' && (f.startsWith('session-') || f.startsWith('app-state-sync-key-')),
      60
    );
    // v10: mapa LID→telefone do Baileys (arquivos minúsculos) sobrevive ao deploy
    const lidFiles = newestFiles((f) => f.startsWith('lid-mapping-'), 200);

    for (const item of [...recentKeyFiles, ...lidFiles]) {
      try {
        snapshot[item.name] = fs.readFileSync(item.fullPath, 'utf-8');
      } catch {}
    }

    // v10.1: conteúdo idêntico ao último backup bem-sucedido => não gasta banda
    const snapHash = crypto
      .createHash('sha1')
      .update(Object.keys(snapshot).sort().map((k) => k + '\u0000' + snapshot[k]).join('\u0001'))
      .digest('hex');
    if (
      !opts.force &&
      lastBackupHash[unitId] === snapHash &&
      Date.now() - (lastBackupOkAt[unitId] || 0) < BACKUP_FORCE_REFRESH_MS
    ) {
      netStats.backupSkippedUnchanged++;
      lastBackupResult = `skipped_unchanged at ${new Date().toISOString()}`;
      return;
    }

    const backupBody = JSON.stringify([
      {
        id: `snapshot__${unitId}`,
        unit_id: String(unitId),
        data: snapshot,
        updated_at: new Date().toISOString()
      }
    ]);

    const endpoint = SUPABASE_URL + '/rest/v1/whatsapp_sessions?on_conflict=id';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: backupBody,
      signal: AbortSignal.timeout(opts.timeoutMs || 25000)
    });

    lastBackupTimestamp[unitId] = Date.now();

    if (!res.ok) {
      const errTxt = await res.text();
      lastBackupResult = `error_http_${res.status}: ${errTxt.slice(0, 80)}`;
    } else {
      lastBackupHash[unitId] = snapHash;
      lastBackupOkAt[unitId] = Date.now();
      netStats.backupBytes += backupBody.length;
      netStats.backupCount++;
      lastBackupResult = `ok_lean (${Object.keys(snapshot).length} cloud / ${allFiles.length} local, ${Math.round(backupBody.length / 1024)} KB at ${new Date().toISOString()})`;
    }
  } catch (err) {
    lastBackupResult = `exception: ${err.message}`;
  } finally {
    backupInFlight[unitId] = false;
  }
}

function scheduleFolderBackupToSupabase(unitId, authFolder, forceImmediate = false) {
  if (!SUPABASE_KEY || !unitId) return;

  if (forceImmediate) {
    if (backupTimers[unitId]) {
      clearTimeout(backupTimers[unitId]);
      delete backupTimers[unitId];
    }
    executeLeanBackupToSupabase(unitId, authFolder);
    return;
  }

  if (backupTimers[unitId]) return;

  const lastRun = lastBackupTimestamp[unitId] || 0;
  const minIntervalMs = 45 * 60 * 1000;
  const elapsed = Date.now() - lastRun;
  const delayMs = elapsed > minIntervalMs ? 25000 : minIntervalMs;

  backupTimers[unitId] = setTimeout(async () => {
    delete backupTimers[unitId];
    await executeLeanBackupToSupabase(unitId, authFolder);
  }, delayMs);
}

async function restoreFolderFromSupabase(unitId, authFolder) {
  if (!SUPABASE_KEY || !unitId) return false;
  try {
    const snapId = `snapshot__${unitId}`;
    const endpoint = `${SUPABASE_URL}/rest/v1/whatsapp_sessions?id=eq.${encodeURIComponent(snapId)}&select=data`;
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(20000),
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    if (!res.ok) return false;
    const rows = await res.json();
    const snapshot = rows?.[0]?.data;
    if (!snapshot || typeof snapshot !== 'object' || !snapshot['creds.json']) return false;

    fs.mkdirSync(authFolder, { recursive: true });
    for (const [fileName, content] of Object.entries(snapshot)) {
      if (typeof content === 'string') {
        fs.writeFileSync(path.join(authFolder, path.basename(fileName)), content, 'utf-8');
      }
    }
    lastBackupResult = `restored (${Object.keys(snapshot).length} files)`;
    return true;
  } catch (err) {
    return false;
  }
}

async function deleteSnapshotFromSupabase(unitId) {
  delete lastBackupHash[unitId];
  delete lastBackupOkAt[unitId];
  if (!SUPABASE_KEY || !unitId) return;
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/whatsapp_sessions?unit_id=eq.${encodeURIComponent(String(unitId))}`,
      {
        method: 'DELETE',
        signal: AbortSignal.timeout(15000),
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
      { signal: AbortSignal.timeout(15000), headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
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
      body: JSON.stringify({ whatsapp_status: status, whatsapp_number: phone }),
      signal: AbortSignal.timeout(15000)
    });
  } catch {}
}

async function postToCrmWebhook(payload) {
  const headers = { 'Content-Type': 'application/json', ...secretHeaders() };
  const body = JSON.stringify(payload);
  const RETRYABLE_NET = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(58000) });
      const text = await res.text();
      netStats.webhookBytes += body.length;
      netStats.webhookCount++;
      // 429/502/503 = a Vercel nem chegou a processar: seguro repetir uma vez
      if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < 2) {
        await sleep(2500);
        continue;
      }
      return { res, body: text, attempt };
    } catch (err) {
      const code = err?.cause?.code || err?.code || '';
      if (attempt >= 2 || !RETRYABLE_NET.includes(code)) throw err;
      await sleep(2500);
    }
  }
  throw new Error('webhook_unreachable');
}

async function forwardToCrmWebhook({
  unitId,
  unitName,
  phone,
  remoteJid,
  senderName,
  text,
  audioBase64 = null,
  audioMimeType = null,
  adTracking = null,
  humanActive = false,
  fromMe
}) {
  try {
    const { res: whRes, body: whBody } = await postToCrmWebhook({
      unitId,
      unitName,
      phone,
      remoteJid,
      senderName,
      message: text,
      audioBase64,
      audioMimeType,
      adTracking,
      humanActive,
      fromMe
    });

    if (fromMe && whBody.includes('ignored_outbound_without_lead')) {
      markContactAsHumanActive(phone, remoteJid);
    }

    logEvent({
      status: audioBase64 ? 'audio_delivered_to_crm' : 'delivered_to_crm',
      unitName,
      phone,
      remoteJid,
      text: text || '[Áudio enviado p/ transcrição IA]',
      fromMe,
      humanActive,
      httpStatus: whRes.status,
      crmResponse: whBody.slice(0, 180)
    });
  } catch (err) {
    logEvent({ status: 'webhook_error', error: err.message });
  }
}

async function processIncomingMessage(unitId, unitName, fullMsg, sock) {
  const key = fullMsg?.key;
  const messageObj = fullMsg?.message;
  const pushName = fullMsg?.pushName;

  const remoteJid = key?.remoteJid || '';
  if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast') || remoteJid.includes('@newsletter')) {
    return;
  }

  const msgId = key?.id;

  if (key?.fromMe && msgId && messageObj) {
    setBoundedMap(sentProtoMessagesCache, msgId, messageObj, 800);
  }

  if (key.senderPn && remoteJid.includes('@lid')) {
    registerLidMapping(remoteJid, key.senderPn);
  }
  if (key.remoteJidAlt && remoteJid.includes('@lid')) {
    registerLidMapping(remoteJid, key.remoteJidAlt);
  }

  if (msgId && processedMsgIds.has(msgId)) return;

  const fromMe = Boolean(key.fromMe);

  // v10: após deploy o mapa LID→telefone (memória) zera; tenta recuperar do repositório do Baileys (se existir na versão instalada)
  if (remoteJid.includes('@lid') && !lidToPhoneMap.get(remoteJid) && !key.senderPn && !key.participantPn && !key.remoteJidAlt) {
    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
      if (pn) registerLidMapping(remoteJid, pn);
    } catch {}
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

  if (fromMe) {
    if (!messageObj) return;
    const text = extractMessageText(messageObj);
    const textSignature = String(text || '').trim().slice(0, 50);
    if (textSignature && recentAiTexts.has(textSignature)) {
      if (msgId) addBoundedSet(processedMsgIds, msgId, 1000);
      logEvent({ status: 'ignored_ai_outbound_echo_by_text', msgId, phone });
      return;
    }
    markContactAsHumanActive(phone, remoteJid);
  }

  const humanCurrentlyActive = isContactHumanActive(phone, remoteJid);

  if (!fromMe && humanCurrentlyActive) {
    cancelPendingFallbacksForContact(phone, remoteJid);
    if (!messageObj) {
      logEvent({ status: 'ignored_retry_on_human_chat', phone, remoteJid });
      return;
    }
  }

  if (!messageObj) {
    if (!fromMe) {
      logEvent({ status: 'decrypt_retry_waiting', remoteJid, phone, msgId });
      if (phone && msgId && !pendingRetryTimers.has(msgId) && !humanCurrentlyActive) {
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
        }, 6500);
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
  const audioObj = extractAudioObject(messageObj);
  const adTracking = !fromMe ? extractMetaAdTracking(messageObj) : null;
  let audioBase64 = null;
  let audioMimeType = null;

  if (!text && audioObj && !fromMe && phone) {
    const durationSec = Number(audioObj.seconds || 0);
    if (durationSec <= 95) {
      try {
        const buffer = await downloadMediaMessage(
          fullMsg,
          'buffer',
          {},
          { logger, reuploadRequest: sock?.updateMediaMessage }
        );
        if (buffer && buffer.length < 2.5 * 1024 * 1024) {
          audioBase64 = buffer.toString('base64');
          audioMimeType = audioObj.mimetype || 'audio/ogg';
        }
      } catch (audioErr) {
        logEvent({ status: 'audio_download_error', phone, error: audioErr.message });
      }
    }
  }

  if (!phone || (!text && !audioBase64)) {
    if (!fromMe) {
      logEvent({ status: 'ignored_non_text_or_unmapped_lid', remoteJid, phone });
    }
    return;
  }

  if (msgId) addBoundedSet(processedMsgIds, msgId, 1000);

  await forwardToCrmWebhook({
    unitId,
    unitName,
    phone,
    remoteJid,
    senderName,
    text,
    audioBase64,
    audioMimeType,
    adTracking,
    humanActive: humanCurrentlyActive,
    fromMe
  });
}

// v10: agenda a reconexão com backoff; ignora sockets antigos (substituídos) e respeita o desligamento do Render
function scheduleReconnect(unitId, unitName, session, statusCode) {
  if (shuttingDown || !session || session.superseded || sessions[unitId] !== session) return;
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;

  let retryMs;
  if (statusCode === DisconnectReason.restartRequired) {
    retryMs = randomBetween(500, 1500); // reinício exigido logo após parear o QR
  } else if (statusCode === DisconnectReason.connectionReplaced) {
    retryMs = randomBetween(25000, 40000); // outra instância assumiu (deploy em sobreposição): não brigar pela sessão
  } else if (session.reconnectAttempts <= 1) {
    retryMs = randomBetween(3000, 6000); // mesmo tempo de antes na 1ª queda
  } else {
    retryMs = Math.min(60000, randomBetween(3000, 6000) * 2 ** Math.min(session.reconnectAttempts - 1, 4));
  }

  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    if (shuttingDown || session.superseded || sessions[unitId] !== session) return;
    startUnitWhatsApp(unitId, unitName).catch(() => {});
  }, retryMs);

  logEvent({
    status: 'reconnect_scheduled',
    unitId,
    unitName,
    inMs: retryMs,
    attempt: session.reconnectAttempts,
    statusCode: statusCode ?? null
  });
}

async function startUnitWhatsApp(unitId, unitName = 'Unidade MULT') {
  if (!unitId || shuttingDown) return;

  const existing = sessions[unitId];
  if (existing && (existing.status === 'connected' || existing.status === 'qr_ready')) {
    return existing;
  }
  // v10: já há uma inicialização recente em andamento: não abre um 2º socket para a mesma sessão
  if (existing && existing.status === 'starting' && !existing.superseded && Date.now() - (existing.startedAt || 0) < 90000) {
    return existing;
  }

  const authFolder = `./auth_info_${unitId}`;
  const prevAttempts = existing?.reconnectAttempts || 0;

  if (existing) {
    existing.superseded = true;
    if (existing.reconnectTimer) {
      clearTimeout(existing.reconnectTimer);
      existing.reconnectTimer = null;
    }
    try { existing.sock?.end?.(undefined); } catch {}
  }

  sessions[unitId] = {
    sock: null,
    qrCodeBase64: null,
    status: 'starting',
    phone: null,
    name: unitName,
    authFolder,
    startedAt: Date.now(),
    reconnectAttempts: prevAttempts,
    reconnectTimer: null,
    superseded: false
  };

  const session = sessions[unitId];

  try {
    if (!fs.existsSync(authFolder)) {
      await restoreFolderFromSupabase(unitId, authFolder);
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    let version = null;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (verErr) {
      // v10: sem rede para consultar a versão? usa a versão embutida do Baileys em vez de travar a unidade
      logEvent({ status: 'baileys_version_lookup_failed', unitId, error: verErr.message });
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('Desktop'),
      markOnlineOnConnect: true,
      syncFullHistory: true,
      shouldSyncHistoryMessage: (msg) => {
        const sType = msg?.syncType;
        if (sType === undefined || sType === null) return true;
        return sType === 0 || sType === 1 || sType === 2 || sType === 3;
      },
      fireInitQueries: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 20000,
      msgRetryCounterCache,
      patchMessageBeforeSending: (message) => {
        const requiresPatch = !!(
          message.buttonsMessage ||
          message.templateMessage ||
          message.listMessage
        );
        if (requiresPatch) {
          message = {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadataVersion: 2,
                  deviceListMetadata: {}
                },
                ...message
              }
            }
          };
        }
        return message;
      },
      getMessage: async (key) => {
        const protoMsg = sentProtoMessagesCache.get(key.id);
        if (protoMsg) {
          logEvent({ status: 'signal_retry_fulfilled_exact_proto', msgId: key.id, remoteJid: key.remoteJid });
          return protoMsg;
        }
        return undefined;
      }
    });

    session.sock = sock;

    sock.ev.on('creds.update', async () => {
      try { await saveCreds(); } catch (e) { logEvent({ status: 'save_creds_error', unitId, error: e.message }); }
      scheduleFolderBackupToSupabase(unitId, authFolder, false);
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
      let mappedCount = 0;
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          if (c.lid && c.id) {
            registerLidMapping(c.lid, c.id);
            mappedCount++;
          }
        }
      }
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (m?.key?.fromMe && m?.key?.remoteJid) {
            markContactAsHumanActive(m.key?.senderPn || m.key?.participantPn, m.key.remoteJid);
          }
        }
      }
      logEvent({
        status: 'history_bootstrap_synced',
        contactsMapped: mappedCount,
        historyMessagesInspected: Array.isArray(messages) ? messages.length : 0
      });
      scheduleFolderBackupToSupabase(unitId, authFolder, false);
    });

    sock.ev.on('connection.update', async (update) => {
      // v10: ignora eventos de sockets antigos (já substituídos por um novo)
      if (session.superseded || sessions[unitId] !== session) return;
      try {
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
          logEvent({ status: 'connection_closed', unitId, unitName, statusCode: statusCode ?? null, loggedOut });

          if (loggedOut) {
            await updateUnitInSupabase(unitId, 'disconnected', null);
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch {}
            await deleteSnapshotFromSupabase(unitId);
            delete sessions[unitId];
          } else {
            // v10: agenda a reconexão ANTES de falar com o Supabase (uma lentidão lá não atrasa mais o retorno)
            scheduleReconnect(unitId, unitName, session, statusCode);
            await updateUnitInSupabase(unitId, 'disconnected', null);
          }
        } else if (connection === 'open') {
          session.status = 'connected';
          session.qrCodeBase64 = null;
          session.reconnectAttempts = 0;
          const rawUserId = sock?.user?.id || '';
          session.phone = rawUserId ? rawUserId.split(':')[0].split('@')[0] : 'Ativo';
          logEvent({ status: 'connection_open', unitId, unitName, phone: session.phone });
          await updateUnitInSupabase(unitId, 'connected', session.phone);
          scheduleFolderBackupToSupabase(unitId, authFolder, true);
        }
      } catch (err) {
        logEvent({ status: 'connection_update_error', unitId, error: err.message });
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (Array.isArray(m.messages)) {
        for (const msg of m.messages) {
          if (msg?.key?.fromMe && msg?.key?.id && msg?.message) {
            setBoundedMap(sentProtoMessagesCache, msg.key.id, msg.message, 800);
          }
        }
      }

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
        try {
          await processIncomingMessage(unitId, unitName, msg, sock);
        } catch (procErr) {
          logEvent({ status: 'process_message_error', unitId, error: procErr.message });
        }
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const u of updates) {
        if (u.update?.message) {
          try {
            await processIncomingMessage(
              unitId,
              unitName,
              { key: u.key, message: u.update.message, pushName: u.update.pushName || 'Lead WhatsApp' },
              sock
            );
          } catch (procErr) {
            logEvent({ status: 'process_message_error', unitId, error: procErr.message });
          }
        }
      }
    });
  } catch (err) {
    console.error(`[${unitName}] Erro Baileys:`, err.message);
    logEvent({ status: 'start_unit_error', unitId, unitName, error: err.message });
    // v10: antes a unidade ficava presa em "starting" para sempre; agora tenta de novo com backoff
    if (sessions[unitId] === session && !session.superseded) {
      session.status = 'disconnected';
      scheduleReconnect(unitId, unitName, session, null);
    }
  }
}

async function restoreAllSessionsOnBoot() {
  // v10: se o Supabase estiver instável no boot, tenta de novo (antes nenhuma unidade subia até o próximo restart)
  let units = [];
  for (let attempt = 1; attempt <= 8 && !shuttingDown; attempt++) {
    units = await fetchUnitsFromSupabase();
    if (units.length || !SUPABASE_KEY) break;
    logEvent({ status: 'boot_units_empty_retry', attempt });
    await sleep(15000);
  }

  // v10: no deploy do Render a instância antiga ainda está viva por alguns segundos. Quem precisa restaurar da nuvem espera um
  // pouco para ler o backup MAIS RECENTE (a antiga salva ao receber o SIGTERM) e para não disputar a sessão com ela.
  const needsCloudRestore = units.some((u) => !fs.existsSync(`./auth_info_${u.id}`));
  if (needsCloudRestore && BOOT_CLOUD_RESTORE_DELAY_MS > 0) {
    const remaining = BOOT_CLOUD_RESTORE_DELAY_MS - (Date.now() - startedAtMs);
    if (remaining > 0) {
      logEvent({ status: 'boot_waiting_for_old_instance', waitMs: remaining });
      await sleep(remaining);
    }
  }

  for (const unit of units) {
    if (shuttingDown) return;
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

// RELÓGIO DESPERTADOR INTERNO NATIVO (a cada 10 min aciona a régua automática de FUP na Vercel para as unidades conectadas)
async function triggerAutomatedFollowupCron() {
  // v10: nunca duas chamadas simultâneas (evita disparo duplicado quando a Vercel demora)
  if (shuttingDown || fupCronInFlight) return;
  fupCronInFlight = true;
  try {
    const hasConnectedUnit = Object.values(sessions).some((s) => s?.status === 'connected');
    if (!hasConnectedUnit) return;

    const nowBr = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const day = nowBr.getDay();
    const hour = nowBr.getHours();

    if (day === 0 || hour < 8 || hour >= 20 || (day === 6 && hour >= 14)) {
      return;
    }

    const res = await fetch(FOLLOWUP_CRON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...secretHeaders() },
      body: JSON.stringify({
        mode: 'cron_all_units',
        limit: FUP_CRON_LIMIT
      }),
      signal: AbortSignal.timeout(65000)
    });
    const data = await res.json().catch(() => ({}));
    lastAutoFupTriggerResult = res.ok
      ? `ok_sent_${data.sentCount || 0}_at_${new Date().toISOString()}`
      : `error_http_${res.status}_at_${new Date().toISOString()}`;
  } catch (err) {
    lastAutoFupTriggerResult = `error: ${err.message}`;
  } finally {
    fupCronInFlight = false;
  }
}

setInterval(triggerAutomatedFollowupCron, FUP_CRON_INTERVAL_MIN * 60 * 1000);

async function sendHumanizedMessage(unitId, targetJid, mappedLid, messageText) {
  messageText = String(messageText ?? '');
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

  await sleep(randomBetween(700, 1200));

  const activeChatJid = mappedLid || targetJid;

  try {
    await sock.presenceSubscribe(activeChatJid);
    await sock.sendPresenceUpdate('composing', activeChatJid);
  } catch {}

  const typingTimeMs = Math.min(Math.max(messageText.length * 24, 1800), 3800) + randomBetween(200, 500);
  await sleep(typingTimeMs);

  try {
    await sock.sendPresenceUpdate('paused', activeChatJid);
  } catch {}

  await sleep(randomBetween(200, 400));

  const sentMsg = await sock.sendMessage(targetJid, { text: messageText });

  if (sentMsg?.key?.id && sentMsg?.message) {
    setBoundedMap(sentProtoMessagesCache, sentMsg.key.id, sentMsg.message, 800);
    addBoundedSet(processedMsgIds, sentMsg.key.id, 1000);
  }

  return sentMsg;
}

function enqueueUnitSend(unitId, taskFn) {
  if (!sendQueues[unitId]) {
    sendQueues[unitId] = Promise.resolve();
  }
  pendingSendCount[unitId] = (pendingSendCount[unitId] || 0) + 1;
  const nextTask = sendQueues[unitId].then(async () => {
    try {
      activeSends++;
      let result;
      try {
        result = await taskFn();
      } finally {
        activeSends--;
      }
      await sleep(randomBetween(4000, 7500));
      return result;
    } catch (err) {
      logEvent({ status: 'async_send_error', unitId, error: err.message });
    } finally {
      pendingSendCount[unitId] = Math.max(0, (pendingSendCount[unitId] || 1) - 1);
    }
  });
  sendQueues[unitId] = nextTask.catch(() => {});
  return nextTask;
}

app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // v10: com ADMIN_KEY definida, o painel pede a chave (responde 200 para não derrubar health checks do Render)
  if (!isAdminAuthorized(req, res)) {
    return res.status(200).send('<div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;"><h1 style="color:#f97316;">🔒 Painel restrito</h1><p style="color:#94a3b8;">Abra esta página com <code>?key=SUA_ADMIN_KEY</code> uma vez.</p></div>');
  }
  const units = await fetchUnitsFromSupabase();

  const cardsHtml = units.map((u) => {
    const s = sessions[u.id] || { status: 'idle', phone: null };
    const isConn = s.status === 'connected';
    const displayPhone = s.phone || u.whatsapp_number || 'Ativo';
    const statusLabel = isConn ? ('✅ Conectado (' + displayPhone + ')') : '⚪ Desconectado';

    return `
      <div style="background:#1e293b;padding:24px;border-radius:12px;width:290px;border:1px solid ${isConn ? '#22c55e' : '#334155'};">
        <h2 style="margin:0 0 10px 0;color:#f8fafc;font-size:20px;">📍 ${escapeHtml(u.name)}</h2>
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
      <p style="color:#94a3b8;margin-bottom:35px;">Motor Oficial v10 (Strict Unit Session Isolation + Full History + Auto-FUP Cron + Deploy-Safe Sessions):</p>
      <div style="display:flex;gap:24px;justify-content:center;flex-wrap:wrap;max-width:1000px;margin:0 auto;">
        ${cardsHtml || '<p>Nenhuma unidade encontrada.</p>'}
      </div>
    </div>
  `);
});

// Rota amigável caso o gestor acesse /connect/:unitId/status no navegador
app.get('/connect/:unitId/status', (req, res) => {
  const unitId = req.params.unitId;
  const s = sessions[unitId] || { name: 'Unidade', status: 'disconnected', phone: null };
  res.json({
    unitId,
    name: s.name,
    status: s.status,
    phone: s.phone,
    last_cloud_backup: lastBackupResult,
    last_auto_fup_cron: lastAutoFupTriggerResult
  });
});

app.get('/connect/:unitId', async (req, res) => {
  if (!adminGate(req, res)) return;
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
        <h1 style="color:#22c55e;margin-top:25px;">✅ WhatsApp ${escapeHtml(unit.name)} Conectado!</h1>
        <p style="font-size:18px;">Aparelho ativo: <strong>${displayPhone}</strong></p>
        <form method="POST" action="/logout/${unit.id}" style="margin-top:30px;">
          <button type="submit" style="padding:10px 20px;background:#ef4444;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:bold;">
            🔌 Desconectar e Limpar Sessão (Resetar Chaves)
          </button>
        </form>
      </div>
    `);
  }

  if (s.status === 'qr_ready' && s.qrCodeBase64) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#fff;min-height:100vh;">
        <a href="/" style="color:#94a3b8;text-decoration:none;">← Voltar para Todas as Unidades</a>
        <h1 style="color:#f97316;margin-top:20px;">📱 Conectar Unidade: ${escapeHtml(unit.name)}</h1>
        <p>Abra o WhatsApp da unidade <strong>${escapeHtml(unit.name)}</strong> > Aparelhos Conectados > Conectar um aparelho:</p>
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
      <h2>⏳ Preparando conexão para ${escapeHtml(unit.name)}...</h2>
      <form method="POST" action="/logout/${unit.id}" style="margin-top:25px;">
        <button type="submit" style="padding:8px 16px;background:#475569;color:#fff;border:none;border-radius:6px;cursor:pointer;">
          Forçar Limpeza de Sessão Antiga e Gerar Novo QR
        </button>
      </form>
      <script>setTimeout(() => location.reload(), 4000);</script>
    </div>
  `);
});

app.post('/logout/:unitId', async (req, res) => {
  if (!adminGate(req, res)) return;
  const unitId = req.params.unitId;
  try {
    const s = sessions[unitId];
    if (s) {
      // v10: marca como substituída para o "close" deste socket não disparar uma reconexão duplicada
      s.superseded = true;
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    }
    if (s?.sock) {
      try { s.sock.end(undefined); } catch {}
    }
    const folder = s?.authFolder || `./auth_info_${unitId}`;
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
    await deleteSnapshotFromSupabase(unitId);
    delete sessions[unitId];
    await updateUnitInSupabase(unitId, 'disconnected', null);
  } catch (err) {
    console.error('Erro no logout seguro:', err.message);
  }
  res.redirect(`/connect/${unitId}`);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()), shutting_down: shuttingDown });
});

app.get('/status', (req, res) => {
  // v10: com ADMIN_KEY definida, quem não tem a chave vê só o resumo sem telefones nem eventos
  if (!isAdminAuthorized(req, res)) {
    const brief = {};
    for (const [id, s] of Object.entries(sessions)) brief[id] = { name: s.name, status: s.status };
    return res.json({ engine: 'native_multifile_v10_strict_unit_isolation', active_sessions: Object.keys(sessions).length, units: brief });
  }
  const summary = {};
  for (const [id, s] of Object.entries(sessions)) {
    let fileCount = 0;
    try {
      if (s.authFolder && fs.existsSync(s.authFolder)) {
        fileCount = fs.readdirSync(s.authFolder).length;
      }
    } catch {}
    summary[id] = { name: s.name, status: s.status, phone: s.phone, auth_files_on_disk: fileCount, reconnect_attempts: s.reconnectAttempts || 0 };
  }
  const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  res.json({
    engine: 'native_multifile_v10_strict_unit_isolation',
    memory_rss_mb: `${memMb} MB`,
    lid_mappings_in_memory: lidToPhoneMap.size,
    last_cloud_backup: lastBackupResult,
    last_auto_fup_cron: lastAutoFupTriggerResult,
    active_sessions: Object.keys(sessions).length,
    webhook_url_configured: WEBHOOK_URL,
    units: summary,
    last_webhook_events: recentEvents,
    uptime_s: Math.round(process.uptime()),
    shutting_down: shuttingDown,
    net_stats: (() => {
      const upH = Math.max(process.uptime() / 3600, 0.05);
      return {
        ...netStats,
        backup_interval_min: BACKUP_INTERVAL_MIN,
        backup_avg_kb: netStats.backupCount ? Math.round(netStats.backupBytes / netStats.backupCount / 102.4) / 10 : null,
        backup_projected_mb_month: Math.round((netStats.backupBytes / upH) * 24 * 30 / 1e6),
        webhook_projected_mb_month: Math.round((netStats.webhookBytes / upH) * 24 * 30 / 1e6),
        since_hours: Math.round(upH * 10) / 10
      };
    })(),
    send_queue_pending: pendingSendCount,
    security: {
      admin_key_enabled: Boolean(ADMIN_KEY),
      webhook_secret_enabled: Boolean(WEBHOOK_SHARED_SECRET),
      api_key_is_legacy_default: API_KEY === 'multZap2026!secret'
    }
  });
});

app.post('/send', async (req, res) => {
  const token = req.headers['apikey'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!safeEqual(token, API_KEY)) return res.status(401).json({ error: 'Não autorizado' });

  // v10: durante o deploy do Render o chamador recebe um erro claro (e pode reenviar), em vez de a mensagem se perder na fila
  if (shuttingDown) {
    return res.status(503).json({ status: 'error', error: 'Gateway reiniciando (deploy). Tente novamente em instantes.', retryable: true });
  }

  try {
    const { phone, remoteJid, message, unitId, waitForDelivery } = req.body || {};
    const requestedUnitId = unitId ? String(unitId).trim() : null;

    // ISOLAMENTO ESTRITO DE SESSÃO POR UNIDADE:
    // Exige que unitId seja informado e que a própria unidade esteja 'connected'.
    // NUNCA mais empresta o chip conectado de outra unidade!
    if (!requestedUnitId || requestedUnitId === 'master') {
      return res.status(400).json({
        status: 'error',
        error: 'Envio recusado: unitId da unidade é obrigatório.'
      });
    }

    const unitSession = sessions[requestedUnitId];
    if (!unitSession || unitSession.status !== 'connected' || !unitSession.sock) {
      logEvent({
        status: 'blocked_send_unit_disconnected',
        unitId: requestedUnitId,
        unitName: unitSession?.name || requestedUnitId,
        phone
      });
      return res.status(400).json({
        status: 'error',
        error: `O WhatsApp da unidade (${unitSession?.name || requestedUnitId}) não está conectado no momento.`,
        unitId: requestedUnitId
      });
    }

    let cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone.startsWith('55') && cleanPhone.length <= 11) {
      cleanPhone = `55${cleanPhone}`;
    }

    const messageText = String(message ?? '');
    if (!messageText.trim()) {
      return res.status(400).json({ status: 'error', error: 'Mensagem vazia.' });
    }
    if (cleanPhone.length < 10) {
      return res.status(400).json({ status: 'error', error: 'Telefone inválido.' });
    }
    if ((pendingSendCount[requestedUnitId] || 0) >= MAX_SEND_QUEUE_PER_UNIT) {
      return res.status(429).json({ status: 'error', error: 'Fila de envio da unidade cheia. Tente novamente em instantes.', retryable: true });
    }

    const textKey = messageText.trim().slice(0, 50);
    if (textKey) {
      addBoundedSet(recentAiTexts, textKey, 500);
      setTimeout(() => recentAiTexts.delete(textKey), 120000);
    }

    // v10: cada envio ganha um requestId para confirmar a entrega real (waitForDelivery ou GET /send/status/:id)
    const requestId = crypto.randomUUID();
    const track = (rec) =>
      setBoundedMap(
        sendResults,
        requestId,
        { requestId, unitId: requestedUnitId, phone: cleanPhone, at: new Date().toISOString(), ...rec },
        500
      );
    track({ status: 'queued' });
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const finish = (rec) => { track(rec); settle(rec); };

    enqueueUnitSend(requestedUnitId, async () => {
      try {
        const sock = sessions[requestedUnitId]?.sock;
        if (!sock || sessions[requestedUnitId]?.status !== 'connected') {
          finish({ status: 'failed', error: 'unit_disconnected_before_send' });
          return;
        }

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
        let jidVerified = false;
        for (const num of candidates) {
          try {
            const [result] = await sock.onWhatsApp(num);
            if (result && result.exists && result.jid) {
              targetJid = result.jid;
              jidVerified = true;
              break;
            }
          } catch {}
        }

        const sent = await sendHumanizedMessage(requestedUnitId, targetJid, mappedLid, messageText);
        logEvent({
          status: 'outbound_sent_ok',
          unitId: requestedUnitId,
          unitName: sessions[requestedUnitId]?.name,
          targetJid,
          mappedLid: mappedLid || null,
          jidVerified,
          msgId: sent?.key?.id || null
        });
        finish({ status: 'sent', msgId: sent?.key?.id || null, targetJid, jidVerified });
        return sent;
      } catch (err) {
        finish({ status: 'failed', error: err.message });
        throw err;
      }
    });

    const base = {
      unitIdUsed: requestedUnitId,
      unitName: unitSession.name,
      phone: cleanPhone,
      requestId
    };

    if (waitForDelivery === true || waitForDelivery === 'true') {
      const rec = await Promise.race([done, sleep(45000).then(() => null)]);
      if (rec?.status === 'sent') return res.status(200).json({ status: 'sent', ...base, msgId: rec.msgId, jidVerified: rec.jidVerified });
      if (rec?.status === 'failed') return res.status(502).json({ status: 'error', ...base, error: rec.error });
      return res.status(200).json({ status: 'queued_humanized', ...base, delivery: 'pending' });
    }

    return res.status(200).json({ status: 'queued_humanized', ...base });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/send/status/:requestId', (req, res) => {
  const token = req.headers['apikey'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!safeEqual(token, API_KEY)) return res.status(401).json({ error: 'Não autorizado' });
  const rec = sendResults.get(String(req.params.requestId || ''));
  if (!rec) return res.status(404).json({ status: 'unknown' });
  return res.json(rec);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Multi-Unidades v10 MULT CRM rodando na porta ${PORT}`);
  restoreAllSessionsOnBoot().catch((e) => console.error('Erro no restore de sessões no boot:', e?.message));
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

// ───────────────────────────────────────────────────────────────────────────────────────────────
// v10: BLINDAGEM DE CICLO DE VIDA (deploy no Render, quedas e processos pendurados)
// ───────────────────────────────────────────────────────────────────────────────────────────────

// Evita keep-alive curto demais do Node derrubar requisições vindas do proxy do Render (502 intermitente)
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Nenhum erro isolado derruba o processo (e, com ele, todas as sessões)
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  console.error('[unhandledRejection]', msg);
  logEvent({ status: 'unhandled_rejection', error: String(msg).slice(0, 200) });
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err);
  logEvent({ status: 'uncaught_exception', error: String(err?.message || err).slice(0, 200) });
});

// Backup periódico das sessões conectadas: um deploy perde no máximo alguns minutos de chaves (antes: até 45 min)
setInterval(() => {
  if (shuttingDown) return;
  for (const [unitId, s] of Object.entries(sessions)) {
    if (s?.status === 'connected' && s.authFolder) {
      executeLeanBackupToSupabase(unitId, s.authFolder).catch(() => {});
    }
  }
}, BACKUP_INTERVAL_MIN * 60 * 1000);

// Vigia: destrava unidades presas e religa quem ficou "disconnected" sem reconexão agendada
let watchdogTick = 0;
async function sessionWatchdog() {
  if (shuttingDown) return;
  watchdogTick++;
  const now = Date.now();

  for (const [unitId, s] of Object.entries(sessions)) {
    if (!s) continue;
    if (s.status === 'starting' && now - (s.startedAt || now) > 180000) {
      logEvent({ status: 'watchdog_restart_stuck_start', unitId, unitName: s.name });
      startUnitWhatsApp(unitId, s.name).catch(() => {});
    } else if (s.status === 'disconnected' && !s.reconnectTimer) {
      logEvent({ status: 'watchdog_reconnect', unitId, unitName: s.name });
      scheduleReconnect(unitId, s.name, s, null);
    }
  }

  // ~6 min: unidade pareada (credenciais no disco) sem sessão em memória volta sozinha
  if (watchdogTick % 3 === 0) {
    try {
      const units = await fetchUnitsFromSupabase();
      for (const u of units) {
        if (sessions[u.id]) continue;
        if (fs.existsSync(path.join(`./auth_info_${u.id}`, 'creds.json'))) {
          logEvent({ status: 'watchdog_start_missing_session', unitId: u.id, unitName: u.name });
          startUnitWhatsApp(u.id, u.name).catch(() => {});
        }
      }
    } catch {}
  }
}
setInterval(() => { sessionWatchdog().catch(() => {}); }, 2 * 60 * 1000);

// Deploy do Render = SIGTERM. Termina os envios em andamento, SALVA as sessões na nuvem e sai SEM deslogar o WhatsApp.
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}: finalizando envios e salvando sessões na nuvem...`);
  logEvent({ status: 'shutdown_started', signal });
  const hardExit = setTimeout(() => process.exit(0), 22000);
  try {
    for (const id of Object.keys(backupTimers)) {
      clearTimeout(backupTimers[id]);
      delete backupTimers[id];
    }
    for (const s of Object.values(sessions)) {
      if (s?.reconnectTimer) clearTimeout(s.reconnectTimer);
    }

    const t0 = Date.now();
    while (activeSends > 0 && Date.now() - t0 < 6000) await sleep(250);
    const t1 = Date.now();
    while (Object.values(backupInFlight).some(Boolean) && Date.now() - t1 < 8000) await sleep(200);

    const jobs = [];
    for (const [unitId, s] of Object.entries(sessions)) {
      // só salva quem está de fato conectado (uma sessão derrubada por outra instância não pode sobrescrever o backup mais novo)
      if (s?.status === 'connected' && s.authFolder) {
        jobs.push(executeLeanBackupToSupabase(unitId, s.authFolder, { timeoutMs: 8000 }));
      }
    }
    await Promise.allSettled(jobs);
    console.log(`[shutdown] backup final: ${lastBackupResult}`);
  } catch (err) {
    console.error('[shutdown] erro:', err?.message);
  }
  try { server.close(); } catch {}
  clearTimeout(hardExit);
  process.exit(0);
}
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
