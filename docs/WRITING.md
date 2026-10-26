# Writing rules for client and prospect text

Everything a client or prospect reads must sound like a careful person at a small agency wrote it. This covers the proposal PDF, the pitch, the weekly review note and the report notes.

The rules come from the MIT-licensed [humanizer](https://github.com/blader/humanizer) skill, which is based on Wikipedia's "Signs of AI writing". The prompts in `netlify/lib/writing.mjs` carry a short version, and `slopFlags()` checks text against the most common patterns. A test fails if the template proposals contain any of them.

## The rules

1. State the point directly. Avoid "not just X, but Y" and "it's not X, it's Y". Name a contrast only when the reader holds the opposite belief.
2. Do not end a paragraph with a line that repeats it ("That is the real win").
3. Start with the fact. No flattery or run-ups ("You already have a lot going for you", "Let's dive in").
4. Avoid stock words: additionally, crucial, pivotal, robust, seamless, leverage, unlock, elevate, showcase, tailored, landscape, journey.
5. Use three items only when there are three. Vary sentence length.
6. Use "is", "are" and "has" instead of "serves as", "boasts" or "features".
7. No em dashes or en dashes. Use a full stop, comma or colon.
8. No claims of significance ("the future looks bright"). End on the last concrete fact.
9. Do not describe the document ("Here is what we noticed"). Do not cite unnamed authorities ("experts say").
10. Never add a number, name or claim that is not in the facts we hold. Cut unsupported selling lines.
11. Bold, emoji and title-case headings are not decoration. Use sentence case.

## Before sending anything new

Read it aloud. Search it for the rules above. Check that each sentence adds something the reader did not already have. If a sentence only sounds impressive, cut it or replace it with the fact behind it.

The full source, with before and after examples for 26 patterns, is at https://github.com/blader/humanizer (`SKILL.md`).
