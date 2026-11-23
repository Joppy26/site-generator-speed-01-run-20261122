// A fast reimplementation of makefun-site 1.0.0 (the reference program of
// site-generator-speed-01). Same answers, byte for byte, for every input;
// written from the README's rules as a single-pass pipeline with no
// intermediate token trees, no per-character escaping and no regexes in the
// hot paths. Dependency-free, deterministic, no clock, no I/O, no randomness.
//
// run(input) -> { outputPath: fileText, ... }

'use strict';

// ------------------------------------------------------------------ utilities

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. `replace` scans once; with no match it returns `text` itself. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** Whether the code unit is a JavaScript \s whitespace character. */
function isWSCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 160 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. NFKD is the identity on ASCII, so ASCII text takes a fast path.
 */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      c === 32 ||
      (c >= 9 && c <= 13) ||
      c === 160 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff
    )
      inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34)
      return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok =
        raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93)
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (
          t === '' ||
          t.indexOf('"') !== -1 ||
          t.indexOf('[') !== -1 ||
          t.indexOf(']') !== -1
        )
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45))
          return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Scans lines by
 * index instead of splitting the whole source.
 */
function parseFrontMatter(text) {
  const len = text.length;
  const nl0 = text.indexOf('\n');
  const firstEnd = nl0 === -1 ? len : nl0;
  if (
    firstEnd !== 3 ||
    text.charCodeAt(0) !== 45 ||
    text.charCodeAt(1) !== 45 ||
    text.charCodeAt(2) !== 45
  )
    return { error: 'no front matter' };
  // Find the close line: a line exactly '---'.
  let closeStart = -1;
  let q = text.indexOf('\n---', firstEnd);
  while (q !== -1) {
    const after = q + 4;
    if (after === len || text.charCodeAt(after) === 10) {
      closeStart = q;
      break;
    }
    q = text.indexOf('\n---', q + 1);
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = firstEnd + 1; // start of line 1
  let lineNo = 2; // line numbers count from 1 at the opening '---'
  while (pos < closeStart) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1 || eol > closeStart) eol = closeStart;
    const line = text.slice(pos, eol);
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // key: value — key of a-z and _, colon, one space, the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58)
        return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c === 32 || c === 9) rEnd--;
        else break;
      }
      raw = raw.slice(0, rEnd);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = eol + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const after = closeStart + 4;
  const body = after === len ? '' : text.slice(after + 1);
  return { data, body };
}

// ------------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set([
  '\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>',
]);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wl = what.length;
  for (let j = from; j <= end - wl; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** indexOf bounded to [from, end): -1 when the hit lies at or past `end`. */
function indexOfWithin(s, ch, from, end) {
  const j = s.indexOf(ch, from);
  return j === -1 || j >= end ? -1 : j;
}

/** Whether `s` holds any whitespace. */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isWSCode(s.charCodeAt(i))) return true;
  return false;
}

/** Whether `target` has a scheme (letters, then alphanumerics/+/-/. , then ':'). */
function hasScheme(target) {
  if (target.length === 0) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (
      !(
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 43 ||
        c === 45 ||
        c === 46
      )
    )
      return false;
  }
  return false;
}

/**
 * `s[a..b)` rendered inline into `parts`; `env.link(target)` is a link's href.
 *
 * One native scan finds the next character that needs attention: a construct
 * opener (\, `, *, [) or a character HTML escapes (& < > " '). Plain runs
 * between those characters hold none of either, so they are pushed raw with a
 * single slice and never re-scanned for escaping. A construct that fails to
 * open stays in the pending plain run, exactly as the per-character walk
 * would leave it.
 */
