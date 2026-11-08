"use strict";

/**
 * Mini evaluation: runs a fixed set of Library of Congress photos through the app's
 * own download and Claude steps, and saves each description next to the cataloger's
 * written summary so they can be scored by hand.
 *
 * Usage: node eval/run.js <version>     e.g. node eval/run.js v2
 * Output: eval/results-<version>.json and eval/review-<version>.md
 */

const fs = require("node:fs");
const path = require("node:path");

const config = require("../src/config");
const { getJson } = require("../src/http-client");
const { downloadImages } = require("../src/loc");
const { describePhotos } = require("../src/claude");

const EVAL_DIR = __dirname;
const { groups } = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "photos.json"), "utf8"));

/** Picks the image closest to 640px tall, the same size the app's search results use. */
function pickImageUrl(imageUrls) {
	let best = null;
	for (const raw of imageUrls || []) {
		const [url, fragment = ""] = raw.split("#");
		const height = Number((fragment.match(/h=(\d+)/) || [])[1]) || 0;
		if (!url.startsWith("https://") || height === 0) continue;
		if (!best || Math.abs(height - 640) < Math.abs(best.height - 640)) best = { url, height };
	}
	return best ? best.url : "";
}

/** The cataloger's summary of what the image shows. */
function extractSummary(item) {
	const summary = Array.isArray(item.summary) ? item.summary.join(" ") : item.summary || "";
	return summary.trim();
}

// Item records are cached locally so a re-run doesn't depend on loc.gov being up.
const CACHE_FILE = path.join(EVAL_DIR, "cache", "items.json");

function readCache() {
	try {
		return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writeCache(cache) {
	fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
	fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, "\t") + "\n");
}

/** Fetches one LoC item record and returns the fields the app would have from a search. */
function fetchItem(id, callback, attempt = 1) {
	const cache = readCache();
	if (cache[id]) return callback(null, cache[id]);

	// at=item asks for just the item record, which is all we use.
	const url = `https://www.loc.gov/item/${id}/?fo=json&at=item`;
	getJson(url, { timeoutMs: config.timeouts.loc }, (err, data) => {
		// loc.gov sometimes rate-limits (429/503), times out or loops redirects; wait and retry.
		// Other 4xx errors (like 404) are real failures and aren't retried.
		const retryable = err && !(err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429);
		if (retryable && attempt < 4) {
			console.warn(`[eval] ${err.message} for item ${id}, retrying in ${attempt * 10}s`);
			return setTimeout(() => fetchItem(id, callback, attempt + 1), attempt * 10_000);
		}
		if (err) return callback(err);
		const item = (data && data.item) || {};
		const record = {
			title: item.title || "Untitled",
			date: item.date || "",
			itemUrl: `https://www.loc.gov/item/${id}/`,
			imageUrl: pickImageUrl(item.image_url),
			reference: extractSummary(item),
		};
		writeCache({ ...readCache(), [id]: record });
		callback(null, record);
	});
}

/** Runs async steps one at a time, collecting results. */
function series(list, step, callback) {
	const out = [];
	(function next(i) {
		if (i >= list.length) return callback(null, out);
		step(list[i], (err, result) => {
			if (err) return callback(err);
			out.push(result);
			next(i + 1);
		});
	})(0);
}

/**
 * Step 1 for a group: fetch item records and download all 5 images.
 * Fails if any image is missing, so Claude is never called with a partial batch.
 */
function prepareGroup(group, callback) {
	console.log(`[eval] Fetching group ${group.id}: ${group.label}`);
	series(group.items, fetchItem, (err, photos) => {
		if (err) return callback(err);
		downloadImages(photos, (err, images) => {
			if (err) return callback(err);
			if (images.length < photos.length) {
				return callback(new Error(`Group ${group.id}: only ${images.length} of ${photos.length} images downloaded. Try again.`));
			}
			callback(null, { group, photos, images });
		});
	});
}

/** Step 2 for a group: send the batch to Claude, the same way the app does. */
function describeGroup({ group, photos, images }, callback) {
	console.log(`[eval] Describing group ${group.id}`);
	describePhotos(images, group.subject, group.location, (err, described) => {
		if (err) return callback(err);
		const rows = described.map((d) => {
			const source = photos.find((p) => p.itemUrl === d.itemUrl);
			return { group: group.id, groupLabel: group.label, ...d, reference: source.reference };
		});
		callback(null, rows);
	});
}

function writeReview(rows, version) {
	const lines = [
		`# Evaluation review sheet (${version})`,
		"",
		`Model: \`${config.claudeModel}\`. Generated ${new Date().toISOString().slice(0, 10)} by \`node eval/run.js ${version}\`.`,
		"",
		"Score each photo 1 to 5 using the rubric in [RUBRIC.md](RUBRIC.md).",
		"",
	];
	rows.forEach((r, i) => {
		lines.push(
			`## ${i + 1}. [${r.group}] ${r.title}`,
			"",
			`[LoC record](${r.itemUrl}) · catalog date: ${r.date || "none"}${r.lowResolution ? " · **flagged low resolution**" : ""}`,
			"",
			`<img src="${r.imageUrl}" width="400">`,
			"",
			`**Cataloger summary (reference):** ${r.reference}`,
			"",
			`**App description:** ${r.description}`,
			"",
			`**Estimated period:** ${r.estimatedPeriod}`,
			"",
			`**Notable details:** ${r.notableDetails.join("; ")}`,
			"",
			"| Accuracy | Usefulness | Reference match | Notes |",
			"| --- | --- | --- | --- |",
			"|  |  |  |  |",
			""
		);
	});
	fs.writeFileSync(path.join(EVAL_DIR, `review-${version}.md`), lines.join("\n"));
}

if (require.main === module) {
	const version = process.argv[2];
	if (!/^[\w-]+$/.test(version || "")) {
		console.error("Usage: node eval/run.js <version>   (for example: node eval/run.js v2)");
		process.exit(1);
	}
	if (!config.anthropicApiKey) {
		console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.");
		process.exit(1);
	}

	const fail = (err) => {
		console.error(`[eval] Failed: ${err.message}`);
		process.exit(1);
	};

	// Download everything first, so a loc.gov outage doesn't waste Claude calls.
	series(groups, prepareGroup, (err, prepared) => {
		if (err) return fail(err);
		series(prepared, describeGroup, (err, groupRows) => {
			if (err) return fail(err);
			finish(groupRows);
		});
	});

	function finish(groupRows) {
		const rows = groupRows.flat();
		const output = { model: config.claudeModel, generatedAt: new Date().toISOString(), photos: rows };
		fs.writeFileSync(path.join(EVAL_DIR, `results-${version}.json`), JSON.stringify(output, null, "\t") + "\n");
		writeReview(rows, version);
		console.log(`\n[eval] Saved ${rows.length} descriptions to eval/results-${version}.json and eval/review-${version}.md`);
	}
}

module.exports = { pickImageUrl, extractSummary };
