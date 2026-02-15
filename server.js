import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || "Europe/Madrid";

// ---- Validaciones mínimas al arrancar (te ahorra horas) ----
function must(name) {
  if (!process.env[name]) {
    console.error(`❌ Falta variable de entorno: ${name}`);
  }
}
must("OPENAI_API_KEY");
must("TWILIO_ACCOUNT_SID");
must("TWILIO_AUTH_TOKEN");
must("TWILIO_SMS_FROM");
must("ALERT_TO_NUMBER");

// --- Twilio SMS client ---
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- helpers ---
function nowInTZ() {
  // devuelve fecha “en esa zona horaria”, pero como Date.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  // Construimos un ISO “falso” pero consistente
  return new Date(`${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}.000Z`);
}

function isNightWindow(dateObj) {
  const h = dateObj.getUTCHours(); // ojo: dateObj ya está “convertido” arriba
  return h >= 22 || h < 8;
}

function dayPart(dateObj) {
  const h = dateObj.getUTCHours();
  if (h >= 8 && h < 14) return "mañana";
  if (h >= 14 && h < 22) return "tarde";
  return "noche";
}

function escapeXml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function sendSms(to, body) {
  const from = process.env.TWILIO_SMS_FROM;
  return twilioClient.messages.create({ from, to, body });
}

// Página de prueba
app.get("/", (req, res) => res.send("Marta 24h está viva ✅"));

