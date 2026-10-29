const { randomBytes } = require("node:crypto");
const { appendFileSync } = require("node:fs");
const { resolve } = require("node:path");

// Dopisujemy nowy sekret, nie odczytując istniejących wartości.
appendFileSync(resolve(__dirname, "../.env.local"), `\nSESSION_SECRET=${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
console.log("Nowy SESSION_SECRET zapisany w .env.local. Poprzednie sesje zostaną unieważnione.");
