"use strict";

/**
 * Library of Congress photo search (public API, no key required).
 * Docs: https://www.loc.gov/apis/json-and-yaml/
 */

const { getJson, getBuffer } = require("./http-client");
const config = require("./config");

// The /photos/ endpoint covers the "Photos, Prints, Drawings" format.
// (Querying /search/ with a format facet redirects here and drops other facets.)
const PHOTOS_ENDPOINT = "https://www.loc.gov/photos/";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function buildSearchUrl(subject, location) {
	const url = new URL(PHOTOS_ENDPOINT);
	url.searchParams.set("q", subject);
	url.searchParams.set("fa", `location:${location.toLowerCase()}`);
	url.searchParams.set("fo", "json");
	url.searchParams.set("c", "25");
	return url.toString();
}

/** Picks the useful fields out of a raw LoC search response. */
function extractPhotos(data, limit) {
	const results = (data && (data.results || (data.content && data.content.results))) || [];

	return results
		.map((result) => {
			const item = result.item || {};
			return {
				title: result.title || item.title || "Untitled",
				date: result.date || "",
				itemUrl: result.url || result.id || "",
				imageUrl: item.service_medium || item.service_low || "",
			};
		})
		.filter((photo) => photo.imageUrl.startsWith("https://"))
		.slice(0, limit);
}

/** Step 1: search the Library of Congress for matching photos. */
function searchPhotos(subject, location, callback) {
	const url = buildSearchUrl(subject, location);
	console.log(`[loc] GET ${url}`);

	getJson(url, { timeoutMs: config.timeouts.loc }, (err, data) => {
		if (err) return callback(err);
		callback(null, extractPhotos(data, config.maxPhotos));
	});
}

/**
 * Step 2: download each image one at a time and attach it as base64.
 * Images that fail to download are skipped rather than failing the whole search.
 */
function downloadImages(photos, callback) {
	const downloaded = [];

	function next(index) {
		if (index >= photos.length) {
			return callback(null, downloaded);
		}

		const photo = photos[index];
		getBuffer(photo.imageUrl, { timeoutMs: config.timeouts.image }, (err, result) => {
			if (err) {
				console.warn(`[loc] Skipping image ${photo.imageUrl}: ${err.message}`);
				return next(index + 1);
			}

			const mediaType = String(result.headers["content-type"] || "").split(";")[0].trim();
			if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
				console.warn(`[loc] Skipping image ${photo.imageUrl}: unsupported type "${mediaType}"`);
				return next(index + 1);
			}

			downloaded.push({ ...photo, mediaType, base64: result.buffer.toString("base64") });
			next(index + 1);
		});
	}

	next(0);
}

module.exports = { buildSearchUrl, extractPhotos, searchPhotos, downloadImages };
