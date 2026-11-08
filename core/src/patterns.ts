// Word lists and regular expressions used by the rule checks.
// Kept separate from the logic so they are easy to review and extend.

const FILE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|py|ipynb|java|kt|go|rs|rb|php|cs|c|h|cpp|hpp|swift|scala|sql|sh|bash|zsh|ps1|" +
  "html|css|scss|less|vue|svelte|json|ya?ml|toml|ini|env|md|mdx|txt|csv|xml|gradle|tf|lock";

/** src/auth/jwt.ts, ./index.js, user.test.ts, package.json */
export const FILE_REF = new RegExp(
  String.raw`(?<![\w/.@-])((?:\.{1,2}/)?(?:[\w@-]+/)*[\w.-]*[\w-]\.(?:${FILE_EXT}))(?![\w])`,
  "gi",
);

/** Framework names that look like files ("Node.js") but are not. */
export const NOT_FILES = new Set([
  "node.js", "next.js", "vue.js", "react.js", "express.js", "nuxt.js", "three.js", "d3.js",
  "chart.js", "socket.io", "nest.js", "angular.js", "ember.js", "backbone.js", "p5.js",
]);

const KNOWN_DIRS = "src|lib|app|apps|test|tests|spec|packages|components|pages|api|server|client|public|scripts|docs|config|core|utils";

/** /api/users, src/auth/, ./scripts/build, components/Header */
export const DIR_REF = new RegExp(
  String.raw`(?<![\w/.-])((?:\.{1,2}/|/)[\w@.-]+(?:/[\w@.-]+)*/?|(?:${KNOWN_DIRS})/[\w@.-]*(?:/[\w@.-]+)*/?|[\w@-]+/[\w@.-]+/[\w@./-]*)`,
  "g",
);

/** Concrete code identifiers and other specific details. */
export const IDENTIFIERS: RegExp[] = [
  /`[^`\n]+`/g, // `code`
  /\b[A-Za-z_][\w.]*\(\)/g, // foo(), obj.method()
  /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, // camelCase
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g, // PascalCase
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, // snake_case
  /\bline\s+\d+\b/gi, // line 42
  /"[^"\n]{2,}"|“[^”\n]{2,}”/g, // "quoted text"
  /\b[A-Z][a-zA-Z]*(?:Error|Exception)\b/g, // TypeError
  /\bE[A-Z]{3,}\b/g, // ENOENT
];

/** Product names that match the identifier patterns but say nothing about the code. */
export const NOT_IDENTIFIERS = new Set([
  "JavaScript", "TypeScript", "GitHub", "GitLab", "PowerShell", "YouTube", "LinkedIn", "WordPress",
  "macOS", "iOS", "iPhone", "iPad", "eBay", "PyTorch", "TensorFlow", "OpenAI", "ChatGPT",
]);

/** Generic parts of an app: a weaker target than a file or identifier. */
export const COMPONENT_WORDS =
  /\b(?:component|page|screen|view|button|form|modal|dialog|navbar|header|footer|sidebar|menu|endpoint|route|api|function|method|class|module|service|controller|model|schema|table|database|db|query|tests?|script|cli|command|hook|config|login|logout|signup|sign-up|auth|authentication|checkout|dashboard|homepage|landing page|search|upload|cart|profile|settings|readme|docs|documentation|pipeline|workflow|dockerfile|migration|parser|validation)\b/i;

export const STRONG_VERBS =
  /\b(?:add|remove|delete|rename|create|implement|write|extract|move|replace|migrate|convert|split|merge|install|configure|set up|setup|upgrade|downgrade|bump|document|debug|reproduce|explain|translate|port|validate|parse|cache|paginate|sort|filter|expose|return|throw|log|catch|wrap|inline|deduplicate|revert|generate|build|deploy|test|fix|show|hide|display|disable|enable|limit|increase|decrease|reduce|raise|lower|insert|append|prepend|introduce|compute|calculate|print|list|count|store|save|load|fetch|send|call|use|switch)\b/gi;

/** "change X to Y" is concrete; "change X" is not. */
export const CHANGE_TO = /\b(?:change|update|modify|adjust|set|rename|convert|move)\b[^.\n]{1,60}?\b(?:to|into|from)\b/i;

export const VAGUE_VERBS =
  /\b(?:improve|enhance|optimi[sz]e|clean(?:\s|-)?up|tidy(?: up)?|polish|refactor|make (?:it |this |that |them |everything )?(?:better|work|nicer|faster|good|cleaner|prettier|nice|easier)|look (?:at|into)|check|deal with|sort out|tweak|moderni[sz]e|rework|redo|handle|work on|help(?: me)?(?: with)?|change|update|modify|adjust|fix(?=\s+(?:it|this|that|them|everything|stuff|things|(?:the|my|a|some) (?:bugs?|issues?|problems?|errors?|code|app|tests?))\b))\b/gi;

export const QUESTION =
  /^\s*(?:why|what|how|where|which|when|who|is|are|does|do|can|could|should|would)\b|\?\s*$/i;

export const BROAD =
  /\b(?:all|every|everything|everywhere|entire|whole|the (?:app|application|project|codebase|code|repo|repository|site|website|system|frontend|backend))\b/gi;

export const BOUNDED =
  /\b(?:only|just|single|don'?t|do not|without|keep|leave|except|limit(?:ed)? to|nothing else|no other)\b/i;

/** Expected behaviour or a check that shows the task is done. */
export const DONE_STRONG =
  /\b(?:so that|should|must|expect(?:ed|s)?|done when|acceptance|ensure|make sure|verify|until|pass(?:es|ing)?|instead of|rather than|returns?|outputs?|results? in|criteria|assert|e\.g\.|for example|(?:add|write) (?:a |an |some )?(?:unit |integration |e2e )?tests?|tests? (?:for|that|cover))\b|->|→|=>/i;

/** Describes what is wrong now, but not what should happen. */
export const DONE_PARTIAL =
  /\b(?:currently|right now|at the moment|error|fails?|failing|crash(?:es|ing)?|throws?|broken|bug|doesn'?t|does not|isn'?t|is not|won'?t|not working|exception|undefined|null|[45]\d\d)\b/i;

export const PRONOUNS = /\b(?:it|this|that|these|those|them|stuff|things?|the thing)\b/gi;

export const SUBJECTIVE =
  /\b(?:better|nicer|cleaner|faster|slower|smaller|bigger|modern|good|great|nice|properly|correctly|robust|scalable|efficient|performant|user[- ]friendly|intuitive|beautiful|pretty|clean|simpler|optimal|best|professional)\b/gi;

/** [file name], [expected behaviour]; not checkboxes [ ] / [x] or markdown links. */
export const PLACEHOLDER = /\[(?!\s?\]|x\])([^\]\n]{2,80})\](?!\()/gi;

export const RISK =
  /\b(?:production|prod|deploy(?:ment)?|migrat(?:e|ion|ions)|drop (?:table|database|column)|rm -rf|force[- ]push|push --force|reset --hard|truncate|wipe|delete (?:all|every|the database)|payments?|billing)\b/gi;

export const SECRETS: RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[^\s"']{6,}/gi,
];

export const TRIVIAL =
  /^\s*(?:commit|push|pull|status|build|lint|format|continue|go on|go ahead|proceed|yes|no|y|n|ok(?:ay)?|thanks?(?: you)?|thx|lgtm|looks good|do it|undo|retry|try again|stop|git status|run (?:the )?(?:tests?|build|linter|app)|run it|commit (?:and push|this|that|it|the changes))\s*[.!]?\s*$/i;

export const SKIP_MARKER = /\[preflight:skip\]/i;
