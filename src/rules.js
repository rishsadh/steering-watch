// Rule definitions. Every rule has a tier, a confidence, a plain-English reason and a regex.
// Tiers follow the grading used in the Common Crawl llms.txt study (mild steering, promotional,
// classic injection), plus extra tiers for hidden text, commands, and two "not an instruction" tiers.
// Every rule matches a pattern. A match is a reason to read the line, not a verdict on its author.

export const RULES_VERSION = '2';

// Rank is used for "worst tier wins" and for --fail-on.
export const TIER_RANK = {
  literal: 0, // present but not an instruction: a code sample, or a stray invisible character
  'platform-default': 1, // text a hosting platform inserts into its customers' files, so it says nothing about the site
  terms: 2, // usage, licensing or integration terms that mention AI
  steering: 3, // tells an AI how to answer, which pages to use, what tone to take
  promotional: 4, // tells an AI to recommend, favour or frame a company or product
  hidden: 5, // text placed where a human reader will not see it
  command: 6, // asks the reader to run code, fetch and obey, or act
  injection: 7, // classic prompt injection: override, role change, exfiltration
};
export const TIERS = Object.keys(TIER_RANK);

// Words that name an AI reader. Used to decide whether a line speaks to a machine.
export const AI_WORD =
  /\b(ai|llms?|large language models?|language models?|assistants?|chatbots?|chatgpt|gpt-?\d[\w.]*|claude|gemini|perplexity|copilot|crawlers?|bots?|agents?)\b/i;

// A heading that addresses an AI reader, such as "Instructions for AI Assistants".
// The AI word has to be the audience ("for AI agents"), not just a word in a product name
// ("AI Live Chat Software for Business").
const AUDIENCE =
  '(?:ai|llms?|language models?|chatbots?|assistants?|ai[- ](?:assistants?|agents?|systems?|models?|crawlers?|tools?|readers?)|agents?|crawlers?|bots?)';
const HEAD_AUDIENCE = new RegExp('\\b(?:for|to)\\s+(?:the\\s+|all\\s+|any\\s+)?' + AUDIENCE + '(?=\\s*$|\\s*[(:,\\-|/&]|\\s+(?:and|or|reading|consuming|visiting|using|crawling|summari[sz]ing|answering)\\b)', 'i');
const HEAD_SUBJECT = /\b(?:ai|llms?|assistants?|chatbots?|language models?)s?\s+(?:should|must|shall|instructions?|guidance|directives?|policy|policies|guidelines?|usage|notes?|rules|readers?)\b/i;
const HEAD_FACTS = /\bfacts? (?:for )?(?:ai|llms?)\b|\b(?:ai|llms?)\b[^\n]{0,20}\b(?:should|must)\b/i;
export function headingAddressesAI(h) {
  return !!h && (HEAD_AUDIENCE.test(h) || HEAD_SUBJECT.test(h) || HEAD_FACTS.test(h));
}