// ✅ Webhook de llamada -> TwiML -> Media Stream a nuestro WS
app.post("/voice", (req, res) => {
  // Render suele pasar por proxy: preferimos x-forwarded-host si existe
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const wsUrl = `wss://${host}/twilio-media`;

  // ✅ CLAVE: NO usar track="both_tracks" (te daba 31941)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// --- Estado / ticket ---
function newTicket() {
  return {
    nombre: "",
    telefono: "",
    direccion: "",
    zona: "",
    servicio: "",
    averia: "",
    urgente: "",
    aceptoNocturno: "n-a",
    notas: ""
  };
}

function formatSms(t, callSid) {
  return [
    "🛠️ AVISO URGENCIA (MARTA)",
    `Servicio: ${t.servicio || "-"}`,
    `Nombre: ${t.nombre || "-"}`,
    `Tel: ${t.telefono || "-"}`,
    `Dirección: ${t.direccion || "-"}`,
    `Zona: ${t.zona || "-"}`,
    `Urgente: ${t.urgente || "-"}`,
    `Acepto nocturno: ${t.aceptoNocturno || "-"}`,
    `Avería: ${t.averia || "-"}`,
    `Notas: ${t.notas || "-"}`,
    callSid ? `CallSid: ${callSid}` : ""
  ].filter(Boolean).join("\n");
}

// 2) WebSocket server para Twilio Media Streams
const server = app.listen(PORT, () => console.log("✅ Listening on", PORT));
const wss = new WebSocketServer({ server, path: "/twilio-media" });

wss.on("connection", (twilioWs) => {
  console.log("🔌 Twilio WS conectado");

  const tNow = nowInTZ();
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  let callSid = "";
  let streamSid = "";
  let transcript = "";

  const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";
  const REALTIME_VOICE = process.env.REALTIME_VOICE || "alloy";

  const baseInstructions = `
Eres "Marta", asistente de urgencias de "Reparaciones Express 24h Costa del Sol". Hablas SIEMPRE en español neutro.
Objetivo: tomar datos y generar un parte. Mantén tono profesional, rápido, empático.

Servicios disponibles: fontanería, electricidad, cerrajería, persianas, electrodomésticos, pintura, mantenimiento.

Guion de apertura EXACTO:
"Hola, soy Marta, el asistente de urgencias de Reparación Express 24h. ¿En qué puedo ayudarte?"

Datos a recoger (en este orden, con preguntas cortas):
1) Nombre
2) Teléfono de contacto (confirmar si es el mismo desde el que llama)
3) Dirección completa (calle, número, portal/piso si aplica)
4) Zona/municipio (Costa del Sol)
5) Tipo de servicio (elige 1 de la lista)
6) Descripción breve de la avería y si hay urgencia o riesgo (agua/fuego/personas atrapadas)

Regla nocturna:
Si la llamada es entre 22:00 y 08:00 (hora España), di literalmente:
"Te informo: entre las 22:00 y las 08:00 la salida para ver la avería son 70€, y después la mano de obra nocturna suele estar entre 50€ y 70€ por hora, según el trabajo.
¿Lo aceptas para enviar al técnico?"
Si no acepta, ofrece tomar nota y que llamen en horario diurno.

Si es horario diurno NO menciones precios nocturnos.

Cierre obligatorio:
"Perfecto. Voy a enviar el aviso al técnico de guardia por WhatsApp ahora mismo y te llamará para confirmar disponibilidad y tiempo estimado."
Luego despedida según parte del día (mañana/tarde/noche).
IMPORTANTE: NO leas el resumen interno al cliente.
`;

  // Conexión a OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  openaiWs.on("open", () => {
    console.log("✅ OpenAI realtime conectado", { model: REALTIME_MODEL });

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: baseInstructions + `\nContexto horario: es_noche=${night}, parte_del_dia=${part}.`,
        voice: REALTIME_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        modalities: ["audio", "text"],
        temperature: 0.4
      }
    }));

    // Saludo inicial
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Empieza con el saludo exacto del guion y espera respuesta.`
      }
    }));
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // evitamos que muera por un chunk raro
    }

    // Audio hacia Twilio
    if (msg.type === "response.audio.delta") {
      if (!streamSid) return;
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: msg.delta }
      }));
    }

    // Transcripción del cliente
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = msg.transcript || "";
      if (t.trim()) transcript += `\nCLIENTE: ${t.trim()}`;
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🔌 OpenAI realtime cerrado", { code, reason: String(reason || "") });
    // Si OpenAI se cae, dejamos que Twilio cierre por su lado (evitamos loops raros)
    try { twilioWs.close(); } catch {}
  });

  openaiWs.on("error", (e) => {
    console.error("❌ OpenAI WS error", e?.message || e);
    try { twilioWs.close(); } catch {}
  });

  // Eventos de Twilio
  twilioWs.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      callSid = data.start?.callSid || "";
      streamSid = data.start?.streamSid || "";
      console.log("📞 Twilio start", { callSid, streamSid });
      return;
    }

    if (data.event === "media") {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        }));
      }
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stop", { callSid, streamSid });

      try {
        const extracted = await extractTicket(transcript, night);
        const smsText = formatSms(extracted, callSid);
        await sendSms(process.env.ALERT_TO_NUMBER, smsText);
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error enviando SMS", e?.message || e);
        // manda SMS mínimo para saber que hubo llamada
        try {
          const smsText = formatSms({
            ...newTicket(),
            notas: transcript.trim() ? "Error extrayendo parte" : "Sin transcripción (posible fallo de audio)"
          }, callSid);
          await sendSms(process.env.ALERT_TO_NUMBER, smsText);
        } catch {}
      } finally {
        try { openaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("🔌 Twilio WS cerrado");
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (e) => {
    console.error("❌ Twilio WS error", e?.message || e);
    try { openaiWs.close(); } catch {}
  });
});

// Extraer parte con OpenAI (texto) para el SMS
async function extractTicket(transcript, night) {
  const model = process.env.EXTRACT_MODEL || "gpt-4o-mini";

  // Si no hay transcripción, devolvemos ticket vacío con nota
  if (!transcript || !transcript.trim()) {
    return {
      ...newTicket(),
      aceptoNocturno: night ? "no" : "n-a",
      notas: "Sin transcripción (posible fallo de audio)"
    };
  }

  const prompt = `
Extrae un PARTE de servicio desde esta conversación (en español).
Devuelve SOLO JSON válido, sin texto extra.

Campos:
nombre, telefono, direccion, zona,
servicio (uno de: fontanería/electricidad/cerrajería/persianas/electrodomésticos/pintura/mantenimiento),
averia, urgente (si/no), aceptoNocturno (si/no/n-a), notas.

Reglas:
- Si night=${night} entonces aceptoNocturno debe ser si/no. Si no se menciona, pon "no".
- Si night=${night} es false, pon aceptoNocturno "n-a".
- Si no hay dato, deja string vacío.

TRANSCRIPCIÓN:
${transcript}
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt,
      // 🔒 ayuda a que salga JSON limpio
      response_format: { type: "json_object" }
    })
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI extract failed: ${resp.status} ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("OpenAI extract: respuesta no JSON");
  }

  const out = (json.output_text || "").trim();
  if (!out) throw new Error("OpenAI extract: output_text vacío");

  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`OpenAI extract: output_text no parseable: ${out.slice(0, 200)}`);
  }
}

// Evita que Render muera por errores sueltos
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
