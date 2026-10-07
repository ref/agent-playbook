// Tests for the pure rules in `.agents/dashboard-data.mjs` — the parts of the
// dashboard that decide what a PR's stage is, which issue is an umbrella and
// how far along it is, and how cmux's and git's text output is read. The
// collectors around them shell out to git, gh and cmux and are exercised live,
// not here.
//
// Shapes asserted below were read from real output, not guessed:
// `cmux list-status` prints `key=value icon=… color=… priority=…` lines and
// has no --json [verified-by-execution, cmux 0.65.0, 2026-10-06]; a verdict
// comment opens `Reviewed-by: <tool / family>, head <sha>` (the review skill).

import { describe, expect, it } from 'vitest';
import {
	checklist,
	ciState,
	groupOf,
	inlineJson,
	linkedIssues,
	parseStatusLines,
	parseWorktrees,
	prFromSubject,
	prStage,
	verdicts,
} from './dashboard-data.mjs';

describe('checklist', () => {
	it('counts done and total task-list items', () => {
		expect(checklist('- [x] one\n- [ ] two\n* [X] three\n')).toEqual({ done: 2, total: 3 });
	});

	it('accepts indented items and every list marker', () => {
		expect(checklist('  - [x] a\n+ [ ] b')).toEqual({ done: 1, total: 2 });
	});

	it('is null when the body has no task list — such an issue is not an umbrella', () => {
		expect(checklist('Plain issue.\n- a bullet\n- [link](x)')).toBeNull();
		expect(checklist('')).toBeNull();
		expect(checklist(undefined)).toBeNull();
	});

	it('does not count an empty checkbox with no text', () => {
		expect(checklist('- [ ]\n- [x] real')).toEqual({ done: 1, total: 1 });
	});
});

describe('linkedIssues', () => {
	it('reads closing and referencing keywords', () => {
		expect(linkedIssues('Closes #12\nRefs #7\nfixes #3, resolved #9')).toEqual([12, 7, 3, 9]);
	});

	it('ignores bare mentions, which cite PRs as often as issues', () => {
		expect(linkedIssues('Follows #40, see also #41.')).toEqual([]);
	});

	it('lists each issue once', () => {
		expect(linkedIssues('Refs #5\nRefs #5')).toEqual([5]);
	});
});

describe('verdicts', () => {
	const c = (body: string, createdAt = '2026-10-01T00:00:00Z') => ({ body, createdAt });

	it('reads the verdict, the head and the reviewer from a verdict comment', () => {
		expect(verdicts([c('Reviewed-by: Antigravity / Gemini, head 0d469b678ff6\n\nVERDICT: approve — fine')])).toEqual([
			{ verdict: 'approve', head: '0d469b678ff6', by: 'Antigravity / Gemini', at: '2026-10-01T00:00:00Z' },
		]);
	});

	it('reads a bolded blocker', () => {
		expect(verdicts([c('Reviewed-by: X, head abcdef1\n**VERDICT: blocker** — no test')])[0].verdict).toBe('blocker');
	});

	it('skips comments that are not verdicts', () => {
		expect(verdicts([c('LGTM'), c('VERDICT: approve but not a verdict comment')])).toEqual([]);
	});
});

describe('ciState', () => {
	it('is none without checks', () => {
		expect(ciState([])).toBe('none');
		expect(ciState(undefined)).toBe('none');
	});

	it('is fail when any check failed, even with others pending', () => {
		expect(ciState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }, { conclusion: 'FAILURE' }])).toBe('fail');
	});

	it('is pending while any check has no conclusion yet', () => {
		expect(ciState([{ conclusion: 'SUCCESS' }, { status: 'QUEUED', conclusion: '' }])).toBe('pending');
	});

	it('is pass when everything concluded green or neutral', () => {
		expect(ciState([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { state: 'SUCCESS' }])).toBe('pass');
	});
});

