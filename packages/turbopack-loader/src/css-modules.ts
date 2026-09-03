const nestingAtRules = new Set([
  'container',
  'document',
  'layer',
  'media',
  'scope',
  'starting-style',
  'supports',
]);

function isWhitespace(char: string) {
  return (
    char === ' ' ||
    char === '\n' ||
    char === '\r' ||
    char === '\t' ||
    char === '\f'
  );
}

function isKeyframesAtRule(name: string) {
  return name.toLowerCase().endsWith('keyframes');
}

function readString(css: string, start: number) {
  const quote = css[start];
  let idx = start + 1;

  while (idx < css.length) {
    const char = css[idx];

    if (char === '\\') {
      idx += 2;
    } else if (char === quote) {
      return idx + 1;
    } else {
      idx += 1;
    }
  }

  return css.length;
}

function readComment(css: string, start: number) {
  const end = css.indexOf('*/', start + 2);
  return end === -1 ? css.length : end + 2;
}

function findAtRuleTerminator(css: string, start: number) {
  let idx = start;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (idx < css.length) {
    const char = css[idx];

    if (char === '/' && css[idx + 1] === '*') {
      idx = readComment(css, idx);
    } else if (char === '"' || char === "'") {
      idx = readString(css, idx);
    } else {
      if (char === '(') parenDepth += 1;
      else if (char === ')' && parenDepth > 0) parenDepth -= 1;
      else if (char === '[') bracketDepth += 1;
      else if (char === ']' && bracketDepth > 0) bracketDepth -= 1;

      if (
        parenDepth === 0 &&
        bracketDepth === 0 &&
        (char === ';' || char === '{')
      ) {
        return idx;
      }

      idx += 1;
    }
  }

  return css.length;
}

function findMatchingBrace(css: string, openBraceIdx: number) {
  let idx = openBraceIdx + 1;
  let depth = 1;

  while (idx < css.length) {
    const char = css[idx];

    if (char === '/' && css[idx + 1] === '*') {
      idx = readComment(css, idx);
    } else if (char === '"' || char === "'") {
      idx = readString(css, idx);
    } else {
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return idx;
      }

      idx += 1;
    }
  }

  return -1;
}

function splitSelectorList(selectorText: string) {
  const parts: string[] = [];
  let start = 0;
  let idx = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (idx < selectorText.length) {
    const char = selectorText[idx];

    if (char === '/' && selectorText[idx + 1] === '*') {
      idx = readComment(selectorText, idx);
    } else if (char === '"' || char === "'") {
      idx = readString(selectorText, idx);
    } else {
      if (char === '(') parenDepth += 1;
      else if (char === ')' && parenDepth > 0) parenDepth -= 1;
      else if (char === '[') bracketDepth += 1;
      else if (char === ']' && bracketDepth > 0) bracketDepth -= 1;

      if (parenDepth === 0 && bracketDepth === 0 && char === ',') {
        parts.push(selectorText.slice(start, idx));
        start = idx + 1;
      }

      idx += 1;
    }
  }

  parts.push(selectorText.slice(start));

  return parts;
}

// One rule per list member: lightningcss folds `:global(a), :global(b)` into
// `:is(a, b)` (parcel-bundler/lightningcss#1032, #1079, proposed fix #1231).
function wrapRule(selectorText: string, blockBody: string) {
  return splitSelectorList(selectorText)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((selector) => `:global(${selector}){${blockBody}}`)
    .join('');
}

export type LineDelta = { delta: number; line: number };

function countNewlines(text: string) {
  let count = 0;
  let idx = text.indexOf('\n');
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf('\n', idx + 1);
  }
  return count;
}

function makeCssModuleGlobalInner(
  css: string,
  startLine: number,
  lineDeltas: LineDelta[]
) {
  let idx = 0;
  let line = startLine;
  let out = '';

  while (idx < css.length) {
    const char = css[idx];

    if (isWhitespace(char)) {
      out += char;
      if (char === '\n') {
        line += 1;
      }
      idx += 1;
    } else if (char === '/' && css[idx + 1] === '*') {
      const end = readComment(css, idx);
      out += css.slice(idx, end);
      line += countNewlines(css.slice(idx, end));
      idx = end;
    } else if (char === '"' || char === "'") {
      const end = readString(css, idx);
      out += css.slice(idx, end);
      line += countNewlines(css.slice(idx, end));
      idx = end;
    } else if (char === '@') {
      const nameStart = idx + 1;
      let nameEnd = nameStart;
      while (nameEnd < css.length && /[A-Za-z0-9_-]/.test(css[nameEnd])) {
        nameEnd += 1;
      }
      const atRuleName = css.slice(nameStart, nameEnd);
      const terminatorIdx = findAtRuleTerminator(css, nameEnd);
      const terminator = css[terminatorIdx];
      const prelude = css.slice(nameEnd, terminatorIdx);

      if (terminator === ';') {
        out += css.slice(idx, terminatorIdx + 1);
        line += countNewlines(prelude);
        idx = terminatorIdx + 1;
      } else if (terminator !== '{') {
        out += css.slice(idx);
        break;
      } else {
        const blockEndIdx = findMatchingBrace(css, terminatorIdx);
        if (blockEndIdx === -1) {
          out += css.slice(idx);
          break;
        }

        const blockBody = css.slice(terminatorIdx + 1, blockEndIdx);
        const bodyStartLine = line + countNewlines(prelude);

        if (isKeyframesAtRule(atRuleName)) {
          out += `@${atRuleName}${prelude}{${blockBody}}`;
        } else if (nestingAtRules.has(atRuleName.toLowerCase())) {
          out += `@${atRuleName}${prelude}{${makeCssModuleGlobalInner(
            blockBody,
            bodyStartLine,
            lineDeltas
          )}}`;
        } else {
          out += `@${atRuleName}${prelude}{${blockBody}}`;
        }

        line = bodyStartLine + countNewlines(blockBody);
        idx = blockEndIdx + 1;
      }
    } else {
      // A selector rule: read until '{' at top-level.
      const openIdx = css.indexOf('{', idx);
      if (openIdx === -1) {
        out += css.slice(idx);
        break;
      }

      const selectorText = css.slice(idx, openIdx).trim();
      const blockEndIdx = findMatchingBrace(css, openIdx);
      if (blockEndIdx === -1) {
        out += css.slice(idx);
        break;
      }

      const blockBody = css.slice(openIdx + 1, blockEndIdx);
      const original = css.slice(idx, blockEndIdx + 1);
      const wrapped = wrapRule(selectorText, blockBody);
      const delta = countNewlines(wrapped) - countNewlines(original);
      if (delta !== 0) {
        lineDeltas.push({ delta, line });
      }

      out += wrapped;
      line += countNewlines(original);
      idx = blockEndIdx + 1;
    }
  }

  return out;
}

export function makeCssModuleGlobalWithLineDeltas(cssText: string) {
  const lineDeltas: LineDelta[] = [];
  const css = makeCssModuleGlobalInner(cssText, 1, lineDeltas);
  return { css, lineDeltas };
}

// Deltas recorded on the same line apply after column 0, where the mappings
// produced by extractCssFromAst live, so only earlier lines shift a mapping.
export function remapGeneratedLine(lineDeltas: LineDelta[], line: number) {
  return lineDeltas.reduce(
    (result, entry) => (entry.line < line ? result + entry.delta : result),
    line
  );
}
