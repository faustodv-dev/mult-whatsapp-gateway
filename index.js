import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || 'https://mpzupaofcmuaiiitgzud.supabase.co').trim();
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1wenVwYW9mY211YWlpaXRnenVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2Njc0MTgsImV4cCI6MjA4NjI0MzQxOH0.922R23c0I5-322_74f9I2N_bH35bS8i2X1i8R6A_bU0'
).replace(/[\r\n\s]+/g, '');

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').replace(/[\r\n\s]+/g, '');
const GATEWAY_URL = 'https://mult-whatsapp-gateway.onrender.com';
const GATEWAY_KEY = 'multZap2026!secret';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const OFFICIAL_COURSES = [
  'INFORMATICA',
  'ATENDENTE DE FARMACIA',
  'GESTAO ADMINISTRATIVA',
  'INGLES',
  'OPERADOR DE CAIXA',
  'MARKETING DIGITAL',
  'EJA / SUPLETIVO',
  'DESIGN GRAFICO',
  'MANUTENCAO DE COMPUTADORES',
  'EXCEL AVANCADO'
];

// Faz a classificação E já cria a mensagem de boas-vindas em UMA ÚNICA chamada rápida (evita Timeout na Vercel!)
async function analyzeAndWelcomeWithGemini(senderName, messageText, unitName, customInstructions) {
  const firstName = (senderName || 'Lead').split(' ')[0];
  const fallbackWelcome = `Olá, ${firstName}! Seja muito bem-vindo(a) à MULT Profissões (${unitName}). Vi que você demonstrou interesse em nossos cursos por aqui! Me conta uma coisa: esse curso que você está buscando é para você mesmo ou para incentivar alguém da família?`;

  if (!GEMINI_API_KEY) {
    return {
      cleanName: senderName || 'Lead WhatsApp',
      courses: ['A DEFINIR (TRIAGEM IA)'],
      welcomeMessage: fallbackWelcome
    };
  }

  try {
    const prompt = `Você é a consultora comercial e orientadora de carreira estrela da escola MULT Profissões (Unidade ${unitName}).
Analise o nome do contato no WhatsApp ("${senderName}") e a primeira mensagem recebida ("${messageText}").
Lista oficial de cursos: ${JSON.stringify(OFFICIAL_COURSES)}.
Instruções da unidade: ${customInstructions || 'Seja acolhedora, empática e natural.'}

Retorne APENAS um JSON válido no formato:
{
  "cleanName": "Nome Limpo do Lead",
  "courses": ["CURSO 1"],
  "welcomeMessage": "Mensagem curta de boas-vindas (máx 3 frases) seguindo o método S.C.O.T., sem passar valores, terminando com a pergunta de sondagem: se o curso é para ele(a) mesmo(a) ou para alguém da família."
}
Regras:
1. Se mencionar curso da lista, use o nome exato da lista em "courses". Se não mencionar curso claro, use ["A DEFINIR (TRIAGEM IA)"].
2. Se o nome do contato for apenas número ou emoji, use "Lead WhatsApp" em cleanName e diga apenas "Olá!" na saudação.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        cleanName: parsed.cleanName || senderName || 'Lead WhatsApp',
        courses: Array.isArray(parsed.courses) && parsed.courses.length ? parsed.courses : ['A DEFINIR (TRIAGEM IA)'],
        welcomeMessage: parsed.welcomeMessage || fallbackWelcome
      };
    }
  } catch (e) {
    console.error('Erro Gemini Webhook:', e.message);
  }

  return {
    cleanName: senderName || 'Lead WhatsApp',
    courses: ['A DEFINIR (TRIAGEM IA)'],
    welcomeMessage: fallbackWelcome
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'MULT WhatsApp Multi-Unit Webhook v2' });
  }

  try {
    const body = req.body || {};

    let phone = body.phone || body?.data?.key?.senderPn || body?.data?.key?.remoteJid || '';
    let senderName = body.senderName || body?.data?.pushName || 'Lead WhatsApp';
    let message =
      body.message ||
      body?.data?.message?.conversation ||
      body?.data?.message?.extendedTextMessage?.text ||
      '';
    const fromMe = Boolean(body.fromMe ?? body?.data?.key?.fromMe ?? false);
    const incomingUnitId = body.unitId || null;

    // Limpa sufixos do WhatsApp (@s.whatsapp.net, @lid, :0)
    phone = String(phone).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (phone.startsWith('55') && (phone.length === 12 || phone.length === 13)) {
      phone = phone.substring(2);
    }

    if (!phone || !message) {
      return res.status(200).json({ status: 'ignored', reason: 'Sem telefone ou texto válido' });
    }

    const { data: units } = await supabase.from('units').select('*');
    let targetUnit = null;
    if (incomingUnitId) {
      targetUnit = (units || []).find((u) => String(u.id) === String(incomingUnitId));
    }
    if (!targetUnit) {
      targetUnit = (units || []).find((u) => (u.name || '').toLowerCase().includes('rio verde')) || (units || [])[0];
    }

    const last8 = phone.slice(-8);
    let query = supabase.from('leads').select('*').ilike('whatsapp', `%${last8}%`);
    if (targetUnit?.id) {
      query = query.eq('unit_id', targetUnit.id);
    }
    const { data: existingLeads } = await query.limit(1);
    const existingLead = existingLeads?.[0];
    const nowIso = new Date().toISOString();

    if (!existingLead) {
      if (fromMe) {
        return res.status(200).json({ status: 'ignored_outbound_without_lead' });
      }

      // 1. Faz a triagem e prepara o texto em uma única chamada rápida (1.5s)
      const aiResult = await analyzeAndWelcomeWithGemini(
        senderName,
        message,
        targetUnit?.name || 'Rio Verde',
        targetUnit?.ai_custom_instructions
      );
      const coursesStr = aiResult.courses.join(', ');
      const newLeadId = Math.random().toString(36).substring(2, 12) + Date.now().toString(36);

      const shouldSendWelcome = targetUnit?.ai_welcome_enabled !== false;
      const initialNotes = [
        {
          id: Date.now().toString(),
          text: `📩 1ª Mensagem no WhatsApp (${targetUnit?.name || 'Unidade'}): "${message}"`,
          author: 'WhatsApp Automático',
          date: nowIso
        }
      ];

      if (shouldSendWelcome) {
        initialNotes.push({
          id: (Date.now() + 1).toString(),
          text: `🤖 Boas-vindas instantâneas enviadas no WhatsApp: "${aiResult.welcomeMessage}"`,
          author: 'Agente IA',
          date: nowIso
        });
      }

      // 2. SALVA O CARD IMEDIATAMENTE NO BANCO ANTES DE CHAMAR O GATEWAY (Zero risco de Timeout!)
      const { data: created, error: insertError } = await supabase
        .from('leads')
        .insert({
          id: newLeadId,
          name: aiResult.cleanName,
          whatsapp: phone,
          course: coursesStr,
          source: 'WHATSAPP',
          status: 'lead_recebido',
          unit_id: targetUnit?.id || null,
          seller_id: null,
          notes: JSON.stringify(initialNotes),
          ai_followup_enabled: true,
          ai_originated: true,
          last_interaction_at: nowIso,
          last_message_by: shouldSendWelcome ? 'ai' : 'lead',
          followup_stage: 0,
          ai_assisted: shouldSendWelcome
        })
        .select()
        .single();

      if (insertError) throw insertError;

      await supabase.from('ai_interactions_log').insert({
        id: Math.random().toString(36).substring(2, 12) + Date.now().toString(36),
        lead_id: created.id,
        unit_id: targetUnit?.id || null,
        action_type: shouldSendWelcome ? 'welcome_auto' : 'auto_create',
        message_sent: shouldSendWelcome ? aiResult.welcomeMessage : message,
        course_detected: coursesStr,
        lead_replied: false,
        created_at: nowIso
      });

      // 3. Dispara a mensagem no Gateway sem travar o salvamento do banco!
      if (shouldSendWelcome) {
        try {
          // Aguarda até no máximo 4s para dar tempo do request sair da Vercel, mas o Gateway processa em background
          await Promise.race([
            fetch(`${GATEWAY_URL}/send`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': GATEWAY_KEY
              },
              body: JSON.stringify({
                unitId: targetUnit?.id,
                phone: phone,
                message: aiResult.welcomeMessage
              })
            }),
            new Promise((resolve) => setTimeout(resolve, 4000))
          ]);
        } catch (e) {
          console.error('Aviso envio boas-vindas:', e.message);
        }
      }

      return res.status(200).json({
        status: 'created',
        unit: targetUnit?.name,
        lead_id: created.id,
        welcome_triggered: shouldSendWelcome,
        detected_courses: aiResult.courses
      });
    } else {
      // Lead já existe na unidade: atualiza histórico e move coluna se respondeu
      let notesArr = [];
      try {
        notesArr = existingLead.notes ? JSON.parse(existingLead.notes) : [];
        if (!Array.isArray(notesArr)) notesArr = [];
      } catch {
        notesArr = [];
      }

      notesArr.push({
        id: Date.now().toString(),
        text: fromMe
          ? `📤 Equipe enviou no WhatsApp: "${message}"`
          : `💬 Cliente respondeu no WhatsApp: "${message}"`,
        author: fromMe ? 'Equipe (WhatsApp)' : 'Lead (WhatsApp)',
        date: nowIso
      });

      let newStatus = existingLead.status;
      if (!fromMe) {
        if (existingLead.status === 'lead_recebido') {
          newStatus = 'respondeu_1_msg';
        } else if (['fup_1', 'fup_2', 'fup_3', 'respondeu_1_msg'].includes(existingLead.status)) {
          newStatus = 'engajou';
        }
      }

      const isRecovered = !fromMe && existingLead.last_message_by === 'ai';

      await supabase
        .from('leads')
        .update({
          status: newStatus,
          notes: JSON.stringify(notesArr),
          last_interaction_at: nowIso,
          last_message_by: fromMe ? 'seller' : 'lead',
          ai_recovered: isRecovered ? true : existingLead.ai_recovered,
          updated_at: nowIso
        })
        .eq('id', existingLead.id);

      if (!fromMe && existingLead.last_message_by === 'ai') {
        await supabase
          .from('ai_interactions_log')
          .update({ lead_replied: true, replied_at: nowIso })
          .eq('lead_id', existingLead.id)
          .eq('lead_replied', false);
      }

      return res.status(200).json({
        status: 'updated',
        unit: targetUnit?.name,
        lead_id: existingLead.id,
        new_status: newStatus
      });
    }
  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
