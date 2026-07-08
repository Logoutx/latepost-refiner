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

---

_Milestones are dated to when the work landed. The fuller story — including the dead-ends that shaped these decisions — lives in the private development diary._