const INLINE_NEXT = /[\\`*&<>"'\[]/g;

function inlineRange(s, a, b, env, parts) {
  let i = a;
  let plain = a;
  while (i < b) {
    INLINE_NEXT.lastIndex = i;
    const m = INLINE_NEXT.exec(s);
    if (m === null || m.index >= b) break;
    const j = m.index;
    const c = s[j];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (j > plain) parts.push(s.slice(plain, j));
      parts.push(ESCAPES[c]);
      i = j + 1;
      plain = i;
      continue;
    }
    if (c === '\\' && j + 1 < b && ESCAPABLE.has(s[j + 1])) {
      if (j > plain) parts.push(s.slice(plain, j));
      // '>' is both escapable and HTML-special, so it still needs escaping.
      parts.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]);
      i = j + 2;
      plain = i;
      continue;
    }
    if (c === '`') {
      const k = indexOfWithin(s, '`', j + 1, b);
      if (k > j + 1) {
        if (j > plain) parts.push(s.slice(plain, j));
        parts.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (j + 1 < b && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k > j + 2) {
          if (j > plain) parts.push(s.slice(plain, j));
          parts.push('<strong>');
          inlineRange(s, j + 2, k, env, parts);
          parts.push('</strong>');
          i = k + 2;
          plain = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k > j + 1) {
        if (j > plain) parts.push(s.slice(plain, j));
        parts.push('<em>');
        inlineRange(s, j + 1, k, env, parts);
        parts.push('</em>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1, b);
      const mm =
        k !== -1 && k + 1 < b && s[k + 1] === '('
          ? indexOfWithin(s, ')', k + 2, b)
          : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !hasWhitespace(target)) {
        if (j > plain) parts.push(s.slice(plain, j));
        parts.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineRange(s, j + 1, k, env, parts);
        parts.push('</a>');
        i = mm + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    // A backslash that escapes nothing: it stays plain.
    i = j + 1;
  }
  if (b > plain) parts.push(s.slice(plain, b));
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const parts = [];
  inlineRange(s, 0, s.length, env, parts);
  return parts.join('');
}

// Line kinds: 0 blank, 1 fence open, 2 heading, 3 thematic break,
// 4 blockquote, 5 bullet, 6 ordered, 7 other.
function kind(line) {
  const n = line.length;
  if (n === 0) return 0;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let i = 0; i < n; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return 7;
    }
    return 0;
  }
  if (c0 === 96) {
    // fence: ``` then a language of [A-Za-z0-9_+-]*, then spaces/tabs only
    if (n >= 3 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      let i = 3;
      while (i < n) {
        const c = line.charCodeAt(i);
        if (
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) ||
          c === 95 ||
          c === 43 ||
          c === 45
        )
          i++;
        else break;
      }
      while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
      if (i === n) return 1;
    }
    return 7;
  }
  if (c0 === 35) {
    // heading: 1-6 #, at least one space/tab, then non-empty text
    let d = 0;
    while (d < n && line.charCodeAt(d) === 35) d++;
    if (d >= 1 && d <= 6 && d < n && (line.charCodeAt(d) === 32 || line.charCodeAt(d) === 9)) {
      let e = n;
      while (e > d && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
      let s = d;
      while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
      if (s < e) return 2;
    }
    return 7;
  }
  if (c0 === 45 || c0 === 42) {
    // thematic break: --- or ***, then spaces/tabs only
    if (n >= 3 && line.charCodeAt(1) === c0 && line.charCodeAt(2) === c0) {
      let i = 3;
      while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
      if (i === n) return 3;
    }
    // bullet: "- " or "* "
    if (n >= 2 && line.charCodeAt(1) === 32) return 5;
    return 7;
  }
  if (c0 === 62) return 4; // blockquote: >
  if (c0 >= 48 && c0 <= 57) {
    // ordered: 1-9 digits, ". "
    let i = 0;
    while (i < n && i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (
      i >= 1 &&
      i < n &&
      line.charCodeAt(i) === 46 &&
      i + 1 < n &&
      line.charCodeAt(i + 1) === 32
    )
      return 6;
    return 7;
  }
  return 7;
}

/** A heading line's level and text (kind(line) === 2 already checked). */
function headingOf(line) {
  let d = 0;
  while (line.charCodeAt(d) === 35) d++;
  let s = d;
  const n = line.length;
  while (s < n && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = n;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return { depth: d, text: line.slice(s, e) };
}

/** A fence's language (kind(line) === 1 already checked). */
function fenceLang(line) {
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 95 ||
      c === 43 ||
      c === 45
    )
      i++;
    else break;
  }
  return line.slice(3, i);
}

/** Whether `line` closes a fence: ``` then spaces/tabs only. */
function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96)
    return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  const k = kind(line);
  return k === 0 || k === 1 || k === 2 || k === 3;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  return (
    line.length >= 3 &&
    line.charCodeAt(0) === 32 &&
    line.charCodeAt(1) === 32 &&
    !isWSCode(line.charCodeAt(2))
  );
}

