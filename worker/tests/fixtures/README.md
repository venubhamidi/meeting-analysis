# Test fixtures

`sarvam-codemix.json` — a real `saaras:v3` / `codemix` batch response captured
from the live API on 2026-08-26, so the mapping in `toSegments` is tested
against the provider's actual shape rather than an invented one.

`speech-0.m4a`, `speech-1.m4a` — an 18-second two-speaker Telugu conversation
with Telugu-English code-mixing, split the way the app segments a recording.
Generated with Sarvam's text-to-speech, so no real person's audio is committed.
Used by the live Sarvam test; the offline tests never need it.

Spoken content:

1. నమస్కారం సర్. మా village లో water problem చాలా serious గా ఉంది. Motor pump రెండు నెలలుగా repair కాలేదు.
2. అర్థమైంది. నేను tomorrow engineer ని పంపిస్తాను. Budget approval కూడా next week వస్తుంది.
3. Thank you సర్. కానీ ఇది third time మీరు చెప్పడం. Please ఈసారి action తీసుకోండి.

`telangana-script.json` — a 24-turn, four-speaker ward sabha in Telangana Telugu
with the Urdu-origin words Telangana Telugu has naturalised (కాగజ్, ఫైసలా,
అర్జీ, జవాబ్, ఫాయిదా, దవాఖానా, సర్కార్, పరేషాన్, మొహల్లా, నౌకరీ, సఫాయి) and the
usual English code-mixing. Text only; run
`scripts/tts-fixture.mts` to render it to 60-second m4a segments for
`scripts/e2e.mts`. The audio is not committed — it is regenerable and large.

It exercises vocabulary and script rendering, not accent. See the accuracy
caveat in the script's header before reading any result as a quality signal.

`hindi-script.json` (hi-IN) and `tamil-script.json` (ta-IN) — the same meeting
again, so the variants are comparable: identical facts, speaker count and
turn structure, differing only in language. Tamil is spoken register, not
literary. Same generator, same caveat.
