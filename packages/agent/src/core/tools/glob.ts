/**
 * File-name globs as editors use them: `*` and `?` stay inside one path
 * segment, `**` spans directories, `{a,b}` lists alternatives and `[abc]` /
 * `[!abc]` are character classes. Paths use `/`.
 */
export function globToRegExp(pattern: string, ignoreCase = false): RegExp {
  return new RegExp(`^${globBody(pattern)}$`, ignoreCase ? "i" : "");
}

function globBody(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const segmentStart = index === 0 || pattern[index - 1] === "/";
        if (segmentStart && pattern[index + 2] === "/") {
          out += "(?:[^/]*/)*"; // "**/": zero or more directories
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const close = pattern.indexOf("}", index);
      if (close < 0) {
        out += "\\{";
        continue;
      }
      const alternatives = pattern.slice(index + 1, close).split(",");
      out += `(?:${alternatives.map(globBody).join("|")})`;
      index = close;
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close < 0) {
        out += "\\[";
        continue;
      }
      let body = pattern.slice(index + 1, close).replace(/\\/g, "\\\\");
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      index = close;
    } else {
      out += char.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return out;
}
