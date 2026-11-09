# Historic Photo Explorer: project write-up

Historic Photo Explorer describes historical photographs for blind and visually impaired readers. You give it a subject and a place. It finds matching photos in the Library of Congress (LoC) archive, sends them to Claude, and returns a page with a written description of each photo.

This write-up covers how the app works, why it's built the way it is, and how I evaluated the descriptions. That includes the rubric, the change from a first prompt (v1) to a stricter one (v2), and a panel of four other AI models used as judges.

## Summary

- **Image size caused most of the errors.** A quarter of the test photos were only available from LoC as 150-pixel thumbnails, and they produced every serious error in v1. The app now detects thumbnails, tells Claude, and shows a notice.
- **The stricter v2 prompt stopped the model from guessing.** Accuracy went from 4.45 to 4.90 out of 5, mostly on the thumbnails. It didn't help with what's missing: completeness and the match with the cataloger's summary stayed about the same.
- **Claude's descriptions ranked first with all four judges.** It was clearly ahead of two models (Kimi, Gemma) but not clearly ahead of the other two (DeepSeek, Muse Spark). Its lead comes mainly from leaving less out, and its descriptions are also the longest.
- **The AI judges are useful but not a substitute for a careful human check yet.** They match the human-checked scores exactly about two-thirds of the time. They tend to miss errors hidden in a description's notable-details list, and to excuse a wrong guess when it is hedged with "likely".
- **The descriptions say what's in a photo, not why it was taken that way.** They don't interpret the photographer's intent, which may be right for a reader who wants to form their own view.

## 1. How it works

One search makes three kinds of outbound request, one after another:

```
Browser ──GET /search?subject=portrait&location=new york──▶ Node server
  1. LoC search      GET  https://www.loc.gov/photos/?q=portrait&fa=location:new york&fo=json&c=25
  2. Image download  GET  https://tile.loc.gov/...jpg     (up to 5, one at a time)
  3. Description     POST https://api.anthropic.com/v1/messages   (all 5 images in one request)
Node server ──HTML results page──▶ Browser
```

1. **Search.** The LoC JSON API is public. The server keeps the first 5 results with an image, and takes each one's title, catalog date, record link and medium-size image.
2. **Download.** Each image is downloaded and converted to base64. The server reads the image's width and height from its header bytes. If the longest side is under 400 pixels, the photo is marked **low resolution**.
3. **Describe.** All 5 images go to Claude in one request. Each image is preceded by a short label with the photo number, the catalog title, the catalog year and, for thumbnails, a low-resolution marker:

   ```
   Photo 5: "Squad car set afire in disorder / photo by Mel Larsen, Chicago Sun-Times." (catalog date: 1966) [LOW RESOLUTION: small thumbnail, fine detail is not visible]
   ```

   The request uses **structured outputs**: a JSON schema requires one entry per photo with a description, an estimated period and a list of notable details. The server rejects refused or cut-off answers instead of showing a half-finished page. The default model is `claude-opus-5-5`.
4. **Render.** The server builds the HTML itself and escapes every value from LoC or Claude, so neither can inject markup into the page.

Finished results are cached in memory for an hour. Timeouts, input limits and error pages are listed in the [README](../README.md). The request code is in [src/](../src/).

## 2. What it's built with, and why

**Node.js core modules only.** The project began as a CUNY assignment (CS 355): a mashup of two APIs using only Node's built-in `http`, `https` and `fs` modules, with the requests running in sequence. I kept that constraint. Every outbound request goes through about 120 lines of [http-client.js](../src/http-client.js), so the redirects, timeouts and error handling are all in one place. There's nothing to install or keep up to date.

**A plain HTTPS call to Claude instead of the SDK.** The request body in [claude.js](../src/claude.js) is exactly what the API receives. That made the evaluation easier, because the evaluation scripts call the same `buildRequest` function as the app and so test the same prompt.

**Structured outputs instead of free text or HTML.** The schema fixes the shape of the answer, so the server never parses prose or trusts model-written markup. The model only provides text, and the server decides how to show it.

