# Historic Photo Explorer: project write-up

Historic Photo Explorer describes historical photographs for blind and visually impaired readers. You give it a subject and a place. It finds matching photos in the Library of Congress (LoC) archive, sends them to Claude, and returns a page with a written description of each photo.

This write-up covers how the app works, why it's built the way it is, and how I evaluated the descriptions: the rubric, the changes between two prompt versions, and a panel of four other models used as judges.

## 1. How it works

One search makes three kinds of outbound request, one after another:

```
Browser ──GET /search?subject=portrait&location=new york──▶ Node server
  1. LoC search      GET  https://www.loc.gov/photos/?q=portrait&fa=location:new york&fo=json&c=25
  2. Image download  GET  https://tile.loc.gov/...jpg     (up to 5, one at a time)
  3. Description     POST https://api.anthropic.com/v1/messages   (all 5 images in one request)
Node server ──HTML results page──▶ Browser
```

**1. Search.** The LoC JSON API is public and needs no key. The `/photos/` endpoint covers the "Photos, Prints, Drawings" collection. `q` is the subject, `fa=location:` filters by place, and `fo=json` asks for JSON. The server keeps the first 5 results that have an HTTPS image, and takes each one's title, catalog date, record URL and medium-size image URL.

**2. Download.** Each image is downloaded in turn and converted to base64. If one fails, it is skipped and the rest are still described. The server reads the image's width and height from the file's header bytes (JPEG, PNG or GIF). If the longest side is under 400 pixels, the photo is marked **low resolution**. This check was added after the evaluation showed that some LoC items only offer a 150-pixel thumbnail.

**3. Describe.** All 5 images go to the Claude Messages API in one request. Each image is an `image` content block (base64), preceded by a text label with the photo number, the catalog title, the catalog year and, if needed, a low-resolution marker:

```
Photo 5: "Squad car set afire in disorder" (catalog date: 1966) [LOW RESOLUTION: small thumbnail, fine detail is not visible]
```

The instructions come after the images. The request uses **structured outputs**: a JSON schema requires one entry per photo, each with `photo_number`, `description`, `estimated_period` and `notable_details`. Other settings:

- `max_tokens` is 16,000 and `effort` is medium.
- `fallbacks: "default"` retries on Anthropic's recommended fallback model if a safety classifier declines the request.
- The headers are `x-api-key` and `anthropic-version`.

The server checks `stop_reason` and reports a refusal or a cut-off answer as an error instead of showing a half-finished page. The default model is `claude-opus-5-5`; it can be changed with the `CLAUDE_MODEL` setting.

**4. Render.** The server builds the HTML itself. Every value from LoC or Claude is HTML-escaped before it goes on the page, so neither service can inject markup. Each result shows the image, the description, the estimated period, the notable details, a link to the LoC record and, for low-resolution images, a notice that detail is limited.

**Around the pipeline:**
- Finished results are cached in memory for an hour (up to 100 searches), so repeating a search doesn't call either API again.
- Every outbound request has a timeout: 15 seconds for LoC, 3 minutes for Claude. Redirects are followed up to 5 times.
- Input over 100 characters gets a 400 response. A failure at LoC or Claude gets a 502 page, and the details go to the server log.

## 2. What it's built with, and why

**Node.js core modules only, with callbacks.** The project began as a CUNY assignment (CS 355): a mashup of two APIs using only Node's `http`, `https` and `fs`, with the requests running one after another. I kept that constraint. With no Express, no SDK and no `fetch`, every request in the app is visible in about 120 lines of [http-client.js](../src/http-client.js), including redirects, timeouts and error bodies. `npm install` isn't needed, and there's nothing to keep up to date.

**Raw HTTPS instead of the Anthropic SDK.** For the same reason, the Claude call is a plain `POST`. The request body in [claude.js](../src/claude.js) is the exact JSON the API receives, which also made the evaluation easy. The scripts reuse `buildRequest`, so they test the same prompt the app sends.

**Structured outputs instead of asking for HTML or free text.** A JSON schema guarantees the shape of the answer, so the server never has to parse prose or trust model-written markup. The model only provides text, and the server decides how it's displayed and escapes it.

**All photos in one request.** Sending 5 images in one call is faster and cheaper than 5 separate calls. Each photo is labeled by number, so the descriptions can be matched back even if one is missing.

**Sending the catalog title and date, but not the cataloger's summary.** The title and date are what a person browsing the archive would see first, and they let the model name a person or place it couldn't recognize. The cataloger's written summary isn't sent, which let the evaluation use it as an independent reference.

**Server-rendered HTML and an in-memory cache.** For a single-page tool, a template function with escaping is simpler and safer than a frontend framework. The cache avoids paying for the same Claude call twice in an hour.

