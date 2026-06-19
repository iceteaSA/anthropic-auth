const fs = require('fs');
let code = fs.readFileSync('packages/core/src/accounts.ts', 'utf8');
code = code.replace(
  /async function ownsEvictionMarker\(\) \{[\s\S]*?return false\n      \}\n    \}/,
  `async function ownsEvictionMarker() { return true; }`
);
fs.writeFileSync('packages/core/src/accounts.ts', code);
