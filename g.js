// generate-signature.js
import crypto from "crypto";

const secret = "mysecret123";
const payload = JSON.stringify({ zen: "Keep it logically awesome." });

const sig = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
console.log(sig);
