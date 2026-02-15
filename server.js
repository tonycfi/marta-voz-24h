import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Cliente Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function escapeXml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function sendSms(body) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_SMS_FROM,
    to: process.env.ALERT_TO_NUMBER,
    body
  });
}

// Ruta de prueba
app.get("/", (_, res) => res.send("Marta voz activa ✅"));

// Webhook de voz Twilio
app.post("/voice", (req, res) => {
  const host = req.get("host");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${escapeXml(host)}/twilio-media" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Servidor HTTP
const server = app.listen(PORT, () => {
  console.log("Listening on", PORT);
});

// WebSocket para Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/twilio-media" });

wss.on("connection", (twilioWs) => {
  let streamSid = "";
  let transcript = "";

  console.log("📞 Twilio WS conectado");

  // Conexión a OpenAI Realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2025-06-03",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // Cuando OpenAI conecta
  openaiWs.on("open", () => {
    console.log("🟢 OpenAI conectado");

    // Configuración de audio compatible con Twilio
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: "alloy",
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw"
        }
      })
    );

    // Saludo inicial hablado
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Di exactamente: Hola, soy Marta, asistente de urgencias. ¿En qué puedo ayudarte?"
        }
      })
    );
  });

  // Audio de OpenAI → Twilio
  openaiWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    // Enviar audio a Twilio
    if (msg.type === "response.audio.delta" && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta }
        })
      );
    }

    // Guardar transcripción del cliente
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      transcript += msg.transcript + "\n";
    }
  });

  openaiWs.on("close", () => console.log("🔵 OpenAI cerrado"));
  openaiWs.on("error", (e) => console.error("❌ OpenAI error", e));

  // Eventos desde Twilio
  twilioWs.on("message", async (raw) => {
    const data = JSON.parse(raw.toString());

    // Inicio de llamada
    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("☎️ Twilio start");
    }

    // Audio del cliente → OpenAI
    if (data.event === "media") {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload
          })
        );
      }
    }

    // Fin de llamada
    if (data.event === "stop") {
      console.log("🛑 Twilio stop");

      try {
        await sendSms(
          transcript
            ? "Transcripción de llamada:\n" + transcript
            : "Llamada sin audio reconocido"
        );
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error SMS", e);
      }

      openaiWs.close();
    }
  });

  twilioWs.on("close", () => console.log("🔌 Twilio WS cerrado"));
});
