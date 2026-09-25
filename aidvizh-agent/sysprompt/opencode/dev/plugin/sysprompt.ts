const buffers = new Map()

const PATTERN = /<sysprompt>([\s\S]*?)<\/sysprompt>/
const RESET = /^(clear|--clear)$/i

export default {
  id: "sysprompt",
  setup: async (context) => {
    await context.session.hook("prompt", (input) => {
      const match = PATTERN.exec(input.prompt?.text ?? "")
      if (!match) return

      const text = match[1].trim()

      if (RESET.test(text)) {
        buffers.delete(input.sessionID)
        input.prompt.text = "sysprompt: буфер очищен."
        return
      }

      if (!text) {
        input.prompt.text = "sysprompt: текст пустой. Формат: /prompt <текст>, сброс: /prompt clear."
        return
      }

      const blocks = buffers.get(input.sessionID) ?? []
      blocks.push(text)
      buffers.set(input.sessionID, blocks)
      input.prompt.text = text
    })

    await context.session.hook("context", (input) => {
      const blocks = buffers.get(input.sessionID)
      if (!blocks || blocks.length === 0) return
      input.system.push({
        type: "text",
        text: blocks.map((text) => `<system-reminder>\n${text}\n</system-reminder>`).join("\n"),
      })
    })
  },
}