**One request for all 5 photos.** One call means one round trip instead of five, and the instructions are sent once. I didn't measure cost or speed against separate calls. The trade-off is that the model sees all five images at once, so details could in principle leak from one description to another. I didn't see that happen in the evaluation, but I didn't test for it specifically.

**The catalog title and date are sent; the cataloger's summary isn't.** The title and date are what a person browsing the archive sees first, and they let the model name a person or place it couldn't recognize. Leaving out the cataloger's written summary kept it independent, so the evaluation could use it as a reference.

## 3. Evaluating the descriptions

Sixteen offline unit tests check the code, for example parsing both APIs' responses, the cache, HTML escaping and the thumbnail check. They can't tell whether a description is any good. For that I built a small evaluation.

### 3.1 The photos and the reference

I picked 20 LoC photos, as 4 searches of 5:

| Group | Search | Difficulty |
| --- | --- | --- |
| A | "portrait" in New York | Easy: one or two people, plain setting |
| B | "sign" in New York | Medium: the text must be read |
| C | "crowd" in Chicago | Hard: news photos, crowds, events |
| D | "bird's eye view" in Pennsylvania | Hard: dense prints and maps full of small text |

Every photo was picked because an LoC cataloger had written a summary of what it shows ("Photograph shows…"). The app never sees these summaries, so they serve as a human-written reference. Picking only photos with summaries may skew the set toward better-catalogued items.

Five of the 20 turned out to be available only as 150-pixel thumbnails, likely because of rights restrictions, and the app sent them anyway.

`node eval/run.js <version>` runs each group through the app's own download and Claude code, so the evaluation tests exactly what a user gets.

### 3.2 The rubric

Each description gets four scores from 1 to 5. Every level is defined, with an example from this evaluation, in [eval/RUBRIC.md](../eval/RUBRIC.md).

| Score | Question | Key rules |
| --- | --- | --- |
| **Accuracy** | Is what it says true? | Only claims count, not omissions. A hedged guess ("possibly") is fine, unless it names a person, place or event that the record contradicts. |
| **Completeness** | Does it leave out anything important in the picture? | People and animals (with a count when there are few), main objects, the action, the setting, large text. A small thumbnail doesn't excuse a miss, because the listener misses it either way. |
| **Usefulness to a blind reader** | Can a listener follow it when it's read aloud once? | Four problems: filler at the start, secondary detail first, text left until the details list, too long. Each problem costs a point. |
| **Matches reference** | Does it get across what the cataloger wrote? | Key facts (subject, name, action) and secondary facts. Wrong reference facts are ignored; facts you can't see still count. |

The rubric started with three scores and was revised twice after scoring began:

- **Completeness was added.** Leaving out something visible, like the dogs in the family portrait (section 4), cost points only if the cataloger happened to mention it.
- **The hedge rule was clarified.** One rule said a hedged guess is never a slip, and another penalized linking a photo to an event the record contradicts. The squad-car photo (section 4) fell between them. Now a hedged guess that names a person, place or event is judged as if it were stated.

The old rubric and its scores are kept in [eval/archive/three-score-rubric/](../eval/archive/three-score-rubric/).

### 3.3 How the scores were produced

1. **Claude drafted** a score and a note for each of the 40 descriptions (20 photos × v1 and v2). That's the same model family being evaluated, which is a reason for the next two steps.
2. **Four other models graded the same descriptions** independently (section 3.7).
3. **I checked the scores** against the images, starting with every score where the judges and the draft differed by 2 or more points. Several scores changed in this step. Most changed because of the rubric revision; the family portrait's accuracy changed because the draft was too harsh.

The resulting scores are the **human-checked baseline**. Some of them changed after I saw the judges' grades, so the agreement figures in section 3.8 are somewhat flattering.

To review everything for one photo in one place, see [eval/REVIEW.md](../eval/REVIEW.md).

### 3.4 Round 1 (v1): what went wrong

