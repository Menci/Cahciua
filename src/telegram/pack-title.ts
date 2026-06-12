export interface StickerSetMetadata {
  stickerSetId?: string;
  stickerSetName?: string;
}

export const resolveStickerSetMetadata = async (
  metadata: StickerSetMetadata | undefined,
  resolvePackTitle: (setName: string) => Promise<string>,
): Promise<StickerSetMetadata> => {
  const stickerSetId = metadata?.stickerSetId ?? metadata?.stickerSetName;
  if (!stickerSetId) return {};

  // Already resolved: stickerSetName populated and distinct from the raw id —
  // skip the network round-trip. Avoids spamming TDLib's getStickerSet on cold
  // start when DB-stored events already carry resolved titles.
  if (metadata?.stickerSetName && metadata.stickerSetName !== stickerSetId) {
    return { stickerSetId, stickerSetName: metadata.stickerSetName };
  }

  return {
    stickerSetId,
    stickerSetName: await resolvePackTitle(stickerSetId),
  };
};

export const normalizeStickerSetMetadata = async <T extends StickerSetMetadata>(
  items: T[] | undefined,
  resolvePackTitle: (setName: string) => Promise<string>,
): Promise<boolean> => {
  if (!items || items.length === 0) return false;

  let changed = false;
  await Promise.all(items.map(async item => {
    const resolved = await resolveStickerSetMetadata(item, resolvePackTitle);
    if (!resolved.stickerSetId) return;

    if (item.stickerSetId !== resolved.stickerSetId || item.stickerSetName !== resolved.stickerSetName) {
      item.stickerSetId = resolved.stickerSetId;
      item.stickerSetName = resolved.stickerSetName;
      changed = true;
    }
  }));
  return changed;
};
