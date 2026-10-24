// prints the QR matrix of each text as rows of 0/1 (read by tests/qr_check.py)
import { makeQr } from '../docs/js/qr.js';
const texts = process.argv.slice(2);
const out = texts.map((t) => { const q = makeQr(t); const rows = []; for (let y = 0; y < q.size; y++) { let r = ''; for (let x = 0; x < q.size; x++) r += q.get(x, y) ? '1' : '0'; rows.push(r); } return { text: t, version: q.version, mask: q.mask, rows }; });
console.log(JSON.stringify(out));
