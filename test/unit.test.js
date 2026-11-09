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

const { pickImageUrl, extractSummary } = require("../eval/run");
const { parseCsvLine } = require("../eval/summarize");

test("eval pickImageUrl chooses the image closest to 640px tall", () => {
	const urls = [
		"https://tile.loc.gov/a_150px.jpg#h=150&w=100",
		"https://tile.loc.gov/ar.jpg#h=640&w=427",
		"https://tile.loc.gov/av.jpg#h=1024&w=683",
	];
	assert.equal(pickImageUrl(urls), "https://tile.loc.gov/ar.jpg");
	assert.equal(pickImageUrl(["https://tile.loc.gov/a_150px.jpg#h=150&w=122"]), "https://tile.loc.gov/a_150px.jpg");
	assert.equal(pickImageUrl([]), "");
});

test("eval extractSummary handles string and array summaries", () => {
	assert.equal(extractSummary({ summary: " Photograph shows a sign. " }), "Photograph shows a sign.");
	assert.equal(extractSummary({ summary: ["Part one.", "Part two."] }), "Part one. Part two.");
	assert.equal(extractSummary({}), "");
});

test("eval parseCsvLine keeps commas inside quoted fields", () => {
	assert.deepEqual(parseCsvLine('1,A,"Says ""hi"", then leaves",5'), ["1", "A", 'Says "hi", then leaves', "5"]);
});

const { imageSize } = require("../src/image-size");
const { isLowResolution } = require("../src/loc");
const { buildRequest } = require("../src/claude");

test("imageSize reads PNG, GIF and JPEG dimensions", () => {
	const png = Buffer.alloc(24);
	png.writeUInt32BE(0x89504e47, 0);
	png.writeUInt32BE(640, 16);
	png.writeUInt32BE(480, 20);
	assert.deepEqual(imageSize(png), { width: 640, height: 480 });

	const gif = Buffer.alloc(24);
	gif.write("GIF89a", 0, "ascii");
	gif.writeUInt16LE(150, 6);
	gif.writeUInt16LE(122, 8);
	assert.deepEqual(imageSize(gif), { width: 150, height: 122 });

	// SOI, then an APP0 segment (length 4), then SOF0 with height 150 and width 121.
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x96, 0x00, 0x79, 0x03, 0, 0, 0, 0, 0, 0]);
	assert.deepEqual(imageSize(jpeg), { width: 121, height: 150 });

	assert.equal(imageSize(Buffer.from("not an image at all, just text")), null);
});

test("isLowResolution flags thumbnails only", () => {
	assert.equal(isLowResolution({ width: 150, height: 122 }), true);
	assert.equal(isLowResolution({ width: 427, height: 640 }), false);
	assert.equal(isLowResolution(null), false);
});

test("buildRequest marks low-resolution photos in the prompt", () => {
	const photo = { title: "T", date: "1930", mediaType: "image/jpeg", base64: "" };
	const request = buildRequest([photo, { ...photo, lowResolution: true }], "s", "l");
	const labels = request.messages[0].content.filter((c) => c.type === "text").map((c) => c.text);
	assert.ok(!labels[0].includes("LOW RESOLUTION"));
	assert.ok(labels[1].includes("LOW RESOLUTION"));
});

test("renderResults shows a notice for low-resolution photos", () => {
	const photo = { title: "T", imageUrl: "https://x/y.jpg", description: "d", estimatedPeriod: "", notableDetails: [] };
	assert.ok(renderResults("s", "l", [{ ...photo, lowResolution: true }]).includes("Low-resolution image"));
	assert.ok(!renderResults("s", "l", [photo]).includes("Low-resolution image"));
});
