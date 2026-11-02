"use strict";

/** Server-side HTML rendering. All dynamic values are escaped. */

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function layout(title, body) {
	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escapeHtml(title)} | Historic Photo Explorer</title>
		<link rel="stylesheet" href="/styles.css" />
	</head>
	<body>
		<main>
${body}
		</main>
	</body>
</html>`;
}

function renderMessage(title, message) {
	return layout(
		title,
		`			<h1>${escapeHtml(title)}</h1>
			<p>${escapeHtml(message)}</p>
			<p><a href="/">&larr; New search</a></p>`
	);
}

function renderPhoto(photo, index) {
	const details = photo.notableDetails.length
		? `<ul>${photo.notableDetails.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`
		: "";
	const period = photo.estimatedPeriod
		? `<p class="period"><strong>Estimated period:</strong> ${escapeHtml(photo.estimatedPeriod)}</p>`
		: "";
	const source = photo.itemUrl
		? `<p class="source"><a href="${escapeHtml(photo.itemUrl)}">View on loc.gov</a></p>`
		: "";

	return `			<article class="photo">
				<h2>Photo ${index + 1}: ${escapeHtml(photo.title)}</h2>
				<img src="${escapeHtml(photo.imageUrl)}" alt="${escapeHtml(photo.title)} (described below)" loading="lazy" />
				${period}
				<p>${escapeHtml(photo.description)}</p>
				${details}
				${source}
			</article>`;
}

function renderResults(subject, location, photos) {
	const heading = `"${subject}" in ${location}`;
	return layout(
		heading,
		`			<p><a href="/">&larr; New search</a></p>
			<h1>${escapeHtml(heading)}</h1>
			<p class="summary">${photos.length} photo${photos.length === 1 ? "" : "s"} from the Library of Congress, described by Claude.</p>
${photos.map(renderPhoto).join("\n")}`
	);
}

module.exports = { escapeHtml, renderMessage, renderResults };
