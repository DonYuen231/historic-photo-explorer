"use strict";

/**
 * Second opinions from other models, via NanoGPT (subscription endpoint only).
 *
 * 1. Describe: each model writes its own descriptions of the 20 photos, using the
 *    exact prompt and inputs the app sends to Claude (v2), in the same 5-photo batches.
 * 2. Grade: each model grades every description (Claude v1, Claude v2 and each model's
 *    own) with the rubric, blind: it isn't told who wrote the description or which version.
 *
 * Usage: node eval/judge.js
 * Results are saved as they arrive, so the script can be stopped and re-run to resume.
 * Output: eval/judges/descriptions-<model>.json and eval/judges/grades.json
 */

const fs = require("node:fs");
const path = require("node:path");

const config = require("../src/config");
const { getBuffer, postJson } = require("../src/http-client");
const { buildRequest } = require("../src/claude");
const { imageSize } = require("../src/image-size");
const { isLowResolution } = require("../src/loc");

const EVAL_DIR = __dirname;
const JUDGE_DIR = path.join(EVAL_DIR, "judges");
const IMAGE_CACHE = path.join(EVAL_DIR, "cache", "images");
const GRADES_FILE = path.join(JUDGE_DIR, "grades.json");

// Subscription endpoint: requests outside the subscription are refused instead of billed
// (when the key's billing mode is set to "Subscription only").
const NANOGPT_URL = "https://nano-gpt.com/api/subscription/v1/chat/completions";
const API_KEY = process.env.NANOGPT_API_KEY || "";

const MODELS = [
	{ id: "deepseek/deepseek-v4.1-flash-1017:thinking", slug: "deepseek-v4.1-flash" },
	{ id: "moonshotai/kimi-k2.6:thinking", slug: "kimi-k2.6" },
	{ id: "google/gemma-4-31b-it", slug: "gemma-4-31b" },
	{ id: "meta/muse-spark-1.3-contributor", slug: "muse-spark-1.3" },
];

const { groups } = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "photos.json"), "utf8"));

// ---------- small helpers ----------

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, "\t") + "\n");
}

/** Runs async steps one at a time. */
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

/** Runs one task list per model in parallel; each model's list runs in order. */
function perModelInParallel(tasksByModel, runTask, callback) {
	const slugs = Object.keys(tasksByModel);
	let pending = slugs.length;
	const errors = [];
	if (pending === 0) return callback(null);
	for (const slug of slugs) {
		series(tasksByModel[slug], runTask, (err) => {
			if (err) errors.push(`${slug}: ${err.message}`);
			if (--pending === 0) callback(errors.length ? new Error(errors.join("; ")) : null);
		});
	}
}

/** Pulls the first JSON object out of a model reply (some wrap it in text or code fences). */
function extractJson(text) {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("No JSON object in reply");
	return JSON.parse(text.slice(start, end + 1));
}

/** The rubric without its "Example from this eval" column, so judges aren't shown our scores. */
function rubricForJudges() {
	const text = fs.readFileSync(path.join(EVAL_DIR, "RUBRIC.md"), "utf8");
	let inExampleTable = false;
	return text
		.split("\n")
		.map((line) => {
			if (!line.startsWith("|")) {
				inExampleTable = false;
				return line;
			}
			if (line.includes("Example from this eval")) inExampleTable = true;
			return inExampleTable ? line.split("|").slice(0, -2).join("|") + "|" : line;
		})
		.join("\n");
}

// ---------- NanoGPT ----------

/** Sends one chat request, retrying on network errors, server errors and bad JSON. */
function chat(model, content, parse, callback, attempt = 1) {
	const body = {
		model: model.id,
		temperature: 0,
		max_tokens: 16000,
		// json_object works on all four models (Kimi returns empty content with json_schema).
		response_format: { type: "json_object" },
		messages: [{ role: "user", content }],
	};
	const options = { timeoutMs: 600_000, headers: { Authorization: `Bearer ${API_KEY}` } };

	postJson(NANOGPT_URL, options, body, (err, response) => {
		let result;
		if (!err) {
			try {
				const text = (response.choices && response.choices[0].message.content) || "";
				result = parse(extractJson(text));
			} catch (parseErr) {
				err = parseErr;
			}
		}
		if (!err) return callback(null, result);

		// Long thinking requests sometimes get their connection dropped, so allow several retries.
		const fatal = err.statusCode === 401 || err.statusCode === 402 || err.statusCode === 403;
		if (!fatal && attempt < 6) {
			console.warn(`[judge] ${model.slug}: ${err.message}, retrying (${attempt}/5)`);
			return setTimeout(() => chat(model, content, parse, callback, attempt + 1), attempt * 10_000);
		}
		callback(err);
	});
}

