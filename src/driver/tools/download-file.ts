import { execFile } from 'node:child_process';

import { createTool } from './create-tool';
import type { CahciuaTool, ToolResult } from './types';
import type { RuntimeConfig } from '../../config/config';

const DOWNLOAD_TIMEOUT_MS = 60_000;

export const createDownloadFileTool = (deps: {
  downloadAttachment: (fileId: string) => Promise<Buffer>;
  runtime: RuntimeConfig;
}): CahciuaTool => createTool({
  name: 'download_file',
  description: 'Download a file attachment from the chat.',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'The \`file-id\` attribute of an attachment element. (Typical format: \`number:number\`)' },
      path: { type: 'string', description: 'Destination file path in the workspace.' },
    },
    required: ['file_id', 'path'],
  },
  execute: async input => {
    const { file_id, path } = input as { file_id: string; path: string };

    const buffer = await deps.downloadAttachment(file_id);

    if (buffer.length > deps.runtime.writeFileSizeLimit) {
      return {
        content: JSON.stringify({ error: `File too large: ${buffer.length} bytes exceeds limit of ${deps.runtime.writeFileSizeLimit} bytes.` }),
        requiresFollowUp: true,
      };
    }

    const writeCmd = deps.runtime.writeFile;
    return await new Promise<ToolResult>((resolve, reject) => {
      const child = execFile(
        writeCmd[0]!,
        [...writeCmd.slice(1), path],
        { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`Failed to write file: ${stderr === '' ? error.message : stderr}`));
          } else {
            resolve({
              content: JSON.stringify({ ok: true, path, size: buffer.length }),
              requiresFollowUp: true,
            });
          }
        },
      );
      if (!child.stdin) throw new Error('Runtime write command has no stdin stream');
      child.stdin.end(buffer);
    });
  },
});
