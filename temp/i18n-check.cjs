const fs = require('fs')
const json = JSON.parse(fs.readFileSync('src/ui/i18n/lang/en-US.json', 'utf8'))
const tsx = fs.readFileSync(
  'src/ui/pages/chat/components/tool-call/XtermTerminal.tsx',
  'utf8',
)
const keys = [...tsx.matchAll(/\bt(?:pl)?\(\s*'([^']+)'/g)].map((x) => x[1])
const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(json, k))
console.log('terminal keys used:', keys.length)
console.log('missing in en-US.json:', JSON.stringify(missing, null, 1))
const m = keys.find((k) => k.includes('秒无输出'))
console.log('idle key:', JSON.stringify(m), '->', JSON.stringify(json[m]))
