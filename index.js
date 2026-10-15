import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || 'multZap2026!secret').trim();
const WEBHOOK_URL = (process.env.WEBHOOK_URL || 'https://multmanager.vercel.app/api/whatsapp-webhook').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://mpzupaofcmuaiiitgzud.supabase.co').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/[\r\n\s]+/g, '');

// Armazena as sessões ativas em memória por unit.id
const sessions = {};
let cachedUnits = [];

// Busca todas as unidades cadastradas na tabela 'units' do Supabase
async function fetchUnitsFromSupabase() {
  if (!SUPABASE_KEY) {
    console.warn('⚠️ SUPABASE_KEY não configurada no Render. Usando lista em cache.');
    return cachedUnits;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/units?select=id,name,whatsapp_status,whatsapp_number&order=name.asc`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) cachedUnits = data;
    }
  } catch (err) {
    console.error('Erro ao buscar unidades no Supabase:', err.message);
  }
  return cachedUnits;
}

// Atualiza o status do WhatsApp na tabela 'units' do Supabase
async function updateUnitInSupabase(unitId, status, phone = null) {
  if (!SUPABASE_KEY || !unitId) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/units?id=eq.${unitId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        whatsapp_status: status,
        whatsapp_number: phone
      })
    });
  } catch (_) {}
}

// Inicia o motor Baileys apenas para a unidade solicitada (Economia de RAM)
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
    name: unitName
  };

  const session = sessions[unitId];
  const authFolder = `./auth_info_${unitId}`;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: [`MULT CRM - ${unitName}`, 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    session.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.qrCodeBase64 = await QRCode.toDataURL(qr);
        session.status = 'qr_ready';
        console.log(`[${unitName}] QR Code pronto para leitura.`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        session.status = 'disconnected';
        session.qrCodeBase64 = null;
        session.phone = null;
        await updateUnitInSupabase(unitId, 'disconnected', null);

        if (loggedOut) {
          console.log(`[${unitName}] Aparelho desconectado pelo celular. Limpando sessão...`);
          try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (_) {}
          delete sessions[unitId]; // Libera a memória RAM!
        } else {
          setTimeout(() => startUnitWhatsApp(unitId, unitName), 4000);
        }
      } else if (connection === 'open') {
        session.status = 'connected';
        session.qrCodeBase64 = null;
        session.phone = sock?.user?.id?.split(':')[0] || 'Conectado';
        console.log(`[${unitName}] WhatsApp Conectado: ${session.phone}`);
        await updateUnitInSupabase(unitId, 'connected', session.phone);
      }
    });

    // Escuta mensagens recebidas e envia para a Vercel com o unitId exato do banco!
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message) continue;
        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) continue;

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

// Restaura automaticamente sessões que já tinham pasta salva no servidor
async function restoreSavedSessions() {
  const units = await fetchUnitsFromSupabase();
  for (const u of units) {
    if (fs.existsSync(`./auth_info_${u.id}`)) {
      console.log(`Restaurando sessão salva da unidade: ${u.name}`);
      startUnitWhatsApp(u.id, u.name);
    }
  }
}

// Painel Central Dinâmico (Puxa todas as unidades da tabela 'units' do Supabase)
app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const units = await fetchUnitsFromSupabase();

  if (!SUPABASE_KEY) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
        <h2 style="color:#ef4444;">⚠️ Falta configurar a variável SUPABASE_KEY no Render!</h2>
        <p style="color:#94a3b8;">Vá em Environment no Render e adicione SUPABASE_KEY com a chave do seu projeto.</p>
      </div>
    `);
  }

  const cardsHtml = units.map((u) => {
    const s = sessions[u.id] || { status: 'idle', phone: null };
    const isConn = s.status === 'connected';
    return `
      <div style="background:#1e293b;padding:24px;border-radius:12px;width:290px;border:1px solid ${isConn ? '#22c55e' : '#334155'};">
        <h2 style="margin:0 0 10px 0;color:#f8fafc;font-size:20px;">📍 ${u.name}</h2>
        <p style="color:${isConn ? '#22c55e' : '#94a3b8'};font-weight:bold;min-height:24px;">
          ${isConn ? `✅ Conectado (\${s.phone})` : '⚪ Desconectado (0 MB RAM)'}
        </p>
        <a href="/connect/${u.id}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:${isConn ? '#334155' : '#f97316'};color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">
          ${isConn ? 'Ver Status / Desconectar' : '📱 Gerar QR Code'}
        </a>
      </div>
    `;
  }).join('');

  res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
      <h1 style="color:#f97316;">🚀 Central Multi-Unidades - MULT Profissões</h1>
      <p style="color:#94a3b8;margin-bottom:35px;">Unidades sincronizadas automaticamente com o banco de dados do CRM:</p>
      <div style="display:flex;gap:24px;justify-content:center;flex-wrap:wrap;max-width:1000px;margin:0 auto;">
        ${cardsHtml || '<p>Nenhuma unidade encontrada na tabela units.</p>'}
      </div>
    </div>
  `);
});

// Tela de Conexão / QR Code Sob Demanda para a Unidade Escolhida
app.get('/connect/:unitId', async (req, res) => {
  const unitId = req.params.unitId;
  const units = await fetchUnitsFromSupabase();
  const unit = units.find((u) => String(u.id) === String(unitId));

  if (!unit) return res.status(404).send('Unidade não encontrada no Supabase.');

  // Só liga o motor na memória RAM quando alguém abre a tela para conectar!
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
        <p style="color:#94a3b8;">Todos os leads e Follow-ups desta linha estão vinculados à unidade <strong>${unit.name}</strong>.</p>
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
        <p style="color:#94a3b8;margin-top:20px;">A página atualiza sozinha a cada 8 segundos após escanear.</p>
        <script>setTimeout(() => location.reload(), 8000);</script>
      </div>
    `);
  }

  return res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
      <h2>⏳ Gerando QR Code para ${unit.name}...</h2>
      <script>setTimeout(() => location.reload(), 3500);</script>
    </div>
  `);
});

// Botão para desconectar uma unidade e liberar RAM
app.post('/logout/:unitId', async (req, res) => {
  const unitId = req.params.unitId;
  const s = sessions[unitId];
  if (s?.sock) {
    try { await s.sock.logout(); } catch (_) {}
  }
  try { fs.rmSync(`./auth_info_${unitId}`, { recursive: true, force: true }); } catch (_) {}
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

// Rota de Disparo Inteligente (Usa o chip da unitId do Lead + Resolvedor 9º dígito BR)
app.post('/send', async (req, res) => {
  const token = req.headers['apikey'] || req.headers['authorization']?.replace('Bearer ', '');
  if (token !== API_KEY) return res.status(401).json({ error: 'Não autorizado' });

  try {
    const { phone, message, unitId } = req.body;

    // 1. Procura a sessão exata da unitId do lead; se não vier unitId, usa a primeira conectada
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

    // Resolvedor automático do 9º dígito do Brasil
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

    const sentMsg = await sock.sendMessage(targetJid, { text: message });
    return res.json({
      status: 'sent',
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
  console.log(`Servidor Multi-Unidades Dinâmico MULT CRM rodando na porta ${PORT}`);
  restoreSavedSessions();
});