1. **Image size mattered more than how hard the photo was.**
   - The 5 thumbnails averaged 3.4 for accuracy, against 4.8 for the full-size images, and they included every serious error.
   - On one, the model said a stretcher carried "presumably the victim"; the record says it was the gang's lawyer.
   - The model mentioned the small size in only 2 of the 5 cases.
2. **It filled gaps with plausible history.**
   - It linked the burning squad car to the wrong riot.
   - On two photos it replaced the catalog date with its own guess on thin evidence. For the Tubman portrait the evidence was "clothing and studio style".
3. **It read text very well but didn't always put it first.**
   - All four signs were transcribed correctly, down to an artist's signature and a small sticker.
   - On the dense prints, the title and banner text appeared only at the end of the notable-details list.

### 3.5 What changed in v2

- **Thumbnail check:** the size check from section 1. Claude is told which images are thumbnails, and the page shows a notice.
- **Stricter prompt**, with five numbered rules:
  1. Open with the main subject and read out any visible text near the start.
  2. Most important things first.
  3. Name a person, place or event only if the catalog title or visible text supports it.
  4. Use the catalog date unless something visible contradicts it.
  5. For thumbnails, describe less and say why.

### 3.6 Round 2 (v2): results

Same 20 photos, same model. Each cell is v1 → v2.

| Subset | Accuracy | Completeness | Usefulness | Matches reference |
| --- | --- | --- | --- | --- |
| **All 20** | 4.45 → 4.90 | 4.40 → 4.35 | 4.30 → 4.35 | 4.15 → 4.10 |
| Full-size (15) | 4.80 → 5.00 | 4.80 → 4.80 | 4.33 → 4.47 | 4.67 → 4.53 |
| 150px thumbnails (5) | 3.40 → 4.60 | 3.20 → 3.00 | 4.20 → 4.00 | 2.60 → 2.80 |

- **Accuracy improved most where it was worst.** All 5 thumbnails were flagged, and the model said what it couldn't see instead of guessing. Every full-size description scored 5.
- **Completeness and the reference match stayed about the same.** The small changes are within noise. A stricter prompt prevents made-up details, but it can't make a 150-pixel image show two dogs or Muhammad Ali's face.
- **The stricter prompt had costs.**
  - It dropped some correct context: the Pittsburgh print no longer says the ruins came from the 1845 fire.
  - It added filler: about 6 of the 20 descriptions now open with a sentence like "no text is visible on the image", which a screen-reader user has to sit through.

### 3.7 Other models, as authors and as judges

I used four vision models through NanoGPT, a service that offers many providers' models through one OpenAI-compatible API: DeepSeek V4.1 Flash, Kimi K2.6, Gemma 4 31B and Muse Spark 1.3. Each model wrote its own descriptions of the 20 photos with the app's v2 prompt. Then each graded all six sets of descriptions, 480 grades in all ([eval/judge.js](../eval/judge.js)). I didn't use Claude as a judge, to avoid it grading its own work.

**How the judging worked:**
- **Blind and shuffled.** Judges weren't told who wrote a description, and saw them in shuffled order.
- **What a judge saw.** The photo, the catalog record, the reference summary and the rubric, with the example column removed so it couldn't see the human-checked scores.
- **Reasons first.** Each judge wrote a one-sentence reason before each score.
- **No self-grades in the ranking.** A model's grades of its own descriptions were left out.

| Descriptions by | Accuracy | Completeness | Usefulness | Reference | Overall | 95% interval |
| --- | --- | --- | --- | --- | --- | --- |
| **Claude v1** | 4.59 | 4.19 | 4.41 | 4.00 | **4.30** | 4.02–4.53 |
| **Claude v2** | 4.75 | 4.11 | 4.42 | 3.80 | **4.27** | 4.02–4.49 |
| DeepSeek V4.1 Flash | 4.83 | 3.77 | 4.60 | 3.38 | 4.15 | 3.90–4.39 |
| Muse Spark 1.3 | 4.37 | 4.07 | 4.35 | 3.77 | 4.14 | 3.83–4.41 |
| Kimi K2.6 | 4.47 | 3.78 | 4.72 | 3.57 | 4.13 | 3.83–4.42 |
| Gemma 4 31B | 4.45 | 3.30 | 4.62 | 3.50 | 3.97 | 3.73–4.20 |

