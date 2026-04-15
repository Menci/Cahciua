<script setup>
import { computed } from 'vue'

const props = defineProps({
  timeNow: { type: String, required: true },
  isProbeEnabled: { type: Boolean, default: false },
  isProbing: { type: Boolean, default: false },
  isMentioned: { type: Boolean, default: false },
  isReplied: { type: Boolean, default: false },
  recentSendMessageHumanLikenessXml: { type: String, default: '' },
  isInterrupted: { type: Boolean, default: false },
  activeBackgroundTasks: { type: Array, default: () => [] },
})

const backgroundTasksXml = computed(() => {
  const tasks = props.activeBackgroundTasks
  if (!tasks || tasks.length === 0) return ''
  const lines = ['<active-background-tasks>']
  for (const t of tasks) {
    lines.push(`<task id="${t.id}" type="${t.typeName}" timeout-ms="${t.timeoutMs}" started-ms="${t.startedMs}">`)
    if (t.intention) lines.push(`<intention>${t.intention}</intention>`)
    lines.push(`<live-summary>\n${t.liveSummary}\n</live-summary>`)
    lines.push('</task>')
  }
  lines.push('</active-background-tasks>')
  return lines.join('\n')
})
</script>

Current time: {{ timeNow }}

Reminder: call `send_message` to speak (multiple calls = multiple messages). No tool call = silence. Text outside tool calls is private inner monologue, never shown to anyone. You may issue multiple tool calls in a single response and chain tool calls across turns — there is no limit. Set `await_response: true` on `send_message` when you need to continue acting afterward. Always maximize parallel tool calls — if calls are independent, fire them all at once. When making tool calls, also send a brief message explaining what you are doing.

<template v-if="isInterrupted">

Your previous tool call sequence was interrupted by new messages. Review the new messages, then continue with your intended tool calls if still appropriate.

</template>
<template v-if="isProbeEnabled && !isProbing">

You have already decided to act after deliberation. Make your tool calls now.

</template>
<template v-else-if="isMentioned">

You were mentioned — you will likely want to respond.

</template>
<template v-else-if="isReplied">

Someone replied to your message — you will likely want to respond.

</template>
<template v-if="recentSendMessageHumanLikenessXml">

{{ recentSendMessageHumanLikenessXml }}

</template>
<template v-if="backgroundTasksXml">

Active background tasks:
{{ backgroundTasksXml }}

</template>
