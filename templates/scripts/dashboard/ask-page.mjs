// The page half of `.agents/ask.sh`: validates a question and renders it into
// `.agents/ask.html`.
//
//   node ask-page.mjs render <question.json | -> <out.html>
//
// Exit 0 with the page written, or 2 with the reason on stderr — a malformed
// question must fail BEFORE a tab opens, not as an empty page the human has
// to close.
//
// The question (first version: options and a free-text field, nothing else):
//
//   {
//     "title":    "Short heading",                  required
//     "question": "The question itself",            required
//     "context":  "One paragraph of background",    optional
//     "options": [                                  1–9 of them
//       { "id": "a", "label": "Option A", "description": "…", "recommended": true }
//     ]
//   }
//
// The answer ask.sh prints: { "choice": "<id>" | null, "label": "…" | null,
// "note": "…" | null }. A note alone is a valid answer — "none of these,
// because …" is exactly what the free field is for.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_OPTIONS = 9; // one digit key per option

/** The problems with a question, empty when it is usable. */
export function validateQuestion(q) {
	const problems = [];
	if (q === null || typeof q !== 'object' || Array.isArray(q)) return ['the question must be a JSON object'];
	const str = (v) => typeof v === 'string' && v.trim() !== '';
	if (!str(q.title)) problems.push('"title" must be a non-empty string');
	if (!str(q.question)) problems.push('"question" must be a non-empty string');
	if (q.context !== undefined && typeof q.context !== 'string') problems.push('"context" must be a string');
	if (!Array.isArray(q.options) || q.options.length === 0) {
		problems.push(`"options" must be an array of 1–${MAX_OPTIONS} options`);
		return problems;
	}
	if (q.options.length > MAX_OPTIONS) problems.push(`at most ${MAX_OPTIONS} options (one digit key each), got ${q.options.length}`);
	const ids = new Set();
	q.options.forEach((o, i) => {
		const at = `options[${i}]`;
		if (o === null || typeof o !== 'object') return problems.push(`${at} must be an object`);
		if (!str(o.id)) problems.push(`${at}.id must be a non-empty string`);
		else if (ids.has(o.id)) problems.push(`${at}.id "${o.id}" is a duplicate`);
		else ids.add(o.id);
		if (!str(o.label)) problems.push(`${at}.label must be a non-empty string`);
		if (o.description !== undefined && typeof o.description !== 'string') problems.push(`${at}.description must be a string`);
		if (o.recommended !== undefined && typeof o.recommended !== 'boolean') problems.push(`${at}.recommended must be true or false`);
	});
	if (q.options.filter((o) => o?.recommended === true).length > 1) problems.push('at most one option may be recommended');
	return problems;
}

/** The question inlined into a <script>: `<` escaped so no text can close the tag. */
export function inlineJson(value) {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderPage(template, question) {
	return template.replace('/*ASK_QUESTION*/null', () => inlineJson(question));
}

function main(argv) {
	const [cmd, input, out] = argv;
	if (cmd !== 'render' || !input || !out) {
		process.stderr.write('usage: ask-page.mjs render <question.json | -> <out.html>\n');
		return 2;
	}
	let question;
	try {
		question = JSON.parse(readFileSync(input === '-' ? 0 : input, 'utf8'));
	} catch (e) {
		process.stderr.write(`ask: the question is not readable JSON: ${e.message}\n`);
		return 2;
	}
	const problems = validateQuestion(question);
	if (problems.length) {
		process.stderr.write(`ask: invalid question:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
		return 2;
	}
	writeFileSync(out, renderPage(readFileSync(resolve(HERE, 'ask.html'), 'utf8'), question));
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = main(process.argv.slice(2));
}
