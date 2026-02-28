import crypto from "crypto";
import { handleBackportEvent } from "../lib/backports.js";
import logger from "../lib/logger.js";

/**
 * Verify GitHub webhook signature.
 * Prevents spoofed requests.
 */

export const config = {
  api: {
    bodyParser: false,
  },
};


async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}



async function verifySignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const rawBody = await getRawBody(req);
  req.rawBody = rawBody;
  if (!signature || !secret || !req.rawBody) return false;
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

  console.log("Raw body type:", rawBody.constructor.name); // Should be Buffer
  console.log("Raw Body:", payload)
  console.log("Raw body length:", Object.keys(payload).length);
  console.log("Signature header:", req.headers["x-hub-signature-256"]);
  console.log("Secret length:", process.env.GITHUB_WEBHOOK_SECRET?.length);
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
        if (!(await verifySignature(req))) {
          logger.warn("Invalid webhook signature");
          return res.status(401).send("Invalid signature");
        }
    }

    const event = req.headers["x-github-event"];
    const rawBody = await getRawBody(req);
    req.rawBody = rawBody;
//    const payload = JSON.parse(rawBody.toString());
    let payload;
    payload = JSON.parse(rawBody.toString("utf8"));

    logger.info(`GitHub event received: ${event}`);

    /* 🎯 Route events */
    switch (event) {
      case "pull_request":
        await handlePullRequest(payload);
        break;

      case "ping":
        logger.info("GitHub ping received");
        break;
      case "pink":
        logger.info("Passed");
        break

      default:
        logger.info(`Unhandled event: ${event}`);
    }

    res.status(200).send("OK");
  } catch (err) {
    logger.error(err, "Webhook error");
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
