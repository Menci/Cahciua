export type HistoryMediaSource = 'events' | 'image_alt_texts';
export type HistoryNotification =
  | { readonly kind: 'media'; readonly sourceKind: HistoryMediaSource; readonly sourceKey: string }
  | { readonly kind: 'recover' };
export interface HistoryDelivery {
  readonly kind: 'history-input';
  readonly id: number;
  readonly input: HistoryNotification;
}

export const parseHistoryDelivery = (value: unknown): HistoryDelivery | undefined => {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'history-input'
    || !('id' in value) || !Number.isSafeInteger(value.id) || (value.id as number) < 1
    || !('input' in value) || !value.input || typeof value.input !== 'object' || !('kind' in value.input)) return;
  const input = value.input;
  if (input.kind === 'recover') return { kind: 'history-input', id: value.id as number, input: { kind: 'recover' } };
  if (input.kind !== 'media' || !('sourceKind' in input) || (input.sourceKind !== 'events' && input.sourceKind !== 'image_alt_texts')
    || !('sourceKey' in input) || typeof input.sourceKey !== 'string' || !input.sourceKey || Buffer.byteLength(input.sourceKey) > 1024) return;
  if (input.sourceKind === 'events' && (!/^\d+$/.test(input.sourceKey) || !Number.isSafeInteger(Number(input.sourceKey)) || Number(input.sourceKey) < 1)) return;
  return { kind: 'history-input', id: value.id as number, input: { kind: 'media', sourceKind: input.sourceKind, sourceKey: input.sourceKey } };
};
