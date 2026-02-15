import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

dotenv.config();

const app = express();
app.set("trust proxy", true); // importante en Render
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || "Europe/Madrid";

// --- Twilio SMS client ---
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function escapeXml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function nowInTZ() {
  // devuelve Date “aproximada” con hora TZ (suficiente para ventana noche)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  // Construimos ISO local-like
  const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  return new Date(iso);
}

function isNightWindow(dateObj) {
  const h = dateObj.getHours();
  return h >= 22 || h < 8; // 22:00-08:00
}

function dayPart(dateObj) {
  const h = dateObj.getHours();
  if (h >= 8 && h < 14) return "mañana";
  if (h >= 14 && h < 22) return "tarde";
  return "noche";
}

async function sendSms(to, body) {
  const from = process.env.TWILIO_SMS_FROM;
  if (!from) throw new Error("Falta TWILIO_SMS_FROM");
  return twilioClient.messages.create({ from, to, body });
}

// Página de prueba
app.get("/", (req, res) => res.send("Marta 24h está viva ✅"));

// Webhook de entrada de llamada -> TwiML abre Media Stream a nuestro WS
app.post("/voice", (req, res) => {
  // Render detrás de proxy
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers["host"] ||
    req.get("host");

  const wsUrl = `wss://${host}/twilio-media`;

  // Pasamos parámetros útiles a "start.customParameters"
  // OJO: no ponemos track (te daba "Invalid Track configuration").
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}">
      <Parameter name="From" value="${escapeXml(req.body?.From || "")}" />
      <Parameter name="To" value="${escapeXml(req.body?.To || "")}" />
      <Parameter name="CallSid" value="${escapeXml(req.body?.CallSid || "")}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---- Servidor HTTP ----
const server = app.listen(PORT, () => console.log("Listening on", PORT));

// ---- WebSocket Server (Twilio Media Streams) ----
const wss = new WebSocketServer({ server, path: "/twilio-media" });

// Base instructions (muy explícitas para que NO busque técnicos externos)
function buildInstructions({ night, part }) {
  return `
Eres "Marta", asistente de urgencias de "Reparaciones Express 24h Costa del Sol".
Hablas SIEMPRE en español neutro.
NO recomiendes buscar técnicos externos, ni directorios, ni "buscar uno cerca".
SIEMPRE trabajamos con NUESTRO técnico de guardia (interno).

Objetivo: tomar datos y generar un parte. Tono profesional, rápido, empático.

Servicios disponibles (elige 1):
- fontanería
- electricidad
- cerrajería
- persianas
- termo / calentador / agua caliente
- aire acondicionado
- electrodomésticos
- pintura
- mantenimiento

Guion de apertura EXACTO (y tú inicias la conversación sin esperar a que el cliente diga hola):
"Hola, soy Marta, el asistente de urgencias de Reparaciones Express 24h. ¿En qué puedo ayudarte?"

Datos a recoger (en este orden, con preguntas cortas):
1) Nombre
2) Teléfono de contacto (si coincide con el número desde el que llama, confírmalo)
3) Dirección completa (calle, número, portal/piso si aplica)
4) Zona/municipio (Costa del Sol)
5) Servicio (elige 1 de la lista)
6) Avería (descripción breve) + si hay urgencia/riesgo (agua/fuego/personas atrapadas)

Regla nocturna:
Si es entre 22:00 y 08:00 (hora España), di literalmente:
"Te informo: entre las 22:00 y las 08:00 la salida para ver la avería son 70€, y después la mano de obra nocturna suele estar entre 50€ y 70€ por hora, según el trabajo.
¿Lo aceptas para enviar al técnico?"
Si no acepta: toma nota y ofrece que llamen en horario diurno.

Cierre obligatorio (NUNCA cambies esto):
"Perfecto. Voy a enviar ahora mismo el aviso al técnico de guardia de nuestra empresa y te contactará para confirmar disponibilidad y tiempo estimado."

Despedida según parte_del_dia:
- mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."

IMPORTANTE:
- No leas el resumen interno al cliente.
- Cuando tengas todos los datos, deja de preguntar y cierra con el texto obligatorio.
Contexto: es_noche=${night}, parte_del_dia=${part}.
`;
}

// Helpers para parse seguro de JSON
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Extraer parte con OpenAI (texto) para el SMS — usando JSON schema
async function extractTicket(transcript, night) {
  const model = process.env.EXTRACT_MODEL || "gpt-4o-mini";

  const input = `
Extrae un PARTE de servicio desde esta conversación. Devuelve SOLO JSON.
Si no hay información suficiente, deja campos vacíos.

TRANSCRIPCIÓN:
${transcript || "(vacío)"}

REGLAS:
- Si night=${night} entonces aceptoNocturno debe ser "si" o "no". Si no se menciona, pon "no".
- Si night=${night} es false, pon aceptoNocturno "n-a".
- urgente: "si" o "no" (si no se sabe, vacío).
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "parte_urgencias",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              nombre: { type: "string" },
              telefono: { type: "string" },
              direccion: { type: "string" },
              zona: { type: "string" },
              servicio: { type: "string" },
              averia: { type: "string" },
              urgente: { type: "string" },
              aceptoNocturno: { type: "string" },
              notas: { type: "string" },
            },
            required: [
              "nombre",
              "telefono",
              "direccion",
              "zona",
              "servicio",
              "averia",
              "urgente",
              "aceptoNocturno",
              "notas",
            ],
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI extract failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();

  // En Responses API, el JSON final suele venir en output[...].content[...]
  // Pero por compatibilidad, probamos varios caminos:
  const candidate =
    json.output_text ||
    json.output?.[0]?.content?.[0]?.text ||
    json.output?.[0]?.content?.[0]?.json ||
    "";

  const parsed = typeof candidate === "string" ? safeJsonParse(candidate) : candidate;
  if (!parsed) {
    // fallback: si algo raro, devolvemos básico
    return {
      nombre: "",
      telefono: "",
      direccion: "",
      zona: "",
      servicio: "",
      averia: "",
      urgente: "",
      aceptoNocturno: night ? "no" : "n-a",
      notas: transcript ? "No se pudo parsear JSON, revisar conversación." : "Sin transcripción (posible fallo de audio).",
    };
  }
  return parsed;
}

function formatSms(t, callSid, fromNumber) {
  return [
    "🛠️ AVISO URGENCIA (MARTA)",
    `Servicio: ${t.servicio || "-"}`,
    `Nombre: ${t.nombre || "-"}`,
    `Tel: ${t.telefono || "-"}`,
    fromNumber ? `Llama desde: ${fromNumber}` : "",
    `Dirección: ${t.direccion || "-"}`,
    `Zona: ${t.zona || "-"}`,
    `Urgente: ${t.urgente || "-"}`,
    `Acepto nocturno: ${t.aceptoNocturno || "-"}`,
    `Avería: ${t.averia || "-"}`,
    `Notas: ${t.notas || "-"}`,
    callSid ? `CallSid: ${callSid}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

wss.on("connection", (twilioWs) => {
  const tNow = nowInTZ();
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  let callSid = "";
  let fromNumber = "";
  let streamSid = "";

  let transcript = ""; // cliente
  let martaText = "";  // opcional

  let openaiReady = false;
  let greeted = false;

  // ---- OpenAI Realtime WS ----
  const realtimeModel =
    process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  function trySendGreeting() {
    if (greeted) return;
    if (!openaiReady) return;
    if (!streamSid) return; // si no hay streamSid, Twilio no aceptará audio de vuelta
    if (openaiWs.readyState !== WebSocket.OPEN) return;

    greeted = true;
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            'Di EXACTAMENTE: "Hola, soy Marta, el asistente de urgencias de Reparaciones Express 24h. ¿En qué puedo ayudarte?" y espera respuesta.',
        },
      })
    );
  }

  openaiWs.on("open", () => {
    // Config sesión Realtime para Twilio (G.711 μ-law)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: buildInstructions({ night, part }),
          voice: process.env.REALTIME_VOICE || "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          modalities: ["audio", "text"],
          temperature: 0.4,

          // 🔥 clave para que haya transcripción del audio entrante
          input_audio_transcription: {
            model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
          },
        },
      })
    );

    openaiReady = true;
    console.log("✅ OpenAI realtime conectado", { model: realtimeModel });

    // Intentamos saludar (pero solo saldrá cuando ya exista streamSid)
    trySendGreeting();
  });

  openaiWs.on("message", (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg) return;

    // Audio hacia Twilio
    if (msg.type === "response.audio.delta") {
      if (!streamSid) return;
      // msg.delta es base64
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
      return;
    }

    // Texto de Marta (opcional)
    if (msg.type === "response.output_text.delta") {
      if (msg.delta) martaText += msg.delta;
      return;
    }

    // Transcripción del cliente
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = msg.transcript || "";
      if (t.trim()) transcript += `\nCLIENTE: ${t.trim()}`;
      return;
    }

    // Algunas versiones devuelven input_audio_transcription en otros tipos
    if (msg.type === "input_audio_transcription.completed") {
      const t = msg.transcript || "";
      if (t.trim()) transcript += `\nCLIENTE: ${t.trim()}`;
      return;
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🔵 OpenAI realtime cerrado", { code, reason: String(reason || "") });
    try {
      twilioWs.close();
    } catch {}
  });

  openaiWs.on("error", (e) => {
    console.error("❌ OpenAI WS error", e?.message || e);
    try {
      twilioWs.close();
    } catch {}
  });

  // ---- Twilio WS events ----
  twilioWs.on("message", async (raw) => {
    const data = safeJsonParse(raw.toString());
    if (!data) return;

    if (data.event === "start") {
      callSid = data.start?.callSid || data.start?.callSid || "";
      streamSid = data.start?.streamSid || "";

      // Lo pasamos desde TwiML <Parameter>
      fromNumber =
        data.start?.customParameters?.From ||
        data.start?.customParameters?.from ||
        "";

      console.log("📞 Twilio start", { callSid, streamSid, fromNumber });

      // Ahora que tenemos streamSid, podemos saludar
      trySendGreeting();
      return;
    }

    if (data.event === "media") {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media?.payload,
          })
        );
      }
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stop", { callSid, streamSid });

      const alertTo = process.env.ALERT_TO_NUMBER;
      if (!alertTo) {
        console.error("Falta ALERT_TO_NUMBER");
      }

      try {
        // Si no hay transcripción, añadimos pista para el SMS
        const finalTranscript =
          transcript && transcript.trim()
            ? transcript
            : "(SIN TRANSCRIPCIÓN - posible fallo de audio)";

        const extracted = await extractTicket(finalTranscript, night);

        // Si seguimos sin datos, deja nota clara
        if (
          !extracted?.nombre &&
          !extracted?.telefono &&
          !extracted?.direccion &&
          !extracted?.averia
        ) {
          extracted.notas = extracted.notas
            ? extracted.notas
            : "Llamada sin datos claros. Revisar audio / transcripción.";
        }

        const smsText = formatSms(extracted, callSid, fromNumber);
        if (alertTo) {
          await sendSms(alertTo, smsText);
          console.log("✅ SMS enviado");
        }
      } catch (e) {
        console.error("❌ Error enviando SMS", e?.message || e);
      } finally {
        try {
          openaiWs.close();
        } catch {}
      }
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("🔵 Twilio WS cerrado");
    try {
      openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (e) => {
    console.error("❌ Twilio WS error", e?.message || e);
    try {
      openaiWs.close();
    } catch {}
  });
});