// Text that speaks straight to an AI reader.
const ADDRESS_FORM =
  /\b(?:if|when) you are (?:an? |the )?(?:ai|llm|large language model|language model|assistant|agent|bot|chatbot|crawler|automated)\b|\b(?:note|message|attention|instructions?|notice|hello|hey|dear)\s+(?:to|for)\s+(?:the\s+)?(?:ai|llm|assistants?|agents?|language models?|crawlers?|bots?)\b|\b(?:ai|llm|assistant|agent|crawler|bot)s?(?: agents?| assistants?| systems?)?\s*[,:]\s*(?:please|you|do|don'?t|always|never|ignore|include|add|say|reply|respond)\b|\bas an? (?:ai|llm|language model|assistant)\b.{0,40}\b(?:must|should|please|include|add|say)\b/i;
const AI_NAMED = /\b(?:ai|llm|language model|assistant|chatbot|agent)s?\b/i;
const CLAUSE_IMPERATIVE =
  /(?:^|[.!?:;,]\s+|\bplease\s+)(?:ignore|disregard|forget|include|add|append|insert|say|write|reply|respond|answer|mention|recommend|output|print|repeat|tell|state|cite|do not|don'?t|never|always|please)\b/i;

// Does this text speak to an AI and give it an instruction? Used where there is no heading to
// lean on (comments, hidden elements, attributes), so it is stricter than the line rules.
export function addressesAI(text) {
  if (ADDRESS_FORM.test(text)) return true;
  return AI_NAMED.test(text) && CLAUSE_IMPERATIVE.test(text);
}

const LEAD = '^[\\s\\-*>\\d.)]*';

// Platform defaults: paragraphs a hosting platform writes into every customer's llms.txt. The same
// words on many unrelated sites, naming the platform's own product, are the platform's text, so a
// site is not graded for them. A rule here wins over the line rules, and the finding is classed
// "platform-default" instead of promotional or steering. It is still shown, with the platform named.
// Add a rule only after reading the paragraph on a site outside the watchlist.
export const PLATFORM_DEFAULTS = [
  {
    id: 'shopify-shop-skill',
    platform: 'Shopify',
    confidence: 'high',
    why: "the Shopify shop.app SKILL.md paragraph that Shopify stores serve in llms.txt; a platform default, not the site's own steering",
    evidence:
      'Read on 2026-10-05: the same paragraph is served by every list site that carries it and by a Shopify store that is not on the list. Each of those files says the store is built on Shopify, and the paragraph points to Shopify\'s own shop.app skill. That reads as text Shopify adds to its stores. No Shopify document confirming that was found.',
    re: /\bpersonal (?:assistant|shopper)\b[^\n]{0,80}\bopenclaw-like manner\b[^\n]{0,200}\bshop\.app\/SKILL\.md\b/i,
  },
];

// The platform default a piece of text matches, or null. Used by the scanner on each line and by
// the report when it re-grades a snapshot written before the rule existed.
export function platformDefaultFor(text) {
  return PLATFORM_DEFAULTS.find((p) => p.re.test(text)) || null;
}

// Line rules. `needs` says what context the rule needs before it may fire:
//   'addr'  the line names an AI reader or sits under a heading that addresses one
//   'heading' only the nearest heading counts, and it must address an AI reader (for weak rules)
//   'any'   the line is enough on its own
// `literalWhenCode` downgrades a hit to tier "literal" when it sits in a code fence or inline code.
export const LINE_RULES = [
  // injection
  {
    id: 'ignore-previous',
    tier: 'injection',
    confidence: 'high',
    needs: 'any',
    why: 'asks the reader to drop its earlier instructions',
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,30}\b(?:all |any |the |your |these |those )?(previous|prior|above|earlier|preceding|foregoing|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|context|messages?|guidelines?|directions?)\b/i,
  },
  {
    id: 'system-prefix',
    tier: 'injection',
    confidence: 'high',
    needs: 'any',
    why: 'a line that poses as a system or admin message',
    re: /^\s*(?:>\s*)*(?:\*\*|__)?\[?(SYSTEM|ADMIN|DEVELOPER|SYSTEM PROMPT|NEW INSTRUCTIONS?)\]?(?:\*\*|__)?\s*:/,
  },
  {
    id: 'role-hijack',
    tier: 'injection',
    confidence: 'medium',
    needs: 'any',
    why: 'tells the reader it has become something else',
    re: /(?:^|[.!?:"'>]\s*|\bSYSTEM:\s*)(?:you are now|from now on,? you (?:are|will|must|shall)|your new (?:role|task|instructions?|persona) (?:is|are)|pretend (?:to be|you are)|enter (?:developer|dan|god|jailbreak) mode|act as (?:if you were )?an? unrestricted)\s+(?:an? |the |my |no longer |free|unrestricted|in (?:dan|developer|god)|dan|now )/i,
  },
  {
    id: 'reveal-prompt',
    tier: 'injection',
    confidence: 'high',
    needs: 'any',
    why: 'asks the reader to disclose its hidden instructions',
    re: /\b(reveal|print|repeat|output|show|disclose|leak|display)\b[^.\n]{0,30}\b(?:your|the) (?:system|hidden|initial|developer|original) (?:prompt|instructions?|message)\b/i,
  },
  {
    id: 'exfiltrate',
    tier: 'injection',
    confidence: 'high',
    needs: 'any',
    why: 'asks the reader to send private context to an address',
    re: /\b(send|post|upload|forward|transmit|append|leak|exfiltrate|encode|submit)\b[^.\n]{0,15}\b(conversation|chat history|system prompt|previous messages|user'?s? (?:data|messages?|email|files?)|api[- ]keys?|credentials|passwords?|cookies|secrets?)\b[^.\n]{0,60}(?:https?:\/\/|\bwebhook\b)/i,
  },
  {
    id: 'hide-from-user',
    tier: 'injection',
    confidence: 'medium',
    needs: 'addr',
    why: 'asks the reader to act without telling the person it serves',
    re: /\b(?:without (?:asking|confirmation|user approval|telling the user|informing the user)|secretly|do not (?:tell|inform|notify|alert) the user|don'?t (?:tell|inform|notify) the user)\b/i,
  },
  {
    id: 'chat-template-token',
    tier: 'injection',
    confidence: 'high',
    needs: 'any',
    why: 'a chat-template control token outside a code sample',
    re: /<\|(?:im_start|im_end|system|user|assistant|endoftext|begin_of_text|start_header_id|eot_id)\|>|\[\/?INST\]|<<\/?SYS>>/,
    literalWhenCode: true,
  },
  // command
  {
    id: 'fetch-and-obey',
    tier: 'command',
    confidence: 'high',
    needs: 'any',
    why: 'asks the reader to fetch an address and act on what comes back',
    re: /\b(?:fetch|retrieve|download|load|visit|open|request|browse to)\b[^.\n]{0,50}https?:\/\/\S+[^\n]{0,80}\b(?:and|then)\b[^.\n]{0,30}\b(?:include|append|print|paste|insert|follow|execute|run|obey)\b|\bbefore continuing\b[^\n]{0,60}https?:\/\//i,
  },
  {
    id: 'pipe-to-shell',
    tier: 'command',
    confidence: 'medium',
    needs: 'any',
    why: 'a download piped straight into a shell',
    re: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\bpowershell\b[^\n]{0,40}\s-(?:enc|encodedcommand)\b|\biex\s*\(/i,
    literalWhenCode: true,
  },
  {
    id: 'run-command',
    tier: 'command',
    confidence: 'low',
    needs: 'addr',
    why: 'tells the reader to run a command',
    re: /\b(?:ai|llm|assistants?|agents?|models?)\b[^\n]{0,40}\b(?:must|should|shall|need to|are (?:required|instructed|expected) to|please)\b[^\n]{0,30}\b(?:run|execute|install)\b[^\n]{0,30}`[^`]+`/i,
    literalWhenCode: true,
  },
  // promotional
  {
    id: 'always-recommend',
    tier: 'promotional',
    confidence: 'high',
    needs: 'addr',
    why: 'tells the reader to recommend or favour a company or product',
    re: /\b(?:always|must|should|please|make sure to|be sure to)\b(?!\s+(?:not|never)\b)[^.\n]{0,25}\b(?:recommend|suggest|promote|favou?r|highlight|endorse)\b/i,
  },
  {
    id: 'prefer-source',
    tier: 'steering',
    confidence: 'medium',
    needs: 'addr',
    why: 'tells the reader which sources or sections to prefer',
    re: /\b(?:always|must|should|please|make sure to|be sure to|generally)\b[^.\n]{0,25}\b(?:prefer|prioriti[sz]e)\b|^[\s\-*>\d.)]*prioriti[sz]e\b/i,
  },
  {
    id: 'output-directive',
    tier: 'steering',
    confidence: 'medium',
    needs: 'addr',
    why: 'tells the reader exactly what to put in its reply',
    re: /\b(?:end|begin|start|finish|close)\s+(?:your|the)\s+(?:reply|response|answer|summary|output)\s+with\b|\b(?:include|add|append|insert)\s+(?:the\s+)?(?:exact\s+)?(?:text|phrase|string|word|code|line|link|tag)\b[^.\n]{0,40}\b(?:in|to|at the end of)\s+(?:your|the)\s+(?:reply|response|answer|summary|output)\b/i,
  },
  {
    id: 'scripted-answer',
    tier: 'steering',
    confidence: 'medium',
    needs: 'any',
    why: 'a model answer written for the reader to reproduce',
    re: /\bpreferred\s*:\s*["'“]/i,
  },
  {
    id: 'recommend',
    tier: 'promotional',
    confidence: 'medium',
    needs: 'addr',
    why: 'tells the reader to recommend, highlight or rank a product',
    re: new RegExp('(?:' + LEAD + '|(?:→|->|=>)\\s*|[,;]\\s+)(?:recommend(?!ing)|highlight|lead with|showcase)\\b|\\b(?:to|should|must|always|please|consider)\\s+(?:recommend(?:ing)?|highlight|lead with|showcase)\\b', 'i'),
  },
  {
    id: 'rank-first',
    tier: 'promotional',
    confidence: 'medium',
    needs: 'addr',
    why: 'asks for a named product to come first or ahead of others',
    re: /\b(?:recommend|suggest|lead with|favou?r)\b[^.\n]{0,60}\b(?:first|over|above|instead of|ahead of|before (?:other|any))\b/i,
  },
  {
    id: 'no-competitors',
    tier: 'promotional',
    confidence: 'high',
    needs: 'addr',
    why: 'asks the reader not to mention or compare rivals',
    re: /\b(?:do not|don'?t|never|avoid)\b[^.\n]{0,20}\b(?:mention|recommend|compare|cite|reference|suggest)\b[^.\n]{0,40}\b(?:competitors?|alternatives?|other (?:brands?|vendors?|products?|providers?|tools?|companies))\b/i,
  },
  {
    id: 'describe-as',
    tier: 'promotional',
    confidence: 'medium',
    needs: 'addr',
    why: 'tells the reader how to frame or describe the company',
    re: new RegExp('(?:' + LEAD + '|\\b(?:should|must|always|please|to)\\s+)(?:describe|position|characteri[sz]e|frame|portray)\\b[^.\\n]{0,50}\\b(?:as|in terms of|in a)\\b', 'i'),
  },
  {
    id: 'self-praise',
    tier: 'promotional',
    confidence: 'low',
    needs: 'heading',
    why: 'a superlative claim written for the reader to repeat',
    re: /\b(?:excels?|unmatched|unrivall?ed|number one|top[- ]rated|best[- ]in[- ]class|industry[- ]leading|most (?:trusted|reliable|secure|advanced))\b/i,
  },
  {
    id: 'comparative-claim',
    tier: 'promotional',
    confidence: 'low',
    needs: 'heading',
    why: 'a comparative claim written for the reader to repeat',
    re: /\b(?:verdict for|for llm citation|cite (?:us|this))\b|\b(?:more|better|faster|cheaper|safer)\b[^.\n]{0,50}\b(?:than|vs\.?|versus)\b\s+[A-Z][A-Za-z0-9]+/,
  },
  // steering
  {
    id: 'addressed-conditional',
    tier: 'steering',
    confidence: 'high',
    needs: 'any',
    why: 'speaks straight to an AI reader with a condition or a note',
    re: new RegExp(ADDRESS_FORM.source, 'i'),
  },
  {
    id: 'use-our-pages',
    tier: 'steering',
    confidence: 'medium',
    needs: 'addr',
    why: 'points the reader to the company pages instead of its own knowledge',
    re: /\b(?:use|consult|refer to|rely on|cite|send|direct|route)\b[^.\n]{0,60}\b(?:pages?|docs?|documentation|site|website|sales|support|sources?)\b[^.\n]{0,80}\b(?:rather than|instead of|not from|over|for (?:the )?(?:latest|current|accurate|up-to-date|official))/i,
  },
  {
    id: 'do-not-guess',
    tier: 'steering',
    confidence: 'medium',
    needs: 'addr',
    why: 'tells the reader not to estimate or quote certain facts',
    re: /\b(?:do not|don'?t|never)\b[^.\n]{0,15}\b(?:guess|invent|fabricate|make up|quote prices?|speculate|estimate|provide prices?|state prices?)\b/i,
  },
  {
    id: 'focus-on',
    tier: 'steering',
    confidence: 'low',
    needs: 'heading',
    why: 'asks the reader to focus on or start with certain pages',
    re: /\b(?:focus on|start with|begin with|prefer to use|refer to the following)\b/i,
  },
  {
    id: 'tone',
    tier: 'steering',
    confidence: 'medium',
    needs: 'heading',
    why: 'sets the tone the reader should answer in',
    re: /\b(?:tone|style|voice)\b[^.\n]{0,40}\b(?:friendly|concise|encouraging|professional|approachable|formal|warm|positive)\b|\b(?:friendly|concise|encouraging|approachable|warm)\b[^.\n]{0,30}\b(?:tone|responses?)\b/i,
  },
  {
    id: 'when-asked',
    tier: 'steering',
    confidence: 'medium',
    needs: 'addr',
    why: 'a rule for what to say when a user asks about a topic',
    re: new RegExp(LEAD + '(?:when|if) (?:a |the |an )?(?:user|users|someone|anyone|asked|you are asked|people|customers?)\\b[^\\n]{0,120}\\b(?:recommend|suggest|use|point|direct|link|mention|cite|answer|respond|say|refer)\\b', 'i'),
  },
  {
    id: 'ai-must',
    tier: 'steering',
    confidence: 'low',
    needs: 'addr',
    why: 'an AI reader is told what it should or must do',
    demoteIf: /robots\.txt|\btrain(?:ing)?\b|scrap(?:e|ing)|crawl|licen[sc]e|attribution|redistribut|rate[- ]limit/i,
    re: new RegExp(LEAD + '(?:ai|llms?|assistants?|agents?|language models?|chatbots?)(?: agents?| assistants?| systems?| models?)?\\b[^\\n]{0,20}\\b(?:must|should|shall|need to|are (?:required|instructed|expected) to)\\b', 'i'),
  },
  // terms
  {
    id: 'usage-terms',
    tier: 'terms',
    confidence: 'medium',
    needs: 'addr',
    why: 'usage, licensing or integration terms that mention AI',
    re: /\b(?:do not|don'?t|not|may|permitted|allowed|prohibited|forbidden)\b[^.\n]{0,40}\b(?:train|scrap(?:e|ing)|crawl|reproduce|redistribute|republish|index)\b|\b(?:licen[sc]e|attribution|rate limits?|terms of (?:use|service)|authenticate|api keys?|robots\.txt|opt[- ]out)\b/i,
  },
];

export const HIDDEN_RULE_IDS = [
  'zero-width',
  'tag-characters',
  'bidi-control',
  'html-comment',
  'css-hidden',
  'attribute-text',
  'structured-data-text',
  'base64-text',
];

export const ALL_RULE_IDS = [...LINE_RULES.map((r) => r.id), ...PLATFORM_DEFAULTS.map((p) => p.id), ...HIDDEN_RULE_IDS];

export function describeRules() {
  const rows = LINE_RULES.map((r) => ({ id: r.id, tier: r.tier, confidence: r.confidence, why: r.why }));
  for (const p of PLATFORM_DEFAULTS) rows.push({ id: p.id, tier: 'platform-default', confidence: p.confidence, why: p.why });
  const hidden = {
    'zero-width': ['hidden', 'medium', 'three or more zero-width characters on a line (one or two are noted as literal)'],
    'tag-characters': ['hidden', 'high', 'Unicode tag characters that decode to a hidden ASCII message'],
    'bidi-control': ['literal', 'low', 'bidirectional control characters that reorder text on screen (noted, not graded)'],
    'html-comment': ['hidden', 'high', 'an HTML or Markdown comment that speaks to an AI reader'],
    'css-hidden': ['hidden', 'high', 'text in a visually hidden element that speaks to an AI reader'],
    'attribute-text': ['hidden', 'medium', 'an alt, title, aria-label or meta value that speaks to an AI reader'],
    'structured-data-text': ['hidden', 'medium', 'JSON-LD, noscript or template text that speaks to an AI reader'],
    'base64-text': ['hidden', 'medium', 'a base64 string that decodes to text that speaks to an AI reader'],
  };
  for (const id of HIDDEN_RULE_IDS) rows.push({ id, tier: hidden[id][0], confidence: hidden[id][1], why: hidden[id][2] });
  return rows;
}

// A heading like "For AI Agents" makes the lines under it "addressed". A rule with needs: 'addr'
// only fires when it has that context, or when the line itself names an AI reader.
export function contextAllows(rule, { headingAI, nearestAI, lineAI }) {
  if (rule.needs === 'any') return true;
  if (rule.needs === 'heading') return nearestAI;
  return headingAI || lineAI;
}
