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

function escapeXml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function nowInTZ() {
  // Render corre en UTC; esto fuerza la zona
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return new Date(s);
}

function isNightWindow(dateObj) {
  const h = dateObj.getHours();
  return h >= 22 || h < 8;
}

function dayPart(dateObj) {
  const h = dateObj.getHours();
  if (h >= 8 && h < 14) return "mañana";
  if (h >= 14 && h < 22) return "tarde";
  return "noche";
}

async function sendSms(to, body) {
  const from = process.env.TWILIO_SMS_FROM; // tu número Twilio (E.164)
  if (!from) throw new Error("Falta TWILIO_SMS_FROM");
  if (!to) throw new Error("Falta ALERT_TO_NUMBER");
  return twilioClient.messages.create({ from, to, body });
}

// Healthcheck
app.get("/", (req, res) => res.send("Marta 24h está viva ✅"));

// IMPORTANTE: Twilio hace POST aquí.
// Y el Stream debe usar track válido (inbound_track / outbound_track)
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" track="inbound_track" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// -----------------------------
// WebSocket server (Twilio Media Streams)
// -----------------------------
const server = app.listen(PORT, () => console.log("Listening on", PORT));
const wss = new WebSocketServer({ server, path: "/twilio-media" });

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

// Extraer parte con OpenAI (texto) para el SMS
async function extractTicket(transcript, night) {
  const model = process.env.EXTRACT_MODEL || "gpt-4o-mini";

  const prompt = `
Extrae un PARTE de servicio desde esta conversación (en español).
Devuelve SOLO JSON válido, sin texto alrededor.

Campos:
nombre, telefono, direccion, zona,
servicio (uno de: fontanería/electricidad/cerrajería/persianas/electrodomésticos/pintura/mantenimiento),
averia, urgente (si/no), aceptoNocturno (si/no/n-a), notas.

Reglas:
- Si night=${night} entonces aceptoNocturno debe ser si/no. Si no se menciona, "no".
- Si night=${night} es false, aceptoNocturno "n-a".
- Si no hay dato, deja "".

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

  // Si vino vacío, no petamos
  if (!out) {
    return {
      nombre: "", telefono: "", direccion: "", zona: "",
      servicio: "", averia: "", urgente: "", aceptoNocturno: night ? "no" : "n-a", notas: ""
    };
  }

  return JSON.parse(out);
}

wss.on("connection", (twilioWs) => {
  const tNow = nowInTZ();
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  let callSid = "";
  let streamSid = "";
  let transcript = "";
  let openaiWs = null;
  let openaiReady = false;
  let closed = false;

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
Despedida:
- mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."
`;

  function connectOpenAI() {
    if (closed) return;
    openaiReady = false;

    const model = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";

    console.log("🟢 Conectando OpenAI realtime...", { model });

    openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    openaiWs.on("open", () => {
      openaiReady = true;
      console.log("✅ OpenAI realtime conectado");

      openaiWs.send(JSON.stringify({
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
      }));

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
        return;
      }

      // AUDIO hacia Twilio
      if (msg.type === "response.audio.delta") {
        if (!streamSid) return;
        if (twilioWs.readyState !== WebSocket.OPEN) return;

        // ✅ FORMATO CORRECTO para Twilio
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta }
        }));
      }

      // Transcripción del cliente (si llega)
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const t = msg.transcript || "";
        transcript += `\nCLIENTE: ${t}`;
      }
    });

    // IMPORTANTÍSIMO: si OpenAI se cae, NO cuelgues la llamada
    openaiWs.on("close", (code, reason) => {
      openaiReady = false;
      console.log("🔵 OpenAI realtime cerrado", { code, reason: reason?.toString?.() });

      // Reintento suave
      if (!closed) {
        setTimeout(() => {
          if (!closed && twilioWs.readyState === WebSocket.OPEN) {
            connectOpenAI();
          }
        }, 800);
      }
    });

    openaiWs.on("error", (e) => {
      console.log("❌ OpenAI WS error", e?.message || e);
    });
  }

  // Conecta OpenAI al entrar
  connectOpenAI();

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
      // AUDIO del caller -> OpenAI
      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        }));
      }
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stop", { callSid, streamSid });

      // al colgar: extraemos parte y mandamos SMS
      try {
        const extracted = await extractTicket(transcript, night);
        const smsText = formatSms(extracted, callSid);
        await sendSms(process.env.ALERT_TO_NUMBER, smsText);
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error enviando SMS", e?.message || e);
      } finally {
        try { openaiWs?.close(); } catch {}
      }
    }
  });

  twilioWs.on("close", () => {
    closed = true;
    console.log("🔵 Twilio WS cerrado");
    try { openaiWs?.close(); } catch {}
  });

  twilioWs.on("error", (e) => {
    console.log("❌ Twilio WS error", e?.message || e);
  });
});
