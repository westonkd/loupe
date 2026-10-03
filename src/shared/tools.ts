import { parseMcpToolName } from './mcp.js';

export type ToolCategory =
  | 'shell'
  | 'file_read'
  | 'file_write'
  | 'search'
  | 'web'
  | 'agent'
  | 'skill'
  | 'plan'
  | 'ask'
  | 'mcp'
  | 'other';

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  shell: 'Shell',
  file_read: 'File read',
  file_write: 'File write',
  search: 'Search',
  web: 'Web',
  agent: 'Subagents',
  skill: 'Skills',
  plan: 'Planning',
  ask: 'User interaction',
  mcp: 'MCP',
  other: 'Other',
};

const BY_NAME: Record<string, ToolCategory> = {
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  Monitor: 'shell',
  Read: 'file_read',
  NotebookRead: 'file_read',
  Write: 'file_write',
  Edit: 'file_write',
  MultiEdit: 'file_write',
  NotebookEdit: 'file_write',
  Grep: 'search',
  Glob: 'search',
  ToolSearch: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'agent',
  Task: 'agent',
  SendMessage: 'agent',
  ListAgents: 'agent',
  TaskStop: 'agent',
  TaskOutput: 'agent',
  SubagentHandback: 'agent',
  Workflow: 'agent',
  Skill: 'skill',
  TodoWrite: 'plan',
  ExitPlanMode: 'plan',
  EnterPlanMode: 'plan',
  ScheduleWakeup: 'plan',
  AskUserQuestion: 'ask',
  EndConversation: 'ask',
};

export function toolCategory(name: string): ToolCategory {
  if (parseMcpToolName(name)) return 'mcp';
  return BY_NAME[name] ?? 'other';
}
