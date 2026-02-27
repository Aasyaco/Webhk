import fs from "fs";
import dotenv from "dotenv";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

dotenv.config();

/**
 * Get Octokit instance authenticated as the App Installation.
 *
 * @param {number|string} installationId - GitHub App Installation ID
 * @returns {Octokit} Authenticated Octokit instance
 */
export async function getInstallationOctokit(installationId) {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;

  if (!appId || !privateKeyPath) {
    throw new Error(
      "Missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY_PATH in .env"
    );
  }

  // Read PEM private key
  const privateKey = fs.readFileSync(privateKeyPath, "utf8");

  // Initialize GitHub App
  const app = new App({ appId, privateKey });

  // Return Octokit authenticated as installation
  const octokit = await app.getInstallationOctokit(installationId);
  return octokit;
}

/**
 * Get Octokit instance authenticated as the App itself (not installation)
 * Useful for App-level operations
 *
 * @returns {Octokit} Authenticated Octokit
 */
export function getAppOctokit() {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;

  if (!appId || !privateKeyPath) {
    throw new Error(
      "Missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY_PATH in .env"
    );
  }

  const privateKey = fs.readFileSync(privateKeyPath, "utf8");

  return new Octokit({
    authStrategy: App,
    auth: {
      appId,
      privateKey,
    },
  });
}

/**
 * Helper: Extract installation ID from webhook payload
 *
 * @param {object} payload - GitHub webhook payload
 * @returns {number} installationId
 */
export function getInstallationIdFromPayload(payload) {
  if (!payload.installation || !payload.installation.id) {
    throw new Error("Webhook payload missing installation.id");
  }
  return payload.installation.id;
}
