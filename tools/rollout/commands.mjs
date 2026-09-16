// Lexical boundaries only: no expansion, execution or control-flow evaluation.
// Keep quoted values and substitutions atomic at both command and word level.
function lex(source, words = false) {
  const commands = [];
  const substitutions = [];
  const groups = [];
  const backticks = [];
  const heredocs = [];
  let heredocError = false;
  let command = "";
  let quote;
  let escaped = false;
  let conditional = false;
  let limit = false;
  let ambiguous = /<<|^\s*(?:function\s|[\w-]+\s*\(\s*\)\s*\{)/m.test(source);
  const flush = () => {
    if (command.trim()) {
      if (commands.length < 1000) commands.push(command.trim());
      else limit = true;
    }
    command = "";
  };
  const capture = (text) => {
    // Word analysis bounds substitutions per command, not across unrelated reads.
    if (!words) return;
    if (substitutions.length < 20) substitutions.push(text);
    else limit = true;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      command += char === "\n" ? "" : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "`" && quote !== "'") {
      if (quote === "`") {
        const frame = backticks.pop();
        capture(source.slice(frame.start + 1, index));
        quote = frame.quote;
      } else {
        backticks.push({ start: index, quote });
        quote = "`";
      }
      command += char;
      continue;
    }
    if (
      char === "$" &&
      ["(", "{"].includes(source[index + 1]) &&
      !["'", "`"].includes(quote)
    ) {
      const open = source[index + 1];
      groups.push({
        close: open === "(" ? ")" : "}",
        quote,
        start: index,
        capture: open === "(",
      });
      quote = undefined;
      command += `$${open}`;
      index += 1;
      continue;
    }
    if (char === "\n" && !quote && heredocs.length) {
      let cursor = index + 1;
      for (const { delimiter, tabs } of heredocs.splice(0)) {
        const start = cursor;
        let found = false;
        while (cursor < source.length) {
          const end = source.indexOf("\n", cursor);
          const lineEnd = end === -1 ? source.length : end;
          const line = source.slice(cursor, lineEnd);
          if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) {
            heredocError ||= source.slice(start, cursor).includes("${{");
            cursor = lineEnd;
            found = true;
            break;
          }
          cursor = lineEnd + 1;
        }
        heredocError ||= !found;
        if (!words || groups.length) command += `\n${delimiter}`;
      }
      index = cursor - 1;
      continue;
    }
    if (!quote && char === "<" && source[index - 1] !== "<") {
      // Only literal cat data, not a heredoc executed by bash/sh or a pipeline.
      const match = source
        .slice(index)
        .match(/^<<(-?)[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*(?=\n|$)/);
      if (
        match &&
        /(?:^|\$\()cat(?:[ \t]+>{1,2}[ \t]+[\w./-]+)?[ \t]*$/.test(
          words ? source.slice(0, index) : command,
        )
      )
        heredocs.push({ delimiter: match[3], tabs: match[1] === "-" });
    }
    if (quote) {
      command += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (["'", '"'].includes(char)) {
      quote = char;
      command += char;
      continue;
    }
    if (
      char === "#" &&
      groups.at(-1)?.close !== "}" &&
      (!command || /\s$/.test(command))
    ) {
      while (index < source.length && source[index] !== "\n") index += 1;
      if (groups.length) command += "\n";
      else flush();
      continue;
    }
    if (char === "(") groups.push({ close: ")" });
    else if (groups.at(-1)?.close === char) {
      const frame = groups.pop();
      if (frame.capture) capture(source.slice(frame.start + 2, index));
      quote = frame.quote;
    } else if (char === ")" && !groups.length) ambiguous = true;
    if (groups.length > 100)
      return {
        commands: [source],
        substitutions: [],
        ambiguous: true,
        limit: true,
        conditional,
      };
    if (words && !groups.length && [">", "<"].includes(char)) {
      flush();
      let operator = char;
      while (source[index + 1] === char) operator += source[++index];
      commands.push(operator);
    } else if (
      !groups.length &&
      (words ? /\s/.test(char) : ["\n", ";", "|", "&"].includes(char)) &&
      !(char === "&" && /[<>]$/.test(command))
    ) {
      if (["&", "|"].includes(char) && source[index + 1] === char)
        conditional = true;
      flush();
    } else command += char;
  }
  if (escaped) command += "\\";
  flush();
  const lexError = Boolean(
    quote || groups.length || escaped || heredocError || heredocs.length,
  );
  return {
    commands,
    substitutions,
    conditional,
    lexError,
    limit,
    ambiguous: ambiguous || lexError || limit,
  };
}

export const shellCommands = (source) => lex(source);
function wordValue(word) {
  let quote;
  let value = "";
  for (let index = 0; index < word.length; index += 1) {
    const char = word[index];
    if (char === "\\" && quote !== "'") {
      const next = word[index + 1];
      if (next !== undefined && (quote !== '"' || /[$`"\\\n]/.test(next))) {
        if (next !== "\n") value += next;
        index += 1;
      } else value += char;
    } else if (char === quote) quote = undefined;
    else if (!quote && ["'", '"'].includes(char)) quote = char;
    else value += char;
  }
  return value;
}
export function shellTokens(source) {
  const result = lex(source, true);
  return { ...result, words: result.commands.map(wordValue) };
}
