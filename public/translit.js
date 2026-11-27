// Turns Devanagari (what Chrome returns for Hindi speech) into Hinglish in English letters,
// e.g. "२८ दिसंबर को पचास मेहमान" -> "28 disambar ko pachas mehman".
// Rule-based and offline. Not perfect spelling, but easy to read and easy for the AI to understand.

const CONS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
};
const NUKTA = { 'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f' };
const VOWEL = { 'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e' };
const MATRA = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e' };
const NASAL = new Set(['ं', 'ँ']);
const HALANT = '्';
const NUKTA_MARK = '़';

function readConsonant(chars, i) {
  let on = CONS[chars[i]];
  const base = chars[i];
  i++;
  if (chars[i] === NUKTA_MARK) { on = NUKTA[base] || on; i++; }
  return { on, i };
}

function convertWord(word) {
  const chars = [...word.normalize('NFC')];
  const syl = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (CONS[c]) {
      let r = readConsonant(chars, i);
      let on = r.on; i = r.i;
      while (chars[i] === HALANT && CONS[chars[i + 1]]) { // conjunct: क्ष, त्र, स्त ...
        r = readConsonant(chars, i + 1);
        on += r.on; i = r.i;
      }
      if (on === 'jn') on = 'gy';
      if (chars[i] === HALANT) { i++; syl.push({ on, v: '', inh: false }); continue; }
      let v = 'a'; let inh = true;
      if (MATRA[chars[i]] !== undefined) { v = MATRA[chars[i]]; inh = false; i++; }
      const s = { on, v, inh };
      if (NASAL.has(chars[i])) { s.nas = true; i++; } else if (chars[i] === 'ः') { s.visarga = true; i++; }
      syl.push(s);
    } else if (VOWEL[c] !== undefined) {
      i++;
      const s = { on: '', v: VOWEL[c], inh: false };
      if (NASAL.has(chars[i])) { s.nas = true; i++; } else if (chars[i] === 'ः') { s.visarga = true; i++; }
      syl.push(s);
    } else if (c >= '०' && c <= '९') { syl.push({ lit: String(c.charCodeAt(0) - 0x0966) }); i++; }
    else if (c === '।') { syl.push({ lit: '.' }); i++; }
    else if (c === NUKTA_MARK || c === HALANT) { i++; }
    else { syl.push({ lit: c }); i++; }
  }
  // Hindi drops many inherent "a" sounds: "kitaab" is read "kitab", "mehamaan" is read "mehman".
  for (let k = syl.length - 1; k >= 0; k--) {
    const s = syl[k];
    if (s.lit !== undefined || !s.inh || s.nas || s.visarga) continue;
    if (k === syl.length - 1) { if (k > 0 && syl[k - 1].lit === undefined) s.v = ''; continue; }
    const p = syl[k - 1]; const n = syl[k + 1];
    if (k > 0 && p.lit === undefined && p.v !== '' && n.lit === undefined && n.v !== '') s.v = '';
  }
  let out = '';
  syl.forEach((s, k) => {
    if (s.lit !== undefined) { out += s.lit; return; }
    out += s.on + s.v;
    if (s.nas) { const nx = syl[k + 1]; out += nx && nx.on && /^(p|b|m|ph|bh)/.test(nx.on) ? 'm' : 'n'; }
    if (s.visarga) out += 'h';
  });
  return out;
}

export function devanagariToRoman(text) {
  if (!/[ऀ-ॿ]/.test(text)) return text;
  return text.replace(/[ऀ-ॿ]+/g, convertWord);
}
