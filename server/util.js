export function todayStr(tz = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Nights of a stay: check_in inclusive, check_out exclusive.
export function nightsBetween(checkIn, checkOut) {
  const out = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) out.push(d);
  return out;
}

export function inr(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function prettyDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1)} ${y}`;
}

const HI_MONTHS = { 'जनवरी': 1, 'फरवरी': 2, 'फ़रवरी': 2, 'मार्च': 3, 'अप्रैल': 4, 'मई': 5, 'जून': 6, 'जुलाई': 7, 'अगस्त': 8, 'सितंबर': 9, 'सितम्बर': 9, 'अक्टूबर': 10, 'नवंबर': 11, 'नवम्बर': 11, 'दिसंबर': 12, 'दिसम्बर': 12 };

export function devanagariDigitsToAscii(text) {
  return String(text).replace(/[\u0966-\u096F]/g, (c) => String(c.charCodeAt(0) - 0x0966));
}

// Finds up to two "28 dec" / "28 december 2026" / "२८ दिसंबर" / ISO dates in free text (used by the no-AI fallback).
export function parseLooseDates(rawText, today) {
  const text = devanagariDigitsToAscii(rawText);
  const hi = Object.keys(HI_MONTHS).join('|');
  const found = [];
  const re = new RegExp(`(\\d{4}-\\d{2}-\\d{2})|(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*(jan[a-z]*|feb[a-z]*|mar[a-z]*|apr[a-z]*|may|jun[a-z]*|jul[a-z]*|aug[a-z]*|sep[a-z]*|oct[a-z]*|nov[a-z]*|dec[a-z]*|${hi})\\.?(?:\\s*,?\\s*(\\d{4}))?`, 'gi');
  let m;
  while ((m = re.exec(text)) && found.length < 2) {
    if (m[1]) { if (isDate(m[1])) found.push(m[1]); continue; }
    const word = m[3].toLowerCase();
    const mon = HI_MONTHS[m[3]] || MONTHS.indexOf(word.slice(0, 3)) + 1;
    if (!mon) continue;
    const year = m[4] ? Number(m[4]) : Number(today.slice(0, 4));
    let s = `${year}-${String(mon).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    if (!m[4] && s < today) s = `${year + 1}-${s.slice(5)}`;
    if (isDate(s)) found.push(s);
  }
  return found;
}