// ---------- images ----------

/** Downloads each image once and keeps it on disk, so every model sees the same bytes. */
function loadImage(photo, callback) {
	const id = photo.itemUrl.match(/item\/([^/]+)/)[1];
	const file = path.join(IMAGE_CACHE, `${id}.jpg`);
	if (fs.existsSync(file)) return callback(null, fs.readFileSync(file));
	getBuffer(photo.imageUrl, { timeoutMs: 30_000 }, (err, result) => {
		if (err) return callback(err);
		fs.mkdirSync(IMAGE_CACHE, { recursive: true });
		fs.writeFileSync(file, result.buffer);
		callback(null, result.buffer);
	});
}

const imagePart = (buffer) => ({
	type: "image_url",
	image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` },
});

// ---------- step 1: each model writes its own descriptions ----------

/** Turns the app's Claude request content into OpenAI-style content parts. */
function toOpenAiContent(claudeContent) {
	return claudeContent.map((part) =>
		part.type === "image"
			? { type: "image_url", image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } }
			: { type: "text", text: part.text }
	);
}

const DESCRIBE_FORMAT =
	'\nReply with JSON only, in this shape: {"photos": [{"photo_number": 1, "description": "...", ' +
	'"estimated_period": "...", "notable_details": ["...", "..."]}]}';

function parseDescriptions(json, count) {
	if (!Array.isArray(json.photos) || json.photos.length !== count) {
		throw new Error(`Expected ${count} photos in reply`);
	}
	return json.photos.map((p, i) => {
		if (typeof p.description !== "string" || !p.description.trim()) throw new Error("Missing description");
		return {
			photoNumber: p.photo_number || i + 1,
			description: p.description,
			estimatedPeriod: String(p.estimated_period || ""),
			notableDetails: Array.isArray(p.notable_details) ? p.notable_details.map(String) : [],
		};
	});
}

function describeGroup(model, group, baseline, callback) {
	const rows = baseline.filter((r) => r.group === group.id);
	series(rows, loadImage, (err, buffers) => {
		if (err) return callback(err);
		const photos = rows.map((r, i) => ({
			title: r.title,
			date: r.date,
			mediaType: "image/jpeg",
			base64: buffers[i].toString("base64"),
			lowResolution: isLowResolution(imageSize(buffers[i])),
		}));
		// Same prompt and inputs as the app's Claude request, plus a line describing the JSON shape.
		const content = toOpenAiContent(buildRequest(photos, group.subject, group.location).messages[0].content);
		content.push({ type: "text", text: DESCRIBE_FORMAT });

		chat(model, content, (json) => parseDescriptions(json, rows.length), (err, described) => {
			if (err) return callback(err);
			callback(
				null,
				rows.map((r, i) => {
					const d = described.find((x) => x.photoNumber === i + 1) || described[i];
					return { ...r, description: d.description, estimatedPeriod: d.estimatedPeriod, notableDetails: d.notableDetails };
				})
			);
		});
	});
}

function describeAll(baseline, callback) {
	const tasksByModel = {};
	for (const model of MODELS) {
		const file = path.join(JUDGE_DIR, `descriptions-${model.slug}.json`);
		if (fs.existsSync(file)) continue;
		tasksByModel[model.slug] = [model];
	}
	perModelInParallel(
		tasksByModel,
		(model, done) => {
			console.log(`[judge] ${model.slug}: writing descriptions`);
			series(groups, (group, next) => describeGroup(model, group, baseline, next), (err, perGroup) => {
				if (err) return done(err);
				writeJson(path.join(JUDGE_DIR, `descriptions-${model.slug}.json`), { model: model.id, photos: perGroup.flat() });
				console.log(`[judge] ${model.slug}: descriptions saved`);
				done(null);
			});
		},
		callback
	);
}

// ---------- step 2: every model grades every description, blind ----------

const SCORE_KEYS = ["accuracy", "completeness", "usefulness", "reference"];

function parseGrade(json) {
	const grade = {};
	for (const key of SCORE_KEYS) {
		const score = Number(json[key]);
		if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error(`Invalid ${key} score`);
		grade[key] = score;
		grade[`${key}_reason`] = String(json[`${key}_reason`] || "");
	}
	return grade;
}

function gradePrompt(rubric, row) {
	return (
		`You are grading a description of a historical photo written for blind and visually impaired readers. ` +
		`Use the rubric below exactly. Grade each of the four scores on its own.\n\n` +
		`${rubric}\n\n---\n\n` +
		`Catalog title: ${row.title}\n` +
		`Catalog date: ${row.date || "none"}\n` +
		`Cataloger's reference summary: ${row.reference}\n\n` +
		`Description to grade:\n${row.description}\n\n` +
		`Estimated period given: ${row.estimatedPeriod}\n` +
		`Notable details given: ${row.notableDetails.join("; ")}\n\n` +
		`The photo is attached. Look at it carefully before grading.\n` +
		`Reply with JSON only, in this shape, giving the one-sentence reason before each score: ` +
		`{"accuracy_reason": "...", "accuracy": 1-5, "completeness_reason": "...", "completeness": 1-5, "usefulness_reason": "...", "usefulness": 1-5, ` +
		`"reference_reason": "...", "reference": 1-5}`
	);
}