/** An ordered list marker's number (kind(line) === 6 already checked). */
function orderedNum(line) {
  let i = 0;
  let num = 0;
  while (line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) {
    num = num * 10 + (line.charCodeAt(i) - 48);
    i++;
  }
  return num;
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading) and
 * its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  const nextLine = () => {
    if (pos > n) return null;
    let eol = src.indexOf('\n', pos);
    if (eol === -1) eol = n;
    const line = src.slice(pos, eol);
    pos = eol === n ? n + 1 : eol + 1;
    return line;
  };
  let line = nextLine();
  while (line !== null) {
    const k = kind(line);
    if (k === 0) {
      line = nextLine();
      continue;
    }
    if (k === 1) {
      const lang = fenceLang(line);
      const body = [];
      line = nextLine();
      while (line !== null && !isFenceClose(line)) {
        body.push(line);
        line = nextLine();
      }
      line = nextLine();
      parts.push('<pre><code');
      if (lang !== '') parts.push(' class="language-', escapeHtml(lang), '"');
      parts.push('>');
      for (let i = 0; i < body.length; i++) parts.push(escapeHtml(body[i]), '\n');
      parts.push('</code></pre>\n');
      continue;
    }
    if (k === 2) {
      const h = headingOf(line);
      const id = uniqueSlug(slugify(h.text), ids);
      const html = inline(h.text, env);
      parts.push(`<h${h.depth} id="${id}">`, html, `</h${h.depth}>\n`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      line = nextLine();
      continue;
    }
    if (k === 3) {
      parts.push('<hr>\n');
      line = nextLine();
      continue;
    }
    if (k === 4) {
      const body = [];
      do {
        body.push(line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1));
        line = nextLine();
      } while (line !== null && kind(line) === 4);
      const lines = [];
      for (let i = 0; i < body.length; i++) {
        const t = trimLine(body[i]);
        if (t !== '') lines.push(t);
      }
      if (lines.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push('<blockquote>\n<p>', inline(lines.join('\n'), env), '</p>\n</blockquote>\n');
      continue;
    }
    if (k === 5 || k === 6) {
      const isOrdered = k === 6;
      const start = isOrdered ? orderedNum(line) : 1;
      const items = [];
      const markerText = (l) =>
        isOrdered ? l.slice(l.indexOf('. ') + 2) : l.slice(2);
      let cur = [trimLine(markerText(line))];
      items.push(cur);
      line = nextLine();
      while (line !== null) {
        const kk = kind(line);
        if (kk === (isOrdered ? 6 : 5)) {
          cur = [trimLine(markerText(line))];
          items.push(cur);
          line = nextLine();
        } else if (isContinued(line)) {
          cur.push(trimLine(line));
          line = nextLine();
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      parts.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (let i = 0; i < items.length; i++)
        parts.push('<li>', inline(items[i].join('\n'), env), '</li>\n');
      parts.push(`</${tag}>\n`);
      continue;
    }
    // paragraph: lines up to a blank line, a fence, a heading or a break
    const body = [trimLine(line)];
    line = nextLine();
    while (line !== null && !endsParagraph(line)) {
      body.push(trimLine(line));
      line = nextLine();
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push('<p>', html, '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text))
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s[a..b)` holds only spaces and tabs. */
function isSpaceTabOnly(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1)
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({
        t: raw ? 'raw' : 'var',
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone =
      isSpaceTabOnly(src, lineStart, open) && isSpaceTabOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = {
          kind: 'if',
          not: m[1] !== undefined,
          path: pathOf(name, m[2]),
          then: [],
          else: null,
        };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null)
          throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(
            `template "${name}": an ${tag} with no open ${tag.slice(3)}`,
          );
        stack.pop();
        const parent = stack[stack.length - 1];
        body =
          parent.kind === 'root'
            ? parent.body
            : parent.kind === 'for'
              ? parent.body
              : (parent.else ?? parent.then);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1)
    throw new TemplateError(
      `template "${name}": a ${stack[stack.length - 1].kind} is not closed`,
    );
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `parts` in `scope` ({ vars, parent }). `ctx` holds
 * the parsed templates (`templates`, a Map of name to nodes) and the HTML
 * escape. A for loop reuses one frame (and one loop record) for all of its
 * elements instead of one scope object per element.
 */
function renderNodes(nodes, scope, ctx, depth, parts) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.kind) {
      case 'text':
        parts.push(n.text);
        break;
      case 'var':
        parts.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        parts.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, parts);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const frame = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const sc = { vars: frame, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          frame[n.name] = xs[k];
          frame.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, sc, ctx, depth, parts);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH)
          renderNodes(t, scope, ctx, depth + 1, parts);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------- build

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      };

/** One site's output tree: path -> text. */
function build(input) {
  // Templates, parsed in code-unit order of their names.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md'))
      sources.push({
        path: f.path,
        text:
          f.content.indexOf('\r') === -1
            ? f.content
            : f.content.replace(/\r\n?/g, '\n'),
      });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter; refused sources and drafts are reported and dropped.
  const kept = [];
  let pageCount = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    if (!s.post) pageCount++;
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#'))
          return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort(
    (x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug),
  );
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const slug = slugify(tags[i]);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(tags[i]);
      }
    }
    return out;
  };
  for (let i = 0; i < kept.length; i++) kept[i].ownTagNames = ownTagNames(kept[i]);
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    for (let j = 0; j < p.ownTagNames.length; j++) {
      const name = p.ownTagNames[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    s.tagRefs = [];
    for (let j = 0; j < s.ownTagNames.length; j++) {
      const name = s.ownTagNames[j];
      const slug = slugify(name);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
  }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderNodes(nodes, { vars, parent: rootScope }, ctx, 0, parts);
    return parts.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const c = s.post ? cards.get(s) : cardOf(s);
    output[`${s.outDir}/index.html`] = render(s.layout, {
      page: {
        ...c,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      },
    });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => cards.get(p)),
      },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path))
      report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(
    `built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`,
  );
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
