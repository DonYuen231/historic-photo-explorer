"use strict";

/** A small in-memory cache with a time-to-live and a size limit. */
class TtlCache {
	constructor({ ttlMs, maxEntries, now = Date.now }) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
		this.now = now;
		this.entries = new Map();
	}

	get(key) {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key, value) {
		this.entries.delete(key);
		this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });

		// Maps keep insertion order, so the first key is the oldest.
		while (this.entries.size > this.maxEntries) {
			this.entries.delete(this.entries.keys().next().value);
		}
	}
}

module.exports = { TtlCache };