/** Deterministic shuffle so the grading order is mixed but repeatable. */
function shuffle(list, seed = 42) {
	const out = [...list];
	let s = seed;
	for (let i = out.length - 1; i > 0; i--) {
		s = (s * 1103515245 + 12345) % 2 ** 31;
		const j = s % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function gradeAll(candidates, callback) {
	const rubric = rubricForJudges();
	const grades = readJson(GRADES_FILE, {});
	const tasksByModel = {};

	for (const judge of MODELS) {
		const tasks = [];
		for (const [author, rows] of Object.entries(candidates)) {
			rows.forEach((row, i) => {
				const key = `${judge.slug}|${author}|${i + 1}`;
				if (!grades[key]) tasks.push({ judge, author, photo: i + 1, row, key });
			});
		}
		if (tasks.length) tasksByModel[judge.slug] = shuffle(tasks);
	}

	const total = Object.values(tasksByModel).reduce((n, t) => n + t.length, 0);
	console.log(`[judge] ${total} grades to do`);
	let done = 0;
	const failed = [];

	perModelInParallel(
		tasksByModel,
		(task, next) => {
			// A failed grade is skipped (and retried on the next run) instead of stopping this judge.
			const skip = (err) => {
				failed.push(task.key);
				console.warn(`[judge] Skipping ${task.key}: ${err.message}`);
				next(null);
			};
			loadImage(task.row, (err, buffer) => {
				if (err) return skip(err);
				const content = [{ type: "text", text: gradePrompt(rubric, task.row) }, imagePart(buffer)];
				chat(task.judge, content, parseGrade, (err, grade) => {
					if (err) return skip(err);
					// Re-read before writing, since the other judges save to the same file.
					const latest = readJson(GRADES_FILE, {});
					latest[task.key] = { judge: task.judge.slug, author: task.author, photo: task.photo, ...grade };
					writeJson(GRADES_FILE, latest);
					if (++done % 20 === 0 || done === total) console.log(`[judge] ${done}/${total} grades`);
					next(null);
				});
			});
		},
		(err) => {
			if (err) return callback(err);
			callback(failed.length ? new Error(`${failed.length} grades failed`) : null);
		}
	);
}

// ---------- main ----------

if (require.main === module) {
	if (!API_KEY) {
		console.error("Missing NANOGPT_API_KEY. Add it to .env.");
		process.exit(1);
	}

	const v1 = readJson(path.join(EVAL_DIR, "results-v1.json")).photos;
	const v2 = readJson(path.join(EVAL_DIR, "results-v2.json")).photos;

	describeAll(v2, (err) => {
		if (err) console.error(`[judge] Some descriptions failed (re-run to retry): ${err.message}`);

		const candidates = { "claude-v1": v1, "claude-v2": v2 };
		for (const model of MODELS) {
			const file = path.join(JUDGE_DIR, `descriptions-${model.slug}.json`);
			if (fs.existsSync(file)) candidates[model.slug] = readJson(file).photos;
		}

		gradeAll(candidates, (err) => {
			if (err) {
				console.error(`[judge] Some grades failed (re-run to resume): ${err.message}`);
				process.exit(1);
			}
			console.log("[judge] Done. Run: node eval/compare.js");
		});
	});
}

module.exports = { extractJson, parseGrade, rubricForJudges, toOpenAiContent, shuffle, MODELS };
