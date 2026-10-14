import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || 'multZap2026!secret').trim();
const WEBHOOK_URL = (process.env.WEBHOOK_URL || 'https://multmanager.vercel.app/api/whatsapp-webhook').trim();

let sock = null;
let qrCodeBase64 = null;
let connectionStatus = 'starting'; // 'starting' | 'qr_ready' | 'connected' | 'disconnected'
let connectedPhone = null;

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['MULT CRM Oficial', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCodeBase64 = await QRCode.toDataURL(qr);
        connectionStatus = 'qr_ready';
        console.log('Novo QR Code gerado e pronto para leitura.');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = 'disconnected';
        qrCodeBase64 = null;
        console.log('Conexão fechada. Reconectar?', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(startWhatsApp, 4000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        qrCodeBase64 = null;
        connectedPhone = sock?.user?.id?.split(':')[0] || 'Conectado';
        console.log('WhatsApp conectado com sucesso:', connectedPhone);
      }
    });

    // Escuta mensagens recebidas e envia para o Webhook na Vercel
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message) continue;
        const remoteJid = msg.key.remoteJid || '';
        // Ignora grupos e status
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
              phone,
              senderName,
              message: text,
              fromMe
            })
          });
          console.log(`Mensagem encaminhada ao CRM (${phone}): ${text.substring(0, 30)}`);
        } catch (err) {
          console.error('Erro ao acionar Webhook da Vercel:', err.message);
        }
      }
    });
  } catch (err) {
    console.error('Erro ao iniciar Baileys:', err);
    setTimeout(startWhatsApp, 5000);
  }
}

// Painel Visual Direto no Navegador para Ler o QR Code da Unidade
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (connectionStatus === 'connected') {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
        <h1 style="color:#22c55e;">✅ WhatsApp MULT CRM Conectado!</h1>
        <p style="font-size:18px;">Aparelho ativo: <strong>${connectedPhone}</strong></p>
        <p style="color:#94a3b8;">Todas as mensagens já estão sendo enviadas automaticamente para o Kanban na Vercel.</p>
      </div>
    `);
  }
  if (connectionStatus === 'qr_ready' && qrCodeBase64) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#fff;min-height:100vh;">
        <h1 style="color:#f97316;">📱 Conectar WhatsApp - MULT Profissões</h1>
        <p>Abra o WhatsApp da unidade > Aparelhos Conectados > Conectar um aparelho:</p>
        <div style="background:#fff;padding:20px;display:inline-block;border-radius:16px;margin-top:15px;">
          <img src="${qrCodeBase64}" style="width:280px;height:280px;" />
        </div>
        <p style="color:#94a3b8;margin-top:20px;">Atualize a página (F5) após escanear.</p>
        <script>setTimeout(() => location.reload(), 15000);</script>
      </div>
    `);
  }
  return res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;min-height:100vh;">
      <h2>⏳ Gerando QR Code... Aguarde alguns segundos.</h2>
      <script>setTimeout(() => location.reload(), 4000);</script>
    </div>
  `);
});

// Rota JSON de Status (para o painel do CRM consultar se quiser)
app.get('/status', (req, res) => {
  res.json({ status: connectionStatus, phone: connectedPhone, qr: qrCodeBase64 });
});

// Rota de Disparo de Mensagens (Usada pelos FUPs Automáticos da IA)
app.post('/send', async (req, res) => {
  const token = req.headers['apikey'] || req.headers['authorization']?.replace('Bearer ', '');
  if (token !== API_KEY) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(400).json({ error: 'WhatsApp não está conectado no momento.' });
  }

  try {
    const { phone, message } = req.body;
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const jid = cleanPhone.startsWith('55') ? `${cleanPhone}@s.whatsapp.net` : `55${cleanPhone}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    return res.json({ status: 'sent', to: jid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor MULT WhatsApp Gateway rodando na porta ${PORT}`);
  startWhatsApp();
});
