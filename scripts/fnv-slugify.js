// Isomorphic FNV-1a 32-bit hash, ES3-compatible (IE8+, Android 4+).
// No dependencies: no Node 'crypto', no Math.imul (ES6-only).
// Run this exact file/function on both server and client so slugs can
// never drift out of sync between build-series-index.js and the front end.
function toUtf8Bytes(s) {
  var bytes = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0|(cp>>18), 0x80|((cp>>12)&0x3f), 0x80|((cp>>6)&0x3f), 0x80|(cp&0x3f));
        i++;
      } else {
        bytes.push(0xef, 0xbf, 0xbd); // unpaired high surrogate -> U+FFFD
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      bytes.push(0xef, 0xbf, 0xbd); // lone low surrogate -> U+FFFD
    } else if (c >= 0xd800 && c <= 0xdbff) {
      bytes.push(0xef, 0xbf, 0xbd); // high surrogate at end of string -> U+FFFD
    } else {
      bytes.push(0xe0|(c>>12), 0x80|((c>>6)&0x3f), 0x80|(c&0x3f));
    }
  }
  return bytes;
}

// 32-bit multiply without Math.imul (ES6-only, missing in IE8/Android4).
function mul32(a, b) {
  var aHi = (a >>> 16) & 0xffff, aLo = a & 0xffff;
  var bHi = (b >>> 16) & 0xffff, bLo = b & 0xffff;
  var mid = ((aHi * bLo + aLo * bHi) << 16) >>> 0;
  return (mid + aLo * bLo) >>> 0;
}

function fnv1a(str) {
  var bytes = toUtf8Bytes(String(str));
  var h = 0x811c9dc5;
  for (var i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = mul32(h, 0x01000193);
  }
  var hex = '';
  for (var b = 3; b >= 0; b--) {
    var byte = (h >>> (8 * b)) & 0xff;
    hex += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return hex; // 8 hex chars = 32 bits, ~4 billion buckets
}

function slugify(label) {
  return 'l-' + fnv1a(label);
}

// Node: require('./fnv-slugify.js').slugify(label)
// Browser: just include this file with a <script> tag and call slugify(label)
if (typeof module !== 'undefined') module.exports = { fnv1a: fnv1a, slugify: slugify };