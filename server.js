import express from "express";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Ruta de prueba
app.get("/", (req, res) => {
  res.send("Marta 24h está viva");
});

// Servidor HTTP
const server = app.listen(port, () => {
  console.log("Servidor escuchando en puerto", port);
});

// WebSocket para Twilio Media Streams
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("📞 Llamada conectada");

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("🤖 Conectado a OpenAI Realtime");
  });

  ws.on("message", (msg) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(msg);
    }
  });

  openaiWs.on("message", (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  ws.on("close", () => {
    console.log("📴 Llamada terminada");
    openaiWs.close();
  });
});