## 3. Evaluating the descriptions

Unit tests (16, all offline) check the code: building the search URL, input validation, parsing both APIs' responses (including refusals and cut-off answers), the cache, HTML escaping, image-size reading and the low-resolution flag. They can't tell whether a description is any good. For that I built a small evaluation.

### 3.1 The photos and the reference

I picked 20 LoC photos, as 4 searches of 5:

| Group | Search | Difficulty |
| --- | --- | --- |
| A | "portrait" in New York | Easy: one or two people, plain setting |
| B | "sign" in New York | Medium: the text must be read |
| C | "crowd" in Chicago | Hard: news photos, crowds, events |
| D | "bird's eye view" in Pennsylvania | Hard: dense prints and maps full of small text |

I chose every photo because an LoC cataloger had written a summary of what it shows ("Photograph shows…"). The app never sees these summaries, so they serve as a human-written reference. Five of the 20 turned out to be available only as 150-pixel thumbnails. That's an LoC rights restriction, and the app sent them anyway, which became the most important finding.

`node eval/run.js <version>` runs each group through the app's own download and Claude code, with the same prompt, model and batches as a real search. It saves the descriptions next to the references.

### 3.2 The rubric

Each description gets four scores from 1 to 5. Every level is defined, with an example from this evaluation, in [eval/RUBRIC.md](../eval/RUBRIC.md).

| Score | Question | Key rules |
| --- | --- | --- |
| **Accuracy** | Is what it says true? | Only claims count, not omissions. A hedged guess ("possibly") is fine, unless it names a person, place or event that the record contradicts. |
| **Completeness** | Does it leave out anything important in the picture? | People and animals (with a count when there are few), main objects, the action, the setting, large text. A small thumbnail doesn't excuse a miss, because the listener misses it either way. |
| **Usefulness to a blind reader** | Can a listener follow it, read aloud once? | Four problems: filler at the start, secondary detail first, text left until the details list, too long. Each problem costs a point. |
| **Matches reference** | Does it get across what the cataloger wrote? | Key facts (subject, name, action) and secondary facts. Wrong reference facts are ignored; facts you can't see still count. |

The rubric started with three scores. Two problems made me revise it:

- **Omissions weren't counted.** Leaving out something visible, such as the dogs in the family portrait (section 4), cost points only if the cataloger happened to mention it. Completeness now covers this directly. That also made "usefulness" purely about how a description is told.
- **Two accuracy rules contradicted each other.** One said a hedged guess is never a slip; another gave a 2 for linking a photo to an event the record contradicts. The squad-car photo (section 4) fell between them. The rule now says a hedged guess that names a person, place or event is judged as if it were stated.

The old rubric and its scores are kept in [eval/archive/three-score-rubric/](../eval/archive/three-score-rubric/).

### 3.3 Round 1 (v1): what went wrong

1. **Image size mattered more than how hard the photo was.** The 5 thumbnails averaged 3.4 for accuracy, against 4.8 for the full-size images, and they included every serious error. On one, the model said a stretcher carried "presumably the victim"; the record says it was the gang's lawyer. The model mentioned the small size in only 2 of the 5 cases.
2. **It filled gaps with plausible history.** It linked the burning squad car to the wrong riot, and on two photos it replaced the catalog date with its own guess, without any visible evidence.
3. **It read text very well but didn't always put it first.** All four signs were transcribed correctly, down to an artist's signature and a small sticker. On the dense prints, though, the title and banner text appeared only at the end of the "notable details" list.

### 3.4 What changed in v2

- **Low-resolution check:** the size check described in section 1. Claude is told which images are thumbnails, and the page shows a notice.
- **Stricter prompt:** five numbered rules.
  - Open with the main subject and read out any visible text near the start.
  - Most important things first.
  - Name a person, place or event only if the catalog title or visible text supports it.
  - Use the catalog date unless something visible contradicts it.
  - For thumbnails, describe less and say why.

### 3.5 Round 2 (v2): results

Same 20 photos, same model. Each cell is v1 → v2.

| Subset | Accuracy | Completeness | Usefulness | Matches reference |
| --- | --- | --- | --- | --- |
| **All 20** | 4.45 → 4.90 | 4.40 → 4.35 | 4.30 → 4.35 | 4.15 → 4.10 |
| Full-size (15) | 4.80 → 5.00 | 4.80 → 4.80 | 4.33 → 4.47 | 4.67 → 4.53 |
| 150px thumbnails (5) | 3.40 → 4.60 | 3.20 → 3.00 | 4.20 → 4.00 | 2.60 → 2.80 |

