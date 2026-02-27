import express from "express";
import dotenv from "dotenv";
import webhookHandler from "./api/webhook.js";

dotenv.config();

const app = express();

/* Required for GitHub webhook signature verification */
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

/* Webhook route */
app.post("/api/webhook", webhookHandler);

/* Serve index.html for testing dashboard */
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* Fallback route */
app.use((req, res) => {
  res.status(404).send("Route not found");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AxotBot running on port ${PORT}`);
});
