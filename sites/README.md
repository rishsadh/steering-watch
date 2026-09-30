# The fixed site list

`watchlist.csv` is the list every run fetches. It is fixed on purpose: the index compares the same
sites over time, so a change in the counts comes from the files and not from a different sample.
It is not a sample of the web.

| Column | Meaning |
|---|---|
| domain | the domain whose `/llms.txt` is fetched (then `www.` if the bare domain has none) |
| cohort | the group the site belongs to |
| tranco_rank | rank in the Tranco list of 2026-09-22, from the Installmap dataset, empty for the reference group |
| source | where the site came from |
| added | the date it joined the list |

## Where the sites came from

- **Installmap groups (129 domains).** The domains Installmap labelled by hand on 2026-09-23 after
  reading their llms.txt files: steering (12), route to own pages (29), usage, licensing and agent
  terms (49), product copy or false positive (39). Five further domains that serve Hola VPN's file
  byte for byte are left out, so each file counts once.
  Source: Installmap, "Everyone is hilariously prompt-injecting AI via llms.txt and you aren't",
  2026-09-23, https://installmap.com/research/llms-txt-ai-instructions. Data `labels.csv`, licence CC BY 4.0.
- **Reference docs sites (11 domains).** Picked by the maintainer: documentation-heavy sites that
  publish an llms.txt and are not expected to carry steering. They are a control group, so a rise
  in the scanner's hits there points at the scanner, not at the sites.

The Installmap labels are one reader's judgement. They are used here to choose the list and to check
the scanner against a second opinion, not as findings of this project.

## Rules for changing the list

- Adding or removing a site is a commit with a reason in the message. Nothing is changed quietly.
- A removed site keeps its history in the old snapshots.
- Personal sites of individuals are not added. The list is companies, publishers and organisations.
- If a site asks to be removed, it is removed.