- **Accuracy improved most where it was worst.** All 5 thumbnails were flagged. The model stopped guessing and said what it couldn't see. Every full-size description scored 5.
- **Completeness and the reference match didn't improve.** A stricter prompt prevents made-up details, but it can't make a 150-pixel image show two dogs or Muhammad Ali's face. That limit is in the source data.
- **The stricter prompt had costs.** It dropped some correct context: the Pittsburgh print no longer says the ruins came from the 1845 fire. It also added filler: many descriptions now open with "no text is visible on the image", which a screen-reader user has to sit through.

### 3.6 Other models, as authors and as judges

Four vision models on NanoGPT each wrote their own descriptions of the 20 photos, using the app's v2 prompt: DeepSeek V4.1 Flash, Kimi K2.6, Gemma 4 31B and Muse Spark 1.3. Each of them then graded all six sets of descriptions, 480 grades in total ([eval/judge.js](../eval/judge.js)). The setup:

- **Judges didn't know who wrote a description** and saw them in a shuffled order.
- **A judge saw** the photo, the catalog record, the reference summary and the rubric. The rubric's example column was removed so the judges couldn't see our scores.
- **Each judge wrote a one-sentence reason before each score.** Answers were requested as JSON and checked in code. Kimi returned empty answers when given a strict JSON schema, so all judges used plain JSON mode.
- **A model's grades of its own descriptions were left out** of the ranking.

| Descriptions by | Accuracy | Completeness | Usefulness | Reference | Overall |
| --- | --- | --- | --- | --- | --- |
| **Claude v1** | 4.59 | 4.19 | 4.41 | 4.00 | **4.30** |
| **Claude v2** | 4.75 | 4.11 | 4.42 | 3.80 | **4.27** |
| DeepSeek V4.1 Flash | 4.83 | 3.77 | 4.60 | 3.38 | 4.15 |
| Muse Spark 1.3 | 4.37 | 4.07 | 4.35 | 3.77 | 4.14 |
| Kimi K2.6 | 4.47 | 3.78 | 4.72 | 3.57 | 4.13 |
| Gemma 4 31B | 4.45 | 3.30 | 4.62 | 3.50 | 3.97 |

**Claude ranks first because it leaves out less.** It isn't the most accurate (DeepSeek is) or the easiest to listen to (Kimi is). The other models wrote 64–109 words per photo on average, against Claude's 115–138, and their completeness scores show what that cost.

**The judges mostly agree with the human-checked scores.** The median of the four judges is within 1 point of the human-checked score on 98–100% of descriptions, with no overall bias. Kimi is the strictest judge, scoring about 0.4 below on average. Only Gemma clearly favors its own work, by about 0.4 points.

## 4. Two photos up close

### The family portrait

LoC only offers this photo as a 150-pixel thumbnail. The cataloger's reference reads: "a family of two fathers, three sons, and two dogs seated in a room."

- **v1** said "several adults" sit on a sofa with "a few young children" on the floor, and listed "multiple generations" in the details. It didn't mention the dogs.
- **v2**, told the image was a thumbnail, wrote "several adults and children" and said faces and smaller objects couldn't be made out. That's more honest, but still no dogs and no count.

I first gave v1 a 3 for accuracy, counting both "several adults" and "multiple generations" as slips. On a second look, "multiple generations" is technically true for fathers and sons, so it's one slip and a 4. The judges gave it 5, except Kimi, which gave 4 for "several adults".

The bigger gap is what's missing: a blind reader never learns there are two dogs in the room. Under the original three-score rubric, that cost a point only because the cataloger happened to mention the dogs. This photo is why the rubric now has a Completeness score. Both versions score 2 on it.

### The squad car on fire

This is another 150-pixel thumbnail. The reference reads: "a police cruiser on its side in flames next to another damaged cruiser, as crowd gathers in the street to watch, following violence after police attempted to break up a gang fight in northwest Chicago."

**v1** describes the scene well: a high viewpoint, thick smoke from a burning squad car, crowds down the block. It has two errors:
- At the end of its notable details, it adds "Likely connected to the July 1966 West Side unrest in Chicago." The record places it on the northwest side after a gang fight. For a news photo, the event is the subject, and a listener hears "likely" as the answer. Accuracy: **2**.
- It calls the light car at the lower right "parked"; it has crashed.

**v2** dropped the event guess, as the new prompt requires, but still calls the crashed car parked. Accuracy: **4**. Neither version notices that the burning car is on its side, or that there's a second damaged police car.

Three of the four judges gave v1 a 5 for accuracy. Their reasons mention only the main description. The one judge that commented on the details list (Muse Spark) caught the wrong event and gave a 2. This is the only photo where the judge panel and the human-checked score still differ by 2 or more points.

## 5. Human-checked scores compared with the model judges

The baseline scores were drafted by Claude, cross-checked against the four judges, and verified by a person against the images. Disagreements of 2 or more points were checked first.

