"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { escapeHtml, renderResults } = require("../src/views");
const { buildSearchUrl, extractPhotos } = require("../src/loc");
const { parseResponse } = require("../src/claude");
const { parseSearchParams } = require("../src/server");
const { TtlCache } = require("../src/cache");

test("escapeHtml escapes HTML special characters", () => {
	assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("renderResults escapes user input", () => {
	const html = renderResults("<script>", "NY", []);
	assert.ok(!html.includes("<script>"));
	assert.ok(html.includes("&lt;script&gt;"));
});

test("buildSearchUrl targets the photos endpoint with a location facet", () => {
	const url = new URL(buildSearchUrl("covered bridges", "New York"));
	assert.equal(url.pathname, "/photos/");
	assert.equal(url.searchParams.get("q"), "covered bridges");
	assert.equal(url.searchParams.get("fa"), "location:new york");
	assert.equal(url.searchParams.get("fo"), "json");
});

test("extractPhotos keeps results with HTTPS images and applies the limit", () => {
	const data = {
		results: [
			{ title: "A", url: "https://loc.gov/a", item: { service_medium: "https://img/a.jpg" } },
			{ title: "B", item: {} },
			{ title: "C", item: { service_low: "https://img/c.jpg" } },
			{ title: "D", item: { service_medium: "https://img/d.jpg" } },
		],
	};
	const photos = extractPhotos(data, 2);
	assert.deepEqual(photos.map((p) => p.title), ["A", "C"]);
	assert.equal(photos[1].imageUrl, "https://img/c.jpg");
});

test("extractPhotos handles missing results", () => {
	assert.deepEqual(extractPhotos({}, 5), []);
	assert.deepEqual(extractPhotos(null, 5), []);
});

test("parseResponse reads the JSON text block and skips thinking blocks", () => {
	const photos = parseResponse({
		stop_reason: "end_turn",
		content: [
			{ type: "thinking", thinking: "" },
			{ type: "text", text: JSON.stringify({ photos: [{ photo_number: 1, description: "A bridge" }] }) },
		],
	});
	assert.equal(photos[0].description, "A bridge");
});

test("parseResponse rejects refusals and truncated output", () => {
	assert.throws(() => parseResponse({ stop_reason: "refusal", content: [] }), /declined/);
	assert.throws(() => parseResponse({ stop_reason: "max_tokens", content: [] }), /cut off/);
});

test("parseSearchParams validates input", () => {
	assert.deepEqual(parseSearchParams(new URLSearchParams("subject= bridges &location=Ohio")), {
		subject: "bridges",
		location: "Ohio",
	});
	assert.ok(parseSearchParams(new URLSearchParams("subject=bridges")).error);
	assert.ok(parseSearchParams(new URLSearchParams(`subject=${"x".repeat(101)}&location=Ohio`)).error);
});

test("TtlCache expires entries and evicts the oldest", () => {
	let time = 0;
	const cache = new TtlCache({ ttlMs: 100, maxEntries: 2, now: () => time });

	cache.set("a", 1);
	cache.set("b", 2);
	cache.set("c", 3);
	assert.equal(cache.get("a"), undefined);
	assert.equal(cache.get("b"), 2);

	time = 150;
	assert.equal(cache.get("c"), undefined);
});