"Overall" is the average of the four scores. The interval comes from resampling the 20 photos 2,000 times ([eval/compare.js](../eval/compare.js)).

- **Claude's lead is clear over Kimi and Gemma, but not over DeepSeek and Muse Spark.** A paired comparison (the same photos, graded by the same judges) puts Claude v1 ahead of Kimi by 0.27 (95% interval 0.07 to 0.48) and of Gemma by 0.25 (0.10 to 0.44). Against DeepSeek (+0.15, interval 0.01 to 0.32) the lead is borderline, and against Muse Spark (+0.13, −0.03 to 0.30) it could be chance. v2's comparisons follow the same pattern. The full table is in [eval/judges/summary.md](../eval/judges/summary.md).
- **The gap is mostly Completeness, and length is part of it.** The other models' descriptions averaged 64–109 words, against Claude's 115–138 (description text only). Across all 120 descriptions, longer descriptions scored higher on completeness (rank correlation 0.50).
- **Claude isn't best at everything.** DeepSeek scored highest on accuracy, and Kimi was easiest to listen to.
- **Claude v1 and v2 tie** (4.30 against 4.27). v2's gain in accuracy is offset by a small loss in matching the reference.

**Don't use Kimi K2.6 as a judge.**
- **It was very slow.** It finished last in every run, and most connection drops in the final run were its requests: 21 of 33. Some of that may be the provider rather than the model, but all four models went through the same provider.
- **It needed a workaround.** It returned empty answers when asked for a strict JSON schema, so all four judges had to use plain JSON mode, with the answers checked in code.

Its grades were reasonable, just the strictest. For a panel meant to run unattended, reliability matters more than a fourth opinion.

### 3.8 How each judge graded

| Judge | Average score given | Share of 5s | Exact match with human-checked | Rank correlation | Average gap from human-checked |
| --- | --- | --- | --- | --- | --- |
| Gemma 4 31B | 4.38 | 65% | 73% | 0.68 | +0.13 |
| Muse Spark 1.3 | 4.20 | 54% | 68% | 0.68 | −0.02 |
| DeepSeek V4.1 Flash | 4.17 | 48% | 67% | 0.64 | −0.07 |
| Kimi K2.6 | 3.92 | 36% | 56% | 0.57 | −0.39 |
| **Median of the four** | | | 66% | 0.70 | 0.00 |

The last three columns compare each judge with the 160 human-checked scores (40 descriptions × 4 scores).

- **The judges agree on the top of the ranking.** Every judge put the two Claude versions first and second. The order of the other four changed from judge to judge.
- **They don't agree on how generous to be.** Gemma gives a 5 almost twice as often as Kimi, so one judge's raw scores are only comparable with its own.
- **Agreement with the human-checked scores is moderate.** The median judge matches exactly about two-thirds of the time, with a rank correlation of 0.70. Almost every disagreement is 1 point; only one score differs by 2 or more. But "within 1 point" is easy on this scale, because 89% of the human-checked scores are a 4 or 5. The exact-match rate and the correlation are the fairer measures.
- **Every judge was hardest on Completeness and Matches reference**, and easiest on Accuracy and Usefulness. The human-checked scores also put Accuracy highest and Matches reference lowest.
- **The reasons make disagreements quick to check.** For example, "clearly hedged so it is not a slip" shows exactly which rule the judge applied. [eval/REVIEW.md](../eval/REVIEW.md) shows every reason next to its score for Claude's descriptions.

### 3.9 How the judges graded their own descriptions

