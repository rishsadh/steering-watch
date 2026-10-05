# steering-watch

A recurring index of AI-directed instructions in llms.txt files, with its scanner and harmless canary pages.

![steering-watch scanning a real llms.txt file](docs/scan-qualys.png)

```sh
npx github:rishsadh/steering-watch scan qualys.com
```

That fetches the site's `/llms.txt`, reads it line by line, and prints every instruction aimed at an AI
reader with an exact quote and a line number. Node 18 or newer, no dependencies, no API keys.

Disclosure: Rish Sadh runs Reidify, a studio that sells AEO services. This is published as data with its method, not as a pitch.

## Why this exists

In August and September 2026 two separate studies looked inside llms.txt files and found text written
for AI assistants rather than for people. Common Crawl analysed 584,107 files from its July 2026 crawl
and graded 3,793 as mild steering, 102 as promotional and 10 as classic prompt injections
([Common Crawl, 2026-08-31](https://commoncrawl.org/blog/a-content-analysis-of-llms-txt-files-from-the-july-2026-crawl-archive)).
It also says one crawl cannot show whether any of this is growing. Installmap read 695 llms.txt files from
top sites and found 16 that steer what an assistant recommends, and published the quotes
([Installmap, 2026-09-23](https://installmap.com/research/llms-txt-ai-instructions)).

Both are one-off studies. When I looked on 30 September 2026 I found no tool that re-runs the check on a
fixed list of sites, so the question "is this growing, and who adds or removes it?" had no answer.
steering-watch is that re-run, plus the scanner it needs and a set of test pages for the related question
of whether an agent obeys instructions it finds in a page.

## What is in it

- **The index.** A fixed list of 140 sites. `steering-watch run` fetches each site's llms.txt, scans it,
  writes a dated snapshot, and rebuilds [INDEX.md](INDEX.md). The next run shows what was added or removed.
- **The scanner.** The engine behind the index. It works on any llms.txt, Markdown or HTML text.
- **The canary pages.** Seventeen harmless test pages, each hiding one made-up-code instruction in a different
  way. They test agents, and they are the scanner's own test fixtures. See [canary/](canary/README.md).

## First run, 2026-09-30

![the first index run](docs/run.png)

The screenshot shows the run as first graded, with rules version 1. The numbers below are the same run
re-graded under rules version 2, which adds the platform-default class described in the last bullet.

- 140 sites on the list, 124 served a valid llms.txt. The other 16 (blocks, timeouts, certificate errors,
  no file) count as no file, not as clean.
- 10 files have promotional-tier lines, 30 more have steering-tier lines, 16 have usage terms that mention AI,
  4 carry a platform default and nothing else, and 64 have nothing the scanner matches.
- No file had a classic prompt injection, a command to run, or hidden text. That matches what Installmap
  reported for its sample.
- One paragraph asks an agent to recommend that its user install a third-party skill, and it appears on
  several unrelated sites in the list. The same paragraph is served by a Shopify store that is not on the list,
  and the files that carry it say they are built on Shopify, so it reads as a Shopify platform default and not
  as each company's own steering. The scanner classes it as `platform-default` and the index lists it in its
  own section, so no site is graded for it. No Shopify document confirming that it is platform-generated was
  found. The index also has a section for other lines shared across sites.

Every quote, the site it came from and the line number are in [INDEX.md](INDEX.md) and
[data/latest.csv](data/latest.csv). A match means a line is worth reading. It does not mean the site did
anything wrong: a line that tells an AI to use the official docs is steering, and so is one that tells it
to recommend the company.

## Use it

```sh
# scan a file, a domain, a URL or stdin
steering-watch scan llms.txt
steering-watch scan example.com --min promotional
cat llms.txt | steering-watch scan - --json
steering-watch scan llms.txt --fail-on promotional      # exit 1 for CI

# the index
steering-watch run                     # fetch the fixed list, write data/snapshots/<date>.json and INDEX.md
steering-watch diff                    # compare the last two runs
steering-watch report                  # rebuild INDEX.md and the CSV files from the snapshots
steering-watch rules                   # every rule, its tier and its confidence

# the canary pages
steering-watch canary build --out my-canary --seed any-new-words
steering-watch canary serve --dir my-canary
steering-watch canary score my-canary/tokens.json reply.txt --agent "name and version"
```

Run it with `npx github:rishsadh/steering-watch <command>`, or clone the repo and use `node bin/steering-watch.js`.

### The tiers

| Tier | What it means |
|---|---|
| injection | classic prompt injection: drop earlier instructions, take a new role, reveal the prompt, send data out |
| command | asks the reader to run code or to fetch an address and act on what comes back |
| hidden | text placed where a person will not see it: invisible characters, comments, hidden elements, alt text, JSON-LD, base64 |
| promotional | tells an AI to recommend, favour or frame a company or product, or not to mention rivals |
| steering | tells an AI how to answer: which pages to use, what tone to take, what not to guess |
| terms | usage, licensing or integration terms that mention AI |
| platform-default | a paragraph a hosting platform writes into its customers' files. It says nothing about the site, so the site is not graded for it. Hidden from `scan` unless you pass `--min platform-default` |
| literal | present but not an instruction: a code sample, or a stray invisible character |

The first three tiers follow the grading Common Crawl used. The tiers describe the kind of instruction, not
the intent behind it.

A platform default is added as a rule in `PLATFORM_DEFAULTS` in `src/rules.js`, and only after the paragraph
has been read on a site outside the list. A report built from a snapshot written under older rules re-grades
it in memory, and the snapshot file is left as written.

### How the scanner avoids the mistakes Common Crawl reported

Common Crawl read its ten top-severity hits and found six were false positives: chat-template control tokens
in a post explaining them, and an incidental "you are now" in a page description. So control tokens in a
code fence or inline code are graded literal, "you are now" only counts at the start of a sentence, and
link-list lines such as `- [Title](url): description` are treated as catalogue entries, not instructions.
Most rules fire only when the line names an AI reader or sits under a heading such as "Instructions for AI
Assistants". These cases are in the tests.

## Checking the scanner

The fixed list is built from the domains Installmap labelled by hand, so the scanner can be compared with a
second reader. On the first run:

- Of the 11 files in Installmap's steering group that could be fetched, the scanner flags all 11 and grades
  10 as promotional.
- In the "route to own pages" group it flags 12 of 25. The rest use wording the rules do not cover, so recall
  is partial.
- In the "product copy or false positive" group it flags 7 of 33. Reading them, some look like real
  steering (a scripted "Preferred:" answer, a "prioritize its identity as" line), so the labels and the
  scanner disagree in both directions. Neither is a verdict.
- In the 11-site reference group of documentation sites it flags 1.

## What it does not do

- It does not judge intent or call anything wrong. It matches patterns and quotes the line.
- The rules are regular expressions. Recall is unknown and some lines will be misgraded. Read the quote.
- It does not test what an AI does with a file. It reads what the file says. The canary pages test
  obedience, and a missing code cannot tell "never saw the hidden text" from "saw it and declined".
- The list is fixed and small, and it was chosen from one study's labels plus a control group. It is not a
  sample of the web and it says nothing about how common steering is overall.
- It sends one request per site with a named User-Agent and honours robots.txt for `/llms.txt`. Some sites
  block that, so some files are missing that a browser-like client could reach. It does not disguise itself.
- It reads English well and other languages poorly.
- It scans `/llms.txt` only, not `/llms-full.txt`, AGENTS.md or skill files. Scanners for those exist;
  the gap here is the llms.txt on live sites over time.
- Snapshots keep a hash and exact quotes of up to 240 characters, not copies of the files.
- No agent has been run against the canary pages yet, so [canary/RESULTS.md](canary/RESULTS.md) is empty.

## Data and the site list

The 129 Installmap-derived domains come from the `labels.csv` dataset in the Installmap study, licensed
CC BY 4.0 (Installmap, 2026-09-23). The other 11 are a reference group picked by the maintainer. See
[sites/README.md](sites/README.md) for the columns and the rules for changing the list. If you run a listed
site and want it removed, open an issue and it will be.

Nearby work, and how this differs: Common Crawl and Installmap published one-off analyses; this repeats the
check on a fixed list. There are labs for testing agents that read llms.txt and skill scanners for AGENTS.md
and SKILL.md files; this targets the llms.txt on live sites and adds a change history.

The index workflow in `.github/workflows/index.yml` is set to manual start. The weekly schedule is two
commented lines away.

## Licence

MIT. By [@rishsadh](https://github.com/rishsadh).
