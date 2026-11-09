"use strict";

/**
 * Builds one review document with everything for each photo in one place:
 * the image, catalog record and reference, Claude's v1 and v2 descriptions,
 * the human-verified baseline scores and notes, the judge panel's scores and
 * reasons, and the other models' own descriptions.
 *
 * Usage: node eval/report.js    Writes eval/REVIEW.md
 */

const fs = require("node:fs");
const path = require("node:path");
const { readScores } = require("./summarize");
const { median } = require("./compare");

const EVAL_DIR = __dirname;
const JUDGE_DIR = path.join(EVAL_DIR, "judges");
const KEYS = ["accuracy", "completeness", "usefulness", "reference"];
const LABELS = { accuracy: "Accuracy", completeness: "Completeness", usefulness: "Usefulness", reference: "Matches reference" };
const VERSIONS = ["v1", "v2"];
const OTHER_MODELS = ["deepseek-v4.1-flash", "gemma-4-31b", "kimi-k2.6", "muse-spark-1.3"];
const FLAG = 2; // a gap this big between the baseline and the panel needs checking
const LOOK = 1.5; // a gap this big is worth a look

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const oneLine = (s) => String(s).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

function load() {
	const results = Object.fromEntries(VERSIONS.map((v) => [v, readJson(path.join(EVAL_DIR, `results-${v}.json`)).photos]));
	const scores = Object.fromEntries(VERSIONS.map((v) => [v, readScores(path.join(EVAL_DIR, `scores-${v}.csv`))]));
	const others = Object.fromEntries(
		OTHER_MODELS.map((m) => [m, readJson(path.join(JUDGE_DIR, `descriptions-${m}.json`)).photos])
	);
	const grades = Object.values(readJson(path.join(JUDGE_DIR, "grades.json")));
	return { results, scores, others, grades };
}

/** Grades of one description, leaving out the author's own grade. */
function gradesFor(grades, author, photo) {
	return grades.filter((g) => g.author === author && g.photo === photo && g.judge !== author);
}

function panelScores(gs) {
	return Object.fromEntries(KEYS.map((k) => [k, gs.length ? median(gs.map((g) => g[k])) : NaN]));
}

/** Every baseline score that differs from the panel median by at least `min` points. */
function gaps(data, min) {
	const out = [];
	for (const v of VERSIONS) {
		data.scores[v].forEach((row, i) => {
			const panel = panelScores(gradesFor(data.grades, `claude-${v}`, i + 1));
			for (const k of KEYS) {
				const gap = panel[k] - row[k];
				if (Math.abs(gap) >= min) out.push({ photo: i + 1, version: v, key: k, base: row[k], panel: panel[k], title: row.title });
			}
		});
	}
	return out;
}

