/*
 * Project Agent
 * Action handlers for Jira and GitHub.
 */

import api, { route, fetch } from '@forge/api';
import { storage } from '@forge/api';

// Jira Actions

export async function getIssue(payload) {
  const issueKey = payload.issue;

  const response = await api.asApp().requestJira(
    route`/rest/api/3/issue/${issueKey}?fields=summary,status,assignee,priority`
  );

  if (!response.ok) {
    throw new Error(`Issue not found: ${issueKey}`);
  }

  const issue = await response.json();
  const prs = await fetchLinkedPRs(issue.id);

  return {
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status?.name,
    assignee: issue.fields.assignee?.displayName || null,
    prs,
  };
}

async function fetchLinkedPRs(issueId) {
  // Fetch PR links from Jira's development panel
  try {
    const response = await api.asApp().requestJira(
      route`/rest/dev-status/1.0/issue/detail?issueId=${issueId}&applicationType=GitHub&dataType=pullrequest`
    );

    if (!response.ok) return [];

    const data = await response.json();
    const prs = [];

    for (const detail of data.detail || []) {
      for (const pr of detail.pullRequests || []) {
        const match = pr.url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (match) {
          prs.push({
            repo: match[1],
            number: parseInt(match[2], 10),
            state: pr.status?.toLowerCase() || 'unknown',
          });
        }
      }
    }

    return prs;
  } catch (error) {
    console.error('Failed to fetch linked PRs:', error.message);
    return [];
  }
}

export async function getSprint(payload) {
  const projectKey = payload.project;

  // Find board
  const boardResponse = await api.asApp().requestJira(
    route`/rest/agile/1.0/board?projectKeyOrId=${projectKey}`
  );

  if (!boardResponse.ok) {
    throw new Error(`No board found for project: ${projectKey}`);
  }

  const boards = await boardResponse.json();
  const board = boards.values?.[0];

  if (!board) {
    throw new Error(`No board found for project: ${projectKey}`);
  }

  // Find active sprint
  const sprintResponse = await api.asApp().requestJira(
    route`/rest/agile/1.0/board/${board.id}/sprint?state=active`
  );

  if (!sprintResponse.ok) {
    return { name: null, message: 'No active sprint', issues: [] };
  }

  const sprints = await sprintResponse.json();
  const sprint = sprints.values?.[0];

  if (!sprint) {
    return { name: null, message: 'No active sprint', issues: [] };
  }

  // Get sprint issues
  const issuesResponse = await api.asApp().requestJira(
    route`/rest/agile/1.0/sprint/${sprint.id}/issue?fields=summary,status,assignee`
  );

  const issuesData = await issuesResponse.json();

  const endDate = sprint.endDate ? new Date(sprint.endDate) : null;
  const now = new Date();
  const daysRemaining = endDate
    ? Math.max(0, Math.ceil((endDate - now) / (1000 * 60 * 60 * 24)))
    : null;

  return {
    name: sprint.name,
    goal: sprint.goal || null,
    daysRemaining,
    issues: (issuesData.issues || []).map(issue => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name,
      assignee: issue.fields.assignee?.displayName || null,
    })),
  };
}

// GitHub Actions

async function getGitHubToken() {
  const token = await storage.get('GITHUB_TOKEN');
  if (!token) {
    throw new Error('GITHUB_TOKEN not configured. Run: forge storage set GITHUB_TOKEN <token>');
  }
  return token;
}

async function github(path) {
  const token = await getGitHubToken();

  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Forge-Project-Agent',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${text}`);
  }

  return response.json();
}

export async function getPRStatus(payload) {
  const { repo, number } = payload;

  // Fetch PR and reviews in parallel
  const [pr, reviews] = await Promise.all([
    github(`/repos/${repo}/pulls/${number}`),
    github(`/repos/${repo}/pulls/${number}/reviews`),
  ]);

  const checks = await fetchChecks(repo, pr.head.sha);

  // Latest review per user
  const reviewsByUser = {};
  for (const review of reviews) {
    const user = review.user.login;
    const existing = reviewsByUser[user];
    const reviewDate = new Date(review.submitted_at);

    if (!existing || reviewDate > new Date(existing.date)) {
      reviewsByUser[user] = { state: review.state, date: review.submitted_at };
    }
  }

  const approved = [];
  const changesRequested = [];
  for (const [user, review] of Object.entries(reviewsByUser)) {
    if (review.state === 'APPROVED') approved.push(user);
    if (review.state === 'CHANGES_REQUESTED') changesRequested.push(user);
  }

  const mergeConflicts = pr.mergeable === false || pr.mergeable_state === 'dirty';

  return {
    number: pr.number,
    title: pr.title,
    author: pr.user.login,
    state: pr.state,
    draft: pr.draft,
    mergeable: pr.mergeable,
    mergeConflicts,
    additions: pr.additions,
    deletions: pr.deletions,
    files: pr.changed_files,
    reviews: { approved, changesRequested },
    checks,
  };
}

async function fetchChecks(repo, sha) {
  const data = await github(`/repos/${repo}/commits/${sha}/check-runs`);
  const runs = data.check_runs || [];

  const passed = runs.filter(c => c.conclusion === 'success').length;
  const failed = runs.filter(c => c.conclusion && c.conclusion !== 'success').length;
  const pending = runs.filter(c => c.status !== 'completed').length;
  const failedNames = runs
    .filter(c => c.conclusion && c.conclusion !== 'success')
    .map(c => c.name);

  return { total: runs.length, passed, failed, pending, failedNames };
}

export async function searchPRs(payload) {
  const query = `is:pr ${payload.query}`;

  const data = await github(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=10`
  );

  return (data.items || []).map(pr => ({
    number: pr.number,
    title: pr.title,
    author: pr.user.login,
    repo: pr.repository_url.replace('https://api.github.com/repos/', ''),
    state: pr.state,
  }));
}