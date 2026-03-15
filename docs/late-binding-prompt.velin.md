<script setup>
defineProps({
  isProbeEnabled: { type: Boolean, default: false },
  isProbing: { type: Boolean, default: false },
  isMentioned: { type: Boolean, default: false },
  isReplied: { type: Boolean, default: false },
})
</script>

Reminder: call `send_message` to speak (multiple calls = multiple messages). No tool call = silence. Text outside tool calls is private inner monologue, never shown to anyone.

<div v-if="isProbeEnabled && !isProbing">

You have already decided to act after deliberation. Make your tool calls now.

</div>
<div v-else-if="isMentioned">

You were mentioned — you will likely want to respond.

</div>
<div v-else-if="isReplied">

Someone replied to your message — you will likely want to respond.

</div>
