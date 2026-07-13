// ============================================================================
// Provider pointer files — CLAUDE.md and AGENTS.md.
//
// Created ONCE at project init and never managed afterward: users own these
// files. They stay thin so they cannot meaningfully drift — all instruction
// content lives in MAAD.md (managed) and _skills/ (managed).
// ============================================================================

function pointerBody(): string {
  return `This is a **MAADb project** — a markdown-native database.

- **Read \`MAAD.md\`** for the operating instructions (boot, tools, safety).
- Use MAADb MCP tools for all data operations — no shell or direct file
  access for record data.
- Task workflows live in \`_skills/\` (architect, schema, import).

You may add project-specific notes below this line — this file is yours
after creation and is never overwritten by the engine.
`;
}

export function generateClaudeMd(): string {
  return `# MAADb Project — Agent Instructions\n\n${pointerBody()}`;
}

export function generateAgentsMd(): string {
  return `# MAADb Project — Agent Instructions\n\n${pointerBody()}`;
}
