"use strict";

/**
 * Claude Messages API client (raw HTTPS, API-key auth).
 * Docs: https://platform.claude.com/docs/en/api/messages
 */

const { postJson, HttpError } = require("./http-client");
const config = require("./config");

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

// Structured output: Claude must reply with JSON that matches this schema.
const RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		photos: {
			type: "array",
			items: {
				type: "object",
				properties: {
					photo_number: { type: "integer" },
					description: { type: "string" },
					estimated_period: { type: "string" },
					notable_details: { type: "array", items: { type: "string" } },
				},
				required: ["photo_number", "description", "estimated_period", "notable_details"],
				additionalProperties: false,
			},
		},
	},
	required: ["photos"],
	additionalProperties: false,
};

function buildRequest(photos, subject, location) {
	const content = [];

	photos.forEach((photo, i) => {
		const dated = photo.date ? ` (catalog date: ${photo.date.slice(0, 4)})` : "";
		content.push({ type: "text", text: `Photo ${i + 1}: "${photo.title}"${dated}` });
		content.push({
			type: "image",
			source: { type: "base64", media_type: photo.mediaType, data: photo.base64 },
		});
	});

	content.push({
		type: "text",
		text:
			`These are historical images from the Library of Congress, found by searching for ` +
			`"${subject}" in "${location}". For each photo, write a description for a visually ` +
			`impaired reader: what is depicted, the setting, and the people, structures or objects ` +
			`in view. Estimate the time period and list a few notable details. Use plain text only, ` +
			`no Markdown. Return one entry per photo, numbered to match.`,
	});

	return {
		model: config.claudeModel,
		max_tokens: 16000,
		output_config: {
			effort: "medium",
			format: { type: "json_schema", schema: RESPONSE_SCHEMA },
		},
		// If the request is declined by a safety classifier, retry on Anthropic's recommended fallback model.
		fallbacks: "default",
		messages: [{ role: "user", content }],
	};
}

/** Pulls the JSON answer out of a Messages API response. */
function parseResponse(response) {
	if (response.stop_reason === "refusal") {
		throw new Error("Claude declined to describe these images.");
	}
	if (response.stop_reason === "max_tokens") {
		throw new Error("Claude's response was cut off before it finished.");
	}

	const textBlock = (response.content || []).find((block) => block.type === "text");
	if (!textBlock) {
		throw new Error("Claude's response did not include any text.");
	}

	const parsed = JSON.parse(textBlock.text);
	if (!Array.isArray(parsed.photos)) {
		throw new Error("Claude's response was not in the expected format.");
	}
	return parsed.photos;
}

/** Step 3: send the downloaded images to Claude and get a description of each. */
function describePhotos(photos, subject, location, callback) {
	console.log(`[claude] POST ${MESSAGES_URL} (${photos.length} images, model ${config.claudeModel})`);

	const options = {
		timeoutMs: config.timeouts.claude,
		headers: {
			"x-api-key": config.anthropicApiKey,
			"anthropic-version": "2026-10-21",
			"anthropic-beta": "server-side-fallback-2026-07-01",
		},
	};

	postJson(MESSAGES_URL, options, buildRequest(photos, subject, location), (err, response) => {
		if (err) {
			if (err instanceof HttpError) {
				console.error(`[claude] ${err.message}: ${err.body}`);
			}
			return callback(err);
		}

		let descriptions;
		try {
			descriptions = parseResponse(response);
		} catch (parseErr) {
			return callback(parseErr);
		}

		// Match each description back to its photo by number.
		const described = photos.map((photo, i) => {
			const match = descriptions.find((d) => d.photo_number === i + 1) || descriptions[i] || {};
			return {
				title: photo.title,
				date: photo.date,
				itemUrl: photo.itemUrl,
				imageUrl: photo.imageUrl,
				description: match.description || "No description was returned for this photo.",
				estimatedPeriod: match.estimated_period || "",
				notableDetails: Array.isArray(match.notable_details) ? match.notable_details : [],
			};
		});

		callback(null, described);
	});
}

module.exports = { buildRequest, parseResponse, describePhotos };
