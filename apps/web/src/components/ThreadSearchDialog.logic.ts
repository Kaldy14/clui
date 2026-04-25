import type { ProjectId } from "@clui/contracts";
import type { Project, Thread } from "../types";

export interface SearchResult {
  thread: Thread;
  matchField: "title" | "branch" | "project" | "message" | null;
  matchSnippet: string | null;
}

export interface GroupedResults {
  project: Project;
  results: SearchResult[];
}

function parseTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function threadActivityTime(thread: Thread): number {
  return Math.max(parseTime(thread.updatedAt), parseTime(thread.createdAt));
}

function compareThreadsByActivityDesc(a: Thread, b: Thread): number {
  const byActivity = threadActivityTime(b) - threadActivityTime(a);
  if (byActivity !== 0) return byActivity;
  return String(b.id).localeCompare(String(a.id));
}

function buildSnippet(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const matchIdx = lowerText.indexOf(query);
  const start = Math.max(0, matchIdx - 30);
  const end = Math.min(text.length, matchIdx + query.length + 60);
  return (
    (start > 0 ? "..." : "") +
    text.slice(start, end).trim() +
    (end < text.length ? "..." : "")
  );
}

export function searchThreads(
  threads: readonly Thread[],
  projects: readonly Project[],
  query: string,
): SearchResult[] {
  const sortedThreads = [...threads].toSorted(compareThreadsByActivityDesc);
  const q = query.trim().toLowerCase();

  if (!q) {
    return sortedThreads.map((thread) => ({
      thread,
      matchField: null,
      matchSnippet: null,
    }));
  }

  const projectNameById = new Map<ProjectId, string>(projects.map((p) => [p.id, p.name]));
  const results: SearchResult[] = [];

  for (const thread of sortedThreads) {
    if (thread.title.toLowerCase().includes(q)) {
      results.push({ thread, matchField: "title", matchSnippet: null });
      continue;
    }

    if (thread.branch?.toLowerCase().includes(q)) {
      results.push({ thread, matchField: "branch", matchSnippet: null });
      continue;
    }

    const projectName = projectNameById.get(thread.projectId);
    if (projectName?.toLowerCase().includes(q)) {
      results.push({ thread, matchField: "project", matchSnippet: null });
      continue;
    }

    const firstMatchingUserMessage = thread.messages.find(
      (message) => message.role === "user" && message.text.toLowerCase().includes(q),
    );
    if (firstMatchingUserMessage) {
      results.push({
        thread,
        matchField: "message",
        matchSnippet: buildSnippet(firstMatchingUserMessage.text, q),
      });
      continue;
    }
  }

  return results;
}

export function groupByProject(
  results: readonly SearchResult[],
  projects: readonly Project[],
): GroupedResults[] {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const groups = new Map<ProjectId, GroupedResults>();

  for (const result of results) {
    const project = projectById.get(result.thread.projectId);
    if (!project) continue;
    const existing = groups.get(project.id);
    if (existing) {
      existing.results.push(result);
    } else {
      groups.set(project.id, { project, results: [result] });
    }
  }

  return [...groups.values()];
}
