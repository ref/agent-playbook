// The data half of `.agents/dashboard.sh`: collects where the repository
// stands from git, gh and cmux, and renders it into `.agents/dashboard.html`.
//
//   node dashboard-data.mjs json                         print the data
//   node dashboard-data.mjs group-of <workspace-ref>     the cmux group holding it
//   node dashboard-data.mjs push --out <file> [--surface <uuid>]
//                                                        write the page; if the
//                                                        tab is open, update it
//
// Split from the shell script for the same reason as task-status-stop.mjs:
// this is JSON work, and the classification rules below are the part most
// likely to be wrong, so they are pure functions with tests beside them
// (`dashboard-data.test.ts`).
//
// FAIL OPEN, PER SOURCE. A dashboard that goes blank because gh rate-limited
// once tells you less than one that shows git's half and says gh failed. Each
// collector catches its own failure and records it in `errors`; the page
// renders whatever arrived.
//
// Nothing here is project-specific: no paths, names or domains. The repo is
// whatever `git` and `gh` see from the current directory.

import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Pure rules — tested in dashboard-data.test.ts
// ---------------------------------------------------------------------------

/** `- [x]` / `- [ ]` task-list items in a markdown body, or null when there are none. */
export function checklist(body) {
	if (typeof body !== 'string') return null;
	let done = 0;
	let total = 0;
	for (const line of body.split('\n')) {
		const m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+\S/);
		if (!m) continue;
		total += 1;
		if (m[1] !== ' ') done += 1;
	}
	return total === 0 ? null : { done, total };
}

/**
 * Issue numbers a PR body links with a closing or referencing keyword.
 * Bare `#12` mentions are not links — a PR body cites other PRs constantly.
 */
export function linkedIssues(body) {
	if (typeof body !== 'string') return [];
	const out = [];
	const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b[:\s]+#(\d+)/gi;
	for (const m of body.matchAll(re)) {
		const n = Number(m[1]);
		if (!out.includes(n)) out.push(n);
	}
	return out;
}

/**
 * The review skill's verdict comments, oldest first. A verdict comment opens
 * with `Reviewed-by: <tool / family>, head <sha>` and carries
 * `VERDICT: approve` or `VERDICT: blocker` (AGENTS.md "Reviewer protocol").
 */
export function verdicts(comments) {
	if (!Array.isArray(comments)) return [];
	return comments
		.filter((c) => typeof c?.body === 'string' && c.body.startsWith('Reviewed-by:'))
		.map((c) => {
			const first = c.body.split('\n')[0];
			const head = first.match(/head\s+([0-9a-f]{7,40})/i)?.[1] ?? null;
			const v = c.body.match(/VERDICT:\s*\**\s*(approve|blocker)/i)?.[1]?.toLowerCase() ?? null;
			const by = first.replace(/^Reviewed-by:\s*/, '').split(',')[0].trim();
			return { verdict: v, head, by, at: c.createdAt ?? null };
		});
}

