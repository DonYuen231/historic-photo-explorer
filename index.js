"use strict";

const config = require("./src/config");
const { createServer } = require("./src/server");

if (!config.anthropicApiKey) {
	console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.");
	process.exit(1);
}

const server = createServer();

server.listen(config.port, config.host, () => {
	console.log(`Historic Photo Explorer running at http://${config.host}:${config.port}`);
});
