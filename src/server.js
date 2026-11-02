"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const config = require("./config");
const { TtlCache } = require("./cache");
const { searchPhotos, downloadImages } = require("./loc");
const { describePhotos } = require("./claude");
const { renderMessage, renderResults } = require("./views");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const STATIC_FILES = {
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};
const MAX_INPUT_LENGTH = 100;

const cache = new TtlCache({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries });

function sendHtml(res, statusCode, html) {
	res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
	res.end(html);
}

function sendStatic(res, { file, type }) {
	const stream = fs.createReadStream(path.join(PUBLIC_DIR, file));
	stream.on("open", () => {
		res.writeHead(200, { "Content-Type": type });
		stream.pipe(res);
	});
	stream.on("error", (err) => {
		console.error(`[server] Could not read ${file}: ${err.message}`);
		if (!res.headersSent) sendHtml(res, 500, renderMessage("Server error", "Something went wrong."));
		else res.destroy();
	});
}

/** Returns { subject, location } or { error } for the search query string. */
function parseSearchParams(searchParams) {
	const subject = (searchParams.get("subject") || "").trim();
	const location = (searchParams.get("location") || "").trim();

	if (!subject || !location) {
		return { error: "Please enter both a subject and a location." };
	}
	if (subject.length > MAX_INPUT_LENGTH || location.length > MAX_INPUT_LENGTH) {
		return { error: `Subject and location must each be ${MAX_INPUT_LENGTH} characters or fewer.` };
	}
	return { subject, location };
}

/**
 * Runs the full pipeline one step after another:
 * LoC search -> download images -> Claude descriptions.
 */
function handleSearch(res, subject, location) {
	const cacheKey = `${subject.toLowerCase()}|${location.toLowerCase()}`;
	const cached = cache.get(cacheKey);
	if (cached) {
		console.log(`[server] Cache hit for ${cacheKey}`);
		return sendHtml(res, 200, renderResults(subject, location, cached));
	}

	searchPhotos(subject, location, (err, photos) => {
		if (err) {
			console.error(`[loc] Search failed: ${err.message}`);
			return sendHtml(res, 502, renderMessage("Search failed", "The Library of Congress could not be reached. Please try again."));
		}
		if (photos.length === 0) {
			return sendHtml(res, 200, renderMessage("No photos found", `No photos matched "${subject}" in "${location}". Try a broader subject or location.`));
		}

		downloadImages(photos, (err, images) => {
			if (err || images.length === 0) {
				return sendHtml(res, 502, renderMessage("Images unavailable", "The matching images could not be downloaded. Please try again."));
			}

			describePhotos(images, subject, location, (err, described) => {
				if (err) {
					console.error(`[claude] Request failed: ${err.message}`);
					return sendHtml(res, 502, renderMessage("Description failed", "Claude could not describe these photos right now. Please try again."));
				}

				cache.set(cacheKey, described);
				sendHtml(res, 200, renderResults(subject, location, described));
			});
		});
	});
}

function handleRequest(req, res) {
	console.log(`[server] ${req.method} ${req.url}`);

	if (req.method !== "GET" && req.method !== "HEAD") {
		res.setHeader("Allow", "GET, HEAD");
		return sendHtml(res, 405, renderMessage("Method not allowed", "Only GET requests are supported."));
	}

	const { pathname, searchParams } = new URL(req.url, "http://localhost");

	if (STATIC_FILES[pathname]) {
		return sendStatic(res, STATIC_FILES[pathname]);
	}

	if (pathname === "/search") {
		const input = parseSearchParams(searchParams);
		if (input.error) {
			return sendHtml(res, 400, renderMessage("Invalid search", input.error));
		}
		return handleSearch(res, input.subject, input.location);
	}

	sendHtml(res, 404, renderMessage("Page not found", "The page you requested does not exist."));
}

function createServer() {
	return http.createServer(handleRequest);
}

module.exports = { createServer, parseSearchParams };
