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
