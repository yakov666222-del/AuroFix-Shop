const fs = require('fs');
let s = fs.readFileSync('launcher.js', 'utf8');
if (s.includes('var edge')) { console.log('already'); process.exit(0); }
const a = '  var root = host.attachShadow';
const b = "'@media print{:host{display:none}}' +";
if (!s.includes(a) || !s.includes(b)) throw new Error('anchor missing');
s = s.replace(a, "  var edge = cur === 'bot'; // בדפי הבוט: לשונית בצד, כדי לא להסתיר את הסרגל התחתון\n  if (edge) host.style.cssText = 'position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:2147483000;';\n" + a);
s = s.replace(b, "(edge ? '.fab{width:30px;height:56px;border-radius:0 14px 14px 0;border-left:0;opacity:.9}.fab svg{width:16px;height:16px}.panel{left:38px;bottom:auto;top:50%;transform:translateY(-50%)}.panel.open{animation:none}' : '') +\n    " + b);
fs.writeFileSync('launcher.js', s);
console.log('patched');