/** pass | fail | pending | none, from gh's statusCheckRollup. */
export function ciState(rollup) {
	if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
	const states = rollup.map((r) => String(r?.conclusion || r?.state || r?.status || '').toUpperCase());
	if (states.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)))
		return 'fail';
	if (states.some((s) => ['', 'PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(s)))
		return 'pending';
	return 'pass';
}

/**
 * Where an open PR stands. Order is the order of what blocks it:
 * draft → red CI → running CI → a blocker on THIS head → approved on THIS head
 * with green CI → otherwise waiting for a review.
 *
 * A verdict counts only for the head it names. A fix push makes the last
 * verdict stale, and a stale approve shown as "ready" is the one wrong answer
 * this page must never give.
 */
export function prStage({ draft, ci, verdictList, headSha }) {
	if (draft) return 'draft';
	if (ci === 'fail') return 'ci-failed';
	const last = verdictList.at(-1) ?? null;
	const current = last && last.head && headSha && headSha.startsWith(last.head) ? last : null;
	if (current?.verdict === 'blocker') return 'blocker';
	if (ci === 'pending') return 'ci-running';
	if (current?.verdict === 'approve' && (ci === 'pass' || ci === 'none')) return 'ready';
	return 'awaiting-review';
}

/** `git worktree list --porcelain` → [{ path, head, branch, detached, bare }]. */
export function parseWorktrees(text) {
	const out = [];
	for (const block of String(text).split(/\n\s*\n/)) {
		const lines = block.split('\n').filter(Boolean);
		if (lines.length === 0) continue;
		const e = { path: null, head: null, branch: null, detached: false, bare: false };
		for (const l of lines) {
			if (l.startsWith('worktree ')) e.path = l.slice(9);
			else if (l.startsWith('HEAD ')) e.head = l.slice(5);
			else if (l.startsWith('branch ')) e.branch = l.slice(7).replace(/^refs\/heads\//, '');
			else if (l === 'detached') e.detached = true;
			else if (l === 'bare') e.bare = true;
		}
		if (e.path) out.push(e);
	}
	return out;
}

/**
 * `cmux list-status` → [{ key, value, icon, color }]. cmux 0.65.0 prints no
 * JSON for this, one `key=value icon=… color=… priority=…` line per pill, and
 * the value may contain spaces — so the value runs up to the first ` icon=`.
 */
export function parseStatusLines(text) {
	const out = [];
	for (const line of String(text).split('\n')) {
		const m = line.match(/^([^=\s]+)=(.*?)(?:\s+icon=(\S+))?(?:\s+color=(\S+))?(?:\s+priority=(-?\d+))?(?:\s+\S+=\S+)*\s*$/);
		if (!m || m[2] === '') continue;
		out.push({ key: m[1], value: m[2], icon: m[3] ?? null, color: m[4] ?? null, priority: m[5] ? Number(m[5]) : 0 });
	}
	return out.sort((a, b) => b.priority - a.priority);
}

/**
 * The ref of the workspace group holding `workspaceRef`, or null. cmux reports
 * membership only from the group side (`workspace-group list --json`), never
 * on the workspace — the same lookup as auto-review.sh's caller_group_ref.
 */
export function groupOf(doc, workspaceRef) {
	if (!workspaceRef || !Array.isArray(doc?.groups)) return null;
	const g = doc.groups.find((x) => Array.isArray(x?.member_workspace_refs) && x.member_workspace_refs.includes(workspaceRef));
	return typeof g?.ref === 'string' ? g.ref : null;
}

/** `#123` at the end of a squash subject, GitHub's own convention. */
export function prFromSubject(subject) {
	const m = String(subject).match(/\(#(\d+)\)\s*$/);
	return m ? Number(m[1]) : null;
}

/** The page's data, inlined into a <script>: `<` escaped so no string can close the tag. */
export function inlineJson(data) {
	// U+2028/2029 need no escape: since ES2019 they are legal inside string literals.
	return JSON.stringify(data).replace(/</g, '\\u003c');
}

// ---------------------------------------------------------------------------
// Collectors — impure, each one fails open into `errors`
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, ...opts });
}

function attempt(errors, source, fn, fallback) {
	try {
		return fn();
	} catch (e) {
		const msg = String(e?.stderr || e?.message || e).trim().split('\n')[0];
		errors.push({ source, message: msg.slice(0, 300) });
		return fallback;
	}
}

function collect() {
	const errors = [];
	const top = run('git', ['rev-parse', '--show-toplevel']).trim();

	const repo = attempt(errors, 'gh repo', () => JSON.parse(run('gh', ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'])), null);
	const base = repo?.defaultBranchRef?.name ?? attempt(errors, 'git default branch', () => run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, ''), 'master');

	// Remote-tracking refs are only as fresh as the last fetch. A failed fetch
	// (offline, a concurrent fetch holding the ref lock) keeps the old refs and
	// says so rather than blanking the branch list.
	attempt(errors, 'git fetch', () => run('git', ['fetch', 'origin', '--prune', '--quiet'], { timeout: 60_000 }), null);

	const prs = attempt(
		errors,
		'gh pr list',
		() =>
			JSON.parse(
				run('gh', [
					'pr', 'list', '--state', 'open', '--limit', '50', '--json',
					'number,title,url,isDraft,headRefName,headRefOid,baseRefName,createdAt,body,comments,statusCheckRollup',
				]),
			),
		[],
	).map((p) => {
		const verdictList = verdicts(p.comments);
		const ci = ciState(p.statusCheckRollup);
		return {
			number: p.number,
			title: p.title,
			url: p.url,
			head: p.headRefName,
			base: p.baseRefName,
			createdAt: p.createdAt,
			ci,
			reviews: verdictList.length,
			lastVerdict: verdictList.at(-1) ?? null,
			stage: prStage({ draft: p.isDraft, ci, verdictList, headSha: p.headRefOid }),
			issues: linkedIssues(p.body),
		};
	});

	const issues = attempt(
		errors,
		'gh issue list',
		() => JSON.parse(run('gh', ['issue', 'list', '--state', 'open', '--limit', '60', '--json', 'number,title,url,createdAt,labels,body'])),
		[],
	).map((i) => {
		const list = checklist(i.body);
		return { number: i.number, title: i.title, url: i.url, createdAt: i.createdAt, labels: (i.labels ?? []).map((l) => l.name), checklist: list, umbrella: list !== null };
	});
	const issueByNumber = new Map(issues.map((i) => [i.number, i]));

	const umbrellaFor = (issueNumbers) => {
		for (const n of issueNumbers) {
			const i = issueByNumber.get(n);
			if (i?.umbrella) return { number: i.number, title: i.title, url: i.url, ...i.checklist };
		}
		return null;
	};

	const branches = attempt(
		errors,
		'git branches',
		() =>
			run('git', ['for-each-ref', 'refs/remotes/origin', '--sort=-committerdate', '--format=%(refname:lstrip=3)%09%(committerdate:iso-strict)%09%(subject)'])
				.split('\n')
				.filter(Boolean)
				.map((l) => {
					const [name, at, subject] = l.split('\t');
					return { name, at, subject };
				})
				.filter((b) => b.name !== 'HEAD' && b.name !== base)
				.slice(0, 30)
				.map((b) => {
					const [behind, ahead] = attempt(errors, `git rev-list ${b.name}`, () => run('git', ['rev-list', '--left-right', '--count', `origin/${base}...origin/${b.name}`]).trim().split(/\s+/).map(Number), [null, null]);
					const own = prs.find((p) => p.head === b.name) ?? null;
					const stacked = prs.filter((p) => p.base === b.name);
					return {
						name: b.name,
						lastCommitAt: b.at,
						lastSubject: b.subject,
						ahead,
						behind,
						pr: own ? { number: own.number, stage: own.stage, base: own.base } : null,
						basePrs: stacked.map((p) => p.number),
						umbrella: umbrellaFor([...(own?.issues ?? []), ...stacked.flatMap((p) => p.issues)]),
					};
				}),
		[],
	);

	// Worktrees are where the work happens; a workspace is matched by its
	// current directory being the worktree or inside it. No cmux, no pills —
	// the worktree list still stands.
	const workspaces = attempt(errors, 'cmux workspace list', () => JSON.parse(run('cmux', ['workspace', 'list', '--json'], { timeout: 5000 })).workspaces, null);
	const tasks = attempt(errors, 'git worktree list', () => parseWorktrees(run('git', ['worktree', 'list', '--porcelain'])), [])
		// git lists the main working tree first, always — that is the only
		// reliable way to tell it from the linked ones.
		.map((w, i) => ({ ...w, main: i === 0 }))
		.filter((w) => !w.bare)
		.map((w) => {
			// Several workspaces can sit in one directory (the main checkout
			// usually has a few), so every match is listed with its own pills —
			// picking one would show some other session's state as this tree's.
			const matched = (workspaces ?? []).filter((x) => typeof x.current_directory === 'string' && (x.current_directory === w.path || x.current_directory.startsWith(w.path + '/')));
			const ws = matched.map((x) => ({
				title: x.title,
				ref: x.ref,
				pills: attempt(errors, `cmux list-status ${x.ref}`, () => parseStatusLines(run('cmux', ['list-status', '--workspace', x.ref], { timeout: 5000, env: { ...process.env, CMUX_QUIET: '1' } })), []),
			}));
			return {
				path: w.path,
				main: w.main,
				branch: w.branch,
				detached: w.detached,
				head: w.head?.slice(0, 7) ?? null,
				pr: prs.find((p) => p.head === w.branch)?.number ?? null,
				workspaces: ws,
			};
		});

	const merges = attempt(
		errors,
		'git log',
		() =>
			run('git', ['log', `origin/${base}`, '--first-parent', '-n', '12', '--format=%h%x09%cI%x09%s'])
				.split('\n')
				.filter(Boolean)
				.map((l) => {
					const [sha, at, subject] = l.split('\t');
					return { sha, at, subject, pr: prFromSubject(subject) };
				}),
		[],
	);

	return {
		generatedAt: new Date().toISOString(),
		repo: { name: repo?.nameWithOwner ?? top.split('/').at(-1), url: repo?.url ?? null, base },
		branches,
		prs,
		issues,
		tasks,
		merges,
		errors,
	};
}

// ---------------------------------------------------------------------------
// Rendering and delivery
// ---------------------------------------------------------------------------

function renderPage(data) {
	const tpl = readFileSync(resolve(HERE, 'dashboard.html'), 'utf8');
	return tpl.replace('/*DASHBOARD_DATA*/null', () => inlineJson(data));
}

/** Atomic: a reload mid-write must see the old page or the new one, never half. */
function writeAtomic(file, text) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/**
 * Hand fresh data to the open tab without a reload: one `eval` of
 * `window.__dashboard(<json>)`. Answers whether the tab took it.
 */
function pushToTab(surface, data) {
	try {
		const out = run('cmux', ['browser', '--surface', surface, 'eval', `window.__dashboard(${inlineJson(data)})`], { timeout: 10_000, env: { ...process.env, CMUX_QUIET: '1' } });
		return out.trim() === 'ok';
	} catch {
		return false;
	}
}

function main(argv) {
	const [cmd, ...rest] = argv;
	const opt = (name) => {
		const i = rest.indexOf(name);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	if (cmd === 'json') {
		process.stdout.write(JSON.stringify(collect(), null, 2) + '\n');
		return 0;
	}
	if (cmd === 'group-of') {
		// Prints the group ref, or nothing — an ungrouped caller is normal.
		try {
			const doc = JSON.parse(run('cmux', ['workspace-group', 'list', '--json'], { timeout: 5000, env: { ...process.env, CMUX_QUIET: '1' } }));
			process.stdout.write(groupOf(doc, rest[0]) ?? '');
		} catch {
			// No group list, no group: the workspace lands ungrouped.
		}
		return 0;
	}
	if (cmd === 'push') {
		const out = opt('--out');
		if (!out) {
			process.stderr.write('usage: dashboard-data.mjs push --out <file> [--surface <uuid>]\n');
			return 64;
		}
		const data = collect();
		writeAtomic(out, renderPage(data));
		const surface = opt('--surface');
		const live = surface ? pushToTab(surface, data) : false;
		const failed = data.errors.length ? `, ${data.errors.length} source(s) failed` : '';
		process.stdout.write(`dashboard: ${data.prs.length} PRs, ${data.issues.length} issues, ${data.tasks.length} worktrees${failed}; ${live ? 'tab updated' : 'page written'}\n`);
		return 0;
	}
	process.stderr.write('usage: dashboard-data.mjs <json | group-of <workspace-ref> | push --out <file> [--surface <uuid>]>\n');
	return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = main(process.argv.slice(2));
}