**What the person did that the judges didn't:**
- **Read everything.** The judges graded the main description and mostly skipped the notable-details list, which is where the squad car's wrong event was.
- **Applied the rubric literally to hedges.** Most judges treated "likely" or "possibly" as an excuse even when the guess was contradicted by the record.
- **Counted.** The judges mostly accepted vague words like "several adults" without counting the people in the photo.
- **Looked closely at small details.** No judge noticed that the "parked" car in the squad-car photo has crashed.

**What the judges did well:**
- **Agreed on the main findings.** With no overall bias, the judges reached the same conclusions: v2 is more accurate, the thumbnails cause most errors, and Claude covers more than the other models.
- **They exposed weak spots in the rubric and in the human-checked scores.** Under the first rubric there were five disagreements of 2+ points, and four of them were fixed:
  - three usefulness scores, where the old rubric mixed "what's missing" into usefulness (now its own Completeness score)
  - the family portrait's accuracy, where the human-checked score was too harsh

  The fifth, the squad car, led to the clearer hedge rule. The human-checked score stayed the same.
- **Scale.** 480 grades with written reasons took a few hours of unattended running. A person can check 40 carefully.

**Plan for further evaluation: model judges only.** Human checking doesn't scale past a few dozen photos, so future scoring will be done by the judge panel. The 40 human-checked scores become a calibration set. Whenever the prompt, rubric or judge models change, the panel is re-run on that set, and its scores are trusted only while its median stays within 1 point of the baseline. The judges' prompt should also tell them to read the notable-details list.

## 6. Compared with the cataloger's reference

On their own terms, the descriptions are better than the cataloger's summaries. The summaries average 31 words; Claude's average 115 (v1) and 138 (v2). The summaries are written to index the archive, not to let someone picture a photo. "Photograph shows a crowd of demonstrators milling around City Hall in Chicago" is the whole entry for a dense, high-angle crowd photo. Claude's descriptions give more:

- **Layout:** what is in the foreground, at the sides and in the distance.
- **Clothing and condition:** what people wear, and wear and damage on objects.
- **Full text:** every sign transcribed, down to a small RONMAR sticker on an awning.
- **Corrections:** in one case it fixed the cataloger, describing a wicker basket that the reference calls a purse.

**The reference wins on what can't be seen.** It knows that a 150-pixel figure is Muhammad Ali with Malcolm X beside him, that the stretcher carries the gang's lawyer, and which riot the squad car belongs to. The model can only use that knowledge when the title gives it. When it guessed instead, it was usually wrong, which is why v2 forbids guessing. A blind reader needs both: the model's description of what's there, and the catalog's facts about who and when.

## 7. What the descriptions don't do

The descriptions report what is in a photo. They don't explain why it looks the way it does, or what the photographer was trying to show.

**Camera position, but no reason for it.** They note where the camera stands ("seen from high above", "elevated position looking down a city street"), and v1 sometimes named a style: "steep overhead camera angle typical of modernist photography" for the Diamond Street print. None of them asks why.
- **Diamond Street:** the photo looks almost straight down, so the street becomes a pattern of hard diagonal shadows.
- **The Pittsburgh print:** tiny figures stand on a hill in the foreground, so the viewer looks at the ruins with them.
- **The squad car:** the photographer shot from above and at a distance, so the crowd and the fire appear together.

The v2 prompt ("only state what you can see") pushes further in this direction. It removed even the few style notes v1 had.

**That may be the right call.** A sighted viewer forms their own view of what a photo means. A description that says "the photographer frames the ruins to emphasize their scale" makes that judgment for the reader, and it's a guess about intent that can't be checked against the catalog. Describing the composition plainly lets a blind reader reach their own conclusions: the viewpoint, the main lines and shapes, what's large and what's small, what's in focus. A possible middle ground is a separate, optional "composition" field that sticks to what's visible and leaves interpretation out.

## 8. Limitations and next steps

**Limitations:**
- **Small sample.** 20 photos is enough to find patterns but too few for small differences to be reliable. The gap between Claude v1 (4.30) and v2 (4.27) on the judges' ranking means nothing.
- **One person checked the baseline.** A second person scoring a sample would show how consistent the rubric is.
- **Thumbnails.** The thumbnail problem is in the source: when LoC only offers 150 pixels, no prompt can recover what isn't there.

**Next steps:**
- **Cut the filler.** Tell the model not to mention text when there isn't any.
- **Allow context the title clearly names.** A print titled "ruins of Pittsburgh" can mention the 1845 fire, while the model still doesn't link a photo to an event the title doesn't mention.
- **Calibrate the judge panel.** Make it the main evaluation, with the 40-score calibration set, and tell the judges to read the details list.
- **Test identification directly.** Add photos whose main subject is a person the reference names.
