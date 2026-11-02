"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Load variables from a local .env file if present (built into Node >= 20.12).
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
	process.loadEnvFile(envFile);
}

module.exports = Object.freeze({
	host: process.env.HOST || "localhost",
	port: Number(process.env.PORT) || 3000,

	anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
	claudeModel: process.env.CLAUDE_MODEL || "claude-opus-5-5",

	// Number of photos sent to Claude per search.
	maxPhotos: Number(process.env.MAX_PHOTOS) || 5,

	// How long a finished search result is kept in memory.
	cacheTtlMs: 60 * 60 * 1000,
	cacheMaxEntries: 100,

	timeouts: {
		loc: 15_000,
		image: 15_000,
		claude: 180_000,
	},
});
