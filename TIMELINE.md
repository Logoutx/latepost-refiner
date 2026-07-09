# Development Timeline

latepost-refiner turns rough, machine-transcribed Chinese interviews into faithful, readable documents — removing filler, fixing mis-heard names and brands, adding sub-headings, and cross-checking people and companies against public sources — **without summarizing**. Every fact in the source must survive into the finished document.

This is the milestone version of the story. A fuller, more technical development diary is kept as a private working file and is not part of the repository.

---

## Early–mid June 2026 — From a manual checklist to a real pipeline

The tool began as a set of instructions an assistant followed by hand. The first real build turned that into an automatic pipeline: read each file, extract the cast of names and mis-hearings, check names against the web, clean the text, and check the result — with cheap work sent to cheap models and only the careful editing sent to the strongest one. An early experiment showed that upgrading the name-extraction step to a stronger model actually made things *worse* (it merged two different people who shared a polite title), which taught a lesson the project kept: precision comes from careful rules, not from a bigger model.

## Mid-June 2026 — One shared core, two editions

The shared logic was pulled into one place so every edition stays in sync. Alongside the original edition that runs on a Claude subscription, a standalone version was built that runs from the command line or a local web page and works with several AI providers (DeepSeek, GLM, Kimi, OpenAI, Anthropic) using your own API key. The transcript-cleaning rules were tuned against real archived work: filler is removed in graded tiers so meaning is never flattened, and a running "correction sheet" of names now carries over between interviews of the same company instead of being rebuilt each time.

## Late June 2026 — The rename and cleanup

`interview-transcriber` was renamed **latepost-refiner** — "refiner," because the promise is to refine, never to summarize. All real interviewees, companies, and brands were replaced with fictional stand-ins so no real research subject ships in the code, and the documentation was rewritten in plain language.

## Late June 2026 — Catching hidden faithfulness failures

A real test exposed the deepest problem: an AI can hand back a polished "cleaned" transcript that is actually a *summary* — most of the interview quietly gone — and the old check passed it, because it only looked at whether the text was tidy, never whether it still matched the source. The fix was a **faithfulness check that compares the finished document against the original** and measures how much of the content survived. It is written as a plain, rule-based check with no AI involved, so it is cheap, repeatable, and can't be fooled the way a model can. This check became the backbone everything else was built on.

## Late June 2026 — Faster without cutting corners; surviving stalls

Long files can be split into pieces and cleaned in parallel. Testing showed this does more than save time: a cheaper model, given a bounded piece, stops running out of room and summarizing — so splitting is a **faithfulness safeguard as much as a speed option**. The strongest model stays the default for the actual editing, because on a long interview it is both the most faithful and, in the end, the cheapest way to stay faithful. The pipeline was also hardened so a cheap early step that stalls can never hold up — or discard — the expensive editing that was already finished.

## Early July 2026 — Making omissions visible

An AI provider silently dropped a politically sensitive stretch of one interview — its own content filter, refusing that passage. The finished document gave no sign anything was missing. The tool now **detects a dropped section on its own** (without trusting the very model that may have censored it) and **marks the gap in the document** — "content missing here, please restore from the source." Each section also gained an invisible link back to its place and timestamp in the recording, so any quote can be traced to the audio. And because choosing an AI provider means choosing who reads the full transcript, the tool now warns which providers process your interview under which country's jurisdiction — a source-protection matter for a newsroom.

## Early July 2026 — Three AI engines, head to head

The same interview was run through three different AI engines and reviewed by hand. They failed in three *different* ways — one over-compressed, one invented dates, one barely cleaned the text and mangled some names — which proved that instructions written as prose don't survive being handed to a different model. The response: move every check that *can* be made mechanical into the rule-based faithfulness layer, and **run that check automatically inside the pipeline**, as a gate the finished documents have to pass, on every edition. The comparison also revealed that the check itself had blind spots — so it grew new detectors for **facts that were quietly *altered* rather than dropped** (a changed number, a stripped "roughly," a quote attributed to the wrong speaker, a name swapped for a similar-sounding one), and a guard so a user-dictated correct name can't be overridden by a common mis-hearing.

## July 2026 — Cost controls and self-logging

With faithfulness settled, attention turned to cost. A second head-to-head confirmed that running everything on the cheapest model quietly compressed the interview and dropped a section, while a **cheap-for-the-mechanical-work, strong-for-the-writing split** stayed faithful for a few cents — so that split became the default for the DeepSeek provider. Two live bugs that only appear in the real run environment (not in offline tests) were fixed and guarded against at build time. Finally, every run now **logs its own time, usage, and estimated cost** to a running file, so the economics of a batch are visible at a glance.

