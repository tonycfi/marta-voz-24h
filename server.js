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

// --- Twilio SMS client ---
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- helpers ---
function nowInMadrid() {
  // Render usa UTC; esto fuerza hora española
  return new Date(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date())
  );
}

function isNightWindow(dateObj) {
  const h = dateObj.getHours();
  // noche: 22:00-08:00
  return h >= 22 || h < 8;
}

function dayPart(dateObj) {
  const h = dateObj.getHours();
  if (h >= 8 && h < 14) return "mañana";     // buenos días
  if (h >= 14 && h < 22) return "tarde";     // buenas tardes
  return "noche";                             // buenas noches
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
  const from = process.env.TWILIO_SMS_FROM; // tu número Twilio (E.164)
  if (!from) throw new Error("Falta TWILIO_SMS_FROM");
  return twilioClient.messages.create({ from, to, body });
}

// Página de prueba
app.get("/", (req, res) => res.send("Marta 24h está viva ✅"));

// 1) Webhook de entrada de llamada -> devolvemos TwiML que abre Media Stream a nuestro WS
app.post("/voice", (req, res) => {
  // Render va detrás de proxy; usamos host actual
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// --- Estado de llamada / ticket ---
function newTicket() {
  return {
    negocio: "Reparaciones Express 24h Costa del Sol",
    fechaHora: "",
    esNoche: false,
    parteDelDia: "",
    nombre: "",
    telefono: "",
    direccion: "",
    zona: "",
    servicio: "",
    averia: "",
    urgente: "",
    aceptoNocturno: null,
    resumen: ""
  };
}

// 2) WebSocket server para Twilio Media Streams
const server = app.listen(PORT, () => console.log("Listening on", PORT));
const wss = new WebSocketServer({ server, path: "/twilio-media" });

wss.on("connection", (twilioWs) => {
  const tNow = nowInMadrid();
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  const ticket = newTicket();
  ticket.fechaHora = tNow.toISOString();
  ticket.esNoche = night;
  ticket.parteDelDia = part;

  let callSid = "";
  let fromNumber = "";
  let transcript = ""; // iremos acumulando texto

  // Conexión a OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(process.env.REALTIME_MODEL || "gpt-4o-realtime-preview")}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

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
Luego despedida:
- si parte del día = mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- si parte del día = tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- si parte del día = noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."

IMPORTANTE: Al final de la llamada, genera un resumen interno con los campos del parte para enviar por SMS. No lo leas al cliente.
`;

  openaiWs.on("open", () => {
    // Configura sesión Realtime para Twilio (G.711 μ-law)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: baseInstructions + `\nContexto horario: es_noche=${night}, parte_del_dia=${part}.`,
          voice: process.env.REALTIME_VOICE || "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          modalities: ["audio", "text"],
          temperature: 0.4
        }
      })
    );

    // Fuerza saludo inicial
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Empieza con el saludo exacto del guion y espera respuesta.`
        }
      })
    );
  });

  // Recibe audio/texto de OpenAI y lo manda a Twilio
  openaiWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    // Audio hacia Twilio
    if (msg.type === "response.audio.delta") {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: msg.delta }
        })
      );
    }

    // Captura transcripciones / texto para formar el parte
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = msg.transcript || "";
      transcript += `\nCLIENTE: ${t}`;
    }
    if (msg.type === "response.output_text.delta") {
      // opcional: acumular texto de Marta
    }
  });

  openaiWs.on("close", () => {
    try { twilioWs.close(); } catch {}
  });

  openaiWs.on("error", (e) => console.error("OpenAI WS error", e));

  // Recibe eventos de Twilio (start/media/stop)
  twilioWs.on("message", async (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.event === "start") {
      callSid = data.start?.callSid || "";
      fromNumber = data.start?.customParameters?.From || ""; // a veces no viene aquí
    }

    if (data.event === "media") {
      // Audio μ-law base64 -> OpenAI input buffer
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload
          })
        );
      }
    }

    if (data.event === "stop") {
      // al colgar: extraemos parte y mandamos SMS
      try {
        const extracted = await extractTicket(transcript, night, part);
        const smsText = formatSms(extracted, callSid);
        await sendSms(process.env.ALERT_TO_NUMBER, smsText);
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error enviando SMS", e);
      } finally {
        try { openaiWs.close(); } catch {}
      }
    }
  });

  twilioWs.on("close", async () => {
    try { openaiWs.close(); } catch {}
  });
});

// Extraer parte con OpenAI (texto) para el SMS
async function extractTicket(transcript, night, part) {
  const model = process.env.EXTRACT_MODEL || "gpt-4o-mini";

  const prompt = `
Extrae un PARTE de servicio desde esta conversación (en español). Devuelve SOLO JSON válido.
Campos:
nombre, telefono, direccion, zona, servicio (uno de: fontanería/electricidad/cerrajería/persianas/electrodomésticos/pintura/mantenimiento), averia, urgente (si/no), aceptoNocturno (si/no/n-a), notas.

Reglas:
- Si night=${night} entonces aceptoNocturno debe ser si/no según si aceptó el recargo. Si no se menciona, pon "no".
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
      input: prompt
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI extract failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();
  const out = (json.output_text || "").trim();
  return JSON.parse(out);
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
