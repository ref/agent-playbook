// Tests for `.agents/ask-page.mjs` — the validation that must reject a bad
// question BEFORE a tab opens, and the rendering that must not let question
// text escape into markup.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inlineJson, renderPage, validateQuestion } from './ask-page.mjs';

const SCRIPT = resolve(import.meta.dirname, 'ask-page.mjs');

const good = () => ({
	title: 'Pick one',
	question: 'Which?',
	options: [
		{ id: 'a', label: 'A', recommended: true },
		{ id: 'b', label: 'B', description: 'second' },
	],
});

describe('validateQuestion', () => {
	it('accepts a well-formed question', () => {
		expect(validateQuestion(good())).toEqual([]);
	});

	it('accepts optional context', () => {
		expect(validateQuestion({ ...good(), context: 'why we ask' })).toEqual([]);
	});

	it('rejects a non-object', () => {
		expect(validateQuestion(null)).not.toEqual([]);
		expect(validateQuestion([])).not.toEqual([]);
		expect(validateQuestion('q')).not.toEqual([]);
	});

	it('requires title, question and at least one option', () => {
		const problems = validateQuestion({ title: ' ', question: '', options: [] });
		expect(problems.join('\n')).toMatch(/title/);
		expect(problems.join('\n')).toMatch(/question/);
		expect(problems.join('\n')).toMatch(/options/);
	});

	it('caps options at nine — one digit key each', () => {
		const options = Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: `o${i}` }));
		expect(validateQuestion({ ...good(), options }).join()).toMatch(/at most 9/);
	});

	it('rejects duplicate ids, which would make the answer ambiguous', () => {
		expect(validateQuestion({ ...good(), options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }).join()).toMatch(/duplicate/);
	});

	it('rejects more than one recommended option', () => {
		const options = [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B', recommended: true }];
		expect(validateQuestion({ ...good(), options }).join()).toMatch(/one option may be recommended/);
	});

	it('rejects options missing a label', () => {
		expect(validateQuestion({ ...good(), options: [{ id: 'a' }] }).join()).toMatch(/label/);
	});
});

describe('renderPage', () => {
	it('inlines the question at the placeholder', () => {
		const page = renderPage('<script>var Q = /*ASK_QUESTION*/null;</script>', good());
		expect(page).toContain('"title":"Pick one"');
		expect(page).not.toContain('/*ASK_QUESTION*/');
	});

	it('cannot be closed out of its script tag by question text', () => {
		const q = { ...good(), title: '</script><img src=x onerror=alert(1)>' };
		const page = renderPage('<script>var Q = /*ASK_QUESTION*/null;</script>', q);
		expect(page.match(/<\/script>/g)).toHaveLength(1);
		expect(JSON.parse(inlineJson(q))).toEqual(q);
	});

	// A `$&` in question text must not be read as a replacement pattern.
	it('keeps replacement patterns in question text literal', () => {
		const page = renderPage('/*ASK_QUESTION*/null', { ...good(), title: 'costs $& and $1' });
		expect(page).toContain('costs $& and $1');
	});
});

describe('the CLI', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ask-page-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('writes the page for a valid question', () => {
		const q = join(dir, 'q.json');
		const out = join(dir, 'out.html');
		writeFileSync(q, JSON.stringify(good()));
		execFileSync(process.execPath, [SCRIPT, 'render', q, out]);
		expect(readFileSync(out, 'utf8')).toContain('"title":"Pick one"');
	});

	it('exits 2 and writes nothing for an invalid question', () => {
		const q = join(dir, 'bad.json');
		const out = join(dir, 'bad.html');
		writeFileSync(q, JSON.stringify({ title: 'x' }));
		let status = 0;
		try {
			execFileSync(process.execPath, [SCRIPT, 'render', q, out], { stdio: 'pipe' });
		} catch (e) {
			status = (e as { status: number }).status;
		}
		expect(status).toBe(2);
		expect(() => readFileSync(out)).toThrow();
	});
});