const anchor = (photo, title) => `#${photo}-${title}`.toLowerCase().replace(/[^\w\s#-]/g, "").replace(/\s+/g, "-");

function gapList(items) {
	if (!items.length) return "None.";
	return items
		.map(
			(x) =>
				`- [Photo ${x.photo}: ${x.title}](${anchor(x.photo, x.title)}), ${x.version}, **${LABELS[x.key]}**: ` +
				`baseline ${x.base}, panel ${fmt(x.panel)}`
		)
		.join("\n");
}

function descriptionBlock(d) {
	return [
		d.description,
		"",
		`*Estimated period:* ${d.estimatedPeriod}  `,
		`*Notable details:* ${d.notableDetails.join("; ")}`,
	].join("\n");
}

function judgeReasons(gs) {
	if (!gs.length) return "No grades.";
	const rows = gs
		.sort((a, b) => a.judge.localeCompare(b.judge))
		.flatMap((g) => KEYS.map((k) => `| ${g.judge} | ${LABELS[k]} | ${g[k]} | ${oneLine(g[`${k}_reason`])} |`));
	return ["| Judge | Score | Given | Reason |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function photoSection(data, i) {
	const photo = i + 1;
	const r1 = data.results.v1[i];
	const row1 = data.scores.v1[i];
	const lines = [
		`## ${photo}. ${row1.title}`,
		"",
		`Group ${row1.group} (${r1.groupLabel}) · [LoC record](${r1.itemUrl}) · catalog date: ${r1.date || "none"}` +
			(row1.thumbnail === "yes" ? " · **150px thumbnail only**" : ""),
		"",
		`<img src="${r1.imageUrl}" width="400">`,
		"",
		`**Catalog title:** ${r1.title}`,
		"",
		`**Cataloger's reference:** ${r1.reference}`,
		"",
		"### Scores",
		"",
		"Each cell: baseline / panel median. ⚠ = they differ by 2 or more.",
		"",
		`| Version | ${KEYS.map((k) => LABELS[k]).join(" | ")} |`,
		`| --- | ${KEYS.map(() => "---").join(" | ")} |`,
	];
	for (const v of VERSIONS) {
		const row = data.scores[v][i];
		const panel = panelScores(gradesFor(data.grades, `claude-${v}`, photo));
		const cells = KEYS.map((k) => {
			const flag = Math.abs(panel[k] - row[k]) >= FLAG ? " ⚠" : "";
			return `${row[k]} / ${fmt(panel[k])}${flag}`;
		});
		lines.push(`| Claude ${v} | ${cells.join(" | ")} |`);
	}
	for (const m of OTHER_MODELS) {
		const panel = panelScores(gradesFor(data.grades, m, photo));
		lines.push(`| ${m} | ${KEYS.map((k) => `– / ${fmt(panel[k])}`).join(" | ")} |`);
	}
	lines.push("");
	for (const v of VERSIONS) lines.push(`**Baseline notes (${v}):** ${data.scores[v][i].notes}`, "");

	for (const v of VERSIONS) {
		lines.push(
			`### Claude ${v}`,
			"",
			descriptionBlock(data.results[v][i]),
			"",
			`<details><summary>Judges' reasons for Claude ${v}</summary>`,
			"",
			judgeReasons(gradesFor(data.grades, `claude-${v}`, photo)),
			"",
			"</details>",
			""
		);
	}

	lines.push("<details><summary>Other models' descriptions</summary>", "");
	for (const m of OTHER_MODELS) lines.push(`#### ${m}`, "", descriptionBlock(data.others[m][i]), "");
	lines.push("</details>", "", "---", "");
	return lines.join("\n");
}

function buildReport(data) {
	const count = data.scores.v1.length;
	const contents = data.scores.v1.map((r, i) => `[${i + 1}](${anchor(i + 1, r.title)})`).join(" · ");
	return [
		"# Evaluation review",
		"",
		`Everything for each of the ${count} photos in one place. Generated by \`node eval/report.js\`; ` +
			"edit the scores in [scores-v1.csv](scores-v1.csv) and [scores-v2.csv](scores-v2.csv), not here, then re-run it.",
		"",
		"- **Baseline:** scores drafted by Claude and verified by a person against [RUBRIC.md](RUBRIC.md).",
		`- **Panel:** median of the four judge models (${OTHER_MODELS.join(", ")}), never counting a model's grade of its own description. Overall results: [judges/summary.md](judges/summary.md).`,
		"",
		`## Check first: baseline and panel differ by ${FLAG}+ points`,
		"",
		gapList(gaps(data, FLAG)),
		"",
		`## Worth a look: they differ by ${LOOK} points`,
		"",
		gapList(gaps(data, LOOK).filter((x) => Math.abs(x.panel - x.base) < FLAG)),
		"",
		`**Photos:** ${contents}`,
		"",
		"---",
		"",
		...data.scores.v1.map((_, i) => photoSection(data, i)),
	].join("\n");
}

if (require.main === module) {
	const report = buildReport(load());
	fs.writeFileSync(path.join(EVAL_DIR, "REVIEW.md"), report);
	console.log(`[eval] Wrote eval/REVIEW.md (${report.length.toLocaleString()} characters)`);
}

module.exports = { buildReport };
