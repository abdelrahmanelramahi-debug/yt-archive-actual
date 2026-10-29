# YouTube Archive

Double-click **START.bat**. Everything is in the menu:

```
1  Update            asks once before spending (shows the cost estimate)
2  Update overnight  set Apify + Claude limits once, then it runs with no questions
3  Ask a question    answers with timestamp links
4  Open the archive  browse every video in your browser, filter by channel / topic / live
5  Add a channel
6  Channel settings  lives, shorts, language, test mode, remove
7  Settings          answer language, search model, speeds, fast indexing, re-tag, keys
8  Balances          Apify balance + what this tool has spent
9  Output folder
```

**ask.bat** jumps straight to questions.

Update shows the estimated cost and asks before spending. Overnight mode asks only for spending limits at the start, keeps the PC awake, and stops at the limits. If anything stops halfway, run Update again: finished work is never redone or re-paid.

## Output

| Where | What |
|---|---|
| Menu option 4 (Open the archive) | The archive in your browser: channels, hours, thumbnails, search, sort, topics, and transcripts with timestamp links. Runs on a small local server on your PC. |
| `output\ALL\topics\` | One page per topic across all channels, with timestamp links |
| `output\ALL\videos.csv` | Every video from every channel. Excel / Power BI |
| `output\ALL\chunks.jsonl`, `videos.json`, `topics.json` | All data for AI tools, websites, visuals |
| `output\<channel>\notebooklm\` | Upload these to NotebookLM (20 videos per file) |
| `output\<channel>\read\` | One Markdown file per video |
| `output\answers\` | Every question you asked, with sources |
| `output\spend.json` | Every charge this tool made |

Don't edit files in `output`: Update regenerates them. `raw` and `tags` hold the downloaded/paid data, keep those.

## Notes

- Claude's balance can't be read automatically for personal accounts. The tool tracks what it spends; your real balance is at console.anthropic.com/settings/billing.
- Lives: only finished YouTube streams with captions. A stream from the last day or two may not have captions yet; it's retried on later updates. Streams on Kick or other sites aren't covered.
- Non-English channels: set the channel's language, and switch the search model to multilingual in Settings.
