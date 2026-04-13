import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { signal } from 'alien-signals';

import type { BackgroundTask, BackgroundTaskFactory, TaskContext } from './types';

export interface ShellParams {
  command: string;
  shell: string[];
}

export interface ShellCheckpoint {
  lines: number;
  bytes: number;
  tmpFile: string;
}

const countNewlines = (buf: Buffer): number => {
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0A) count++;
  }
  return count;
};

const TAIL_SIZE = 500;
const HEAD_SIZE = 500;
const SUMMARY_MAX_OUTPUT = 2000;

const keepTail = (text: string, maxLen: number): string =>
  text.length <= maxLen ? text : text.slice(-maxLen);

const buildOutputSummary = (head: string, tail: string, totalBytes: number): string => {
  const trimmedHead = head.trimEnd();
  const trimmedTail = tail.trimStart();

  // Short enough to show everything
  if (totalBytes <= SUMMARY_MAX_OUTPUT)
    return trimmedHead;

  // Head + tail with truncation notice
  const gap = totalBytes - head.length - tail.length;
  if (gap > 0)
    return `${trimmedHead}\n\n[... ${gap} bytes truncated ...]\n\n${trimmedTail}`;

  // Overlap — just show tail (it contains everything)
  return trimmedTail;
};

export const shellTaskFactory: BackgroundTaskFactory<ShellParams, ShellCheckpoint> = {
  typeName: 'shell_execute',

  start(ctx: TaskContext, params: ShellParams): BackgroundTask {
    const _completed = signal(false);
    const _finalSummary = signal<string | undefined>(undefined);

    let lines = 0;
    let bytes = 0;
    let lastOutputMs = Date.now();
    let head = '';
    let tail = '';
    let killReason: 'timeout' | 'tool_call' | null = null;

    const tmpFile = join(tmpdir(), `cahciua-shell-${ctx.id}-${Date.now()}.txt`);
    const outStream = createWriteStream(tmpFile);

    const child = spawn(params.shell[0]!, [...params.shell.slice(1), params.command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const handleData = (chunk: Buffer) => {
      outStream.write(chunk);
      bytes += chunk.length;
      lines += countNewlines(chunk);
      lastOutputMs = Date.now();
      const text = chunk.toString('utf-8', 0, Math.min(chunk.length, TAIL_SIZE * 2));
      if (head.length < HEAD_SIZE)
        head += text.slice(0, HEAD_SIZE - head.length);
      tail = keepTail(tail + text, TAIL_SIZE);
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('close', (exitCode) => {
      const reason = killReason === 'timeout'
        ? 'Timed out'
        : killReason === 'tool_call'
          ? 'Killed by user'
          : `Exited with code ${exitCode}`;
      const meta = `${reason}. ${lines} lines, ${bytes} bytes output.`;
      const output = buildOutputSummary(head, tail, bytes);
      const summary = output ? `${meta}\n\n${output}` : meta;
      outStream.end(() => {
        _finalSummary(summary);
        _completed(true);
      });
    });

    child.on('error', (err) => {
      const meta = `Process error: ${err.message}. ${lines} lines, ${bytes} bytes output.`;
      const output = buildOutputSummary(head, tail, bytes);
      const summary = output ? `${meta}\n\n${output}` : meta;
      outStream.end(() => {
        _finalSummary(summary);
        _completed(true);
      });
    });

    return {
      completed: _completed,
      finalSummary: _finalSummary,

      renderLiveSummary() {
        const agoSec = Math.round((Date.now() - lastOutputMs) / 1000);
        const parts = [
          `Command: \`${params.command}\``,
          `Output: ${lines} lines, ${bytes} bytes`,
          `Last output: ${agoSec}s ago`,
        ];
        if (tail) parts.push(`Tail:\n${tail}`);
        return parts.join('\n');
      },

      streamFullOutput() {
        return createReadStream(tmpFile, 'utf-8');
      },

      pause() {
        try { child.kill('SIGKILL'); } catch {}
        outStream.end();
        return { lines, bytes, tmpFile } satisfies ShellCheckpoint;
      },

      kill(reason) {
        killReason = reason;
        child.kill('SIGTERM');
      },

      dispose() {
        // tmpFile is kept for read_task_output — cleaned up by retention policy
      },
    };
  },

  recover(_ctx: TaskContext, _params: ShellParams, _checkpoint: ShellCheckpoint | null): BackgroundTask {
    const summary = 'Task interrupted: runtime restarted.';
    return {
      completed: () => true,
      finalSummary: () => summary,
      renderLiveSummary: () => '',
      streamFullOutput: () => null,
      pause: () => null,
      kill() {},
      dispose() {},
    };
  },
};
