import type { TurnResponseV2 } from './types';
import type { ConversationEntry } from '../unified-api/types';

export const RECENT_SEND_MESSAGE_WINDOW = 5;
const SHORT_MESSAGE_CHAR_LIMIT = 32;
const DENSE_CLAUSE_PUNCTUATION_THRESHOLD = 2;

export const potentiallyNotHumanFeatureDefinitions = [
  {
    name: 'trailing-period',
    description: 'Ended with a full stop.',
  },
  {
    name: 'dense-clause-punctuation',
    description: 'Packed a short message with multiple clause punctuation marks instead of using a space or a bare clause.',
  },
  {
    name: 'multiple-markdown-bold',
    description: 'Used more than one Markdown bold span.',
  },
  {
    name: 'markdown-list',
    description: 'Used a Markdown list.',
  },
  {
    name: 'markdown-header',
    description: 'Used a Markdown header.',
  },
  {
    name: 'newline',
    description: 'Used a newline.',
  },
] as const;

export type PotentiallyNotHumanFeature = typeof potentiallyNotHumanFeatureDefinitions[number]['name'];

export interface SendMessageHumanLikenessAssessment {
  text: string;
  features: PotentiallyNotHumanFeature[];
}

const MARKDOWN_BOLD_RE = /(?<!\\)(\*\*|__)(?=\S)([\s\S]*?\S)\1/g;
const MARKDOWN_LIST_RE = /(?:^|\r?\n)[ \t]{0,3}(?:[-+*][ \t]+\S|\d+[.)][ \t]+\S)/;
const MARKDOWN_HEADER_RE = /(?:^|\r?\n)#{1,6}[ \t]+\S/;
const NEWLINE_RE = /\r?\n/;
const CLAUSE_PUNCTUATION_RE = /[，,、；;：:]/gu;

const parseJsonRecord = (text: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const extractSendMessageText = (args: string): string | null => {
  const parsed = parseJsonRecord(args);
  return typeof parsed?.text === 'string' ? parsed.text : null;
};

const isSuccessfulSendMessageResult = (output: string): boolean =>
  parseJsonRecord(output)?.ok === true;

const countMatches = (text: string, re: RegExp): number => [...text.matchAll(re)].length;

const hasTrailingPeriod = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.endsWith('。'))
    return true;
  return trimmed.endsWith('.') && !/\.{2,}$/.test(trimmed);
};

const hasDenseClausePunctuation = (text: string): boolean => {
  const trimmed = text.trim();
  return [...trimmed].length <= SHORT_MESSAGE_CHAR_LIMIT
    && countMatches(trimmed, CLAUSE_PUNCTUATION_RE) >= DENSE_CLAUSE_PUNCTUATION_THRESHOLD;
};

export const assessSendMessageHumanLikeness = (text: string): PotentiallyNotHumanFeature[] => {
  const features: PotentiallyNotHumanFeature[] = [];
  if (hasTrailingPeriod(text))
    features.push('trailing-period');
  if (hasDenseClausePunctuation(text))
    features.push('dense-clause-punctuation');
  if ([...text.matchAll(MARKDOWN_BOLD_RE)].length > 1)
    features.push('multiple-markdown-bold');
  if (MARKDOWN_LIST_RE.test(text))
    features.push('markdown-list');
  if (MARKDOWN_HEADER_RE.test(text))
    features.push('markdown-header');
  if (NEWLINE_RE.test(text))
    features.push('newline');
  return features;
};

const extractSendMessageAssessments = (entries: ConversationEntry[]): SendMessageHumanLikenessAssessment[] => {
  const successfulCallIds = new Set(
    entries
      .filter((e): e is Extract<ConversationEntry, { kind: 'toolResult' }> => e.kind === 'toolResult')
      .filter(e => typeof e.payload === 'string' && isSuccessfulSendMessageResult(e.payload))
      .map(e => e.callId),
  );

  const assessments: SendMessageHumanLikenessAssessment[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
    for (const part of entry.parts) {
      if (part.kind !== 'toolCall') continue;
      if (part.name !== 'send_message') continue;
      if (!successfulCallIds.has(part.callId)) continue;
      const text = extractSendMessageText(part.args);
      if (text == null) continue;
      assessments.push({ text, features: assessSendMessageHumanLikeness(text) });
    }
  }
  return assessments;
};

export const collectRecentSendMessageAssessments = (
  trs: TurnResponseV2[],
  limit = RECENT_SEND_MESSAGE_WINDOW,
): SendMessageHumanLikenessAssessment[] =>
  trs.flatMap(tr => extractSendMessageAssessments(tr.entries)).slice(-limit);

export const appendRecentSendMessageAssessments = (
  current: SendMessageHumanLikenessAssessment[],
  tr: TurnResponseV2,
  limit = RECENT_SEND_MESSAGE_WINDOW,
): SendMessageHumanLikenessAssessment[] =>
  [...current, ...extractSendMessageAssessments(tr.entries)].slice(-limit);

export const renderRecentSendMessageHumanLikenessXml = (
  recentMessages: SendMessageHumanLikenessAssessment[],
): string => {
  if (recentMessages.length === 0)
    return '';

  const featureCounts = potentiallyNotHumanFeatureDefinitions
    .map(feature => ({
      ...feature,
      count: recentMessages.filter(message => message.features.includes(feature.name)).length,
    }))
    .filter(feature => feature.count > 0);

  if (featureCounts.length === 0)
    return '';

  const lines = [
    `<human-likeness checked-count="${recentMessages.length}" window-size="${RECENT_SEND_MESSAGE_WINDOW}">`,
  ];

  for (const feature of featureCounts)
    lines.push(`<feature name="${feature.name}" count="${feature.count}">${feature.description} Appeared in ${feature.count} of your recent ${recentMessages.length} send_message messages.</feature>`);

  lines.push('<guidance>If those patterns were intentional, do not follow this rigidly. If you agree with the critique, try to sound a bit more human in your next messages.</guidance>');

  lines.push('</human-likeness>');
  return lines.join('\n');
};