Each model also graded its own descriptions without being told they were its own. A raw comparison is misleading, because a generous judge scores everything higher. So the last column below first removes each judge's general lean, meaning how far it scores above or below the other judges on descriptions it didn't write.

| Model | Own work, graded by itself | Same work, graded by the others | Its general lean | Self-preference after the lean |
| --- | --- | --- | --- | --- |
| Gemma 4 31B | 4.35 | 3.97 | +0.26 | +0.12 |
| DeepSeek V4.1 Flash | 4.21 | 4.15 | +0.01 | +0.06 |
| Muse Spark 1.3 | 4.17 | 4.14 | +0.07 | −0.03 |
| Kimi K2.6 | 3.90 | 4.13 | −0.34 | +0.10 |

No judge shows a clear self-preference at this sample size: about a tenth of a point at most, with 20 photos each. No judge ranked its own descriptions first. Leaving self-grades out of the ranking is still the safer default.

### 3.10 Human checking compared with the AI judges

**What the human check caught that the judges mostly didn't:**
- **Errors in the notable-details list.** On the squad car, the wrong event guess was at the end of the details list. Two judges' reasons never mention it, and a third (Kimi) saw it but excused it as "properly hedged".
- **Wrong counts.** Only 3 of the 8 judge grades of the family portrait questioned "several adults" for a photo with two.
- **Small visual details.** Only one judge (DeepSeek, on v2) noticed that the "parked" car in the squad-car photo looks damaged, and it took off only a point.

**What the judges did well:**
- **They reached the same main conclusions** independently: v2 is more accurate, the thumbnails cause most errors, and Claude covers more than the other models.
- **They found problems in the rubric and in the draft scores.** Most of the early disagreements traced back to the two rubric problems in 3.2, or to a draft score that was too harsh.
- **They scale.** 480 graded descriptions with written reasons ran unattended. A careful human check covered 40.

## 4. Two photos up close

### The family portrait

LoC only offers this photo as a 150-pixel thumbnail. The cataloger's reference reads: "a family of two fathers, three sons, and two dogs seated in a room."

- **v1** said "several adults" sit on a sofa with "a few young children" on the floor, and listed "multiple generations" in the details.
- **v2**, told the image was a thumbnail, wrote "several adults and children" and dropped "multiple generations".
- **Both** said faces and small details couldn't be made out. Neither mentions the dogs or gives a count.

The draft gave v1 a 3 for accuracy, counting "several adults" and "multiple generations" as two slips. On review, "multiple generations" is technically true for fathers and sons. That leaves one slip, so the score became 4. Three judges gave it 5. Kimi gave it 4, citing "sofa and armchairs" in the details list.

The bigger gap is what's missing. A blind reader never learns there are two dogs in the room. This photo is why the rubric now has a Completeness score; both versions score 2 on it.

### The squad car on fire

This is another 150-pixel thumbnail. The reference reads: "a police cruiser on its side in flames next to another damaged cruiser, as crowd gathers in the street to watch, following violence after police attempted to break up a gang fight in northwest Chicago."

**v1** describes the scene well: a high viewpoint, thick smoke from a burning squad car, crowds down the block. It has two errors:
- **A wrong event.** At the end of its notable details, it adds "Likely connected to the July 1966 West Side unrest in Chicago." The record places it on the northwest side, after a gang fight. For a news photo the event is the subject, and a listener hears "likely" as the answer. Accuracy: **2**.
- **A wrong detail.** It calls the light car at the lower right "parked", but it has crashed.

**v2** dropped the event guess, as the new prompt requires, but still calls the crashed car parked. Accuracy: **4**.

Neither version notices that the burning car is on its side, or that there is a second damaged police car.

Three of the four judges gave v1 a 5 for accuracy. Only Muse Spark applied the hedge rule and gave a 2. This is the one score where the judges and the human check still differ by 2 or more points.

## 5. What the descriptions do and don't capture

### Compared with the cataloger's reference

