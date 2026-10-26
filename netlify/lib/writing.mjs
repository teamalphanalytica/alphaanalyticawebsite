// House writing rules for everything a client or prospect reads: proposals, weekly reviews, report notes.
// Distilled from the MIT-licensed "humanizer" skill (github.com/blader/humanizer, based on Wikipedia's
// "Signs of AI writing"). The full notes are in docs/WRITING.md.

/** Added to the system prompt of every AI-written piece of customer-facing text. */
export const WRITING_RULES = [
  "Writing rules. The text must read as if a careful person at a small agency wrote it for one business owner.",
  "State each point directly. Never use \"not just X, but Y\", \"it's not X, it's Y\", or \"This isn't about X\" contrasts. Never end a paragraph with a line that repeats it.",
  "No flattery or filler openers (\"You already have a lot going for you\", \"Great news\", \"Let's dive in\"). Start with the fact.",
  "Avoid these words: additionally, crucial, pivotal, key (adjective), robust, seamless, leverage, unlock, elevate, enhance, showcase, tailored, landscape, journey, vibrant, delve, testament, game-changing.",
  "Do not group things in threes unless there really are three. Vary sentence length. Use is, are and has instead of serves as, boasts or features.",
  "No em dashes or en dashes. Use a full stop, comma or colon.",
  "No claims of significance (\"a step in the right direction\", \"the future looks bright\"). End on the last concrete fact.",
  "Do not describe the document itself (\"Here is what we noticed\", \"The table below shows\"). Do not use unnamed authorities (\"experts say\", \"studies show\").",
  "Keep every number, name and claim true to the facts given. Do not add detail that is not in them.",
].join("\n");

const PATTERNS = [
  ["contrast", /\b(?:not (?:just|only|merely)\b[^.]{0,80}\bbut\b|it(?:'|’)s not\b[^.]{0,60}\bit(?:'|’)s\b|isn(?:'|’)t just\b|this isn(?:'|’)t (?:mainly )?about)/i],
  ["dash", /[—–]| -- /],
  ["stock word", /\b(?:additionally|crucial|pivotal|robust|seamless(?:ly)?|leverag(?:e|ing)|unlock(?:s|ing)?|elevate|showcas(?:e|es|ing)|delve|testament|game.?chang(?:er|ing)|cutting.edge|vibrant|tapestry|supercharge|streamline)\b/i],
  ["opener", /\b(?:let(?:'|’)s dive|here(?:'|’)s what you need|great question|i hope this helps|you already have a lot going for you)\b/i],
  ["significance", /\b(?:step in the right direction|future looks bright|exciting times|continues to thrive)\b/i],
  ["about the document", /\bhere is what we noticed\b/i],
  ["exclamation", /!/],
];

/** Names of the AI-writing patterns found in a piece of text. Empty list means clean. */
export function slopFlags(text) {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return PATTERNS.filter(([, re]) => re.test(s)).map(([name]) => name);
}