describe('prStage', () => {
	const HEAD = 'abcdef1234567890';
	const v = (verdict: string, head = 'abcdef1') => ({ verdict, head, by: 'R', at: null });

	it('draft wins over everything', () => {
		expect(prStage({ draft: true, ci: 'fail', verdictList: [v('blocker')], headSha: HEAD })).toBe('draft');
	});

	it('red CI is ci-failed', () => {
		expect(prStage({ draft: false, ci: 'fail', verdictList: [v('approve')], headSha: HEAD })).toBe('ci-failed');
	});

	it('a blocker on the current head is a blocker even while CI runs', () => {
		expect(prStage({ draft: false, ci: 'pending', verdictList: [v('blocker')], headSha: HEAD })).toBe('blocker');
	});

	it('an approve on the current head with green CI is ready', () => {
		expect(prStage({ draft: false, ci: 'pass', verdictList: [v('approve')], headSha: HEAD })).toBe('ready');
	});

	// The one wrong answer the page must never give: after a fix push, the old
	// approve names the old head and must not read as "ready".
	it('an approve on an OLD head is awaiting review, not ready', () => {
		expect(prStage({ draft: false, ci: 'pass', verdictList: [v('approve', '1111111')], headSha: HEAD })).toBe('awaiting-review');
	});

	it('a blocker on an old head no longer blocks', () => {
		expect(prStage({ draft: false, ci: 'pass', verdictList: [v('blocker', '1111111')], headSha: HEAD })).toBe('awaiting-review');
	});

	it('only the LAST verdict counts', () => {
		expect(prStage({ draft: false, ci: 'pass', verdictList: [v('blocker'), v('approve')], headSha: HEAD })).toBe('ready');
		expect(prStage({ draft: false, ci: 'pass', verdictList: [v('approve'), v('blocker')], headSha: HEAD })).toBe('blocker');
	});

	it('approved but CI still running is ci-running', () => {
		expect(prStage({ draft: false, ci: 'pending', verdictList: [v('approve')], headSha: HEAD })).toBe('ci-running');
	});

	it('no verdict is awaiting review', () => {
		expect(prStage({ draft: false, ci: 'pass', verdictList: [], headSha: HEAD })).toBe('awaiting-review');
	});
});

describe('parseWorktrees', () => {
	it('reads paths, heads, branches and detached trees', () => {
		const text = [
			'worktree /repo',
			'HEAD 1111111111',
			'branch refs/heads/feat/x',
			'',
			'worktree /repo-wt-review',
			'HEAD 2222222222',
			'detached',
			'',
		].join('\n');
		expect(parseWorktrees(text)).toEqual([
			{ path: '/repo', head: '1111111111', branch: 'feat/x', detached: false, bare: false },
			{ path: '/repo-wt-review', head: '2222222222', branch: null, detached: true, bare: false },
		]);
	});
});

describe('parseStatusLines', () => {
	it('keeps spaces inside the value and sorts by priority', () => {
		const text = [
			'claude_code=Running icon=bolt.fill color=#4C8DFF work=running',
			'task=Working 1h 16m icon=hammer.fill color=#38BDF8 priority=80',
		].join('\n');
		expect(parseStatusLines(text)).toEqual([
			{ key: 'task', value: 'Working 1h 16m', icon: 'hammer.fill', color: '#38BDF8', priority: 80 },
			{ key: 'claude_code', value: 'Running', icon: 'bolt.fill', color: '#4C8DFF', priority: 0 },
		]);
	});

	it('skips blank and malformed lines', () => {
		expect(parseStatusLines('\nnot a pill\n')).toEqual([]);
	});
});

describe('groupOf', () => {
	// The shape of `cmux workspace-group list --json`, trimmed
	// [verified-by-execution, cmux 0.65.0, 2026-10-07].
	const doc = {
		groups: [
			{ ref: 'workspace_group:1', member_workspace_refs: ['workspace:1', 'workspace:2'] },
			{ ref: 'workspace_group:2', member_workspace_refs: ['workspace:22'] },
		],
	};

	it('finds the group that lists the workspace as a member', () => {
		expect(groupOf(doc, 'workspace:22')).toBe('workspace_group:2');
	});

	it('matches whole refs, never a prefix', () => {
		expect(groupOf(doc, 'workspace:2')).toBe('workspace_group:1');
	});

	it('is null for an ungrouped workspace, no caller, or an unreadable list', () => {
		expect(groupOf(doc, 'workspace:9')).toBeNull();
		expect(groupOf(doc, '')).toBeNull();
		expect(groupOf({}, 'workspace:1')).toBeNull();
		expect(groupOf(null, 'workspace:1')).toBeNull();
	});
});

describe('prFromSubject', () => {
	it('reads the trailing (#N) of a squash subject', () => {
		expect(prFromSubject('feat(x): thing (#289)')).toBe(289);
	});

	it('ignores a number that is not at the end', () => {
		expect(prFromSubject('fix: revert (#12) partially')).toBeNull();
	});
});

describe('inlineJson', () => {
	it('cannot close the script tag it is inlined into', () => {
		const out = inlineJson({ title: '</script><script>alert(1)</script>' });
		expect(out).not.toContain('</script>');
		expect(JSON.parse(out)).toEqual({ title: '</script><script>alert(1)</script>' });
	});
});
