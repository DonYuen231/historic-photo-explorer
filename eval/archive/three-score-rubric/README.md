# Archive: three-score rubric

These are the earlier v1 and v2 scores, kept as a development record. They used three scores: accuracy, usefulness and matches reference.

The current rubric ([../../RUBRIC.md](../../RUBRIC.md)) made two changes:

- **Added Completeness.** Leaving out something visible, such as the two dogs in the family portrait, now costs points on its own score. Before, an omission only counted if the cataloger's summary mentioned it.
- **Fixed a conflict in Accuracy.** The old rubric said hedged guesses were fine, but also gave a 2 for linking a photo to an event the record contradicts. The model judges took the first rule and gave the squad car (v1) a 5, while the hand score was 2. Now a hedged guess that names a person, place or event the record contradicts counts as an error.

As a result, usefulness now covers only how a description is told, so some thumbnail usefulness scores went up.

| File | What it is |
| --- | --- |
| [RUBRIC.md](RUBRIC.md) | The old rubric |
| [scores-v1.csv](scores-v1.csv), [scores-v2.csv](scores-v2.csv) | Hand scores under the old rubric |
| [judge-grades.json](judge-grades.json) | 480 model-judge grades under the old rubric |
| [judge-summary.md](judge-summary.md) | Summary of those grades (`node eval/compare.js` at the time) |
