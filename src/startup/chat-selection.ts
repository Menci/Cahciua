export const isConfiguredChat = (configuredChatIds: ReadonlySet<string>, chatId: string): boolean =>
  configuredChatIds.has(chatId);

export const selectStartupReplayChatIds = (
  knownChatIds: readonly string[],
  configuredChatIds: Iterable<string>,
): string[] => {
  const configured = new Set(configuredChatIds);
  return knownChatIds.filter(chatId => configured.has(chatId));
};
