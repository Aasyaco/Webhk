import crypto from "crypto";
import { handleBackportEvent } from "./backports.js";
import logger from "../lib/logger.js";

/**
 * Verify GitHub webhook signature.
 * Prevents spoofed requests.
 */
function verifySignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!signature || !secret) return false;

  const payload = req.rawBody;

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/**
 * GitHub webhook handler.
 * Handles pull_request backport automation.
 */
export default async function webhook(req, res) {
  try {
    /* 🔐 Verify request */
    if (req.headers["x-github-event"] !== "pink") {
        if (!verifySignature(req)) {
          logger.warn("Invalid webhook signature");
          return res.status(401).send("Invalid signature");
        }
    }

    const event = req.headers["x-github-event"];

    logger.info(`GitHub event received: ${event}`);

    /* 🎯 Route events */
    switch (event) {
      case "pull_request":
        await handlePullRequest(req.body);
        break;

      case "ping":
        logger.info("GitHub ping received");
        break;

      default:
        logger.info(`Unhandled event: ${event}`);
    }

    res.status(200).send("OK");
  } catch (err) {
    logger.error("Webhook error:", err);
    res.status(500).send("Internal Server Error");
  }
}

/**
 * Handle pull request events.
 */
async function handlePullRequest(payload) {
  const action = payload.action;

  /* Only act when PR merged */
  if (action !== "closed") return;

  if (!payload.pull_request?.merged) {
    logger.info("PR closed but not merged");
    return;
  }

  logger.info(
    `Processing merged PR #${payload.pull_request.number}`
  );

  await handleBackportEvent(payload);
}
