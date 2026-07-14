import { execFile } from 'node:child_process';

import { createTool } from './create-tool';
import type { CahciuaTool, ToolResult } from './types';
import type { RuntimeConfig } from '../../config/config';

const BASH_MAX_OUTPUT = 4096;
const BASH_TIMEOUT_MS = 30_000;

export const createBashTool = (runtime: RuntimeConfig, backgroundTask: {
  startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number;
  sessionId: string;
  backgroundThresholdSec: number;
}): CahciuaTool => createTool({
  name: 'bash',
  description:
    'Execute a shell command. Output (stdout+stderr combined) is truncated to 4 KB. '
    + 'For large outputs, redirect to a file and read specific ranges. '
    + `Set timeout_seconds > ${backgroundTask.backgroundThresholdSec} for long-running commands — they run as background tasks and return immediately with a task ID.`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout_seconds: {
        type: 'number',
        description: `Timeout in seconds. Commands with timeout > ${backgroundTask.backgroundThresholdSec}s run as background tasks and return immediately with a task ID. Short commands (e.g. ls, cat) typically need 5-10s; builds or tests may need 60-300s.`,
      },
      intention: { type: 'string', description: 'Brief description of what this command does (shown in background task status).' },
    },
    required: ['command', 'timeout_seconds'],
  },
  execute: async input => {
    const { command, timeout_seconds, intention } = input as { command: string; timeout_seconds: number; intention?: string };
    const timeoutSec = timeout_seconds;

    if (timeoutSec > backgroundTask.backgroundThresholdSec) {
      const taskId = backgroundTask.startTask(
        'shell_execute',
        backgroundTask.sessionId,
        { command, shell: runtime.shell },
        intention,
        timeoutSec * 1000,
      );
      return {
        content: JSON.stringify({ background_task_id: taskId, message: `Background task started (id: ${taskId}). You will be notified when it completes. Use kill_task to cancel or read_task_output to view results.` }),
        requiresFollowUp: true,
      };
    }

    return await new Promise<ToolResult>(resolve => {
      const child = execFile(
        runtime.shell[0]!,
        [...runtime.shell.slice(1), command],
        { timeout: Math.min(timeoutSec * 1000, BASH_TIMEOUT_MS), maxBuffer: BASH_MAX_OUTPUT * 2 },
        (error, stdout, stderr) => {
          let output = stdout + stderr;
          let truncated = false;
          if (output.length > BASH_MAX_OUTPUT) {
            output = output.slice(0, BASH_MAX_OUTPUT);
            if ((output.charCodeAt(output.length - 1) & 0xFC00) === 0xD800)
              output = output.slice(0, -1);
            truncated = true;
          }
          const processError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string } | null;
          let exitCode: number | string = 0;
          if (processError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            exitCode = 'truncated';
          } else if (processError) {
            if (child.exitCode != null) exitCode = child.exitCode;
            else if (processError.signal) exitCode = `signal:${processError.signal}`;
            else exitCode = processError.killed ? 'timeout' : 'failed';
          }
          resolve({
            content: JSON.stringify({ exit_code: exitCode, output, truncated }),
            requiresFollowUp: true,
          });
        },
      );
    });
  },
});
