# Corrected collection authorization — 2026-09-09

## Superseding allowance

While the corrected run was active, the user explicitly said: "you can use up to
20m tokens". The corrected collection's authorized total ceiling is therefore
20,000,000 reported tokens, not 20M additional to its current usage. The invalid
first collection remains separately disclosed below. This changes spending
authority only, not task outcomes, models, scoring, or the no-result-driven-retry
rule.

The already-running evaluator read its 12M scheduling limit at startup; editing
the settings file cannot change that in-memory limit. Do not claim the live
process has adopted 20M or silently hot-patch the frozen evaluator. Preserve
completed evidence if a bounded continuation becomes necessary.

## Original corrected-run launch allowance

The user directed resumption and explicitly granted the corrected collection a
fresh 12,000,000-token budget: "you can eveb have the full budget of ( i think )
12m again." This supersedes the previously proposed 10,515,857 remaining cap.

Frozen runner: 4d41826a0ba064e67dead46125aa6a64e34426b6. Settings:
corrected-settings.json. Preserve original preregistered analysis and fixed task
checks; no result-driven retries or rubric changes. Monitor the owned process
until joined and retain every attempted slot and any unknown usage.

The invalid first collection remains separate, with 306,143 reported tokens and
one interrupted call of unknown usage. The previous 1,178,000 reserve was a
scheduling precaution, not measured consumption. Those costs are not erased or
included as valid comparative evidence by this renewed allowance.
