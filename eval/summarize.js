"use strict";

/**
 * Reads eval/scores-<version>.csv and prints the Markdown score tables for the README.
 * Usage: node eval/summarize.js v1        (one version)
 *        node eval/summarize.js v1 v2     (side-by-side comparison)
 */

const fs = require("node:fs");
const path = require("node:path");

/** Parses one CSV line, allowing double-quoted fields that contain commas. */
function parseCsvLine(line) {
	const fields = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			fields.push(field);
			field = "";
		} else field += ch;
	}
	fields.push(field);
	return fields;
}

function readScores(file) {
	const [header, ...lines] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
	const keys = parseCsvLine(header);
	return lines.map((line) => {
		const row = Object.fromEntries(parseCsvLine(line).map((v, i) => [keys[i], v]));
		for (const k of ["accuracy", "usefulness", "reference"]) row[k] = Number(row[k]);
		return row;
	});
}

function average(rows, key) {
	return rows.length ? (rows.reduce((sum, r) => sum + r[key], 0) / rows.length).toFixed(2) : "-";
}

const SUBSETS = [
	["**All**", () => true],
	["Easy (group A)", (r) => r.group === "A"],
	["Hard (groups C, D)", (r) => r.group === "C" || r.group === "D"],
	["Full-size image", (r) => r.thumbnail !== "yes"],
	["150px thumbnail only", (r) => r.thumbnail === "yes"],
];
const KEYS = ["accuracy", "usefulness", "reference"];

/**
 * Builds the README tables for one or more scored versions.
 * With two versions, each cell reads "old → new".
 */
function summarize(versions) {
	const names = Object.keys(versions);
	const first = versions[names[0]];
	const cell = (pick) => names.map((n) => pick(versions[n])).join(" → ");
	const header = names.length > 1 ? ` (${names.join(" → ")})` : "";

	const out = [
		`| # | Group | Photo | Accuracy${header} | Usefulness${header} | Matches reference${header} |`,
		"| --- | --- | --- | --- | --- | --- |",
		...first.map((r, i) => {
			const title = r.thumbnail === "yes" ? `${r.title} *(150px)*` : r.title;
			const scores = KEYS.map((k) => cell((rows) => rows[i][k]));
			return `| ${r.photo} | ${r.group} | ${title} | ${scores.join(" | ")} |`;
		}),
		"",
		`| Subset | Photos | Accuracy${header} | Usefulness${header} | Matches reference${header} |`,
		"| --- | --- | --- | --- | --- |",
	];
	for (const [label, keep] of SUBSETS) {
		const count = first.filter(keep).length;
		const scores = KEYS.map((k) => cell((rows) => average(rows.filter(keep), k)));
		out.push(`| ${label} | ${count} | ${scores.join(" | ")} |`);
	}
	return out.join("\n");
}

if (require.main === module) {
	const names = process.argv.slice(2);
	if (names.length === 0 || !names.every((n) => /^[\w-]+$/.test(n))) {
		console.error("Usage: node eval/summarize.js <version> [<version>]   e.g. node eval/summarize.js v1 v2");
		process.exit(1);
	}
	const versions = Object.fromEntries(names.map((n) => [n, readScores(path.join(__dirname, `scores-${n}.csv`))]));
	console.log(summarize(versions));
}

module.exports = { parseCsvLine, readScores, summarize };
