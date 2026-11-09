"use strict";

/**
 * Summarizes the model judges' grades (eval/judges/grades.json):
 *   1. Which descriptions scored best: Claude v1, Claude v2 and each other model's own.
 *   2. How closely each judge agrees with the human-verified baseline (scores-v1/v2.csv).
 *   3. Whether judges favor their own descriptions.
 *   4. Photos where the judges and the baseline disagree by 2+ points (check these first).
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

/** Seeded random numbers, so the bootstrap intervals are the same on every run. */
function seededRandom(seed) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Ranks with ties given their average rank. */
function ranks(xs) {
	const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
	const out = new Array(xs.length);
	for (let i = 0; i < order.length; ) {
		let j = i;
		while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
		for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2 + 1;
		i = j + 1;
	}
	return out;
}

/** Spearman rank correlation between two equal-length lists. */
function spearman(xs, ys) {
	const rx = ranks(xs);
	const ry = ranks(ys);
	const mx = mean(rx);
	const my = mean(ry);
	let num = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < rx.length; i++) {
		num += (rx[i] - mx) * (ry[i] - my);
		dx += (rx[i] - mx) ** 2;
		dy += (ry[i] - my) ** 2;
	}
	return num / Math.sqrt(dx * dy);
}

/** 95% bootstrap interval for an author's overall score, resampling photos. */
function bootstrapInterval(gs, rounds = 2000) {
	const random = seededRandom(42);
	const photos = [...new Set(gs.map((g) => g.photo))];
	const byPhoto = photos.map((p) => gs.filter((g) => g.photo === p).flatMap((g) => KEYS.map((k) => g[k])));
	const stats = [];
	for (let r = 0; r < rounds; r++) {
		const sample = [];
		for (let i = 0; i < photos.length; i++) sample.push(...byPhoto[Math.floor(random() * photos.length)]);
		stats.push(mean(sample));
	}
	stats.sort((a, b) => a - b);
	return [stats[Math.floor(rounds * 0.025)], stats[Math.floor(rounds * 0.975)]];
}

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
			return { author, gs, overall: mean(all), thumbs, interval: bootstrapInterval(gs) };
		})
		.sort((a, b) => b.overall - a.overall);
	out.push("The 95% interval comes from resampling the 20 photos 2,000 times. Where intervals overlap, the difference may be chance.\n");
	out.push(
		table(
			["Descriptions by", ...KEYS.map((k) => LABELS[k]), "Overall", "95% interval", "Thumbnails only (overall)", "Grades"],
			boardRows.map(({ author, gs, overall, thumbs, interval }) => [
				author.startsWith("claude") ? `**${author}**` : author,
				...KEYS.map((k) => fmt(mean(gs.map((g) => g[k])))),
				`**${fmt(overall)}**`,
				`${fmt(interval[0])}–${fmt(interval[1])}`,
				fmt(mean(thumbs.flatMap((g) => KEYS.map((k) => g[k])))),
				gs.length,
			])
		)
	);

	// 1b. Paired comparison: Claude against each other model on the same photos, using only
	// judges that wrote neither description, so no self-grades are involved.
	out.push("\n### Claude compared with each other model (paired by photo)\n");
	const pairRows = [];
	for (const a of authors.filter((x) => x.startsWith("claude"))) {
		for (const b of authors.filter((x) => !x.startsWith("claude"))) {
			const shared = judges.filter((j) => j !== a && j !== b);
			const overallFor = (author, photo) =>
				mean(grades.filter((g) => g.author === author && g.photo === photo && shared.includes(g.judge)).flatMap((g) => KEYS.map((k) => g[k])));
			const diffs = [];
			for (let photo = 1; photo <= 20; photo++) diffs.push(overallFor(a, photo) - overallFor(b, photo));
			const random = seededRandom(42);
			const stats = [];
			for (let r = 0; r < 2000; r++) {
				const sample = [];
				for (let i = 0; i < diffs.length; i++) sample.push(diffs[Math.floor(random() * diffs.length)]);
				stats.push(mean(sample));
			}
			stats.sort((x, y) => x - y);
			pairRows.push([a, b, fmt(mean(diffs)), `${fmt(stats[50])} to ${fmt(stats[1949])}`, `${diffs.filter((d) => d > 0).length}/20`]);
		}
	}
	out.push("Difference in overall score (Claude minus the other model). If the 95% interval includes 0, the lead may be chance.\n");
	out.push(table(["Claude", "Compared with", "Difference", "95% interval", "Photos where Claude scored higher"], pairRows));

	// 2. Agreement with the hand-checked scores on Claude's descriptions.
	out.push("\n## 2. How closely each judge agrees with the human-verified baseline (Claude v1 + v2, 40 descriptions)\n");
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
					const base = handScore(author, photo, k);
					diffs.push({ k, d: judged - base, judged, base });
				}
			}
		}
		const cellFor = (k) => {
			const gaps = diffs.filter((x) => x.k === k).map((x) => Math.abs(x.d));
			const withinOne = mean(gaps.map((g) => (g <= 1 ? 1 : 0)));
			return `${fmt(mean(gaps))} (${pct(withinOne)})`;
		};
		const exact = mean(diffs.map((x) => (x.d === 0 ? 1 : 0)));
		const rho = spearman(
			diffs.map((x) => x.judged),
			diffs.map((x) => x.base)
		);
		agreeRows.push([name, ...KEYS.map(cellFor), pct(exact), fmt(rho), fmt(mean(diffs.map((x) => x.d)))]);
	}
	out.push(
		"Each score cell: average gap from the baseline score in points (share within 1 point). " +
			"Exact match and rank correlation (Spearman) cover all four scores together. " +
			"Bias above 0 means the judge scores higher than the baseline.\n"
	);
	out.push(table(["Judge", ...KEYS.map((k) => LABELS[k]), "Exact match", "Rank correlation", "Bias"], agreeRows));

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
	out.push("\n## 4. Where the judge panel and the baseline differ by 2+ points\n");
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
	out.push(flagged.length ? table(["Version", "Photo", "Score", "Baseline", "Panel median", "Judges' reasons"], flagged) : "None.");

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
