"use strict";

/**
 * Small callback-based HTTPS helpers built on Node's core `https` module.
 * Every callback follows the Node convention: callback(error, result).
 */

const https = require("node:https");

const USER_AGENT = "historic-photo-explorer/1.0 (+https://github.com/DonYuen231/historic-photo-explorer)";
const MAX_REDIRECTS = 5;

class HttpError extends Error {
	constructor(statusCode, url, body) {
		super(`HTTP ${statusCode} from ${new URL(url).host}`);
		this.name = "HttpError";
		this.statusCode = statusCode;
		this.body = body;
	}
}

/** Wraps a callback so it can only ever run once. */
function once(callback) {
	let called = false;
	return (...args) => {
		if (called) return;
		called = true;
		callback(...args);
	};
}

/** Reads a response stream fully into a Buffer. */
function collect(stream, callback) {
	const chunks = [];
	stream.on("data", (chunk) => chunks.push(chunk));
	stream.on("end", () => callback(null, Buffer.concat(chunks)));
	stream.on("error", callback);
}

/**
 * GET a URL, following redirects, and return { buffer, headers }.
 * Non-2xx responses are reported as an HttpError.
 */
function getBuffer(url, { timeoutMs = 15_000, redirectsLeft = MAX_REDIRECTS } = {}, callback) {
	const done = once(callback);

	const req = https.get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
		const { statusCode, headers } = res;

		if (statusCode >= 300 && statusCode < 400 && headers.location) {
			res.resume();
			if (redirectsLeft === 0) {
				return done(new Error(`Too many redirects for ${url}`));
			}
			const nextUrl = new URL(headers.location, url).toString();
			return getBuffer(nextUrl, { timeoutMs, redirectsLeft: redirectsLeft - 1 }, done);
		}

		collect(res, (err, buffer) => {
			if (err) return done(err);
			if (statusCode < 200 || statusCode >= 300) {
				return done(new HttpError(statusCode, url, buffer.toString("utf8")));
			}
			done(null, { buffer, headers });
		});
	});

	req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms: ${url}`)));
	req.on("error", done);
}

/** GET a URL and parse the body as JSON. */
function getJson(url, options, callback) {
	getBuffer(url, options, (err, result) => {
		if (err) return callback(err);
		try {
			callback(null, JSON.parse(result.buffer.toString("utf8")));
		} catch {
			callback(new Error(`Invalid JSON received from ${url}`));
		}
	});
}

/** POST a JSON payload and parse the JSON response. */
function postJson(url, { headers = {}, timeoutMs = 60_000 } = {}, payload, callback) {
	const done = once(callback);
	const body = JSON.stringify(payload);

	const req = https.request(
		url,
		{
			method: "POST",
			headers: {
				"User-Agent": USER_AGENT,
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
				...headers,
			},
		},
		(res) => {
			collect(res, (err, buffer) => {
				if (err) return done(err);
				const text = buffer.toString("utf8");
				if (res.statusCode < 200 || res.statusCode >= 300) {
					return done(new HttpError(res.statusCode, url, text));
				}
				try {
					done(null, JSON.parse(text));
				} catch {
					done(new Error(`Invalid JSON received from ${url}`));
				}
			});
		}
	);

	req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms: ${url}`)));
	req.on("error", done);
	req.end(body);
}

module.exports = { HttpError, getBuffer, getJson, postJson };