## July 2026 — Subtitle transcripts, and reuniting the editions

The tool learned to read subtitle-style source files: timed caption blocks are turned into clean speaker turns before editing, with the timecodes set aside so they are never mistaken for facts in the interview — and the faithfulness check gained a way to confirm that a re-ordered "logical narrative" draft still covers the whole interview. This work had grown up on a separate line alongside the local-app front end, so the two were merged back together, bringing every edition into step again.

## July 2026 — One source of truth for the shared files

A handful of files ship in more than one place so each edition is self-contained, and those copies had begun to drift apart when edited by hand. A single sync step now regenerates every copy from one source of truth — each generated copy carries a "do not edit" banner — and one check, run before the tests and in continuous integration, fails the build the moment any copy falls out of sync, replacing the earlier file-by-file comparisons.

## July 2026 — A quality check that can't be silently skipped

A three-engine comparison exposed a quiet failure: on one real run the automatic quality check hit an error and, instead of stopping, the tool delivered the finished documents with a small "check unavailable" note — as if nothing were wrong. A check that can be skipped without anyone noticing is not a check. Now, when the check cannot run even after one retry, the whole run is marked failed: the finished files are kept on disk (the work is not thrown away), but the final report states plainly that they are unaudited and must be verified by hand before they are trusted, and the command exits with an error that the "ship anyway" override cannot mask. "Not checked" is never allowed to read as "passed".

## July 2026 — Catching figures the interviewee never said

The same comparison turned up the highest-stakes failure of all: a generated timeline stated numbers — presented as things the interviewee said — that never appeared in the interview at all. For a newsroom that is the worst kind of mistake, and nothing had been watching for it; the faithfulness check only ever compared a cleaned transcript against its own source, never the timeline or the summary built on top. Now every figure in those two documents must carry a source label — spoken in the interview, or drawn from public/background material (which is flagged for a reporter to verify) — and a rule-based check reads each finished timeline and summary back against what was actually said. A measured quantity (a sum of money, a weight, a distance, a percentage, a duration) marked as coming from the interview but absent from it fails the run and is named by file and line. Plain counts and calendar dates are held to a gentler "please double-check" tier, since they are easy to confuse with list numbers and entry dates, and the same amount written two ways (eight thousand-myriad and nought-point-eight hundred-million) is recognised as one number, so honest editing is never punished.

## July 2026 — Telling a real changed number from transcription noise

A close look at the strongest engine run showed that almost every "number changed" alarm was a false one: the raw transcript had stuttered a figure ("thirty… thirty people"), or buried a stray number inside a garbled fragment, and the cleaned-up version had rightly dropped it — yet the check counted that tidy-up as a missing fact. The number-checker now knows the difference. A figure the raw transcript repeats on the spot is treated as one fact, not two; a figure sitting inside a passage the tool already recognises as transcription garbage is set aside as a "worth a glance" note rather than a fault; and numbers are compared passage-by-passage against the matching part of the source instead of against the whole document at once, so two unrelated figures can no longer be mistaken for one that drifted. A figure that genuinely was changed or invented in the finished text still raises the alarm, exactly as before.

## July 2026 — Fewer false "wrong speaker" alarms when the room is crowded

Matching each answer back to the person who said it gets harder once more than two people are in the room: a cleaned-up transcript merges or splits turns, and the checker can pin a line to the wrong name. On the strongest run of a four-person interview, all four "wrong speaker" alarms turned out to be these alignment slips, not real mistakes. The check now asks for more before it accuses. In a conversation of three or more people it raises a firm "wrong speaker" fault only when a whole answer plainly sits under the wrong name; a single weak match is set aside as a "please double-check" note instead of an accusation. A genuine swap — an entire answer moved under someone else's name — still fails firmly, and two-person interviews, where the check was already reliable, work exactly as before.

## July 2026 — Catching a document that disagrees with itself

A finished document can quietly contradict itself: the same figure — a margin, a headcount, a span of time — is given one number in an early passage and a different number later, and each passage reads as faithful on its own. A human editor caught exactly this once. The tool now reads each finished transcript, and the timeline and summary built from it, for a measured quantity that is named the same way but carries two different exact numbers, and lists both places for a person to check against the recording. It is deliberately cautious: it only pairs the same noun with the same unit, it ignores rough estimates and "up to / no more than" phrasings that are allowed to differ, it never fails a run on its own, and the list is capped so it can never bury the more urgent items.

---

_Milestones are dated to when the work landed. The fuller story — including the dead-ends that shaped these decisions — lives in the private development diary._
