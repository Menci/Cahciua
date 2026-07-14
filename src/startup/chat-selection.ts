export const selectStartupReplayChatIds = (
  knownChatIds: readonly string[],
  configuredChatIds: Iterable<string>,
): string[] => {
  const configured = new Set(configuredChatIds);
  return knownChatIds.filter(chatId => configured.has(chatId));
};