The cataloger's summaries and the descriptions do different jobs.
- **The summaries index the archive.** They average 31 words. "Photograph shows a crowd of demonstrators milling around City Hall in Chicago" is the whole entry for a dense, high-angle crowd photo.
- **Claude's descriptions help someone picture the photo.** They average 115 words (v1) and 138 (v2), and add the layout (foreground, sides, distance), clothing and condition, the full text of every sign, and once a correction: a wicker basket that the reference calls a purse.

**The reference is better on what can't be seen.** It knows that a 150-pixel figure is Muhammad Ali with Malcolm X beside him, that the stretcher carries the gang's lawyer, and what led to the squad car being burned. The model can only use that knowledge when the title gives it. When v1 guessed beyond the title, several guesses were wrong (the event, "the victim", two dates), which is why v2 forbids guessing. A blind reader is best served by both: the description of what's there, and the catalog's facts about who and when.

### The photographer's intent and composition

The descriptions report what's in a photo. They don't explain why it looks the way it does, or what the photographer was trying to show.

They note where the camera is ("seen from high above", "elevated position looking down a city street"). v1 sometimes named a style, such as "steep overhead camera angle typical of modernist photography" for the Diamond Street print. None of them asks why the photographer made that choice:
- **Diamond Street:** looking almost straight down turns the street into a pattern of hard diagonal shadows.
- **The Pittsburgh print:** tiny figures on a hill in the foreground make the viewer look at the ruins with them.
- **The squad car:** shooting from above and at a distance shows the crowd and the fire together.

The v2 prompt ("only state what you can see") removed even the few style notes v1 had.

**That may be the right call.** A sighted viewer decides for themselves what a photo means. A description that says "the photographer frames the ruins to emphasize their scale" makes that judgment for the reader, and it's a guess about intent that can't be checked against the catalog. Describing the composition plainly lets a blind reader reach their own view: the viewpoint, the main lines and shapes, what's large and what's small, what's in focus. One option is a separate, optional "composition" field limited to what's visible.

## 6. Limitations, lessons and next steps

### Limitations

- **No testing with blind users.** "Usefulness to a blind reader" is my own judgment of what a listener needs, not something tested with screen-reader users.
- **v2 was tested on the photos it was written from.** The v2 rules came from v1's mistakes on these 20 photos and were scored on the same 20, and the rubric was revised after seeing results. A fair test of v2 needs new photos.
- **Small sample, one run each.** 20 photos, each described once per version, so run-to-run variation isn't measured.
- **One person checked the baseline**, starting from Claude's draft scores.
- **Not measured:**
  - cost, token counts and response time per search
  - whether the fallback model was ever used during the evaluation

### What I'd do differently next time

1. **Pilot the rubric before scoring everything.** Both rubric problems came up only after 40 descriptions were scored and 480 grades were run, and fixing them meant doing both again. Scoring 3 or 4 photos with two judges first would have found them.
2. **Score blind first.** Next time a person would score a sample without seeing the draft or the judges, then compare, so the draft can't anchor the check.
3. **Check image sizes when picking photos.** The thumbnails were the most informative photos, but they should be a planned subset, not an accident.
4. **Make the judges show their evidence.** Ask them to quote each claim they mark down, and to confirm they read the notable-details list.
5. **Test each judge model with one call before the main run.** That would have shown Kimi's speed and JSON problems up front.
6. **Log time and cost per call, and tag every grade with the rubric version.**
7. **Use about 50 photos, with a second person scoring a sample**, to measure how consistent the rubric is between people.

### Next steps

- **Cut the filler.** Tell the model not to mention text when there isn't any.
- **Allow context the title clearly names.** A print titled "ruins of Pittsburgh" could mention the 1845 fire, while the model still avoids events the title doesn't mention.
- **Make the AI judge panel the main evaluation.** Human checking doesn't scale past a few dozen photos. The 40 human-checked descriptions become a calibration set: when the prompt, rubric or judge models change, re-run the panel on them, and trust its scores only while it keeps agreeing with them.
- **Test identification directly.** Add photos whose main subject is a person the reference names.
