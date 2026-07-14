import type { ContentNode } from './types';

export const contentToPlainText = (nodes: ContentNode[]): string =>
  nodes.map(node => 'children' in node ? contentToPlainText(node.children) : node.text).join('');

export const visitCustomEmoji = (
  nodes: ContentNode[],
  visit: (node: Extract<ContentNode, { type: 'custom_emoji' }>) => void,
): void => {
  for (const node of nodes) {
    if (node.type === 'custom_emoji') visit(node);
    if ('children' in node) visitCustomEmoji(node.children, visit);
  }
};
