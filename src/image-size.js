"use strict";

/**
 * Reads the width and height of a JPEG, PNG or GIF from its bytes.
 * Returns { width, height }, or null if the format isn't recognized.
 */
function imageSize(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;

	// PNG: size is in the IHDR chunk right after the 8-byte signature.
	if (buffer.readUInt32BE(0) === 0x89504e47) {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}

	// GIF: little-endian width and height after the 6-byte header.
	if (buffer.toString("ascii", 0, 3) === "GIF") {
		return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
	}

	// JPEG: walk the segments until a start-of-frame (SOF) marker.
	if (buffer[0] === 0xff && buffer[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < buffer.length) {
			if (buffer[offset] !== 0xff) return null;
			const marker = buffer[offset + 1];
			const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
			if (isStartOfFrame) {
				return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
			}
			offset += 2 + buffer.readUInt16BE(offset + 2);
		}
	}

	return null;
}

module.exports = { imageSize };
