"use strict";

/**
 * Summarizes the model judges' grades (eval/judges/grades.json):
 *   1. Which descriptions scored best: Claude v1, Claude v2 and each other model's own.
 *   2. How closely each judge agrees with the hand-checked scores (scores-v1/v2.csv).
 *   3. Whether judges favor their own descriptions.
 *   4. Photos where the judges and the hand scores disagree by 2+ points (check these first).
 *
 * Usage: node eval/compare.js    Writes eval/judges/summary.md and prints it.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readScores } = require("./summarize");

const EVAL_DIR = __dirname;
const JUDGE_DIR = path.join(EVAL_DIR, "judges");
const KEYS = ["accuracy", "completeness", "usefulness", "reference"];
const LABELS = { accuracy: "Accuracy", completeness: "Completeness", usefulness: "Usefulness", reference: "Matches reference" };

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, digits = 2) => (Number.isNaN(x) ? "-" : x.toFixed(digits));
const pct = (x) => (Number.isNaN(x) ? "-" : `${Math.round(x * 100)}%`);

function table(header, rows) {
	return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function summarizeGrades(grades, handScores) {
	const judges = [...new Set(grades.map((g) => g.judge))];
	const authors = [...new Set(grades.map((g) => g.author))];
	const thumbnails = new Set(handScores.v1.filter((r) => r.thumbnail === "yes").map((r) => Number(r.photo)));
	const hand = { "claude-v1": handScores.v1, "claude-v2": handScores.v2 };
	const handScore = (author, photo, key) => Number(hand[author][photo - 1][key]);
	const out = [];

	// 1. Leaderboard. Self-grades are left out, so no model grades its own work here.
	out.push("## 1. Which descriptions scored best (model judges, self-grades excluded)\n");
	const boardRows = authors
		.map((author) => {
			const gs = grades.filter((g) => g.author === author && g.judge !== author);
			const all = gs.flatMap((g) => KEYS.map((k) => g[k]));
			const thumbs = gs.filter((g) => thumbnails.has(g.photo));
			return { author, gs, overall: mean(all), thumbs };
		})
		.sort((a, b) => b.overall - a.overall);
	out.push(
		table(
			["Descriptions by", ...KEYS.map((k) => LABELS[k]), "Overall", "Thumbnails only (overall)", "Grades"],
			boardRows.map(({ author, gs, overall, thumbs }) => [
				author.startsWith("claude") ? `**${author}**` : author,
				...KEYS.map((k) => fmt(mean(gs.map((g) => g[k])))),
				`**${fmt(overall)}**`,
				fmt(mean(thumbs.flatMap((g) => KEYS.map((k) => g[k])))),
				gs.length,
			])
		)
	);

	// 2. Agreement with the hand-checked scores on Claude's descriptions.
	out.push("\n## 2. How closely each judge agrees with the hand scores (Claude v1 + v2, 40 descriptions)\n");
	const agreeRows = [];
	const judgeSets = [...judges.map((j) => [j, (g) => g.judge === j]), ["**judge panel (median)**", null]];
	for (const [name, filter] of judgeSets) {
		const diffs = [];
		for (const author of ["claude-v1", "claude-v2"]) {
			for (let photo = 1; photo <= 20; photo++) {
				const gs = grades.filter((g) => g.author === author && g.photo === photo && (!filter || filter(g)));
				if (!gs.length) continue;
				for (const k of KEYS) {
					const judged = filter ? gs[0][k] : median(gs.map((g) => g[k]));
					diffs.push({ k, d: judged - handScore(author, photo, k) });
				}
			}
		}
		const cellFor = (k) => {
			const gaps = diffs.filter((x) => x.k === k).map((x) => Math.abs(x.d));
			const withinOne = mean(gaps.map((g) => (g <= 1 ? 1 : 0)));
			return `${fmt(mean(gaps))} (${pct(withinOne)})`;
		};
		agreeRows.push([name, ...KEYS.map(cellFor), fmt(mean(diffs.map((x) => x.d)))]);
	}
	out.push(
		"Each cell: average gap from the hand score in points (share within 1 point). " +
			"Bias above 0 means the judge scores higher than the hand scores.\n"
	);
	out.push(table(["Judge", ...KEYS.map((k) => LABELS[k]), "Bias"], agreeRows));

	// 3. Self-preference: own descriptions graded by self vs by the other judges.
	out.push("\n## 3. Do judges favor their own descriptions?\n");
	const selfRows = judges
		.filter((j) => authors.includes(j))
		.map((j) => {
			const own = grades.filter((g) => g.author === j && g.judge === j).flatMap((g) => KEYS.map((k) => g[k]));
			const others = grades.filter((g) => g.author === j && g.judge !== j).flatMap((g) => KEYS.map((k) => g[k]));
			return [j, fmt(mean(own)), fmt(mean(others)), fmt(mean(own) - mean(others))];
		});
	out.push(table(["Model", "Own descriptions, graded by itself", "Same descriptions, graded by the others", "Difference"], selfRows));

	// 4. Big disagreements with the hand scores.
	out.push("\n## 4. Where the judge panel and the hand scores differ by 2+ points\n");
	const flagged = [];
	for (const author of ["claude-v1", "claude-v2"]) {
		for (let photo = 1; photo <= 20; photo++) {
			const gs = grades.filter((g) => g.author === author && g.photo === photo);
			if (!gs.length) continue;
			for (const k of KEYS) {
				const panel = median(gs.map((g) => g[k]));
				const mine = handScore(author, photo, k);
				if (Math.abs(panel - mine) >= 2) {
					const reasons = gs.map((g) => `${g.judge} ${g[k]}: ${g[`${k}_reason`]}`).join("<br>");
					flagged.push([author, `${photo}. ${hand[author][photo - 1].title}`, LABELS[k], mine, panel, reasons]);
				}
			}
		}
	}
	out.push(flagged.length ? table(["Version", "Photo", "Score", "Hand", "Panel median", "Judges' reasons"], flagged) : "None.");

	return out.join("\n");
}

if (require.main === module) {
	const raw = JSON.parse(fs.readFileSync(path.join(JUDGE_DIR, "grades.json"), "utf8"));
	const grades = Object.values(raw);
	const handScores = {
		v1: readScores(path.join(EVAL_DIR, "scores-v1.csv")),
		v2: readScores(path.join(EVAL_DIR, "scores-v2.csv")),
	};
	const summary = `# Model judges: summary\n\nGenerated by \`node eval/compare.js\` from ${grades.length} grades.\n\n${summarizeGrades(grades, handScores)}\n`;
	fs.writeFileSync(path.join(JUDGE_DIR, "summary.md"), summary);
	console.log(summary);
}

module.exports = { summarizeGrades, median };
