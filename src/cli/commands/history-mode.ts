// ============================================================================
// History-mode CLI commands
// ============================================================================

import type { CliContext } from '../helpers.js';
import { initEngine } from '../helpers.js';
import { flushHistoryBoundary } from '../../mcp/tools/history-mode.js';

export async function cmdFlush(ctx: CliContext): Promise<void> {
  const engine = await initEngine(ctx);
  const result = await flushHistoryBoundary(engine);

  if (!result.ok) {
    console.error('Flush failed:');
    console.error(`  ${result.error.code}: ${result.error.message}`);
    await engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value, null, 2));
  await engine.close();
}
